import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendTurn,
  listSessions,
  newSessionId,
  parseSessionFile,
  pruneSessions,
  readSession,
  renderTranscript,
  resolveSelector,
  startSession,
  summarise,
  type SessionSummary,
} from "./sessions.ts";

describe("newSessionId", () => {
  test("is filename safe and sorts chronologically", () => {
    const a = newSessionId(new Date("2026-01-01T00:00:00Z"));
    const b = newSessionId(new Date("2026-06-01T00:00:00Z"));
    expect(a).toMatch(/^[0-9A-Za-z-]+$/);
    expect(a < b).toBe(true);
  });

  test("two ids from the same instant still differ", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(newSessionId(now)).not.toBe(newSessionId(now));
  });
});

describe("parseSessionFile", () => {
  const header = JSON.stringify({ v: 1, id: "s1", acpSessionId: "acp-1", cwd: "/r", startedAt: 5 });

  test("reads the header and the turns", () => {
    const parsed = parseSessionFile(
      [header, '{"role":"user","text":"hi"}', '{"role":"assistant","text":"hello"}'].join("\n"),
    );
    expect(parsed?.header.acpSessionId).toBe("acp-1");
    expect(parsed?.entries).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ]);
  });

  test("drops a truncated final line from an interrupted write", () => {
    // The reason for JSONL: a crash mid-append must not cost the whole file.
    const parsed = parseSessionFile(
      [header, '{"role":"user","text":"hi"}', '{"role":"us'].join("\n"),
    );
    expect(parsed?.entries).toHaveLength(1);
  });

  test("returns null without a header, since the session cannot be resumed", () => {
    expect(parseSessionFile("")).toBeNull();
    expect(parseSessionFile('{"role":"user","text":"hi"}')).toBeNull();
  });

  test("returns null when the header lacks an ACP session id", () => {
    expect(parseSessionFile(JSON.stringify({ v: 1, id: "s1" }))).toBeNull();
  });

  test("skips entries with an unknown role or missing text", () => {
    const parsed = parseSessionFile(
      [
        header,
        '{"role":"system","text":"x"}',
        '{"role":"user"}',
        '{"role":"thought","text":"t"}',
      ].join("\n"),
    );
    expect(parsed?.entries).toEqual([{ role: "thought", text: "t" }]);
  });

  test("tolerates blank lines", () => {
    const parsed = parseSessionFile([header, "", '{"role":"user","text":"hi"}', ""].join("\n"));
    expect(parsed?.entries).toHaveLength(1);
  });
});

describe("summarise", () => {
  test("counts user turns and keeps the first prompt", () => {
    const s = summarise(
      { v: 1, id: "s1", acpSessionId: "a", cwd: "/r", startedAt: 1 },
      [
        { role: "user", text: "first" },
        { role: "assistant", text: "reply" },
        { role: "user", text: "second" },
      ],
      99,
    );
    expect(s.turns).toBe(2);
    expect(s.firstPrompt).toBe("first");
    expect(s.updatedAt).toBe(99);
  });

  test("an empty session has no first prompt rather than a blank one", () => {
    const s = summarise({ v: 1, id: "s", acpSessionId: "a", cwd: "", startedAt: 0 }, [], 0);
    expect(s.firstPrompt).toBeUndefined();
    expect(s.turns).toBe(0);
  });
});

describe("resolveSelector", () => {
  const sessions: SessionSummary[] = [
    { id: "aaa111", acpSessionId: "x", cwd: "", startedAt: 0, updatedAt: 3, turns: 1 },
    { id: "bbb222", acpSessionId: "y", cwd: "", startedAt: 0, updatedAt: 2, turns: 1 },
  ];

  test("resolves a 1-based number against the displayed order", () => {
    expect(resolveSelector(sessions, "1")?.id).toBe("aaa111");
    expect(resolveSelector(sessions, "2")?.id).toBe("bbb222");
  });

  test("rejects a number outside the list rather than wrapping", () => {
    expect(resolveSelector(sessions, "0")).toBeUndefined();
    expect(resolveSelector(sessions, "3")).toBeUndefined();
  });

  test("resolves an exact id and a prefix", () => {
    expect(resolveSelector(sessions, "bbb222")?.id).toBe("bbb222");
    expect(resolveSelector(sessions, "bbb")?.id).toBe("bbb222");
  });

  test("prefers an exact id to a prefix match", () => {
    const withBoth: SessionSummary[] = [
      { ...sessions[0]!, id: "ab" },
      { ...sessions[1]!, id: "a" },
    ];
    expect(resolveSelector(withBoth, "a")?.id).toBe("a");
  });

  test("an empty or unmatched selector resolves to nothing", () => {
    expect(resolveSelector(sessions, "")).toBeUndefined();
    expect(resolveSelector(sessions, "  ")).toBeUndefined();
    expect(resolveSelector(sessions, "zzz")).toBeUndefined();
  });
});

