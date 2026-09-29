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


test('in-flight work is bounded; identical requests still join at capacity', async () => {
  const coordinator = createRunCoordinator({ maxEntries: 2 });
  const release = [];
  let started = 0;
  const pending = () => new Promise(resolve => { release.push(resolve); started++; });
  const first = coordinator.executeOnce('request-001', { goal: 'A' }, pending);
  const second = coordinator.executeOnce('request-002', { goal: 'B' }, pending);
  await Promise.resolve();
  assert.equal(started, 2);
  assert.equal(coordinator.size(), 2);
  assert.equal(coordinator.activeCount(), 2);

  let duplicateExecuted = false;
  const duplicate = coordinator.executeOnce('request-001', { goal: 'A' }, async () => {
    duplicateExecuted = true;
  });
  await assert.rejects(
    coordinator.executeOnce('request-003', { goal: 'C' }, pending),
    error => error.code === 'RUN_CAPACITY_EXCEEDED'
  );
  await assert.rejects(
    coordinator.executeOnce('request-001', { goal: 'different' }, pending),
    error => error.code === 'KEY_CONFLICT'
  );
  assert.equal(started, 2, 'an over-capacity or duplicate call cannot start new work');

  release[0]('done-1');
  assert.equal(await first, 'done-1');
  assert.equal(await duplicate, 'done-1');
  assert.equal(duplicateExecuted, false);
  assert.equal(coordinator.activeCount(), 1);

  // The completed entry is evicted, never the still-active request.
  assert.equal(await coordinator.executeOnce('request-003', { goal: 'C' }, async () => 'done-3'), 'done-3');
  assert.equal(coordinator.size(), 2);
  release[1]('done-2');
  assert.equal(await second, 'done-2');
});

test('failed work releases capacity without retaining a false successful result', async () => {
  const coordinator = createRunCoordinator({ maxEntries: 1 });
  await assert.rejects(coordinator.executeOnce('request-001', {}, async () => {
    throw new Error('temporary failure');
  }));
  assert.equal(coordinator.size(), 0);
  assert.equal(await coordinator.executeOnce('request-002', {}, async () => 42), 42);
});

test('TTL begins when a run settles, not when a long task starts', async () => {
  let clock = 0;
  let release;
  const coordinator = createRunCoordinator({ ttlMs: 10, maxEntries: 1, now: () => clock });
  const task = coordinator.executeOnce('request-001', { kind: 'slow' }, () => new Promise(resolve => {
    release = resolve;
  }));
  await Promise.resolve();
  clock = 1000;
  assert.equal(coordinator.size(), 1, 'active work must never expire from the idempotency map');
  release(1);
  await task;
  clock = 1009;
  assert.equal(coordinator.size(), 1);
  clock = 1010;
  assert.equal(coordinator.size(), 0);
});

test('rejects invalid memory limits before accepting work', () => {
  for (const value of [0, -1, 1.2, Infinity, 10001])
    assert.throws(() => createRunCoordinator({ maxEntries: value }), RangeError);
  assert.throws(() => createRunCoordinator({ ttlMs: 0 }), RangeError);
});
