import test from 'node:test';
import assert from 'node:assert/strict';
import { GroupParticipationPolicy } from '../src/group-participation-policy.js';

function groupMessage(overrides = {}) {
  return {
    conversationId: 'group:1', senderId: '10', content: '今天天气不错',
    mentionedSelf: false, replyMessageId: null, ...overrides
  };
}

test('always responds to mentions and textual name calls', () => {
  const policy = new GroupParticipationPolicy({ ambientChancePercent: 0 });
  assert.equal(policy.decide(groupMessage({ mentionedSelf: true }), 1_000).respond, true);
  assert.equal(policy.decide(groupMessage({ content: '小鲸鱼你怎么看' }), 1_000).respond, true);
});

test('continues a conversation without requiring another mention', () => {
  const policy = new GroupParticipationPolicy({ activeWindowMs: 10_000, ambientChancePercent: 0 });
  const message = groupMessage();
  policy.recordReply(message, { messageIds: ['88'], now: 1_000 });
  assert.equal(policy.decide(groupMessage({ content: '然后呢' }), 5_000).respond, true);
  assert.equal(policy.decide(groupMessage({ senderId: '11', replyMessageId: '88' }), 5_000).respond, true);
  assert.equal(policy.decide(groupMessage(), 12_000).respond, false);
});

test('uses probability and cooldown only for ambient interjections', () => {
  const policy = new GroupParticipationPolicy({ cooldownMs: 20_000, ambientChancePercent: 12, random: () => 0.01 });
  const message = groupMessage();
  assert.equal(policy.decide(message, 30_000).respond, true);
  policy.recordReply(message, { now: 30_000 });
  assert.equal(policy.decide(groupMessage({ senderId: '11' }), 35_000).respond, false);
});
