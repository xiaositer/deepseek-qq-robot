import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const personaUrl = new URL('../persona/fixed.md', import.meta.url);

test('fixed persona keeps the localized whale identity and current output protocol', async () => {
  const persona = await readFile(personaUrl, 'utf8');

  assert.match(persona, /先像(?:群友、像真人|真人、像群友)，再谈人设/);
  assert.match(persona, /蓝色大肥鱼/);
  assert.match(persona, /DeepSeek 经典梗/);
  assert.match(persona, /换行代表下一条 QQ 气泡/);
  assert.match(persona, /自然群聊动作模式/);
  assert.match(persona, /`send`/);
  assert.match(persona, /`wait`/);
  assert.match(persona, /`stay`/);
  assert.match(persona, /`read`/);
});

test('fixed persona does not advertise unavailable bridge capabilities', async () => {
  const persona = await readFile(personaUrl, 'utf8');
  const unavailable = [
    /mcp__/i,
    /qq_send_message/i,
    /qq_reply/i,
    /qq_mark_read/i,
    /qq_send_poke/i,
    /qq_memory_/i,
    /qq_(?:list|send|get|collect)_sticker/i,
    /qq_set_wake_config/i,
    /reserved2/i,
    /web_search/i
  ];

  for (const pattern of unavailable) assert.doesNotMatch(persona, pattern);
});
