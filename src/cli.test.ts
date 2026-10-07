import { describe, expect, test } from "bun:test";
import { parseArgv } from "./cli.ts";
import { isValidProfileName, profilePaths, resolvePaths } from "./env.ts";

describe("parseArgv", () => {
  test("no arguments yields the empty command, which dispatches to chat", () => {
    expect(parseArgv([])).toMatchObject({ command: "", noBanner: false, help: false });
  });

  test("reads -h and its long form", () => {
    expect(parseArgv(["-h"]).help).toBe(true);
    expect(parseArgv(["--help"]).help).toBe(true);
    expect(parseArgv([]).help).toBe(false);
  });

  test("--help is a flag, not a prompt, even after -p", () => {
    // Otherwise `cclaw -p --help` would send "--help" to the agent, or print
    // mode would reject it as an unknown option.
    const parsed = parseArgv(["-p", "--help"]);
    expect(parsed.help).toBe(true);
    expect(parsed.args).toEqual([]);
  });

  test("--help does not become the command, so a bare run can start chat", () => {
    // `case ""` dispatches to chat now, so --help must be caught as a flag or
    // asking for help would launch the TUI instead.
    expect(parseArgv(["--help"]).command).toBe("");
  });

  test("`help` as a word still works", () => {
    expect(parseArgv(["help"]).command).toBe("help");
  });

  test("reads a command", () => {
    expect(parseArgv(["doctor"]).command).toBe("doctor");
  });

  test("reads --profile and its short form", () => {
    expect(parseArgv(["--profile", "work"]).profile).toBe("work");
    expect(parseArgv(["-P", "home", "doctor"])).toMatchObject({
      profile: "home",
      command: "doctor",
    });
  });

  test("flags are order independent relative to the command", () => {
    expect(parseArgv(["--no-banner", "doctor"])).toMatchObject({
      command: "doctor",
      noBanner: true,
    });
    expect(parseArgv(["doctor", "--no-banner"])).toMatchObject({
      command: "doctor",
      noBanner: true,
    });
  });

  test("everything after -- is passed through untouched", () => {
    expect(parseArgv(["doctor", "--", "--profile", "x"]).args).toEqual(["--profile", "x"]);
  });

  test("reads -p and its long form", () => {
    expect(parseArgv(["-p", "hi"]).print).toBe(true);
    expect(parseArgv(["--print", "hi"]).print).toBe(true);
    expect(parseArgv(["chat"]).print).toBe(false);
  });

  test("under -p the first bare word is prompt text, not a command", () => {
    // Otherwise `cclaw -p chat about the build` would launch the TUI.
    const parsed = parseArgv(["-p", "chat", "about", "the", "build"]);
    expect(parsed.command).toBe("");
    expect(parsed.args).toEqual(["chat", "about", "the", "build"]);
  });

  test("-p still reads the profile flag", () => {
    const parsed = parseArgv(["-p", "-P", "work", "do", "it"]);
    expect(parsed.profile).toBe("work");
    expect(parsed.args).toEqual(["do", "it"]);
  });

  test("-P and -p are distinct, since only case separates them", () => {
    expect(parseArgv(["-P", "work"]).print).toBe(false);
    expect(parseArgv(["-P", "work"]).profile).toBe("work");
  });

  test("a trailing --profile with no value does not crash", () => {
    expect(parseArgv(["--profile"]).profile).toBeUndefined();
  });
});

describe("isValidProfileName", () => {
  test("accepts ordinary names", () => {
    for (const n of ["default", "work", "home", "a", "my-profile", "p_2"]) {
      expect(isValidProfileName(n)).toBe(true);
    }
  });

  test("rejects path traversal and separators", () => {
    for (const n of ["..", ".", "a/b", "../etc", "a\\b", ""]) {
      expect(isValidProfileName(n)).toBe(false);
    }
  });

  test("rejects leading punctuation and whitespace", () => {
    for (const n of ["-x", "_x", ".hidden", "a b", " a"]) {
      expect(isValidProfileName(n)).toBe(false);
    }
  });

  test("rejects names over 32 characters", () => {
    expect(isValidProfileName("a".repeat(32))).toBe(true);
    expect(isValidProfileName("a".repeat(33))).toBe(false);
  });
});

describe("paths", () => {
  test("CCLAW_HOME overrides the default root", () => {
    expect(resolvePaths({ CCLAW_HOME: "/tmp/x" }).home).toBe("/tmp/x");
  });

  test("an empty CCLAW_HOME falls back to the default rather than to ''", () => {
    expect(resolvePaths({ CCLAW_HOME: "" }).home).toMatch(/\.cclaw$/);
  });

  test("profile paths are all under the profile directory", () => {
    const p = profilePaths(resolvePaths({ CCLAW_HOME: "/tmp/x" }), "work");
    expect(p.dir).toBe("/tmp/x/profiles/work");
    expect(p.cursorConfigDir).toBe("/tmp/x/profiles/work/config");
    expect(p.cursorDataDir).toBe("/tmp/x/profiles/work/data");
    for (const v of Object.values(p)) {
      if (typeof v === "string" && v.startsWith("/")) expect(v.startsWith(p.dir)).toBe(true);
    }
  });
});
