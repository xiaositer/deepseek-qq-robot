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

test('allows one unaddressed follow-up after replying, then returns to sampling', () => {
  const engine = new NaturalConversationEngine({ reviewEveryMessages: 99 });
  const current = message({ mentionedSelf: true });
  engine.observe(current);
  engine.applyDecision(current, { action: 'send', messages: ['在'], focusUserIds: ['10'], topic: '当前话题' }, { messageIds: ['88'] });
  assert.equal(engine.snapshot('group:1').phase, 'observing');
  assert.equal(engine.observe(message({ senderId: '10', content: '然后呢' })).review, true);
  assert.equal(engine.observe(message({ senderId: '10', content: '我跟别人继续聊' })).review, false);
  assert.equal(engine.observe(message({ senderId: '11', replyMessageId: '88' })).review, true);
});

test('a focused speaker replying to someone else ends focus but still enters semantic review', () => {
  const engine = new NaturalConversationEngine({ reviewEveryMessages: 1 });
  const current = message({ mentionedSelf: true });
  engine.observe(current);
  engine.applyDecision(current, { action: 'send', messages: ['在'], focusUserIds: ['10'], topic: '当前话题' }, { messageIds: ['88'] });

  const observation = engine.observe(message({
    senderId: '10',
    replyMessageId: '77',
    replyTarget: { messageId: '77', senderId: '20', name: '群友乙', isSelf: false }
  }));
  assert.equal(observation.review, true);
  assert.equal(engine.snapshot('group:1').phase, 'sleeping');
  assert.deepEqual(engine.snapshot('group:1').focusUserIds, []);
});

test('ends implicit focus when another group member speaks in between', () => {
  const engine = new NaturalConversationEngine({ reviewEveryMessages: 99, reviewOpenQuestions: false });
  const current = message({ mentionedSelf: true });
  engine.observe(current);
  engine.applyDecision(current, { action: 'send', messages: ['在'], focusUserIds: ['10'], topic: '当前话题' });

  assert.equal(engine.observe(message({ senderId: '20', content: '我插一句' })).review, false);
  assert.equal(engine.observe(message({ senderId: '10', content: '是啊' })).review, false);
  assert.equal(engine.snapshot('group:1').phase, 'sleeping');
});

test('messages that @ another member still enter review by accumulation, and @ all counts as addressing everyone', () => {
  const engine = new NaturalConversationEngine({ reviewEveryMessages: 2, reviewOpenQuestions: false });
  const atOther = engine.observe(message({
    mentionedUserIds: ['20'], selfId: '99', content: '你觉得呢'
  }));
  assert.equal(atOther.review, false);

  const atOtherAgain = engine.observe(message({
    mentionedUserIds: ['20'], selfId: '99', content: '我也是这么想的'
  }));
  assert.equal(atOtherAgain.review, true);

  const atAll = new NaturalConversationEngine({ reviewEveryMessages: 99, reviewOpenQuestions: false })
    .observe(message({ mentionedUserIds: ['all'], selfId: '99', content: '今晚有人开黑吗' }));
  assert.equal(atAll.review, true);
  assert.match(atAll.reason, /全体成员/);

  const replySelf = new NaturalConversationEngine({ reviewEveryMessages: 99 })
    .observe(message({
      replyMessageId: 'old-bot-message',
      replyTarget: { messageId: 'old-bot-message', senderId: '99', name: '小鲸鱼', isSelf: true }
    }));
  assert.equal(replySelf.review, true);
  assert.match(replySelf.reason, /引用回复了你/);
});
