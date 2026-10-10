#!/usr/bin/env node
// Replays a bad night twice against the fake paid server: once directly, once
// through nightcap. Then crashes nightcap in the middle of a send_email and retries.
// Usage: node demo/overnight.js   (writes to demo/.out/, touches nothing else)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const out = path.join(here, '.out');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const server = path.join(here, 'fake-paid-server.js');
const cli = path.join(root, 'bin', 'nightcap.js');
const policy = path.join(here, 'policy.json');
const ledger = path.join(out, 'ledger.jsonl');
const billOf = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const usd = (rows) => Math.round(rows.reduce((s, r) => s + r.usd, 0) * 100) / 100;
const viaNightcap = (env) => connect('node', [cli, 'run', '--policy', policy, '--ledger', ledger, '--', 'node', server], { env });

// The "agent": 96 variants of the same clip, no model specified, and a few
// attempts to upgrade to 1080p "for the final cut".
async function badNight(c) {
  await c.init();
  let ok = 0, blocked = 0;
  for (let i = 1; i <= 96; i++) {
    const args = { prompt: `person walks through a door, variant ${i}` };
    if (i % 30 === 0) args.model = 'video-pro-1080p';
    const r = await c.call('generate_video', args);
    if (r.result?.isError) blocked++; else ok++;
  }
  return { ok, blocked };
}

console.log('1) Without nightcap: agent talks to the paid server directly');
const billA = path.join(out, 'bill-without.jsonl');
const a = connect('node', [server], { env: { FAKE_BILL: billA } });
const ra = await badNight(a);
await a.close();
console.log(`   ${ra.ok} clips rendered, provider bill $${usd(billOf(billA))}`);

console.log('2) Same night through nightcap (budget $5, model pinned to video-draft-480p)');
const billB = path.join(out, 'bill-with.jsonl');
const b = viaNightcap({ FAKE_BILL: billB });
const rb = await badNight(b);
await b.close();
console.log(`   ${rb.ok} clips rendered, ${rb.blocked} calls blocked, provider bill $${usd(billOf(billB))}`);

console.log('3) Crash in the middle of send_email, then the agent retries');
const billC = path.join(out, 'bill-email.jsonl');
const email = { to: 'client@example.com', subject: 'Your renders are ready', body: '96 variants attached.' };
const c1 = viaNightcap({ FAKE_BILL: billC, FAKE_SLOW_MS: '2000' });
await c1.init();
c1.callNoWait('send_email', email);
await new Promise((r) => setTimeout(r, 500)); // the server has sent it; the reply hasn't arrived
await c1.kill();
const c2 = viaNightcap({ FAKE_BILL: billC });
await c2.init();
const retry = await c2.call('send_email', email);
const other = await c2.call('send_email', { ...email, to: 'producer@example.com' });
const again = await c2.call('send_email', { ...email, to: 'producer@example.com' });
await c2.close();
console.log(`   retry after crash: ${retry.result.isError ? 'BLOCKED (outcome unknown)' : 'sent again'}`);
console.log(`   new recipient: ${other.result.isError ? 'blocked' : 'sent'}; same email twice: ${again.result.isError ? 'BLOCKED (duplicate)' : 'sent twice'}`);
console.log(`   emails the provider actually sent: ${billOf(billC).length}`);
console.log(`\nLedger: ${path.relative(process.cwd(), ledger)}\nMorning report: node bin/nightcap.js report --policy demo/policy.json --ledger ${path.relative(process.cwd(), ledger)}`);
