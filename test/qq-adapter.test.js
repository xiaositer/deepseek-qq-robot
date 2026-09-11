import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractMentionedUserIds,
  extractText,
  normalizeOneBotMessage,
  resolveMentionedUsers,
  resolveReplyTarget
} from '../src/qq-adapter.js';

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

test('extracts mentioned QQ ids from CQ-code string messages', () => {
  assert.deepEqual(extractMentionedUserIds({ message: '[CQ:at,qq=99] [CQ:at,qq=88]你好' }), ['99', '88']);
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
  assert.deepEqual(message.mentionedUserIds, ['200']);
});

test('keeps a mention-only group message instead of dropping it as empty', () => {
  const message = normalizeOneBotMessage({
    post_type: 'message',
    message_type: 'group',
    message_id: 99,
    group_id: 100950944,
    user_id: 1516453033,
    self_id: 2405910558,
    sender: { card: '。。。。' },
    message: [{ type: 'at', data: { qq: '2405910558' } }]
  });

  assert.equal(message.mentionedSelf, true);
  assert.equal(message.content, '（只@了你，没有附带文字）');
  assert.deepEqual(message.mentionedUserIds, ['2405910558']);
});

test('still ignores a truly empty message without a self mention', () => {
  assert.equal(normalizeOneBotMessage({
    post_type: 'message',
    message_type: 'group',
    group_id: 1,
    user_id: 2,
    self_id: 3,
    message: []
  }), null);
});

test('keeps a mention-only message aimed at another group member', () => {
  const message = normalizeOneBotMessage({
    post_type: 'message', message_type: 'group', message_id: 100,
    group_id: 100950944, user_id: 1516453033, self_id: 2405910558,
    message: [{ type: 'at', data: { qq: '1667973966' } }]
  });

  assert.equal(message.mentionedSelf, false);
  assert.equal(message.content, '（只@了群友，没有附带文字）');
  assert.deepEqual(message.mentionedUserIds, ['1667973966']);
});

test('resolves mentioned QQ ids to group cards while preserving ids', async () => {
  const resolved = await resolveMentionedUsers({
    kind: 'group', targetId: '100950944', selfId: '2405910558',
    mentionedUserIds: ['1667973966', '2405910558']
  }, async (groupId, userId) => {
    assert.equal(groupId, '100950944');
    assert.equal(userId, '1667973966');
    return { card: 'happy', nickname: 'fallback' };
  });

  assert.deepEqual(resolved.mentionedUsers, [
    { id: '1667973966', name: 'happy', isSelf: false },
    { id: '2405910558', name: '小鲸鱼', isSelf: true }
  ]);
});

test('captures mentions of other group members for addressing context', () => {
  const message = normalizeOneBotMessage({
    post_type: 'message', message_type: 'group', message_id: 15,
    group_id: 300, user_id: 100, self_id: 200,
    message: [
      { type: 'at', data: { qq: '300' } },
      { type: 'text', data: { text: '你怎么看' } }
    ]
  });
  assert.equal(message.mentionedSelf, false);
  assert.deepEqual(message.mentionedUserIds, ['300']);
});

test('captures the replied message id', () => {
  const message = normalizeOneBotMessage({
    post_type: 'message', message_type: 'group', message_id: 14,
    group_id: 300, user_id: 100, self_id: 200,
    message: [
      { type: 'reply', data: { id: '88' } },
      { type: 'text', data: { text: '然后呢' } }
    ]
  });
  assert.equal(message.replyMessageId, '88');
});

test('resolves the sender of a replied message across process restarts', async () => {
  const resolved = await resolveReplyTarget({
    kind: 'group', targetId: '300', selfId: '200', replyMessageId: '88'
  }, async (messageId) => {
    assert.equal(messageId, '88');
    return { sender: { user_id: 100, nickname: '群友甲' }, message: [{ type: 'text', data: { text: '今天吃什么' } }] };
  }, async () => { throw new Error('not needed'); });

  assert.deepEqual(resolved.replyTarget, {
    messageId: '88', senderId: '100', name: '群友甲', isSelf: false,
    content: '今天吃什么', contentUnavailable: false
  });
});

test('extracts quoted content with mentions rendered as text and truncates long text', async () => {
  const longText = '长'.repeat(200);
  const resolved = await resolveReplyTarget({
    kind: 'group', targetId: '300', selfId: '200', replyMessageId: '77'
  }, async () => ({
    sender: { user_id: 100, nickname: '群友甲' },
    message: [
      { type: 'at', data: { qq: '200', name: '小鲸鱼' } },
      { type: 'text', data: { text: ` 你为啥${longText}` } }
    ]
  }), async () => { throw new Error('not needed'); });

  assert.equal(resolved.replyTarget.content, `@小鲸鱼 你为啥${'长'.repeat(113)}`.slice(0, 120));
  assert.equal(resolved.replyTarget.content.length, 120);
});

test('marks quoted content unavailable when the replied message has no text', async () => {
  const resolved = await resolveReplyTarget({
    kind: 'group', targetId: '300', selfId: '200', replyMessageId: '66'
  }, async () => ({
    sender: { user_id: 100, nickname: '群友甲' },
    message: [{ type: 'image', data: { file: 'x' } }]
  }), async () => { throw new Error('not needed'); });

  assert.equal(resolved.replyTarget.content, '');
  assert.equal(resolved.replyTarget.contentUnavailable, true);
});
