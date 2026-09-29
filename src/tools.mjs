import { readFile, realpath, rename, stat, writeFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_FILE_BYTES = 64 * 1024;
const SAFE_EXTENSIONS = /\.(?:html|css|js|mjs)$/i;
export class ToolError extends Error {
  constructor(code, message) { super(message); this.name = 'ToolError'; this.code = code; }
}

function requireString(value, name, max = 300) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new ToolError('INVALID_ARGUMENT', name + ' must be a non-empty string <= ' + max + ' characters');
  }
  return value;
}

export function createProjectTools(workspaceDirectory) {
  let rootPromise;
  const root = () => (rootPromise ??= realpath(resolve(workspaceDirectory)));

  async function checkedFile(path) {
    const input = requireString(path, 'path', 240);
    if (input.includes('\\') || isAbsolute(input) || input.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new ToolError('UNSAFE_PATH', 'Use a relative file path inside the demo workspace');
    }
    if (!SAFE_EXTENSIONS.test(input)) throw new ToolError('UNSUPPORTED_FILE', 'Only html/css/js/mjs files are allowed');
    const base = await root();
    const target = await realpath(join(base, input)).catch(() => {
      throw new ToolError('NOT_FOUND', 'Target file does not exist');
    });
    if (!target.startsWith(base + sep) || relative(base, target).startsWith('..')) {
      throw new ToolError('UNSAFE_PATH', 'Target escapes the demo workspace');
    }
    const info = await stat(target);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new ToolError('FILE_LIMIT', 'Expected a small regular source file');
    return target;
  }

  return {
    async read_project_file({ path } = {}) {
      const target = await checkedFile(path);
      return { path, content: await readFile(target, 'utf8') };
    },

    async replace_in_file({ path, oldText, newText } = {}) {
      requireString(oldText, 'oldText', 10000);
      if (typeof newText !== 'string' || newText.length > 10000) {
        throw new ToolError('INVALID_ARGUMENT', 'newText must be a string <= 10000 characters');
      }
      const target = await checkedFile(path);
      const source = await readFile(target, 'utf8');
      const occur = source.split(oldText).length - 1;
      if (occur !== 1) throw new ToolError('AMBIGUOUS_EDIT', 'Expected exactly one match; found ' + occur);
      const next = source.replace(oldText, newText);
      if (Buffer.byteLength(next) > MAX_FILE_BYTES) throw new ToolError('FILE_LIMIT', 'Edited file exceeds size limit');
      const temp = join(dirname(target), '.agent-tmp-' + randomUUID());
      try {
        await writeFile(temp, next, { flag: 'wx', mode: 0o600 });
        await rename(temp, target);
      } finally { await rm(temp, { force: true }).catch(() => {}); }
      return { path, changed: true, replacementCount: 1 };
    },

    async run_project_check({ path, expectedText } = {}) {
      const target = await checkedFile(path);
      if (!target.endsWith('.html')) throw new ToolError('UNSUPPORTED_CHECK', 'This safe demo only checks HTML fixtures');
      const source = await readFile(target, 'utf8');
      const headings = [...source.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)];
      const expected = expectedText === undefined ? null : requireString(expectedText, 'expectedText');
      const errors = [];
      if (headings.length !== 1) errors.push('Expected exactly one H1 element');
      if (expected && (!headings.length || !headings[0][1].includes(expected))) errors.push('Expected H1 text missing');
      if (!source.includes('</html>')) errors.push('HTML document has no closing html tag');
      return { path, passed: errors.length === 0, errors, check: 'bounded-fixture-html-check' };
    }
  };
}

export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'read_project_file', description: 'Read one existing small source file inside the demo workspace.',
      parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' } }, required: ['path'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'replace_in_file', description: 'Replace exactly one matching string in an existing workspace source file.',
      parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } }, required: ['path', 'oldText', 'newText'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_project_check', description: 'Run bounded deterministic validation on one HTML fixture, optionally checking the expected H1 text.',
      parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, expectedText: { type: 'string' } }, required: ['path'] }
    }
  }
];
