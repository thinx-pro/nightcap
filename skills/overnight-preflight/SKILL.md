---
name: overnight-preflight
description: Use before starting any long, batch, background or overnight task that will run while the user is away, especially one that calls paid tools (video, image, search, email, payments, form submission) or spawns many sessions. Builds a nightcap policy with pinned models and a hard dollar cap, and gets the user's sign-off before they leave.
---

# Overnight preflight

The user is about to leave you running. Model usage limits only cover model calls; they do not cover paid tools you call, or emails and forms you submit. Before starting, do this:

1. **List what this run will call.** For each tool that costs money or has side effects (sends, posts, submits, pays, deletes), write down:
   - the tool name (in Claude Code: `mcp__<server>__<tool>`, or `Bash` plus a command pattern),
   - which argument picks the price tier (model, resolution, duration, size), and the cheapest value that is good enough for this job,
   - what the tool does when that argument is left out. If you don't know, assume the most expensive option.
2. **Estimate the cost.** Number of calls × price per call, using prices the user gives you or the provider's pricing page. Show the arithmetic. If you can't find a price, say so; don't guess.
3. **Write `nightcap.json`** in the project root (see https://github.com/thinx-pro/nightcap):
   - `budget.usd`: the user's number, not yours. Ask for it.
   - a `pin` for every tier argument, cheapest acceptable value first,
   - `sideEffect: true` for anything that sends, submits or pays, plus a `maxCalls`,
   - `deny: true` for anything that must not happen unattended (payments, deletions, posting in public).
4. **Dry-run it.** For each tool, run `nightcap check <tool> '<typical args as JSON>'` and confirm that the price and pins come out as expected.
5. **Ask once, then go.** Show the user one short block: tools, pinned values, estimated cost, cap, and what will be blocked. Start only after they confirm.

During the run:

- If a call comes back with `nightcap blocked this call`, read the reason. Never retry a budget block or an "outcome unknown" block. Stop that line of work and note it for the morning.
- Don't switch to a more expensive tier to "get better results" unless the policy allows it.

When the run ends, run `nightcap report --md` and put the output at the top of your summary, with the **Needs you** items first.
