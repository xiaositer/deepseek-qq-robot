import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RecentContextStore } from '../src/recent-context-store.js';

test('isolates conversations, trims history, and restores it', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qq-context-'));
  const filePath = path.join(directory, 'context.json');
  const store = new RecentContextStore({ filePath, maxMessages: 2 });
  await store.init();
  await store.append('private:1', { role: 'user', content: 'one' });
  await store.append('private:2', { role: 'user', content: 'other' });
  await store.append('private:1', { role: 'assistant', content: 'two' });
  await store.append('private:1', { role: 'user', content: 'three' });

  assert.deepEqual(store.get('private:1').map((item) => item.content), ['two', 'three']);
  assert.deepEqual(store.get('private:2').map((item) => item.content), ['other']);

  const restored = new RecentContextStore({ filePath, maxMessages: 2 });
  await restored.init();
  assert.deepEqual(restored.get('private:1').map((item) => item.content), ['two', 'three']);
});
