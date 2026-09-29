import { TOOL_SCHEMAS, ToolError } from './tools.mjs';

export class AgentConfigurationError extends Error {}

// Abort stops waiting for an uncooperative model, not the model's own side effects.
const INTERRUPTED = Symbol('interrupted');
async function nextOrAbort(invoke, signal) {
  if (!signal) return invoke();
  if (signal.aborted) return INTERRUPTED;
  let listener;
  const cancellation = new Promise(resolve => {
    listener = () => resolve(INTERRUPTED);
    signal.addEventListener('abort', listener, { once: true });
  });
  try {
    if (signal.aborted) return INTERRUPTED;
    return await Promise.race([Promise.resolve().then(invoke), cancellation]);
  } finally {
    signal.removeEventListener('abort', listener);
  }
}

function normalizeRequiredChecks(requiredChecks) {
  if (!Array.isArray(requiredChecks)) throw new AgentConfigurationError('requiredChecks must be an array');
  const goals = new Map();
  for (const item of requiredChecks) {
    if (!item || typeof item.path !== 'string' || !/^[\w./-]+\.html?$/.test(item.path) ||
        typeof item.expectedText !== 'string' || !item.expectedText.trim() || item.expectedText.length > 1000 ||
        goals.has(item.path)) {
      throw new AgentConfigurationError('requiredChecks need unique HTML paths and non-empty expectedText');
    }
    goals.set(item.path, item.expectedText);
  }
  return goals;
}

/**
 * Minimal Agent loop with an explicit, caller-owned completion contract.
 * A tool saying "passed" is not a task verdict: every changed HTML route needs
 * a check after the last edit, and every required target needs matching evidence.
 * CSS and visual preservation are verified separately by the caller.
 * Pedagogical standalone example; not production CrossWeb AI source.
 */
export async function runAgent({ instruction, model, tools, requiredChecks = [], maxTurns = 8, maxToolCalls = 12, signal } = {}) {
  if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 4000)
    throw new AgentConfigurationError('instruction must contain 1–4000 characters');
  if (!model || typeof model.next !== 'function') throw new AgentConfigurationError('A model adapter is required');
  if (!tools) throw new AgentConfigurationError('Project tools are required');
  const goals = normalizeRequiredChecks(requiredChecks);
  const messages = [
    { role: 'system', content: 'You are a coding Agent. Inspect before editing. Use only declared tools. Run an expected-text check for every edited HTML page after your last edit. The runtime independently decides whether completion evidence is sufficient.' },
    { role: 'user', content: instruction }
  ];
  const trace = [];
  const editedFiles = new Set();
  const checkedFiles = new Map();
  let calls = 0;

  function completionEvidence() {
    const editedHtml = [...editedFiles].filter(path => /\.html?$/i.test(path));
    const allEditedChecked = editedHtml.length > 0 && editedHtml.every(path => checkedFiles.has(path));
    const contractSatisfied = [...goals].every(([path, expected]) =>
      editedFiles.has(path) && checkedFiles.get(path) === expected);
    return {
      verified: goals.size > 0 && allEditedChecked && contractSatisfied,
      selfChecked: allEditedChecked,
      contractProvided: goals.size > 0,
      changedFiles: [...editedFiles],
      checkedFiles: [...checkedFiles.keys()],
      unmetChecks: [...goals.keys()].filter(path => !editedFiles.has(path) || checkedFiles.get(path) !== goals.get(path))
    };
  }

  const stopped = turns => ({
    status: signal?.reason?.code === 'DEADLINE_EXCEEDED' ? 'timed_out' : 'cancelled',
    trace, calls, turns
  });

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (signal?.aborted) return stopped(turn - 1);
    let decision;
    try {
      decision = await nextOrAbort(() => model.next(messages, TOOL_SCHEMAS, { signal }), signal);
    } catch (error) {
      if (signal?.aborted) return stopped(turn - 1);
      throw error;
    }
    if (decision === INTERRUPTED || signal?.aborted) return stopped(turn - 1);
    if (!decision || typeof decision !== 'object') throw new AgentConfigurationError('Model adapter returned invalid data');
    const actions = Array.isArray(decision.toolCalls) ? decision.toolCalls : [];
    if (actions.length === 0) {
      const evidence = completionEvidence();
      return {
        status: evidence.verified ? 'verified'
          : evidence.selfChecked && !evidence.contractProvided ? 'self_checked' : 'unverified',
        answer: String(decision.text || (evidence.verified ? 'Verified.' : 'Insufficient verification evidence.')),
        verification: evidence, trace, calls, turns: turn
      };
    }
    if (actions.length + calls > maxToolCalls) return { status: 'budget_exhausted', trace, calls, turns: turn };
    messages.push({ role: 'assistant', content: decision.text ?? null,
      tool_calls: actions.map(a => ({ id: a.id, type: 'function', function: { name: a.name, arguments: JSON.stringify(a.args ?? {}) } })) });
    for (const action of actions) {
      const startedAt = Date.now();
      let outcome;
      try {
        if (signal?.aborted) return { status: 'cancelled', trace, calls, turns: turn };
        const schema = TOOL_SCHEMAS.find(s => s.function.name === action.name);
        if (!schema || typeof tools[action.name] !== 'function') throw new ToolError('UNKNOWN_TOOL', 'Tool is not available');
        const args = action.args;
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ToolError('INVALID_ARGUMENT', 'Tool args must be an object');
        const props = schema.function.parameters.properties;
        for (const key of schema.function.parameters.required)
          if (!(key in args)) throw new ToolError('INVALID_ARGUMENT', 'Missing ' + key);
        for (const [key, val] of Object.entries(args))
          if (!(key in props) || typeof val !== 'string') throw new ToolError('INVALID_ARGUMENT', 'Unexpected or invalid ' + key);
        const value = await tools[action.name](args);
        outcome = { ok: true, value };
        if (action.name === 'replace_in_file' && value?.changed === true) {
          editedFiles.add(args.path);
          checkedFiles.clear(); // any subsequent edit invalidates ALL older verification
        }
        if (action.name === 'run_project_check') {
          if (value?.passed === true && editedFiles.has(args.path) &&
              typeof args.expectedText === 'string' && args.expectedText.trim()) {
            checkedFiles.set(args.path, args.expectedText);
          } else {
            checkedFiles.delete(args.path); // a failed or irrelevant check cannot certify the route
          }
        }
      } catch (error) {
        outcome = { ok: false, error: { code: error.code || 'TOOL_ERROR',
          message: String(error.message || 'Unknown failure').slice(0, 180) } };
        if (action.name === 'run_project_check' && typeof action.args?.path === 'string')
          checkedFiles.delete(action.args.path);
      }
      calls++;
      trace.push({ turn, tool: String(action.name).slice(0, 70),
        outcome: outcome.ok ? 'success' : outcome.error.code, durationMs: Date.now() - startedAt });
      messages.push({ role: 'tool', tool_call_id: action.id, content: JSON.stringify(outcome) });
    }
  }
  return { status: 'budget_exhausted', trace, calls, turns: maxTurns };
}
