function isShortUnfinishedText(content) {
  const text = String(content ?? '').trim();
  if (!text || text.length > 8) return false;
  return !/[。！？!?…~～]$/.test(text);
}

function mergeMessages(messages) {
  const first = messages[0];
  const last = messages.at(-1);
  return {
    ...last,
    id: `batch:${first.id}:${last.id}:${messages.length}`,
    content: messages.map((message) => message.content.trim()).filter(Boolean).join('\n'),
    timestamp: last.timestamp,
    mentionedSelf: messages.some((message) => message.mentionedSelf),
    mentionedUserIds: [...new Set(messages.flatMap((message) => message.mentionedUserIds ?? []).map(String))],
    batchSize: messages.length
  };
}

export class MessageBatcher {
  #onBatch;
  #quietMs;
  #shortQuietMs;
  #maxWaitMs;
  #groupQuietMs;
  #groupMaxWaitMs;
  #logger;
  #batches = new Map();
  #inFlight = new Set();
  #closed = false;

  constructor({ onBatch, quietMs = 1_800, shortQuietMs = 3_000, maxWaitMs = 8_000, groupQuietMs = 8_000, groupMaxWaitMs = 20_000, logger = console }) {
    if (typeof onBatch !== 'function') throw new Error('MessageBatcher 需要 onBatch 回调');
    this.#onBatch = onBatch;
    this.#quietMs = quietMs;
    this.#shortQuietMs = shortQuietMs;
    this.#maxWaitMs = maxWaitMs;
    this.#groupQuietMs = groupQuietMs;
    this.#groupMaxWaitMs = groupMaxWaitMs;
    this.#logger = logger;
  }

  add(message) {
    if (this.#closed) return false;
    const key = `${message.conversationId}::${message.senderId}`;
    let batch = this.#batches.get(key);
    if (!batch) {
      batch = { messages: [], quietTimer: null, maxTimer: null };
      const maxWait = message.kind === 'group' ? this.#groupMaxWaitMs : this.#maxWaitMs;
      batch.maxTimer = setTimeout(() => this.#emit(key), maxWait);
      batch.maxTimer.unref?.();
      this.#batches.set(key, batch);
    }
    if (batch.messages.some((item) => String(item.id) === String(message.id))) return false;
    batch.messages.push(message);
    clearTimeout(batch.quietTimer);
    const delay = message.kind === 'group' && !message.mentionedSelf
      ? this.#groupQuietMs
      : isShortUnfinishedText(message.content) ? this.#shortQuietMs : this.#quietMs;
    batch.quietTimer = setTimeout(() => this.#emit(key), delay);
    batch.quietTimer.unref?.();
    return true;
  }

  async flush() {
    for (const key of [...this.#batches.keys()]) this.#emit(key);
    await Promise.allSettled([...this.#inFlight]);
  }

  async close({ flush = false } = {}) {
    this.#closed = true;
    if (flush) return this.flush();
    for (const batch of this.#batches.values()) {
      clearTimeout(batch.quietTimer);
      clearTimeout(batch.maxTimer);
    }
    this.#batches.clear();
    await Promise.allSettled([...this.#inFlight]);
  }

  #emit(key) {
    const batch = this.#batches.get(key);
    if (!batch) return;
    this.#batches.delete(key);
    clearTimeout(batch.quietTimer);
    clearTimeout(batch.maxTimer);
    if (!batch.messages.length) return;
    const merged = mergeMessages(batch.messages);
    const task = Promise.resolve(this.#onBatch(merged))
      .catch((error) => this.#logger.error?.(`[batch] ${merged.conversationId} 处理失败：${error.message ?? error}`))
      .finally(() => this.#inFlight.delete(task));
    this.#inFlight.add(task);
  }
}

export { isShortUnfinishedText, mergeMessages };
