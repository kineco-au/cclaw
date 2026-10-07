# Subagents — implementation design

Status: **design, not built.** Feature 14 of the capability gap list.

This document is written to be executed. It states the decisions already made,
the facts already verified (and how), the exact files and signatures to create,
and the order to build them. Where something is unverified it says so — those
are the only places needing judgement. Do not re-litigate the settled
decisions in "Decisions already taken"; they were made against evidence
recorded here.

---

## 1. What this feature is

Let one cclaw session delegate work to several short-lived agents running in
parallel, and fold their results back into the parent's conversation.

**In scope (phase 1 and 2):**

- The user asks for fan-out explicitly, with a slash command.
- Each subagent is a separate `cclaw -p` child process with its own ACP
  session, its own transcript on disk, and its own result file.
- The parent collects results, reports them in the chat log, and carries a
  digest into its next prompt.
- Subagent activity is visible: inline in the chat log always, and as
  split-pane tabs when running under cmux.

**Out of scope (phase 3, deferred — see §11):**

- The _model_ deciding to spawn subagents. This is impossible today without
  MCP; see §11 for why and what it would take.
- Subagents spawning their own subagents beyond `maxDepth`.
- Sharing context between sibling subagents.

**Non-goals:**

- Replicating Claude Code's Task tool semantics exactly.
- Any cross-machine or cloud execution.

---

## 2. Decisions already taken

These were decided with the user. Implement them; do not redesign them.

| #   | Decision                                                                                                       | Rationale                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Orchestration is **independent of any display**. It must work with no multiplexer at all.                      | A view-coupled feature does not exist for most users.                                                                                       |
| D2  | Views are **drivers behind a `SubagentView` interface**: inline first, cmux second, tmux later.                | Decided by the user.                                                                                                                        |
| D3  | Approvals are **centralised in the parent**, never answered per-pane.                                          | A grant is a policy decision made once and shared; an agent blocked on a prompt in an unwatched tab is the worst failure mode.              |
| D4  | Fan-out shape is **process per subagent** (`cclaw -p` children), not N sessions inside one process.            | Verified cheap (§3.2), gives each child its own TTY and pane naturally, and reuses `-p` wholesale.                                          |
| D5  | **Never port code from cmux.**                                                                                 | cmux is GPL-3.0-or-later with BUSL-1.1 on server directories. cclaw is not GPL. Shelling out to its CLI is fine; copying its source is not. |
| D6  | Phase 1 subagents **refuse** permission requests locally and report them. Parent-mediated granting is phase 2. | Keeps phase 1 small. Allowlisted commands and stored grants still run — see §6.3.                                                           |

---

## 3. Verified facts to build on

Each of these was tested first-hand. The evidence is given so you can trust it
without repeating the work. **Do not assume anything not in this section.**

### 3.1 Cursor's ACP server multiplexes concurrent sessions

One `agent acp` process, three sessions, three prompts in flight:

```
elapsed 1124ms
  prompt 0/1/2: {"stopReason":"end_turn"}
updates per session: 78701c3a=2 2fbcc741=2 30cb8be1=1
interleaving: 30cb8be1:agent_message_chunk 2fbcc741:agent_message_chunk 78701c3a:agent_message_chunk
```

Updates are correctly tagged by `sessionId` and completed out of request order,
so the server is not serialising. **Caveat:** all three replies were plan
refusals, which return fast. Three long tool-using turns on one process is
_untested_. This matters only if you revisit D4.

### 3.2 Fan-out by child process is nearly free in wall-clock

One `cclaw -p` run: **7.5s**. Three in parallel: **8.9s**. The ~7.5s is fixed
startup (Bun, spawning `agent acp`, `initialize`, `session/new`), not
contention. Budget accordingly: a subagent batch costs about one subagent.

### 3.3 The child contract already works

Three `cclaw -p --json` children spawned in parallel each produced valid JSON
with a distinct session id, propagated exit codes, and were collected and
classified by the caller. This was run end to end. The only failure was the
model work itself (§3.5).

