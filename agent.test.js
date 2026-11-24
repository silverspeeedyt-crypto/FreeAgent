import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Router } from '../src/router.js';
import { Agent } from '../src/agent.js';
import { runTool } from '../src/tools.js';

const sse = (res, chunks) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end('data: [DONE]\n\n');
};

function mockServer() {
  const hits = { a: 0, b: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const which = req.url.startsWith('/a') ? 'a' : 'b';
      hits[which]++;
      if (which === 'a') {
        res.writeHead(429, { 'retry-after': '120' });
        return res.end('{"error":"rate limited"}');
      }
      const msgs = JSON.parse(body).messages;
      const last = msgs[msgs.length - 1];
      if (last.role === 'tool') {
        return sse(res, [{ choices: [{ delta: { content: 'Done: ' } }] }, { choices: [{ delta: { content: last.content } }] }]);
      }
      // split the tool call across chunks like real providers do
      sse(res, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_file', arguments: '{"path":"hello.txt",' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"hi"}' } }] } }] },
      ]);
    });
  });
  return new Promise((r) => server.listen(0, () => r({ server, hits, port: server.address().port })));
}

test('fails over from a rate-limited provider and runs a streamed tool call', async () => {
  const { server, hits, port } = await mockServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-'));
  process.env.FREEAGENT_HOME = dir;
  const usage = { day: 'x', byProvider: {} };
  const providers = [
    { id: 'a', base: `http://127.0.0.1:${port}/a`, key: 'k', models: ['m1', 'm2'] },
    { id: 'b', base: `http://127.0.0.1:${port}/b`, key: 'k', models: ['m1'] },
  ];
  const router = new Router(providers, usage);
  const out = [];
  const agent = new Agent({
    router, cwd: dir, notes: '',
    approve: async () => true,
    ui: { text: (t) => out.push(t), endText() {}, tool() {}, served() {} },
  });
  const reply = await agent.send('make a file');
  assert.equal(fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8'), 'hi');
  assert.match(reply, /Wrote hello.txt/);
  assert.equal(hits.a, 2, 'tries both a models once, then both are cooling');
  assert.ok(router.status().find((s) => s.id === 'a/m1').state.startsWith('cooling'));
  assert.equal(router.sticky, 'b/m1');
  assert.ok(usage.byProvider.b.requests >= 2);
  server.close();
});

test('declined approval is reported to the model, not executed', async () => {
  const { server, port } = await mockServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-'));
  process.env.FREEAGENT_HOME = dir;
  const router = new Router([{ id: 'b', base: `http://127.0.0.1:${port}/b`, key: 'k', models: ['m'] }], { day: 'x', byProvider: {} });
  const agent = new Agent({ router, cwd: dir, notes: '', approve: async () => false, ui: { text() {}, endText() {}, tool() {}, served() {} } });
  const reply = await agent.send('make a file');
  assert.equal(fs.existsSync(path.join(dir, 'hello.txt')), false);
  assert.match(reply, /declined/);
  server.close();
});

test('tools: edit uniqueness, path guard, glob, grep, bash', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-'));
  const ctx = { cwd: dir };
  fs.mkdirSync(path.join(dir, 'src/deep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/deep/a.js'), 'const x = 1;\nconst x2 = 1;\n');
  await assert.rejects(runTool('edit_file', { path: 'src/deep/a.js', old_string: '= 1', new_string: '= 2' }, ctx), /matches 2 times/);
  await runTool('edit_file', { path: 'src/deep/a.js', old_string: 'x = 1', new_string: 'x = 9' }, ctx);
  assert.match(fs.readFileSync(path.join(dir, 'src/deep/a.js'), 'utf8'), /x = 9/);
  await assert.rejects(runTool('read_file', { path: '../../etc/passwd' }, ctx), /outside the working directory/);
  assert.match(await runTool('list_files', { pattern: 'src/**/*.js' }, ctx), /src\/deep\/a.js/);
  assert.match(await runTool('grep', { pattern: 'x2' }, ctx), /a.js:2:/);
  assert.match(await runTool('bash', { command: 'echo hi; exit 3' }, ctx), /hi[\s\S]*\[exit 3\]/);
});

test('CLI one-shot works end to end against a custom provider in config', async () => {
  const { server, port } = await mockServer();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-home-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-work-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ providers: { mock: { base: `http://127.0.0.1:${port}/b`, models: ['m'] } } }));
  const bin = path.resolve('bin/freeagent.js');
  // async spawn so the mock server in this process can answer
  const { spawn } = await import('node:child_process');
  const out = await new Promise((resolve) => {
    const p = spawn('node', [bin, '-y', '-p', 'make a file'], { cwd: work, env: { PATH: process.env.PATH, FREEAGENT_HOME: home, NO_COLOR: '1' } });
    let s = '';
    p.stdout.on('data', (d) => (s += d));
    p.stderr.on('data', (d) => (s += d));
    p.on('close', () => resolve(s));
  });
  assert.equal(fs.readFileSync(path.join(work, 'hello.txt'), 'utf8'), 'hi');
  assert.match(out, /mock\/m/);
  server.close();
});

test('CLI with no keys prints setup help and exits 1', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-home-'));
  const r = spawnSync('node', [path.resolve('bin/freeagent.js'), '-p', 'x'], { env: { PATH: process.env.PATH, FREEAGENT_HOME: home }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /GROQ_API_KEY/);
});
