/** A completely offline deterministic adapter makes the demo/test repeatable. */
export function createMockModel({ targetText = 'Welcome to the AI Agent Showcase' } = {}) {
  let step = 0;
  const responses = [
    { toolCalls: [{ id: 'demo-read', name: 'read_project_file', args: { path: 'index.html' } }] },
    { toolCalls: [{ id: 'demo-edit', name: 'replace_in_file', args: { path: 'index.html', oldText: 'Sample Headline', newText: targetText } }] },
    { toolCalls: [{ id: 'demo-check', name: 'run_project_check', args: { path: 'index.html', expectedText: targetText } }] },
    { text: 'Read, edited and checked the demo page. See tool trace for execution evidence.', toolCalls: [] }
  ];
  return { async next() { return responses[step++] ?? responses.at(-1); } };
}

/** Optional live OpenAI-compatible API adapter. No SDK or credential required for offline demo. */
export function createLiveModel({ apiKey = process.env.OPENAI_API_KEY, baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', model = process.env.OPENAI_MODEL } = {}) {
  if (!apiKey || !model) throw new Error('OPENAI_API_KEY and OPENAI_MODEL are required for live mode');
  let endpoint;
  try { endpoint = new URL('chat/completions', baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'); }
  catch { throw new Error('Invalid OPENAI_BASE_URL'); }
  if (endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(endpoint.hostname)) throw new Error('HTTPS base URL required');
  return {
    async next(messages, tools, { signal } = {}) {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', temperature: 0 }), signal: signal ?? AbortSignal.timeout(45000)
      });
      if (!response.ok) throw new Error('LLM_HTTP_' + response.status);
      const data = await response.json();
      const message = data.choices?.[0]?.message;
      if (!message) throw new Error('Missing LLM response message');
      return {
        text: message.content ?? '',
        toolCalls: (message.tool_calls || []).map(call => {
          let args;
          try { args = JSON.parse(call.function.arguments || '{}'); }
          catch { args = null; }
          return { id: String(call.id), name: String(call.function.name), args };
        })
      };
    }
  };
}
