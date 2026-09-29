import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from '../src/agent.mjs';
import { createMockModel } from '../src/provider.mjs';
import { createProjectTools } from '../src/tools.mjs';

async function withFixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-contract-test-'));
  try {
    await cp(fileURLToPath(new URL('../demo-site/', import.meta.url)), dir, { recursive: true });
    return await fn(dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('model-selected verification is a self-check, not user-goal verification', () =>
  withFixture(async dir => {
    const result = await runAgent({
      instruction: 'Generate an unrelated 12-page booking app',
      model: createMockModel(), tools: createProjectTools(dir)
    });
    assert.equal(result.status, 'self_checked');
    assert.equal(result.verification.verified, false);
    assert.equal(result.verification.selfChecked, true);
    assert.equal(result.verification.contractProvided, false);
  }));

test('caller-owned goal must match checked post-edit evidence', () =>
  withFixture(async dir => {
    const result = await runAgent({
      instruction: 'Change the heading', model: createMockModel(),
      tools: createProjectTools(dir),
      requiredChecks: [{ path: 'index.html', expectedText: 'An unrelated title' }]
    });
    assert.equal(result.status, 'unverified');
    assert.deepEqual(result.verification.unmetChecks, ['index.html']);
  }));

test('an uncooperative model wait exits promptly on deadline and never executes late tool calls', () =>
  withFixture(async dir => {
    const controller = new AbortController();
    let modelEntered;
    const started = new Promise(resolve => { modelEntered = resolve; });
    let release;
    const lateModel = { next() {
      modelEntered();
      return new Promise(resolve => { release = resolve; });
    } };
    let toolCalls = 0;
    const original = createProjectTools(dir);
    const tools = Object.fromEntries(Object.entries(original).map(([name, fn]) => [
      name, async args => { toolCalls++; return fn(args); }
    ]));
    const pending = runAgent({
      instruction: 'Do not let a late model edit my workspace', model: lateModel,
      tools, signal: controller.signal,
      requiredChecks: [{ path: 'index.html', expectedText: 'Late title' }]
    });
    await started;
    controller.abort({ code: 'DEADLINE_EXCEEDED' });
    const result = await pending;
    assert.equal(result.status, 'timed_out');
    assert.equal(result.calls, 0);
    release({ toolCalls: [{ id: 'late', name: 'replace_in_file', args: {
      path: 'index.html', oldText: 'Sample Headline', newText: 'Late title'
    } }] });
    await Promise.resolve();
    assert.equal(toolCalls, 0);
    assert.doesNotMatch(await readFile(join(dir, 'index.html'), 'utf8'), /Late title/);
  }));

test('ordinary user cancellation remains distinct from a deadline', async () => {
  const controller = new AbortController();
  controller.abort('user cancelled');
  const result = await runAgent({
    instruction: 'Inspect a file', model: { next: () => { throw Error('must not call'); } },
    tools: {}, signal: controller.signal
  });
  assert.equal(result.status, 'cancelled');
});


test('a blocked tool releases the Agent wait on deadline and cannot supply late evidence', () =>
  withFixture(async dir => {
    const controller = new AbortController();
    const original = createProjectTools(dir);
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    let release;
    let laterToolsStarted = 0;
    let capturedSignal;
    const tools = {
      ...original,
      read_project_file: (_args, options) => {
        capturedSignal = options.signal;
        entered();
        return new Promise(resolve => { release = resolve; });
      },
      replace_in_file: () => { laterToolsStarted++; throw new Error('must not run'); }
    };
    let modelCalls = 0;
    const model = { next: async () => {
      modelCalls++;
      return { toolCalls: [
        { id: 'blocked-read', name: 'read_project_file', args: { path: 'index.html' } },
        { id: 'should-not-edit', name: 'replace_in_file',
          args: { path: 'index.html', oldText: 'Sample Headline', newText: 'Late title' } }
      ] };
    } };
    const pending = runAgent({
      instruction: 'Inspect and edit the fixture',
      model, tools, signal: controller.signal,
      requiredChecks: [{ path: 'index.html', expectedText: 'Late title' }]
    });
    await started;
    assert.equal(capturedSignal, controller.signal, 'custom tools receive the cancellation signal');
    controller.abort({ code: 'DEADLINE_EXCEEDED' });
    const result = await pending;
    assert.equal(result.status, 'timed_out');
    assert.equal(result.calls, 1, 'the attempted tool counts against the budget');
    assert.deepEqual(result.trace.map(t => [t.tool, t.outcome]),
      [['read_project_file', 'timed_out']]);
    assert.equal(modelCalls, 1);
    assert.equal(laterToolsStarted, 0);

    release({ path: 'index.html', content: '<h1>Late title</h1>' });
    await Promise.resolve();
    assert.equal(laterToolsStarted, 0, 'late tool output cannot restart Agent execution');
    assert.doesNotMatch(await readFile(join(dir, 'index.html'), 'utf8'), /Late title/);
  }));

test('user cancellation of a pending tool is distinct from the deadline', () =>
  withFixture(async dir => {
    const controller = new AbortController();
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    let rejectLate;
    const tools = {
      ...createProjectTools(dir),
      read_project_file: () => {
        entered();
        return new Promise((_, reject) => { rejectLate = reject; });
      }
    };
    const pending = runAgent({
      instruction: 'Read a file', signal: controller.signal, tools,
      model: { next: async () => ({ toolCalls: [
        { id: 'waiting-read', name: 'read_project_file', args: { path: 'index.html' } }
      ] }) }
    });
    await started;
    controller.abort('stopped by caller');
    const result = await pending;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.calls, 1);
    assert.equal(result.trace[0].outcome, 'cancelled');
    // A late rejection remains handled by the original raced promise.
    rejectLate(new Error('late underlying tool failure'));
    await Promise.resolve();
  }));
