# Trac — handoff

Packaged 2026-09-11 from Tony's working tree.

## What it is

A local tool that reads your Claude Code transcripts (`~/.claude/projects/**/*.jsonl`)
and tells you how much of your Claude subscription you're actually using. It also has
a background task runner that dispatches work into idle quota.

Nothing leaves your machine. No dependencies — pure Node builtins, no `npm install`.

## Run it

Requires Node >= 18 and macOS (the quota lookup and menu bar are mac-specific).

```sh
node trac.js status              # current 5h window: spend, burn rate, projection
node trac.js report              # last 14 days + unused-capacity estimate
node trac.js report --days 30
```

Optional: `npm link` to get `trac` on your PATH.

## Task runner

```sh
node trac.js add "<spec>" --repo <path>   # queue a task
node trac.js list                         # see the queue
node trac.js run                          # run the next one now
node trac.js daemon                       # scheduler: dispatches into idle quota
```

State lives in `~/.trac/` (created on first run). That directory is intentionally
NOT in this zip — it holds Tony's personal usage history, task queue, and reports.

## Menu bar (macOS)

```sh
cd menubar && swiftc -O tracbar.swift -o tracbar && ./tracbar &
```

Shows session quota % in the menu bar. 🟢 <50% · 🟠 50–80% · 🔴 ≥80%.
The compiled binary is not in this zip — build it from source with the above.
`com.trac.menubar.plist` is the launchd agent if you want it to start at login.

## Notes / caveats

- Quota "capacity" is estimated from your own busiest window — Anthropic doesn't
  publish exact plan caps, so utilization is relative to your demonstrated peak.
- It reads your Claude OAuth token from the macOS Keychain at runtime to hit the
  same usage endpoint `/usage` uses. Unofficial endpoint, best-effort, falls back
  to transcript estimates.
- `trac.js` in this zip includes work that was uncommitted in Tony's tree at
  package time (the M3.5 task-prep pass) — it's ahead of the last commit.
