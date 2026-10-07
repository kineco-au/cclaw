# cclaw over ACP

cclaw drives `cursor-agent acp` using the official
**`@agentclientprotocol/sdk` v1.7.0** (Apache-2.0). No hand-rolled JSON-RPC.

Everything below was verified first-hand against the live CLI. **Trust it over
the protocol schema**, because Cursor advertises capabilities it does not
honour. Where something is unverified it says so.

## The single most important fact

**Cursor negotiates protocol v1 while the SDK's `PROTOCOL_VERSION` is 2.**

This is the likely cause of every "the protocol defines it but nothing arrives"
case below. Before concluding a feature is impossible, check whether it is a v2
feature.

## `initialize` response, verified

```json
{ "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "mcpCapabilities": { "http": true, "sse": true },
    "promptCapabilities": { "audio": false, "embeddedContext": false, "image": true },
    "sessionCapabilities": { "list": {} } },
  "authMethods": [ { "id": "cursor_login", "name": "Cursor Login" } ] }
```

Read carefully: **`mcpCapabilities` has no stdio** — an MCP server must be HTTP
or SSE. **`image: true`** but we send text only. **`embeddedContext: false`**,
so `@file` cannot attach content through the protocol.

## `session/update`: 6 of 19 kinds are handled

`ingest()` in `src/tui/acp-backend.ts` handles:

`agent_message_chunk` · `agent_thought_chunk` · `session_info_update` ·
`available_commands_update` · `tool_call` · `tool_call_update`

Everything else hits the default branch and is **dropped**:

`compaction_summary_chunk` · `compaction_update` · `config_option_update` ·
`current_mode_update` · `notice` · `plan` · `plan_removed` · `plan_update` ·
`session_message` · `session_message_chunk` · `subagent_update` ·
`usage_update` · `user_message_chunk`

If you add a handler, add it to this list.

## What is advertised but does not work

### `loadSession` — advertised, broken

Probed with raw JSON-RPC across five parameter shapes. Our params were
structurally correct; the error was `Session "<id>" not found`, **including for
ids Cursor itself had just written**. Its persisted record is:

```json
{"schemaVersion":1,"cwd":"…","title":"Defect Reviewer"}
```

No conversation in it.

**Do not build anything that depends on native resume.** `/resume` tries it and
falls back to replaying our own transcript as carried context
(`src/tui/sessions.ts` + `carriedMessage`), reporting which path it took.

### `usage_update` — defined, never sent

The protocol defines `UsageUpdate { used: number; size: number; cost?: Cost }`
— exactly a context-window figure. **This build never sends one** and
advertises nothing for usage in `agentCapabilities`.

Consequences:

- `cclaw chat` shows `ctx unknown`. **Never invent or estimate a figure.**
- The only live context figure comes from Cursor's `statusLine`, which exists
  inside Cursor's own TUI — hence `cclaw raw`.
- Where a window size can be _derived_ (the model id encodes `1M`, or a
  `context=` parameter is set) `cclaw model info` reports it and labels it
  derived. `src/models.ts` returns 0 rather than guessing.

Corroboration from outside this project: cmux samples token usage for Claude
Code and Codex only, because — in its own words — "only agents whose on-disk
transcript records per-request token usage are listed". Cursor is a supported
hook source there and still gets no usage.

### Native compaction — needs a client capability we do not declare

`compaction_update` and `compaction_summary_chunk` exist but require the
_client_ to advertise a `compaction` capability. `src/acp/client.ts` declares no
filesystem, terminal or compaction methods. So `/compact` is ours
(`src/tui/compact.ts`) and is not duplicating something already switched on —
though it may duplicate something available for the asking. Unverified.

## Plan gating — read this before debugging any empty reply

On a plan-restricted account **every turn** returns:

```
"\n\nUpgrade your plan to continue"
```

streamed as an ordinary `agent_message_chunk`, with `stopReason: "end_turn"`.
**Neither the protocol nor the transcript marks it as an error.**

This has caused two real bugs:

1. `/compact` accepted it as a summary and cleared a live session. Fixed with
   `isPlausibleSummary` (a 200-char floor) in `src/tui/compact.ts`.
2. `cclaw -p` exited 0 on it, which would green a CI run. Fixed with
   `isPlanGated()` in `src/commands/print.ts`.

**If you add any code path that treats a reply as success, handle this case.**

The underlying cause is not ACP: `ActionRequiredError: Named models
unavailable. Free plans can only use Auto.` With `auto` selected the chain
works. Model curation must intersect the catalogue with plan entitlement.

## Verified working

- **Concurrent sessions on one process.** Three sessions, three prompts in
  flight, all returned, updates correctly tagged by `sessionId`, completing out
  of request order. _Caveat:_ the replies were fast plan refusals; three long
  tool-using turns is untested.
- **Slash commands.** 43 arrive via the undocumented
  `available_commands_update` notification. The count changes between Cursor
  builds — it was 39 a day earlier. Do not hardcode it.
- **Permission requests.** A shell call offers
  `allow_once` / `allow_always` / `reject_once`. See [`policy-and-consent.md`](policy-and-consent.md).
- **Policy enforcement over ACP.** The profile's `cli-config.json` governs ACP
  sessions, not just Cursor's own TUI.

## Cursor CLI facts

- `cursor-agent acp` is **hidden from `--help`** but `agent help acp` works.
- The binary ships as both `agent` and `cursor-agent`; `src/cursor.ts` resolves
  either.
- `agent models` has **no `--format json`** and its output **contains U+200B
  zero-width spaces**. Sanitising is mandatory — this broke the first parser.
- `CURSOR_CONFIG_DIR` and `CURSOR_DATA_DIR` work, and profiles depend on them.
  **Only `cli-config.json` and `permissions.json` honour them.**
  `sandbox.json`, `hooks.json` and `mcp.json` are hardcoded to
  `homedir()/.cursor`.
- `AcpClient.stop()` leaves Cursor's `worker-server` children running. Harmless;
  the process guard deliberately ignores them.
- `agent persist` exists upstream but is **absent on this build**. Depend only
  on verified subcommands.

## How to probe

`src/acp/probe.ts` is the harness. For a one-off, write a script in the
scratchpad that imports `AcpClient` directly:

```ts
import { AcpClient } from "/abs/path/src/acp/client.ts";
const client = new AcpClient({ cwd: process.cwd(), events: { onUpdate: (n) => console.log(n) } });
await client.start();
const sid = await client.newSession();
await client.prompt(sid, "...");
await client.stop();
```

Keep the client thin and event handling tolerant of unknown fields: Cursor's
ACP is undocumented and `acp` is a hidden subcommand, so it may change without
notice.
