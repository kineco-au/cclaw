import { describe, expect, test } from "bun:test";
import { applySelectionSpec } from "./model.ts";
import { parseDuration, parseLoopArgs } from "./loop.ts";
import { goalRuleBody } from "../goal.ts";
import { commandFromRequest } from "../policy/resolver.ts";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";

const catalogue = [
  { id: "auto", displayName: "Auto (default)" },
  { id: "claude-opus-5", displayName: "Claude Opus 5" },
  { id: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
  { id: "grok-4.6", displayName: "Grok 4.6" },
  { id: "gpt-5.2", displayName: "GPT-5.2" },
];

describe("applySelectionSpec", () => {
  test("selects by index", () => {
    expect(applySelectionSpec("2", catalogue, [])).toEqual(["auto", "claude-opus-5"]);
  });

  test("selects a comma list and a range", () => {
    expect(applySelectionSpec("2,4-5", catalogue, [])).toEqual([
      "auto",
      "claude-opus-5",
      "grok-4.6",
      "gpt-5.2",
    ]);
  });

  test("adds and removes by glob", () => {
    const withClaude = applySelectionSpec("+claude*", catalogue, []);
    expect(withClaude).toEqual(["auto", "claude-opus-5", "claude-sonnet-5"]);
    expect(applySelectionSpec("-claude*", catalogue, withClaude)).toEqual(["auto"]);
  });

  test("all and none", () => {
    expect(applySelectionSpec("all", catalogue, [])).toHaveLength(5);
    // `auto` is re-added: on a Free plan it is the only model that runs, so
    // dropping it would leave the profile unusable.
    expect(applySelectionSpec("none", catalogue, ["grok-4.6"])).toEqual(["auto"]);
  });

  test("result follows catalogue order regardless of spec order", () => {
    expect(applySelectionSpec("5,2", catalogue, [])).toEqual(["auto", "claude-opus-5", "gpt-5.2"]);
  });

  test("selects by exact id", () => {
    expect(applySelectionSpec("grok-4.6", catalogue, [])).toEqual(["auto", "grok-4.6"]);
  });

  test("ignores out-of-range indices and unknown ids", () => {
    expect(applySelectionSpec("99 nonsense", catalogue, [])).toEqual(["auto"]);
  });

  test("is additive over the current selection", () => {
    expect(applySelectionSpec("+gpt-5.2", catalogue, ["grok-4.6"])).toEqual([
      "auto",
      "grok-4.6",
      "gpt-5.2",
    ]);
  });
});

describe("parseDuration", () => {
  test("reads seconds, minutes and hours", () => {
    expect(parseDuration("30s")).toBe(30);
    expect(parseDuration("5m")).toBe(300);
    expect(parseDuration("2h")).toBe(7200);
  });

  test("a bare number means minutes", () => {
    expect(parseDuration("5")).toBe(300);
  });

  test("rejects nonsense rather than defaulting silently", () => {
    expect(parseDuration("soon")).toBeNull();
    expect(parseDuration("-5m")).toBeNull();
    expect(parseDuration("")).toBeNull();
  });
});

describe("parseLoopArgs", () => {
  test("defaults are bounded, so an unattended loop cannot run forever", () => {
    const { opts } = parseLoopArgs([]);
    expect(opts.maxIterations).toBeGreaterThan(0);
    expect(opts.budgetMinutes).toBeGreaterThan(0);
    expect(opts.write).toBe(false);
  });

  test("reads the prompt from bare words", () => {
    expect(parseLoopArgs(["fix", "the", "build"]).opts.prompt).toBe("fix the build");
  });

  test("reads every flag", () => {
    const { opts } = parseLoopArgs(["--every", "90s", "--max", "3", "--budget", "1h", "--write"]);
    expect(opts.intervalSeconds).toBe(90);
    expect(opts.maxIterations).toBe(3);
    expect(opts.budgetMinutes).toBe(60);
    expect(opts.write).toBe(true);
  });

  test("--once overrides the iteration count at run time", () => {
    expect(parseLoopArgs(["--once"]).opts.once).toBe(true);
  });

  test("rejects a bad budget or max rather than guessing", () => {
    expect(parseLoopArgs(["--budget", "soon"]).error).toBeDefined();
    expect(parseLoopArgs(["--max", "0"]).error).toBeDefined();
    expect(parseLoopArgs(["--max", "-1"]).error).toBeDefined();
  });

  test("flags are not mistaken for the prompt", () => {
    expect(parseLoopArgs(["--max", "3"]).opts.prompt).toBeUndefined();
  });
});

describe("goalRuleBody", () => {
  test("produces a Cursor rule that always applies", () => {
    const body = goalRuleBody("ship the thing");
    expect(body).toContain("alwaysApply: true");
    expect(body).toContain("ship the thing");
  });

  test("tells the agent to stop rather than invent work when the goal is met", () => {
    expect(goalRuleBody("x")).toMatch(/already met/i);
  });
});

describe("commandFromRequest", () => {
  const req = (toolCall: unknown): RequestPermissionRequest =>
    ({ sessionId: "s", toolCall, options: [] }) as unknown as RequestPermissionRequest;

  test("reads an explicit command argument", () => {
    expect(commandFromRequest(req({ rawInput: { command: "aws s3 ls" } }))).toBe("aws s3 ls");
    expect(commandFromRequest(req({ rawInput: { cmd: "ls -la" } }))).toBe("ls -la");
  });

  test("falls back to the backticked command in the title, as Cursor renders it", () => {
    expect(commandFromRequest(req({ title: "`head -n 1 /etc/hosts`" }))).toBe(
      "head -n 1 /etc/hosts",
    );
  });

  test("returns undefined for a non-shell tool call", () => {
    expect(commandFromRequest(req({ title: "Read file", kind: "read" }))).toBeUndefined();
    expect(commandFromRequest(req(undefined))).toBeUndefined();
  });
});
