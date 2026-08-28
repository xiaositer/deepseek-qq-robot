import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChatController, splitReply } from '../src/chat-controller.js';
import { RecentContextStore } from '../src/recent-context-store.js';
import { SafetyGuard } from '../src/safety-guard.js';

test('splits a reply into bounded QQ messages', () => {
  assert.deepEqual(splitReply('一\n\n二\n三\n四', { maxReplyChars: 10, maxReplyParts: 3 }), ['一', '二', '三']);
  assert.deepEqual(splitReply('123456', { maxReplyChars: 4, maxReplyParts: 3 }), ['1234']);
});

test('runs the minimal private chat flow and saves context', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qq-chat-'));
  const store = new RecentContextStore({ filePath: path.join(directory, 'context.json'), maxMessages: 10 });
  await store.init();
  const sent = [];
  const qq = { sendText: async (...args) => sent.push(args) };
  let modelMessages;
  const deepseek = {
    chat: async (messages) => {
      modelMessages = messages;
      return { content: '在\n干嘛' };
    }
  };
  const safety = new SafetyGuard({
    allow: { private: ['100'], groups: [] },
    perMinuteLimit: 8,
    globalPerMinuteLimit: 20
  });
  const controller = new ChatController({
    qq,
    deepseek,
    persona: '# 小鲸鱼',
    store,
    safety,
    config: { groupReplyMode: 'off', maxReplyChars: 100, maxReplyParts: 3, sendGapMs: 1 },
    logger: { info() {}, error() {} }
  });

  await controller.handle({
    id: 'm1',
    kind: 'private',
    targetId: '100',
    conversationId: 'private:100',
    senderId: '100',
    selfId: '200',
    senderName: '小明',
    content: '在吗',
    timestamp: 1
  });

  assert.deepEqual(sent, [['private', '100', '在'], ['private', '100', '干嘛']]);
  assert.match(modelMessages[0].content, /小鲸鱼/);
  assert.equal(modelMessages.at(-1).content, '小明：在吗');
  assert.deepEqual(store.get('private:100').map((item) => item.role), ['user', 'assistant']);
});

test('ignores a non-whitelisted message', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qq-chat-'));
  const store = new RecentContextStore({ filePath: path.join(directory, 'context.json') });
  await store.init();
  let called = false;
  const controller = new ChatController({
    qq: { sendText: async () => { called = true; } },
    deepseek: { chat: async () => { called = true; return { content: 'x' }; } },
    persona: 'x',
    store,
    safety: new SafetyGuard({ allow: { private: [], groups: [] }, perMinuteLimit: 2, globalPerMinuteLimit: 2 }),
    config: { groupReplyMode: 'off', maxReplyChars: 100, maxReplyParts: 1, sendGapMs: 1 },
    logger: { info() {}, error() {} }
  });
  assert.equal(await controller.handle({ id: 'x', kind: 'private', targetId: '9', conversationId: 'private:9', senderId: '9', content: 'hi' }), false);
  assert.equal(called, false);
});

test('records only successfully sent parts when a later send fails', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qq-chat-'));
  const store = new RecentContextStore({ filePath: path.join(directory, 'context.json'), maxMessages: 10 });
  await store.init();
  let sends = 0;
  const controller = new ChatController({
    qq: { sendText: async () => { sends += 1; if (sends === 2) throw new Error('send failed'); } },
    deepseek: { chat: async () => ({ content: '第一条\n第二条' }) },
    persona: 'x',
    store,
    safety: new SafetyGuard({ allow: { private: ['1'], groups: [] }, perMinuteLimit: 5, globalPerMinuteLimit: 5 }),
    config: { groupReplyMode: 'off', maxReplyChars: 100, maxReplyParts: 3, sendGapMs: 1 },
    logger: { info() {}, error() {} }
  });
  await controller.handle({ id: 'partial', kind: 'private', targetId: '1', conversationId: 'private:1', senderId: '1', content: 'hi' });
  assert.deepEqual(store.get('private:1').map((item) => item.content), ['hi', '第一条']);
});

test('keeps silent without sending when the model chooses natural silence', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qq-chat-'));
  const store = new RecentContextStore({ filePath: path.join(directory, 'context.json'), maxMessages: 10 });
  await store.init();
  let sent = false;
  const controller = new ChatController({
    qq: { sendText: async () => { sent = true; } },
    deepseek: { chat: async () => ({ content: '[SILENT]' }) },
    persona: 'x',
    store,
    safety: new SafetyGuard({ allow: { private: ['1'], groups: [] }, perMinuteLimit: 5, globalPerMinuteLimit: 5 }),
    config: { groupReplyMode: 'off', maxReplyChars: 100, maxReplyParts: 3, sendGapMs: 1 },
    logger: { info() {}, error() {} }
  });
  await controller.handle({ id: 'silent', kind: 'private', targetId: '1', conversationId: 'private:1', senderId: '1', content: '嗯' });
  assert.equal(sent, false);
  assert.deepEqual(store.get('private:1').map((item) => item.role), ['user']);
});

test('observes passive natural group messages without calling the model', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qq-chat-'));
  const store = new RecentContextStore({ filePath: path.join(directory, 'context.json'), maxMessages: 10 });
  await store.init();
  let modelCalled = false;
  const controller = new ChatController({
    qq: { sendText: async () => {} },
    deepseek: { chat: async () => { modelCalled = true; return { content: 'x' }; } },
    persona: 'x', store,
    safety: new SafetyGuard({ allow: { private: [], groups: ['1'] }, perMinuteLimit: 5, globalPerMinuteLimit: 5 }),
    participation: { decide: () => ({ respond: false, reason: '旁听' }) },
    config: { groupReplyMode: 'natural', maxReplyChars: 100, maxReplyParts: 3, sendGapMs: 1 },
    logger: { info() {}, error() {} }
  });
  await controller.handle({ id: 'ambient', kind: 'group', targetId: '1', conversationId: 'group:1', senderId: '10', senderName: '甲', content: '天气不错' });
  assert.equal(modelCalled, false);
  assert.deepEqual(store.get('group:1').map((item) => item.content), ['甲：天气不错']);
});

test('cancels an unsent reply when a newer message arrives', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qq-chat-'));
  const store = new RecentContextStore({ filePath: path.join(directory, 'context.json'), maxMessages: 10 });
  await store.init();
  let resolveModel;
  let modelStarted;
  const started = new Promise((resolve) => { modelStarted = resolve; });
  const sent = [];
  const controller = new ChatController({
    qq: { sendText: async (...args) => sent.push(args) },
    deepseek: { chat: async () => { modelStarted(); return new Promise((resolve) => { resolveModel = resolve; }); } },
    persona: 'x', store,
    safety: new SafetyGuard({ allow: { private: ['1'], groups: [] }, perMinuteLimit: 5, globalPerMinuteLimit: 5 }),
    config: { groupReplyMode: 'off', maxReplyChars: 100, maxReplyParts: 3, sendGapMs: 1 },
    logger: { info() {}, error() {} }
  });
  const first = { id: 'old', kind: 'private', targetId: '1', conversationId: 'private:1', senderId: '1', content: '你现在' };
  const pending = controller.handle(first);
  await started;
  controller.noteIncoming({ id: 'new', kind: 'private', targetId: '1', conversationId: 'private:1', senderId: '1', content: '在干什么' });
  resolveModel({ content: '旧回复' });
  await pending;
  assert.deepEqual(sent, []);
});
