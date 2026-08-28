import test from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeekClient, DeepSeekError } from '../src/deepseek-client.js';

const config = {
  apiKey: 'test-key',
  baseUrl: 'https://api.deepseek.com',
  model: 'test-model',
  timeoutMs: 1_000,
  maxRetries: 0,
  maxTokens: 100
};

test('calls DeepSeek chat completions without thinking mode', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      model: 'test-model',
      choices: [{ message: { content: '  你好  ' } }],
      usage: { total_tokens: 8 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = new DeepSeekClient(config, { fetchImpl });
  const result = await client.chat([{ role: 'user', content: '在吗' }]);

  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(request.options.headers.authorization, 'Bearer test-key');
  assert.deepEqual(request.body.thinking, { type: 'disabled' });
  assert.equal(result.content, '你好');
});

test('does not retry an authentication error', async () => {
  let calls = 0;
  const client = new DeepSeekClient({ ...config, maxRetries: 2 }, {
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: 'bad key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  await assert.rejects(() => client.chat([]), (error) => error instanceof DeepSeekError && error.status === 401);
  assert.equal(calls, 1);
});
