import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validatePolicy, priceOf, matchRule, fmt } from '../src/policy.js';
import { evaluate, complete, resolve } from '../src/engine.js';
import { read, fold, canonical } from '../src/ledger.js';
import { buildReport, renderText, renderMarkdown, parseSince } from '../src/report.js';

function setup(raw) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightcap-'));
  const policy = validatePolicy(raw);
  policy.ledgerPath = path.join(dir, 'ledger.jsonl');
  return policy;
}

const video = {
  tool: '*generate_video',
  pin: { model: ['draft', 'std'] },
  max: { duration_s: 10 },
  price: { by: 'model', table: { draft: 0.02, std: 0.08, pro: 0.5 }, per: 'duration_s', perDefault: 5 },
};

test('policy validation reports every problem at once', () => {
  assert.throws(
    () => validatePolicy({ budget: { usd: -1, per: 'week' }, rules: [{ tool: '', pin: { model: [] }, price: { table: {} } }] }),
    (e) => /budget\.usd/.test(e.message) && /budget\.per/.test(e.message) && /rules\[0\]\.tool/.test(e.message) && /pin\.model/.test(e.message) && /by is required/.test(e.message),
  );
});

test('pricing: flat, table, per-unit, multi-key, unknown', () => {
  assert.equal(priceOf({ price: 0.25 }, {}), 0.25);
  assert.equal(priceOf({ price: video.price }, { model: 'std', duration_s: 3 }), 0.24);
  assert.equal(priceOf({ price: video.price }, { model: 'draft' }), 0.1); // perDefault 5
  assert.equal(priceOf({ price: video.price }, { model: 'mystery' }), null);
  assert.equal(priceOf({ price: { by: ['size', 'q'], table: { '1024|hd': 0.08 } } }, { size: 1024, q: 'hd' }), 0.08);
  assert.equal(priceOf({ price: { by: 'size', table: {}, default: 0.04 } }, { size: 9 }), 0.04);
  assert.equal(priceOf({}, {}), 0);
});

test('rules match by glob and by argument regex; first match wins', () => {
  const p = validatePolicy({ rules: [{ tool: 'Bash', match: { command: '^curl .*paid\\.api' }, price: 2 }, { tool: 'Bash', price: 0 }, video] });
  assert.equal(matchRule(p, 'Bash', { command: 'curl https://paid.api/x' }).price, 2);
  assert.equal(matchRule(p, 'Bash', { command: 'ls' }).price, 0);
  assert.equal(matchRule(p, 'mcp__vid__generate_video', {}).tool, '*generate_video');
  assert.equal(matchRule(p, 'generate_image', {}), null);
});

test('missing pinned argument is filled with the first allowed value (proxy mode)', () => {
  const p = setup({ rules: [video] });
  const d = evaluate(p, { tool: 'generate_video', args: { prompt: 'x' } });
  assert.equal(d.allow, true);
  assert.equal(d.args.model, 'draft');
  assert.deepEqual(d.pinned, ['model=draft']);
  assert.equal(d.cost, 0.1);
});

test('missing pinned argument is refused with instructions in hook mode', () => {
  const p = setup({ rules: [video] });
  const d = evaluate(p, { tool: 'mcp__v__generate_video', args: { prompt: 'x' }, fillPinned: false });
  assert.equal(d.allow, false);
  assert.match(d.reason, /Retry with model="draft"/);
});

test('disallowed pinned value and over-limit argument are blocked', () => {
  const p = setup({ rules: [video] });
  assert.match(evaluate(p, { tool: 'generate_video', args: { model: 'pro' } }).reason, /model="pro" is not allowed/);
  assert.match(evaluate(p, { tool: 'generate_video', args: { model: 'std', duration_s: 60 } }).reason, /duration_s=60 is above the limit of 10/);
});

test('unpriced calls are blocked rather than guessed', () => {
  const p = setup({ rules: [{ tool: 'gen', price: { by: 'model', table: { a: 1 } } }] });
  const d = evaluate(p, { tool: 'gen', args: { model: 'b' } });
  assert.equal(d.allow, false);
  assert.match(d.reason, /no price/);
});

