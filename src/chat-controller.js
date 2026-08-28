import { setTimeout as sleep } from 'node:timers/promises';

const RUNTIME_RULES = `你正在通过 QQ 聊天。只输出要发送的最终文本，不输出分析过程、规则、工具名或动作说明。普通闲聊优先简短自然；确有必要时才详细说明。用换行表示不同 QQ 消息，最多三条。用户可能把一句话拆成连续多条发送；输入中的换行表示这些连续片段属于同一轮，请理解合并后的完整意思，只整体回应一次，不要逐行作答。不是每一轮都必须回复：私聊自然收尾时可以输出 [SILENT]；群聊中更要克制，如果话不是对你说、别人正在交谈、插话会打断节奏，或者你没有真正想说的内容，就只输出 [SILENT]。不要为了证明在线而接每一句，也不要把 [SILENT] 和其他文字一起输出。`;

export function splitReply(content, { maxReplyChars, maxReplyParts }) {
  const cleaned = String(content ?? '')
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  if (!cleaned) return [];
  const lines = cleaned.split(/\r?\n+/).map((line) => line.trim()).filter(Boolean);
  const source = lines.length ? lines : [cleaned];
  return source.slice(0, maxReplyParts).map((line) => line.slice(0, maxReplyChars));
}

export class ChatController {
  #qq;
  #deepseek;
  #persona;
  #store;
  #safety;
  #config;
  #logger;
  #participation;
  #queues = new Map();
  #seen = new Map();
  #inputVersions = new Map();

  constructor({ qq, deepseek, persona, store, safety, participation = null, config, logger = console }) {
    this.#qq = qq;
    this.#deepseek = deepseek;
    this.#persona = persona;
    this.#store = store;
    this.#safety = safety;
    this.#participation = participation;
    this.#config = config;
    this.#logger = logger;
  }

  handle(message) {
    if (!this.accepts(message)) return Promise.resolve(false);
    if (!Number.isInteger(message.inputVersion)) this.noteIncoming(message);
    if (this.#isDuplicate(message.id)) return Promise.resolve(false);
    const key = message.conversationId;
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => this.#process(message))
      .catch((error) => this.#logger.error?.(`[chat] ${key} 处理失败：${error.message ?? error}`))
      .finally(() => {
        if (this.#queues.get(key) === current) this.#queues.delete(key);
      });
    this.#queues.set(key, current);
    return current.then(() => true);
  }

  async flush() {
    await Promise.allSettled([...this.#queues.values()]);
    await this.#store.flush();
  }

  noteIncoming(message) {
    const key = message?.conversationId;
    if (!key) return 0;
    const version = (this.#inputVersions.get(key) ?? 0) + 1;
    this.#inputVersions.set(key, version);
    message.inputVersion = version;
    return version;
  }

  accepts(message) {
    if (!message?.content || !['private', 'group'].includes(message.kind)) return false;
    if (message.selfId && message.senderId === message.selfId) return false;
    if (!this.#safety.isAllowed(message.kind, message.targetId)) return false;
    if (message.kind === 'group') {
      if (this.#config.groupReplyMode === 'off') return false;
      if (this.#config.groupReplyMode === 'mention' && !message.mentionedSelf) return false;
    }
    return true;
  }

  #isDuplicate(id) {
    const now = Date.now();
    for (const [key, timestamp] of this.#seen) {
      if (timestamp < now - 10 * 60_000) this.#seen.delete(key);
    }
    const key = String(id);
    if (this.#seen.has(key)) return true;
    this.#seen.set(key, now);
    return false;
  }

  async #process(message) {
    if (message.batchSize > 1) {
      this.#logger.info?.(`[chat] ${message.conversationId} 合并 ${message.batchSize} 条连续消息`);
    }
    await this.#store.append(message.conversationId, {
      role: 'user',
      content: message.senderName ? `${message.senderName}：${message.content}` : message.content,
      timestamp: message.timestamp
    });
    let participationReason = message.kind === 'private'
      ? '这是私聊消息'
      : this.#config.groupReplyMode === 'mention'
        ? '对方明确 @ 了你'
        : '调试模式把本条群消息交给你判断';
    if (message.kind === 'group' && this.#config.groupReplyMode === 'natural') {
      const decision = this.#participation?.decide(message) ?? { respond: false, reason: '自然参与策略不可用' };
      participationReason = decision.reason;
      if (!decision.respond) {
        this.#logger.info?.(`[chat] ${message.conversationId} 旁听：${decision.reason}`);
        return;
      }
    }
    const history = this.#store.get(message.conversationId).map(({ role, content }) => ({ role, content }));
    const decisionHint = message.kind === 'group'
      ? `本轮进入回复候选的原因：${participationReason}。这只是候选，不代表必须说话；仍应根据群聊语境决定回复或 [SILENT]。`
      : '私聊通常正常回应；只有自然收尾、没有继续交流意图时才使用 [SILENT]。';
    const system = `${this.#persona}\n\n## 本次运行规则\n${RUNTIME_RULES}\n当前时间：${new Date().toLocaleString('zh-CN', { hour12: false })}\n会话类型：${message.kind === 'private' ? 'QQ 私聊' : 'QQ 群聊'}\n${decisionHint}`;
    const result = await this.#deepseek.chat([{ role: 'system', content: system }, ...history]);
    if (result.content.trim() === '[SILENT]') {
      this.#logger.info?.(`[chat] ${message.conversationId} 本轮自然静默`);
      return;
    }
    if (this.#isSuperseded(message)) {
      this.#logger.info?.(`[chat] ${message.conversationId} 收到更新消息，取消旧回复`);
      return;
    }
    const parts = splitReply(result.content, this.#config);
    if (!parts.length) throw new Error('模型回复为空');

    const sent = [];
    const sentMessageIds = [];
    try {
      for (const part of parts) {
        if (this.#isSuperseded(message)) {
          this.#logger.info?.(`[chat] ${message.conversationId} 用户仍在输入，停止发送剩余回复`);
          break;
        }
        if (!this.#safety.isAllowed(message.kind, message.targetId)) throw new Error('发送前白名单校验失败');
        this.#safety.reserveSend(message.conversationId);
        const sendResult = await this.#qq.sendText(message.kind, message.targetId, part);
        sent.push(part);
        if (sendResult?.message_id !== undefined) sentMessageIds.push(String(sendResult.message_id));
        if (parts.length > 1 && sent.length < parts.length) await sleep(this.#config.sendGapMs);
      }
    } catch (error) {
      if (sent.length) {
        await this.#store.append(message.conversationId, {
          role: 'assistant',
          content: sent.join('\n'),
          timestamp: Date.now()
        });
      }
      throw error;
    }
    if (!sent.length) return;
    await this.#store.append(message.conversationId, {
      role: 'assistant',
      content: sent.join('\n'),
      timestamp: Date.now()
    });
    if (message.kind === 'group' && this.#config.groupReplyMode === 'natural') {
      this.#participation?.recordReply(message, { messageIds: sentMessageIds });
    }
    this.#logger.info?.(`[chat] ${message.conversationId} 已回复 ${sent.length} 条`);
  }

  #isSuperseded(message) {
    return (this.#inputVersions.get(message.conversationId) ?? 0) > (message.inputVersion ?? 0);
  }
}
