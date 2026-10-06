import { describe, expect, test } from "bun:test";
import { parseArgv } from "./cli.ts";
import { isValidProfileName, profilePaths, resolvePaths } from "./env.ts";

describe("parseArgv", () => {
  test("no arguments yields the help command", () => {
    expect(parseArgv([])).toMatchObject({ command: "", noBanner: false });
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