test('budget is a hard stop and counts in-flight calls', () => {
  const p = setup({ budget: { usd: 0.3 }, rules: [video] });
  const a = evaluate(p, { tool: 'generate_video', args: {} }); // 0.10, never completed (in flight)
  const b = evaluate(p, { tool: 'generate_video', args: { prompt: 2 } });
  const c = evaluate(p, { tool: 'generate_video', args: { prompt: 3 } });
  const d = evaluate(p, { tool: 'generate_video', args: { prompt: 4 } });
  assert.equal(a.allow && b.allow && c.allow, true);
  assert.equal(d.allow, false);
  assert.match(d.reason, /budget reached: \$0\.30 of \$0\.30/);
  complete(p, a.id, true);
  assert.equal(evaluate(p, { tool: 'generate_video', args: { prompt: 5 } }).allow, false);
});

test('maxPerCall and maxCalls', () => {
  const p = setup({ budget: { usd: 100, maxPerCall: 0.2 }, rules: [{ ...video, maxCalls: 2 }] });
  assert.match(evaluate(p, { tool: 'generate_video', args: { model: 'std' } }).reason, /above maxPerCall/); // 0.40
  assert.equal(evaluate(p, { tool: 'generate_video', args: { prompt: 1 } }).allow, true);
  assert.equal(evaluate(p, { tool: 'generate_video', args: { prompt: 2 } }).allow, true);
  assert.match(evaluate(p, { tool: 'generate_video', args: { prompt: 3 } }).reason, /maxCalls 2/);
});

test('budget window "session" is per session', () => {
  const p = setup({ budget: { usd: 0.1, per: 'session' }, rules: [video] });
  assert.equal(evaluate(p, { tool: 'generate_video', args: {}, session: 's1' }).allow, true);
  assert.equal(evaluate(p, { tool: 'generate_video', args: { prompt: 1 }, session: 's1' }).allow, false);
  assert.equal(evaluate(p, { tool: 'generate_video', args: { prompt: 1 }, session: 's2' }).allow, true);
});

test('24h window ignores old spend', () => {
  const p = setup({ budget: { usd: 0.1, per: '24h' }, rules: [video] });
  const old = Date.now() - 25 * 3600_000;
  assert.equal(evaluate(p, { tool: 'generate_video', args: {}, now: old }).allow, true);
  assert.equal(evaluate(p, { tool: 'generate_video', args: { prompt: 1 } }).allow, true);
});

test('side effects: unknown outcome blocks the retry until resolved', () => {
  const p = setup({ rules: [{ tool: 'send_email', sideEffect: true }] });
  const args = { to: 'a@example.com', subject: 'hi' };
  const first = evaluate(p, { tool: 'send_email', args });
  assert.equal(first.allow, true);
  // crash: no complete()
  const retry = evaluate(p, { tool: 'send_email', args: { subject: 'hi', to: 'a@example.com' } }); // key order must not matter
  assert.equal(retry.allow, false);
  assert.match(retry.reason, new RegExp(`nightcap resolve ${first.id}`));
  resolve(p.ledgerPath, first.id, 'not-done');
  assert.equal(evaluate(p, { tool: 'send_email', args }).allow, true);
});

test('side effects: completed call is not repeated; failed call may be retried', () => {
  const p = setup({ rules: [{ tool: 'send_email', sideEffect: true }] });
  const a = evaluate(p, { tool: 'send_email', args: { to: 'x' } });
  complete(p, a.id, true);
  assert.match(evaluate(p, { tool: 'send_email', args: { to: 'x' } }).reason, /already completed/);
  const b = evaluate(p, { tool: 'send_email', args: { to: 'y' } });
  complete(p, b.id, false, 'smtp 500');
  assert.equal(evaluate(p, { tool: 'send_email', args: { to: 'y' } }).allow, true);
});

