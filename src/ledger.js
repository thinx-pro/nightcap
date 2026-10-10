// Append-only JSONL ledger. Every write is fsync'd before the call it describes
// is forwarded, so after a crash the ledger knows what was *started*.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(sleeper, 0, 0, ms);

export function append(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, JSON.stringify(entry) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function read(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn last line after a crash: ignore */ }
  }
  return out;
}

// Cross-process lock (hook mode runs one process per tool call, and Claude Code
// can run tool calls in parallel). O_EXCL lock file, stale after 10 s.
export function withLock(file, fn, { timeoutMs = 5000 } = {}) {
  const lock = file + '.lock';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const start = Date.now();
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(lock, 'wx');
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) { fs.unlinkSync(lock); continue; }
      } catch { continue; }
      if (Date.now() - start > timeoutMs) throw new Error(`ledger is locked (${lock}); remove it if no nightcap process is running`);
      sleep(15);
    }
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(lock); } catch { /* already gone */ }
  }
}

// Stable JSON (sorted keys) so the same arguments always hash the same.
export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
}

export const keyOf = (tool, args) => crypto.createHash('sha256').update(tool + '\0' + canonical(args || {})).digest('hex').slice(0, 16);

export const newId = () => 'c_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

// Short, single-line view of arguments for reports. Long values (email bodies,
// prompts) are cut so the ledger doesn't become a copy of everything the agent sent.
export function summarize(args, max = 80) {
  const parts = [];
  for (const [k, v] of Object.entries(args || {})) {
    let s = typeof v === 'string' ? v : JSON.stringify(v);
    s = String(s).replace(/\s+/g, ' ');
    if (s.length > max) s = s.slice(0, max - 1) + '…';
    parts.push(`${k}=${s}`);
  }
  return parts.join(' ');
}

// Fold raw entries into one record per call with its final state.
export function fold(entries) {
  const calls = new Map();
  const blocks = [];
  for (const e of entries) {
    if (e.t === 'call') calls.set(e.id, { ...e, status: 'open' });
    else if (e.t === 'done' && calls.has(e.id)) Object.assign(calls.get(e.id), { status: e.ok ? 'done' : 'failed', doneTs: e.ts, info: e.info });
    else if (e.t === 'resolve' && calls.has(e.id)) Object.assign(calls.get(e.id), { status: e.outcome === 'done' ? 'done' : 'not-done', resolvedTs: e.ts, resolved: true });
    else if (e.t === 'block') blocks.push(e);
  }
  return { calls: [...calls.values()], blocks };
}

export function windowStart(per, now = Date.now()) {
  if (per === '24h') return now - 24 * 3600_000;
  if (per === 'day') { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }
  return 0; // 'session' and 'total' filter by session id / not at all
}

export function inWindow(rec, per, session, now = Date.now()) {
  if (per === 'session') return rec.session === session;
  return Date.parse(rec.ts) >= windowStart(per, now);
}
