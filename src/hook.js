// Claude Code hook mode. Register `nightcap hook` for PreToolUse and PostToolUse
// (and PostToolUseFailure); it reads the hook JSON on stdin.
import { findPolicy, loadPolicy } from './policy.js';
import { evaluate, complete } from './engine.js';
import { read, fold, keyOf, withLock } from './ledger.js';

export function handleHook(input, { policyPath, cwd } = {}) {
  const event = input.hook_event_name;
  const file = findPolicy(policyPath, cwd || input.cwd || process.cwd());
  if (!file) return null; // no policy for this project: stay out of the way
  const policy = loadPolicy(file);
  const tool = input.tool_name;
  const args = input.tool_input || {};
  const session = input.session_id || 'default';

  if (event === 'PreToolUse') {
    let d;
    try {
      d = evaluate(policy, { tool, args, session, toolUseId: input.tool_use_id, fillPinned: false });
    } catch (e) {
      d = { allow: false, reason: `nightcap blocked this call: internal error (${e.message}); failing closed` };
    }
    if (d.allow) return null; // no opinion: normal permission rules still apply
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.reason } };
  }

  if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
    const id = findOpenCall(policy.ledgerPath, { tool, args, session, toolUseId: input.tool_use_id });
    if (id) {
      const ok = event === 'PostToolUse' && !looksFailed(input.tool_response);
      complete(policy, id, ok, ok ? undefined : (input.error || 'tool reported an error'));
    }
    return null;
  }
  return null;
}

function findOpenCall(ledgerPath, { tool, args, session, toolUseId }) {
  return withLock(ledgerPath, () => {
    const open = fold(read(ledgerPath)).calls.filter((c) => c.status === 'open' && c.tool === tool);
    if (toolUseId) {
      const hit = open.find((c) => c.toolUseId === toolUseId);
      if (hit) return hit.id;
    }
    const key = keyOf(tool, args);
    const hit = open.filter((c) => c.key === key && c.session === session).pop();
    return hit?.id || null;
  });
}

function looksFailed(resp) {
  return !!(resp && typeof resp === 'object' && (resp.isError === true || resp.is_error === true));
}

export const settingsSnippet = (cmd = 'nightcap hook') => {
  const entry = [{ matcher: 'mcp__.*|Bash', hooks: [{ type: 'command', command: cmd }] }];
  return { hooks: { PreToolUse: entry, PostToolUse: entry, PostToolUseFailure: entry } };
};
