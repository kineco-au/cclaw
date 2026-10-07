# cclaw

A Claude-Code-shaped terminal agent that runs on the **Cursor CLI**. Work
executes and bills through your Cursor account.

```
./install.sh          # check dependencies, sign in, seed policy
./install.sh --check  # report readiness, change nothing
cclaw                 # start the chat TUI
cclaw raw             # Cursor's own TUI under a cclaw profile
cclaw doctor          # diagnose dependencies, auth, sandbox and policy
```

Requires [Bun](https://bun.sh) and the Cursor CLI; the installer offers to set
up either if missing. The Cursor desktop app is not needed.

## Commands

| Command                                                             | What it does                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `cclaw` / `cclaw chat`                                              | the chat TUI                                                        |
| `cclaw -p "<prompt>"`                                               | headless: one prompt, reply on stdout                               |
| `cclaw raw [-- …]`                                                  | Cursor's own TUI. The only mode showing a live context-window size. |
| `cclaw setup`                                                       | create the profile and seed its policy; safe to re-run              |
| `cclaw doctor [--deep]`                                             | dependencies, ACP, auth, plan tier, sandbox, hook sources           |
| `cclaw profile list\|create\|use\|show\|delete\|cred`               | profiles                                                            |
| `cclaw model list [--all]\|config <spec>\|use <id>\|info`           | curate and switch models                                            |
| `cclaw grant list\|add\|rm\|block\|prune`                           | tool consent                                                        |
| `cclaw goal show\|set\|clear`                                       | record a standing objective, injected as a Cursor rule              |
| `cclaw loop [prompt] [--every 5m] [--max N] [--budget 2h] [--once]` | unattended iteration                                                |

## Slash commands

Type `/` for the list; Tab completes names and arguments. Three sources merge,
and cclaw's own win a name collision:

| Source   | Commands                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| built in | `/model` `/mode` `/compact` `/resume` `/thinking` `/goal` `/loop` `/usage` `/grant` `/clear` `/help` `/exit` |
| yours    | one markdown file per command in `<profile>/commands/`                                                       |
| Cursor's | its own commands, plus skills it finds in `.claude/skills/`, `.cursor/skills/` and your plugins              |

A command of your own is a markdown file whose body is the prompt:

```markdown
---
description: review the staged diff
argument-hint: [path]
---

Review $ARGUMENTS and list only real defects.
```

`$ARGUMENTS` takes everything after the command, `$1`…`$9` take single words,
and a template with no placeholder gets the arguments appended.

## Using the TUI

Tool calls render as they run — the command or file, then its output, with
failures marked. Diffs are summarised as `path +added -removed`.
`/thinking on` also streams the model's reasoning, off by default.

**Type while a turn is running.** Messages queue and send in order when the
turn ends; the footer shows how many are waiting.

**Esc cancels**, escalating one step per press:

| State                                  | Esc does                                       |
| -------------------------------------- | ---------------------------------------------- |
| a permission prompt is open            | denies it **and** stops the turn it belongs to |
| a turn is running                      | stops it                                       |
| already stopping, or idle with a queue | discards the queued messages                   |
| idle and empty                         | nothing                                        |

## Resuming

Every turn is appended to `<profile>/sessions/<id>.jsonl`, so conversations
survive leaving the TUI. `/resume` lists what is saved; `/resume 2` reopens one.

Cursor will not reopen its own sessions, so cclaw replays its own transcript
into a fresh session as context instead. It tells you which happened.

## Goals

```
/goal get the test suite green    # set it and start working toward it
/goal                             # show the current goal
/goal clear                       # remove it
/loop 5                           # work the existing goal again, 5 iterations
```

`/goal <objective>` records the goal and immediately works on it, re-prompting
until the agent reports the objective met or it reaches 20 iterations. **Esc
stops the loop**, not just the turn in flight. The footer shows the goal and the
iteration count.

It stops early and says why — goal met, cancelled, the iteration limit, or your
plan refusing the turn.

The goal is also written into the profile's Cursor rules, so it applies to
`cclaw raw` and to later sessions. `cclaw goal set` records one **without**
starting work.

## Compaction

```
/compact                        # summarise everything
/compact keep the migration     # weight the summary towards one thread
/clear                          # total amnesia
```

`/compact` asks the model to summarise the session, starts a fresh one, and
carries the summary into your next message rather than spending a turn on it.
The footer reads `summary pending` until it goes out.

If the reply is too short to be a summary, compaction refuses, leaves the
session untouched and shows you what came back.

## Headless runs

```sh
cclaw -p "what changed in src since the last tag?"
cclaw -p fix the failing test            # quoting optional
git diff | cclaw -p "review this diff"   # piped prompt
cclaw -p --json "list the TODOs"         # machine-readable
cclaw -p -r 1 "and now fix them"         # carry a prior session's context
```

Text output is the reply alone, so it pipes cleanly; diagnostics go to stderr.
`--json` adds the session id, `stopReason`, tool calls made, and any permission
requests refused.

Exit codes: `0` success, `2` usage error, `1` when the agent errored, replied
with nothing, or was refused by your plan.

Nobody is present to answer a permission prompt, so consent is declined and
reported. Allowlisted commands and grants from `cclaw grant add` still run.
Headless turns are recorded, so `/resume` picks them up later.

## Profiles

A profile isolates Cursor's config and data directories:

```
cclaw profile create work
cclaw --profile work chat
```

**Credentials are the limit of that isolation.** On macOS the Cursor web login
is a single global keychain slot, so every profile using it shares one
identity. For a separate identity, give the profile its own key:

```
printf %s "$CURSOR_API_KEY" | cclaw profile cred set work
```

`cclaw profile show` states which of the two a profile uses.

## Policy and consent

Defaults aim at Claude Code parity: a workspace-scoped sandbox, `allowlist`
approvals that ask on a miss, a 16-entry allowlist where nothing takes an
arbitrary path, and a 39-entry denylist covering credentials and system paths.

Sensitive commands (`aws`, `kubectl`, `terraform`, `gcloud`, …) always require
consent, even if allowlisted:

```
Permission needed: `aws sts get-caller-identity` — 'aws' is a sensitive command
  1. Allow once — just this command
  2. Allow this session — every 'aws' until this session ends
  3. Allow always — every 'aws' in this directory, permanently
  4. Reject — refuse this command
```

**"Allow always" is permanent** — it records a profile grant. **"Allow this
session"** is cleared when the session ends.

Grants can also be managed from the CLI:

```
cclaw grant add aws                      # this directory, any arguments
cclaw grant add aws --argv "aws s3 ls"   # exactly this command line
cclaw grant add aws --days 7             # expiring standing grant
cclaw grant rm aws                       # undo; it will prompt again
cclaw grant block aws                    # refuse without asking
cclaw grant list                         # permanent, session and blocked
```

Grants bind to the **exact command, arguments and directory**, so allowing
`aws s3 ls` in one repo never authorises `aws s3 rm` or the same command
elsewhere.

## Limits

Properties of the Cursor CLI, established by testing against it.

1. **No context-window figure in `cclaw chat`** — the footer reads
   `ctx unknown`. `cclaw raw` shows the real figure. Where a size can be
   derived from the model name, `cclaw model info` reports it and labels it
   derived; it is never invented.
2. **File reads cannot be confined to the working directory.** Shell commands
   can be gated, prompted and denied; file reads cannot. The denylist covering
   `/etc`, `~/.ssh`, `~/.aws`, `**/.env` and similar is defence in depth, not a
   boundary — any path not listed is readable. `cclaw raw` is no different.
3. **The consent layer is UX, not a sandbox.** `bash -c '…'` and shell aliases
   can evade name matching. The policy refuses what it cannot parse. Cursor's
   own sandbox and `permissions.deny` are the real boundary.
4. **Free plans can only use `auto`.** `cclaw model list` marks the rest
   `[plan]` rather than listing models you cannot run.
5. **Unattended loops refuse all permissions** and report what they would need.
   Every loop has a hard iteration count and a wall-clock budget.

## Checking without installing

```sh
./install.sh --check      # --dry-run is a synonym
```

Runs every check the installer runs and changes nothing; anything it would
otherwise offer is reported and declined. Exits `0` when cclaw could run and
`1` when something is missing.

Use it before anything is installed — `cclaw doctor` is cclaw code, so it needs
Bun and `node_modules` to run at all. Once installed, `cclaw doctor --deep`
goes further.

## Uninstalling

```sh
./install.sh --uninstall           # remove the cclaw command
./install.sh --uninstall --purge   # also remove profiles and credentials
```

`--uninstall` removes the `~/.local/bin/cclaw` link and nothing else, then
prints what it left behind, so reinstalling picks up where you were.

`--purge` additionally deletes `~/.cclaw` (honouring `CCLAW_HOME`) and the
`cclaw` keychain entries. It lists what will go and asks first; `--yes` skips
the confirmation. **This destroys data.**

It will not remove a command link belonging to another checkout, and it never
uninstalls Bun or the Cursor CLI. The checkout itself is untouched.

## Development

```
bun run check     # prettier + shellcheck/shfmt + tsc + tests  (the gate)
bun run build     # compile a standalone binary to dist/cclaw
```

`src/vendor/` is copied verbatim from upstream and excluded from formatting and
linting; see `scripts/vendor-openclaw.sh` and `PROVENANCE.md` for exact
commits. Ported files carry a header naming their upstream source.

| Document                     | What                                                         |
| ---------------------------- | ------------------------------------------------------------ |
| `docs/internals.md`          | layout, what is ours vs ported vs vendored, the seams        |
| `docs/cursor-acp.md`         | what Cursor's ACP actually does, and what it only advertises |
| `docs/policy-and-consent.md` | the exec policy and approval model, and its real boundaries  |
| `docs/testing.md`            | the gate, test patterns and live-testing harnesses           |
| `docs/architecture.html`     | how cclaw talks to Cursor — all five integration channels    |
| `docs/subagents-design.md`   | implementation design for parallel subagents (not built)     |

Licensing: cclaw is MIT. The terminal UI is ported from
[OpenClaw](https://github.com/openclaw/openclaw) (MIT) and driven over the
[Agent Client Protocol](https://agentclientprotocol.com). See
`THIRD-PARTY-NOTICES.md`.
