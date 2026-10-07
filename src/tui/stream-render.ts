/**
 * Turning ACP stream events into chat-log calls.
 *
 * Extracted from the app for the same reason as TurnController: this is
 * ordering logic over a view, and the one previous bug in this layer
 * (PromptEditor destroying the autocomplete rows) survived eight passing tests
 * because every one of them exercised the wrong case. A fake sink makes the
 * ordering assertable without a live agent, which matters here because Cursor
 * will not emit a tool call on a plan-gated account.
 */

import type { ToolEvent } from "./acp-backend.ts";

export interface ToolRenderSink {
  startTool: (toolCallId: string, toolName: string, args: unknown) => void;
  updateToolResult: (
    toolCallId: string,
    result: unknown,
    opts?: { isError?: boolean; partial?: boolean },
  ) => void;
}

/** A tool call is terminal once it has succeeded or failed. */
export function isTerminalStatus(status: ToolEvent["status"]): boolean {
  return status === "completed" || status === "failed";
}

/** The name the chat log tracks a call under, preferring the agent's own. */
export function toolLabel(ev: ToolEvent): string {
  return ev.title ?? ev.name ?? ev.kind ?? "tool";
}

/** A short verb per ACP tool kind, so a row reads as an action. */
const KIND_VERB: Record<string, string> = {
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  execute: "Run",
  think: "Think",
  fetch: "Fetch",
  switch_mode: "Switch mode",
  other: "Tool",
};

/** Argument keys worth showing, most specific first. */
const DETAIL_KEYS = [
  "command",
  "cmd",
  "file_path",
  "filePath",
  "path",
  "file",
  "pattern",
  "query",
  "url",
  "description",
] as const;

/** `read_file` -> `Read file`; `mcp__linear__issue` -> `Linear issue`. */
function humaniseName(name: string): string {
  const words = name
    .replace(/^mcp__/, "")
    .replace(/__/g, " ")
    .split(/[\s_\-.]+/)
    .filter((w) => w !== "");
  if (words.length === 0) return "Tool";
  const [first, ...rest] = words;
  return [(first ?? "").charAt(0).toUpperCase() + (first ?? "").slice(1), ...rest].join(" ");
}

