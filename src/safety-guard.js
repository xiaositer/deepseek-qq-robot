function prune(timestamps, now, windowMs) {
  while (timestamps.length && timestamps[0] <= now - windowMs) timestamps.shift();
}

export class SafetyGuard {
  #privateAllow;
  #groupAllow;
  #perConversation = new Map();
  #global = [];
  #perMinuteLimit;
  #globalPerMinuteLimit;

  constructor({ allow, perMinuteLimit, globalPerMinuteLimit }) {
    this.#privateAllow = new Set(allow.private.map(String));
    this.#groupAllow = new Set(allow.groups.map(String));
    this.#perMinuteLimit = perMinuteLimit;
    this.#globalPerMinuteLimit = globalPerMinuteLimit;
  }

  isAllowed(kind, targetId) {
    const id = String(targetId);
    return kind === 'private' ? this.#privateAllow.has(id) : this.#groupAllow.has(id);
  }

  reserveSend(conversationId, now = Date.now()) {
    const windowMs = 60_000;
    const local = this.#perConversation.get(conversationId) ?? [];
    prune(local, now, windowMs);
    prune(this.#global, now, windowMs);
    if (local.length >= this.#perMinuteLimit) throw new Error('当前会话发送频率已达到上限');
    if (this.#global.length >= this.#globalPerMinuteLimit) throw new Error('全局发送频率已达到上限');
    local.push(now);
    this.#global.push(now);
    this.#perConversation.set(conversationId, local);
  }
}
