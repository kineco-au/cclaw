import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HISTORY_FILE_LIMIT,
  appendHistory,
  loadHistory,
  parseHistory,
  seedEditorHistory,
  serialiseHistory,
} from "./history.ts";

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cclaw-hist-"));
  return join(dir, "history.jsonl");
}

describe("parseHistory", () => {
  test("reads entries oldest first", () => {
    expect(parseHistory('{"t":"one"}\n{"t":"two"}\n')).toEqual(["one", "two"]);
  });

  test("survives a truncated final line from an interrupted write", () => {
    expect(parseHistory('{"t":"kept"}\n{"t":"trunca')).toEqual(["kept"]);
  });

  test("skips blank lines and entries that are not strings", () => {
    expect(parseHistory('{"t":"a"}\n\n{"t":42}\n{"x":"b"}\n{"t":"  "}\n')).toEqual(["a"]);
  });

  test("round-trips multi-line prompts, which a line-based format would split", () => {
    const entry = "line one\nline two";
    expect(parseHistory(serialiseHistory([entry]))).toEqual([entry]);
  });

  test("an empty file yields no entries", () => {
    expect(parseHistory("")).toEqual([]);
  });
});

describe("appendHistory", () => {
  test("creates the file and appends in order", async () => {
    const f = await tmpFile();
    await appendHistory(f, "first");
    await appendHistory(f, "second");
    expect(await loadHistory(f)).toEqual(["first", "second"]);
  });

  test("ignores blanks and whitespace-only input", async () => {
    const f = await tmpFile();
    await appendHistory(f, "   ");
    await appendHistory(f, "");
    expect(await loadHistory(f)).toEqual([]);
  });

  test("skips a consecutive duplicate, matching the editor's own behaviour", async () => {
    const f = await tmpFile();
    await appendHistory(f, "same");
    await appendHistory(f, "same");
    expect(await loadHistory(f)).toEqual(["same"]);
  });

  test("keeps a repeat that is not consecutive", async () => {
    const f = await tmpFile();
    await appendHistory(f, "a");
    await appendHistory(f, "b");
    await appendHistory(f, "a");
    expect(await loadHistory(f)).toEqual(["a", "b", "a"]);
  });

  test("trims to the cap, keeping the most recent", async () => {
    const f = await tmpFile();
    const existing = Array.from({ length: HISTORY_FILE_LIMIT }, (_, i) => `e${i}`);
    await writeFile(f, serialiseHistory(existing));
    await appendHistory(f, "newest");
    const after = await loadHistory(f);
    expect(after).toHaveLength(HISTORY_FILE_LIMIT);
    expect(after.at(-1)).toBe("newest");
    expect(after[0]).toBe("e1"); // the oldest was dropped
  });

  test("a missing file reads as empty rather than throwing", async () => {
    expect(await loadHistory("/nonexistent/path/history.jsonl")).toEqual([]);
  });

  test("the written file is owner-only", async () => {
    const f = await tmpFile();
    await appendHistory(f, "secret-ish");
    const { stat } = await import("node:fs/promises");
    expect((await stat(f)).mode & 0o777).toBe(0o600);
  });

  test("the file is valid JSONL on disk", async () => {
    const f = await tmpFile();
    await appendHistory(f, "x\ny");
    const text = await readFile(f, "utf8");
    for (const line of text.split("\n").filter((l) => l !== "")) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  });
});

describe("seedEditorHistory", () => {
  test("feeds oldest first, so the newest ends up where Up finds it first", () => {
    const seen: string[] = [];
    seedEditorHistory({ addToHistory: (t) => seen.push(t) }, ["old", "mid", "new"]);
    // The editor unshifts, so feeding in this order puts "new" at the front.
    expect(seen).toEqual(["old", "mid", "new"]);
  });

  test("feeds at most the editor's own in-memory cap", () => {
    const seen: string[] = [];
    const many = Array.from({ length: 180 }, (_, i) => `e${i}`);
    seedEditorHistory({ addToHistory: (t) => seen.push(t) }, many);
    expect(seen).toHaveLength(100);
    // And it keeps the most recent 100, not the oldest.
    expect(seen.at(-1)).toBe("e179");
  });

  test("an empty history seeds nothing", () => {
    const seen: string[] = [];
    seedEditorHistory({ addToHistory: (t) => seen.push(t) }, []);
    expect(seen).toEqual([]);
  });
});
