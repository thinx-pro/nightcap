// Policy file: which tool calls cost what, which argument values are allowed,
// and how much may be spent in a window. Plain JSON, no dependencies.
import fs from 'node:fs';
import path from 'node:path';

export const WINDOWS = ['24h', 'day', 'session', 'total'];

export function findPolicy(explicit, cwd = process.cwd()) {
  const candidates = [explicit, process.env.NIGHTCAP_POLICY, path.join(cwd, 'nightcap.json')].filter(Boolean);
  for (const c of candidates) {
    const p = path.resolve(cwd, c);
    if (fs.existsSync(p)) return p;
    if (c === explicit) throw new Error(`policy not found: ${p}`);
  }
  return null;
}

export function loadPolicy(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read policy ${file}: ${e.message}`);
  }
  const policy = validatePolicy(raw);
  policy.file = file;
  policy.dir = path.dirname(file);
  policy.ledgerPath = path.resolve(policy.dir, raw.ledger || '.nightcap/ledger.jsonl');
  return policy;
}

export function validatePolicy(raw) {
  const errs = [];
  if (!raw || typeof raw !== 'object') throw new Error('policy must be a JSON object');
  const budget = raw.budget ?? null;
  if (budget !== null) {
    if (typeof budget.usd !== 'number' || budget.usd < 0) errs.push('budget.usd must be a non-negative number');
    if (budget.per && !WINDOWS.includes(budget.per)) errs.push(`budget.per must be one of ${WINDOWS.join(', ')}`);
    if (budget.maxPerCall !== undefined && typeof budget.maxPerCall !== 'number') errs.push('budget.maxPerCall must be a number');
  }
  if (raw.unknownTools && !['allow', 'deny'].includes(raw.unknownTools)) errs.push('unknownTools must be "allow" or "deny"');
  const rules = raw.rules ?? [];
  if (!Array.isArray(rules)) errs.push('rules must be an array');
  rules.forEach((r, i) => {
    const at = `rules[${i}]`;
    if (typeof r.tool !== 'string' || !r.tool) errs.push(`${at}.tool must be a tool name or glob`);
    if (r.price !== undefined) checkPrice(r.price, `${at}.price`, errs);
    if (r.pin !== undefined) {
      if (typeof r.pin !== 'object' || Array.isArray(r.pin)) errs.push(`${at}.pin must be an object of arg -> [allowed values]`);
      else for (const [k, v] of Object.entries(r.pin)) {
        if (!Array.isArray(v) || v.length === 0) errs.push(`${at}.pin.${k} must be a non-empty array (first value is the default)`);
      }
    }
    if (r.max !== undefined) {
      if (typeof r.max !== 'object') errs.push(`${at}.max must be an object of arg -> number`);
      else for (const [k, v] of Object.entries(r.max)) if (typeof v !== 'number') errs.push(`${at}.max.${k} must be a number`);
    }
    if (r.match !== undefined) {
      if (typeof r.match !== 'object') errs.push(`${at}.match must be an object of arg -> regex`);
      else for (const [k, v] of Object.entries(r.match)) {
        try { new RegExp(v); } catch { errs.push(`${at}.match.${k} is not a valid regex`); }
      }
    }
    if (r.maxCalls !== undefined && (!Number.isInteger(r.maxCalls) || r.maxCalls < 0)) errs.push(`${at}.maxCalls must be a non-negative integer`);
  });
  if (errs.length) throw new Error('invalid policy:\n  - ' + errs.join('\n  - '));
  return {
    budget: budget ? { usd: budget.usd, per: budget.per || '24h', maxPerCall: budget.maxPerCall } : null,
    unknownTools: raw.unknownTools || 'allow',
    rules: rules.map((r, i) => ({ ...r, name: r.name || r.tool, index: i })),
  };
}

function checkPrice(p, at, errs) {
  if (typeof p === 'number') { if (p < 0) errs.push(`${at} must be >= 0`); return; }
  if (!p || typeof p !== 'object') { errs.push(`${at} must be a number or {by, table, per}`); return; }
  if (p.table !== undefined && (typeof p.table !== 'object' || Array.isArray(p.table))) errs.push(`${at}.table must be an object`);
  if (p.table && !p.by) errs.push(`${at}.by is required with a table`);
  if (p.base !== undefined && typeof p.base !== 'number') errs.push(`${at}.base must be a number`);
}

export function globToRegExp(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`);
}

export function matchRule(policy, tool, args = {}) {
  for (const r of policy.rules) {
    if (!globToRegExp(r.tool).test(tool)) continue;
    if (r.match && !Object.entries(r.match).every(([k, re]) => new RegExp(re).test(String(args?.[k] ?? '')))) continue;
    return r;
  }
  return null;
}

// Returns the USD estimate for a call, or null when the policy can't price it.
export function priceOf(rule, args = {}) {
  const p = rule.price;
  if (p === undefined) return 0;
  if (typeof p === 'number') return p;
  let unit = p.base ?? 0;
  if (p.table) {
    const keys = Array.isArray(p.by) ? p.by : [p.by];
    const k = keys.map((key) => String(args[key])).join('|');
    const v = Object.prototype.hasOwnProperty.call(p.table, k) ? p.table[k] : p.default;
    if (typeof v !== 'number') return null;
    unit += v;
  }
  if (p.per) {
    const n = args[p.per] !== undefined ? Number(args[p.per]) : p.perDefault;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
    unit *= n;
  }
  return round(unit);
}

export function describePrice(rule) {
  const p = rule.price;
  if (p === undefined || p === 0) return null;
  if (typeof p === 'number') return `$${fmt(p)}/call`;
  const vals = p.table ? Object.values(p.table).filter((v) => typeof v === 'number') : [];
  let s = vals.length ? (Math.min(...vals) === Math.max(...vals) ? `$${fmt(vals[0])}` : `$${fmt(Math.min(...vals))}–$${fmt(Math.max(...vals))}`) : `$${fmt(p.base ?? 0)}`;
  if (p.per) s += ` per ${p.per}`;
  if (p.table) s += ` (by ${[].concat(p.by).join('+')})`;
  return s;
}

export const round = (n) => Math.round(n * 1e6) / 1e6;
export function fmt(n) {
  if (n >= 100) return n.toFixed(0);
  if (n >= 1 || n === 0) return n.toFixed(2);
  const s = String(Number(n.toFixed(4)));
  return s.split('.')[1]?.length >= 2 ? s : n.toFixed(2);
}
