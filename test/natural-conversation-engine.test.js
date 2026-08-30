import test from 'node:test';
import assert from 'node:assert/strict';
import { NaturalConversationEngine, parseNaturalDecision } from '../src/natural-conversation-engine.js';

function message(overrides = {}) {
  return {
    conversationId: 'group:1', senderId: '10', content: '普通消息',
    mentionedSelf: false, replyMessageId: null, batchSize: 1, ...overrides
  };
}

test('parses natural action JSON and fails closed', () => {
  assert.deepEqual(parseNaturalDecision('```json\n{"action":"send","messages":["在的","咋了"],"topic":"测试"}\n```'), {
    action: 'send', messages: ['在的', '咋了'], topic: '测试', focusUserIds: [], invalid: false
  });
  assert.equal(parseNaturalDecision('不是 JSON').action, 'read');
  assert.equal(parseNaturalDecision('{"action":"send","messages":[]}').action, 'read');
  assert.deepEqual(parseNaturalDecision('{"action":"send","message":"第一句\\n第二句"}').messages, ['第一句', '第二句']);
  assert.equal(parseNaturalDecision('{"action":"unknown"}').invalid, true);
});

test('repairs an otherwise valid send action containing an unescaped quote', () => {
  const decision = parseNaturalDecision('{"action":"send","messages":["你@"我干嘛，我哪知道这整合包","要不去问问d指导的脑子"],"topic":"","focusUserIds":[]}');
  assert.deepEqual(decision, {
    action: 'send',
    messages: ['你@"我干嘛，我哪知道这整合包', '要不去问问d指导的脑子'],
    topic: '',
    focusUserIds: [],
    invalid: false,
    repaired: true
  });
});

test('does not repair malformed or unknown natural actions', () => {
  assert.equal(parseNaturalDecision('{"action":"send","messages":not-an-array}').action, 'read');
  assert.equal(parseNaturalDecision('{"action":"delete","messages":["不要发送"]}').action, 'read');
  assert.equal(parseNaturalDecision('{"action":"send","messages":[]}').action, 'read');
});

test('collects ordinary messages into an inbox before semantic review', () => {
  const engine = new NaturalConversationEngine({ reviewEveryMessages: 3, reviewOpenQuestions: false });
  assert.equal(engine.observe(message()).review, false);
  assert.equal(engine.observe(message()).review, false);
  assert.equal(engine.observe(message()).review, true);
});

test('wake-up is an opportunity rather than a forced reply', () => {
  const engine = new NaturalConversationEngine({ reviewEveryMessages: 99 });
  const directed = message({ mentionedSelf: true });
  assert.equal(engine.observe(directed).review, true);
  engine.applyDecision(directed, { action: 'wait', messages: [], focusUserIds: ['10'], topic: '等下文' });
  assert.equal(engine.snapshot('group:1').phase, 'waiting');
  assert.equal(engine.observe(message({ senderId: '10', content: '我还没说完' })).review, true);
  engine.applyDecision(directed, { action: 'read', messages: [], focusUserIds: [], topic: '' });
  assert.equal(engine.snapshot('group:1').phase, 'sleeping');
});

test('keeps observing after a reply without a fixed cooldown', () => {
  const engine = new NaturalConversationEngine({ reviewEveryMessages: 99 });
  const current = message({ mentionedSelf: true });
  engine.observe(current);
  engine.applyDecision(current, { action: 'send', messages: ['在'], focusUserIds: ['10'], topic: '当前话题' }, { messageIds: ['88'] });
  assert.equal(engine.snapshot('group:1').phase, 'observing');
  assert.equal(engine.observe(message({ senderId: '10', content: '然后呢' })).review, true);
  assert.equal(engine.observe(message({ senderId: '11', replyMessageId: '88' })).review, true);
});
