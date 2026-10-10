#!/usr/bin/env node
// A fake "paid API" MCP server for demos and tests. Nothing real is called.
// It bills itself into $FAKE_BILL (JSONL) so you can compare what the provider
// charged with what nightcap allowed. Its default model is the expensive one,
// on purpose: that's how unattended runs overspend.
import fs from 'node:fs';
import readline from 'node:readline';

const BILL = process.env.FAKE_BILL || 'fake-bill.jsonl';
const SLOW_MS = Number(process.env.FAKE_SLOW_MS || 0); // makes send_email slow, to kill it mid-call
const RATES = { 'video-draft-480p': 0.02, 'video-std-720p': 0.08, 'video-pro-1080p': 0.5 };

const tools = [
  {
    name: 'generate_video',
    description: 'Generate a short video clip from a prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        model: { type: 'string', description: 'defaults to video-pro-1080p' },
        duration_s: { type: 'number', description: 'defaults to 5' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'send_email',
    description: 'Send an email.',
    inputSchema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject'] },
  },
];

const bill = (entry) => fs.appendFileSync(BILL, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === undefined) return; // notification
  if (msg.method === 'initialize') {
    return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-paid-server', version: '0.1.0' } } });
  }
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools } });
  if (msg.method === 'tools/call') {
    const { name, arguments: a = {} } = msg.params;
    if (name === 'generate_video') {
      const model = a.model || 'video-pro-1080p';
      const dur = a.duration_s ?? 5;
      const usd = Math.round((RATES[model] ?? 1) * dur * 1e6) / 1e6;
      bill({ tool: name, model, duration_s: dur, usd });
      return send({ jsonrpc: '2.0', id: msg.id, result: text(`rendered ${dur}s on ${model} ($${usd})`) });
    }
    if (name === 'send_email') {
      bill({ tool: name, to: a.to, subject: a.subject, usd: 0 }); // the side effect happens first...
      if (SLOW_MS) await new Promise((r) => setTimeout(r, SLOW_MS)); // ...then the reply is slow
      return send({ jsonrpc: '2.0', id: msg.id, result: text(`sent to ${a.to}`) });
    }
    return send({ jsonrpc: '2.0', id: msg.id, result: text(`unknown tool ${name}`, true) });
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
});
