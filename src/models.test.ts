import { describe, expect, test } from "bun:test";
import { derivedContextWindow, humaniseTokens, parseModels, sanitiseCatalogue } from "./models.ts";

/**
 * Captured from a real `agent models` run on build 2026.08.11-e8db854.
 * Note the U+200B zero-width spaces after "Fast" on the grok-4.7 rows: they are
 * genuinely in Cursor's output and broke the first parser written against it.
 */
const REAL_OUTPUT = `Available models

auto - Auto (default)
gpt-5.3-codex-low - Codex 5.3 Low
composer-2.5 - Composer 2.5
claude-opus-5-thinking-high - Claude Opus 5 1M Thinking
claude-fable-5-thinking-high - Claude Fable 5 1M Thinking (NO ZDR)
grok-4.7-low-fast - Grok 4.7  Low Fast​​
grok-4.7-high-fast - Grok 4.7  High Fast​​
claude-opus-5-5-max-fast - Claude Opus 5.5 1M Max Fast
gemini-3.7-flash-high - Gemini 3.7 Flash
`;

describe("sanitiseCatalogue", () => {
  test("strips zero-width spaces", () => {
    expect(sanitiseCatalogue("a​b")).toBe("ab");
  });

  test("strips ANSI escapes", () => {
    expect(sanitiseCatalogue("\x1b[38;5;198mred\x1b[0m")).toBe("red");
  });

  test("converts non-breaking spaces to plain spaces", () => {
    expect(sanitiseCatalogue("a b")).toBe("a b");
  });
});

describe("parseModels", () => {
  test("parses every model row from real output", () => {
    const models = parseModels(REAL_OUTPUT);
    expect(models).toHaveLength(9);
    expect(models[0]).toEqual({ id: "auto", displayName: "Auto (default)" });
  });

  test("ignores the 'Available models' header and blank lines", () => {
    const ids = parseModels(REAL_OUTPUT).map((m) => m.id);
    expect(ids).not.toContain("Available");
    expect(ids.every((i) => i !== "")).toBe(true);
  });

  test("recovers ids whose display name carried zero-width spaces", () => {
    const m = parseModels(REAL_OUTPUT).find((x) => x.id === "grok-4.7-low-fast");
    expect(m).toBeDefined();
    expect(m?.displayName).toBe("Grok 4.7  Low Fast");
  });

  test("keeps parenthesised suffixes such as (NO ZDR)", () => {
    const m = parseModels(REAL_OUTPUT).find((x) => x.id === "claude-fable-5-thinking-high");
    expect(m?.displayName).toBe("Claude Fable 5 1M Thinking (NO ZDR)");
  });

  test("returns nothing for empty or junk input rather than throwing", () => {
    expect(parseModels("")).toEqual([]);
    expect(parseModels("not a model list at all")).toEqual([]);
  });

  test("de-duplicates repeated ids", () => {
    expect(parseModels("a - A\na - A again")).toHaveLength(1);
  });
});

describe("derivedContextWindow", () => {
  test("reads a bracketed context parameter", () => {
    expect(derivedContextWindow("claude-opus-5[context=300k]")).toBe(300_000);
    expect(derivedContextWindow("claude-opus-5[effort=high,context=1m]")).toBe(1_000_000);
  });

  test("reads a size baked into the display name", () => {
    expect(derivedContextWindow("claude-opus-5-5-high", "Claude Opus 5.5 1M High")).toBe(1_000_000);
    expect(derivedContextWindow("x", "Some Model 256K")).toBe(256_000);
  });

  test("returns 0 rather than inventing a figure", () => {
    expect(derivedContextWindow("cursor-grok-4.6-high", "Grok 4.6")).toBe(0);
    expect(derivedContextWindow("composer-2.5", "Composer 2.5")).toBe(0);
    expect(derivedContextWindow("auto", "Auto (default)")).toBe(0);
  });

  test("does not mistake a version number for a window size", () => {
    // "5.5" has no K/M suffix, so it must not be read as a size.
    expect(derivedContextWindow("composer-2.5", "Composer 2.5")).toBe(0);
  });
});

describe("humaniseTokens", () => {
  test("formats millions and thousands", () => {
    expect(humaniseTokens(1_000_000)).toBe("1.0M");
    expect(humaniseTokens(272_000)).toBe("272K");
    expect(humaniseTokens(512)).toBe("512");
  });

  test("renders unknown for non-positive or invalid values", () => {
    expect(humaniseTokens(0)).toBe("unknown");
    expect(humaniseTokens(-1)).toBe("unknown");
    expect(humaniseTokens(Number.NaN)).toBe("unknown");
  });
});
