import { describe, expect, test } from "bun:test";
import { sanitizeRenderableLine, sanitizeRenderableText } from "./formatters.ts";
import { isImageMediaFact, readPersistedMediaFacts } from "./media-facts.ts";
import { escapeRegExp } from "./regexp.ts";
import { formatToolDetail, resolveToolDisplay } from "./tool-display.ts";

describe("sanitizeRenderableText", () => {
  test("strips ANSI escapes, so agent output cannot repaint the UI", () => {
    expect(sanitizeRenderableText("\x1b[31mred\x1b[0m")).toBe("red");
  });

  test("strips C0/C1 control characters but keeps newlines and tabs", () => {
    expect(sanitizeRenderableText("a\u0007b")).toBe("ab");
    expect(sanitizeRenderableText("a\nb\tc")).toBe("a\nb\tc");
  });

  test("strips bidi overrides, which can visually reorder text", () => {
    expect(sanitizeRenderableText("a‮b")).toBe("ab");
  });

  test("redacts a line that is mostly replacement characters", () => {
    expect(sanitizeRenderableText("�".repeat(20))).toBe("[binary data omitted]");
  });

  test("leaves ordinary text untouched", () => {
    expect(sanitizeRenderableText("hello world")).toBe("hello world");
  });
});

describe("sanitizeRenderableLine", () => {
  test("collapses whitespace to a single line for titles and rows", () => {
    expect(sanitizeRenderableLine("a   b\n\nc  ")).toBe("a b c");
  });
});

describe("escapeRegExp", () => {
  test("escapes regex metacharacters so filter input is literal", () => {
    expect(escapeRegExp("a.b*c")).toBe("a\\.b\\*c");
    expect(new RegExp(escapeRegExp("1+1")).test("1+1")).toBe(true);
  });
});

describe("media-facts adapter", () => {
  test("reports no persisted facts: Cursor keeps no sidecar", () => {
    expect(readPersistedMediaFacts({})).toBeUndefined();
  });

  test("still recognises an image fact by mime type, kind or extension", () => {
    expect(isImageMediaFact({ mimeType: "image/png" })).toBe(true);
    expect(isImageMediaFact({ kind: "image" })).toBe(true);
    expect(isImageMediaFact({ path: "/tmp/a.JPEG" })).toBe(true);
    expect(isImageMediaFact({ url: "https://x/y.webp?v=2" })).toBe(true);
  });

  test("does not treat non-images as images", () => {
    expect(isImageMediaFact({ path: "/tmp/notes.txt" })).toBe(false);
    expect(isImageMediaFact({})).toBe(false);
  });
});

describe("tool-display adapter", () => {
  test("humanises a tool name into a label", () => {
    expect(resolveToolDisplay({ name: "read_file" }).label).toBe("Read File");
    expect(resolveToolDisplay({ name: "mcp__linear__create_issue" }).label).toBe(
      "Linear Create Issue",
    );
  });

  test("falls back to a sane label for a missing name", () => {
    expect(resolveToolDisplay({}).label).toBe("Tool");
  });

  test("surfaces the most useful argument as the detail", () => {
    expect(resolveToolDisplay({ name: "shell", args: { command: "ls -la" } }).detail).toBe(
      "ls -la",
    );
    expect(resolveToolDisplay({ name: "read", args: { file_path: "/a/b.ts" } }).detail).toBe(
      "/a/b.ts",
    );
  });

  test("prefers an explicit meta over inferred args", () => {
    expect(resolveToolDisplay({ name: "x", meta: "chosen", args: { command: "no" } }).detail).toBe(
      "chosen",
    );
  });

  test("detailMode off suppresses the detail", () => {
    expect(
      resolveToolDisplay({ name: "shell", args: { command: "ls" }, detailMode: "off" }).detail,
    ).toBeUndefined();
  });

  test("formatToolDetail collapses whitespace and truncates long details", () => {
    expect(formatToolDetail({ name: "x", title: "X", label: "X", detail: "a\n  b" })).toBe("a b");
    const long = formatToolDetail({ name: "x", title: "X", label: "X", detail: "z".repeat(300) });
    expect(long?.length).toBe(160);
    expect(long?.endsWith("…")).toBe(true);
  });

  test("formatToolDetail returns undefined when there is nothing to show", () => {
    expect(formatToolDetail({ name: "x", title: "X", label: "X" })).toBeUndefined();
    expect(formatToolDetail({ name: "x", title: "X", label: "X", detail: "   " })).toBeUndefined();
  });
});
