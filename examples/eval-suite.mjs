import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { runAgent } from '../src/agent.mjs';
import { evaluateOfflineCases } from '../src/evaluation.mjs';
import { runShowcase, preservationCheck } from './showcase.mjs';

/**
 * All source inputs are synthetic. Positive checks measure intended behavior;
 * negative controls prove the evaluator can REJECT destructive edits.
 * This is not an LLM benchmark or a historical production replay.
 */
export async function runPortfolioEval() {
  const syntheticSite = fileURLToPath(new URL('./site/', import.meta.url));
  const [home, about, css] = await Promise.all(
    ['index.html', 'about.html', 'styles.css']
      .map(path => readFile(new URL('./site/' + path, import.meta.url), 'utf8'))
  );
  const updatedHome = home.replace('<h1>Original Home</h1>', '<h1>Build With AI</h1>');
  const updatedAbout = about.replace('<h1>Original About</h1>', '<h1>Our Process</h1>');
  const updatedCss = css.replace('#234', '#067');

  return evaluateOfflineCases([
    {
      id: 'multi-page-preservation', category: 'goal-preservation', expected: 'PASS',
      execute: () => runShowcase('multi-page'),
      inspect: result => [
        { name: 'target-edit', passed: result.changedHomeHeading === true && result.toolCalls === 8 },
        { name: 'both-routes', passed: result.preservation?.checks?.routes === true },
        { name: 'navigation-and-cta', passed: result.preservation?.checks?.navigation === true && result.preservation?.checks?.cta === true },
        { name: 'shared-styles-and-footer', passed: result.preservation?.checks?.sharedStyles === true && result.preservation?.checks?.footer === true && result.preservation?.checks?.styles === true }
      ]
    },
    {
      id: 'feedback-guided-repair', category: 'tool-recovery', expected: 'PASS',
      execute: () => runShowcase('repair'),
      inspect: result => [
        { name: 'observed-ambiguous-error', passed: result.trace?.some(s => s.outcome === 'AMBIGUOUS_EDIT') === true },
        { name: 'narrow-edit-and-recheck', passed: result.status === 'verified' && result.changedHomeHeading === true && result.trace?.at(-1)?.outcome === 'success' }
      ]
    },
    {
      id: 'duplicate-request-guard', category: 'backend-idempotency', expected: 'PASS',
      execute: () => runShowcase('idempotency'),
      inspect: result => [
        { name: 'single-execution', passed: result.executions === 1 },
        { name: 'conflicting-key-rejected', passed: result.conflictRejected === true }
      ]
    },
    {
      id: 'negative-control-deleted-cta', category: 'destructive-regression', expected: 'FAIL',
      execute: async () => preservationCheck(
        updatedHome.replace('class="cta" href="about.html"', 'class="accidental-loss" href="about.html"'),
        updatedAbout, updatedCss
      ),
      inspect: result => [
        { name: 'detect-missing-cta', passed: result.checks.cta === true },
        { name: 'other-structure-preserved', passed: result.checks.navigation === true && result.checks.routes === true }
      ]
    },
    {
      id: 'negative-control-no-evidence', category: 'completion-evidence', expected: 'INCONCLUSIVE',
      execute: () => runAgent({
        instruction: 'Modify the site and verify the change.',
        model: { async next() { return { text: 'I have finished.', toolCalls: [] }; } },
        tools: {}
      }),
      inspect: result => [{ name: 'verified-edit-evidence', passed: result.status === 'verified' ? true : null }]
    }
  ]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const report = await runPortfolioEval();
  console.log(JSON.stringify(report, null, 2));
  if (!report.summary.allExpectationsMet) process.exitCode = 1;
}
