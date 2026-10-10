// The morning report: what was spent, on what, what was stopped, and what
// needs a human before anything else runs.
import path from 'node:path';
import { read, fold } from './ledger.js';
import { fmt, round } from './policy.js';

export function parseSince(s, now = Date.now()) {
  if (!s) return now - 24 * 3600_000;
  const m = /^(\d+(?:\.\d+)?)\s*([mhd])$/.exec(s);
  if (m) return now - Number(m[1]) * { m: 60_000, h: 3600_000, d: 86_400_000 }[m[2]];
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`--since: expected like 12h, 7d or an ISO date, got "${s}"`);
  return t;
}

export function buildReport(ledgerPath, { since, policy, now = Date.now() } = {}) {
  const from = since ?? now - 24 * 3600_000;
  const { calls: all, blocks: allBlocks } = fold(read(ledgerPath));
  const calls = all.filter((c) => Date.parse(c.ts) >= from);
  const blocks = allBlocks.filter((b) => Date.parse(b.ts) >= from);
  const counted = calls.filter((c) => c.status !== 'not-done');
  const spent = round(counted.reduce((s, c) => s + (c.cost || 0), 0));

  const byTool = new Map();
  for (const c of counted) {
    const t = byTool.get(c.tool) || { tool: c.tool, calls: 0, cost: 0, failed: 0, pinned: new Map() };
    t.calls += 1;
    t.cost = round(t.cost + (c.cost || 0));
    if (c.status === 'failed') t.failed += 1;
    for (const p of c.pinned || []) t.pinned.set(p, (t.pinned.get(p) || 0) + 1);
    byTool.set(c.tool, t);
  }

  const blockGroups = new Map();
  for (const b of blocks) {
    const label = blockLabel(b);
    const g = blockGroups.get(label) || { label, kind: b.kind, count: 0, first: b.ts, last: b.ts, avoided: 0 };
    g.count += 1;
    g.last = b.ts;
    g.avoided = round(g.avoided + (b.cost || 0));
    blockGroups.set(label, g);
  }

  const side = calls.filter((c) => c.sideEffect);
  const unknown = side.filter((c) => c.status === 'open');
  return {
    from: new Date(from).toISOString(),
    to: new Date(now).toISOString(),
    ledgerPath,
    budget: policy?.budget || null,
    spent,
    calls: counted.length,
    tools: [...byTool.values()].sort((a, b) => b.cost - a.cost || b.calls - a.calls),
    blocked: blocks.length,
    blockGroups: [...blockGroups.values()].sort((a, b) => b.count - a.count),
    avoided: round(blocks.reduce((s, b) => s + (b.cost || 0), 0)),
    sideEffects: {
      done: side.filter((c) => c.status === 'done').map(view),
      failed: side.filter((c) => c.status === 'failed').map(view),
      unknown: unknown.map(view),
      duplicatesStopped: blocks.filter((b) => b.kind === 'duplicate').length,
      unknownRetriesStopped: blocks.filter((b) => b.kind === 'unknown').length,
    },
  };
}

const view = (c) => ({ id: c.id, tool: c.tool, ts: c.ts, args: c.args, cost: c.cost });

function blockLabel(b) {
  switch (b.kind) {
    case 'budget': return 'budget cap reached';
    case 'maxCalls': return `${b.rule}: maxCalls reached`;
    case 'perCall': return 'single call above maxPerCall';
    case 'unknown': return `retry of an unfinished ${b.tool} (outcome unknown)`;
    case 'duplicate': return `duplicate ${b.tool}`;
    case 'unpriced': return `${b.tool}: no price in policy`;
    case 'denied': return `${b.tool}: denied by policy`;
    case 'unlisted': return `${b.tool}: not in policy`;
    case 'pin':
    case 'limit': return `${b.tool}: ${b.detail || b.kind}`;
    default: return b.reason;
  }
}

