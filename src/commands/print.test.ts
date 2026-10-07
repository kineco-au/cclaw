import { describe, expect, test } from "bun:test";
import { formatResult, parsePrintArgs, recordable, type PrintResult } from "./print.ts";

const result = (over: Partial<PrintResult> = {}): PrintResult => ({
  reply: "done",
  sessionId: "s1",
  stopReason: "end_turn",
  tools: [],
  refused: [],
  isError: false,
  ...over,
});

describe("parsePrintArgs", () => {
  test("takes an unquoted prompt as the whole remaining line", () => {
    // So `cclaw -p fix the build` works without quoting.
    expect(parsePrintArgs(["fix", "the", "build"]).opts.prompt).toBe("fix the build");
  });

  test("takes a quoted prompt as one word", () => {
    expect(parsePrintArgs(["what changed in src?"]).opts.prompt).toBe("what changed in src?");
  });

  test("defaults to text output", () => {
    expect(parsePrintArgs(["hi"]).opts.format).toBe("text");
  });

  test("accepts --output-format and its --format alias", () => {
    expect(parsePrintArgs(["--output-format", "json", "hi"]).opts.format).toBe("json");
    expect(parsePrintArgs(["--format", "json", "hi"]).opts.format).toBe("json");
  });

  test("accepts --json as a shorthand", () => {
    expect(parsePrintArgs(["--json", "hi"]).opts.format).toBe("json");
  });

  test("rejects an unknown output format rather than falling back silently", () => {
    const { error } = parsePrintArgs(["--output-format", "yaml", "hi"]);
    expect(error).toContain("yaml");
  });

  test("reports a flag given no value", () => {
    expect(parsePrintArgs(["--output-format"]).error).toContain("needs a value");
    expect(parsePrintArgs(["--resume"]).error).toContain("needs a session selector");
  });

  test("reads a resume selector", () => {
    expect(parsePrintArgs(["-r", "2", "go"]).opts.resume).toBe("2");
    expect(parsePrintArgs(["--resume", "20261007-abc", "go"]).opts.resume).toBe("20261007-abc");
  });

  test("rejects an unknown option instead of treating it as prompt text", () => {
    // Silently prompting with "--max-turns 3" would waste a billed turn.
    expect(parsePrintArgs(["--max-turns", "3"]).error).toContain("--max-turns");
  });

  test("leaves the prompt unset for no arguments, so stdin can supply it", () => {
    expect(parsePrintArgs([]).opts.prompt).toBeUndefined();
  });

  test("treats a lone '-' as 'read stdin', not as a prompt", () => {
    expect(parsePrintArgs(["-"]).opts.prompt).toBeUndefined();
  });

  test("keeps flags out of the prompt text", () => {
    expect(parsePrintArgs(["--json", "summarise", "this"]).opts.prompt).toBe("summarise this");
  });
});

describe("formatResult", () => {
  test("text output is the reply alone, so it can be piped", () => {
    expect(formatResult(result({ reply: "hello" }), "text")).toBe("hello\n");
  });

  test("text output does not double the trailing newline", () => {
    expect(formatResult(result({ reply: "hello\n" }), "text")).toBe("hello\n");
  });

  test("an empty reply prints nothing in text mode", () => {
    expect(formatResult(result({ reply: "" }), "text")).toBe("");
  });

  test("json output carries the fields a script needs", () => {
    const parsed: unknown = JSON.parse(
      formatResult(
        result({
          reply: "r",
          tools: [{ name: "shell", status: "completed" }],
          refused: ["aws s3 ls"],
        }),
        "json",
      ),
    );
    expect(parsed).toEqual({
      reply: "r",
      sessionId: "s1",
      stopReason: "end_turn",
      tools: [{ name: "shell", status: "completed" }],
      refused: ["aws s3 ls"],
      isError: false,
    });
  });

  test("json output reports refusals, which text mode sends to stderr", () => {
    const text = formatResult(result({ refused: ["curl x"] }), "json");
    expect(text).toContain("curl x");
  });
});

describe("recordable", () => {
  test("records both turns when the agent replied", () => {
    expect(recordable("ask", "answer")).toEqual([
      { role: "user", text: "ask" },
      { role: "assistant", text: "answer" },
    ]);
  });

  test("records the prompt even when nothing came back", () => {
    // Otherwise a failed run leaves no trace to resume or debug.
    expect(recordable("ask", "")).toEqual([{ role: "user", text: "ask" }]);
    expect(recordable("ask", "   \n")).toEqual([{ role: "user", text: "ask" }]);
  });
});