function detailFromArgs(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  for (const key of DETAIL_KEYS) {
    const v = rec[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  // An unrecognised shape still beats showing nothing: summarise the scalars
  // rather than dropping them, which left rows reading just "Weird Tool …".
  const parts: string[] = [];
  for (const [key, value] of Object.entries(rec)) {
    if (value === null || value === undefined || typeof value === "object") continue;
    const text = String(value).trim();
    if (text === "") continue;
    parts.push(`${key}: ${text}`);
    if (parts.length === 2) break;
  }
  return parts.length === 0 ? undefined : parts.join("  ");
}

/** Collapse to one line and bound the length for a single row. */
function oneLine(text: string, max = 120): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * A human row for a tool call: an action and what it acted on.
 *
 * Without this the chat log fell back to dumping the raw arguments as JSON —
 * `Execute {"title":"…"}` — because the display adapter only recognises a few
 * argument keys and nothing supplied a description.
 */
export function describeTool(ev: ToolEvent): { label: string; detail?: string } {
  const label =
    (ev.kind !== undefined ? KIND_VERB[ev.kind] : undefined) ??
    (ev.name !== undefined ? humaniseName(ev.name) : undefined) ??
    "Tool";

  const fromArgs = detailFromArgs(ev.rawInput);
  const fromLocations =
    ev.locations !== undefined && ev.locations.length > 0 ? ev.locations.join(", ") : undefined;
  // Cursor's own title is usually already a sentence ("Read src/cli.ts"), so
  // it is the best detail when the arguments give nothing. Drop a leading verb
  // that would otherwise read as "Read  Read src/cli.ts".
  const fromTitle =
    ev.title === undefined
      ? undefined
      : ev.title.toLowerCase().startsWith(label.toLowerCase())
        ? ev.title.slice(label.length).trim() || undefined
        : ev.title;

  const detail = fromArgs ?? fromLocations ?? fromTitle;
  // A generic kind with a prose title needs no "Tool" in front of it.
  if (
    label === "Tool" &&
    fromArgs === undefined &&
    fromLocations === undefined &&
    detail !== undefined
  ) {
    return { label: oneLine(detail) };
  }
  return { label, ...(detail !== undefined ? { detail: oneLine(detail) } : {}) };
}

/** The single header row: an action and what it acted on. */
export function toolHeader(label: string, detail?: string): string {
  return detail === undefined || detail === "" ? label : `${label}  ${detail}`;
}

/**
 * Upsert one tool call.
 *
 * ACP sends `tool_call` once and then `tool_call_update` repeatedly against the
 * same id, so `startTool` is called for both phases: the chat log treats a
 * known id as an update. A result is written only once there is something to
 * show, so a pending call renders as running rather than as finished-and-empty.
 */
export function renderToolEvent(sink: ToolRenderSink, ev: ToolEvent): void {
  const { label, detail } = describeTool(ev);
  // One header row reading "Run bun run check" rather than a verb on its own
  // line and the target on the next. Args are passed as undefined: anything
  // else renders a second line, and an object would be dumped as JSON.
  sink.startTool(ev.toolCallId, toolHeader(label, detail), undefined);

  const terminal = isTerminalStatus(ev.status);
  if (ev.output === undefined && !terminal) return;

  const text = ev.output ?? (ev.status === "failed" ? "failed" : (ev.locations?.join("\n") ?? ""));
  sink.updateToolResult(
    ev.toolCallId,
    { content: [{ type: "text", text }] },
    { isError: ev.status === "failed", partial: !terminal },
  );
}

export interface StreamSink {
  update: (runId: string, text: string) => void;
  finalize: (runId: string, text: string) => void;
}

/**
 * Routes streamed chunks into chat-log runs, keeping reasoning separate.
 *
 * Reasoning always streams from Cursor; only showing it is optional. It goes
 * into its own run so the reply is not interleaved with it, and that run is
 * finalised the moment the first reply chunk arrives: the chat log resolves a
 * tool call's owning run by "the one currently streaming", so two live runs at
 * once would attach tool output to the wrong place.
 */
export class StreamRouter {
  private readonly text = new Map<string, string>();
  private seq = 0;
  private thinking = false;

  constructor(private readonly sink: StreamSink) {}

  setThinking(on: boolean): void {
    this.thinking = on;
  }

  get showsThinking(): boolean {
    return this.thinking;
  }

  /** Begin a turn. Returns the run id the reply will stream into. */
  beginTurn(): string {
    this.seq += 1;
    this.text.delete(this.replyRun);
    return this.replyRun;
  }

  get replyRun(): string {
    return "turn";
  }

  get thoughtRun(): string {
    return `thought-${this.seq}`;
  }

  /** Accumulated reply text for the current turn. */
  reply(): string {
    return this.text.get(this.replyRun) ?? "";
  }

  chunk(kind: "message" | "thought", chunk: string): void {
    if (kind === "thought") {
      if (!this.thinking) return;
      const runId = this.thoughtRun;
      const next = (this.text.get(runId) ?? "") + chunk;
      this.text.set(runId, next);
      this.sink.update(runId, italic(next));
      return;
    }
    this.closeThought();
    const next = this.reply() + chunk;
    this.text.set(this.replyRun, next);
    this.sink.update(this.replyRun, next);
  }

  /** Finalise a reasoning run that is still open, if any. */
  closeThought(): void {
    const runId = this.thoughtRun;
    const thought = this.text.get(runId);
    if (thought === undefined) return;
    this.text.delete(runId);
    this.sink.finalize(runId, italic(thought));
  }

  clear(): void {
    this.text.clear();
  }
}

/** Reasoning is rendered in markdown italics to distinguish it from the reply. */
function italic(text: string): string {
  const trimmed = text.trim();
  return trimmed === "" ? "" : `*${trimmed}*`;
}