### 3.4 Native ACP session resume does not work

`loadSession: true` is advertised, but probed with raw JSON-RPC across five
parameter shapes it returns `Session "<id>" not found` — including for ids
Cursor itself wrote. Its persisted record is
`{"schemaVersion":1,"cwd":"…","title":"…"}` with no conversation.

**Consequence:** a subagent cannot be handed a live parent session. Context
must be passed as text in the prompt. `renderTranscript` + `carriedMessage`
already do this.

### 3.5 Every turn on this account is plan-gated

All replies are `Upgrade your plan to continue` with
`stopReason: "end_turn"` — no protocol-level error. `isPlanGated()` in
`src/commands/print.ts` detects it and makes `-p` exit 1.

**Consequence for you:** you can build and unit-test everything, and you can
verify the orchestration mechanically (processes spawn, results collect, caps
hold, panes open), but **you cannot verify that a subagent does useful work.**
Do not report the feature as working end to end. Say exactly what you verified.

### 3.6 Cursor sends no usage data

The protocol defines `usage_update { used, size, cost }`; this Cursor build
never sends one and advertises nothing for usage. `ingest()` in
`src/tui/acp-backend.ts` handles 6 of the protocol's 19 update kinds.

**Consequence:** the parent cannot tell how close it is to its context limit,
which matters because fan-out multiplies context pressure on it. Mitigate by
capping digest size (§5.4), not by guessing a window.

---

## 4. Architecture

```
┌─ parent: cclaw chat ─────────────────────────────────────────┐
│                                                              │
│  /agents 3 <task>                                            │
│        │                                                     │
│        ▼                                                     │
│  SubagentOrchestrator          ← pure scheduling + caps      │
│        │                                                     │
│        ├── spawn ─► cclaw -p --json --result <path>  (child) │
│        ├── spawn ─► cclaw -p --json --result <path>  (child) │
│        └── spawn ─► cclaw -p --json --result <path>  (child) │
│        │                                                     │
│        │  reads result files, classifies, builds digest      │
│        ▼                                                     │
│  SubagentView (interface)                                    │
│        ├── InlineView   → rows in ChatLog     [always]       │
│        ├── CmuxView     → split + tabs        [CMUX_SURFACE_ID] │
│        └── TmuxView     → nested-socket tabs  [later]        │
└──────────────────────────────────────────────────────────────┘
```

The orchestrator never imports a view implementation, and no view implementation
knows how a subagent runs. That seam is D1/D2 and is the main thing to get
right.

---

## 5. Files to create

### 5.1 `src/subagents/types.ts`

```ts
export type SubagentState = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface SubagentTask {
  /** Stable short id, used for file names and pane titles. */
  id: string;
  /** The prompt sent to the child. */
  prompt: string;
  /** Short human label for the view, derived from the prompt. */
  label: string;
}

export interface SubagentRecord {
  task: SubagentTask;
  state: SubagentState;
  startedAt: number;
  endedAt?: number;
  /** Parsed child result, once it has one. */
  result?: SubagentResult;
  /** Why it failed, when state is "failed". */
  error?: string;
}

/** The JSON a `cclaw -p --json` child emits. Mirrors PrintResult. */
export interface SubagentResult {
  reply: string;
  sessionId: string;
  stopReason: string;
  tools: { name: string; status: string }[];
  refused: string[];
  isError: boolean;
}

export interface SubagentLimits {
  /** Most subagents running at once. */
  maxConcurrent: number;
  /** Most subagents in one batch. */
  maxBatch: number;
  /** Deepest nesting allowed. 1 = a subagent cannot spawn subagents. */
  maxDepth: number;
  /** Wall-clock per subagent, milliseconds. */
  timeoutMs: number;
  /** Characters of digest carried back to the parent. */
  maxDigestChars: number;
}

export const DEFAULT_LIMITS: SubagentLimits = {
  maxConcurrent: 3,
  maxBatch: 5,
  maxDepth: 1,
  timeoutMs: 300_000,
  maxDigestChars: 6_000,
};
```

