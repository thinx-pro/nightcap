#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPolicy, loadPolicy, fmt } from '../src/policy.js';
import { runProxy } from '../src/proxy.js';
import { handleHook, settingsSnippet } from '../src/hook.js';
import { evaluate, resolve } from '../src/engine.js';
import { buildReport, renderText, renderMarkdown, parseSince } from '../src/report.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

const HELP = `nightcap ${VERSION} - a hard stop for unattended agents

Usage:
  nightcap run [--policy FILE] -- <mcp server command...>
      Wrap a stdio MCP server. Every tools/call is priced, checked against
      the policy, and written to the ledger before it reaches the server.
  nightcap hook [--policy FILE]
      Claude Code hook (PreToolUse / PostToolUse / PostToolUseFailure).
      Reads the hook JSON on stdin. Prints the settings snippet with --print-settings.
  nightcap report [--since 12h|7d|ISO] [--md|--json] [--no-color]
      The morning report: spend, what was stopped, what needs you.
  nightcap check <tool> ['<json args>']
      Dry run: what would the policy do with this call? Writes nothing.
  nightcap resolve <call-id> --done|--not-done
      Settle a side-effect call whose outcome is unknown (crash mid-call).
  nightcap init [FILE]
      Write an example policy (default ./nightcap.json).

Options:
  --policy FILE   policy JSON (default: $NIGHTCAP_POLICY, then ./nightcap.json)
  --ledger FILE   override the ledger path from the policy
  -h, --help      show this help
  -v, --version   show the version

Docs: https://github.com/thinx-pro/nightcap`;

function parse(argv) {
  const dd = argv.indexOf('--');
  const rest = dd >= 0 ? argv.slice(dd + 1) : [];
  const a = dd >= 0 ? argv.slice(0, dd) : argv;
  const opts = { _: [] };
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (['--policy', '--ledger', '--since'].includes(x)) opts[x.slice(2)] = a[++i];
    else if (x.startsWith('--')) opts[x.slice(2)] = true;
    else if (x === '-h') opts.help = true;
    else if (x === '-v') opts.version = true;
    else opts._.push(x);
  }
  return { opts, rest };
}

function policyOrDie(opts, { required = true } = {}) {
  const file = findPolicy(opts.policy);
  if (!file) {
    if (!required) return null;
    die('no policy found. Pass --policy FILE, set NIGHTCAP_POLICY, or run `nightcap init` to create ./nightcap.json');
  }
  const p = loadPolicy(file);
  if (opts.ledger) p.ledgerPath = path.resolve(opts.ledger);
  return p;
}

function die(msg, code = 1) {
  process.stderr.write(`nightcap: ${msg}\n`);
  process.exit(code);
}

async function main() {
  const { opts, rest } = parse(process.argv.slice(2));
  const cmd = opts._[0];
  if (opts.version) return console.log(VERSION);
  if (opts.help || !cmd) return console.log(HELP);

  try {
    if (cmd === 'run') {
      if (!rest.length) die('usage: nightcap run [--policy FILE] -- <server command...>');
      const policy = policyOrDie(opts);
      runProxy(policy, rest[0], rest.slice(1));
      return;
    }

    if (cmd === 'hook') {
      if (opts['print-settings']) return console.log(JSON.stringify(settingsSnippet(), null, 2));
      const raw = fs.readFileSync(0, 'utf8');
      let input;
      try { input = JSON.parse(raw); } catch { die('hook: expected JSON on stdin'); }
      try {
        const out = handleHook(input, { policyPath: opts.policy });
        if (out) process.stdout.write(JSON.stringify(out));
      } catch (e) {
        // Fail closed before a call, fail open after it.
        if (input.hook_event_name === 'PreToolUse') {
          process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `nightcap: ${e.message}` } }));
        } else process.stderr.write(`nightcap: ${e.message}\n`);
      }
      return;
    }

    if (cmd === 'report' || cmd === 'status') {
      const policy = policyOrDie(opts, { required: !opts.ledger });
      const ledgerPath = policy?.ledgerPath || path.resolve(opts.ledger);
      const r = buildReport(ledgerPath, { since: parseSince(opts.since), policy });
      if (opts.json) return console.log(JSON.stringify(r, null, 2));
      if (opts.md) return console.log(renderMarkdown(r));
      return console.log(renderText(r, { color: !opts['no-color'] && (opts.color || process.stdout.isTTY) }));
    }

    if (cmd === 'check') {
      const policy = policyOrDie(opts);
      const [, tool, json] = opts._;
      if (!tool) die("usage: nightcap check <tool> '<json args>'");
      let args = {};
      if (json) try { args = JSON.parse(json); } catch { die('check: arguments must be JSON'); }
      const d = evaluate(policy, { tool, args, dryRun: true, session: 'check' });
      if (!d.allow) { console.log(`BLOCK  ${d.reason.replace(/^nightcap blocked this call: /, '')}`); process.exitCode = 2; return; }
      if (d.untracked) return console.log(`ALLOW  ${tool} is not in the policy (unknownTools: allow); not priced or logged`);
      console.log(`ALLOW  ~$${fmt(d.cost)}${d.pinned.length ? `  pinned ${d.pinned.join(', ')}` : ''}`);
      console.log(`       forwarded args: ${JSON.stringify(d.args)}`);
      return;
    }

    if (cmd === 'resolve') {
      const id = opts._[1];
      if (!id || (!opts.done && !opts['not-done'])) die('usage: nightcap resolve <call-id> --done|--not-done');
      const policy = policyOrDie(opts, { required: !opts.ledger });
      const ledgerPath = opts.ledger ? path.resolve(opts.ledger) : policy.ledgerPath;
      const c = resolve(ledgerPath, id, opts.done ? 'done' : 'not-done');
      console.log(`${id} (${c.tool}) marked ${opts.done ? 'done: identical calls stay blocked' : 'not done: it no longer counts against the budget and may be retried'}`);
      return;
    }

    if (cmd === 'init') {
      const target = path.resolve(opts._[1] || 'nightcap.json');
      if (fs.existsSync(target)) die(`${target} already exists`);
      fs.copyFileSync(path.join(root, 'examples', 'nightcap.json'), target);
      console.log(`wrote ${target}\nEdit the prices to match your providers, then try: nightcap check <tool> '{"arg": "value"}'`);
      return;
    }

    die(`unknown command "${cmd}". Run nightcap --help`);
  } catch (e) {
    die(e.message);
  }
}

main();
