import { TOOL_SCHEMAS, ToolError } from './tools.mjs';

export class AgentConfigurationError extends Error {}

/** Small visible Agent loop; pedagogical showcase, not production SiteForge source. */
export async function runAgent({ instruction, model, tools, maxTurns = 8, maxToolCalls = 12, signal } = {}) {
  if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 4000) {
    throw new AgentConfigurationError('instruction must contain 1–4000 characters');
  }
  if (!model || typeof model.next !== 'function') throw new AgentConfigurationError('A model adapter is required');
  if (!tools) throw new AgentConfigurationError('Project tools are required');
  const messages = [
    { role: 'system', content: 'You are a coding Agent working on a tiny demo site. Inspect before editing. Use only declared tools. Run a check after each edit. Do not claim success without check evidence.' },
    { role: 'user', content: instruction }
  ];
  const trace = [];
  let calls = 0;
  let verified = false;
  for (let turn = 1; turn <= maxTurns; turn++) {
    if (signal?.aborted) return { status: 'cancelled', trace, calls, turns: turn - 1 };
    const decision = await model.next(messages, TOOL_SCHEMAS, { signal });
    if (!decision || typeof decision !== 'object') throw new AgentConfigurationError('Model adapter returned invalid data');
    const actions = Array.isArray(decision.toolCalls) ? decision.toolCalls : [];
    if (actions.length === 0) {
      return {
        status: verified ? 'verified' : 'unverified',
        answer: String(decision.text || (verified ? 'Verified.' : 'No verification evidence.')),
        trace, calls, turns: turn
      };
    }
    if (actions.length + calls > maxToolCalls) return { status: 'budget_exhausted', trace, calls, turns: turn };
    messages.push({ role: 'assistant', content: decision.text ?? null, tool_calls: actions.map(a => ({ id: a.id, type: 'function', function: { name: a.name, arguments: JSON.stringify(a.args ?? {}) } })) });
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
        for (const key of schema.function.parameters.required) if (!(key in args)) throw new ToolError('INVALID_ARGUMENT', 'Missing ' + key);
        for (const [key, val] of Object.entries(args)) if (!(key in props) || typeof val !== 'string') throw new ToolError('INVALID_ARGUMENT', 'Unexpected or invalid ' + key);
        const value = await tools[action.name](args);
        outcome = { ok: true, value };
        if (action.name === 'replace_in_file') verified = false;
        if (action.name === 'run_project_check') verified = Boolean(value?.passed);
      } catch (error) {
        outcome = { ok: false, error: { code: error.code || 'TOOL_ERROR', message: String(error.message || 'Unknown failure').slice(0,180) } };
        verified = false;
      }
      calls++;
      trace.push({ turn, tool: String(action.name).slice(0,70), outcome: outcome.ok ? 'success' : outcome.error.code, durationMs: Date.now() - startedAt });
      messages.push({ role: 'tool', tool_call_id: action.id, content: JSON.stringify(outcome) });
    }
  }
  return { status: 'budget_exhausted', trace, calls, turns: maxTurns };
}
