import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOfflineCases, verdictForEvidence } from '../src/evaluation.mjs';
import { runPortfolioEval } from '../examples/eval-suite.mjs';

test('portfolio Eval suite distinguishes real positive checks, negative control and missing evidence', async () => {
  const report = await runPortfolioEval();
  assert.equal(report.dataset, 'controlled-synthetic');
  assert.equal(report.summary.total, 5);
  assert.equal(report.summary.mismatched, 0);
  assert.equal(report.summary.allExpectationsMet, true);
  assert.equal(report.cases.find(c => c.id === 'negative-control-deleted-cta')?.observed, 'FAIL');
  assert.equal(report.cases.find(c => c.id === 'negative-control-no-evidence')?.observed, 'INCONCLUSIVE');
});

test('FAIL takes precedence over unknown, and missing checks are inconclusive', () => {
  assert.equal(verdictForEvidence([]), 'INCONCLUSIVE');
  assert.equal(verdictForEvidence([{ name: 'documented', passed: null }]), 'INCONCLUSIVE');
  assert.equal(verdictForEvidence([{ name: 'documented', passed: null }, { name: 'lost-navigation', passed: false }]), 'FAIL');
});

test('a broken scenario is flagged as an Eval mismatch, not silently omitted', async () => {
  const report = await evaluateOfflineCases([{
    id: 'broken-regression', category: 'goal-preservation', expected: 'PASS',
    execute: async () => ({}),
    inspect: async () => [{ name: 'requested-goal', passed: false }]
  }]);
  assert.equal(report.summary.mismatched, 1);
  assert.equal(report.cases[0].observed, 'FAIL');
});

test('Eval does not leak raw exception text into generated report', async () => {
  const report = await evaluateOfflineCases([{
    id: 'throwing-fixture', category: 'tool-recovery', expected: 'PASS',
    execute: async () => { throw new Error('private prompt and customer content'); },
    inspect: () => []
  }]);
  assert.equal(report.cases[0].observed, 'EXECUTION_ERROR');
  assert.equal(JSON.stringify(report).includes('private prompt'), false);
});