test('resolve --not-done refunds the budget', () => {
  const p = setup({ budget: { usd: 0.1 }, rules: [{ ...video, sideEffect: true }] });
  const a = evaluate(p, { tool: 'generate_video', args: {} });
  assert.equal(evaluate(p, { tool: 'generate_video', args: { prompt: 1 } }).allow, false);
  resolve(p.ledgerPath, a.id, 'not-done');
  assert.equal(evaluate(p, { tool: 'generate_video', args: { prompt: 1 } }).allow, true);
});

test('deny rules and unknownTools', () => {
  const p = setup({ unknownTools: 'deny', rules: [{ tool: 'pay', deny: true, reason: 'no payments overnight' }, { tool: 'ok' }] });
  assert.match(evaluate(p, { tool: 'pay', args: {} }).reason, /no payments overnight/);
  assert.match(evaluate(p, { tool: 'other', args: {} }).reason, /not listed/);
  assert.equal(evaluate(p, { tool: 'ok', args: {} }).allow, true);
  const q = setup({ rules: [] });
  assert.equal(evaluate(q, { tool: 'anything', args: {} }).untracked, true);
  assert.equal(read(q.ledgerPath).length, 0);
});

test('dry run writes nothing', () => {
  const p = setup({ budget: { usd: 1 }, rules: [video] });
  evaluate(p, { tool: 'generate_video', args: {}, dryRun: true });
  evaluate(p, { tool: 'generate_video', args: { model: 'pro' }, dryRun: true });
  assert.equal(read(p.ledgerPath).length, 0);
});

test('ledger survives a torn last line', () => {
  const p = setup({ rules: [video] });
  evaluate(p, { tool: 'generate_video', args: {} });
  fs.appendFileSync(p.ledgerPath, '{"t":"call","id":"c_tor');
  assert.equal(fold(read(p.ledgerPath)).calls.length, 1);
  assert.equal(evaluate(p, { tool: 'generate_video', args: { prompt: 1 } }).allow, true);
});

test('long argument values are truncated in the ledger', () => {
  const p = setup({ rules: [{ tool: 'send_email', sideEffect: true }] });
  evaluate(p, { tool: 'send_email', args: { body: 'x'.repeat(5000) } });
  assert.ok(fs.readFileSync(p.ledgerPath, 'utf8').length < 700);
});

test('canonical JSON sorts keys deeply', () => {
  assert.equal(canonical({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
});

test('report: spend, groups, unknowns, markdown', () => {
  const p = setup({ budget: { usd: 0.2 }, rules: [video, { tool: 'send_email', sideEffect: true }] });
  const a = evaluate(p, { tool: 'generate_video', args: {} });
  complete(p, a.id, true);
  evaluate(p, { tool: 'generate_video', args: { prompt: 1 } });
  evaluate(p, { tool: 'generate_video', args: { prompt: 2 } }); // budget
  evaluate(p, { tool: 'generate_video', args: { model: 'pro' } }); // pin
  const e = evaluate(p, { tool: 'send_email', args: { to: 'x' } }); // left open
  const r = buildReport(p.ledgerPath, { policy: p });
  assert.equal(r.spent, 0.2);
  assert.equal(r.blocked, 2);
  assert.equal(r.sideEffects.unknown[0].id, e.id);
  const txt = renderText(r, { color: false });
  assert.match(txt, /SPENT\s+\$0\.20 of \$0\.20/);
  assert.match(txt, /budget cap reached/);
  assert.match(txt, new RegExp(`nightcap resolve ${e.id} --done`));
  assert.match(renderMarkdown(r), /\| `generate_video` \| 2 \| \$0\.20 \|/);
});

test('parseSince and fmt', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  assert.equal(parseSince('12h', now), now - 12 * 3600_000);
  assert.equal(parseSince('2d', now), now - 2 * 86_400_000);
  assert.throws(() => parseSince('yesterday'));
  assert.equal(fmt(0.5), '0.50');
  assert.equal(fmt(0.005), '0.005');
  assert.equal(fmt(12.345), '12.35');
  assert.equal(fmt(0), '0.00');
});
