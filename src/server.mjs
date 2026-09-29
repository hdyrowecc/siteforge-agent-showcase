// Local-only backend demonstration. Not a public or authenticated production API.
// Scripted execution and caller-declared HTML checks are deliberately different
// from proving that an arbitrary natural-language website request was fulfilled.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, cp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjectTools } from './tools.mjs';
import { runAgent } from './agent.mjs';
import { createMockModel, createLiveModel } from './provider.mjs';
import { createRunCoordinator } from './run-coordinator.mjs';

const FIXTURE_DIR = fileURLToPath(new URL('../demo-site/', import.meta.url));
const FIXED_DEMO_CHECKS = [{ path: 'index.html', expectedText: 'Welcome to the AI Agent Showcase' }];

function declaredChecks(input) {
  // This demo contains one existing HTML route and validates its H1 only.
  // The caller, never the model, specifies what successful evidence looks like.
  if (!Array.isArray(input) || input.length !== 1) return null;
  const [check] = input;
  if (!check || Object.keys(check).sort().join(',') !== 'expectedText,path' ||
      check.path !== 'index.html' || typeof check.expectedText !== 'string' ||
      !check.expectedText.trim() || check.expectedText.length > 300) return null;
  return [{ path: check.path, expectedText: check.expectedText }];
}

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

/**
 * Exported factory permits isolated HTTP integration tests without a network
 * model. In normal use modelFactory chooses a scripted or real LLM adapter.
 */
export function createShowcaseServer({
  liveMode = process.env.AGENT_MODE === 'live',
  modelFactory = () => liveMode ? createLiveModel() : createMockModel(),
  coordinator = createRunCoordinator()
} = {}) {
  return createServer(async (req, res) => {
    if (req.url === '/health' && req.method === 'GET') return send(res, 200, { ok: true });
    if (req.url !== '/agent/run' || req.method !== 'POST')
      return send(res, 404, { error: 'Not found' });

    const chunks = [];
    let bytes = 0;
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 8192) return send(res, 413, { error: 'Body too large' });
        chunks.push(chunk);
      }
    } catch {
      if (!res.writableEnded && !res.destroyed) send(res, 400, { error: 'Incomplete request body' });
      return;
    }

    let input;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return send(res, 400, { error: 'Invalid JSON' }); }
    const instruction = input?.instruction;
    if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 4000)
      return send(res, 422, { error: 'instruction must be 1-4000 characters' });

    const checks = liveMode ? declaredChecks(input?.requiredChecks) : FIXED_DEMO_CHECKS;
    if (liveMode && !checks) return send(res, 422, {
      code: 'GOAL_CONTRACT_REQUIRED',
      error: 'Live demo requires [{path:"index.html",expectedText:"..."}]; HTML H1 checks do not prove an entire website request.'
    });
    if (Object.hasOwn(input, 'request_id') &&
        (typeof input.request_id !== 'string' || !/^[\w-]{8,90}$/.test(input.request_id)))
      return send(res, 422, { code: 'INVALID_KEY', error: 'request_id must be 8–90 word or dash characters' });

    const run = async () => {
      const workspace = await mkdtemp(join(tmpdir(), 'agent-api-'));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45_000);
      try {
        await cp(FIXTURE_DIR, workspace, { recursive: true });
        const result = await runAgent({
          instruction, model: modelFactory(), tools: createProjectTools(workspace),
          requiredChecks: checks, signal: controller.signal
        });
        const status = liveMode
          ? result.status === 'verified' ? 'contract_verified' : 'unverified'
          : result.status === 'verified' ? 'demo_verified' : 'demo_unverified';
        return {
          ...result, status,
          verificationScope: liveMode ? 'caller-declared-html-h1-only' : 'fixed-scripted-fixture-only',
          fullInstructionVerified: false,
          finalHtml: await readFile(join(workspace, 'index.html'), 'utf8')
        };
      } finally {
        clearTimeout(timeout);
        await rm(workspace, { recursive: true, force: true });
      }
    };

    try {
      // Every request consumes capacity. A client key is reusable; anonymous
      // requests get an internal random ID in a separate namespace.
      const key = input.request_id ? 'client-' + input.request_id : 'anon-' + randomUUID();
      const result = await coordinator.executeOnce(key, {
        instruction, liveMode, checks
      }, run);
      return send(res, 200, result);
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[A-Z_]{3,48}$/.test(error.code)
        ? error.code : 'RUN_FAILED';
      const status = code === 'KEY_CONFLICT' ? 409
        : code === 'INVALID_KEY' ? 422
        : code === 'RUN_CAPACITY_EXCEEDED' ? 503 : 500;
      if (status === 503) res.setHeader('Retry-After', '1');
      return send(res, status, { code, error: code });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3001);
  createShowcaseServer().listen(port, '127.0.0.1',
    () => console.log('Local showcase API: http://127.0.0.1:' + port));
}