### 5.2 `src/subagents/view.ts`

```ts
import type { SubagentRecord } from "./types.ts";

/**
 * How subagent progress is shown. Implementations must tolerate being called
 * with states out of order and must never throw: a display failure must not
 * fail the work.
 */
export interface SubagentView {
  /** Called once before anything spawns. */
  begin: (records: readonly SubagentRecord[]) => Promise<void> | void;
  /** Called whenever any record changes. Pass the whole set; it is cheap. */
  update: (records: readonly SubagentRecord[]) => Promise<void> | void;
  /** Called once when the batch settles, successfully or not. */
  end: (records: readonly SubagentRecord[]) => Promise<void> | void;
  /** Release panes, processes, sockets. Must be idempotent. */
  dispose: () => Promise<void> | void;
}

/** A view that shows nothing. The default, and the fallback on any error. */
export const nullView: SubagentView = {
  begin: () => {},
  update: () => {},
  end: () => {},
  dispose: () => {},
};
```

### 5.3 `src/subagents/digest.ts` — **pure, test this hard**

```ts
import type { SubagentRecord } from "./types.ts";

/** One line per subagent for the chat log: state, label, timing. */
export function renderStatusLines(records: readonly SubagentRecord[]): string[];

/** Counts for a footer: "2 running · 1 done · 1 failed". */
export function summarise(records: readonly SubagentRecord[]): {
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
};

/**
 * The text carried into the parent's next prompt.
 *
 * Budgeted to maxDigestChars because the parent has no context figure (§3.6).
 * Trims the longest replies first so one verbose subagent cannot crowd out the
 * others, and says explicitly when it truncated.
 */
export function buildDigest(records: readonly SubagentRecord[], maxChars: number): string;

/** A short label for a prompt, for pane titles and log rows. */
export function labelFor(prompt: string, max?: number): string;
```

`buildDigest` requirements:

- Wrap in `<subagent-results>` … `</subagent-results>`, matching the
  `<compacted-context>` convention in `src/tui/compact.ts`.
- One block per subagent: its label, its state, and its reply.
- A failed or refused subagent must still appear, with why. Silently omitting
  a failure makes the parent believe work happened that did not.
- When over budget, trim the longest replies first and append
  `[N result(s) truncated]`.
- Never return a string over `maxChars`.

### 5.4 `src/subagents/orchestrator.ts`

```ts
import type { SubagentLimits, SubagentRecord, SubagentResult, SubagentTask } from "./types.ts";
import type { SubagentView } from "./view.ts";

export interface SpawnContext {
  /** Working directory for children. */
  cwd: string;
  /** Environment for children, from launchEnv(pp, paths). */
  env: Record<string, string>;
  /** Where result files are written. */
  resultDir: string;
  /** Profile to run children under, so they share policy and grants. */
  profile: string;
  /** This process's pid, passed so children die with it. */
  ownerPid: number;
  /** Current nesting depth; children get this + 1. */
  depth: number;
}

/** Spawn one child. Injected so tests never start a real process. */
export type SubagentRunner = (
  task: SubagentTask,
  ctx: SpawnContext,
  signal: AbortSignal,
) => Promise<SubagentResult>;

export interface RunBatchOptions {
  tasks: readonly SubagentTask[];
  ctx: SpawnContext;
  limits: SubagentLimits;
  view: SubagentView;
  runner: SubagentRunner;
  /** Called on every state change, for the footer. */
  onChange?: (records: readonly SubagentRecord[]) => void;
}

export type BatchOutcome =
  { kind: "ran"; records: SubagentRecord[]; digest: string } | { kind: "refused"; reason: string };

/**
 * Run a batch to completion. Never throws: a child that fails becomes a
 * failed record.
 */
export async function runBatch(opts: RunBatchOptions): Promise<BatchOutcome>;

/** The real runner: spawns `cclaw -p --json --result <path>`. */
export const spawnRunner: SubagentRunner;
```

