import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME_DIR = process.env.FREEAGENT_HOME || path.join(os.homedir(), '.freeagent');
const CONFIG_PATH = path.join(HOME_DIR, 'config.json');
const USAGE_PATH = path.join(HOME_DIR, 'usage.json');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch {
    // Usage tracking is best-effort and must never crash the agent.
  }
}

export function loadConfig() {
  return readJson(CONFIG_PATH, {});
}

export function loadUsage() {
  const u = readJson(USAGE_PATH, { day: '', byProvider: {} });
  const today = new Date().toISOString().slice(0, 10);
  if (u.day !== today) return { day: today, byProvider: {} };
  return u;
}

export function saveUsage(u) {
  writeJson(USAGE_PATH, u);
}

export function recordUsage(usage, providerId, { requests = 1, tokens = 0 } = {}) {
  const row = (usage.byProvider[providerId] ||= { requests: 0, tokens: 0 });
  row.requests += requests;
  row.tokens += tokens;
  saveUsage(usage);
}

// Project instructions, like CLAUDE.md. Looks for FREEAGENT.md, then AGENTS.md, then CLAUDE.md.
export function loadProjectNotes(cwd) {
  for (const name of ['FREEAGENT.md', 'AGENTS.md', 'CLAUDE.md']) {
    try {
      return fs.readFileSync(path.join(cwd, name), 'utf8').slice(0, 20000);
    } catch {
      // try next
    }
  }
  return '';
}
