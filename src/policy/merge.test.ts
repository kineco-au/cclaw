import { describe, expect, test } from "bun:test";
import {
  deepMerge,
  enforcedScalarsPresent,
  mergePolicy,
  renderTemplate,
  sortKeys,
  unionArrays,
  type JsonObject,
} from "./merge.ts";

/** Shape observed in a real ~/.cursor/cli-config.json, including Cursor's own fields. */
const EXISTING: JsonObject = {
  version: 1,
  hints: false,
  model: { modelId: "grok-4.6", displayName: "Cursor Grok 4.6 High Fast" },
  runEverythingSettingsPromptStreak: 3,
  display: { mode: "compact" },
  permissions: { allow: ["Shell(ls)", "Shell(databricks)"], deny: [] },
};

const DEFAULTS: JsonObject = {
  hints: true,
  display: { mode: "zen", showThinkingBlocks: true },
};

const ENFORCE: JsonObject = {
  version: 1,
  approvalMode: "allowlist",
  sandbox: { mode: "enabled", readBoundary: "workspace" },
  permissions: { allow: ["Shell(rg)", "Shell(cat)"], deny: ["Shell(sudo)"] },
};

describe("deepMerge", () => {
  test("b wins for scalars", () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  test("nested objects merge rather than replace", () => {
    expect(deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 3 } })).toEqual({ a: { x: 1, y: 3 } });
  });

  test("arrays are replaced, not concatenated", () => {
    expect(deepMerge({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
  });

  test("a non-object on either side yields b", () => {
    expect(deepMerge(5, { a: 1 })).toEqual({ a: 1 });
    expect(deepMerge({ a: 1 }, 5)).toBe(5);
  });
});

describe("unionArrays", () => {
  test("preserves existing order and appends ours", () => {
    expect(unionArrays(["a", "b"], ["c"])).toEqual(["a", "b", "c"]);
  });

  test("de-duplicates", () => {
    expect(unionArrays(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });

  test("tolerates undefined and non-arrays", () => {
    expect(unionArrays(undefined, ["a"])).toEqual(["a"]);
    expect(unionArrays("nope", ["a"])).toEqual(["a"]);
    expect(unionArrays(undefined, undefined)).toEqual([]);
  });

  test("drops non-string members rather than crashing", () => {
    expect(unionArrays([1, "a", null], ["b"])).toEqual(["a", "b"]);
  });
});

describe("mergePolicy", () => {
  const merged = mergePolicy({ existing: EXISTING, defaults: DEFAULTS, enforce: ENFORCE });

  test("the user's own value beats our default", () => {
    // hints: default true, user false -> user wins
    expect(merged.hints).toBe(false);
  });

  test("our default fills a gap the user left", () => {
    expect((merged.display as JsonObject).showThinkingBlocks).toBe(true);
  });

  test("the user's nested value survives alongside our added one", () => {
    expect((merged.display as JsonObject).mode).toBe("compact");
  });

  test("enforced keys are asserted", () => {
    expect(merged.approvalMode).toBe("allowlist");
    expect((merged.sandbox as JsonObject).mode).toBe("enabled");
    expect((merged.sandbox as JsonObject).readBoundary).toBe("workspace");
  });

  test("Cursor's own managed fields are preserved untouched", () => {
    expect(merged.runEverythingSettingsPromptStreak).toBe(3);
    expect((merged.model as JsonObject).modelId).toBe("grok-4.6");
  });

  test("permission arrays union, keeping the user's entries", () => {
    expect(merged.permissions).toEqual({
      allow: ["Shell(ls)", "Shell(databricks)", "Shell(rg)", "Shell(cat)"],
      deny: ["Shell(sudo)"],
    });
  });

  test("is idempotent: merging the result again changes nothing", () => {
    const again = mergePolicy({ existing: merged, defaults: DEFAULTS, enforce: ENFORCE });
    expect(JSON.stringify(again)).toBe(JSON.stringify(merged));
  });

  test("an entry in both allow and deny is removed from allow, since deny wins", () => {
    const r = mergePolicy({
      existing: { permissions: { allow: ["Shell(aws)"], deny: [] } },
      defaults: {},
      enforce: { permissions: { allow: [], deny: ["Shell(aws)"] } },
    });
    expect(r.permissions).toEqual({ allow: [], deny: ["Shell(aws)"] });
  });

  test("key order is stable, so an unchanged merge is byte-identical", () => {
    const a = mergePolicy({ existing: { b: 1, a: 2 }, defaults: {}, enforce: {} });
    const b = mergePolicy({ existing: { a: 2, b: 1 }, defaults: {}, enforce: {} });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("empty inputs produce an empty object rather than throwing", () => {
    expect(mergePolicy({ existing: {}, defaults: {}, enforce: {} })).toEqual({});
  });
});

describe("enforcedScalarsPresent", () => {
  test("true when every enforced scalar landed", () => {
    const merged = mergePolicy({ existing: EXISTING, defaults: DEFAULTS, enforce: ENFORCE });
    expect(enforcedScalarsPresent(merged, ENFORCE)).toBe(true);
  });

  test("false when a scalar was not applied", () => {
    expect(
      enforcedScalarsPresent({ approvalMode: "unrestricted" }, { approvalMode: "allowlist" }),
    ).toBe(false);
  });

  test("array positions are not compared, since they are unioned", () => {
    expect(
      enforcedScalarsPresent(
        { permissions: { allow: ["x", "a"] } },
        { permissions: { allow: ["a"] } },
      ),
    ).toBe(true);
  });
});

describe("renderTemplate", () => {
  test("expands every occurrence of a placeholder", () => {
    expect(renderTemplate("@@A@@/x and @@A@@/y", { A: "/tmp" })).toBe("/tmp/x and /tmp/y");
  });

  test("leaves unknown placeholders alone rather than emptying them", () => {
    expect(renderTemplate("@@KNOWN@@ @@OTHER@@", { KNOWN: "k" })).toBe("k @@OTHER@@");
  });
});

describe("sortKeys", () => {
  test("sorts nested object keys and leaves array order alone", () => {
    expect(JSON.stringify(sortKeys({ b: 1, a: { d: 1, c: [3, 1, 2] } }))).toBe(
      '{"a":{"c":[3,1,2],"d":1},"b":1}',
    );
  });
});
