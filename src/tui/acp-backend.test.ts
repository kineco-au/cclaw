import { describe, expect, test } from "bun:test";
import { CURSOR_AGENT_ID, flattenToolContent, toModelChoice, toToolEvent } from "./acp-backend.ts";

describe("toModelChoice", () => {
  test("maps a catalogue entry onto the contract shape", () => {
    const c = toModelChoice(
      { id: "claude-opus-5-5-high", displayName: "Claude Opus 5.5 1M High" },
      false,
    );
    expect(c.id).toBe("claude-opus-5-5-high");
    expect(c.name).toBe("Claude Opus 5.5 1M High");
    expect(c.provider).toBe("cursor");
    expect(c.available).toBe(true);
  });

  test("carries a derived context window when one can be inferred", () => {
    const c = toModelChoice({ id: "x", displayName: "Model 1M High" }, false);
    expect(c.contextWindow).toBe(1_000_000);
  });

  test("omits the context window rather than guessing when none is derivable", () => {
    const c = toModelChoice({ id: "composer-2.5", displayName: "Composer 2.5" }, false);
    expect(c.contextWindow).toBeUndefined();
  });

  test("on a Free plan only auto is available", () => {
    const auto = toModelChoice({ id: "auto", displayName: "Auto (default)" }, true);
    expect(auto.available).toBe(true);
    expect(auto.unavailableReason).toBeUndefined();

    const named = toModelChoice({ id: "gpt-5.2", displayName: "GPT-5.2" }, true);
    expect(named.available).toBe(false);
    // The contract's unavailableReason is a fixed union with no member meaning
    // "plan forbids this", so it is deliberately left unset.
    expect(named.unavailableReason).toBeUndefined();
  });

  test("on a paid plan every model is available", () => {
    expect(toModelChoice({ id: "gpt-5.2", displayName: "GPT-5.2" }, false).available).toBe(true);
  });
});

describe("agent identity", () => {
  test("Cursor presents as a single agent", () => {
    // The contract requires an agent id; Cursor has no multi-agent concept, so
    // this is synthesised and must stay stable for view code that keys off it.
    expect(CURSOR_AGENT_ID).toBe("cursor");
  });
});

describe("flattenToolContent", () => {
  test("flattens nested content blocks", () => {
    expect(
      flattenToolContent([
        { type: "content", content: { type: "text", text: "line one" } },
        { type: "content", content: { type: "text", text: "line two" } },
      ]),
    ).toBe("line one\nline two");
  });

  test("accepts text inlined on the block, as some agents send it", () => {
    expect(flattenToolContent([{ type: "content", text: "inline" }])).toBe("inline");
  });

  test("summarises a diff rather than dropping it", () => {
    // Dropping the block would make an edit look like it did nothing.
    const out = flattenToolContent([
      { type: "diff", path: "src/a.ts", oldText: "a\nb", newText: "a\nb\nc" },
    ]);
    expect(out).toBe("src/a.ts  +3 -2");
  });

  test("counts an added file as no removals", () => {
    expect(flattenToolContent([{ type: "diff", path: "new.ts", newText: "x" }])).toBe(
      "new.ts  +1 -0",
    );
  });

  test("names a terminal block, which we cannot read", () => {
    // We advertise no terminal methods, so it can only be reported.
    expect(flattenToolContent([{ type: "terminal", terminalId: "t1" }])).toBe("[terminal t1]");
    expect(flattenToolContent([{ type: "terminal" }])).toBe("[terminal]");
  });

  test("returns empty for nothing usable", () => {
    expect(flattenToolContent(undefined)).toBe("");
    expect(flattenToolContent([])).toBe("");
    expect(flattenToolContent("not an array")).toBe("");
    expect(flattenToolContent([null, 7, {}])).toBe("");
  });

  test("mixes block types in order", () => {
    expect(
      flattenToolContent([
        { type: "content", content: { text: "before" } },
        { type: "diff", path: "p", oldText: "", newText: "x" },
      ]),
    ).toBe("before\np  +1 -0");
  });
});

describe("toToolEvent", () => {
  test("maps a tool_call payload", () => {
    const ev = toToolEvent(
      {
        toolCallId: "t1",
        title: "Read src/cli.ts",
        kind: "read",
        status: "pending",
        rawInput: { path: "src/cli.ts" },
        locations: [{ path: "src/cli.ts" }],
      },
      "start",
    );
    expect(ev).toMatchObject({
      phase: "start",
      toolCallId: "t1",
      title: "Read src/cli.ts",
      kind: "read",
      status: "pending",
      locations: ["src/cli.ts"],
    });
  });

  test("returns null without an id, since there is nothing to upsert against", () => {
    expect(toToolEvent({ title: "x" }, "start")).toBeNull();
    expect(toToolEvent({ toolCallId: "" }, "start")).toBeNull();
    expect(toToolEvent({ toolCallId: 7 }, "start")).toBeNull();
  });

  test("ignores a status outside the protocol's four values", () => {
    expect(toToolEvent({ toolCallId: "t", status: "weird" }, "update")?.status).toBeUndefined();
  });

  test("carries the flattened output", () => {
    const ev = toToolEvent(
      { toolCallId: "t", status: "completed", content: [{ type: "content", text: "done" }] },
      "update",
    );
    expect(ev?.output).toBe("done");
    expect(ev?.status).toBe("completed");
  });

  test("omits absent fields rather than setting them undefined", () => {
    const ev = toToolEvent({ toolCallId: "t" }, "update");
    expect(Object.keys(ev ?? {}).sort()).toEqual(["phase", "toolCallId"]);
  });

  test("drops locations with no usable path", () => {
    const ev = toToolEvent({ toolCallId: "t", locations: [{}, { path: 1 }, null] }, "start");
    expect(ev?.locations).toBeUndefined();
  });

  test("keeps the update phase distinct from the start", () => {
    expect(toToolEvent({ toolCallId: "t" }, "update")?.phase).toBe("update");
  });
});
