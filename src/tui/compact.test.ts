import { describe, expect, test } from "bun:test";
import { carriedMessage, compactPrompt, isPlausibleSummary, MIN_SUMMARY_CHARS } from "./compact.ts";

describe("compactPrompt", () => {
  test("asks for the things a successor session cannot recover otherwise", () => {
    const p = compactPrompt();
    for (const required of [
      "constraint",
      "Decisions",
      "Files",
      "failed",
      "verified",
      "outstanding",
    ])
      expect(p).toContain(required);
  });

  test("insists on verbatim identifiers, since a paraphrased path is useless", () => {
    expect(compactPrompt()).toContain("verbatim");
  });

  test("adds a focus when one is given", () => {
    expect(compactPrompt("the auth refactor")).toContain("particular weight to: the auth refactor");
  });

  test("ignores a blank focus rather than asking for weight on nothing", () => {
    expect(compactPrompt("   ")).toBe(compactPrompt());
    expect(compactPrompt("")).toBe(compactPrompt());
  });

  test("trims the focus", () => {
    expect(compactPrompt("  tests  ")).toContain("weight to: tests");
  });
});

describe("carriedMessage", () => {
  test("tags the summary so it is distinguishable from what the user typed", () => {
    const m = carriedMessage("we chose bun", "now add the flag");
    expect(m).toContain("<compacted-context>");
    expect(m).toContain("</compacted-context>");
    expect(m).toContain("we chose bun");
  });

  test("puts the user's message last, outside the tag", () => {
    const m = carriedMessage("summary", "now add the flag");
    expect(m.indexOf("</compacted-context>")).toBeLessThan(m.indexOf("now add the flag"));
    expect(m.trimEnd().endsWith("now add the flag")).toBe(true);
  });

  test("says the described session is gone, so the model does not expect to recall it", () => {
    expect(carriedMessage("s", "t")).toContain("cleared");
  });

  test("trims the summary without touching the message", () => {
    expect(carriedMessage("\n\n  s  \n\n", "t")).toContain("\ns\n");
  });

  test("survives a summary that contains the tag itself", () => {
    // The model is summarising a conversation that may quote the tag back.
    const m = carriedMessage("earlier I saw </compacted-context> in a file", "carry on");
    expect(m.trimEnd().endsWith("carry on")).toBe(true);
  });
});

describe("isPlausibleSummary", () => {
  test("rejects Cursor's plan refusal, which arrives as ordinary assistant prose", () => {
    // Observed live: streamed as an agent_message_chunk, then stopReason
    // "end_turn". Nothing in the protocol marks it as a failure, so this
    // length check is the only thing standing between it and a cleared session.
    expect(isPlausibleSummary("Upgrade your plan to continue")).toBe(false);
    expect(isPlausibleSummary("\n\nUpgrade your plan to continue")).toBe(false);
  });

  test("rejects an empty or whitespace reply", () => {
    expect(isPlausibleSummary("")).toBe(false);
    expect(isPlausibleSummary("   \n\t ")).toBe(false);
  });

  test("accepts a reply of summary length", () => {
    expect(isPlausibleSummary("x".repeat(MIN_SUMMARY_CHARS))).toBe(true);
  });

  test("rejects one character below the floor", () => {
    expect(isPlausibleSummary("x".repeat(MIN_SUMMARY_CHARS - 1))).toBe(false);
  });

  test("measures the trimmed length, so padding cannot pass the floor", () => {
    expect(isPlausibleSummary(`${" ".repeat(400)}too short${" ".repeat(400)}`)).toBe(false);
  });
});

describe("carriedMessage kinds", () => {
  test("a transcript is not described as a cleared summary", () => {
    // Telling the model a replayed transcript is a summary of a cleared
    // session asserts two untrue things about its own history.
    const m = carriedMessage("User: hi", "carry on", "transcript");
    expect(m).toContain("transcript of an earlier session");
    expect(m).not.toContain("cleared");
    expect(m).not.toContain("A summary");
  });

  test("summary stays the default, so existing callers are unchanged", () => {
    expect(carriedMessage("s", "t")).toBe(carriedMessage("s", "t", "summary"));
    expect(carriedMessage("s", "t")).toContain("cleared");
  });

  test("both kinds keep the tags and the user's text", () => {
    for (const kind of ["summary", "transcript"] as const) {
      const m = carriedMessage("ctx", "what next?", kind);
      expect(m).toContain("<compacted-context>");
      expect(m).toContain("</compacted-context>");
      expect(m.endsWith("what next?")).toBe(true);
    }
  });
});
