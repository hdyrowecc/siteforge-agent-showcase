// Local-only backend demonstration: POST /agent/run creates an isolated disposable fixture.
// Intentionally NOT a public, authenticated, long-running production API.
import { createServer } from 'node:http';
import { mkdtemp, cp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createProjectTools } from './tools.mjs';
import { runAgent } from './agent.mjs';
import { createMockModel, createLiveModel } from './provider.mjs';
import { createRunCoordinator } from './run-coordinator.mjs';

const port = Number(process.env.PORT || 3001);
const live = process.env.AGENT_MODE === 'live';
const coordinator = createRunCoordinator();
function send(res, status, obj) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
const server = createServer(async (req, res) => {
  if (req.url === '/health' && req.method === 'GET') return send(res, 200, { ok: true });
  if (req.url !== '/agent/run' || req.method !== 'POST') return send(res, 404, { error: 'Not found' });
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 8192) return send(res, 413, { error: 'Body too large' });
    chunks.push(chunk);
  }
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return send(res, 400, { error: 'Invalid JSON' }); }
  const instruction = input?.instruction;
  if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 4000) return send(res, 422, { error: 'instruction must be 1-4000 characters' });
  const run = async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agent-api-'));
    try {
      await cp(resolve('demo-site'), workspace, { recursive: true });
      const model = live ? createLiveModel() : createMockModel();
      const result = await runAgent({ instruction, model, tools: createProjectTools(workspace) });
      return { ...result, finalHtml: await readFile(join(workspace, 'index.html'), 'utf8') };
    } finally { await rm(workspace, { recursive: true, force: true }); }
  };
  try {
    const requestId = input?.request_id;
    const result = requestId ? await coordinator.executeOnce(requestId, { instruction, live }, run) : await run();
    return send(res, 200, result);
  } catch (error) {
    const code = String(error.code || error.message || 'Run failed').slice(0,100);
    return send(res, code === 'KEY_CONFLICT' ? 409 : code === 'INVALID_KEY' ? 422 : 500, { error: code });
  }
});
server.listen(port, '127.0.0.1', () => console.log('Local showcase API: http://127.0.0.1:' + port));
