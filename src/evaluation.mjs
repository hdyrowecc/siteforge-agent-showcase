/**
 * Offline, deterministic Eval runner for the public coding-Agent showcase.
 * Every case has explicit evidence checks and an expected outcome.
 * All scenarios are synthetic; no production traces, prompts or customer assets.
 */

const VERDICTS = new Set(['PASS', 'FAIL', 'INCONCLUSIVE']);
function normalizedChecks(checks) {
  if (!Array.isArray(checks)) throw new TypeError('Eval inspect() must return evidence checks');
  const names = new Set();
  return checks.map(check => {
    const name = String(check?.name || '');
    if (!/^[a-z][a-z0-9_-]{1,48}$/.test(name) || names.has(name))
      throw new TypeError('Eval check names must be valid and unique');
    names.add(name);
    if (check.passed !== true && check.passed !== false && check.passed !== null)
      throw new TypeError('Eval evidence must be true, false, or null (unknown)');
    return { name, passed: check.passed };
  });
}

export function verdictForEvidence(checks) {
  const valid = normalizedChecks(checks);
  if (!valid.length) return 'INCONCLUSIVE';
  if (valid.some(c => c.passed === false)) return 'FAIL';
  return valid.every(c => c.passed === true) ? 'PASS' : 'INCONCLUSIVE';
}

export async function evaluateOfflineCases(cases) {
  if (!Array.isArray(cases) || !cases.length) throw new TypeError('At least one Eval case is required');
  const seen = new Set();
  const results = [];
  for (const scenario of cases) {
    const { id, category, expected, execute, inspect } = scenario || {};
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{2,48}$/.test(id) || seen.has(id))
      throw new TypeError('Eval IDs must be valid and unique');
    if (typeof category !== 'string' || !/^[a-z][a-z-]{2,30}$/.test(category))
      throw new TypeError('Invalid Eval category');
    if (!VERDICTS.has(expected) || typeof execute !== 'function' || typeof inspect !== 'function')
      throw new TypeError('Eval case needs expected, execute() and inspect()');
    seen.add(id);
    try {
      const observation = await execute();
      const checks = normalizedChecks(await inspect(observation));
      const observed = verdictForEvidence(checks);
      results.push({ id, category, expected, observed, matched: observed === expected, checks });
    } catch (error) {
      // No raw exception message, source code, model text or user content in reports.
      results.push({ id, category, expected, observed: 'EXECUTION_ERROR', matched: false,
        errorCode: /^[A-Z_]{2,48}$/.test(String(error?.code || '')) ? error.code : 'CASE_EXECUTION_ERROR',
        checks: [] });
    }
  }
  const matched = results.filter(r => r.matched).length;
  return {
    suite: 'sanitized-coding-agent-offline-v1',
    dataset: 'controlled-synthetic',
    measurement: 'deterministic-regression-not-online-agent-success-rate',
    cases: results,
    summary: { total: results.length, matched, mismatched: results.length - matched,
      allExpectationsMet: matched === results.length }
  };
}