`runBatch` requirements:

- Refuse before spawning anything when `ctx.depth >= limits.maxDepth`
  (`{kind: "refused"}`), or when `tasks.length > limits.maxBatch`.
- Respect `maxConcurrent`: a pool, not `Promise.all`. `p-limit` is already a
  dependency.
- Enforce `timeoutMs` per subagent by aborting its signal; the record becomes
  `failed` with `error: "timed out after Ns"`.
- Call `view.begin` once, `view.update` on every change, `view.end` once, and
  `view.dispose` in a `finally`. Wrap every view call in try/catch and fall
  back to `nullView` on first throw — a broken pane must not fail the work.
- Return a digest built with `limits.maxDigestChars`.

### 5.5 `src/subagents/inline-view.ts`

Renders into the existing chat log. Needs only a narrow sink, so it is testable
against a real `ChatLog` the way `src/tui/stream-render.test.ts` does:

```ts
export interface InlineSink {
  addSystem: (text: string) => void;
  requestRender: () => void;
}

export function createInlineView(sink: InlineSink): SubagentView;
```

Behaviour: one system block on `begin` listing the tasks, one replacing status
block on `update` (throttled to at most every 250ms), one summary on `end`.

### 5.6 `src/subagents/cmux-view.ts`

Drives the cmux CLI. **Shell out only — never link or copy cmux code (D5).**

```ts
/** Runs a cmux CLI command. Injected so tests assert argv without cmux installed. */
export type CmuxRunner = (args: readonly string[]) => Promise<{
  code: number;
  stdout: string;
  stderr: string;
}>;

/** True when running inside cmux. */
export function inCmux(env: NodeJS.ProcessEnv): boolean;

export function createCmuxView(opts: {
  run: CmuxRunner;
  env: NodeJS.ProcessEnv;
  limits: { maxPanes: number };
}): SubagentView;
```

Detection: `env.CMUX_SURFACE_ID` is set inside a cmux terminal (alongside
`CMUX_WORKSPACE_ID`, `CMUX_TAB_ID`). Treat a missing `CMUX_SURFACE_ID` as
"not in cmux" and return `nullView`.

Commands to use, all with `--json --id-format uuids` so handles parse:

| Purpose                                  | Command                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| Split below the current surface          | `cmux new-split <CMUX_SURFACE_ID> --direction down --command "<child cmd>"` |
| Add a subagent as a **tab** in that pane | `cmux new-surface <pane-handle> --command "<child cmd>"`                    |
| Rename a tab to the subagent label       | `cmux tab-action rename <tab> --name "<label>"`                             |
| Read a subagent's screen                 | `cmux capture-pane --surface <id> --lines 200`                              |
| Close a tab on dispose                   | `cmux close-surface <id>`                                                   |

Notes the implementer needs:

- The socket is password-gated. The CLI resolves `CMUX_SOCKET_PASSWORD` from
  the environment. **Pass it in the environment, never in argv** — other local
  users can read a process's arguments but not its environment. (This is
  cmux's own stated reason; it applies to us identically.)
- `cmux` is macOS-only. `inCmux()` must be the only gate; nothing else in the
  codebase may assume it exists.
- Cap panes at `maxPanes` (default 4). Beyond that, run the extra subagents
  without a pane rather than refusing them.
- **Unverified:** cmux is not installed on the development machine, so every
  command above comes from `docs/cli-contract.md` in the cmux repo, not from a
  live run. Test with an injected `CmuxRunner` asserting argv, and mark the
  live path as unverified until someone runs it with cmux installed.

### 5.7 Changes to existing files

**`src/commands/print.ts`** — three additions:

1. `--result <path>`: write the same JSON to that path as well as stdout, via
   write-to-temp-then-rename so a reader never sees half a file. The parent
   needs this because a child in a pane writes its stdout to the pane, not to
   the parent.
