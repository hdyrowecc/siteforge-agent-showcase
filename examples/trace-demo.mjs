import { mkdtemp, cp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from '../src/agent.mjs';
import { createMockModel } from '../src/provider.mjs';
import { createProjectTools } from '../src/tools.mjs';
import { createSafeTrace, observeModel, observeTools, analyzeTrace } from '../src/trace.mjs';

/** Actual OFFLINE execution timings from a disposable synthetic fixture, never customer data. */
export async function runObservedDemo() {
  const workspace = await mkdtemp(join(tmpdir(), 'showcase-trace-'));
  const trace = createSafeTrace();
  try {
    await cp(fileURLToPath(new URL('../demo-site/', import.meta.url)), workspace, { recursive: true });
    const tools = createProjectTools(workspace);
    const run = await runAgent({
      instruction: 'Read the synthetic fixture, make an exact H1 edit, verify the result.',
      model: observeModel(createMockModel(), trace),
      tools: observeTools(tools, trace)
    });
    const finalCheck = await trace.capture('verification', { check: 'expected_h1' }, async () => {
      const html = await readFile(join(workspace, 'index.html'), 'utf8');
      return html.includes('<h1>Welcome to the AI Agent Showcase</h1>');
    });
    const snapshot = trace.snapshot();
    return {
      source: 'actual-offline-synthetic-fixture',
      outcome: run.status === 'verified' && finalCheck ? 'verified' : 'unverified',
      trace: snapshot,
      analysis: analyzeTrace(snapshot)
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

/** Separately labeled synthetic data: illustrates model retries and recorded token usage.
 * These numbers are invented for demonstration, NOT metrics measured from CrossWeb AI.
 */
export function syntheticRetryExample() {
  const trace = {
    kind: 'sanitized-showcase-trace',
    source: 'invented-illustrative-data-not-a-real-run',
    durationMs: 1800,
    discardedSpans: 0,
    spans: [
      { sequence: 1, phase: 'workspace', startMs: 0, durationMs: 150, attributes: { outcome: 'success' } },
      { sequence: 2, phase: 'model', startMs: 150, durationMs: 650,
        attributes: { outcome: 'failure', errorCode: 'GATEWAY_TIMEOUT', inputTokens: 800, outputTokens: 0 } },
      { sequence: 3, phase: 'model', startMs: 800, durationMs: 540,
        attributes: { outcome: 'success', inputTokens: 840, outputTokens: 120 } },
      { sequence: 4, phase: 'tool', startMs: 1340, durationMs: 280,
        attributes: { tool: 'replace_in_file', outcome: 'success' } },
      { sequence: 5, phase: 'verification', startMs: 1580, durationMs: 160,
        attributes: { check: 'expected_h1', outcome: 'success' } }
    ]
  };
  return { trace, analysis: analyzeTrace(trace) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL('file://' + process.argv[1].replace(/\\/g, '/')))) {
  const result = process.argv.includes('--synthetic') ? syntheticRetryExample() : await runObservedDemo();
  console.log(JSON.stringify(result, null, 2));
  if (result.outcome && result.outcome !== 'verified') process.exitCode = 1;
}
