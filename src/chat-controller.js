import { setTimeout as sleep } from 'node:timers/promises';
import { parseNaturalDecision } from './natural-conversation-engine.js';
import { RateLimitError } from './safety-guard.js';

const RUNTIME_RULES = `你正在通过 QQ 聊天。只输出要发送的最终文本，不输出分析过程、规则、工具名或动作说明。普通闲聊优先简短自然；确有必要时才详细说明。用换行表示不同 QQ 消息，最多三条。用户可能把一句话拆成连续多条发送；输入中的换行表示这些连续片段属于同一轮，请理解合并后的完整意思，只整体回应一次，不要逐行作答。不是每一轮都必须回复：私聊自然收尾时可以输出 [SILENT]；群聊中更要克制，如果话不是对你说、别人正在交谈、插话会打断节奏，或者你没有真正想说的内容，就只输出 [SILENT]。不要为了证明在线而接每一句，也不要把 [SILENT] 和其他文字一起输出。`;

const NATURAL_ACTION_RULES = `你正在进行 QQ 群聊中的一次自主观察回合。此任务不是直接生成聊天文本，而是决定内部动作。收到消息只代表你有机会查看，不代表必须回复。你必须只输出一个合法 JSON 对象，不要输出 Markdown、解释、[SILENT] 或其他文字：
{"action":"send|wait|read|stay","messages":[],"topic":"","focusUserIds":[]}
- send：现在确实适合开口。messages 是要发送的 1-3 条短消息，每个数组元素是一条完整 QQ 气泡。
- wait：对方可能没说完，或你明确在等当前的人继续说；本轮不发送。
- stay：本轮不说，但仍参与/观察当前话题；下一批消息到达时继续判断。
- read：看过但不参与，退回普通旁听；本轮不发送。
不要因为被唤醒就硬说话。别人正在互相交流、引用对象不是你、只会复述附和、话题已经翻篇时优先 read 或 stay。被明确点名也可以 wait，但通常应正常接话。`;

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
  #naturalConversation;
  #queues = new Map();
  #seen = new Map();
  #inputVersions = new Map();
  #deferredTurns = new Map();

  constructor({ qq, deepseek, persona, store, safety, naturalConversation = null, config, logger = console }) {
    this.#qq = qq;
    this.#deepseek = deepseek;
    this.#persona = persona;
    this.#store = store;
    this.#safety = safety;
    this.#naturalConversation = naturalConversation;
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
    for (const deferred of this.#deferredTurns.values()) clearTimeout(deferred.timer);
    this.#deferredTurns.clear();
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
    if (!message.deferredStored) {
      await this.#store.append(message.conversationId, {
        role: 'user',
        content: message.senderName ? `${message.senderName}：${message.content}` : message.content,
        timestamp: message.timestamp
      });
    }
    const existingDeferred = this.#deferredTurns.has(message.conversationId);
    const rateWaitMs = this.#safety.retryAfterMs?.(message.conversationId) ?? 0;
    if (!message.deferredStored && (existingDeferred || rateWaitMs > 0)) {
      this.#deferTurn(message, Math.max(rateWaitMs, 250));
      return;
    }
    let participationReason = message.kind === 'private'
      ? '这是私聊消息'
      : this.#config.groupReplyMode === 'mention'
        ? '对方明确 @ 了你'
        : '调试模式把本条群消息交给你判断';
    if (message.kind === 'group' && this.#config.groupReplyMode === 'natural') {
      const observation = this.#naturalConversation?.observe(message) ?? { review: false, reason: '自然对话中枢不可用' };
      participationReason = observation.reason;
      if (!observation.review) {
        this.#logger.info?.(`[chat] ${message.conversationId} 收件箱旁听：${observation.reason}`);
        return;
      }
    }
    const history = this.#store.get(message.conversationId).map(({ role, content }) => ({ role, content }));
    const naturalMode = message.kind === 'group' && this.#config.groupReplyMode === 'natural';
    const decisionHint = naturalMode
      ? `${NATURAL_ACTION_RULES}\n本轮唤醒原因：${participationReason}\n本轮最后发言者：${message.senderName || message.senderId}（ID ${message.senderId}）\n当前内部状态：${JSON.stringify(this.#naturalConversation?.snapshot(message.conversationId) ?? {})}`
      : message.kind === 'group'
        ? `本轮进入回复候选的原因：${participationReason}。这只是候选，不代表必须说话；仍应根据群聊语境决定回复或 [SILENT]。`
      : '私聊通常正常回应；只有自然收尾、没有继续交流意图时才使用 [SILENT]。';
    const system = naturalMode
      ? `${this.#persona}\n\n## 本次运行的最高优先级规则\n${decisionHint}\n当前时间：${new Date().toLocaleString('zh-CN', { hour12: false })}\n会话类型：QQ 群聊\n无论角色卡中怎样描述回复格式，本轮都只能返回上述 JSON 动作对象。`
      : `${this.#persona}\n\n## 本次运行规则\n${RUNTIME_RULES}\n当前时间：${new Date().toLocaleString('zh-CN', { hour12: false })}\n会话类型：${message.kind === 'private' ? 'QQ 私聊' : 'QQ 群聊'}\n${decisionHint}`;
    const result = await this.#deepseek.chat(
      [{ role: 'system', content: system }, ...history],
      naturalMode ? { responseFormat: 'json_object' } : undefined
    );
    if (result.jsonModeFallback) {
      this.#logger.warn?.(`[chat] ${message.conversationId} DeepSeek JSON 模式连续空回复，已使用严格提示词兜底`);
    }
    if (!naturalMode && result.content.trim() === '[SILENT]') {
      this.#logger.info?.(`[chat] ${message.conversationId} 本轮自然静默`);
      return;
    }
    if (this.#isSuperseded(message)) {
      this.#logger.info?.(`[chat] ${message.conversationId} 收到更新消息，取消旧回复`);
      return;
    }
    let naturalDecision = null;
    if (naturalMode) {
      naturalDecision = parseNaturalDecision(result.content);
      if (naturalDecision.invalid) {
        const preview = String(result.content).replace(/\s+/g, ' ').slice(0, 240);
        this.#logger.warn?.(`[chat] ${message.conversationId} 自然动作格式无效，安全转为已读；模型输出：${preview}`);
      }
      if (naturalDecision.action !== 'send') {
        this.#naturalConversation?.applyDecision(message, naturalDecision);
        this.#logger.info?.(`[chat] ${message.conversationId} 自主动作：${naturalDecision.action}`);
        return;
      }
    }
    const parts = naturalMode
      ? naturalDecision.messages
        .map((part) => String(part).replace(/\s*\r?\n+\s*/g, ' ').trim().slice(0, this.#config.maxReplyChars))
        .filter(Boolean)
        .slice(0, this.#config.maxReplyParts)
      : splitReply(result.content, this.#config);
    if (!parts.length) throw new Error('模型回复为空');

    const sent = [];
    const sentMessageIds = [];
    try {
      if (!this.#safety.isAllowed(message.kind, message.targetId)) throw new Error('发送前白名单校验失败');
      if (typeof this.#safety.reserveSends === 'function') {
        this.#safety.reserveSends(message.conversationId, parts.length);
      } else {
        for (let index = 0; index < parts.length; index += 1) this.#safety.reserveSend(message.conversationId);
      }
      for (const part of parts) {
        if (this.#isSuperseded(message)) {
          this.#logger.info?.(`[chat] ${message.conversationId} 用户仍在输入，停止发送剩余回复`);
          break;
        }
        if (!this.#safety.isAllowed(message.kind, message.targetId)) throw new Error('发送前白名单校验失败');
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
        if (naturalMode) this.#naturalConversation?.applyDecision(message, naturalDecision, { messageIds: sentMessageIds });
      }
      if (error instanceof RateLimitError) {
        if (!sent.length) {
          this.#deferTurn(message, error.retryAfterMs);
        } else {
          this.#logger.info?.(`[chat] ${message.conversationId} 发送额度暂满；已发送当前回复的一部分，后续新消息将延迟合并`);
        }
        return;
      }
      throw error;
    }
    if (!sent.length) return;
    await this.#store.append(message.conversationId, {
      role: 'assistant',
      content: sent.join('\n'),
      timestamp: Date.now()
    });
    if (naturalMode) this.#naturalConversation?.applyDecision(message, naturalDecision, { messageIds: sentMessageIds });
    this.#logger.info?.(`[chat] ${message.conversationId} 已回复 ${sent.length} 条`);
  }

  #isSuperseded(message) {
    return (this.#inputVersions.get(message.conversationId) ?? 0) > (message.inputVersion ?? 0);
  }

  #deferTurn(message, retryAfterMs) {
    const key = message.conversationId;
    let deferred = this.#deferredTurns.get(key);
    if (!deferred) {
      deferred = { messages: [], ids: new Set(), timer: null };
      this.#deferredTurns.set(key, deferred);
    }
    if (!deferred.ids.has(String(message.id))) {
      deferred.ids.add(String(message.id));
      deferred.messages.push(message);
    }
    clearTimeout(deferred.timer);
    const delay = Math.max(250, Number(retryAfterMs) || 250) + 100;
    deferred.timer = setTimeout(() => this.#resumeDeferredTurn(key), delay);
    deferred.timer.unref?.();
    this.#logger.info?.(`[chat] ${key} 发送额度暂满，已暂存 ${deferred.messages.length} 个话轮，约 ${Math.ceil(delay / 1000)} 秒后合并重试`);
  }

  #resumeDeferredTurn(key) {
    const deferred = this.#deferredTurns.get(key);
    if (!deferred?.messages.length) return;
    this.#deferredTurns.delete(key);
    clearTimeout(deferred.timer);
    const first = deferred.messages[0];
    const last = deferred.messages.at(-1);
    const merged = {
      ...last,
      id: `deferred:${first.id}:${last.id}:${Date.now()}`,
      content: deferred.messages.map((item) => item.content).filter(Boolean).join('\n'),
      timestamp: last.timestamp,
      mentionedSelf: deferred.messages.some((item) => item.mentionedSelf),
      batchSize: deferred.messages.reduce((sum, item) => sum + (Number(item.batchSize) || 1), 0),
      inputVersion: this.#inputVersions.get(key) ?? last.inputVersion,
      deferredStored: true
    };
    this.#logger.info?.(`[chat] ${key} 发送额度恢复，合并 ${deferred.messages.length} 个暂存话轮重新生成回复`);
    void this.handle(merged);
  }
}
