# Trac

See how much of your Claude subscription you actually use, and put the idle part to work.

Trac reads your local Claude Code transcripts (`~/.claude/projects/**/*.jsonl`) and the same
usage endpoint Claude Code's `/usage` command reads, then shows you the current 5-hour
window, the week, and how much of your plan went unused. A built-in task runner can queue
work and dispatch it into idle quota while you are away.

Nothing leaves your machine except the usage call to Anthropic. No dependencies, no build step.

## Requirements

- macOS. The live quota lookup reads your Claude Code token from the Keychain, and the menu
  bar and idle detection are Mac-only.
- Node 18 or newer. If you cannot use Homebrew, the official tarball works from your home
  directory with no admin rights:

  ```sh
  mkdir -p ~/.local/node && cd ~/.local/node
  curl -fsSL https://nodejs.org/dist/v22.19.0/node-v22.19.0-darwin-arm64.tar.xz | tar -xJ --strip-components=1
  echo 'export PATH="$HOME/.local/node/bin:$PATH"' >> ~/.zshrc
  ```

- Claude Code installed and signed in. The task runner shells out to `claude -p`.

## Install

```sh
git clone git@github.com:ArcherX0X/trac.git ~/trac
cd ~/trac && npm link        # puts `trac` on your PATH
trac status
```

`npm link` is optional. `node ~/trac/trac.js status` does the same thing.

The first live quota call may raise a macOS Keychain prompt asking to allow access to
Claude Code's credentials. Allow it once. If you decline, Trac falls back to estimates from
your transcripts.

## Usage tracking

```sh
trac status              # current 5h window and week, burn rate, plan
trac report              # last 14 days, day by day, with the unused-capacity estimate
trac report --days 30
trac export --days 30    # JSON: per day, per window, per model
trac json                # one-line JSON snapshot, what the menu bar reads
```

How the numbers work:

- **Spend** is weighted by API-equivalent pricing per model. Cache reads count about a
  tenth of fresh input, which matches how quota weighs them. It is a consistent yardstick,
  not a bill. You pay flat.
- **Session and week** come from the live endpoint when it is reachable, cached to
  `~/.trac/quota.json` so every Trac process together makes at most one call a minute.
- **Capacity** is calibrated from the live cap when available, otherwise from your own
  busiest 5-hour window. Anthropic does not publish exact plan caps, so utilization is
  relative to your demonstrated peak.

## Task runner

Queue work now, let it run when your quota would otherwise sit idle.

```sh
trac add "write tests for the vendor score reader" --repo ~/proj
trac tasks                 # the queue and results
trac rm t3                 # delete a task, its prep folder, and its worktree
trac run                   # run the next runnable task now, ignoring the idle gate
trac run t3                # run a specific task
trac run t3 --dry          # exercise the worktree flow without calling Claude
trac morning               # what finished while you were away, marked as read
trac ui                    # browser dashboard at http://localhost:7433
```

Flags for `trac add`:

| Flag | Default | Meaning |
|---|---|---|
| `--repo <path>` | current directory | Must be a git checkout |
| `-p N` | 2 | Priority. Lower runs first |
| `--budget N` | 25 | Percent of a 5-hour window the task may spend |
| `--analyze` | off | Read-only. Writes findings to `REPORT.md` instead of changing code |
| `--push` | off | Push the result branch when done |
| `--pr` | off | Push and open a draft PR (implies `--push`) |
| `--prep` | off | Run a short Claude pass now that snapshots the spec's URLs and assets into `~/.trac/specs/<id>/`, so the later run never depends on a URL being reachable |

Every task runs headless in its own git worktree at `~/.trac/work/<id>` on a branch named
`trac/<id>-<slug>`, cut from the repo's default branch. Your working tree and history are
never touched. Nothing is pushed unless the task was added with `--push` or `--pr`, and PRs
are always drafts. When a task finishes, review it with the command `trac morning` prints,
or merge, revert, defer, requeue and discard it from the dashboard.

### The scheduler

```sh
trac daemon               # install a launchd agent that checks every 15 minutes
trac daemon uninstall
```

The daemon dispatches one task only when every gate passes:

- the live quota is readable
- the session window plus the task's budget stays under a 75% reserve
- the week is under 90%
- you have been idle for 15 minutes or more

A running task is killed the moment you become active and is hard-capped at 30 minutes.
`trac run` bypasses the idle gate and warns instead of refusing when a task would breach
the reserve, because you are at the keyboard to decide.

## Menu bar gauge

An always-visible session percentage, refreshed every 60 seconds.

```sh
cd menubar && swiftc -O tracbar.swift -o tracbar && ./tracbar &
```

🟢 under 50% · 🟠 50 to 80% · 🔴 80% and up. Click it for the week, reset times, burn rate
and task counts. Quit from its menu. The binary finds `trac.js` one directory above itself,
so the checkout can live anywhere.

To start it at login, edit the path in `menubar/com.trac.menubar.plist` to your compiled
binary, then:

```sh
cp menubar/com.trac.menubar.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.trac.menubar.plist
```

Remove with `launchctl bootout gui/$(id -u)/com.trac.menubar`.

## Where state lives

Everything is under `~/.trac/`, created on first run: the quota cache, the task queue,
per-task reports, prepared spec folders, and worktrees. Delete the directory to reset.

## Caveats

- The usage endpoint is unofficial. When it fails, Trac serves the last good reading for
  up to 15 minutes, then falls back to transcript estimates.
- The runner spends your subscription quota. Set budgets you are comfortable losing to an
  unattended run, and start with `--analyze` tasks until you trust the output.
- Transcripts are parsed on every command, which takes under a second for a few weeks of
  history.

## Roadmap

See [ROADMAP.md](ROADMAP.md). Tracking, warnings, the task runner and the prep pass are
built. Plan right-sizing, the weekly digest, a compiled binary and a team tier are not.
