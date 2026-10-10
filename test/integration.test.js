// End to end: real child processes over stdio, the CLI, and hook mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connect } from '../demo/client.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin', 'nightcap.js');
const server = path.join(root, 'demo', 'fake-paid-server.js');

function workdir(policy) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightcap-it-'));
  fs.writeFileSync(path.join(dir, 'nightcap.json'), JSON.stringify(policy));
  return dir;
}
const bill = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const nc = (args, opts = {}) => spawnSync('node', [cli, ...args], { encoding: 'utf8', ...opts });

const POLICY = {
  budget: { usd: 0.25, per: '24h' },
  rules: [
    { tool: '*generate_video', pin: { model: ['video-draft-480p'] }, price: { by: 'model', table: { 'video-draft-480p': 0.02, 'video-pro-1080p': 0.5 }, per: 'duration_s', perDefault: 5 } },
    { tool: '*send_email', sideEffect: true },
  ],
};

test('proxy: pins the model, annotates tools/list, stops at the budget', async () => {
  const dir = workdir(POLICY);
  const billFile = path.join(dir, 'bill.jsonl');
  const c = connect('node', [cli, 'run', '--', 'node', server], { cwd: dir, env: { FAKE_BILL: billFile } });
  const init = await c.init();
  assert.equal(init.result.serverInfo.name, 'fake-paid-server');

  const list = await c.list();
  const gv = list.result.tools.find((t) => t.name === 'generate_video');
  assert.deepEqual(gv.inputSchema.properties.model.enum, ['video-draft-480p']);
  assert.match(gv.description, /\[nightcap: costs ~\$0\.02–\$0\.50 per duration_s/);

  const results = [];
  for (let i = 0; i < 4; i++) results.push(await c.call('generate_video', { prompt: `v${i}` }));
  await c.close();
  assert.deepEqual(results.map((r) => !!r.result.isError), [false, false, true, true]);
  assert.match(results[2].result.content[0].text, /budget reached/);
  const rows = bill(billFile);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.model === 'video-draft-480p'));
});

test('proxy: crash mid-call leaves the call unknown; retry is blocked; resolve unblocks', async () => {
  const dir = workdir(POLICY);
  const billFile = path.join(dir, 'bill.jsonl');
  const email = { to: 'a@example.com', subject: 's' };
  const c1 = connect('node', [cli, 'run', '--', 'node', server], { cwd: dir, env: { FAKE_BILL: billFile, FAKE_SLOW_MS: '3000' } });
  await c1.init();
  c1.callNoWait('send_email', email);
  for (let i = 0; i < 50 && bill(billFile).length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  await c1.kill();
  assert.equal(bill(billFile).length, 1, 'the server performed the side effect');

  const c2 = connect('node', [cli, 'run', '--', 'node', server], { cwd: dir, env: { FAKE_BILL: billFile } });
  await c2.init();
  const retry = await c2.call('send_email', email);
  assert.equal(retry.result.isError, true);
  const id = /nightcap resolve (c_[a-z0-9]+)/.exec(retry.result.content[0].text)[1];
  await c2.close();
  assert.equal(bill(billFile).length, 1, 'no duplicate email');

  const rep = nc(['report', '--no-color'], { cwd: dir });
  assert.match(rep.stdout, /1 unknown/);
  assert.match(rep.stdout, new RegExp(`nightcap resolve ${id} --done`));

  assert.equal(nc(['resolve', id, '--done'], { cwd: dir }).status, 0);
  const rep2 = nc(['report', '--no-color'], { cwd: dir });
  assert.match(rep2.stdout, /NEEDS YOU\n {2}nothing/);
});

test('hook mode: deny JSON for blocked calls, silence for allowed ones, Post closes the call', () => {
  const dir = workdir({ ...POLICY, budget: { usd: 0.1, per: 'session' } });
  const hook = (input) => nc(['hook'], { cwd: dir, input: JSON.stringify({ session_id: 's1', cwd: dir, ...input }) });

  const missing = hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__vid__generate_video', tool_input: { prompt: 'x' } });
  const out = JSON.parse(missing.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /Retry with model="video-draft-480p"/);

  const input = { tool_name: 'mcp__vid__generate_video', tool_input: { prompt: 'x', model: 'video-draft-480p' } };
  const ok = hook({ hook_event_name: 'PreToolUse', ...input });
  assert.equal(ok.stdout, '', 'allowed calls produce no output so normal permissions still apply');
  assert.equal(hook({ hook_event_name: 'PostToolUse', ...input, tool_response: { content: 'ok' } }).status, 0);

  const over = hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__vid__generate_video', tool_input: { prompt: 'y', model: 'video-draft-480p' } });
  assert.match(JSON.parse(over.stdout).hookSpecificOutput.permissionDecisionReason, /budget reached/);

  const lines = fs.readFileSync(path.join(dir, '.nightcap', 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.filter((l) => l.t === 'done' && l.ok).length, 1);

  const untouched = hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'x' } });
  assert.equal(untouched.stdout, '');
});

test('hook mode without a policy file does nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightcap-none-'));
  const r = nc(['hook'], { cwd: dir, input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }) });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('CLI: --help, --version, check, init, bad policy', () => {
  assert.match(nc(['--help']).stdout, /nightcap run/);
  assert.equal(nc(['-v']).stdout.trim(), '0.1.0');
  const dir = workdir(POLICY);
  const chk = nc(['check', 'generate_video', '{"prompt":"x"}'], { cwd: dir });
  assert.match(chk.stdout, /ALLOW {2}~\$0\.10 {2}pinned model=video-draft-480p/);
  const blk = nc(['check', 'generate_video', '{"model":"video-pro-1080p"}'], { cwd: dir });
  assert.equal(blk.status, 2);
  assert.match(blk.stdout, /^BLOCK/);
  assert.equal(fs.existsSync(path.join(dir, '.nightcap', 'ledger.jsonl')), false);

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'nightcap-init-'));
  assert.equal(nc(['init'], { cwd: empty }).status, 0);
  assert.match(nc(['check', 'mcp__v__generate_video', '{}'], { cwd: empty }).stdout, /ALLOW/);
  assert.equal(nc(['init'], { cwd: empty }).status, 1);

  fs.writeFileSync(path.join(empty, 'bad.json'), '{"budget":{"usd":"ten"}}');
  const bad = nc(['check', 'x', '--policy', 'bad.json'], { cwd: empty });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /budget\.usd must be/);
});
