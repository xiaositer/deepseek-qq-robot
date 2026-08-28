import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimitError, SafetyGuard } from '../src/safety-guard.js';

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
  assert.throws(
    () => guard.reserveSend('private:1', 3_000),
    (error) => error instanceof RateLimitError && error.retryAfterMs === 58_000
  );
  assert.equal(guard.retryAfterMs('private:1', 1, 3_000), 58_000);
  assert.equal(guard.retryAfterMs('private:1', 1, 60_000), 1_000);
  assert.equal(guard.retryAfterMs('private:1', 1, 61_001), 0);
  assert.equal(guard.retryAfterMs('private:1', 1, 62_001), 0);
});

test('reserves all bubbles in one reply atomically', () => {
  const guard = new SafetyGuard({
    allow: { private: ['1'], groups: [] },
    perMinuteLimit: 3,
    globalPerMinuteLimit: 10
  });
  guard.reserveSend('private:1', 1_000);
  assert.throws(
    () => guard.reserveSends('private:1', 3, 2_000),
    (error) => error instanceof RateLimitError && error.retryAfterMs === 59_000
  );
  guard.reserveSends('private:1', 2, 2_000);
  assert.equal(guard.retryAfterMs('private:1', 1, 3_000), 58_000);
});
