import { describe, expect, test } from "bun:test";
import {
  classify,
  classifyCatalogue,
  isSkill,
  isUsableCommandName,
  listSkills,
  shortDescription,
} from "./skills.ts";

describe("classify", () => {
  test("reads the tag Cursor appends to a skill's description", () => {
    expect(classify({ name: "morning", description: "Brief. (user skill)" }).kind).toBe(
      "user-skill",
    );
    expect(classify({ name: "autopilot", description: "Go. (builtin skill)" }).kind).toBe(
      "builtin-skill",
    );
    expect(classify({ name: "worktree", description: "Worktrees" }).kind).toBe("command");
  });

  test("treats a project skill as one of yours", () => {
    expect(classify({ name: "x", description: "d (project skill)" }).kind).toBe("user-skill");
  });

  test("is not fooled by the word skill inside a description", () => {
    expect(classify({ name: "x", description: "Teaches a skill to the model" }).kind).toBe(
      "command",
    );
  });

  test("strips the tag from the summary", () => {
    expect(classify({ name: "x", description: "Do a thing. (user skill)" }).summary).toBe(
      "Do a thing.",
    );
  });

  test("an empty description yields an empty summary, not the word undefined", () => {
    expect(classify({ name: "x", description: "" }).summary).toBe("");
  });
});

describe("shortDescription", () => {
  test("keeps a short description whole", () => {
    expect(shortDescription("Render the morning brief.")).toBe("Render the morning brief.");
  });

  test("cuts a long description at a sentence end", () => {
    const long = "Do the first thing. " + "And then a great deal more detail ".repeat(20);
    expect(shortDescription(long)).toBe("Do the first thing.");
  });

  test("bounds a long description with no sentence break", () => {
    const s = shortDescription("x".repeat(500));
    expect(s.length).toBeLessThanOrEqual(80);
    expect(s.endsWith("…")).toBe(true);
  });

  test("collapses newlines and tabs onto one line", () => {
    expect(shortDescription("a\n\tb  c")).toBe("a b c");
  });

  test("never exceeds the requested bound", () => {
    // Cursor's own `docs` description is ~900 characters and was being shown
    // in full in the completion list.
    const huge = "Lorem ipsum dolor sit amet consectetur ".repeat(40);
    for (const max of [20, 40, 80, 120]) {
      expect(shortDescription(huge, max).length).toBeLessThanOrEqual(max + 1);
    }
  });
});

describe("isUsableCommandName", () => {
  test("accepts ordinary names", () => {
    for (const n of ["morning", "create-tc-invoice", "docs", "x2"]) {
      expect(isUsableCommandName(n)).toBe(true);
    }
  });

  test("rejects deleted-plugin leftovers Cursor still indexes", () => {
    expect(isUsableCommandName(".trash-1789775496551-20062-Zy153j-computer-use")).toBe(false);
  });

  test("rejects a name carrying a directory id nobody would type", () => {
    expect(
      isUsableCommandName("synced-8506bf56-96a3-4ed2-ae4c-5cb817ed78c2_c57d2f5e-browser"),
    ).toBe(false);
  });

  test("rejects an empty name", () => {
    expect(isUsableCommandName("")).toBe(false);
    expect(isUsableCommandName("   ")).toBe(false);
  });
});

describe("listSkills", () => {
  const catalogue = [
    { name: "zeta", description: "z (user skill)" },
    { name: "builtin-b", description: "b (builtin skill)" },
    { name: "alpha", description: "a (user skill)" },
    { name: "plain", description: "not a skill" },
    { name: "builtin-a", description: "a (builtin skill)" },
    { name: ".trash-1-computer-use", description: "junk (user skill)" },
  ];

  test("returns skills only", () => {
    expect(listSkills(catalogue).map((s) => s.name)).not.toContain("plain");
  });

  test("puts your own skills first, each group alphabetical", () => {
    expect(listSkills(catalogue).map((s) => s.name)).toEqual([
      "alpha",
      "zeta",
      "builtin-a",
      "builtin-b",
    ]);
  });

  test("drops unusable names", () => {
    expect(listSkills(catalogue).some((s) => s.name.startsWith(".trash"))).toBe(false);
  });

  test("an empty catalogue yields no skills", () => {
    expect(listSkills([])).toEqual([]);
  });
});

describe("classifyCatalogue", () => {
  test("classifies and filters in one pass", () => {
    const out = classifyCatalogue([
      { name: "a", description: "x (user skill)" },
      { name: ".trash-1", description: "y (user skill)" },
    ]);
    expect(out).toHaveLength(1);
    expect(isSkill(out[0]!)).toBe(true);
  });
});
