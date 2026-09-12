# Trac — roadmap

Unit standard: the 5h window. Week = the budget. Dollars = dim API-equivalent yardstick.
Audience: Claude subscription users (Pro/Max), not API billing.

## M1 — Trust (days)
The numbers must be beyond doubt before trac is allowed to warn or act.
- [x] **report ↔ live-quota calibration** — report capacity comes from the live cap
      (implied $/window), not the busiest-window heuristic; report % matches /usage
- [x] **`--json` history export** (shipped as `trac export`) — full per-day/per-window/per-model dump for
      integrations and testers
- [x] **limit warnings** — macOS notification at 70/85/95% session + "you'll cap
      in ~40min at this burn, reset is 7:49" (tracbar already polls every 60s —
      the trigger lives there). First paid-feeling feature.

## M2 — Money insight (week)
The shareable conversion moments.
- [ ] **plan right-sizing** — "you'd never notice a Pro downgrade" / "Max 5x pays
      for itself" with receipts from real usage
- [ ] **model-mix coaching** — per-project model suggestions with windows-freed math
- [ ] **weekly digest** — Sunday notification: windows used, waste, one recommendation

## M3 — Execution (the product)
Converts sunk subscription into work product. Needs M1 trust.
- [x] **task backlog** — repo + prompt + priority + budget + permission level
- [x] **idle scheduler** — fills forecast-unused windows; hard reserve (~25%);
      halts the moment the human is active
- [x] **headless `claude -p` dispatch** — runs in git worktrees on branches, never
      the working tree; artifacts = branches/draft PRs/docs
- [x] **morning report** — what got done, what's blocked, what it cost

## M3.5 — Task intake / prep ("capture at queue time, execute at run time")
Overnight runs can't reach live resources (Figma desktop, dev servers, the user).
Prep moves the intelligence to `trac add`:
- [ ] **prep pass at add time** — `trac add --prep` (auto-suggested when the spec
      contains URLs): a short, budget-capped headless run *right now* that snapshots
      everything the task needs into `~/.trac/specs/<task-id>/` — URLs fetched,
      assets downloaded, a written SPEC.md with acceptance criteria. Fails loudly
      at queue time instead of silently at 3am.
- [ ] **spec folder auto-injection** — if `~/.trac/specs/<task-id>/` exists,
      dispatch prepends "read SPEC.md in <dir> first" to the task prompt.
- [ ] later: source-specific enrichers (Figma MCP, error-log gathering for bug
      tasks, repo-context summaries).

## M3.6 — Session handoff ("send my session to trac")
The runner stops being only for specs: the conversation you were in becomes the task.
- [x] **pause and resume** — a run that dies to the window limit pauses instead of
      failing; the daemon resumes the same Claude session (`--resume`) when the
      reserve fits, three pauses max, uncommitted work checkpointed on the branch
- [x] **adopt / release** — `trac adopt` takes an interactive session over as a
      forked copy (the original is never written to); `trac release` hands it back
      with the `claude --resume` command; `/trac` slash command, or
      `! trac adopt $CLAUDE_CODE_SESSION_ID` once the limit has hit
- [x] **auto-continue** — an adopted session runs under the normal gates, in the
      user's working tree; limit, time slice and turn budget all pause rather than fail
- [ ] later: auto-adopt (opt-in per repo: a session that hits the limit there is
      picked up without a handoff)

## M4 — Distribution
- [ ] **compiled no-Node binary** (`bun build --compile`) — removes the Node 18+ ask
- [ ] **Linux/Windows** — credentials paths + notification equivalents
- [ ] **Tauri popover app** — the real menu-bar product (HTML popover), replaces tracbar

## M5 — Team tier (the business)
- [ ] per-seat utilization dashboard, shared backlog routed to surplus windows,
      org-level waste number
- [ ] opt-in anonymous cap benchmarking (the public "actual Claude limits" dataset)

## Pricing sketch
Free: gauge + status/report. Paid (~$5–10/mo): warnings, right-sizing, digest,
coaching. Pro (~$15–20/mo): scheduler + execution. Team: per-seat.
