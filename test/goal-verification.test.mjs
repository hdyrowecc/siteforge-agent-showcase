import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../src/agent.mjs';
import { createProjectTools } from '../src/tools.mjs';

async function withSite(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-goal-contract-'));
  try {
    await writeFile(join(dir, 'index.html'), '<html><h1>Original Home</h1></html>');
    await writeFile(join(dir, 'about.html'), '<html><h1>Original About</h1></html>');
    return await fn(createProjectTools(dir));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

function steps(sequence) {
  let step = 0;
  return { async next() {
    const current = sequence[step++];
    return current ? { toolCalls: current.map(([name, args]) => ({
      id: 'tool-' + step + '-' + name, name, args
    })) } : { text: 'The model claims completion.', toolCalls: [] };
  } };
}

const editHome = ['replace_in_file', {
  path: 'index.html', oldText: 'Original Home', newText: 'New Home'
}];
const editAbout = ['replace_in_file', {
  path: 'about.html', oldText: 'Original About', newText: 'New About'
}];
const checkHome = ['run_project_check', { path: 'index.html', expectedText: 'New Home' }];
const checkAbout = ['run_project_check', { path: 'about.html', expectedText: 'New About' }];
const goals = [
  { path: 'index.html', expectedText: 'New Home' },
  { path: 'about.html', expectedText: 'New About' }
];
const run = (tools, plan, requiredChecks = []) => runAgent({
  instruction: 'Change both headings with proof for every page',
  tools, model: steps(plan), requiredChecks
});

test('check-only model claim cannot certify a request with no changes', () =>
  withSite(async tools => {
    const result = await run(tools, [[['run_project_check', {
      path: 'index.html', expectedText: 'Original Home'
    }]]]);
    assert.equal(result.status, 'unverified');
    assert.deepEqual(result.verification.changedFiles, []);
  }));

test('a successful check on the last page cannot hide failed validation on the first', () =>
  withSite(async tools => {
    const result = await run(tools, [
      [editHome, editAbout],
      [['run_project_check', { path: 'index.html', expectedText: 'Wrong Title' }], checkAbout]
    ], goals);
    assert.equal(result.status, 'unverified');
    assert.deepEqual(result.verification.unmetChecks, ['index.html']);
  }));

test('every edited HTML page needs a passing check since the last mutation', () =>
  withSite(async tools => {
    const result = await run(tools, [[editHome, editAbout], [checkHome]]);
    assert.equal(result.status, 'unverified');
    assert.deepEqual(result.verification.checkedFiles, ['index.html']);
  }));

test('later edits invalidate a previously successful completion check', () =>
  withSite(async tools => {
    const result = await run(tools, [[editHome], [checkHome], [
      ['replace_in_file', { path: 'index.html', oldText: 'New Home', newText: 'Changed Again' }]
    ]]);
    assert.equal(result.status, 'unverified');
    assert.deepEqual(result.verification.checkedFiles, []);
  }));

test('model-chosen success text cannot override the caller-owned goal contract', () =>
  withSite(async tools => {
    const result = await run(tools, [[editHome], [checkHome]], [
      { path: 'index.html', expectedText: 'What the user actually requested' }
    ]);
    assert.equal(result.status, 'unverified');
    assert.deepEqual(result.verification.unmetChecks, ['index.html']);
  }));

test('all explicitly required routes and exact target text produce a verified result', () =>
  withSite(async tools => {
    const result = await run(tools, [[editHome, editAbout], [checkHome, checkAbout]], goals);
    assert.equal(result.status, 'verified');
    assert.deepEqual(result.verification.unmetChecks, []);
    assert.deepEqual(result.verification.checkedFiles.sort(), ['about.html', 'index.html']);
  }));

test('reject malformed or duplicate caller-owned goal contracts', () =>
  withSite(async tools => {
    await assert.rejects(run(tools, [], [
      { path: 'index.html', expectedText: 'A' },
      { path: 'index.html', expectedText: 'B' }
    ]), { name: 'Error', message: /requiredChecks/ });
  }));