2. Read `CCLAW_SUBAGENT_DEPTH` (default `0`) and expose it so a child knows its
   own depth. A child at or over `maxDepth` must refuse to spawn further
   subagents.
3. Read `CCLAW_OWNER_PID`. If set, poll every 2s with `process.kill(pid, 0)`
   and exit 1 when the owner is gone. **This is not optional**: an orphaned
   subagent keeps a live ACP session and keeps billing. Put the watchdog in a
   small exported function so it can be unit-tested with a fake `kill`.

**`src/env.ts`** — add to `ProfilePaths`:

```ts
/** Subagent result files, one JSON per subagent run. */
subagentsDir: string; // join(dir, "subagents")
```

**`src/tui/commands.ts`** — add to `CommandContext`:

```ts
/** Fan out n subagents over a task. */
spawnSubagents: (count: number, task: string) => Promise<BatchOutcome>;
/** Live subagent records, for the footer. */
subagents: () => readonly SubagentRecord[];
```

and a `/agents` built-in:

```
/agents <n> <task>    run n subagents on a task and report back
```

Validation, all before spawning: `n` must parse as 1…`maxBatch`; a missing or
empty task is an error naming the usage; `ctx.busy()` means refuse with "a turn
is already running". Follow the existing `/loop` command for the shape.

**`src/tui/app.ts`** — wire it: build the view (`inCmux(process.env)` →
`createCmuxView` else `createInlineView`), implement `spawnSubagents`, and on a
successful batch set `carried` to the digest with `carriedLabel = "subagents"`.
That requires a third `CarriedKind` in `src/tui/compact.ts` with its own
preamble — the existing two say "summary of a cleared session" and "transcript
of an earlier session", and neither is true of subagent results.

---

## 6. Behaviour specifications

### 6.1 The child command line

```
cclaw -p --json --result <resultDir>/<id>.json -P <profile> "<prompt>"
```

with environment `launchEnv(pp, paths)` plus:

| Variable               | Value                               |
| ---------------------- | ----------------------------------- |
| `CCLAW_SUBAGENT_ID`    | the task id                         |
| `CCLAW_SUBAGENT_DEPTH` | `ctx.depth + 1`                     |
| `CCLAW_OWNER_PID`      | the parent's pid                    |
| `CMUX_SOCKET_PASSWORD` | inherited if present, never in argv |

Running children under the **same profile** is deliberate: they then share the
parent's policy, allowlist and grant store (§6.3).

### 6.2 Collecting a result

Prefer the result file; fall back to parsing stdout. Treat as `failed` when:

- the file is absent or unparseable after the child exits, or
- the child exited non-zero and the parsed result has `isError: true`, or
- it timed out.

`isError: true` already covers the plan gate (§3.5), so a plan-refused
subagent correctly reads as failed, not as a terse success.

### 6.3 Approvals (D3, D6)

A subagent child builds the _same_ resolver the parent does —
`createPermissionResolver` with the profile's `allow`/`deny` from
`readPolicyFromConfig` and an `ApprovalStore` over the profile's
`grantsFile` — with an `askUser` that refuses and records. This is already
implemented in `src/commands/print.ts`; reuse it, do not fork it.

Therefore, **today**: allowlisted commands and anything granted with
`cclaw grant add` run inside a subagent; anything else is refused and reported
in `refused[]`, which `buildDigest` must surface so the parent can say what it
would have needed.

**Phase 2** adds parent-mediated granting: a unix socket in the run directory,
the child asking over it, the parent routing to its existing `askUser` UI so
one queue serves every subagent. Build phase 1 without it; the socket is a
separate, self-contained change.

### 6.4 Cancellation

Esc in the parent must cancel a running batch: abort every signal, mark
unfinished records `cancelled`, call `view.dispose`. Children must die — rely
on the owner-pid watchdog as the backstop, but also kill the process group
directly. A cancelled batch carries **no** digest.

