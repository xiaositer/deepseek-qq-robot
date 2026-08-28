import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadFixedPersona } from '../src/fixed-persona-loader.js';

test('loads and trims a fixed persona', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qq-persona-'));
  const file = path.join(directory, 'fixed.md');
  await writeFile(file, '\uFEFF  # 小鲸鱼\n  ', 'utf8');
  assert.equal(await loadFixedPersona(file), '# 小鲸鱼');
});

test('rejects an empty persona', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qq-persona-'));
  const file = path.join(directory, 'fixed.md');
  await writeFile(file, '  ', 'utf8');
  await assert.rejects(() => loadFixedPersona(file), /角色卡为空/);
});