describe("on disk", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cclaw-sessions-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("a started session round-trips through read", async () => {
    await startSession(dir, { id: "s1", acpSessionId: "acp-1", cwd: "/r", startedAt: 7 });
    await appendTurn(dir, "s1", { role: "user", text: "hi" });
    await appendTurn(dir, "s1", { role: "assistant", text: "hello" });
    const file = await readSession(dir, "s1");
    expect(file?.header.acpSessionId).toBe("acp-1");
    expect(file?.entries.map((e) => e.text)).toEqual(["hi", "hello"]);
  });

  test("creates the directory it is given", async () => {
    const nested = join(dir, "a", "b");
    await startSession(nested, { id: "s", acpSessionId: "x", cwd: "", startedAt: 0 });
    expect(await readdir(nested)).toEqual(["s.jsonl"]);
  });

  test("appendTurn does not throw when the session was never started", async () => {
    // A turn must never fail because history could not be written.
    await appendTurn(join(dir, "missing", "deeper"), "s", { role: "user", text: "x" });
  });

  test("lists sessions newest first", async () => {
    for (const id of ["s1", "s2"]) {
      await startSession(dir, { id, acpSessionId: `acp-${id}`, cwd: "", startedAt: 0 });
      await appendTurn(dir, id, { role: "user", text: id });
      await new Promise((r) => setTimeout(r, 12));
    }
    const list = await listSessions(dir);
    expect(list.map((s) => s.id)).toEqual(["s2", "s1"]);
  });

  test("skips files that are not sessions", async () => {
    await startSession(dir, { id: "s1", acpSessionId: "a", cwd: "", startedAt: 0 });
    await writeFile(join(dir, "notes.txt"), "hello");
    await writeFile(join(dir, "broken.jsonl"), "not json");
    expect((await listSessions(dir)).map((s) => s.id)).toEqual(["s1"]);
  });

  test("a missing directory lists nothing rather than throwing", async () => {
    expect(await listSessions(join(dir, "nope"))).toEqual([]);
  });

  test("reading an absent session returns null", async () => {
    expect(await readSession(dir, "nope")).toBeNull();
  });

  test("prune keeps the newest and removes the rest", async () => {
    for (const id of ["s1", "s2", "s3"]) {
      await startSession(dir, { id, acpSessionId: "a", cwd: "", startedAt: 0 });
      await new Promise((r) => setTimeout(r, 12));
    }
    expect(await pruneSessions(dir, 2)).toBe(1);
    expect((await listSessions(dir)).map((s) => s.id)).toEqual(["s3", "s2"]);
  });

  test("prune is a no-op below the limit", async () => {
    await startSession(dir, { id: "s1", acpSessionId: "a", cwd: "", startedAt: 0 });
    expect(await pruneSessions(dir, 5)).toBe(0);
  });
});

describe("renderTranscript", () => {
  test("renders turns with speaker labels", () => {
    expect(
      renderTranscript([
        { role: "user", text: "fix the failing build" },
        { role: "assistant", text: "I changed the config" },
      ]),
    ).toBe("User: fix the failing build\n\nAssistant: I changed the config");
  });

  test("omits reasoning, which is working notes rather than conversation", () => {
    const out = renderTranscript([
      { role: "thought", text: "let me think about this carefully for a while" },
      { role: "user", text: "do the thing please now" },
    ]);
    expect(out).not.toContain("think about this");
    expect(out).toContain("do the thing");
  });

  test("returns empty only when there is genuinely nothing", () => {
    expect(renderTranscript([])).toBe("");
    expect(renderTranscript([{ role: "user", text: "   " }])).toBe("");
    expect(renderTranscript([{ role: "thought", text: "just reasoning" }])).toBe("");
  });

  test("keeps a short turn, which still carries meaning", () => {
    // A length threshold here would silently drop "next" or "yes".
    expect(renderTranscript([{ role: "user", text: "next" }])).toBe("User: next");
  });

  test("drops the oldest turns when over budget and says how many", () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      role: "user" as const,
      text: `turn number ${i} with some padding text`,
    }));
    const out = renderTranscript(entries, 200);
    expect(out).toContain("earlier turn");
    // The most recent turn must survive: it determines what happens next.
    expect(out).toContain("turn number 9");
    expect(out).not.toContain("turn number 0");
  });

  test("keeps everything when within budget", () => {
    const out = renderTranscript(
      [
        { role: "user", text: "first question here" },
        { role: "assistant", text: "first answer here" },
      ],
      10_000,
    );
    expect(out).not.toContain("omitted");
  });

  test("keeps the last turn even when it alone exceeds the budget", () => {
    const out = renderTranscript([{ role: "user", text: "x".repeat(500) }], 100);
    expect(out).toContain("x".repeat(500));
  });

  test("trims whitespace around each turn", () => {
    expect(renderTranscript([{ role: "user", text: "  padded question  " }])).toBe(
      "User: padded question",
    );
  });
});