const hhmm = (iso) => new Date(iso).toTimeString().slice(0, 5);
const stamp = (iso) => { const d = new Date(iso); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hhmm(iso)}`; };

export function renderText(r, { color = true } = {}) {
  const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const bold = (s) => c(1, s), dim = (s) => c(90, s), red = (s) => c(31, s), green = (s) => c(32, s), yellow = (s) => c(33, s), cyan = (s) => c(36, s);
  const out = [];
  const rel = path.relative(process.cwd(), r.ledgerPath);
  out.push(`${bold('nightcap')} ${dim(`· ${stamp(r.from)} → ${stamp(r.to)} · ${rel.length < r.ledgerPath.length ? rel : r.ledgerPath}`)}`);
  out.push('');

  const capTxt = r.budget ? ` of $${fmt(r.budget.usd)} cap ${dim(`(per ${r.budget.per})`)}` : '';
  const pct = r.budget && r.budget.usd > 0 ? r.spent / r.budget.usd : null;
  const bar = pct === null ? '' : '  ' + meter(pct, 20, pct >= 1 ? red : pct >= 0.8 ? yellow : green);
  out.push(`${bold('SPENT')}     ${bold('$' + fmt(r.spent))}${capTxt}${bar}`);
  out.push(`${' '.repeat(10)}${r.calls} priced call${r.calls === 1 ? '' : 's'} allowed · ${r.blocked} blocked${r.avoided ? ` · ~$${fmt(r.avoided)} in blocked calls` : ''}`);
  out.push('');

  if (r.tools.length) {
    out.push(bold('BY TOOL'));
    const w = Math.max(...r.tools.map((t) => t.tool.length), 8);
    for (const t of r.tools) {
      const pins = [...t.pinned].map(([p, n]) => `${p} ×${n}`).join(', ');
      out.push(`  ${t.tool.padEnd(w)}  ${String(t.calls).padStart(4)} ${t.calls === 1 ? 'call ' : 'calls'}  ${('$' + fmt(t.cost)).padStart(9)}${t.failed ? red(`  ${t.failed} failed`) : ''}${pins ? dim(`  pinned ${pins}`) : ''}`);
    }
    out.push('');
  }

  if (r.blockGroups.length) {
    out.push(bold('STOPPED'));
    for (const g of r.blockGroups) {
      out.push(`  ${yellow('×' + String(g.count).padEnd(4))} ${g.label}${dim(`  first ${hhmm(g.first)}${g.count > 1 ? `, last ${hhmm(g.last)}` : ''}`)}${g.avoided ? dim(`  ~$${fmt(g.avoided)}`) : ''}`);
    }
    out.push('');
  }

  const s = r.sideEffects;
  if (s.done.length || s.failed.length || s.unknown.length || s.duplicatesStopped) {
    out.push(bold('ACTIONS WITH SIDE EFFECTS'));
    out.push(`  ${green(s.done.length + ' done')} · ${s.failed.length} failed · ${s.unknown.length ? red(s.unknown.length + ' unknown') : '0 unknown'} · ${s.duplicatesStopped} duplicate${s.duplicatesStopped === 1 ? '' : 's'} stopped`);
    for (const a of s.done.slice(-8)) out.push(dim(`  ✓ ${hhmm(a.ts)} ${a.tool} ${a.args}`));
    if (s.done.length > 8) out.push(dim(`  … ${s.done.length - 8} more`));
    out.push('');
  }

  out.push(bold('NEEDS YOU'));
  if (!s.unknown.length && !(r.budget && r.spent >= r.budget.usd)) out.push(green('  nothing. ✓'));
  for (const a of s.unknown) {
    out.push(`  ${red('?')} ${a.tool} ${dim(a.args)}`);
    out.push(`    started ${hhmm(a.ts)}, never reported a result (crash or kill mid-call). Check whether it happened, then:`);
    out.push(`    ${cyan(`nightcap resolve ${a.id} --done`)}   ${dim('or')}   ${cyan(`nightcap resolve ${a.id} --not-done`)}`);
  }
  if (r.budget && r.spent >= r.budget.usd) out.push(`  ${yellow('!')} budget is used up; raise budget.usd or wait for the window to roll over before the next run`);
  return out.join('\n');
}

function meter(p, width, paint) {
  const n = Math.max(0, Math.min(width, Math.round(p * width)));
  return paint('█'.repeat(n)) + '░'.repeat(width - n) + ` ${Math.round(p * 100)}%`;
}

export function renderMarkdown(r) {
  const out = [];
  out.push(`## nightcap report (${r.from.slice(0, 16).replace('T', ' ')} → ${r.to.slice(0, 16).replace('T', ' ')} UTC)`);
  out.push('');
  out.push(`**Spent:** $${fmt(r.spent)}${r.budget ? ` of $${fmt(r.budget.usd)} (per ${r.budget.per})` : ''} · ${r.calls} priced calls allowed · ${r.blocked} blocked${r.avoided ? ` · ~$${fmt(r.avoided)} in blocked calls` : ''}`);
  out.push('');
  if (r.tools.length) {
    out.push('| Tool | Calls | Cost | Failed | Pinned |', '|---|---:|---:|---:|---|');
    for (const t of r.tools) out.push(`| \`${t.tool}\` | ${t.calls} | $${fmt(t.cost)} | ${t.failed} | ${[...t.pinned].map(([p, n]) => `${p} ×${n}`).join(', ')} |`);
    out.push('');
  }
  if (r.blockGroups.length) {
    out.push('**Stopped**', '');
    for (const g of r.blockGroups) out.push(`- ×${g.count} ${g.label}${g.avoided ? ` (~$${fmt(g.avoided)})` : ''}`);
    out.push('');
  }
  const s = r.sideEffects;
  out.push(`**Side effects:** ${s.done.length} done · ${s.failed.length} failed · ${s.unknown.length} unknown · ${s.duplicatesStopped} duplicates stopped`, '');
  out.push('**Needs you**', '');
  if (!s.unknown.length) out.push('- nothing');
  for (const a of s.unknown) out.push(`- \`${a.tool}\` started ${a.ts}, no result. Verify, then \`nightcap resolve ${a.id} --done\` or \`--not-done\`.`);
  return out.join('\n');
}
