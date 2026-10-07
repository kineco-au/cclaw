import { describe, expect, test } from "bun:test";
import { ChatLog } from "./view/components/chat-log.ts";
import {
  describeTool,
  isTerminalStatus,
  toolHeader,
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

describe("describeTool", () => {
  test("turns a kind into an action verb", () => {
    expect(describeTool(ev({ kind: "read" })).label).toBe("Read");
    expect(describeTool(ev({ kind: "execute" })).label).toBe("Run");
    expect(describeTool(ev({ kind: "search" })).label).toBe("Search");
  });

  test("falls back to a humanised tool name", () => {
    expect(describeTool(ev({ name: "read_file" })).label).toBe("Read file");
    expect(describeTool(ev({ name: "mcp__linear__create_issue" })).label).toBe(
      "Linear create issue",
    );
    expect(describeTool(ev()).label).toBe("Tool");
  });

  test("shows the command for a shell call", () => {
    expect(describeTool(ev({ kind: "execute", rawInput: { command: "ls -la" } }))).toEqual({
      label: "Run",
      detail: "ls -la",
    });
  });

  test("shows the path for a file call, whichever key it arrives under", () => {
    for (const key of ["file_path", "filePath", "path", "file"]) {
      expect(describeTool(ev({ kind: "read", rawInput: { [key]: "src/cli.ts" } })).detail).toBe(
        "src/cli.ts",
      );
    }
  });

  test("falls back to the touched locations", () => {
    expect(describeTool(ev({ kind: "edit", locations: ["a.ts", "b.ts"] })).detail).toBe(
      "a.ts, b.ts",
    );
  });

  test("uses the agent's own title when arguments give nothing", () => {
    // With a generic kind the title becomes the whole label, since "Tool
    // Checking the build" reads worse than the title alone.
    expect(describeTool(ev({ kind: "other", title: "Checking the build" }))).toEqual({
      label: "Checking the build",
    });
    expect(describeTool(ev({ kind: "read", title: "Checking the build" })).detail).toBe(
      "Checking the build",
    );
  });

  test("does not repeat the verb already in the title", () => {
    // Otherwise the row reads "Read  Read src/cli.ts".
    expect(describeTool(ev({ kind: "read", title: "Read src/cli.ts" }))).toEqual({
      label: "Read",
      detail: "src/cli.ts",
    });
  });

  test("a title that is only the verb leaves no detail", () => {
    expect(describeTool(ev({ kind: "read", title: "Read" })).detail).toBeUndefined();
  });

  test("collapses newlines and bounds a long detail to one row", () => {
    const d = describeTool(ev({ kind: "execute", rawInput: { command: "a\n  b\tc" } })).detail;
    expect(d).toBe("a b c");
    const long = describeTool(ev({ kind: "execute", rawInput: { command: "x".repeat(400) } }));
    expect(long.detail?.length).toBeLessThanOrEqual(120);
    expect(long.detail?.endsWith("…")).toBe(true);
  });

  test("prefers arguments over the title, since they are more specific", () => {
    expect(
      describeTool(ev({ kind: "execute", title: "Running a command", rawInput: { command: "ls" } }))
        .detail,
    ).toBe("ls");
  });

  test("summarises an unrecognised scalar rather than dropping it", () => {
    // Showing nothing left rows reading just "Weird Tool …".
    expect(describeTool(ev({ kind: "read", rawInput: { limit: 50 } })).detail).toBe("limit: 50");
  });

  test("no detail when there is genuinely nothing to say", () => {
    expect(describeTool(ev({ kind: "read", rawInput: {} })).detail).toBeUndefined();
    expect(
      describeTool(ev({ kind: "read", rawInput: { nested: { a: 1 } } })).detail,
    ).toBeUndefined();
    expect(describeTool(ev({ kind: "read" })).detail).toBeUndefined();
  });
});

describe("toolHeader", () => {
  test("reads as one action row", () => {
    expect(toolHeader("Run", "bun run check")).toBe("Run  bun run check");
  });

  test("a label with no detail stands alone", () => {
    expect(toolHeader("Run")).toBe("Run");
    expect(toolHeader("Run", "")).toBe("Run");
  });
});

describe("describeTool prefixes", () => {
  test("a prose title with a generic kind needs no 'Tool' in front", () => {
    expect(describeTool(ev({ kind: "other", title: "Thinking about it" }))).toEqual({
      label: "Thinking about it",
    });
  });

  test("a generic kind with real arguments keeps the label", () => {
    expect(describeTool(ev({ kind: "other", rawInput: { command: "ls" } }))).toEqual({
      label: "Tool",
      detail: "ls",
    });
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

  test("passes one human header row, not raw arguments", () => {
    // Raw arguments reached the view as JSON before this: `Execute {"…":"…"}`.
    const { s, calls } = sink();
    renderToolEvent(s, ev({ name: "shell", rawInput: { command: "ls -la" } }));
    expect(calls[0]?.name).toBe("Shell  ls -la");
    expect(calls[0]?.args).toBeUndefined();
  });

  test("describes a call from its title when the agent echoes no arguments", () => {
    const { s, calls } = sink();
    renderToolEvent(s, ev({ title: "Read a.ts" }));
    expect(calls[0]?.name).toBe("Read a.ts");
    expect(calls[0]?.args).toBeUndefined();
  });

  test("passes no args at all when there is nothing to describe", () => {
    // `{}` would render as a literal "{}" in the row.
    const { s, calls } = sink();
    renderToolEvent(s, ev({ kind: "read" }));
    expect(calls[0]?.args).toBeUndefined();
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

  test("no row ever shows raw JSON", () => {
    // The reported problem: rows like `Execute {"title":"…"}`.
    const out = render([
      ev({ toolCallId: "a", kind: "execute", title: "Execute", rawInput: { command: "ls -la" } }),
      ev({ toolCallId: "b", kind: "read", rawInput: { file_path: "src/cli.ts" } }),
      ev({ toolCallId: "c", name: "weird_tool", rawInput: { unknown_key: "some value" } }),
      ev({ toolCallId: "d", kind: "other", title: "Thinking about it" }),
    ]);
    expect(out).not.toContain('{"');
    expect(out).not.toContain("{}");
  });

  test("a shell call reads as an action and its command", () => {
    const out = render([
      ev({ kind: "execute", title: "Execute", rawInput: { command: "bun run check" } }),
    ]);
    expect(out).toContain("Run");
    expect(out).toContain("bun run check");
    expect(out).not.toContain("command");
  });

  test("a read shows the path, not the argument object", () => {
    const out = render([ev({ kind: "read", rawInput: { file_path: "src/env.ts", limit: 50 } })]);
    expect(out).toContain("src/env.ts");
    expect(out).not.toContain("limit");
  });

  test("an unrecognised argument shape degrades to key: value, not JSON", () => {
    const out = render([ev({ name: "weird_tool", rawInput: { unknown_key: "some value" } })]);
    expect(out).toContain("some value");
    expect(out).not.toContain('{"');
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
