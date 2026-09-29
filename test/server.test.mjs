import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createShowcaseServer } from '../src/server.mjs';
import { createMockModel } from '../src/provider.mjs';
import { createRunCoordinator } from '../src/run-coordinator.mjs';

async function withServer(options, callback) {
  const server = createShowcaseServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = async body => {
    const response = await fetch(base + '/agent/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { status: response.status, retryAfter: response.headers.get('retry-after'),
      data: await response.json() };
  };
  try { await callback(post); }
  finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  }
}

test('arbitrary offline instructions only certify the fixed scripted fixture, not user intent', async () => {
  await withServer({}, async post => {
    const { status, data } = await post({ instruction: 'Build me a 12-page marketplace with payments' });
    assert.equal(status, 200);
    assert.equal(data.status, 'demo_verified');
    assert.equal(data.verificationScope, 'fixed-scripted-fixture-only');
    assert.equal(data.fullInstructionVerified, false);
    assert.match(data.finalHtml, /Welcome to the AI Agent Showcase/);
  });
});

test('live adapter rejects a missing or malformed caller-owned completion contract', async () => {
  let modelCreated = 0;
  await withServer({ liveMode: true, modelFactory: () => { modelCreated++; return createMockModel(); } },
    async post => {
      for (const body of [
        { instruction: 'Change heading' },
        { instruction: 'Change heading', requiredChecks: [] },
        { instruction: 'Change heading', requiredChecks: [{ path: '../secret.html', expectedText: 'x' }] },
        { instruction: 'Change heading', requiredChecks: [{ path: 'index.html', expectedText: '  ' }] }
      ]) {
        const response = await post(body);
        assert.equal(response.status, 422);
        assert.equal(response.data.code, 'GOAL_CONTRACT_REQUIRED');
      }
      assert.equal(modelCreated, 0, 'no model calls before validation');
    });
});

test('live API only reports contract_verified when the declared title was actually checked', async () => {
  await withServer({ liveMode: true, modelFactory: () => createMockModel() }, async post => {
    const correct = await post({ instruction: 'Change heading',
      requiredChecks: [{ path: 'index.html', expectedText: 'Welcome to the AI Agent Showcase' }] });
    assert.equal(correct.status, 200);
    assert.equal(correct.data.status, 'contract_verified');
    assert.equal(correct.data.verificationScope, 'caller-declared-html-h1-only');
    assert.equal(correct.data.fullInstructionVerified, false);

    const mismatch = await post({ instruction: 'Build an unrelated title',
      requiredChecks: [{ path: 'index.html', expectedText: 'An unrelated title' }] });
    assert.equal(mismatch.data.status, 'unverified');
    assert.deepEqual(mismatch.data.verification.unmetChecks, ['index.html']);
  });
});

test('anonymous requests also consume capacity and receive a retryable 503 when saturated', async () => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let release;
  const pause = new Promise(resolve => { release = resolve; });
  const coordinator = createRunCoordinator({ maxEntries: 1 });
  let invocations = 0;
  const modelFactory = () => ({ async next() {
    invocations++;
    entered();
    await pause;
    return { text: 'I cannot prove this goal', toolCalls: [] };
  } });
  await withServer({ coordinator, modelFactory }, async post => {
    const first = post({ instruction: 'Start task A' });
    await started;
    const overloaded = await post({ instruction: 'Start task B' });
    assert.equal(overloaded.status, 503);
    assert.equal(overloaded.retryAfter, '1');
    assert.equal(overloaded.data.code, 'RUN_CAPACITY_EXCEEDED');
    assert.equal(invocations, 1);

    release();
    assert.equal((await first).data.status, 'demo_unverified');
    const admitted = await post({ instruction: 'Start task C' });
    assert.equal(admitted.status, 200, 'completed entries may be evicted to admit new tasks');
    assert.equal(invocations, 2);
  });
});

test('keyed requests deduplicate during active work, even at full capacity', async () => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  let startedCount = 0;
  await withServer({
    coordinator: createRunCoordinator({ maxEntries: 1 }),
    modelFactory: () => ({ async next() {
      startedCount++;
      entered();
      await wait;
      return { text: 'No verified edit', toolCalls: [] };
    } })
  }, async post => {
    const args = { instruction: 'Same work', request_id: 'demo-key-001' };
    const first = post(args);
    await started;
    const second = post(args);
    const conflict = await post({ instruction: 'Changed request', request_id: 'demo-key-001' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.data.code, 'KEY_CONFLICT');
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a.data, b.data);
    assert.equal(startedCount, 1);
  });
});


test('a model that ignores AbortSignal cannot hold the API slot forever', async () => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let resolveLate;
  let toolsAfterDeadline = 0;
  const coordinator = createRunCoordinator({ maxEntries: 1 });
  await withServer({
    coordinator,
    timeoutMs: 25,
    modelFactory: () => ({ async next() {
      entered();
      return new Promise(resolve => { resolveLate = resolve; });
    } })
  }, async post => {
    const first = post({ instruction: 'Wait forever on the model', request_id: 'timeout-001' });
    await started;
    const response = await first;
    assert.equal(response.status, 504);
    assert.equal(response.data.status, 'timed_out');
    assert.equal(response.data.fullInstructionVerified, false);
    assert.equal(coordinator.activeCount(), 0);
    // An overdue model response must not be allowed to start a later tool call.
    resolveLate({ toolCalls: [{
      id: 'late-tool', name: 'replace_in_file',
      args: { path: 'index.html', oldText: 'Sample Headline', newText: 'Late mutation' }
    }] });
    await Promise.resolve();
    assert.equal(coordinator.activeCount(), 0);
    assert.equal(toolsAfterDeadline, 0);
    const second = await post({ instruction: 'Next task is admitted', request_id: 'timeout-002' });
    assert.equal(second.status, 504);
    assert.equal(coordinator.activeCount(), 0);
  });
});

test('rejects invalid API deadline configuration', () => {
  assert.throws(() => createShowcaseServer({ timeoutMs: 0 }), RangeError);
  assert.throws(() => createShowcaseServer({ timeoutMs: NaN }), RangeError);
});
