import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('keeps persona separate from runtime transport protocols', async () => {
  const persona = await readFile(new URL('../persona/fixed.md', import.meta.url), 'utf8');
  assert.match(persona, /人格与程序协议的边界/);
  assert.match(persona, /没人点名不等于不能说话/);
  assert.match(persona, /不要把所有消息当成同一个人/);
  assert.doesNotMatch(persona, /\[SILENT\]|mcp__|qq_send|web_search|DSH|\{"action"/i);
});
