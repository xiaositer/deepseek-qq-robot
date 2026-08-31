import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

test('loads safe defaults and resolves project paths', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qq-config-'));
  await writeFile(path.join(directory, 'config.json'), JSON.stringify({
    allow: { private: [123], groups: [] },
    deepseek: { maxRetries: 0 }
  }), 'utf8');
  const config = await loadConfig({ cwd: directory, env: { DEEPSEEK_API_KEY: 'test-key' } });
  assert.deepEqual(config.allow.private, ['123']);
  assert.equal(config.chat.groupReplyMode, 'off');
  assert.equal(config.chat.naturalReviewEveryMessages, 3);
  assert.equal(config.chat.groupInputDebounceMs, 8000);
  assert.equal(config.deepseek.maxRetries, 0);
  assert.equal(config.personaPath, path.join(directory, 'persona', 'fixed.md'));
});

test('requires the DeepSeek API key', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qq-config-'));
  await writeFile(path.join(directory, 'config.json'), '{}', 'utf8');
  await assert.rejects(() => loadConfig({ cwd: directory, env: {} }), /DeepSeek API Key/);
});

test('can load an API key from local config', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qq-config-'));
  await writeFile(path.join(directory, 'config.json'), JSON.stringify({
    deepseek: { apiKey: 'local-test-key' }
  }), 'utf8');
  const config = await loadConfig({ cwd: directory, env: {} });
  assert.equal(config.deepseek.apiKey, 'local-test-key');
});
