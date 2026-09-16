# Trac

See how much of your Claude subscription you actually use, and put the idle part to work.

Trac reads your local Claude Code transcripts (`~/.claude/projects/**/*.jsonl`) and the same
usage endpoint Claude Code's `/usage` command reads, then shows you the current 5-hour
window, the week, and how much of your plan went unused. A built-in task runner can queue
work and dispatch it into idle quota while you are away.

Nothing leaves your machine except the usage call to Anthropic. No dependencies, no build step.
MIT, from the team behind [Bubbl](https://bubblai.com).

## Getting started, step by step

Each step is one command and what you should see. The sections after this one are the
reference for every flag.

1. **Install Node 18 or newer** if `node --version` fails. Homebrew works; so does the
   no-admin tarball under Requirements below.

2. **Get Trac and take a first look.**

   ```sh
   git clone https://github.com/bubbl-ai/trac.git ~/trac
   cd ~/trac && npm link
   trac status
   ```

   You should see your plan, the current 5-hour window and the week as bars, and the burn
   rate. macOS may ask once whether Trac can read Claude Code's Keychain entry. Allow it,
   or the numbers fall back to estimates.

3. **See where your week went.** `trac report` shows the last 14 days and how many windows
   went unused. `trac report --days 30` for a month.

4. **Put the gauge in the menu bar.**

   ```sh
   cd ~/trac/menubar && swiftc -O tracbar.swift -o tracbar && ./tracbar &
   ```

   A colored dot with the session percentage appears within a few seconds. Click it for
   the week and the reset times. The Menu bar section below covers starting it at login.

5. **Queue a first task, read-only.**

   ```sh
   trac add "review the error handling in src/ and list what would break under load" --repo ~/proj --analyze
   trac tasks
   ```

   `--analyze` means the run writes a report instead of changing code, which is the right
   first task while you decide how much to trust the runner.

6. **Run it once by hand, while you watch.**

   ```sh
   trac run t1
   trac morning
   ```

   The run happens in a worktree under `~/.trac/work/t1` on a branch named `trac/t1-...`.
   Your working tree is not touched. `trac morning` shows what it did and the command to
   review the branch. For an analysis task the report is under `~/.trac/reports/`.

7. **Turn on the scheduler.**

   ```sh
   trac daemon
   ```

   From now on, every 15 minutes, Trac runs the next queued task if the live gauge is
   readable, the session window plus the task's budget is under 75%, the week is under
   90%, and you have been idle 15 minutes. Queue tasks with `trac add` in the evening and
   read `trac morning` the next day. `trac daemon uninstall` turns it off.

8. **Hand a session over when you hit the wall.** Inside a Claude Code session that just
   hit the limit, or one you have to leave:

   ```
   /trac
   ```

   or, once Claude can no longer respond, run the shell directly from the prompt box:

   ```
   ! trac adopt $CLAUDE_CODE_SESSION_ID
   ```

   Install the `/trac` command once with `cp ~/trac/commands/trac.md ~/.claude/commands/`.
   Then leave that session. Trac continues a forked copy after the reset, in your working
   tree, and `trac morning` gives you `claude --resume <id>` to pick the conversation back
   up with everything it did in context. `trac release t3` takes it back any time.

9. **Let Trac pick sessions up on its own** in the repos where you want that:

   ```sh
   trac watch ~/proj
   ```

   Any session started there that is active when the window caps is adopted
   automatically and continued after the reset. If you carry on in the original session
   yourself, Trac notices and lets go. `trac unwatch ~/proj` stops it.

10. **Undo anything.** `trac rm t3` deletes a task and its worktree, `trac release t3`
    hands a session back, `trac unwatch` stops automatic pickup, `trac daemon uninstall`
    stops the scheduler, and deleting `~/.trac` resets Trac entirely.

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
git clone https://github.com/bubbl-ai/trac.git ~/trac
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
trac run t3 --fresh        # start a paused or failed task over, discarding its session and branch
trac morning               # what finished while you were away, marked as read
trac ui                    # browser dashboard at http://localhost:7433
trac sessions              # recent Claude Code sessions in this directory (--all for every project, -n 20 for more)
trac adopt <session-id>    # hand an interactive session to trac, see below
trac release t3            # take it back; prints the command to continue it yourself
trac watch [path]          # pick up any session here that hits the limit, without a handoff
trac unwatch [path]        # stop that; trac watch --list shows what is watched
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
or merge, revert, defer, requeue, start over and discard it from the dashboard.

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

### Running out of quota mid-task

A task that dies because the 5-hour window ran out is **paused**, not failed. Trac keeps
its worktree and branch, commits any edits the agent left uncommitted as a checkpoint,
and remembers the Claude session. When the window resets and the reserve gate fits
again, the daemon resumes paused tasks ahead of new ones by continuing that same session
with `claude --resume`, so the agent picks up its own conversation and the commits it
already made rather than starting over. `trac tasks` shows a paused task as ◔ with its
attempt count. A task paused three times and still not done is marked failed.

Trac detects the pause two ways: the run's error text names a usage or rate limit, or the
live gauge reads capped right after a failure. A task interrupted because you came back
to the keyboard, or one that failed for any other reason, is not resumed automatically,
but retrying it with `trac run` or the dashboard's Resume button continues the same
session too. `trac run <id> --fresh` or the dashboard's Start over button discards the
session and the branch and begins again from the spec.

## Handing a session to Trac

An interactive Claude Code session that hit the limit, or that you have to walk away
from, can be handed to Trac. Trac continues it unattended under the same gates as any
task, and hands it back whenever you want it.

From inside the session, while Claude can still respond, type `/trac`. Install that
command once with:

```sh
cp commands/trac.md ~/.claude/commands/
```

If the limit has already hit and Claude cannot respond, run the shell directly from the
prompt box instead:

```
! trac adopt $CLAUDE_CODE_SESSION_ID
```

Or from any terminal: `trac sessions` lists recent sessions for the current directory
with their titles, and `trac adopt <id>` takes one. Add `--note "..."` to tell the
continuation what to focus on.

What happens next:

- **Trac forks the conversation.** Your original session is never written to. Trac's
  copy gets its own id. Leave the interactive session once you have handed it off,
  because anything you type there continues the old copy, not Trac's.
- **The daemon continues the fork** when the window has room and you have been idle
  15 minutes, with `claude --resume`, telling it the person had to stop and it should
  finish the task. This runs in your working tree, not a worktree, because that is
  what the conversation is about. It is told not to push, and not to commit unless
  the conversation already asked for that.
- **It pauses instead of failing** when the run hits the limit again or its 30 minute
  slice or turn budget ends, and continues in the next slice with room, up to three
  pauses.
- **The morning report** shows what it did and the command to pick the conversation
  up yourself, `claude --resume <id>`, with all of Trac's work in context.

`trac release <id>` takes a session back at any time. If it is running, the run is
stopped first. The dashboard's Release button does the same.

### Picking sessions up automatically

`trac watch` marks the current directory, or a path, as one where a session that runs
into the window limit should be picked up without a handoff. The daemon does not need
the limit message for this: on any tick where the live gauge reads capped, every
session started in a watched directory that was active in the last 30 minutes is
adopted, with a notification naming the task, and continued after the reset exactly
as a handed-off session would be. `trac unwatch` stops it and `trac watch --list`
shows what is watched. Nothing watches until the daemon is installed.

Because nobody said "take this", Trac is careful about one thing: if you carry on in
the original session yourself, Trac lets go. Before every run it counts your prompts
in the original transcript, and in its own copy. If the original has a new prompt
from after the session became usable again, or its copy has one it did not write,
the task ends as failed with a note saying so, and nothing runs. The same rule
protects sessions you handed over with `trac adopt`. A prompt typed while the window
was still capped could not have been answered, so it does not count.

A session you took back with `trac release`, `trac rm` or the dashboard is never picked
up again on its own. Handing it over explicitly with `trac adopt` clears that.

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
per-task reports, prepared spec folders, worktrees, the watched directories
(`config.json`) and the sessions you took back (`state.json`). Delete the directory to
reset.

## Caveats

- The usage endpoint is unofficial. When it fails, Trac serves the last good reading for
  up to 15 minutes, then falls back to transcript estimates.
- The runner spends your subscription quota. Set budgets you are comfortable losing to an
  unattended run, and start with `--analyze` tasks until you trust the output.
- An adopted session edits your working tree, unlike a spec task. Hand over sessions whose
  work you would be happy to find half done in the morning, and commit or stash anything
  unrelated first.
- Transcripts are parsed on every command, which takes under a second for a few weeks of
  history.
