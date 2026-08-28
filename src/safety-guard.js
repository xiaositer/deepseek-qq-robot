function prune(timestamps, now, windowMs) {
  while (timestamps.length && timestamps[0] <= now - windowMs) timestamps.shift();
}

export class RateLimitError extends Error {
  constructor(message, { retryAfterMs, scope } = {}) {
    super(message);
    this.name = 'RateLimitError';
    this.code = 'RATE_LIMITED';
    this.retryAfterMs = Math.max(1, Number(retryAfterMs) || 1);
    this.scope = scope;
  }
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
    return this.reserveSends(conversationId, 1, now);
  }

  reserveSends(conversationId, count, now = Date.now()) {
    const windowMs = 60_000;
    const requested = Math.max(1, Number(count) || 1);
    const local = this.#perConversation.get(conversationId) ?? [];
    prune(local, now, windowMs);
    prune(this.#global, now, windowMs);
    const localWait = waitForCapacity(local, this.#perMinuteLimit, requested, now, windowMs);
    if (localWait > 0) {
      throw new RateLimitError('当前会话发送频率已达到上限', {
        retryAfterMs: localWait,
        scope: 'conversation'
      });
    }
    const globalWait = waitForCapacity(this.#global, this.#globalPerMinuteLimit, requested, now, windowMs);
    if (globalWait > 0) {
      throw new RateLimitError('全局发送频率已达到上限', {
        retryAfterMs: globalWait,
        scope: 'global'
      });
    }
    for (let index = 0; index < requested; index += 1) {
      local.push(now);
      this.#global.push(now);
    }
    this.#perConversation.set(conversationId, local);
  }

  retryAfterMs(conversationId, count = 1, now = Date.now()) {
    const windowMs = 60_000;
    const local = this.#perConversation.get(conversationId) ?? [];
    prune(local, now, windowMs);
    prune(this.#global, now, windowMs);
    const requested = Math.max(1, Number(count) || 1);
    const localWait = waitForCapacity(local, this.#perMinuteLimit, requested, now, windowMs);
    const globalWait = waitForCapacity(this.#global, this.#globalPerMinuteLimit, requested, now, windowMs);
    return Math.max(0, localWait, globalWait);
  }
}

function waitForCapacity(timestamps, limit, requested, now, windowMs) {
  const expirationsNeeded = timestamps.length + requested - limit;
  if (expirationsNeeded <= 0) return 0;
  if (expirationsNeeded > timestamps.length) return windowMs;
  return Math.max(1, timestamps[expirationsNeeded - 1] + windowMs - now);
}
