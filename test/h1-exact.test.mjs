import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectTools } from '../src/tools.mjs';

async function checkHeading(headingHtml, expectedText) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-h1-exact-'));
  try {
    await writeFile(join(dir, 'index.html'),
      '<!doctype html><html><body>' + headingHtml + '</body></html>');
    return await createProjectTools(dir).run_project_check({ path: 'index.html', expectedText });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a heading containing the requested title plus extra text must not pass', async () => {
  const result = await checkHeading('<h1>New Home Extra</h1>', 'New Home');
  assert.equal(result.passed, false);
  assert.match(result.errors.join(' '), /does not match exactly/);
});

test('a proper prefix, suffix, or changed punctuation must not pass', async () => {
  for (const actual of ['My New Home', 'New Home!', 'New Homepage']) {
    const result = await checkHeading('<h1>' + actual + '</h1>', 'New Home');
    assert.equal(result.passed, false, 'Unexpected acceptance: ' + actual);
  }
});

test('identical titles with formatting markup and extra whitespace do pass', async () => {
  const result = await checkHeading('<h1> Build <em>With</em>   AI </h1>', 'Build With AI');
  assert.equal(result.passed, true);
});

test('HTML character references are decoded before exact matching', async () => {
  const result = await checkHeading('<h1>Research&nbsp;&amp;&#32;Development</h1>',
    'Research & Development');
  assert.equal(result.passed, true);
});

test('an explicitly expected title cannot be empty after whitespace normalization', async () => {
  await assert.rejects(checkHeading('<h1>   </h1>', ' \n  '),
    error => error.code === 'INVALID_ARGUMENT');
});

test('existing structural checks still reject missing or duplicate H1 tags', async () => {
  assert.equal((await checkHeading('<p>No H1</p>', 'New Home')).passed, false);
  assert.equal((await checkHeading('<h1>New Home</h1><h1>New Home</h1>', 'New Home')).passed, false);
});

test('H1 structural check remains available without an expected title', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-h1-optional-'));
  try {
    await writeFile(join(dir, 'index.html'), '<html><h1>Any title</h1></html>');
    const result = await createProjectTools(dir).run_project_check({ path: 'index.html' });
    assert.equal(result.passed, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
