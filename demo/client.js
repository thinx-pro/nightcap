// Minimal stdio MCP client used by the demo and the tests.
import { spawn } from 'node:child_process';
import readline from 'node:readline';

export function connect(cmd, args, { env = {}, cwd } = {}) {
  const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env }, cwd });
  const waiting = new Map();
  let nextId = 1;
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    const w = waiting.get(msg.id);
    if (w) { waiting.delete(msg.id); w(msg); }
  });
  const request = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const closed = new Promise((r) => child.on('close', r));
  return {
    child,
    get stderr() { return stderr; },
    async init() {
      const r = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'demo', version: '0' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      return r;
    },
    list: () => request('tools/list', {}),
    call: (name, args) => request('tools/call', { name, arguments: args }),
    callNoWait(name, args) {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    },
    async close() { child.stdin.end(); await closed; },
    async kill() { child.kill('SIGKILL'); await closed; },
  };
}
