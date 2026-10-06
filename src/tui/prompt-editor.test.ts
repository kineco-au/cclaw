import { describe, expect, test } from "bun:test";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { PromptEditor } from "./prompt-editor.ts";
import { editorTheme } from "./view/theme/theme.ts";
import { buildCommands, type CommandContext } from "./commands.ts";

/** Minimal TUI stand-in: the Editor only needs terminal size and a render hook. */
function fakeTui(): unknown {
  return {
    requestRender() {},
    addInputListener() {},
    setFocus() {},
    addChild() {},
    terminal: { rows: 40, columns: 80 },
  };
}

function editor(): PromptEditor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = new PromptEditor(fakeTui() as any, editorTheme);
  e.setPromptStyle({ prompt: (p) => p });
  return e;
}

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function commandContext(): CommandContext {
  return {
    models: () => ({ current: "d", available: [] }),
    modes: () => ({ current: "agent", available: [] }),
    switchModel: async () => true,
    switchMode: async () => true,
    showGoal: () => null,
    setGoal: async () => {},
    clearGoal: async () => {},
    grant: async () => {},
    newSession: async () => {},
    say: () => {},
    quit: () => {},
    usage: () => ({ profile: "d", cwd: "/x", turns: 0, grants: { permanent: 0, session: 0 } }),
    loopRunning: () => false,
    runLoop: async () => {},
    busy: () => false,
    compact: async () => ({ kind: "nothing" }),
    sendPrompt: () => {},
    thinking: () => false,
    setThinking: () => {},
    cursorCommands: () => [],
    userCommands: () => [],
    listSessions: async () => [],
    resume: async (selector) => ({ kind: "not-found", selector }),
  };
}

describe("PromptEditor", () => {
  test("shows the prompt and indent on the input line", () => {
    const e = editor();
    e.setText("hello world");
    const lines = e.render(60).map(strip);
    expect(lines[1]).toStartWith(" > hello world");
  });

  test("shows the prompt even when empty, so the field is always visible", () => {
    const e = editor();
    e.setText("");
    expect(strip(e.render(60)[1] ?? "")).toStartWith(" > ");
  });

  test("continuation lines align under the text, not under the prompt", () => {
    const e = editor();
    e.setText("one\ntwo");
    const lines = e.render(60).map(strip);
    expect(lines[1]).toStartWith(" > one");
    expect(lines[2]).toStartWith("   two");
    expect(lines[2]?.trim()).toBe("two");
  });

  test("every rendered line is exactly the requested width", () => {
    const e = editor();
    e.setText("hello");
    for (const line of e.render(60)) {
      expect(strip(line)).toHaveLength(60);
    }
  });

  test("the prompt style is applied to the prompt only", () => {
    const e = editor();
    e.setPromptStyle({ prompt: (p) => `<${p}>` });
    e.setText("hi");
    const line = e.render(40)[1] ?? "";
    expect(line).toContain("<> >");
    expect(line).toContain("hi");
  });

  test("narrow widths do not throw", () => {
    const e = editor();
    e.setText("hello");
    for (const w of [1, 2, 4, 8]) {
      expect(() => e.render(w)).not.toThrow();
    }
  });

  test("text wraps and stays within the width", () => {
    const e = editor();
    e.setText("a".repeat(80));
    const lines = e.render(30).map(strip);
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) expect(line).toHaveLength(30);
  });
});

/**
 * Regression: an earlier version reduced the render width and rebuilt the
 * borders, assuming super.render() returns [border, content, border]. With the
 * autocomplete popup open it also returns a separator and one row per
 * suggestion, so the "bottom border" was actually a suggestion row — rebuilt
 * from its first glyph and destroyed. Typing `/ex` showed an empty list.
 */
describe("with the autocomplete popup open", () => {
  async function typed(text: string): Promise<string[]> {
    const e = editor();
    e.setAutocompleteProvider?.(
      new CombinedAutocompleteProvider(buildCommands(commandContext()), process.cwd()),
    );
    for (const ch of text) {
      e.handleInput(ch);
      await sleep(80);
    }
    await sleep(220);
    return e.render(70).map(strip);
  }

  test("a single suggestion is not destroyed by prompt rendering", async () => {
    const lines = await typed("/ex");
    expect(lines.join("\n")).toContain("exit");
  });

  test("the prompt line still renders alongside the popup", async () => {
    const lines = await typed("/ex");
    expect(lines[1]).toStartWith(" > /ex");
  });

  test("no line is replaced by a run of a repeated glyph", async () => {
    const lines = await typed("/ex");
    for (const line of lines.slice(1)) {
      const content = line.trim();
      if (content.length < 4) continue;
      // A border is legitimately one repeated glyph; a suggestion row is not.
      const distinct = new Set(content.split(""));
      if (distinct.size === 1) expect(content.startsWith("─")).toBe(true);
    }
  });

  test("suggestions survive at several prefix lengths", async () => {
    for (const text of ["/e", "/ex", "/exi", "/exit"]) {
      expect((await typed(text)).join("\n")).toContain("exit");
    }
  });

  test("popup rows keep the requested width", async () => {
    for (const line of await typed("/ex")) {
      expect(line).toHaveLength(70);
    }
  });
});
