import { describe, expect, test } from "bun:test";
import { ChatLog } from "./view/components/chat-log.ts";
import {
  isTerminalStatus,
  renderToolEvent,
  StreamRouter,
  toolLabel,
  type ToolRenderSink,
} from "./stream-render.ts";
import type { ToolEvent } from "./acp-backend.ts";

interface Call {
  method: "start" | "result";
  id: string;
  name?: string;
  args?: unknown;
  result?: unknown;
  opts?: { isError?: boolean; partial?: boolean };
}

function sink(): { s: ToolRenderSink; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    s: {
      startTool: (id, name, args) => calls.push({ method: "start", id, name, args }),
      updateToolResult: (id, result, opts) =>
        calls.push({ method: "result", id, result, ...(opts !== undefined ? { opts } : {}) }),
    },
  };
}

const ev = (over: Partial<ToolEvent> = {}): ToolEvent => ({
  phase: "start",
  toolCallId: "t1",
  ...over,
});

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("toolLabel", () => {
  test("prefers the agent's title", () => {
    expect(toolLabel(ev({ title: "Read src/cli.ts", name: "read_file", kind: "read" }))).toBe(
      "Read src/cli.ts",
    );
  });

  test("falls back through name and kind", () => {
    expect(toolLabel(ev({ name: "read_file", kind: "read" }))).toBe("read_file");
    expect(toolLabel(ev({ kind: "read" }))).toBe("read");
    expect(toolLabel(ev())).toBe("tool");
  });
});

describe("isTerminalStatus", () => {
  test("only completed and failed are terminal", () => {
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("pending")).toBe(false);
    expect(isTerminalStatus("in_progress")).toBe(false);
    expect(isTerminalStatus(undefined)).toBe(false);
  });
});

describe("renderToolEvent", () => {
  test("starts a tool without writing an empty result", () => {
    const { s, calls } = sink();
    renderToolEvent(s, ev({ title: "Read a.ts", status: "pending" }));
    // Writing a result here would render a pending call as finished and empty.
    expect(calls.map((c) => c.method)).toEqual(["start"]);
  });

  test("writes output as a partial result while still running", () => {
    const { s, calls } = sink();
    renderToolEvent(s, ev({ phase: "update", status: "in_progress", output: "half" }));
    expect(calls[1]?.opts).toEqual({ isError: false, partial: true });
  });

  test("marks a completed call as no longer partial", () => {
    const { s, calls } = sink();
    renderToolEvent(s, ev({ phase: "update", status: "completed", output: "all done" }));
    expect(calls[1]?.opts).toEqual({ isError: false, partial: false });
    expect(calls[1]?.result).toEqual({ content: [{ type: "text", text: "all done" }] });
  });

  test("marks a failure as an error", () => {
    const { s, calls } = sink();
    renderToolEvent(s, ev({ phase: "update", status: "failed" }));
    expect(calls[1]?.opts).toEqual({ isError: true, partial: false });
    expect(calls[1]?.result).toEqual({ content: [{ type: "text", text: "failed" }] });
  });

  test("falls back to the touched paths when a call completes silently", () => {
    const { s, calls } = sink();
    renderToolEvent(s, ev({ phase: "update", status: "completed", locations: ["a.ts", "b.ts"] }));
    expect(calls[1]?.result).toEqual({ content: [{ type: "text", text: "a.ts\nb.ts" }] });
  });

  test("passes rawInput through as the args, so the header can show them", () => {
    const { s, calls } = sink();
    renderToolEvent(s, ev({ name: "shell", rawInput: { command: "ls -la" } }));
    expect(calls[0]?.name).toBe("shell");
    expect(calls[0]?.args).toEqual({ command: "ls -la" });
  });

  test("synthesises args from the title when the agent echoes none", () => {
    const { s, calls } = sink();
    renderToolEvent(s, ev({ title: "Read a.ts" }));
    expect(calls[0]?.args).toEqual({ title: "Read a.ts" });
  });

  test("an update re-starts the same id, which the chat log treats as an upsert", () => {
    const { s, calls } = sink();
    renderToolEvent(s, ev({ title: "Read a.ts", status: "pending" }));
    renderToolEvent(s, ev({ phase: "update", status: "completed", output: "x" }));
    expect(calls.filter((c) => c.method === "start")).toHaveLength(2);
    expect(new Set(calls.map((c) => c.id))).toEqual(new Set(["t1"]));
  });
});

