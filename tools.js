import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const MAX_OUT = 8000; // chars returned to the model per tool call (free tiers have tight token caps)
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '__pycache__', '.venv', 'venv', 'target']);

export function truncate(text, max = MAX_OUT) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return `${text.slice(0, head)}\n... [${text.length - max} characters omitted] ...\n${text.slice(-tail)}`;
}

function inside(cwd, p) {
  const abs = path.resolve(cwd, p);
  const rel = path.relative(cwd, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path is outside the working directory: ${p}`);
  }
  return abs;
}

function* walk(dir, root) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(path.join(dir, e.name), root);
    } else if (e.isFile()) {
      yield path.relative(root, path.join(dir, e.name));
    }
  }
}

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') i++;
        re += '(?:.*/)?';
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else if (ch === '{') {
      const end = glob.indexOf('}', i);
      if (end > i) {
        re += `(?:${glob.slice(i + 1, end).split(',').map(escapeRe).join('|')})`;
        i = end;
      } else re += '\\{';
    } else re += escapeRe(ch);
  }
  return new RegExp(`^${re}$`);
}
const escapeRe = (s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&');

function isBinary(buf) {
  return buf.subarray(0, 4000).includes(0);
}

export const TOOL_SPECS = [
  {
    name: 'read_file',
    description: 'Read a text file. Returns numbered lines. Use offset and limit for large files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'integer', description: '1-based first line' },
        limit: { type: 'integer', description: 'max lines, default 300' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file with the given content. Creates parent folders.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Replace old_string with new_string in a file. old_string must match exactly once unless replace_all is true. Read the file first.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'list_files',
    description: 'List files matching a glob pattern such as "src/**/*.js". Skips node_modules and .git.',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'glob, default **/*' } },
    },
  },
  {
    name: 'grep',
    description: 'Search file contents with a JavaScript regular expression. Returns path:line:text.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        glob: { type: 'string', description: 'limit to files matching this glob' },
        ignore_case: { type: 'boolean' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'bash',
    description: 'Run a shell command in the working directory. 120 second timeout. Output is truncated.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
];

export const toOpenAITools = () =>
  TOOL_SPECS.map((t) => ({ type: 'function', function: t }));

// Tools that change things on disk or run code ask for approval first.
export const NEEDS_APPROVAL = new Set(['write_file', 'edit_file', 'bash']);

export function describeCall(name, args) {
  if (name === 'bash') return `$ ${args.command}`;
  if (name === 'write_file') return `write ${args.path} (${String(args.content ?? '').length} chars)`;
  if (name === 'edit_file') return `edit ${args.path}`;
  return `${name} ${JSON.stringify(args)}`;
}

export async function runTool(name, args, { cwd, signal }) {
  switch (name) {
    case 'read_file': {
      const abs = inside(cwd, args.path);
      const buf = fs.readFileSync(abs);
      if (isBinary(buf)) return `Binary file, ${buf.length} bytes. Not shown.`;
      const lines = buf.toString('utf8').split('\n');
      const start = Math.max(1, args.offset || 1);
      const limit = args.limit || 300;
      const slice = lines.slice(start - 1, start - 1 + limit);
      const out = slice.map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join('\n');
      const more = start - 1 + limit < lines.length ? `\n[${lines.length} lines total, use offset to continue]` : '';
      return truncate(out) + more;
    }
    case 'write_file': {
      const abs = inside(cwd, args.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, String(args.content ?? ''));
      return `Wrote ${args.path}`;
    }
    case 'edit_file': {
      const abs = inside(cwd, args.path);
      const text = fs.readFileSync(abs, 'utf8');
      const { old_string: from, new_string: to } = args;
      if (!from) throw new Error('old_string is empty');
      const count = text.split(from).length - 1;
      if (count === 0) throw new Error('old_string not found. Read the file again and match it exactly.');
      if (count > 1 && !args.replace_all) {
        throw new Error(`old_string matches ${count} times. Add more context or set replace_all.`);
      }
      fs.writeFileSync(abs, args.replace_all ? text.split(from).join(to) : text.replace(from, () => to));
      return `Edited ${args.path} (${args.replace_all ? count : 1} replacement)`;
    }
    case 'list_files': {
      const re = globToRegex(args.pattern || '**/*');
      const hits = [];
      for (const f of walk(cwd, cwd)) {
        if (re.test(f.split(path.sep).join('/'))) hits.push(f);
        if (hits.length >= 500) break;
      }
      return hits.length ? truncate(hits.join('\n')) : 'No files matched.';
    }
    case 'grep': {
      const re = new RegExp(args.pattern, args.ignore_case ? 'i' : '');
      const gre = args.glob ? globToRegex(args.glob) : null;
      const hits = [];
      for (const f of walk(cwd, cwd)) {
        const rel = f.split(path.sep).join('/');
        if (gre && !gre.test(rel)) continue;
        let buf;
        try {
          buf = fs.readFileSync(path.join(cwd, f));
        } catch {
          continue;
        }
        if (buf.length > 1_000_000 || isBinary(buf)) continue;
        buf
          .toString('utf8')
          .split('\n')
          .forEach((line, i) => {
            if (hits.length < 200 && re.test(line)) hits.push(`${rel}:${i + 1}:${line.slice(0, 200)}`);
          });
        if (hits.length >= 200) break;
      }
      return hits.length ? truncate(hits.join('\n')) : 'No matches.';
    }
    case 'bash':
      return runBash(args.command, cwd, signal);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function runBash(command, cwd, signal) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], { cwd, signal, env: process.env });
    let out = '';
    const add = (d) => {
      out += d;
      if (out.length > 200000) out = out.slice(-100000);
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve(`Command failed to start: ${e.message}`);
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      const tail = sig ? `\n[killed by ${sig}]` : `\n[exit ${code}]`;
      resolve(truncate(out.trim()) + tail);
    });
  });
}
