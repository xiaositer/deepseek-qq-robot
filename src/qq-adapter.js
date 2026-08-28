import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

function withAccessToken(rawUrl, accessToken) {
  const url = new URL(rawUrl);
  if (accessToken && !url.searchParams.has('access_token')) {
    url.searchParams.set('access_token', accessToken);
  }
  return url.toString();
}

export function extractText(event) {
  if (typeof event?.message === 'string') return event.message.replace(/\[CQ:[^\]]+\]/g, '').trim();
  if (Array.isArray(event?.message)) {
    return event.message
      .filter((segment) => segment?.type === 'text')
      .map((segment) => String(segment?.data?.text ?? ''))
      .join('')
      .trim();
  }
  return typeof event?.raw_message === 'string' ? event.raw_message.replace(/\[CQ:[^\]]+\]/g, '').trim() : '';
}

export function normalizeOneBotMessage(event) {
  if (event?.post_type !== 'message') return null;
  const kind = event.message_type;
  if (!['private', 'group'].includes(kind)) return null;
  const targetId = kind === 'private' ? event.user_id : event.group_id;
  if (targetId === undefined || targetId === null) return null;
  const content = extractText(event);
  if (!content) return null;
  const selfId = event.self_id === undefined ? null : String(event.self_id);
  const senderId = String(event.user_id ?? event.sender?.user_id ?? '');
  const mentionedSelf = Array.isArray(event.message) && selfId
    ? event.message.some((segment) => segment?.type === 'at' && String(segment?.data?.qq ?? '') === selfId)
    : false;
  return {
    id: String(event.message_id ?? randomUUID()),
    kind,
    targetId: String(targetId),
    conversationId: `${kind}:${targetId}`,
    senderId,
    senderName: String(event.sender?.card || event.sender?.nickname || '').trim(),
    selfId,
    content,
    mentionedSelf,
    timestamp: Number(event.time ? event.time * 1000 : Date.now()),
    raw: event
  };
}

export class QQAdapter extends EventEmitter {
  #config;
  #logger;
  #socket = null;
  #stopping = false;
  #reconnectTimer = null;
  #reconnectAttempt = 0;
  #pending = new Map();

  constructor(config, { logger = console } = {}) {
    super();
    this.#config = config;
    this.#logger = logger;
  }

  async connect() {
    this.#stopping = false;
    await this.#open();
  }

  async close() {
    this.#stopping = true;
    clearTimeout(this.#reconnectTimer);
    this.#rejectPending(new Error('OneBot 连接已关闭'));
    if (this.#socket && this.#socket.readyState < WebSocket.CLOSING) this.#socket.close(1000, 'shutdown');
    this.#socket = null;
  }

  async sendText(kind, targetId, message) {
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const idField = kind === 'private' ? 'user_id' : 'group_id';
    return this.callAction(action, { [idField]: Number(targetId), message: String(message) });
  }

  async callAction(action, params = {}, timeoutMs = 15_000) {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('OneBot WebSocket 尚未连接');
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(echo);
        reject(new Error(`OneBot 动作超时：${action}`));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(echo, { resolve, reject, timer, action });
      try {
        socket.send(JSON.stringify({ action, params, echo }));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(echo);
        reject(error);
      }
    });
  }

  #open() {
    return new Promise((resolve, reject) => {
      const url = withAccessToken(this.#config.wsUrl, this.#config.accessToken);
      const socket = new WebSocket(url);
      this.#socket = socket;
      let settled = false;
      socket.addEventListener('open', () => {
        settled = true;
        this.#reconnectAttempt = 0;
        this.#logger.info?.(`[qq] 已连接 ${this.#config.wsUrl}`);
        this.emit('open');
        resolve();
      }, { once: true });
      socket.addEventListener('message', (event) => this.#handleFrame(event.data));
      socket.addEventListener('error', (event) => {
        const error = event?.error ?? new Error('OneBot WebSocket 错误');
        this.#logger.error?.('[qq] WebSocket 错误', error.message ?? error);
        this.emit('adapter-error', error);
        if (!settled) reject(error);
      });
      socket.addEventListener('close', () => {
        this.#rejectPending(new Error('OneBot WebSocket 已断开'));
        this.emit('close');
        if (!settled) reject(new Error('OneBot WebSocket 连接失败'));
        if (!this.#stopping) this.#scheduleReconnect();
      });
    });
  }

  async #handleFrame(data) {
    try {
      const text = typeof data === 'string' ? data : await new Response(data).text();
      const payload = JSON.parse(text);
      if (payload.echo && this.#pending.has(String(payload.echo))) {
        const pending = this.#pending.get(String(payload.echo));
        this.#pending.delete(String(payload.echo));
        clearTimeout(pending.timer);
        if (payload.status === 'ok' && Number(payload.retcode ?? 0) === 0) pending.resolve(payload.data);
        else pending.reject(new Error(`OneBot ${pending.action} 失败：${payload.wording || payload.message || payload.retcode || '未知错误'}`));
        return;
      }
      const message = normalizeOneBotMessage(payload);
      if (message) this.emit('message', message);
    } catch (error) {
      this.#logger.warn?.('[qq] 忽略无法解析的 OneBot 数据', error.message ?? error);
    }
  }

  #scheduleReconnect() {
    clearTimeout(this.#reconnectTimer);
    const delay = Math.min(1_000 * (2 ** this.#reconnectAttempt), 30_000);
    this.#reconnectAttempt += 1;
    this.#logger.warn?.(`[qq] ${delay}ms 后重连`);
    this.#reconnectTimer = setTimeout(() => {
      this.#open().catch((error) => this.#logger.error?.('[qq] 重连失败', error.message ?? error));
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  #rejectPending(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
