import { mkdtemp, cp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from '../src/agent.mjs';
import { createProjectTools } from '../src/tools.mjs';
import { createRunCoordinator } from '../src/run-coordinator.mjs';

function plannedModel(mode) {
  let step = 0;
  if (mode === 'multi-page') {
    const actions = [
      { toolCalls: [
        { id: 'read-home', name: 'read_project_file', args: { path: 'index.html' } },
        { id: 'read-about', name: 'read_project_file', args: { path: 'about.html' } },
        { id: 'read-css', name: 'read_project_file', args: { path: 'styles.css' } }
      ] },
      { toolCalls: [
        { id: 'edit-home', name: 'replace_in_file', args: { path: 'index.html', oldText: '<h1>Original Home</h1>', newText: '<h1>Build With AI</h1>' } },
        { id: 'edit-about', name: 'replace_in_file', args: { path: 'about.html', oldText: '<h1>Original About</h1>', newText: '<h1>Our Process</h1>' } },
        { id: 'edit-css', name: 'replace_in_file', args: { path: 'styles.css', oldText: '#234', newText: '#067' } }
      ] },
      { toolCalls: [
        { id: 'check-home', name: 'run_project_check', args: { path: 'index.html', expectedText: 'Build With AI' } },
        { id: 'check-about', name: 'run_project_check', args: { path: 'about.html', expectedText: 'Our Process' } }
      ] },
      { text: 'Both requested pages passed checks.', toolCalls: [] }
    ];
    return { async next() { return actions[step++] ?? actions.at(-1); } };
  }
  return {
    async next(messages) {
      step++;
      if (step === 1) return { toolCalls: [{ id: 'inspect', name: 'read_project_file', args: { path: 'index.html' } }] };
      if (step === 2) return { toolCalls: [{ id: 'broad-edit', name: 'replace_in_file', args: { path: 'index.html', oldText: '<', newText: '[' } }] };
      if (step === 3) {
        const last = [...messages].reverse().find(m => m.role === 'tool');
        if (!last || JSON.parse(last.content)?.error?.code !== 'AMBIGUOUS_EDIT')
          return { text: 'Unexpected tool result; stop without claiming success.', toolCalls: [] };
        return { text: 'Observed ambiguity, retry with a precise edit.', toolCalls: [
          { id: 'precise-edit', name: 'replace_in_file', args: { path: 'index.html', oldText: '<h1>Original Home</h1>', newText: '<h1>Recovered Home</h1>' } }
        ] };
      }
      if (step === 4) return { toolCalls: [{ id: 'recheck', name: 'run_project_check', args: { path: 'index.html', expectedText: 'Recovered Home' } }] };
      return { text: 'Targeted correction passed the check.', toolCalls: [] };
    }
  };
}

/** Bounded HTML/CSS fixture check; does not replace browser visual QA. */
export function preservationCheck(home, about, css) {
  const checks = {
    routes: home.includes('</html>') && about.includes('</html>'),
    navigation: [home, about].every(s => s.includes('href="index.html"') && s.includes('href="about.html"')),
    sharedStyles: [home, about].every(s => s.includes('href="styles.css"')),
    cta: home.includes('class="cta" href="about.html"'),
    footer: [home, about].every(s => s.includes('Portfolio demonstration footer')),
    styles: css.includes('.site-nav') && css.includes('.cta') && css.includes('.hero') && css.includes('#067'),
    goals: home.includes('<h1>Build With AI</h1>') && about.includes('<h1>Our Process</h1>')
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

export async function runShowcase(mode = 'multi-page') {
  if (mode === 'idempotency') {
    const coordinator = createRunCoordinator();
    let executions = 0;
    const task = async () => { executions++; await new Promise(done => setTimeout(done, 5)); return { ok: true }; };
    const [one, two] = await Promise.all([
      coordinator.executeOnce('portfolio-run-001', { goal: 'build' }, task),
      coordinator.executeOnce('portfolio-run-001', { goal: 'build' }, task)
    ]);
    let conflictRejected = false;
    try { await coordinator.executeOnce('portfolio-run-001', { goal: 'change' }, task); }
    catch (e) { conflictRejected = e.code === 'KEY_CONFLICT'; }
    return { scenario: mode, status: one.ok && two.ok && executions === 1 && conflictRejected ? 'verified' : 'unverified', executions, conflictRejected };
  }
  if (!['multi-page', 'repair'].includes(mode)) throw new Error('Unknown scenario');
  const dir = await mkdtemp(join(tmpdir(), 'coding-agent-showcase-'));
  try {
    await cp(fileURLToPath(new URL('./site/', import.meta.url)), dir, { recursive: true });
    const run = await runAgent({
      instruction: mode === 'multi-page' ? 'Update both page headings and hero color; preserve existing navigation, CTA, footer and styles.' : 'Respond to edit ambiguity with a smaller edit and verify.',
      model: plannedModel(mode), tools: createProjectTools(dir),
      requiredChecks: mode === 'multi-page'
        ? [{ path: 'index.html', expectedText: 'Build With AI' }, { path: 'about.html', expectedText: 'Our Process' }]
        : [{ path: 'index.html', expectedText: 'Recovered Home' }],
      maxTurns: 8, maxToolCalls: 12
    });
    const [home, about, css] = await Promise.all(['index.html', 'about.html', 'styles.css'].map(p => readFile(join(dir, p), 'utf8')));
    const check = mode === 'multi-page' ? preservationCheck(home, about, css) : null;
    return {
      scenario: mode,
      status: run.status === 'verified' && (!check || check.passed) ? 'verified' : 'unverified',
      toolCalls: run.calls,
      trace: run.trace.map(s => ({ tool: s.tool, outcome: s.outcome })),
      preservation: check,
      changedHomeHeading: home.includes(mode === 'multi-page' ? '<h1>Build With AI</h1>' : '<h1>Recovered Home</h1>')
    };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const selected = process.argv.find(a => a.startsWith('--scenario='))?.slice(11) || 'multi-page';
  const result = await runShowcase(selected);
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'verified') process.exitCode = 1;
}
