import test from 'node:test';
import assert from 'node:assert/strict';
import { runShowcase, preservationCheck } from './showcase.mjs';

test('multi-page edit changes both routes and CSS while preserving existing structure', async () => {
  const r = await runShowcase('multi-page');
  assert.equal(r.status, 'verified');
  assert.equal(r.toolCalls, 8);
  assert.equal(r.changedHomeHeading, true);
  assert.equal(r.preservation.passed, true);
});

test('ambiguous tool error causes a narrower edit and a fresh check', async () => {
  const r = await runShowcase('repair');
  assert.equal(r.status, 'verified');
  assert.deepEqual(r.trace.map(x => x.outcome), ['success', 'AMBIGUOUS_EDIT', 'success', 'success']);
});

test('duplicate requests run once and conflicting request keys are rejected', async () => {
  const r = await runShowcase('idempotency');
  assert.equal(r.status, 'verified');
  assert.equal(r.executions, 1);
  assert.equal(r.conflictRejected, true);
});

test('preservation check rejects accidental CTA deletion', () => {
  const home = '<html><link href="styles.css"><a href="index.html"></a><a href="about.html"></a><h1>Build With AI</h1>Portfolio demonstration footer</html>';
  const about = '<html><link href="styles.css"><a href="index.html"></a><a href="about.html"></a><h1>Our Process</h1>Portfolio demonstration footer</html>';
  const css = '.site-nav {} .cta {} .hero {color:#067}';
  const r = preservationCheck(home, about, css);
  assert.equal(r.passed, false);
  assert.equal(r.checks.cta, false);
});
