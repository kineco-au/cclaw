# cclaw

A Claude-Code-shaped terminal agent that runs on the **Cursor CLI**.

The terminal UI is ported from [OpenClaw](https://github.com/openclaw/openclaw)
(MIT) and driven over the [Agent Client Protocol](https://agentclientprotocol.com)
by `cursor-agent acp`, so work executes and bills through your Cursor account.

```
./install.sh          # check dependencies, sign in, seed policy
cclaw                 # start the chat TUI
cclaw raw             # Cursor's own TUI under a cclaw profile
cclaw doctor           # diagnose dependencies, auth, sandbox and policy
```

## Commands

| Command                                                             | What it does                                                                                 |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `cclaw` / `cclaw chat`                                              | the chat TUI (our UI, Cursor over ACP); `/compact` summarises a long session                 |
| `cclaw raw [-- …]`                                                  | Cursor's own TUI under a cclaw profile. **The only mode with a live context-window figure.** |
| `cclaw setup`                                                       | create the profile and seed its policy; safe to re-run                                       |
| `cclaw doctor [--deep]`                                             | dependencies, ACP, auth, plan tier, sandbox support, hook sources                            |
| `cclaw profile list\|create\|use\|show\|delete\|cred`               | profiles                                                                                     |
| `cclaw model list [--all]\|config <spec>\|use <id>\|info`           | curate and switch models                                                                     |
| `cclaw grant list\|add\|rm\|block\|prune`                           | tool consent                                                                                 |
| `cclaw goal show\|set\|clear`                                       | a standing objective, injected as a Cursor rule                                              |
| `cclaw loop [prompt] [--every 5m] [--max N] [--budget 2h] [--once]` | unattended iteration                                                                         |

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

**1. No context-window figure in `cclaw chat`.** Cursor exposes
`context_window_size` only through its `statusLine`, which exists inside its own
TUI. Over ACP no token, usage or context field appears in any event, and none is
advertised in `agentCapabilities`. So `cclaw chat` shows `ctx unknown`, and
`cclaw raw` shows the real figure. Where a window size can be _derived_ (the
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

Licensing: cclaw is MIT. See `THIRD-PARTY-NOTICES.md`.
