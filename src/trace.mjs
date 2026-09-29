/**
 * Sanitized, dependency-free Trace example for the portfolio repository.
 * Independent illustrative code: NOT copied from the private CrossWeb AI service.
 * No prompts, source files, raw tool arguments, user IDs or exception messages are stored.
 */

const PHASES = new Set(['model', 'tool', 'verification', 'workspace']);
const OUTCOMES = new Set(['success', 'failure', 'cancelled']);
const LABEL = /^[a-zA-Z][a-zA-Z0-9_.-]{0,47}$/;

function safeAttributes(input = {}) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const key of ['tool', 'model', 'check', 'errorCode']) {
    const value = input[key];
    if (typeof value === 'string' && LABEL.test(value)) out[key] = value;
  }
  if (OUTCOMES.has(input.outcome)) out.outcome = input.outcome;
  // Tokens may be absent in offline runs. Absence is NOT zero usage.
  for (const key of ['inputTokens', 'outputTokens']) {
    if (Number.isSafeInteger(input[key]) && input[key] >= 0) out[key] = input[key];
  }
  return out;
}

export function createSafeTrace({ maxSpans = 128, clock = () => performance.now() } = {}) {
  if (!Number.isSafeInteger(maxSpans) || maxSpans < 1 || maxSpans > 1000)
    throw new RangeError('maxSpans must be between 1 and 1000');
  const origin = clock();
  const spans = [];
  let discarded = 0;

  function record({ phase, startMs, durationMs, attributes = {} }) {
    if (!PHASES.has(phase)) throw new TypeError('Unknown Trace phase');
    if (![startMs, durationMs].every(Number.isFinite) || startMs < 0 || durationMs < 0)
      throw new TypeError('Trace timings must be nonnegative finite numbers');
    if (spans.length === maxSpans) { discarded++; return null; }
    const span = {
      sequence: spans.length + 1,
      phase,
      startMs: Math.round(startMs),
      durationMs: Math.round(durationMs),
      attributes: safeAttributes(attributes)
    };
    spans.push(span);
    return span;
  }

  async function capture(phase, attributes, operation) {
    if (typeof operation !== 'function') throw new TypeError('Operation must be a function');
    const start = clock();
    try {
      const result = await operation();
      record({ phase, startMs: start - origin, durationMs: clock() - start,
        attributes: { ...attributes, outcome: 'success' } });
      return result;
    } catch (error) {
      record({ phase, startMs: start - origin, durationMs: clock() - start,
        attributes: { ...attributes, outcome: 'failure', errorCode: String(error?.code || 'OPERATION_FAILED') } });
      throw error;
    }
  }

  return {
    record, capture,
    snapshot() {
      const elapsedMs = Math.max(0, Math.round(clock() - origin));
      return {
        kind: 'sanitized-showcase-trace',
        source: 'offline-demo',
        durationMs: Math.max(elapsedMs, ...spans.map(s => s.startMs + s.durationMs), 0),
        spans: spans.map(s => ({ ...s, attributes: { ...s.attributes } })),
        discardedSpans: discarded
      };
    }
  };
}

export function observeModel(model, trace) {
  return { next: (messages, schemas, options) =>
    trace.capture('model', { model: 'offline-adapter' }, () => model.next(messages, schemas, options)) };
}

export function observeTools(tools, trace) {
  return Object.fromEntries(Object.entries(tools).map(([tool, method]) => [
    tool, (args) => trace.capture('tool', { tool }, () => method(args))
  ]));
}

/** Exclusive wall-time attribution: overlapping spans are NOT summed twice. */
export function analyzeTrace(trace) {
  const spans = Array.isArray(trace?.spans) ? trace.spans : [];
  const total = Math.max(0, Number(trace?.durationMs) || 0);
  const phases = ['verification', 'tool', 'model', 'workspace'];
  const boundaries = new Set([0, total]);
  const valid = [];
  for (const span of spans) {
    if (!PHASES.has(span?.phase) || !Number.isFinite(span?.startMs) ||
        !Number.isFinite(span?.durationMs) || span.durationMs < 0) continue;
    const start = Math.max(0, Math.min(total, span.startMs));
    const end = Math.max(start, Math.min(total, span.startMs + span.durationMs));
    valid.push({ ...span, start, end });
    boundaries.add(start); boundaries.add(end);
  }
  const points = [...boundaries].sort((a, b) => a - b);
  const attribution = { model: 0, tool: 0, verification: 0, workspace: 0, other: 0 };
  for (let i = 1; i < points.length; i++) {
    const middle = (points[i - 1] + points[i]) / 2;
    const active = valid.filter(s => s.start <= middle && middle < s.end);
    const phase = phases.find(p => active.some(s => s.phase === p)) || 'other';
    attribution[phase] += points[i] - points[i - 1];
  }
  const modelSpans = valid.filter(s => s.phase === 'model');
  const recorded = key => {
    const withMetric = modelSpans.filter(s => Number.isSafeInteger(s.attributes?.[key]) && s.attributes[key] >= 0);
    const known = withMetric.reduce((sum, s) => sum + s.attributes[key], 0);
    return {
      value: modelSpans.length > 0 && withMetric.length === modelSpans.length ? known : null,
      known: withMetric.length > 0 ? known : null,
      count: withMetric.length
    };
  };
  const input = recorded('inputTokens');
  const output = recorded('outputTokens');
  const completeSpans = modelSpans.filter(s =>
    Number.isSafeInteger(s.attributes?.inputTokens) && s.attributes.inputTokens >= 0 &&
    Number.isSafeInteger(s.attributes?.outputTokens) && s.attributes.outputTokens >= 0).length;
  const completeness = modelSpans.length > 0 && completeSpans === modelSpans.length ? 'complete'
    : input.count > 0 || output.count > 0 ? 'partial' : 'unrecorded';

  return {
    durationMs: Math.round(total),
    wallTimeMs: Object.fromEntries(Object.entries(attribution).map(([k, v]) => [k, Math.round(v)])),
    failedToolCalls: valid.filter(s => s.phase === 'tool' && s.attributes?.outcome === 'failure').length,
    failedModelAttempts: valid.filter(s => s.phase === 'model' && s.attributes?.outcome === 'failure').length,
    tokenUsage: {
      inputTokens: input.value,
      outputTokens: output.value,
      totalTokens: input.value !== null && output.value !== null ? input.value + output.value : null,
      // Partial sums are labeled as known quantities, never reported as exact totals.
      knownInputTokens: input.known,
      knownOutputTokens: output.known,
      recordedInputSpans: input.count,
      recordedOutputSpans: output.count,
      recordedModelSpans: completeSpans,
      modelSpans: modelSpans.length,
      completeness
    },
    discardedSpans: Math.max(0, Number(trace?.discardedSpans) || 0)
  };
}
