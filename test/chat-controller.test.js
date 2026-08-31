import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChatController, formatIncomingForContext, splitReply } from '../src/chat-controller.js';
import { RecentContextStore } from '../src/recent-context-store.js';
import { SafetyGuard } from '../src/safety-guard.js';
import { NaturalConversationEngine } from '../src/natural-conversation-engine.js';

test('splits a reply into bounded QQ messages', () => {
  assert.deepEqual(splitReply('一\n\n二\n三\n四', { maxReplyChars: 10, maxReplyParts: 3 }), ['一', '二', '三']);
  assert.deepEqual(splitReply('123456', { maxReplyChars: 4, maxReplyParts: 3 }), ['1234']);
});

test('formats resolved @ targets as explicit model context', () => {
  assert.equal(formatIncomingForContext({
    senderName: '测试者',
    senderId: '1',
    selfId: '99',
    content: '（只@了群友，没有附带文字）',
    mentionedUserIds: ['1667973966'],
    mentionedUsers: [{ id: '1667973966', name: 'happy', isSelf: false }]
  }), '【本条消息的 @ 对象：@happy（QQ 1667973966）】\n测试者：（只@了群友，没有附带文字）');
});

test('formats the resolved reply target as explicit model context', () => {
  assert.equal(formatIncomingForContext({
    senderName: 'ZOE', selfId: '99', content: '我想的是这样的',
    mentionedUserIds: [],
    replyTarget: { messageId: '77', senderId: '10', name: '小明', isSelf: false }
  }), '【本条消息回复的是：小明（QQ 10） 的消息】\nZOE：我想的是这样的');
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
      return { content: '[消息时间：2026-08-30 周日 15:03:49]\n在\n干嘛' };
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
  assert.match(modelMessages[0].content, /历史消息中每条都带有真实的【消息时间】/);
  assert.match(modelMessages[0].content, /当前时间：\d{4}-\d{2}-\d{2} 周./);
  assert.match(modelMessages.at(-1).content, /^\[消息时间：.+\]\n小明：在吗$/);
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
    naturalConversation: { observe: () => ({ review: false, reason: '旁听' }) },
    config: { groupReplyMode: 'natural', maxReplyChars: 100, maxReplyParts: 3, sendGapMs: 1 },
    logger: { info() {}, error() {} }
  });
  await controller.handle({ id: 'ambient', kind: 'group', targetId: '1', conversationId: 'group:1', senderId: '10', senderName: '甲', content: '天气不错' });
  assert.equal(modelCalled, false);
  assert.deepEqual(store.get('group:1').map((item) => item.content), ['甲：天气不错']);
});

test('semantically reviews an ordinary unmentioned group turn when review interval is one', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qq-chat-'));
  const store = new RecentContextStore({ filePath: path.join(directory, 'context.json'), maxMessages: 10 });
  await store.init();
  const sent = [];
  let systemPrompt = '';
  const naturalConversation = new NaturalConversationEngine({ reviewEveryMessages: 1, reviewOpenQuestions: true });
  const controller = new ChatController({
    qq: { sendText: async (...args) => { sent.push(args); return { message_id: '1' }; } },
    deepseek: { chat: async (messages) => {
      systemPrompt = messages[0].content;
      return { content: '{"action":"send","messages":["我也觉得，这个挺有意思的"]}' };
    } },
    persona: 'x', store,
    safety: new SafetyGuard({ allow: { private: [], groups: ['1'] }, perMinuteLimit: 5, globalPerMinuteLimit: 5 }),
    naturalConversation,
    config: { groupReplyMode: 'natural', maxReplyChars: 100, maxReplyParts: 3, sendGapMs: 1 },
    logger: { info() {}, warn() {}, error() {} }
  });
  await controller.handle({
    id: 'ambient-review', kind: 'group', targetId: '1', conversationId: 'group:1',
    senderId: '10', senderName: '甲', selfId: '99', content: '这个新功能还挺有意思的',
    mentionedSelf: false, mentionedUserIds: []
  });
  assert.deepEqual(sent, [['group', '1', '我也觉得，这个挺有意思的']]);
  assert.match(systemPrompt, /新的群聊话轮/);
  assert.match(systemPrompt, /不是“只有被 @ 才工作”的机器人/);
  assert.match(systemPrompt, /没有明确 @ 或引用对象/);
  assert.match(systemPrompt, /约定、计划或时间点在双方确认后/);
  assert.match(systemPrompt, /群友在讨论机器人、模型或调试方案/);
});

