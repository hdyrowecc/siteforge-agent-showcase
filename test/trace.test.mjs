import test from 'node:test';
import assert from 'node:assert/strict';
import { createSafeTrace, analyzeTrace } from '../src/trace.mjs';
import { runObservedDemo, syntheticRetryExample } from '../examples/trace-demo.mjs';

test('real offline fixture emits model, tool and verification spans without credentials', async () => {
  const result = await runObservedDemo();
  assert.equal(result.outcome, 'verified');
  assert.equal(result.source, 'actual-offline-synthetic-fixture');
  assert.equal(result.trace.spans.filter(s => s.phase === 'tool').length, 3);
  assert.equal(result.trace.spans.filter(s => s.phase === 'model').length, 4);
  assert.equal(result.trace.spans.filter(s => s.phase === 'verification').length, 1);
  assert.equal(result.analysis.tokenUsage.totalTokens, null, 'unmeasured token usage must not become zero');
  assert.equal(result.analysis.failedToolCalls, 0);
  assert.equal(Object.values(result.analysis.wallTimeMs).reduce((a, b) => a + b, 0), result.analysis.durationMs);
});

test('strict Trace allowlist excludes prompts, customer content and API keys', () => {
  let time = 0;
  const trace = createSafeTrace({ clock: () => time });
  trace.record({ phase: 'model', startMs: 0, durationMs: 100, attributes: {
    model: 'offline-adapter', outcome: 'success', inputTokens: 800, outputTokens: 50,
    prompt: 'private prompt', content: 'customer HTML', authorization: 'Bearer sensitive',
    apiKey: 'sensitive', tool: '../../invalid', errorCode: 'OK'
  } });
  time = 100;
  const serialized = JSON.stringify(trace.snapshot());
  assert.equal(serialized.includes('private prompt'), false);
  assert.equal(serialized.includes('customer HTML'), false);
  assert.equal(serialized.includes('sensitive'), false);
  assert.deepEqual(trace.snapshot().spans[0].attributes, {
    model: 'offline-adapter', errorCode: 'OK', outcome: 'success', inputTokens: 800, outputTokens: 50
  });
});

test('nested and overlapping spans do not double-count elapsed wall time', () => {
  const analysis = analyzeTrace({ durationMs: 100, spans: [
    { phase: 'model', startMs: 0, durationMs: 70, attributes: { outcome: 'success' } },
    { phase: 'tool', startMs: 30, durationMs: 50, attributes: { outcome: 'success' } },
    { phase: 'verification', startMs: 70, durationMs: 20, attributes: { outcome: 'success' } }
  ] });
  assert.deepEqual(analysis.wallTimeMs, {
    model: 30, tool: 40, verification: 20, workspace: 0, other: 10
  });
  assert.equal(analysis.durationMs, 100);
});

test('invented retry timeline is explicitly synthetic and accounts for failed attempts', () => {
  const sample = syntheticRetryExample();
  assert.equal(sample.trace.source, 'invented-illustrative-data-not-a-real-run');
  assert.equal(sample.analysis.failedModelAttempts, 1);
  assert.equal(sample.analysis.tokenUsage.totalTokens, 1760);
  assert.equal(Object.values(sample.analysis.wallTimeMs).reduce((a, b) => a + b, 0), 1800);
});

test('bounded Trace drops surplus spans without copying their attributes', () => {
  const trace = createSafeTrace({ maxSpans: 1, clock: () => 0 });
  trace.record({ phase: 'tool', startMs: 0, durationMs: 3, attributes: { tool: 'read_project_file' } });
  trace.record({ phase: 'tool', startMs: 3, durationMs: 4, attributes: { tool: 'replace_in_file' } });
  assert.equal(trace.snapshot().spans.length, 1);
  assert.equal(trace.snapshot().discardedSpans, 1);
});

