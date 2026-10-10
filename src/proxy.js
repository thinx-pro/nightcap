// stdio MCP proxy: client <-> nightcap <-> real server.
// MCP stdio is newline-delimited JSON-RPC, so we can inspect each message.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { evaluate, complete } from './engine.js';
import { matchRule, describePrice, fmt } from './policy.js';

export function runProxy(policy, command, cmdArgs, { input = process.stdin, output = process.stdout, log = (m) => process.stderr.write(`[nightcap] ${m}\n`) } = {}) {
  const session = 'proxy-' + crypto.randomBytes(4).toString('hex');
  const child = spawn(command, cmdArgs, { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
  const pending = new Map(); // JSON id -> { kind, callId }
  const send = (msg) => output.write(JSON.stringify(msg) + '\n');
  const toChild = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');

  child.on('error', (e) => { log(`could not start server: ${e.message}`); process.exitCode = 1; output.end?.(); });

  readline.createInterface({ input }).on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { child.stdin.write(line + '\n'); return; }
    const idKey = msg.id !== undefined ? JSON.stringify(msg.id) : null;

    if (msg.method === 'tools/list' && idKey) pending.set(idKey, { kind: 'list' });

    if (msg.method === 'tools/call' && idKey) {
      const tool = msg.params?.name;
      let d;
      try {
        d = evaluate(policy, { tool, args: msg.params?.arguments || {}, session });
      } catch (e) {
        d = { allow: false, reason: `nightcap blocked this call: internal error (${e.message}); failing closed` };
      }
      if (!d.allow) {
        log(`BLOCK ${tool}: ${d.reason.replace(/^nightcap blocked this call: /, '')}`);
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: d.reason }], isError: true } });
        return;
      }
      if (d.id) pending.set(idKey, { kind: 'call', callId: d.id });
      if (d.pinned?.length) log(`pinned ${tool}: ${d.pinned.join(', ')}`);
      msg = { ...msg, params: { ...msg.params, arguments: d.args } };
    }
    toChild(msg);
  }).on('close', () => child.stdin.end());

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { output.write(line + '\n'); return; }
    const idKey = msg.id !== undefined && msg.method === undefined ? JSON.stringify(msg.id) : null;
    const p = idKey && pending.get(idKey);
    if (p) {
      pending.delete(idKey);
      if (p.kind === 'call') {
        const ok = !msg.error && !msg.result?.isError;
        const info = msg.error?.message || (msg.result?.isError ? msg.result?.content?.[0]?.text : undefined);
        try { complete(policy, p.callId, ok, info); } catch (e) { log(`ledger write failed: ${e.message}`); }
      } else if (p.kind === 'list' && Array.isArray(msg.result?.tools)) {
        msg = { ...msg, result: { ...msg.result, tools: msg.result.tools.map((t) => annotate(policy, t)) } };
      }
    }
    send(msg);
  });

  child.on('close', (code, signal) => {
    if (pending.size) log(`server exited with ${pending.size} call(s) in flight; they stay "unknown" in the ledger`);
    process.exitCode = code ?? (signal ? 1 : 0);
    output.end?.();
  });
  return child;
}

// Tell the model what a tool costs and restrict pinned arguments in the schema,
// so it picks allowed values up front instead of learning by being blocked.
export function annotate(policy, tool) {
  const rule = matchRule(policy, tool.name, {});
  if (!rule) return tool;
  if (rule.deny) return { ...tool, description: `${tool.description || ''}\n[nightcap: this tool is disabled by policy]`.trim() };
  const notes = [];
  const price = describePrice(rule);
  if (price) notes.push(`costs ~${price}`);
  for (const [k, v] of Object.entries(rule.pin || {})) notes.push(`${k} must be ${v.map((x) => JSON.stringify(x)).join(' or ')}`);
  if (rule.maxCalls !== undefined) notes.push(`max ${rule.maxCalls} calls`);
  if (policy.budget) notes.push(`shared budget $${fmt(policy.budget.usd)} per ${policy.budget.per}`);
  if (rule.sideEffect) notes.push('identical calls are not repeated');
  let schema = tool.inputSchema;
  if (rule.pin && schema?.properties) {
    const props = { ...schema.properties };
    for (const [k, v] of Object.entries(rule.pin)) {
      if (props[k]) props[k] = { ...props[k], enum: v, default: v[0] };
    }
    schema = { ...schema, properties: props };
  }
  return { ...tool, inputSchema: schema, description: `${tool.description || ''}\n[nightcap: ${notes.join('; ')}]`.trim() };
}
