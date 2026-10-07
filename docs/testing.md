# Testing cclaw

## The gate

```bash
bun run check
```

That is `fmt:check` (prettier) → `lint:sh` (shellcheck + shfmt) → `typecheck`
(`tsc --noEmit`) → `test` (`bun test src`). **A change is not done until this
passes.**

Current baseline: **481 tests across 22 files**. If your change drops the count,
find out why before moving on.

While iterating, run only what you touched:

```bash
bun test src/tui/sessions.test.ts
bun test src/policy           # a directory
bun run typecheck             # fastest signal on a refactor
```

Notes:

- `bunfig.toml` pins the test root to `src`, so `reference/` clones never run.
- `bun run lint` (oxlint) exists but is **not** in the gate. Run it if you want.
- `src/vendor/` is excluded from prettier and lint. **Never reformat it** — it
  is copied verbatim so refreshes stay clean diffs.
- Prettier will reformat files you create. Run `bun run fmt` or expect
  `fmt:check` to fail.

## What needs a test

New functionality in this codebase needs covering tests — that is the project
standard, not a suggestion. Markup- or docs-only changes do not.

**Do not run browser interaction tests.** Not applicable here and not wanted.

## The pattern that works here

Push logic into a pure module, test that exhaustively, then test the
integration against the **real** component.

**Why this is stated so firmly:** the `PromptEditor` bug (the autocomplete rows
being destroyed) survived **eight passing tests**, because every one of them
exercised the wrong case. The logic lived in a closure inside the app, so the
only thing testable was the wrong thing.

`src/tui/stream-render.ts` + `stream-render.test.ts` is the model to copy:

- pure helpers (`toolLabel`, `isTerminalStatus`) tested directly
- ordering logic (`StreamRouter`) tested through an injected fake sink
- **four tests against a real `ChatLog`**, asserting that tool calls actually
  become visible rows and that every rendered line respects the requested width

That last group is what proves the feature works. A fake sink proves the
ordering; only the real component proves the output.

## Injecting instead of mocking

There is no mocking framework in use. Pass the dependency in:

| Dependency             | Injected as                                      |
| ---------------------- | ------------------------------------------------ |
| a child process        | a `Runner` function returning its result         |
| a CLI (`tmux`, `cmux`) | a function taking argv, so tests assert the argv |
| the terminal           | `TuiProcessTerminal`, or a fake sink             |
| time                   | pass a `now` argument (see `newSessionId(now)`)  |

A test that needs a real directory uses `mkdtemp` in `beforeEach` and `rm` in
`afterEach` — see `sessions.test.ts` and `user-commands.test.ts`.

## Write tests that say why

Existing tests carry a one-line comment when the expectation is non-obvious,
explaining the failure it prevents. Keep this up — it is why the suite is
readable. Examples in the tree:

```ts
// Writing a result here would render a pending call as finished and empty.
// Otherwise a bare invocation reads as "Review  and list" with a gap.
// Telling the model a replayed transcript is a summary of a cleared session
// asserts two untrue things about its own history.
```

Otherwise follow the house style: no comments unless they clarify something
complex or unexpected; terse docstrings stating purpose, not implementation.

## Live testing is not optional

**Every significant bug in this project was found by running it, not by
testing it.** Tests passed in all of these cases:

| Bug                                                       | Found by   |
| --------------------------------------------------------- | ---------- |
| `/compact` cleared a live session on a plan refusal       | running it |
| `cclaw -p` exited 0 on a plan refusal                     | running it |
| `$ARGUMENTS` left a double space                          | running it |
| Footer said "summary pending" for a transcript            | running it |
| `tui.setFocus(editor)` missing — editor got no keystrokes | running it |

For the TUI, drive it under a PTY. Minimal harness:

```python
import os, pty, select, time
pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.execvp("bun", ["bun", "run", "src/cli.ts", "chat"])
out = b""; deadline = time.time() + 14; sent = False
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.4)
    if r:
        try: out += os.read(fd, 65536)
        except OSError: break
    if not sent and b"ready" in out:
        os.write(fd, b"/resume\r"); sent = True
os.write(fd, b"\x03")
print(out.decode("utf8", "replace")[-2000:])
```

Put it in the scratchpad directory, not the repo. Strip ANSI with
`re.sub(r"\x1b\[[0-9;]*m", "", text)` when asserting on content.

For headless paths, just run them and check the exit code **without a pipe** —
a pipe reports the last command's status, which has masked exit codes here
before:

```bash
bun run cclaw -p "say hi" >/dev/null 2>&1; echo "exit=$?"
```

## Expect plan refusals

On a plan-restricted account every turn returns `Upgrade your plan to
continue`. You can verify wiring, rendering, exit codes, file writes and caps;
you **cannot** verify that the agent did useful work.

**Report this honestly.** Say what you verified and what you could not, rather
than implying an end-to-end pass. See [`cursor-acp.md`](cursor-acp.md) for the detail.

## Before reporting done

- [ ] `bun run check` passes, with the test count at or above baseline
- [ ] new behaviour has covering tests, including one against the real
      component if it touches the view
- [ ] the user-facing path was actually run
- [ ] anything unverified is stated as unverified
