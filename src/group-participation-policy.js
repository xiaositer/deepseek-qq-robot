const DIRECT_NAME_PATTERN = /(?:小鲸鱼|鲸鱼|D指导|deepseek)/i;

export class GroupParticipationPolicy {
  #activeWindowMs;
  #cooldownMs;
  #ambientChance;
  #random;
  #lastReplyAt = new Map();
  #activeSenders = new Map();
  #botMessageIds = new Map();

  constructor({ activeWindowMs = 120_000, cooldownMs = 20_000, ambientChancePercent = 12, random = Math.random } = {}) {
    this.#activeWindowMs = activeWindowMs;
    this.#cooldownMs = cooldownMs;
    this.#ambientChance = ambientChancePercent / 100;
    this.#random = random;
  }

  decide(message, now = Date.now()) {
    const conversationId = message.conversationId;
    this.#prune(conversationId, now);
    if (message.mentionedSelf) return { respond: true, reason: '对方明确 @ 了你' };
    if (this.#isReplyToBot(message, now)) return { respond: true, reason: '对方正在回复你刚才的消息' };
    if (DIRECT_NAME_PATTERN.test(message.content)) return { respond: true, reason: '对方在文字中点了你的名字' };

    const senderKey = `${conversationId}:${message.senderId}`;
    if ((this.#activeSenders.get(senderKey) ?? 0) > now) {
      return { respond: true, reason: '对方正在延续刚才与你的对话' };
    }

    const lastReplyAt = this.#lastReplyAt.get(conversationId) ?? 0;
    if (now - lastReplyAt < this.#cooldownMs) return { respond: false, reason: '群聊插话冷却中' };
    if (this.#random() >= this.#ambientChance) return { respond: false, reason: '普通群聊内容，本轮选择旁听' };
    return { respond: true, reason: '普通群聊中的偶尔自然插话候选' };
  }

  recordReply(message, { messageIds = [], now = Date.now() } = {}) {
    const conversationId = message.conversationId;
    this.#lastReplyAt.set(conversationId, now);
    this.#activeSenders.set(`${conversationId}:${message.senderId}`, now + this.#activeWindowMs);
    const ids = this.#botMessageIds.get(conversationId) ?? new Map();
    for (const id of messageIds.map(String).filter(Boolean)) ids.set(id, now + this.#activeWindowMs);
    this.#botMessageIds.set(conversationId, ids);
    this.#prune(conversationId, now);
  }

  #isReplyToBot(message, now) {
    if (!message.replyMessageId) return false;
    return (this.#botMessageIds.get(message.conversationId)?.get(String(message.replyMessageId)) ?? 0) > now;
  }

  #prune(conversationId, now) {
    for (const [key, expiresAt] of this.#activeSenders) {
      if (expiresAt <= now) this.#activeSenders.delete(key);
    }
    const ids = this.#botMessageIds.get(conversationId);
    if (!ids) return;
    for (const [id, expiresAt] of ids) if (expiresAt <= now) ids.delete(id);
    if (!ids.size) this.#botMessageIds.delete(conversationId);
  }
}
