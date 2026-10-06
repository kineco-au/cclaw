import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { policyFromConfig, readPolicyFromConfig, unwrapShellEntries } from "./profile-policy.ts";

describe("unwrapShellEntries", () => {
  test("unwraps a bare Shell rule to the command name", () => {
    expect(unwrapShellEntries(["Shell(ls)"])).toEqual(["ls"]);
  });

  test("unwraps a rule with an argument pattern", () => {
    expect(unwrapShellEntries(["Shell(git:status*)"])).toEqual(["git"]);
  });

  test("drops rules that are not shell rules", () => {
    // Read(...) and Write(...) are enforced by Cursor, not by our matcher;
    // keeping them would make them look like allowed commands.
    expect(unwrapShellEntries(["Read(/etc/**)", "Write(**)", "Shell(ls)"])).toEqual(["ls"]);
  });

  test("drops a malformed entry rather than inventing a command", () => {
    expect(unwrapShellEntries(["Shell()", "Shell", "", "ls"])).toEqual([]);
  });

  test("keeps every shell rule, in order", () => {
    expect(unwrapShellEntries(["Shell(git:log*)", "Shell(rg)", "Shell(bun:test*)"])).toEqual([
      "git",
      "rg",
      "bun",
    ]);
  });
});

describe("policyFromConfig", () => {
  test("reads both lists", () => {
    expect(
      policyFromConfig({ permissions: { allow: ["Shell(ls)"], deny: ["Shell(curl)"] } }),
    ).toEqual({ allow: ["ls"], deny: ["curl"] });
  });

  test("a config with no permissions yields empty lists", () => {
    expect(policyFromConfig({})).toEqual({ allow: [], deny: [] });
  });

  test("tolerates wrong types instead of throwing", () => {
    // A hand-edited config must not crash the agent before it starts.
    expect(policyFromConfig({ permissions: { allow: "Shell(ls)", deny: 7 } })).toEqual({
      allow: [],
      deny: [],
    });
    expect(policyFromConfig(null)).toEqual({ allow: [], deny: [] });
    expect(policyFromConfig("nonsense")).toEqual({ allow: [], deny: [] });
  });

  test("ignores non-string entries inside a list", () => {
    expect(policyFromConfig({ permissions: { allow: ["Shell(ls)", 3, null] } }).allow).toEqual([
      "ls",
    ]);
  });
});

describe("readPolicyFromConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cclaw-policy-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("reads the profile's cli-config.json", async () => {
    await writeFile(
      join(dir, "cli-config.json"),
      JSON.stringify({ permissions: { allow: ["Shell(rg)"], deny: ["Shell(aws)"] } }),
    );
    expect(await readPolicyFromConfig(dir)).toEqual({ allow: ["rg"], deny: ["aws"] });
  });

  test("a missing config yields empty lists, so the mode decides", async () => {
    expect(await readPolicyFromConfig(join(dir, "nope"))).toEqual({ allow: [], deny: [] });
  });

  test("invalid JSON yields empty lists rather than throwing", async () => {
    await writeFile(join(dir, "cli-config.json"), "{ not json");
    expect(await readPolicyFromConfig(dir)).toEqual({ allow: [], deny: [] });
  });
});
