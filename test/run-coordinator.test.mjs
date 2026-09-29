import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunCoordinator } from '../src/run-coordinator.mjs';

test('concurrent requests with the same key execute only once', async () => {
  const coordinator = createRunCoordinator();
  let called = 0;
  const work = async () => { called++; await new Promise(done => setTimeout(done, 5)); return { ok: true }; };
  const [a, b] = await Promise.all([
    coordinator.executeOnce('request-123', { instruction: 'A' }, work),
    coordinator.executeOnce('request-123', { instruction: 'A' }, work)
  ]);
  assert.equal(called, 1);
  assert.deepEqual(a, b);
});

test('the same key cannot silently change its meaning', async () => {
  const coordinator = createRunCoordinator();
  await coordinator.executeOnce('request-123', { instruction: 'A' }, async () => 1);
  await assert.rejects(coordinator.executeOnce('request-123', { instruction: 'B' }, async () => 2), e => e.code === 'KEY_CONFLICT');
});

test('failed work is not cached as a successful request', async () => {
  const coordinator = createRunCoordinator();
  let called = 0;
  await assert.rejects(coordinator.executeOnce('request-123', { instruction: 'A' }, async () => { called++; throw new Error('transient'); }));
  assert.equal(await coordinator.executeOnce('request-123', { instruction: 'A' }, async () => { called++; return 42; }), 42);
  assert.equal(called, 2);
});