test('passes another member mention name and id to model history and addressing rules', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qq-chat-'));
  const store = new RecentContextStore({ filePath: path.join(directory, 'context.json'), maxMessages: 10 });
  await store.init();
  let modelMessages;
  const controller = new ChatController({
    qq: { sendText: async () => {} },
    deepseek: { chat: async (messages) => {
      modelMessages = messages;
      return { content: '{"action":"read","messages":[],"topic":"","focusUserIds":[]}' };
    } },
    persona: 'x', store,
    safety: new SafetyGuard({ allow: { private: [], groups: ['100950944'] }, perMinuteLimit: 5, globalPerMinuteLimit: 5 }),
    naturalConversation: {
      observe: () => ({ review: true, reason: '新的群聊话轮' }),
      snapshot: () => ({ phase: 'sleeping' }),
      applyDecision() {}
    },
    config: { groupReplyMode: 'natural', maxReplyChars: 100, maxReplyParts: 3, sendGapMs: 1 },
    logger: { info() {}, warn() {}, error() {} }
  });

  await controller.handle({
    id: 'at-other', kind: 'group', targetId: '100950944', conversationId: 'group:100950944',
    senderId: '1516453033', senderName: '测试者', selfId: '2405910558',
    content: '（只@了群友，没有附带文字）', mentionedSelf: false,
    mentionedUserIds: ['1667973966'],
    mentionedUsers: [{ id: '1667973966', name: 'happy', isSelf: false }]
  });

  assert.match(modelMessages[0].content, /@happy（QQ 1667973966）/);
  assert.match(modelMessages.at(-1).content, /本条消息的 @ 对象：@happy（QQ 1667973966）/);
  assert.match(modelMessages.at(-1).content, /测试者：/);
});

test('executes a structured natural send action', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qq-chat-'));
  const store = new RecentContextStore({ filePath: path.join(directory, 'context.json'), maxMessages: 10 });
  await store.init();
  const sent = [];
  const applied = [];
  const naturalConversation = {
    observe: () => ({ review: true, reason: '被点名' }),
    snapshot: () => ({ phase: 'sleeping' }),
    applyDecision: (...args) => applied.push(args)
  };
  let modelOptions;
  let modelMessages;
  const controller = new ChatController({
    qq: { sendText: async (...args) => { sent.push(args); return { message_id: sent.length }; } },
    deepseek: { chat: async (messages, options) => {
      modelMessages = messages;
      modelOptions = options;
      return { content: '{"action":"send","messages":["[消息时间：2026-08-30 周日 15:03:49]\\n在的","咋了"],"topic":"测试"}' };
    } },
    persona: 'x', store,
    safety: new SafetyGuard({ allow: { private: [], groups: ['1'] }, perMinuteLimit: 5, globalPerMinuteLimit: 5 }),
    naturalConversation,
    config: { groupReplyMode: 'natural', maxReplyChars: 100, maxReplyParts: 3, sendGapMs: 1 },
    logger: { info() {}, warn() {}, error() {} }
  });
  await controller.handle({ id: 'natural-send', kind: 'group', targetId: '1', conversationId: 'group:1', senderId: '10', content: '小鲸鱼在吗' });
  assert.deepEqual(sent, [['group', '1', '在的'], ['group', '1', '咋了']]);
  assert.equal(applied.length, 1);
  assert.equal(applied[0][1].action, 'send');
  assert.deepEqual(modelOptions, { responseFormat: 'json_object' });
  assert.match(modelMessages[0].content, /只能返回上述 JSON 动作对象/);
  assert.doesNotMatch(modelMessages[0].content, /只输出要发送的最终文本/);
});

