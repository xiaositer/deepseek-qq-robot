import test from 'node:test';
import assert from 'node:assert/strict';
import { extractText, normalizeOneBotMessage } from '../src/qq-adapter.js';

test('extracts only text segments', () => {
  const text = extractText({ message: [
    { type: 'at', data: { qq: '99' } },
    { type: 'text', data: { text: ' 你好' } },
    { type: 'image', data: { file: 'x' } }
  ] });
  assert.equal(text, '你好');
});

test('removes non-text CQ codes from string messages', () => {
  assert.equal(extractText({ message: '[CQ:at,qq=99] 你好 [CQ:image,file=x]' }), '你好');
});

test('normalizes a private OneBot event', () => {
  const message = normalizeOneBotMessage({
    post_type: 'message',
    message_type: 'private',
    message_id: 12,
    user_id: 100,
    self_id: 200,
    time: 10,
    sender: { nickname: '测试者' },
    raw_message: '在吗',
    message: '在吗'
  });
  assert.equal(message.conversationId, 'private:100');
  assert.equal(message.content, '在吗');
  assert.equal(message.senderName, '测试者');
});

test('detects a group mention of self', () => {
  const message = normalizeOneBotMessage({
    post_type: 'message',
    message_type: 'group',
    message_id: 13,
    group_id: 300,
    user_id: 100,
    self_id: 200,
    message: [
      { type: 'at', data: { qq: '200' } },
      { type: 'text', data: { text: ' 在吗' } }
    ]
  });
  assert.equal(message.conversationId, 'group:300');
  assert.equal(message.mentionedSelf, true);
});
