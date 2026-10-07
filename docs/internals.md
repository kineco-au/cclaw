# cclaw internals

A Claude-Code-shaped terminal agent. Our own TUI, ported from OpenClaw (MIT),
driving `cursor-agent acp` over the Agent Client Protocol. Bun + TypeScript.

**Cursor is the model backend**, so work executes and bills through Cursor.
OpenClaw is a reference implementation we ported from, **not a dependency**.

## The other documents

| Working on                                                        | Read                                             |
| ----------------------------------------------------------------- | ------------------------------------------------ |
| ACP, streaming, session updates, tool calls, Cursor CLI behaviour | [`cursor-acp.md`](cursor-acp.md)                 |
| Permissions, grants, exec policy, anything security-shaped        | [`policy-and-consent.md`](policy-and-consent.md) |
| Writing or running tests, or finishing a change                   | [`testing.md`](testing.md)                       |
| Parallel subagents (designed, not built)                          | [`subagents-design.md`](subagents-design.md)     |
| How cclaw talks to Cursor, as a diagram                           | [`architecture.html`](architecture.html)         |

## Layout

```
src/
  cli.ts              entrypoint, arg dispatch only
  env.ts              Paths / ProfilePaths, name validation
  profile.ts          profile creation, launchEnv
  cursor.ts           binary resolution, status/about probes
  models.ts           catalogue parsing, derived context window
  acp/client.ts       our ACP client over the official SDK
  policy/             exec policy, approval store, resolver
  commands/           doctor setup profile model grant goal loop print raw
  tui/                our app + ported view layer
  tui/view/           ported OpenClaw components
  vendor/             copied verbatim, excluded from fmt + lint
reference/            gitignored clones, read-only, never imported
docs/                 design notes
```

## What is ours, ported, or vendored

- **Ours**: everything in `src/` except `src/vendor/` and `src/tui/view/`.
- **Ported** (`src/tui/view/`, `src/policy/`): adapted from OpenClaw with a
  header naming the upstream source. MIT, attributed in
  `THIRD-PARTY-NOTICES.md` and `PROVENANCE.md`.
- **Vendored** (`src/vendor/`): copied verbatim, refreshed by
  `scripts/vendor-openclaw.sh`. **Excluded from prettier and lint so refreshes
  stay clean diffs — never reformat it.**

## The seams that matter

| Seam                  | Where                               | Why it matters                                                                                    |
| --------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| Backend contract      | `src/tui/contract.ts`               | The ~35-method `TuiBackend` the view expects. Adapt to it; never `as`-cast over it.               |
| ACP ingest            | `src/tui/acp-backend.ts` `ingest()` | Every `session/update` enters here. Handles 6 of 19 kinds — see [`cursor-acp.md`](cursor-acp.md). |
| Stream rendering      | `src/tui/stream-render.ts`          | Chunks and tool events → chat-log calls. Pure, testable.                                          |
| Permission resolution | `src/policy/resolver.ts`            | Only `askUser` differs between hosts. See [`policy-and-consent.md`](policy-and-consent.md).       |
| Profile policy        | `src/policy/profile-policy.ts`      | Shared by `chat` and `-p`. One implementation, deliberately.                                      |

## Hard-won rules

1. **No suppressing `as` casts.** Two real bugs hid behind them (a stringified
   `contextWindow`, a `CommandEntry` missing required fields). Adapt to the
   contract instead.
2. **Path-alias imports must not carry a `.ts` suffix** — the mapping appends
   it. Relative imports must.
3. **Extract logic out of closures before testing it.** The `PromptEditor` bug
   survived eight passing tests because every one exercised the wrong case.
   `stream-render.ts` exists for this reason.
4. **Never invent a number.** Where a context window cannot be derived, report
   unknown. See [`cursor-acp.md`](cursor-acp.md).
5. **Live-test anything user-facing.** Every significant bug in this project
   was found by running it under a PTY, not by tests.

## Docs

| Document                   | Covers                                             |
| -------------------------- | -------------------------------------------------- |
| `README.md`                | user-facing behaviour, commands, known limitations |
| `docs/architecture.html`   | all five Cursor integration channels               |
| `docs/subagents-design.md` | parallel subagents — designed, not built           |
| `PROVENANCE.md`            | upstream commits for vendored and ported files     |

## Commands

```bash
bun run cclaw <args>    # run from source
bun run check           # the gate — see [testing.md](testing.md)
bun run build           # standalone binary to dist/cclaw
```
