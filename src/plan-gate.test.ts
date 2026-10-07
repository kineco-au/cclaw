import { describe, expect, test } from "bun:test";
import { isPlanGated } from "./plan-gate.ts";

describe("isPlanGated", () => {
  test("recognises the plan refusal Cursor streams as an ordinary reply", () => {
    // Verified live: this exact text arrives with stopReason "end_turn", so
    // without the check a CI run would exit 0 on a non-answer.
    expect(isPlanGated("Upgrade your plan to continue")).toBe(true);
    expect(isPlanGated("\n\nUpgrade your plan to continue")).toBe(true);
  });

  test("is case insensitive", () => {
    expect(isPlanGated("upgrade your plan")).toBe(true);
  });

  test("does not fire on an ordinary reply", () => {
    expect(isPlanGated("I upgraded the dependency plan in build.ts")).toBe(false);
    expect(isPlanGated("done")).toBe(false);
    expect(isPlanGated("")).toBe(false);
  });
});
