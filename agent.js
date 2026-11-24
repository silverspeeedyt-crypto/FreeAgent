import { toOpenAITools, runTool, NEEDS_APPROVAL, describeCall, truncate } from './tools.js';

const MAX_STEPS = 25; // tool-call rounds per user message
const MAX_CONTEXT_CHARS = 60000; // free tiers cap tokens per minute, so keep history small

export function systemPrompt({ cwd, notes }) {
  return `You are freeagent, a coding agent running in the user's terminal. You help with software engineering tasks by reading and changing files and running commands in the working directory.

Working directory: ${cwd}
Platform: ${process.platform}

How to work:
- Explore before changing: use list_files, grep and read_file. Read a file before editing it.
- Make the smallest change that solves the task. Match the existing code style.
- Prefer edit_file for changes to existing files and write_file only for new files.
- Run tests or the program with bash to check your work when that is possible.
- Be concise. Do not paste whole files back to the user. Say what you changed and why in a few lines.
- If a tool call fails, read the error, fix the call and try again. Do not repeat the same failing call.
- Never run destructive commands (rm -rf, git reset --hard, force pushes) unless the user asked for them.
${notes ? `\nProject notes from the user:\n${notes}\n` : ''}`;
}

// Shrinks old tool results so long sessions fit inside small free-tier context windows.
export function compact(messages) {
  const size = () => messages.reduce((n, m) => n + String(m.content || '').length + JSON.stringify(m.tool_calls || '').length, 0);
  if (size() <= MAX_CONTEXT_CHARS) return;
  for (let i = 1; i < messages.length - 6 && size() > MAX_CONTEXT_CHARS; i++) {
    const m = messages[i];
    if (m.role === 'tool' && m.content.length > 400) m.content = truncate(m.content, 400);
  }
  // Still too big: drop the oldest whole turns, keeping the system prompt and the recent tail.
  while (size() > MAX_CONTEXT_CHARS && messages.length > 8) {
    messages.splice(1, 1);
    while (messages[1] && messages[1].role === 'tool') messages.splice(1, 1); // never orphan a tool result
  }
}

// Some free models write tool calls as plain JSON text. Rescue the obvious cases.
function rescueToolCalls(message) {
  if (message.tool_calls?.length || !message.content) return message;
  const m = message.content.trim().match(/^```(?:json)?\s*([\s\S]*?)```$|^(\{[\s\S]*\})$/);
  const raw = m && (m[1] || m[2]);
  if (!raw) return message;
  try {
    const j = JSON.parse(raw);
    const name = j.name || j.tool;
    const args = j.arguments || j.parameters || j.args;
    if (name && args) {
      return {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: `rescued_${Date.now()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      };
    }
  } catch {
    // not a tool call
  }
  return message;
}

export class Agent {
  constructor({ router, cwd, notes, approve, ui }) {
    this.router = router;
    this.cwd = cwd;
    this.approve = approve; // async (name, summary) => boolean
    this.ui = ui;
    this.messages = [{ role: 'system', content: systemPrompt({ cwd, notes }) }];
    this.tools = toOpenAITools();
  }

  reset() {
    this.messages.length = 1;
  }

  async send(text, signal) {
    this.messages.push({ role: 'user', content: text });
    for (let step = 0; step < MAX_STEPS; step++) {
      compact(this.messages);
      let streamed = false;
      const { message: raw, provider, model } = await this.router.chat({
        messages: this.messages,
        tools: this.tools,
        signal,
        onText: (t) => {
          streamed = true;
          this.ui.text(t);
        },
      });
      const message = rescueToolCalls(raw);
      if (streamed) this.ui.endText();
      this.ui.served(provider, model);
      this.messages.push(message);

      if (!message.tool_calls?.length) return message.content;

      for (const call of message.tool_calls) {
        const result = await this.execute(call, signal);
        this.messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
    }
    return 'Stopped after the maximum number of steps. Tell me to continue if you want more.';
  }

  async execute(call, signal) {
    const name = call.function.name;
    let args;
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      return 'Error: tool arguments were not valid JSON. Call the tool again with valid JSON.';
    }
    const summary = describeCall(name, args);
    if (NEEDS_APPROVAL.has(name)) {
      const ok = await this.approve(name, summary);
      if (!ok) return 'The user declined this action. Ask what they would prefer instead.';
    }
    this.ui.tool(summary);
    try {
      return await runTool(name, args, { cwd: this.cwd, signal });
    } catch (e) {
      return `Error: ${e.message}`;
    }
  }
}