---

## 7. Testing plan

Follow the pattern this codebase has been repeatedly rewarded for: push logic
into pure functions, test those exhaustively, and test the view integration
against a real component. The `PromptEditor` bug survived eight passing tests
because they all exercised the wrong case; `src/tui/stream-render.test.ts` is
the model to copy.

**`digest.test.ts`** — the most important file. Cover at minimum:

- a digest with one, several and zero records
- a digest that must truncate: assert `length <= maxChars` and that the
  truncation notice appears
- a failed subagent still appears, with its reason
- a refused subagent surfaces its `refused[]` entries
- a plan-gated subagent reads as failed
- the longest reply is trimmed before shorter ones
- `labelFor` on an empty prompt, a very long prompt, and one with newlines
- `summarise` counts each state

**`orchestrator.test.ts`** — with a fake `SubagentRunner`, never a real process:

- `maxConcurrent` is respected (have the runner record overlap and assert the
  peak)
- `maxBatch` exceeded → `{kind: "refused"}` and **nothing spawned**
- `depth >= maxDepth` → refused, nothing spawned
- a runner that throws becomes a `failed` record, and siblings still complete
- a runner that never resolves hits `timeoutMs` and becomes `failed`
- a view whose `update` throws does not fail the batch
- `view.dispose` is called even when the batch throws
- cancellation marks unfinished records `cancelled` and yields no digest

**`cmux-view.test.ts`** — with an injected `CmuxRunner`:

- `inCmux` false without `CMUX_SURFACE_ID` → `nullView`
- `begin` issues `new-split` once, then one `new-surface` per subagent
- panes are capped at `maxPanes`, extra subagents still run
- `dispose` closes every surface it opened, and is safe to call twice
- a non-zero cmux exit does not throw

**`inline-view.test.ts`** — against a **real `ChatLog`**, asserting that
subagent labels and final states actually appear in rendered output, and that
every rendered line respects the requested width.

**`commands.test.ts`** — extend: `/agents` with a bad count, a missing task,
while busy, and a valid invocation.

**`print.test.ts`** — extend: `--result` parsing, and the owner-pid watchdog
with a fake `kill`.

### Definition of done

Per the project standard: `bun run check` green — prettier, shellcheck/shfmt,
`tsc --noEmit`, and `bun test src` — with covering tests for every new
behaviour. Plus:

- `/agents 3 <task>` run live in a PTY, with the processes, result files, caps
  and cancellation observed.
- Report honestly that subagents returned plan refusals (§3.5) and that the
  cmux live path is unverified unless cmux was actually installed.

---

## 8. Build order

Each phase is independently shippable and leaves the tree green.

**Phase A — the spine (no view).** `types.ts`, `digest.ts`, `orchestrator.ts`
with `spawnRunner`, `print.ts`'s `--result` and owner watchdog, `subagentsDir`.
Exercise it from a scratch script, not the TUI. _Done when_ a script fans out
three real children, collects three results, and the caps and timeout are
proven by tests.

**Phase B — inline view and the slash command.** `view.ts`, `inline-view.ts`,
`CommandContext` additions, `/agents`, `app.ts` wiring, the third
`CarriedKind`. _Done when_ `/agents 2 <task>` works in a PTY and the digest
reaches the next prompt.

**Phase C — cmux driver.** `cmux-view.ts` plus tests with an injected runner.
_Done when_ argv is asserted for every command and `inCmux` gating is proven.
Mark the live path unverified unless run under cmux.

**Phase D (optional) — tmux driver.** The mechanism is verified: split the
window, then run a tmux server on its **own socket** (`tmux -L <name>`) inside
the lower pane, one window per subagent. Its status line renders as a tab bar:

```
[subs] 0:agent-1  1:agent-2- 2:agent-3*
```

A separate socket means its own config and its own prefix, so there is no
`C-b C-b` ambiguity, and the parent can switch tabs with
`tmux -L <name> select-window -t <n>` and read any pane with `capture-pane -p`.

