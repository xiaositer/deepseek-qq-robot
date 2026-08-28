import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

function cleanMessage(message) {
  const role = message?.role;
  const content = String(message?.content ?? '').trim();
  if (!['user', 'assistant'].includes(role) || !content) {
    throw new Error('上下文消息必须包含有效的 role 和 content');
  }
  return { role, content, timestamp: Number(message.timestamp ?? Date.now()) };
}

export class RecentContextStore {
  #filePath;
  #maxMessages;
  #data = { version: 1, conversations: {} };
  #writeChain = Promise.resolve();

  constructor({ filePath, maxMessages = 24 }) {
    this.#filePath = filePath;
    this.#maxMessages = maxMessages;
  }

  async init() {
    try {
      const parsed = JSON.parse(await readFile(this.#filePath, 'utf8'));
      if (parsed?.version === 1 && parsed.conversations && typeof parsed.conversations === 'object') {
        this.#data = parsed;
      } else {
        throw new Error('状态文件结构无效');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`无法读取近期上下文：${error.message}`);
    }
  }

  get(conversationId) {
    const items = this.#data.conversations[String(conversationId)] ?? [];
    return items.map((item) => ({ ...item }));
  }

  async append(conversationId, message) {
    const key = String(conversationId);
    const next = [...(this.#data.conversations[key] ?? []), cleanMessage(message)];
    this.#data.conversations[key] = next.slice(-this.#maxMessages);
    await this.#scheduleWrite();
  }

  async flush() {
    await this.#writeChain;
  }

  #scheduleWrite() {
    const snapshot = JSON.stringify(this.#data, null, 2);
    const task = async () => {
      await mkdir(path.dirname(this.#filePath), { recursive: true });
      const temporaryPath = `${this.#filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, this.#filePath);
    };
    this.#writeChain = this.#writeChain.then(task, task);
    return this.#writeChain;
  }
}
