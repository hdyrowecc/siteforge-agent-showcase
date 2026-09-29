import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectTools } from '../src/tools.mjs';
import { runAgent } from '../src/agent.mjs';
import { createMockModel } from '../src/provider.mjs';

async function withWorkspace(fn) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-test-'));
  await writeFile(join(workspace, 'index.html'), '<!doctype html><html><body><h1>Sample Headline</h1></body></html>');
  try { await fn(workspace, createProjectTools(workspace)); }
  finally { await rm(workspace, { recursive: true, force: true }); }
}

test('agent actually edits and verifies a demo site', async () => withWorkspace(async (dir, tools) => {
  const result = await runAgent({ instruction: 'Change the H1 and check it', model: createMockModel(), tools,
    requiredChecks: [{ path: 'index.html', expectedText: 'Welcome to the AI Agent Showcase' }] });
  assert.equal(result.status, 'verified');
  assert.equal(result.calls, 3);
  assert.deepEqual(result.trace.map(t => t.tool), ['read_project_file', 'replace_in_file', 'run_project_check']);
  assert.match(await readFile(join(dir, 'index.html'), 'utf8'), /Welcome to the AI Agent Showcase/);
}));

test('traversal and absolute paths cannot be read', async () => withWorkspace(async (_, tools) => {
  await assert.rejects(tools.read_project_file({ path: '../outside.html' }), e => e.code === 'UNSAFE_PATH');
  await assert.rejects(tools.read_project_file({ path: '/etc/passwd' }), e => e.code === 'UNSAFE_PATH');
}));

test('symlink pointing outside the workspace is rejected', async (t) => withWorkspace(async (dir, tools) => {
  const outside = await mkdtemp(join(tmpdir(), 'outside-'));
  try {
    await writeFile(join(outside, 'secret.html'), 'private');
    try {
      await symlink(join(outside, 'secret.html'), join(dir, 'external.html'));
    } catch (error) {
      // Windows often denies symlink creation without Developer Mode; that is an OS permission failure, not a failed security boundary.
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip('Windows denied symlink creation; the complete security test still runs in Linux CI');
        return;
      }
      throw error;
    }
    await assert.rejects(tools.read_project_file({ path: 'external.html' }), e => e.code === 'UNSAFE_PATH');
  } finally { await rm(outside, { recursive: true, force: true }); }
}));

test('ambiguous replacements are rejected before side effects', async () => withWorkspace(async (dir, tools) => {
  await writeFile(join(dir, 'index.html'), '<h1>repeat</h1><p>repeat</p>');
  await assert.rejects(tools.replace_in_file({ path: 'index.html', oldText: 'repeat', newText: 'new' }), e => e.code === 'AMBIGUOUS_EDIT');
  assert.equal(await readFile(join(dir, 'index.html'), 'utf8'), '<h1>repeat</h1><p>repeat</p>');
}));

test('verification reports failure for missing requested H1', async () => withWorkspace(async (_, tools) => {
  const result = await tools.run_project_check({ path: 'index.html', expectedText: 'Missing title' });
  assert.equal(result.passed, false);
}));

test('invalid model tool arguments return structured errors', async () => withWorkspace(async (_, tools) => {
  let n = 0;
  const model = { async next() { n++; return n === 1
    ? { toolCalls: [{ id: 'x', name: 'replace_in_file', args: { path: 'index.html', oldText: 8, newText: 'xx' } }] }
    : { text: 'Stopped', toolCalls: [] }; } };
  const result = await runAgent({ instruction: 'invalid args', model, tools });
  assert.equal(result.status, 'unverified');
  assert.equal(result.trace[0].outcome, 'INVALID_ARGUMENT');
}));

test('task stops at a strict turn budget', async () => withWorkspace(async (_, tools) => {
  const model = { async next() { return { toolCalls: [{ id: 'read-loop', name: 'read_project_file', args: { path: 'index.html' } }] }; } };
  const result = await runAgent({ instruction: 'loop test', model, tools, maxTurns: 2 });
  assert.equal(result.status, 'budget_exhausted');
  assert.equal(result.calls, 2);
}));

test('already-aborted request performs no model or tool calls', async () => withWorkspace(async (_, tools) => {
  const controller = new AbortController(); controller.abort();
  const result = await runAgent({ instruction: 'cancelled', model: { async next() { throw new Error('should not be called'); } }, tools, signal: controller.signal });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.calls, 0);
}));


test('a symlink to an internal file remains readable through a checked file handle', async (t) =>
  withWorkspace(async (dir, tools) => {
    try {
      await symlink(join(dir, 'index.html'), join(dir, 'internal.html'));
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip('Windows denied symlink creation; Linux CI runs the file handle check');
        return;
      }
      throw error;
    }
    const result = await tools.read_project_file({ path: 'internal.html' });
    assert.match(result.content, /Sample Headline/);
  }));

test('oversized source files are rejected before reads, edits, and checks', async () =>
  withWorkspace(async (dir, tools) => {
    const huge = '<h1>' + 'A'.repeat(70_000) + '</h1>';
    await writeFile(join(dir, 'index.html'), huge);
    await assert.rejects(tools.read_project_file({ path: 'index.html' }),
      error => error.code === 'FILE_LIMIT');
    await assert.rejects(tools.replace_in_file({
      path: 'index.html', oldText: 'A', newText: 'B'
    }), error => error.code === 'FILE_LIMIT');
    await assert.rejects(tools.run_project_check({ path: 'index.html', expectedText: 'A' }),
      error => error.code === 'FILE_LIMIT');
    assert.equal(await readFile(join(dir, 'index.html'), 'utf8'), huge);
  }));
