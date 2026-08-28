import { setTimeout as sleep } from 'node:timers/promises';

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export class DeepSeekError extends Error {
  constructor(message, { status, retryable = false, cause, code } = {}) {
    super(message, { cause });
    this.name = 'DeepSeekError';
    this.status = status;
    this.retryable = retryable;
    this.code = code;
  }
}

export class DeepSeekClient {
  #config;
  #fetch;

  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('当前 Node.js 环境不支持 fetch');
    this.#config = config;
    this.#fetch = fetchImpl;
  }

  async chat(messages, options = {}) {
    let lastError;
    for (let attempt = 0; attempt <= this.#config.maxRetries; attempt += 1) {
      try {
        return await this.#request(messages, options);
      } catch (error) {
        lastError = error;
        if (!error?.retryable || attempt === this.#config.maxRetries) {
          if (options.responseFormat === 'json_object' && error?.code === 'EMPTY_RESPONSE') {
            const fallback = await this.#request(messages, { ...options, responseFormat: undefined });
            return { ...fallback, jsonModeFallback: true };
          }
          throw error;
        }
        const delay = Math.min(500 * (2 ** attempt) + Math.floor(Math.random() * 250), 3_000);
        await sleep(delay);
      }
    }
    throw lastError;
  }

  async #request(messages, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#config.timeoutMs);
    timeout.unref?.();
    let response;
    const requestBody = {
      model: this.#config.model,
      messages,
      thinking: { type: 'disabled' },
      max_tokens: this.#config.maxTokens,
      stream: false
    };
    if (options.responseFormat === 'json_object') {
      requestBody.response_format = { type: 'json_object' };
    }
    try {
      response = await this.#fetch(`${this.#config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#config.apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
    } catch (error) {
      const timedOut = error?.name === 'AbortError';
      throw new DeepSeekError(timedOut ? 'DeepSeek 请求超时' : `DeepSeek 网络错误：${error.message}`, {
        retryable: true,
        cause: error
      });
    } finally {
      clearTimeout(timeout);
    }

    let body;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      const rawDetail = String(body?.error?.message ?? body?.message ?? response.statusText ?? '未知错误');
      const detail = rawDetail.replaceAll(this.#config.apiKey, '[REDACTED]');
      throw new DeepSeekError(`DeepSeek API 错误（${response.status}）：${detail.slice(0, 300)}`, {
        status: response.status,
        retryable: RETRYABLE_STATUS.has(response.status)
      });
    }

    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new DeepSeekError('DeepSeek 返回了空回复', {
        retryable: options.responseFormat === 'json_object',
        code: 'EMPTY_RESPONSE'
      });
    }

    return {
      content: content.trim(),
      usage: body.usage ?? null,
      model: body.model ?? this.#config.model
    };
  }
}
