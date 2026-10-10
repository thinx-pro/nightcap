// The decision: given a tool call, allow it (possibly with pinned arguments
// filled in) or block it with a reason the agent can read.
import { matchRule, priceOf, round, fmt } from './policy.js';
import { append, read, withLock, fold, keyOf, newId, summarize, inWindow } from './ledger.js';

// A call counts against the budget unless it was resolved as "never happened".
const charged = (c) => c.status !== 'not-done';

// fillPinned=false (hook mode) blocks a call that omits a pinned argument and
// asks the agent to pass it, instead of rewriting the call behind its back.
export function evaluate(policy, { tool, args = {}, session = 'default', toolUseId, now = Date.now(), ledgerPath = policy.ledgerPath, fillPinned = true, dryRun = false }) {
  const write = dryRun ? () => {} : (e) => append(ledgerPath, e);
  return withLock(ledgerPath, () => {
    const ts = new Date(now).toISOString();
    const block = (reason, extra = {}) => {
      write({ t: 'block', ts, session, tool, reason, args: summarize(args), ...extra });
      return { allow: false, reason: `nightcap blocked this call: ${reason}` };
    };

    const rule = matchRule(policy, tool, args);
    if (!rule) {
      if (policy.unknownTools === 'deny') return block(`"${tool}" is not listed in the policy and unknownTools is "deny"`, { kind: 'unlisted' });
      return { allow: true, args, cost: 0, untracked: true };
    }
    if (rule.deny) return block(rule.reason || `"${tool}" is denied by policy`, { kind: 'denied', rule: rule.name });

    // Pinned arguments: fill in the default when missing, refuse anything else.
    const next = { ...args };
    const pinned = [];
    for (const [k, allowed] of Object.entries(rule.pin || {})) {
      if (next[k] === undefined) {
        if (!fillPinned) {
          return block(`${tool} must be called with ${k} set explicitly (the tool's own default may be a more expensive option). Retry with ${k}=${JSON.stringify(allowed[0])}${allowed.length > 1 ? ` or one of ${allowed.slice(1).map((a) => JSON.stringify(a)).join(', ')}` : ''}.`, { kind: 'pin', rule: rule.name, detail: `${k} not set` });
        }
        next[k] = allowed[0];
        pinned.push(`${k}=${allowed[0]}`);
      } else if (!allowed.some((a) => a === next[k])) {
        return block(`${k}=${JSON.stringify(next[k])} is not allowed for ${tool}; allowed: ${allowed.map((a) => JSON.stringify(a)).join(', ')}`, { kind: 'pin', rule: rule.name, detail: `${k}=${JSON.stringify(next[k])} not allowed` });
      }
    }
    for (const [k, max] of Object.entries(rule.max || {})) {
      if (next[k] !== undefined && Number(next[k]) > max) {
        return block(`${k}=${next[k]} is above the limit of ${max} for ${tool}`, { kind: 'limit', rule: rule.name, detail: `${k} over ${max}` });
      }
    }

    const cost = priceOf(rule, next);
    if (cost === null) {
      return block(`no price for this call in the policy (${describeMissing(rule, next)}); add it to the price table so it can be budgeted`, { kind: 'unpriced', rule: rule.name });
    }

    const { calls } = fold(read(ledgerPath));
    const per = policy.budget?.per || '24h';

    if (rule.maxCalls !== undefined) {
      const n = calls.filter((c) => c.rule === rule.name && charged(c) && inWindow(c, per, session, now)).length;
      if (n >= rule.maxCalls) return block(`${rule.name} already ran ${n} times (maxCalls ${rule.maxCalls} per ${per})`, { kind: 'maxCalls', rule: rule.name, cost });
    }

    if (policy.budget) {
      if (policy.budget.maxPerCall !== undefined && cost > policy.budget.maxPerCall) {
        return block(`this call would cost ~$${fmt(cost)}, above maxPerCall $${fmt(policy.budget.maxPerCall)}`, { kind: 'perCall', rule: rule.name, cost });
      }
      const spent = round(calls.filter((c) => charged(c) && inWindow(c, per, session, now)).reduce((s, c) => s + (c.cost || 0), 0));
      if (spent + cost > policy.budget.usd + 1e-9) {
        return block(`budget reached: $${fmt(spent)} of $${fmt(policy.budget.usd)} spent (${per}); this call needs ~$${fmt(cost)}. This is a hard stop; stop retrying and report back.`, { kind: 'budget', rule: rule.name, cost });
      }
    }

    const key = keyOf(tool, next);
    if (rule.sideEffect) {
      const prev = calls.filter((c) => c.key === key && c.sideEffect).pop();
      if (prev && prev.status === 'open') {
        return block(`an identical ${tool} call (${prev.id}) started at ${prev.ts} and never reported a result, so it may or may not have happened. Not repeating it. A human should check, then run: nightcap resolve ${prev.id} --done (or --not-done)`, { kind: 'unknown', rule: rule.name, ref: prev.id });
      }
      if (prev && prev.status === 'done') {
        return block(`an identical ${tool} call (${prev.id}) already completed at ${prev.doneTs || prev.ts}. Not doing it twice. Change the arguments if a second one is really intended.`, { kind: 'duplicate', rule: rule.name, ref: prev.id });
      }
    }

    const id = newId();
    write({
      t: 'call', id, ts, session, tool, rule: rule.name, cost, key,
      sideEffect: !!rule.sideEffect, pinned, args: summarize(next), ...(toolUseId ? { toolUseId } : {}),
    });
    return { allow: true, args: next, cost, id, pinned };
  });
}

export function complete(policy, id, ok, info, { ledgerPath = policy.ledgerPath, now = Date.now() } = {}) {
  withLock(ledgerPath, () => append(ledgerPath, { t: 'done', id, ts: new Date(now).toISOString(), ok: !!ok, ...(info ? { info: String(info).slice(0, 200) } : {}) }));
}

export function resolve(ledgerPath, id, outcome, now = Date.now()) {
  return withLock(ledgerPath, () => {
    const { calls } = fold(read(ledgerPath));
    const c = calls.find((x) => x.id === id);
    if (!c) throw new Error(`no call ${id} in ${ledgerPath}`);
    append(ledgerPath, { t: 'resolve', id, ts: new Date(now).toISOString(), outcome });
    return c;
  });
}

function describeMissing(rule, args) {
  const p = rule.price || {};
  const bits = [];
  if (p.by) bits.push([].concat(p.by).map((k) => `${k}=${JSON.stringify(args[k])}`).join(', '));
  if (p.per && args[p.per] === undefined) bits.push(`${p.per} missing`);
  return bits.join('; ') || 'unpriced';
}
