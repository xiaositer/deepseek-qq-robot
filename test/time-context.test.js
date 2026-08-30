import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTimedHistory,
  currentTimeContext,
  formatChatTime,
  formatElapsedTime,
  stripInternalTimeMetadata
} from '../src/time-context.js';

const timeZone = 'Asia/Shanghai';

test('formats an absolute chat time with date weekday and seconds', () => {
  const timestamp = Date.parse('2026-08-30T01:10:00.000Z');
  assert.equal(formatChatTime(timestamp, { timeZone }), '2026-08-30 周日 09:10:00');
  assert.equal(currentTimeContext(timestamp, { timeZone }), '当前时间：2026-08-30 周日 09:10:00（时区 Asia/Shanghai）');
});

test('formats elapsed time for natural gap descriptions', () => {
  assert.equal(formatElapsedTime(45_000), '45 秒');
  assert.equal(formatElapsedTime(70 * 60_000), '1 小时 10 分钟');
  assert.equal(formatElapsedTime(27 * 60 * 60_000), '1 天 3 小时');
});

test('adds time metadata and marks a long conversational gap', () => {
  const history = buildTimedHistory([
    { role: 'user', content: '中午吃什么好', timestamp: Date.parse('2026-08-30T01:10:00.000Z') },
    { role: 'assistant', content: '吃面怎么样', timestamp: Date.parse('2026-08-30T01:11:00.000Z') },
    { role: 'user', content: '说到中午那个', timestamp: Date.parse('2026-08-30T12:00:00.000Z') }
  ], { timeZone });
  assert.equal(history[0].content, '[消息时间：2026-08-30 周日 09:10:00]\n中午吃什么好');
  assert.match(history[2].content, /消息时间：2026-08-30 周日 20:00:00/);
  assert.match(history[2].content, /与上一条相隔 10 小时 49 分钟，可能已进入新的聊天时段/);
});

test('removes internal time metadata before a reply is sent', () => {
  assert.equal(stripInternalTimeMetadata('[消息时间：2026-08-30 周日 15:03:49]\n刚刚在发呆'), '刚刚在发呆');
  assert.equal(stripInternalTimeMetadata('【消息时间：2026-08-30 周日 15:03:49】 好呀'), '好呀');
  assert.equal(stripInternalTimeMetadata('[消息时间：2026-08-30 周日 15:03:49]'), '');
  assert.equal(stripInternalTimeMetadata('现在是下午三点'), '现在是下午三点');
});
