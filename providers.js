// Free-tier providers that expose an OpenAI-compatible /chat/completions endpoint.
// Model ids and limits drift often: every default can be overridden in
// ~/.freeagent/config.json, and `/models` lists what your key can actually use.
//
// Each provider needs YOUR OWN key from that provider's own signup page.

export const PROVIDERS = [
  {
    id: 'gemini',
    name: 'Google Gemini',
    env: 'GEMINI_API_KEY',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    keyUrl: 'https://aistudio.google.com/apikey',
    tier: 1,
  },
  {
    id: 'groq',
    name: 'Groq',
    env: 'GROQ_API_KEY',
    base: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'],
    keyUrl: 'https://console.groq.com/keys',
    tier: 1,
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    env: 'CEREBRAS_API_KEY',
    base: 'https://api.cerebras.ai/v1',
    models: ['gpt-oss-120b', 'llama-3.3-70b'],
    keyUrl: 'https://cloud.cerebras.ai',
    tier: 1,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter (free models)',
    env: 'OPENROUTER_API_KEY',
    base: 'https://openrouter.ai/api/v1',
    models: ['openrouter/free'],
    keyUrl: 'https://openrouter.ai/keys',
    tier: 2,
  },
  {
    id: 'mistral',
    name: 'Mistral',
    env: 'MISTRAL_API_KEY',
    base: 'https://api.mistral.ai/v1',
    models: ['mistral-small-latest'],
    keyUrl: 'https://console.mistral.ai/api-keys',
    tier: 2,
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    env: 'NVIDIA_API_KEY',
    base: 'https://integrate.api.nvidia.com/v1',
    models: ['meta/llama-3.3-70b-instruct'],
    keyUrl: 'https://build.nvidia.com',
    tier: 2,
  },
  {
    id: 'github',
    name: 'GitHub Models',
    env: 'GITHUB_TOKEN',
    base: 'https://models.github.ai/inference',
    models: ['openai/gpt-4.1-mini'],
    keyUrl: 'https://github.com/settings/personal-access-tokens',
    tier: 3,
  },
];

// Merge built-ins with user config. Config shape:
// { "providers": { "groq": { "models": [...], "disabled": false },
//                  "mylocal": { "name": "...", "base": "http://localhost:3001/v1", "key": "x", "models": ["auto"] } } }
export function resolveProviders(config = {}, env = process.env) {
  const overrides = config.providers || {};
  const out = [];
  const seen = new Set();
  for (const p of PROVIDERS) {
    const o = overrides[p.id] || {};
    seen.add(p.id);
    if (o.disabled) continue;
    const key = o.key || env[p.env] || '';
    if (!key) continue;
    out.push({ ...p, ...o, key, models: o.models || p.models });
  }
  for (const [id, o] of Object.entries(overrides)) {
    if (seen.has(id) || o.disabled || !o.base || !o.models?.length) continue;
    out.push({ id, name: o.name || id, tier: o.tier ?? 2, key: o.key || 'none', ...o });
  }
  return out.sort((a, b) => a.tier - b.tier);
}
