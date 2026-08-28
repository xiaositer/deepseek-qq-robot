import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SettingsStore, mergeAndValidateSettings } from '../src/settings-store.js';

function baseConfig() {
  return {
    onebot: { wsUrl: 'ws://127.0.0.1:3001', accessToken: 'onebot-secret' },
    deepseek: { apiKey: 'deepseek-secret', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', timeoutMs: 45000, maxRetries: 2, maxTokens: 600 },
    allow: { private: ['1516453033'], groups: ['100950944'] },
    chat: {
      groupReplyMode: 'mention', inputDebounceMs: 1800, shortInputDebounceMs: 3000, maxInputWaitMs: 8000,
      naturalActiveWindowMs: 120000, naturalCooldownMs: 20000, naturalReplyChancePercent: 12,
      contextMessages: 24, maxReplyChars: 500, maxReplyParts: 3, sendGapMs: 700,
      perMinuteLimit: 8, globalPerMinuteLimit: 30
    },
    console: { port: 3100, autoStartChat: false },
    personaPath: 'persona/fixed.md',
    statePath: 'state/recent-context.json'
  };
}

test('preserves secrets when secret inputs are blank', () => {
  const current = baseConfig();
  const submitted = structuredClone(current);
  delete submitted.onebot.accessToken;
  delete submitted.deepseek.apiKey;
  submitted.chat.inputDebounceMs = 2200;
  const next = mergeAndValidateSettings(current, submitted, { deepseekApiKey: '', onebotAccessToken: '' });
  assert.equal(next.deepseek.apiKey, 'deepseek-secret');
  assert.equal(next.onebot.accessToken, 'onebot-secret');
  assert.equal(next.chat.inputDebounceMs, 2200);
});

test('rejects paths outside the project', () => {
  const submitted = baseConfig();
  submitted.personaPath = '../outside.md';
  assert.throws(() => mergeAndValidateSettings(baseConfig(), submitted), /项目内/);
});

test('redacts secrets and atomically writes settings and persona', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'qq-settings-'));
  await mkdir(path.join(rootDir, 'persona'), { recursive: true });
  await writeFile(path.join(rootDir, 'config.json'), JSON.stringify(baseConfig()), 'utf8');
  await writeFile(path.join(rootDir, 'persona', 'fixed.md'), '# old', 'utf8');
  const store = new SettingsStore({ rootDir });
  const publicSettings = await store.readPublicSettings();
  assert.equal(publicSettings.config.deepseek.apiKey, undefined);
  assert.equal(publicSettings.config.onebot.accessToken, undefined);
  assert.deepEqual(publicSettings.secrets, { hasDeepseekApiKey: true, hasOnebotAccessToken: true });

  publicSettings.config.allow.private.push('123456789');
  await store.apply({ config: publicSettings.config, persona: '# new persona', secrets: {} });
  const saved = JSON.parse(await readFile(path.join(rootDir, 'config.json'), 'utf8'));
  assert.equal(saved.deepseek.apiKey, 'deepseek-secret');
  assert.deepEqual(saved.allow.private, ['1516453033', '123456789']);
  assert.equal(await readFile(path.join(rootDir, 'persona', 'fixed.md'), 'utf8'), '# new persona');
});
