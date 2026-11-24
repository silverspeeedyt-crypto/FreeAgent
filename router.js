import { recordUsage } from './config.js';

const MIDNIGHT = () => {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

export class RouterError extends Error {
  constructor(message, attempts) {
    super(message);
    this.name = 'RouterError';
    this.attempts = attempts;
  }
}

// Routes each model call to the first healthy provider/model, with failover.
// Free tiers differ in limits, so a 429 puts that model on cooldown and the next
// candidate takes over. Everything runs on keys you supplied yourself.
export class Router {
  constructor(providers, usage, { fetchImpl = fetch, timeoutMs = 180000 } = {}) {
    this.providers = providers;
    this.usage = usage;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.cooldown = new Map(); // "provider/model" -> epoch ms until usable
    this.dead = new Set(); // provider ids with rejected keys, or models not found
    this.sticky = null;
    this.pinned = null; // optional "provider" or "provider/model"
  }

  candidates() {
    const all = [];
    for (const p of this.providers) {
      for (const m of p.models) all.push({ p, model: m, id: `${p.id}/${m}` });
    }
    let list = all;
    if (this.pinned) {
      list = all.filter((c) => c.id === this.pinned || c.p.id === this.pinned);
    }
    if (this.sticky) {
      const i = list.findIndex((c) => c.id === this.sticky);
      if (i > 0) list = [list[i], ...list.slice(0, i), ...list.slice(i + 1)];
    }
    return list;
  }

  status() {
    const now = Date.now();
    return this.candidates().map((c) => {
      const until = this.cooldown.get(c.id) || 0;
      const dead = this.dead.has(c.p.id) || this.dead.has(c.id);
      return {
        id: c.id,
        state: dead ? 'unavailable' : until > now ? `cooling ${Math.ceil((until - now) / 1000)}s` : 'ready',
      };
    });
  }

  usable(c) {
    if (this.dead.has(c.p.id) || this.dead.has(c.id)) return false;
    return (this.cooldown.get(c.id) || 0) <= Date.now();
  }

  async chat({ messages, tools, signal, onText, maxTokens = 4096 }) {
    const attempts = [];
    for (const c of this.candidates()) {
      if (!this.usable(c)) continue;
      try {
        const result = await this.call(c, { messages, tools, signal, onText, maxTokens });
        this.sticky = c.id;
        recordUsage(this.usage, c.p.id, { requests: 1, tokens: result.tokens });
        return { ...result, provider: c.p.id, model: c.model };
      } catch (err) {
        if (signal?.aborted) throw err;
        attempts.push(`${c.id}: ${err.message}`);
        this.penalize(c, err);
      }
    }
    if (!attempts.length) {
      const soonest = [...this.cooldown.values()].sort((a, b) => a - b)[0];
      const wait = soonest ? Math.max(0, Math.ceil((soonest - Date.now()) / 1000)) : null;
      throw new RouterError(
        wait !== null
          ? `Every free model is cooling down. Next one is ready in about ${wait}s.`
          : 'No usable provider. Add a free API key (see README) or check /models.',
        attempts,
      );
    }
    throw new RouterError(`All providers failed:\n  ${attempts.join('\n  ')}`, attempts);
  }

  penalize(c, err) {
    const status = err.status;
    if (status === 401 || status === 403) {
      this.dead.add(c.p.id); // bad key: stop trying this provider this session
    } else if (status === 404) {
      this.dead.add(c.id); // model retired or not on this key
    } else if (status === 429 || status === 413) {
      const dailyHint = /per day|daily|quota|exhausted/i.test(err.body || '');
      const ra = err.retryAfter;
      const until = dailyHint && (!ra || ra > 300) ? MIDNIGHT() : Date.now() + (ra ? ra * 1000 : 60000);
      this.cooldown.set(c.id, until);
    } else {
      this.cooldown.set(c.id, Date.now() + 30000); // 5xx, 400, network: short pause
    }
  }

  async call(c, { messages, tools, signal, onText, maxTokens }) {
    const body = { model: c.model, messages, stream: true, max_tokens: maxTokens };
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res;
    try {
      res = await this.fetch(`${c.p.base.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${c.p.key}`,
          ...(c.p.headers || {}),
        },
        body: JSON.stringify(body),
        signal: sig,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw Object.assign(new Error(`network error (${e.cause?.code || e.message})`), { status: 0 });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const e = new Error(`HTTP ${res.status} ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
      e.status = res.status;
      e.body = text;
      const ra = Number(res.headers.get('retry-after'));
      e.retryAfter = Number.isFinite(ra) && ra > 0 ? ra : 0;
      throw e;
    }
    return parseStream(res, onText, messages);
  }
}

// Reads an OpenAI-style SSE stream and assembles the final assistant message.
export async function parseStream(res, onText, messages = []) {
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  const calls = [];
  let usageTokens = 0;

  const handle = (line) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    if (json.error) {
      const e = new Error(json.error.message || 'stream error');
      e.status = Number(json.error.code) || 500;
      e.body = JSON.stringify(json.error);
      throw e;
    }
    if (json.usage?.total_tokens) usageTokens = json.usage.total_tokens;
    const delta = json.choices?.[0]?.delta;
    if (!delta) return;
    if (delta.content) {
      content += delta.content;
      onText?.(delta.content);
    }
    for (const tc of delta.tool_calls || []) {
      const i = tc.index ?? 0;
      const slot = (calls[i] ||= { id: '', type: 'function', function: { name: '', arguments: '' } });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.function.name += tc.function.name;
      if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
    }
  };

  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      handle(buf.slice(0, nl).trim());
      buf = buf.slice(nl + 1);
    }
  }
  if (buf.trim()) handle(buf.trim());

  const tool_calls = calls
    .filter(Boolean)
    .map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` }));
  if (!usageTokens) {
    const inChars = messages.reduce((n, m) => n + String(m.content || '').length, 0);
    usageTokens = Math.ceil((inChars + content.length + JSON.stringify(tool_calls).length) / 4);
  }
  if (!content && !tool_calls.length) {
    const e = new Error('empty response');
    e.status = 502;
    throw e;
  }
  return { message: { role: 'assistant', content, ...(tool_calls.length ? { tool_calls } : {}) }, tokens: usageTokens };
}
