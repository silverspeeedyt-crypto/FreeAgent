# freeagent

A coding agent for your terminal, in the style of Claude Code, that runs on the free tiers of many LLM providers. It reads and edits your files, searches code, runs commands, and when one provider hits its free limit it moves to the next one.

Zero dependencies. Node 20 or newer.

## What it does

- Agent loop with tools: `read_file`, `write_file`, `edit_file`, `list_files`, `grep`, `bash`
- Asks before it writes a file or runs a command (`y`, `n`, or `a` for always). `--yes` skips the prompts.
- Failover router: a 429 puts that model on cooldown (until UTC midnight if it is a daily cap), then the next free model takes over. 5xx errors and timeouts fail over too.
- Streams output, Ctrl+C interrupts a running task
- Reads project notes from `FREEAGENT.md`, `AGENTS.md` or `CLAUDE.md`
- Keeps history small so it fits free-tier token-per-minute limits
- Local usage counter (`/usage`)

## Install

```bash
git clone https://github.com/silverspeeedyt-crypto/FreeAgent
cd FreeAgent
npm link          # puts `freeagent` on your PATH
```

## Add free keys

Each key is your own, from the provider's own signup page. One key per provider is enough. Add as many providers as you like.

| Provider | Variable | Get a key |
|---|---|---|
| Google Gemini | `GEMINI_API_KEY` | https://aistudio.google.com/apikey |
| Groq | `GROQ_API_KEY` | https://console.groq.com/keys |
| Cerebras | `CEREBRAS_API_KEY` | https://cloud.cerebras.ai |
| OpenRouter | `OPENROUTER_API_KEY` | https://openrouter.ai/keys |
| Mistral | `MISTRAL_API_KEY` | https://console.mistral.ai/api-keys |
| NVIDIA NIM | `NVIDIA_API_KEY` | https://build.nvidia.com |
| GitHub Models | `GITHUB_TOKEN` | https://github.com/settings/personal-access-tokens |

```bash
export GROQ_API_KEY=gsk_...
export GEMINI_API_KEY=...
freeagent
```

## Use

```bash
freeagent                              # interactive session in this folder
freeagent -p "add tests for src/util.js"
freeagent -y -p "fix the failing test"   # no approval prompts
freeagent -m groq                      # only use Groq
```

Inside a session: `/models` (routing order and cooldowns), `/usage`, `/model <id>`, `/yes`, `/clear`, `/help`, `/exit`.

## Config

`~/.freeagent/config.json` (created by you, never by the tool):

```json
{
  "providers": {
    "groq": { "models": ["llama-3.3-70b-versatile"] },
    "openrouter": { "disabled": true },
    "local": {
      "name": "FreeLLMAPI on this machine",
      "base": "http://localhost:3001/v1",
      "key": "freellmapi-your-key",
      "models": ["auto"]
    }
  }
}
```

Any OpenAI-compatible endpoint can be added this way, including [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi), Ollama, LM Studio or vLLM. Free model ids change often. If a default has been retired, override `models` for that provider.

## Honest limits

- **Not 10 billion tokens.** That figure is the sum of every provider's free quota added up in someone's catalog. freeagent can only use the providers you add keys for, and each one has its own daily and per-minute caps. Real capacity is whatever your keys allow.
- **Not Claude.** Free-tier models are smaller and weaker at multi-step coding. Expect more mistakes, and review changes (`git diff`) before committing.
- **Tool calling varies by model.** Some free models call tools badly. freeagent rescues the common JSON-in-text case, and the router moves on when a model fails.
- **Terms of service.** Use your own keys, one account per provider, within each provider's terms. Do not create multiple accounts to get around limits, and note that some free tiers may use your prompts to improve their products. Do not send secrets or private code you cannot share.
- **Safety.** `bash` runs real commands with your permissions. File tools are limited to the working directory, but a shell command is not. Read the approval prompts.

## Test

```bash
npm test
```

Tests use a local mock server: failover, streamed tool calls, approval handling, tools, and the CLI end to end.

## License

MIT
