import { open, realpath, rename, stat, writeFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
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

// Bounded fixture text extraction, not a general HTML parser or browser assertion.
// Ignore inline heading markup, decode common entities, and normalize whitespace.
function normalizeH1Text(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
  return String(value)
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-f]+);/gi, entity => {
      const name = entity.slice(1, -1).toLowerCase();
      if (name in named) return named[name];
      const codepoint = name.startsWith('#x')
        ? parseInt(name.slice(2), 16)
        : parseInt(name.slice(1), 10);
      return codepoint > 0 && codepoint <= 0x10ffff &&
        !(codepoint >= 0xd800 && codepoint <= 0xdfff)
        ? String.fromCodePoint(codepoint) : entity;
    })
    .replace(/\s+/gu, ' ')
    .trim();
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

  // Open a handle after path validation: O_NOFOLLOW prevents a final-component
  // symlink swap on POSIX, and fstat validates the descriptor actually read.
  // This reduces pathname races; it is not an openat-based sandbox for
  // directories concurrently mutated by an untrusted external process.
  async function readCheckedFile(target) {
    let handle;
    try {
      handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    } catch (error) {
      if (error?.code === 'ELOOP') throw new ToolError('UNSAFE_PATH', 'Symlink changed during file open');
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_FILE_BYTES)
        throw new ToolError('FILE_LIMIT', 'Expected a small regular source file');
      const content = await handle.readFile({ encoding: 'utf8' });
      if (Buffer.byteLength(content) > MAX_FILE_BYTES)
        throw new ToolError('FILE_LIMIT', 'Source file exceeds size limit');
      return content;
    } finally { await handle.close(); }
  }

  return {
    async read_project_file({ path } = {}) {
      const target = await checkedFile(path);
      return { path, content: await readCheckedFile(target) };
    },

    async replace_in_file({ path, oldText, newText } = {}) {
      requireString(oldText, 'oldText', 10000);
      if (typeof newText !== 'string' || newText.length > 10000) {
        throw new ToolError('INVALID_ARGUMENT', 'newText must be a string <= 10000 characters');
      }
      const target = await checkedFile(path);
      const source = await readCheckedFile(target);
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
      const source = await readCheckedFile(target);
      const headings = [...source.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)];
      const expected = expectedText === undefined ? null : requireString(expectedText, 'expectedText');
      const errors = [];
      if (headings.length !== 1) errors.push('Expected exactly one H1 element');
      if (expected !== null) {
        const targetHeading = normalizeH1Text(expected);
        if (!targetHeading) throw new ToolError('INVALID_ARGUMENT', 'expectedText must contain visible text');
        if (!headings.length || normalizeH1Text(headings[0][1]) !== targetHeading)
          errors.push('Expected H1 text does not match exactly');
      }
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
