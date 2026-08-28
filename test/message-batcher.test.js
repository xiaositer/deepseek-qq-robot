import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { MessageBatcher, isShortUnfinishedText, mergeMessages } from '../src/message-batcher.js';

function message(id, content) {
  return {
    id,
    conversationId: 'private:1',
    senderId: '1',
    content,
    timestamp: Number(id),
    mentionedSelf: false
  };
}

test('recognizes short unfinished fragments', () => {
  assert.equal(isShortUnfinishedText('你现在'), true);
  assert.equal(isShortUnfinishedText('在干什么？'), false);
  assert.equal(isShortUnfinishedText('这是一条比较完整的长消息'), false);
});

test('merges consecutive message fragments into one turn', () => {
  const merged = mergeMessages([message('1', '你现在'), message('2', '在干什么')]);
  assert.equal(merged.content, '你现在\n在干什么');
  assert.equal(merged.batchSize, 2);
  assert.equal(merged.timestamp, 2);
});

test('waits for quiet time and emits only one merged batch', async () => {
  const received = [];
  const batcher = new MessageBatcher({
    onBatch: async (value) => received.push(value),
    quietMs: 10,
    shortQuietMs: 25,
    maxWaitMs: 100,
    logger: { error() {} }
  });
  batcher.add(message('1', '你现在'));
  await sleep(10);
  batcher.add(message('2', '在干什么'));
  await sleep(35);
  assert.equal(received.length, 1);
  assert.equal(received[0].content, '你现在\n在干什么');
  await batcher.close();
});

test('flush emits pending input immediately', async () => {
  const received = [];
  const batcher = new MessageBatcher({
    onBatch: async (value) => received.push(value),
    quietMs: 1_000,
    shortQuietMs: 1_000,
    maxWaitMs: 2_000,
    logger: { error() {} }
  });
  batcher.add(message('1', '测试'));
  await batcher.flush();
  assert.equal(received.length, 1);
  await batcher.close();
});