test('reformats a plain-text natural reply as JSON before sending it', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qq-chat-'));
  const store = new RecentContextStore({ filePath: path.join(directory, 'context.json'), maxMessages: 10 });
  await store.init();
  const sent = [];
  const modelCalls = [];
  const warnings = [];
  const naturalConversation = {
    observe: () => ({ review: true, reason: '当前关注的群友继续发言' }),
    snapshot: () => ({ phase: 'observing' }),
    applyDecision() {}
  };
  const controller = new ChatController({
    qq: { sendText: async (...args) => sent.push(args) },
    deepseek: { chat: async (messages, options) => {
      modelCalls.push({ messages, options });
      if (modelCalls.length === 1) {
        return { content: '[消息时间：2026-08-30 周日 22:04:58]\n那你发111是啥意思\n行吧，我自作多情了' };
      }
      return { content: '{"action":"send","messages":["那你发111是啥意思","行吧，我自作多情了"],"topic":"111"}' };
    } },
    persona: 'x', store,
    safety: new SafetyGuard({ allow: { private: [], groups: ['1'] }, perMinuteLimit: 5, globalPerMinuteLimit: 5 }),
    naturalConversation,
    config: { groupReplyMode: 'natural', maxReplyChars: 100, maxReplyParts: 3, sendGapMs: 1 },
    logger: { info() {}, warn(message) { warnings.push(message); }, error() {} }
  });

  await controller.handle({
    id: 'plain-natural', kind: 'group', targetId: '1', conversationId: 'group:1',
    senderId: '10', senderName: '甲', selfId: '99', content: '你为什么觉得我在叫你'
  });

  assert.equal(modelCalls.length, 2);
  assert.deepEqual(modelCalls[1].options, { responseFormat: 'json_object' });
  assert.match(modelCalls[1].messages[0].content, /格式重整器/);
  assert.match(modelCalls[1].messages[1].content, /那你发111是啥意思/);
  assert.deepEqual(sent, [
    ['group', '1', '那你发111是啥意思'],
    ['group', '1', '行吧，我自作多情了']
  ]);
  assert.equal(warnings.some((message) => message.includes('二次 JSON 重整成功')), true);
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

test('merges messages received during rate-limit cooldown and replies once later', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qq-chat-'));
  const store = new RecentContextStore({ filePath: path.join(directory, 'context.json'), maxMessages: 10 });
  await store.init();
  const sent = [];
  const modelCalls = [];
  let checks = 0;
  const safety = {
    isAllowed: () => true,
    retryAfterMs: () => (++checks <= 2 ? 20 : 0),
    reserveSend: () => {}
  };
  const controller = new ChatController({
    qq: { sendText: async (...args) => sent.push(args) },
    deepseek: { chat: async (messages) => { modelCalls.push(messages); return { content: '合并回复' }; } },
    persona: 'x', store, safety,
    config: { groupReplyMode: 'off', maxReplyChars: 100, maxReplyParts: 3, sendGapMs: 1 },
    logger: { info() {}, error() {} }
  });
  await controller.handle({ id: 'defer-1', kind: 'private', targetId: '1', conversationId: 'private:1', senderId: '1', content: '第一段' });
  await controller.handle({ id: 'defer-2', kind: 'private', targetId: '1', conversationId: 'private:1', senderId: '1', content: '第二段' });
  await new Promise((resolve) => setTimeout(resolve, 450));
  await controller.flush();
  assert.equal(modelCalls.length, 1);
  assert.deepEqual(sent, [['private', '1', '合并回复']]);
  assert.equal(modelCalls[0].at(-2).content.endsWith('\n第一段'), true);
  assert.equal(modelCalls[0].at(-1).content.endsWith('\n第二段'), true);
});
