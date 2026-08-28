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
  assert.equal(request.body.response_format, undefined);
  assert.equal(result.content, '你好');
});

test('enables DeepSeek JSON output for structured decisions', async () => {
  let requestBody;
  const client = new DeepSeekClient(config, {
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"action":"read"}' } }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const result = await client.chat([{ role: 'system', content: '输出 JSON' }], { responseFormat: 'json_object' });
  assert.deepEqual(requestBody.response_format, { type: 'json_object' });
  assert.equal(result.content, '{"action":"read"}');
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

test('falls back to strict prompted text mode after repeated empty JSON responses', async () => {
  const bodies = [];
  const client = new DeepSeekClient({ ...config, maxRetries: 1 }, {
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      const content = body.response_format ? '' : '{"action":"send","messages":["在的"]}';
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  const result = await client.chat([{ role: 'system', content: '输出 JSON' }], { responseFormat: 'json_object' });
  assert.equal(bodies.length, 3);
  assert.deepEqual(bodies.slice(0, 2).map((body) => body.response_format), [
    { type: 'json_object' },
    { type: 'json_object' }
  ]);
  assert.equal(bodies[2].response_format, undefined);
  assert.equal(result.jsonModeFallback, true);
});
