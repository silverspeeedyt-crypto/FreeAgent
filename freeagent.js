#!/usr/bin/env node
import readline from 'node:readline';
import process from 'node:process';
import { loadConfig, loadUsage, loadProjectNotes, HOME_DIR } from '../src/config.js';
import { resolveProviders, PROVIDERS } from '../src/providers.js';
import { Router } from '../src/router.js';
import { Agent } from '../src/agent.js';

const VERSION = '0.1.0';
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);
const green = (s) => c('32', s);
const red = (s) => c('31', s);
const cyan = (s) => c('36', s);

const HELP = `freeagent ${VERSION}: a terminal coding agent that spreads work across free LLM tiers.

Usage:
  freeagent                     interactive session in the current folder
  freeagent -p "task"           run one task and exit
  echo "task" | freeagent       read the task from stdin

Options:
  -p, --print <task>   one-shot mode
  -y, --yes            approve file edits and shell commands without asking
  -m, --model <id>     pin a provider ("groq") or model ("groq/llama-3.3-70b-versatile")
  -h, --help           show this help
  -v, --version        show version

In a session: /models  /usage  /model <id>  /yes  /clear  /help  /exit
Config: ${HOME_DIR}/config.json   Project notes: FREEAGENT.md, AGENTS.md or CLAUDE.md`;

function parseArgs(argv) {
  const o = { prompt: null, yes: false, model: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-v' || a === '--version') o.version = true;
    else if (a === '-y' || a === '--yes') o.yes = true;
    else if (a === '-p' || a === '--print') o.prompt = argv[++i] ?? '';
    else if (a === '-m' || a === '--model') o.model = argv[++i];
    else if (!a.startsWith('-')) o.prompt = [o.prompt, a].filter(Boolean).join(' ');
  }
  return o;
}

function setupHelp() {
  const lines = [
    red('No free API keys found.'),
    '',
    'Add at least one (all have a free tier, no card needed for most). Each key is your own:',
    '',
    ...PROVIDERS.map((p) => `  ${p.env.padEnd(20)} ${p.keyUrl}`),
    '',
    'Then export it, for example:  export GROQ_API_KEY=gsk_...',
    `Or put keys in ${HOME_DIR}/config.json:  { "providers": { "groq": { "key": "gsk_..." } } }`,
  ];
  console.error(lines.join('\n'));
}

function printUsage(router, usage) {
  console.log(bold('Today (UTC), counted locally by this tool:'));
  const rows = Object.entries(usage.byProvider);
  if (!rows.length) console.log(dim('  nothing yet'));
  for (const [id, r] of rows) {
    console.log(`  ${id.padEnd(12)} ${String(r.requests).padStart(5)} requests  ~${r.tokens.toLocaleString()} tokens`);
  }
  console.log(dim('Provider dashboards are the source of truth for your real remaining quota.'));
}

function printModels(router) {
  console.log(bold('Models in routing order:'));
  for (const s of router.status()) {
    const col = s.state === 'ready' ? green : s.state === 'unavailable' ? red : dim;
    console.log(`  ${s.id.padEnd(48)} ${col(s.state)}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return console.log(HELP);
  if (opts.version) return console.log(VERSION);

  const config = loadConfig();
  const providers = resolveProviders(config);
  if (!providers.length) {
    setupHelp();
    process.exit(1);
  }
  const usage = loadUsage();
  const router = new Router(providers, usage);
  if (opts.model) router.pinned = opts.model;

  let stdinText = null;
  if (!process.stdin.isTTY && opts.prompt === null) {
    stdinText = await new Promise((resolve) => {
      let d = '';
      process.stdin.on('data', (x) => (d += x));
      process.stdin.on('end', () => resolve(d.trim()));
    });
  }
  const oneShot = opts.prompt !== null || stdinText !== null;
  const interactive = process.stdin.isTTY && !oneShot;

  const rl = process.stdin.isTTY
    ? readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    : null;
  const ask = (q) => new Promise((resolve) => (rl ? rl.question(q, resolve) : resolve('n')));

  let autoYes = opts.yes;
  const always = new Set();
  const approve = async (name, summary) => {
    if (autoYes || always.has(name)) return true;
    const a = (await ask(`${cyan('?')} Allow ${bold(summary)} [y]es / [n]o / [a]lways for ${name}: `)).trim().toLowerCase();
    if (a === 'a') {
      always.add(name);
      return true;
    }
    return a === 'y' || a === 'yes' || a === '';
  };

  let lastServed = '';
  let midLine = false;
  const ui = {
    text(t) {
      process.stdout.write(t);
      midLine = !t.endsWith('\n');
    },
    endText() {
      if (midLine) process.stdout.write('\n');
      midLine = false;
    },
    tool(summary) {
      console.log(dim(`  ● ${summary.split('\n')[0].slice(0, 120)}`));
    },
    served(provider, model) {
      const id = `${provider}/${model}`;
      if (id !== lastServed) {
        console.log(dim(`  [${id}]`));
        lastServed = id;
      }
    },
  };

  const agent = new Agent({ router, cwd: process.cwd(), notes: loadProjectNotes(process.cwd()), approve, ui });

  let controller = null;
  const run = async (text) => {
    controller = new AbortController();
    try {
      await agent.send(text, controller.signal);
    } catch (e) {
      if (controller.signal.aborted) console.log(dim('\n  interrupted'));
      else console.error(red(`\n${e.message}`));
    } finally {
      controller = null;
    }
  };

  process.on('SIGINT', () => {
    if (controller) controller.abort();
    else {
      console.log();
      process.exit(0);
    }
  });

  if (oneShot) {
    await run(opts.prompt || stdinText || '');
    rl?.close();
    return;
  }

  console.log(`${bold('freeagent')} ${dim(VERSION)}  ${dim(process.cwd())}`);
  console.log(dim(`${providers.length} provider${providers.length === 1 ? '' : 's'} ready: ${providers.map((p) => p.id).join(', ')}. Type /help.`));

  if (!interactive) return;
  rl.setPrompt(`${green('>')} `);
  rl.prompt();
  for await (const line of rl) {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      continue;
    }
    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.split(/\s+/);
      if (cmd === '/exit' || cmd === '/quit') break;
      else if (cmd === '/help') console.log(HELP);
      else if (cmd === '/models') printModels(router);
      else if (cmd === '/usage') printUsage(router, usage);
      else if (cmd === '/clear') {
        agent.reset();
        console.log(dim('  conversation cleared'));
      } else if (cmd === '/yes') {
        autoYes = !autoYes;
        console.log(dim(`  auto-approve ${autoYes ? 'on' : 'off'}`));
      } else if (cmd === '/model') {
        router.pinned = rest[0] || null;
        console.log(dim(rest[0] ? `  pinned to ${rest[0]}` : '  back to automatic routing'));
      } else console.log(dim('  unknown command, try /help'));
    } else {
      await run(text);
    }
    rl.prompt();
  }
  rl.close();
}

main().catch((e) => {
  console.error(red(e.stack || e.message));
  process.exit(1);
});
