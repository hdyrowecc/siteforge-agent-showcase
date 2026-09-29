import { mkdtemp, cp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createProjectTools } from './tools.mjs';
import { runAgent } from './agent.mjs';
import { createMockModel, createLiveModel } from './provider.mjs';

const workspace = await mkdtemp(join(tmpdir(), 'agent-showcase-'));
try {
  await cp(resolve('demo-site'), workspace, { recursive: true });
  const model = process.argv.includes('--live') ? createLiveModel() : createMockModel();
  const result = await runAgent({
    instruction: 'Read index.html, change the H1 to Welcome to the AI Agent Showcase, and verify the edit.',
    model, tools: createProjectTools(workspace),
    requiredChecks: [{ path: 'index.html', expectedText: 'Welcome to the AI Agent Showcase' }]
  });
  console.log(JSON.stringify({ ...result, finalHtml: await readFile(join(workspace, 'index.html'), 'utf8') }, null, 2));
  if (result.status !== 'verified') process.exitCode = 1;
} finally { await rm(workspace, { recursive: true, force: true }); }
