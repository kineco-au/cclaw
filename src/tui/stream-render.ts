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

/**
 * Upsert one tool call.
 *
 * ACP sends `tool_call` once and then `tool_call_update` repeatedly against the
 * same id, so `startTool` is called for both phases: the chat log treats a
 * known id as an update. A result is written only once there is something to
 * show, so a pending call renders as running rather than as finished-and-empty.
 */
export function renderToolEvent(sink: ToolRenderSink, ev: ToolEvent): void {
  const label = toolLabel(ev);
  sink.startTool(ev.toolCallId, ev.name ?? ev.kind ?? label, ev.rawInput ?? { title: label });

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
