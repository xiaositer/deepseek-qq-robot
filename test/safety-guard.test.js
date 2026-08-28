import test from 'node:test';
import assert from 'node:assert/strict';
import { SafetyGuard } from '../src/safety-guard.js';

test('fails closed and enforces per-conversation rate limits', () => {
  const guard = new SafetyGuard({
    allow: { private: ['1'], groups: [] },
    perMinuteLimit: 2,
    globalPerMinuteLimit: 10
  });
  assert.equal(guard.isAllowed('private', '1'), true);
  assert.equal(guard.isAllowed('private', '2'), false);
  assert.equal(guard.isAllowed('group', '1'), false);
  guard.reserveSend('private:1', 1_000);
  guard.reserveSend('private:1', 2_000);
  assert.throws(() => guard.reserveSend('private:1', 3_000), /频率已达到上限/);
});
