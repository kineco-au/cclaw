import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expandTemplate,
  isValidCommandName,
  loadUserCommands,
  parseCommandFile,
} from "./user-commands.ts";

describe("parseCommandFile", () => {
  test("reads the description and argument hint from frontmatter", () => {
    const p = parseCommandFile(
      ["---", "description: review the staged diff", "argument-hint: [path]", "---", "Do it."].join(
        "\n",
      ),
    );
    expect(p.description).toBe("review the staged diff");
    expect(p.argumentHint).toBe("[path]");
    expect(p.template).toBe("Do it.");
  });

  test("treats a file with no frontmatter as all template", () => {
    const p = parseCommandFile("Just the prompt.\nSecond line.");
    expect(p.description).toBe("");
    expect(p.argumentHint).toBeUndefined();
    expect(p.template).toBe("Just the prompt.\nSecond line.");
  });

  test("strips matched quotes from a value", () => {
    expect(parseCommandFile('---\ndescription: "quoted"\n---\nx').description).toBe("quoted");
    expect(parseCommandFile("---\ndescription: 'quoted'\n---\nx").description).toBe("quoted");
  });

  test("accepts argumentHint as one word too", () => {
    expect(parseCommandFile("---\nargumentHint: <id>\n---\nx").argumentHint).toBe("<id>");
  });

  test("ignores unknown keys rather than failing", () => {
    const p = parseCommandFile("---\nmodel: opus\ndescription: d\n---\nbody");
    expect(p.description).toBe("d");
    expect(p.template).toBe("body");
  });

  test("an unterminated frontmatter block is treated as body", () => {
    // Otherwise a stray leading `---` would silently eat the whole prompt.
    const p = parseCommandFile("---\ndescription: d\nstill going");
    expect(p.template).toContain("still going");
  });

  test("handles CRLF line endings", () => {
    const p = parseCommandFile("---\r\ndescription: d\r\n---\r\nbody\r\n");
    expect(p.description).toBe("d");
    expect(p.template).toBe("body");
  });

  test("an empty hint is dropped rather than shown as blank", () => {
    expect(parseCommandFile("---\nargument-hint:\n---\nx").argumentHint).toBeUndefined();
  });
});

describe("expandTemplate", () => {
  test("substitutes $ARGUMENTS", () => {
    expect(expandTemplate("Review $ARGUMENTS now", "src/a.ts")).toBe("Review src/a.ts now");
  });

  test("substitutes positional arguments", () => {
    expect(expandTemplate("Compare $1 with $2", "a.ts b.ts")).toBe("Compare a.ts with b.ts");
  });

  test("an unsupplied placeholder takes its preceding space with it", () => {
    // Otherwise a bare invocation reads as "Review  and list" with a gap.
    expect(expandTemplate("Compare $1 with $2", "a.ts")).toBe("Compare a.ts with");
    expect(expandTemplate("Review $ARGUMENTS and list defects", "")).toBe(
      "Review and list defects",
    );
    expect(expandTemplate("Check $1 now", "")).toBe("Check now");
  });

  test("keeps the placeholder's own spacing when it is filled", () => {
    expect(expandTemplate("Review $ARGUMENTS and list", "a.ts")).toBe("Review a.ts and list");
    expect(expandTemplate("Compare $1 to $2", "a b")).toBe("Compare a to b");
  });

  test("appends arguments when the template has no placeholder", () => {
    // So a command written without arguments in mind still accepts them.
    expect(expandTemplate("Review the diff.", "be harsh")).toBe("Review the diff.\n\nbe harsh");
  });

  test("does not append when the template uses a placeholder", () => {
    expect(expandTemplate("Review $ARGUMENTS", "x")).toBe("Review x");
    expect(expandTemplate("Review $1", "x")).toBe("Review x");
  });

  test("an empty argument leaves a placeholder-free template alone", () => {
    expect(expandTemplate("Review the diff.", "")).toBe("Review the diff.");
    expect(expandTemplate("Review $ARGUMENTS.", "")).toBe("Review.");
  });

  test("replaces every occurrence", () => {
    expect(expandTemplate("$ARGUMENTS then $ARGUMENTS", "go")).toBe("go then go");
  });

  test("leaves $0 alone, since only $1..$9 are placeholders", () => {
    // With no real placeholder the template counts as argument-free, so the
    // argument is appended rather than substituted.
    expect(expandTemplate("cost $0 only", "a b")).toBe("cost $0 only\n\na b");
    expect(expandTemplate("cost $0 only", "")).toBe("cost $0 only");
  });
});

describe("isValidCommandName", () => {
  test("accepts lowercase names with dashes and underscores", () => {
    for (const n of ["review", "pr-check", "x", "a_b", "test2"])
      expect(isValidCommandName(n)).toBe(true);
  });

  test("rejects names that could not be typed or would collide with paths", () => {
    for (const n of ["", "-lead", "Upper", "has space", "a/b", "..", "x".repeat(33)])
      expect(isValidCommandName(n)).toBe(false);
  });
});

describe("loadUserCommands", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cclaw-cmds-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("loads a command from a markdown file", async () => {
    await writeFile(join(dir, "review.md"), "---\ndescription: d\n---\nReview $ARGUMENTS");
    const cmds = await loadUserCommands(dir);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]?.name).toBe("review");
    expect(cmds[0]?.description).toBe("d");
    expect(cmds[0]?.template).toBe("Review $ARGUMENTS");
  });

  test("a missing directory yields no commands rather than an error", async () => {
    expect(await loadUserCommands(join(dir, "nope"))).toEqual([]);
  });

  test("ignores non-markdown files", async () => {
    await writeFile(join(dir, "notes.txt"), "hello");
    await writeFile(join(dir, "ok.md"), "prompt");
    const names = (await loadUserCommands(dir)).map((c) => c.name);
    expect(names).toEqual(["ok"]);
  });

  test("skips a file with no body, which has no prompt to send", async () => {
    await writeFile(join(dir, "empty.md"), "---\ndescription: d\n---\n   \n");
    expect(await loadUserCommands(dir)).toEqual([]);
  });

  test("skips a filename that is not a usable command name", async () => {
    await writeFile(join(dir, "has space.md"), "prompt");
    await writeFile(join(dir, "fine.md"), "prompt");
    expect((await loadUserCommands(dir)).map((c) => c.name)).toEqual(["fine"]);
  });

  test("lowercases the name so /Review and /review cannot both exist", async () => {
    await writeFile(join(dir, "Review.md"), "prompt");
    expect((await loadUserCommands(dir)).map((c) => c.name)).toEqual(["review"]);
  });

  test("falls back to a description rather than showing an empty one", async () => {
    await writeFile(join(dir, "x.md"), "prompt");
    expect((await loadUserCommands(dir))[0]?.description).toBe("custom: x");
  });

  test("returns commands in a stable order", async () => {
    for (const n of ["c", "a", "b"]) await writeFile(join(dir, `${n}.md`), "p");
    expect((await loadUserCommands(dir)).map((c) => c.name)).toEqual(["a", "b", "c"]);
  });
});
