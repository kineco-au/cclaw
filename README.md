# cclaw

A Claude-Code-shaped terminal agent that runs on the **Cursor CLI**.

The terminal UI is ported from [OpenClaw](https://github.com/openclaw/openclaw)
(MIT) and driven over the [Agent Client Protocol](https://agentclientprotocol.com)
by `cursor-agent acp`, so work executes and bills through your Cursor account.

```
./install.sh          # check dependencies, sign in, seed policy
cclaw                 # start the chat TUI
cclaw raw             # Cursor's own TUI under a cclaw profile
cclaw doctor          # diagnose dependencies, auth, sandbox and policy
./install.sh --help   # installer options, including --uninstall
```

## Commands

| Command                                                             | What it does                                                                                 |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `cclaw` / `cclaw chat`                                              | the chat TUI (our UI, Cursor over ACP)                                                       |
| `cclaw -p "<prompt>"`                                               | headless: one prompt, reply on stdout                                                        |
| `cclaw raw [-- …]`                                                  | Cursor's own TUI under a cclaw profile. **The only mode with a live context-window figure.** |
| `cclaw setup`                                                       | create the profile and seed its policy; safe to re-run                                       |
| `cclaw doctor [--deep]`                                             | dependencies, ACP, auth, plan tier, sandbox support, hook sources                            |
| `cclaw profile list\|create\|use\|show\|delete\|cred`               | profiles                                                                                     |
| `cclaw model list [--all]\|config <spec>\|use <id>\|info`           | curate and switch models                                                                     |
| `cclaw grant list\|add\|rm\|block\|prune`                           | tool consent                                                                                 |
| `cclaw goal show\|set\|clear`                                       | a standing objective, injected as a Cursor rule                                              |
| `cclaw loop [prompt] [--every 5m] [--max N] [--budget 2h] [--once]` | unattended iteration                                                                         |

## Slash commands

Type `/` for the list; Tab completes names and arguments. Three sources are
merged, and ours win a name collision so `/model` always stays the switcher:

| Source   | Where it comes from                                                                                                        |
| -------- | -------------------------------------------------------------------------------------------------------------------------- |
| built in | cclaw itself: `/model` `/mode` `/compact` `/resume` `/thinking` `/goal` `/loop` `/usage` `/grant` `/clear` `/help` `/exit` |
| your own | one markdown file per command in `<profile>/commands/`                                                                     |
| Cursor's | whatever the session advertises, currently 39                                                                              |

A command of your own is a markdown file whose body is the prompt:

```markdown
---
description: review the staged diff
argument-hint: [path]
---

Review $ARGUMENTS and list only real defects.
```

`$ARGUMENTS` takes everything after the command, `$1`…`$9` take single words,
and a template with no placeholder gets the arguments appended. An unfilled
placeholder takes its preceding space with it, so a bare `/review` reads as a
sentence. Cursor's own commands are forwarded verbatim for Cursor to parse.

## Watching the work

Tool calls render as they run: the command or file, then its output, with
failures marked. `/thinking on` additionally streams the model's reasoning,
which is off by default because it is long and usually noise. Reasoning streams
either way; only rendering is optional.

Diffs are summarised as `path +added -removed` rather than rendered in full.

## Resuming

Every turn is appended to `<profile>/sessions/<id>.jsonl`, so a conversation
survives leaving the TUI. `/resume` lists what is saved and `/resume 2` reopens
one.

Resume does **not** depend on Cursor restoring its own session, because it will
not. Cursor advertises `loadSession: true` and writes a session record under
`CURSOR_CONFIG_DIR/acp-sessions/<id>/meta.json`, but that record holds only
`{schemaVersion, cwd, title}` — no conversation — and `session/load` answers
`Session "<id>" not found` for ids Cursor itself wrote. So cclaw tries the
native path, and when it is refused falls back to replaying its own transcript
into a fresh session as carried context. It says which happened. The transcript
is ours on disk either way; the difference is whether the model remembers it or
is reading it.

## Headless runs

`cclaw -p` runs one prompt without a TUI, for pipes, scripts and CI:

```sh
cclaw -p "what changed in src since the last tag?"
cclaw -p fix the failing test          # quoting is optional
git diff | cclaw -p "review this diff"  # a piped prompt works too
cclaw -p --json "list the TODOs"       # machine-readable
cclaw -p -r 1 "and now fix them"       # carry the last session's context
```

`text` output is the reply alone, so it pipes cleanly; everything else goes to
stderr. `--json` adds the session id, `stopReason`, the tool calls made, and
any permission requests that were refused.

Exit codes are `0` on success, `2` for a usage error, and `1` when the agent
errored, replied with nothing, or **was refused by the plan** — Cursor streams
"Upgrade your plan to continue" as an ordinary reply with
`stopReason: "end_turn"`, so without that check a scripted run would exit 0 on
a non-answer.

Nobody is present to answer a permission prompt, so consent is declined and
reported rather than waited on, exactly as in `cclaw loop`. Allowlisted
commands and grants added with `cclaw grant add` still run — the same policy
and the same approval store as the TUI, not a second set of rules.

Every headless turn is recorded to the session store, so a scripted run can be
picked up afterwards with `/resume` in the TUI.

## Context and compaction

Context lives inside Cursor's ACP session: cclaw sends only your latest message
and Cursor keeps the thread. So cclaw cannot trim the window, measure it, or
inspect it — and because ACP reports no token usage, the footer says
`ctx unknown`.

`/compact` is the one lever that works within that. It asks the model to
summarise the session **while it still has it**, starts a fresh session, and
carries the summary into your next message rather than spending a turn on it.
The footer shows `summary pending` until it goes out.

```
/compact                        # summarise everything
/compact keep the migration     # weight the summary towards one thread
/clear                          # the blunt instrument: total amnesia
```

**Compaction refuses rather than risks losing context.** A reply too short to be
a summary leaves the session exactly as it was and shows you what came back.
This is not defensive paranoia: a plan-gated turn streams
`Upgrade your plan to continue` as ordinary assistant prose and then reports
`stopReason: "end_turn"`, so neither the protocol nor the transcript marks it as
a failure. Without the check, that sentence would replace your whole session.

## While a turn is running

Type anyway — messages are **queued** and sent in order when the turn ends,
rather than being dropped. The footer shows how many are waiting.

**Esc cancels**, escalating one step per press so each has a predictable effect:

| State                                  | Esc does                                       |
| -------------------------------------- | ---------------------------------------------- |
| a permission prompt is open            | denies it **and** stops the turn it belongs to |
| a turn is running                      | stops it                                       |
| already stopping, or idle with a queue | discards the queued messages                   |
| idle and empty                         | nothing                                        |

Work queued behind a cancelled turn is discarded, not run: it was typed
expecting the earlier turn to proceed.

## Profiles

A profile is isolation through two environment variables Cursor honours. The
split is not what the names suggest, and is undocumented upstream:

| Variable            | Holds                                                         |
| ------------------- | ------------------------------------------------------------- |
| `CURSOR_CONFIG_DIR` | `cli-config.json`, `permissions.json`, **`chats/`**, `rules/` |
| `CURSOR_DATA_DIR`   | **`projects/`**                                               |

```
cclaw profile create work
cclaw --profile work chat
```

**Credentials are the limit of that isolation.** On macOS the Cursor web login
lives in a single global keychain slot (`cursor-access-token`) and its auth file
path ignores `CURSOR_CONFIG_DIR`, so every profile using the shared login has the
_same identity_. For a genuinely separate identity, give the profile its own key:

```
printf %s "$CURSOR_API_KEY" | cclaw profile cred set work
```

`cclaw profile show` always states which of the two a profile is using.

## Policy and consent

Defaults aim at Claude Code parity: a workspace-scoped sandbox, `allowlist`
approvals that ask on a miss, a 16-entry allowlist where **nothing takes an
arbitrary path**, and a 39-entry denylist covering credentials and system paths.

Sensitive commands (`aws`, `kubectl`, `terraform`, `gcloud`, …) always require
consent, even if allowlisted. In the TUI:

```
Permission needed: `aws sts get-caller-identity` — 'aws' is a sensitive command
  1. Allow once — just this command
  2. Allow this session — every 'aws' until this session ends
  3. Allow always — every 'aws' in this directory, permanently
  4. Reject — refuse this command
permission  1 Allow once   2 Allow this session   3 Allow always   4 Reject
```

The four choices are ours, not Cursor's: cclaw renders the prompt and maps your
choice onto whichever option Cursor advertised. **"Allow always" is permanent**
— it records a profile grant and tells Cursor to remember it too. **"Allow this
session"** is cleared when the session ends.

The same grants can be managed from the CLI:

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

## Known limitations

These are properties of the Cursor CLI, established by testing against it, not
things left unfinished.

**1. No context-window figure in `cclaw chat`.** Not an ACP limitation, as
earlier versions of this file claimed: the protocol defines a `usage_update`
event carrying exactly `{used, size, cost}`. **This Cursor build never sends
one.** It negotiates protocol v1 while the SDK is v2, which is the likely
reason, and it advertises nothing for usage in `agentCapabilities`. cclaw does
not yet read the event, since nothing has ever sent one. `context_window_size` is
reachable only through Cursor's `statusLine`, which exists inside its own TUI,
so `cclaw chat` shows `ctx unknown` and `cclaw raw` shows the real figure. Where a window size can be _derived_ (the
model name encodes `1M`, or a `context=` parameter is set) `cclaw model info`
reports it and labels it as derived. It is never invented.

**2. File reads cannot be confined to the working directory.** Shell commands can
be gated, prompted and denied. File reads cannot:

- `sandbox.mode: enabled` with `readBoundary: workspace` does not confine them
- a global `~/.cursor/sandbox.json` with `type: workspace_readwrite` does not either
- `Read(/**)` as a deny _does_ confine them, but also blocks the workspace, since
  workspace paths are absolute and deny beats allow — so no carve-out is expressible
- **Cursor's own non-ACP path behaves identically**, so `cclaw raw` is no different

The mitigation is an explicit denylist of the locations that matter (`/etc`,
`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/Library/Keychains`, `**/.env`, `**/*.pem`, …).
That is defence in depth, **not a boundary**: any path not listed is readable.

**3. Our consent layer is UX, not a sandbox.** `bash -c '…'` and shell aliases
can evade name matching. The policy refuses what it cannot parse — command
substitution, backticks, `eval`, and a wrapper whose next token is an option
(`nice -n5 kubectl`, where naming the flag would miss `kubectl`). Cursor's own
sandbox and `permissions.deny` are the real boundary.

**4. Free plans can only use `auto`.** Named models are rejected with
`ActionRequiredError: Named models unavailable`. `cclaw model list` marks the
rest `[plan]` rather than listing ~250 models you cannot run.

**5. Unattended loops refuse all permissions.** Nobody is present to answer, so
`cclaw loop` declines tool requests and reports what it would need. Every loop
has a hard iteration count and a wall-clock budget.

## Uninstalling

```sh
./install.sh --uninstall           # remove the cclaw command
./install.sh --uninstall --purge   # also remove profiles and credentials
```

`--uninstall` removes the `~/.local/bin/cclaw` link and nothing else, then
prints what it left behind. Your profiles, grants, goals and session history
survive, so reinstalling picks up where you were.

`--purge` additionally deletes `~/.cclaw` (honouring `CCLAW_HOME`) and the
`cclaw` keychain entries holding per-profile API keys. It lists exactly what
will go and asks first; `--yes` skips the confirmation for scripted runs.
**This destroys data** — session transcripts, grants and goals are not
recoverable.

Two things it deliberately will not do:

- **Remove a command link belonging to another checkout.** It only deletes
  `~/.local/bin/cclaw` when that link points at _this_ directory, or when it
  dangles because the checkout moved. Otherwise it says so and leaves it.
- **Uninstall Bun or the Cursor CLI.** Those are installed by their own
  vendors, not by this script, and other tools may depend on them.

The checkout itself is never touched. Delete the directory by hand when you
want it gone.

## Development

```
bun run check     # prettier + shellcheck/shfmt + tsc + tests  (the gate)
bun run build     # compile a standalone binary to dist/cclaw
```

`src/vendor/` is copied verbatim from upstream and excluded from formatting and
linting, so refreshes stay clean diffs — see `scripts/vendor-openclaw.sh` and
`PROVENANCE.md` for the exact commits. Ported files carry a header naming their
upstream source; `src/tui/view/shims/` holds adapters where upstream's logic
assumed OpenClaw concepts Cursor does not have.

Design notes live in `docs/`:

| Document                   | What it covers                                            |
| -------------------------- | --------------------------------------------------------- |
| `docs/architecture.html`   | how cclaw talks to Cursor — all five integration channels |
| `docs/subagents-design.md` | implementation design for parallel subagents (not built)  |

Licensing: cclaw is MIT. See `THIRD-PARTY-NOTICES.md`.