describe("renderToolEvent against a real ChatLog", () => {
  function render(events: ToolEvent[]): string {
    const log = new ChatLog(50);
    const s: ToolRenderSink = {
      startTool: (id, name, args) => void log.startTool(id, name, args),
      updateToolResult: (id, result, opts) => void log.updateToolResult(id, result, opts),
    };
    for (const e of events) renderToolEvent(s, e);
    return log.render(70).map(strip).join("\n");
  }

  test("a tool call actually appears in the log", () => {
    // The point of item 1: before this, tool activity was invisible.
    expect(
      render([ev({ title: "Read src/cli.ts", name: "read_file", status: "pending" })]),
    ).toContain("Read");
  });

  test("the output is shown once the call completes", () => {
    const out = render([
      ev({ title: "Run ls", name: "shell", status: "pending" }),
      ev({ phase: "update", status: "completed", output: "cli.ts\nenv.ts" }),
    ]);
    expect(out).toContain("cli.ts");
  });

  test("two calls render as two entries, not one overwritten", () => {
    const out = render([
      ev({ toolCallId: "a", title: "Read a.ts", status: "completed", output: "alpha" }),
      ev({ toolCallId: "b", title: "Read b.ts", status: "completed", output: "bravo" }),
    ]);
    expect(out).toContain("alpha");
    expect(out).toContain("bravo");
  });

  test("every rendered line respects the requested width", () => {
    const log = new ChatLog(50);
    const s: ToolRenderSink = {
      startTool: (id, name, args) => void log.startTool(id, name, args),
      updateToolResult: (id, result, opts) => void log.updateToolResult(id, result, opts),
    };
    renderToolEvent(
      s,
      ev({
        title: "Run a very long command ".repeat(6),
        status: "completed",
        output: "x".repeat(400),
      }),
    );
    for (const line of log.render(60)) expect(strip(line).length).toBeLessThanOrEqual(60);
  });
});

describe("StreamRouter", () => {
  interface H {
    r: StreamRouter;
    updates: [string, string][];
    finals: [string, string][];
  }

  function harness(): H {
    const updates: [string, string][] = [];
    const finals: [string, string][] = [];
    return {
      updates,
      finals,
      r: new StreamRouter({
        update: (id, t) => updates.push([id, t]),
        finalize: (id, t) => finals.push([id, t]),
      }),
    };
  }

  test("accumulates reply chunks into one run", () => {
    const h = harness();
    h.r.beginTurn();
    h.r.chunk("message", "Hel");
    h.r.chunk("message", "lo");
    expect(h.updates.map((u) => u[1])).toEqual(["Hel", "Hello"]);
    expect(h.r.reply()).toBe("Hello");
  });

  test("drops reasoning when thinking is off", () => {
    const h = harness();
    h.r.beginTurn();
    h.r.chunk("thought", "pondering");
    expect(h.updates).toEqual([]);
    // It still streamed; only rendering was skipped.
    expect(h.r.reply()).toBe("");
  });

  test("renders reasoning in its own run when thinking is on", () => {
    const h = harness();
    h.r.setThinking(true);
    h.r.beginTurn();
    h.r.chunk("thought", "pondering");
    expect(h.updates[0]?.[0]).toBe(h.r.thoughtRun);
    expect(h.updates[0]?.[0]).not.toBe(h.r.replyRun);
    expect(h.updates[0]?.[1]).toBe("*pondering*");
  });

  test("finalises reasoning before the reply streams, so only one run is live", () => {
    // The chat log attaches a tool call to "the run currently streaming", so
    // two live runs would put tool output in the wrong place.
    const h = harness();
    h.r.setThinking(true);
    h.r.beginTurn();
    h.r.chunk("thought", "think");
    h.r.chunk("message", "answer");
    expect(h.finals).toEqual([[h.r.thoughtRun, "*think*"]]);
    expect(h.updates.at(-1)?.[0]).toBe(h.r.replyRun);
  });

  test("finalises reasoning only once across several reply chunks", () => {
    const h = harness();
    h.r.setThinking(true);
    h.r.beginTurn();
    h.r.chunk("thought", "t");
    h.r.chunk("message", "a");
    h.r.chunk("message", "b");
    expect(h.finals).toHaveLength(1);
  });

  test("each turn gets a fresh reasoning run", () => {
    const h = harness();
    h.r.setThinking(true);
    h.r.beginTurn();
    const first = h.r.thoughtRun;
    h.r.beginTurn();
    expect(h.r.thoughtRun).not.toBe(first);
  });

  test("a new turn clears the previous reply", () => {
    const h = harness();
    h.r.beginTurn();
    h.r.chunk("message", "old");
    h.r.beginTurn();
    expect(h.r.reply()).toBe("");
  });

  test("closeThought on a turn that never replied still finalises", () => {
    const h = harness();
    h.r.setThinking(true);
    h.r.beginTurn();
    h.r.chunk("thought", "only thought");
    h.r.closeThought();
    expect(h.finals).toEqual([[h.r.thoughtRun, "*only thought*"]]);
  });

  test("closeThought is a no-op with nothing open", () => {
    const h = harness();
    h.r.beginTurn();
    h.r.closeThought();
    h.r.closeThought();
    expect(h.finals).toEqual([]);
  });

  test("whitespace-only reasoning does not render stray italics", () => {
    const h = harness();
    h.r.setThinking(true);
    h.r.beginTurn();
    h.r.chunk("thought", "   \n ");
    expect(h.updates[0]?.[1]).toBe("");
  });

  test("clear drops all accumulated text", () => {
    const h = harness();
    h.r.beginTurn();
    h.r.chunk("message", "x");
    h.r.clear();
    expect(h.r.reply()).toBe("");
  });

  test("reports whether reasoning is shown", () => {
    const h = harness();
    expect(h.r.showsThinking).toBe(false);
    h.r.setThinking(true);
    expect(h.r.showsThinking).toBe(true);
  });
});