test('failed observed operations produce sanitized failure spans and still throw', async () => {
  let now = 0;
  const trace = createSafeTrace({ clock: () => now });
  await assert.rejects(trace.capture('tool', { tool: 'replace_in_file' }, async () => {
    now = 23;
    const error = new Error('raw customer text must never appear in Trace');
    error.code = 'AMBIGUOUS_EDIT';
    throw error;
  }), e => e.code === 'AMBIGUOUS_EDIT');
  assert.deepEqual(trace.snapshot().spans[0].attributes, {
    tool: 'replace_in_file', errorCode: 'AMBIGUOUS_EDIT', outcome: 'failure'
  });
  assert.equal(JSON.stringify(trace.snapshot()).includes('raw customer'), false);
});


test('partially recorded input is not presented as complete model usage', () => {
  const report = analyzeTrace({ durationMs: 50, spans: [
    { phase: 'model', startMs: 0, durationMs: 20,
      attributes: { inputTokens: 100, outputTokens: 0 } },
    { phase: 'model', startMs: 20, durationMs: 30,
      attributes: { outputTokens: 25 } }
  ] });
  assert.deepEqual(report.tokenUsage, {
    inputTokens: null,
    outputTokens: 25,
    totalTokens: null,
    knownInputTokens: 100,
    knownOutputTokens: 25,
    recordedInputSpans: 1,
    recordedOutputSpans: 2,
    recordedModelSpans: 1,
    modelSpans: 2,
    completeness: 'partial'
  });
});

test('an explicitly reported zero is distinct from an unreported output', () => {
  const zero = analyzeTrace({ durationMs: 10, spans: [
    { phase: 'model', startMs: 0, durationMs: 10,
      attributes: { inputTokens: 0, outputTokens: 0 } }
  ] });
  assert.equal(zero.tokenUsage.totalTokens, 0);
  assert.equal(zero.tokenUsage.completeness, 'complete');
  const unknown = analyzeTrace({ durationMs: 10, spans: [
    { phase: 'model', startMs: 0, durationMs: 10,
      attributes: { inputTokens: 100 } }
  ] });
  assert.equal(unknown.tokenUsage.inputTokens, 100);
  assert.equal(unknown.tokenUsage.outputTokens, null);
  assert.equal(unknown.tokenUsage.totalTokens, null);
  assert.equal(unknown.tokenUsage.completeness, 'partial');
});

test('unrecorded usage never becomes a zero-token metric', () => {
  const result = analyzeTrace({ durationMs: 10, spans: [
    { phase: 'model', startMs: 0, durationMs: 10, attributes: { outcome: 'success' } }
  ] });
  assert.equal(result.tokenUsage.inputTokens, null);
  assert.equal(result.tokenUsage.outputTokens, null);
  assert.equal(result.tokenUsage.totalTokens, null);
  assert.equal(result.tokenUsage.knownInputTokens, null);
  assert.equal(result.tokenUsage.completeness, 'unrecorded');
});


test('dropped spans invalidate complete-looking token totals', () => {
  const analysis = analyzeTrace({
    durationMs: 10, discardedSpans: 1,
    spans: [{ phase: 'model', startMs: 0, durationMs: 10,
      attributes: { inputTokens: 100, outputTokens: 20 } }]
  });
  assert.equal(analysis.tokenUsage.completeness, 'truncated');
  assert.equal(analysis.tokenUsage.inputTokens, null);
  assert.equal(analysis.tokenUsage.outputTokens, null);
  assert.equal(analysis.tokenUsage.totalTokens, null);
  assert.equal(analysis.tokenUsage.knownInputTokens, 100);
  assert.equal(analysis.tokenUsage.knownOutputTokens, 20);
  assert.equal(analysis.discardedSpans, 1);
});

test('a bounded trace with a dropped model span cannot claim exact usage', () => {
  let time = 0;
  const trace = createSafeTrace({ maxSpans: 1, clock: () => time });
  trace.record({ phase: 'model', startMs: 0, durationMs: 5,
    attributes: { inputTokens: 8, outputTokens: 1 } });
  trace.record({ phase: 'model', startMs: 5, durationMs: 5,
    attributes: { inputTokens: 99, outputTokens: 99 } });
  time = 10;
  const result = analyzeTrace(trace.snapshot());
  assert.equal(result.tokenUsage.completeness, 'truncated');
  assert.equal(result.tokenUsage.totalTokens, null);
  assert.equal(result.tokenUsage.knownInputTokens, 8);
  assert.equal(result.tokenUsage.modelSpans, 1);
});
