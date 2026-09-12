# Trac

See how much of your Claude subscription you actually use — and what goes to waste.

Parses your local Claude Code transcripts (`~/.claude/projects/**/*.jsonl`).
Nothing leaves your machine. No dependencies, no build step.

```sh
node trac.js status            # current 5h window: spend, burn rate, projection
node trac.js report            # last 14 days: daily usage + unused-capacity estimate
node trac.js report --days 30
```

Or link it: `npm link` → `trac status`.

## How the numbers work

- **Spend** is weighted by API-equivalent pricing per model (cache reads count
  ~10x cheaper than fresh input, matching how quota weighs them). It's a
  consistent yardstick, not a bill.
- **Windows** follow the subscription's rolling 5-hour quota window: a window
  opens (floored to the hour) at your first message and lasts 5 hours.
- **Capacity** is estimated from your own busiest window — Anthropic doesn't
  publish exact plan caps, so utilization is relative to your demonstrated peak.

## Roadmap (deliberately not in the MVP)

Task backlog → idle-time scheduler → headless `claude -p` dispatch → morning
report. The tracker has to earn trust first.

## Menu bar (macOS)

An always-visible gauge — session quota % in the menu bar, refreshed every 60s.

```sh
cd menubar && swiftc -O tracbar.swift -o tracbar && ./tracbar &
```

🟢 <50% · 🟠 50–80% · 🔴 ≥80%. Click for details (week, resets, burn). Quit from the menu.

**Auto-start on login:** copy `menubar/com.trac.menubar.plist` to
`~/Library/LaunchAgents/` (edit the binary path for your username), then
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.trac.menubar.plist`.
Remove with `launchctl bootout gui/$(id -u)/com.trac.menubar`.

## Background tasks (M3)

```sh
trac add "write tests for X" --repo ~/proj [-p 1] [--budget 25] [--analyze] [--push] [--pr] [--prep]
trac tasks                  # queue + results
trac run [id] [--dry]       # manual dispatch
trac daemon                 # install the scheduler (launchd, every 15 min)
trac morning                # what got done while you were away
```

**`--prep`** runs a short headless pass right after queueing that snapshots
everything the task needs into `~/.trac/specs/<id>/` — it fetches any URLs in the
spec, saves their assets, and writes a self-contained `SPEC.md` (with concrete
acceptance criteria and any OPEN QUESTIONS up top). The later unattended run
reads that folder first and treats it as authoritative, so an overnight task
never depends on a URL still being reachable. `trac rm` cleans the folder up.
Add a spec with a URL but no `--prep` and trac reminds you to consider it.

The scheduler dispatches only when ALL gates pass: live quota readable, session
under the 75% reserve (incl. task budget), week under 90%, and you idle 15+ min.
Tasks run headless in a git worktree (`~/.spare/work/<id>`) on a `spare/<id>-*`
branch — your working tree and history are never touched; nothing is pushed
unless the task was created with `--push`/`--pr` (draft PRs only). A task is
killed if you become active, and hard-capped at 30 min.