**Phase E (optional, needs §11) — model-driven spawning over MCP.**

---

## 9. Risks

| Risk                                 | Mitigation                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Orphaned subagents keep billing      | Owner-pid watchdog (§5.7), plus killing the process group on cancel. Not optional.                                              |
| Runaway nesting                      | `maxDepth` default 1, enforced before spawning, carried in `CCLAW_SUBAGENT_DEPTH`.                                              |
| Parent context overflow from digests | `maxDigestChars`, longest-first trimming. We cannot measure the window (§3.6), so the cap is the whole defence.                 |
| Cost multiplication                  | `maxBatch`, `maxConcurrent`, `timeoutMs`. Consider refusing fan-out entirely while the plan gate is active.                     |
| Concurrency unproven under real load | §3.1 caveat. If Cursor serialises long turns, D4's process-per-subagent already isolates us — that is partly why it was chosen. |
| cmux commands wrong                  | All from docs, not a live run. Injected runner + explicit "unverified" in the report.                                           |
| A broken pane breaks the work        | Every view call wrapped; fall back to `nullView`.                                                                               |

---

## 10. Interfaces you will touch, as they exist today

Read these before writing code; the signatures are current.

| What                                                   | Where                                 |
| ------------------------------------------------------ | ------------------------------------- |
| `PrintResult`, `isPlanGated`, `printCommand`           | `src/commands/print.ts`               |
| `createPermissionResolver`, `ApprovalStore`, `AskUser` | `src/policy/resolver.ts`              |
| `readPolicyFromConfig`                                 | `src/policy/profile-policy.ts`        |
| `carriedMessage`, `CarriedKind`                        | `src/tui/compact.ts`                  |
| `renderTranscript`, `appendTurn`, `startSession`       | `src/tui/sessions.ts`                 |
| `CommandContext`, `builtinCommands`, `runSlash`        | `src/tui/commands.ts`                 |
| `ChatLog.addSystem`, `startTool`, `updateToolResult`   | `src/tui/view/components/chat-log.ts` |
| `ProfilePaths`, `profilePaths`, `resolvePaths`         | `src/env.ts`                          |
| `launchEnv`, `ensureProfile`, `resolveProfileName`     | `src/profile.ts`                      |
| `ToolEvent`, `AcpTuiBackend`                           | `src/tui/acp-backend.ts`              |

---

## 11. Why the model cannot spawn subagents yet

Worth understanding before anyone files it as a bug.

cclaw has no way to let Cursor's agent call our code. `src/acp/client.ts`
advertises no client-side filesystem or terminal methods, and ACP has no
"client tool" concept beyond MCP. So the _only_ route to model-driven spawning
is to expose a `spawn_subagent` tool over MCP and pass it in `session/new`'s
`mcpServers`, which is currently hardcoded to `[]` (`src/acp/client.ts:219`
and `:287`).

Two constraints if anyone builds this:

- Cursor advertises `mcpCapabilities: { http: true, sse: true }` — **and no
  stdio**. The server must be HTTP or SSE, so cclaw would host a local one.
- That is feature 12 (MCP server management) and should be built as feature 12,
  not smuggled in here.

Until then `/agents` is user-driven, which is also the more testable design and
needs no model cooperation.

---

## 12. Licence constraints

- **cmux is GPL-3.0-or-later**, with BUSL-1.1 on its server directories.
  Shelling out to the `cmux` CLI is fine. Copying or adapting its source into
  cclaw is not. If you need to know what a command does, read
  `docs/cli-contract.md` in its repo and write your own implementation.
- The clone lives at `~/dev/cmux`, outside this repo, and is read-only
  reference material. Nothing in `src/` may import from it or assume it is
  present.
- OpenClaw ports remain MIT with attribution in file headers and
  `THIRD-PARTY-NOTICES.md`. Nothing here changes that.
