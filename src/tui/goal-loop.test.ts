import { describe, expect, test } from "bun:test";
import {
  describeStop,
  GOAL_MET_SENTINEL,
  goalPrompt,
  runGoalLoop,
  type GoalLoopDeps,
  type GoalLoopStop,
} from "./goal-loop.ts";

interface Harness {
  deps: GoalLoopDeps;
  sent: string[];
  progress: [number, number][];
}

function harness(over: Partial<GoalLoopDeps> & { replies?: string[] } = {}): Harness {
  const sent: string[] = [];
  const progress: [number, number][] = [];
  const replies = over.replies ?? [];
  let n = 0;
  return {
    sent,
    progress,
    deps: {
      iterations: over.iterations ?? 3,
      goal: over.goal ?? ((): string | null => "get the build green"),
      send:
        over.send ??
        (async (m: string): Promise<string> => {
          sent.push(m);
          return replies[n++] ?? "still working";
        }),
      onIteration: (i, of) => progress.push([i, of]),
      ...(over.aborted !== undefined ? { aborted: over.aborted } : {}),
      ...(over.waitUntilReady !== undefined ? { waitUntilReady: over.waitUntilReady } : {}),
    },
  };
}

describe("goalPrompt", () => {
  test("carries the objective, the position and the sentinel", () => {
    const p = goalPrompt("fix the build", 2, 5);
    expect(p).toContain("fix the build");
    expect(p).toContain("iteration 2 of 5");
    expect(p).toContain(GOAL_MET_SENTINEL);
  });
});

describe("runGoalLoop", () => {
  test("keeps going until the iteration cap", async () => {
    // The reported bug was that nothing happened at all after setting a goal.
    const h = harness({ iterations: 3 });
    const stop = await runGoalLoop(h.deps);
    expect(h.sent).toHaveLength(3);
    expect(stop).toEqual({ kind: "limit", iteration: 3 });
  });

  test("sends the goal on the very first iteration", async () => {
    const h = harness({ iterations: 1 });
    await runGoalLoop(h.deps);
    expect(h.sent[0]).toContain("get the build green");
  });

  test("reports progress for each iteration", async () => {
    const h = harness({ iterations: 3 });
    await runGoalLoop(h.deps);
    expect(h.progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  test("stops as soon as the agent reports the goal met", async () => {
    const h = harness({ iterations: 5, replies: ["working", `done\n${GOAL_MET_SENTINEL}`] });
    const stop = await runGoalLoop(h.deps);
    expect(stop).toEqual({ kind: "met", iteration: 2 });
    expect(h.sent).toHaveLength(2);
  });

  test("stops on a plan refusal rather than burning the budget", async () => {
    const h = harness({ iterations: 20, replies: ["\n\nUpgrade your plan to continue"] });
    const stop = await runGoalLoop(h.deps);
    expect(stop).toEqual({ kind: "plan-gated", iteration: 1 });
    expect(h.sent).toHaveLength(1);
  });

  test("stops when cancelled, and does not start another turn", async () => {
    let cancelled = false;
    const h = harness({
      iterations: 10,
      aborted: () => cancelled,
      send: async (): Promise<string> => {
        cancelled = true;
        return "still working";
      },
    });
    const stop = await runGoalLoop(h.deps);
    expect(stop).toEqual({ kind: "cancelled", iteration: 1 });
  });

  test("a failing turn becomes an error stop, never a silent exit", async () => {
    // `void runLoop(...)` cannot observe a rejection, so the loop must not throw.
    const h = harness({
      send: async (): Promise<string> => {
        throw new Error("ACP client started but not initialized");
      },
    });
    const stop = await runGoalLoop(h.deps);
    expect(stop.kind).toBe("error");
    expect(stop.kind === "error" && stop.message).toContain("not initialized");
  });

  test("a non-Error throw still reports something", async () => {
    const h = harness({
      send: async (): Promise<string> => {
        throw "plain string";
      },
    });
    const stop = await runGoalLoop(h.deps);
    expect(stop.kind === "error" && stop.message).toBe("plain string");
  });

  test("refuses to run without a goal", async () => {
    const h = harness({ goal: () => null });
    const stop = await runGoalLoop(h.deps);
    expect(stop).toEqual({ kind: "no-goal" });
    expect(h.sent).toEqual([]);
  });

  test("treats a blank goal as no goal", async () => {
    const h = harness({ goal: () => "   \n " });
    expect((await runGoalLoop(h.deps)).kind).toBe("no-goal");
  });

  test("clearing the goal mid-loop ends it as cancelled", async () => {
    let goal: string | null = "ship it";
    const h = harness({
      iterations: 5,
      goal: () => goal,
      send: async (): Promise<string> => {
        goal = null;
        return "working";
      },
    });
    const stop = await runGoalLoop(h.deps);
    expect(stop).toEqual({ kind: "cancelled", iteration: 1 });
  });

  test("the goal is re-read each turn, so an edited goal takes effect", async () => {
    let goal = "first";
    const h = harness({
      iterations: 2,
      goal: () => goal,
      send: async (m: string): Promise<string> => {
        h.sent.push(m);
        goal = "second";
        return "working";
      },
    });
    await runGoalLoop(h.deps);
    expect(h.sent[0]).toContain("first");
    expect(h.sent[1]).toContain("second");
  });

  test("a zero or negative cap runs nothing", async () => {
    for (const iterations of [0, -1]) {
      const h = harness({ iterations });
      expect(await runGoalLoop(h.deps)).toEqual({ kind: "limit", iteration: 0 });
      expect(h.sent).toEqual([]);
    }
  });

  test("works without the optional callbacks", async () => {
    const stop = await runGoalLoop({
      iterations: 1,
      goal: () => "x",
      send: async () => "y",
    });
    expect(stop.kind).toBe("limit");
  });
});

describe("runGoalLoop waiting for an in-flight turn", () => {
  test("waits before the first turn instead of refusing to start", async () => {
    // Setting a goal mid-turn used to tell the user to run /loop themselves.
    const order: string[] = [];
    let ready = false;
    const stop = await runGoalLoop({
      iterations: 1,
      goal: () => "ship it",
      waitUntilReady: async () => {
        order.push("waited");
        ready = true;
      },
      send: async () => {
        order.push(ready ? "sent-after-wait" : "sent-too-early");
        return "working";
      },
    });
    expect(order).toEqual(["waited", "sent-after-wait"]);
    expect(stop.kind).toBe("limit");
  });

  test("waits before every turn, not just the first", async () => {
    let waits = 0;
    await runGoalLoop({
      iterations: 3,
      goal: () => "ship it",
      waitUntilReady: async () => {
        waits += 1;
      },
      send: async () => "working",
    });
    expect(waits).toBe(3);
  });

  test("cancelling while waiting does not then fire a turn", async () => {
    let cancelled = false;
    let sends = 0;
    const stop = await runGoalLoop({
      iterations: 2,
      goal: () => "ship it",
      aborted: () => cancelled,
      waitUntilReady: async () => {
        cancelled = true;
      },
      send: async () => {
        sends += 1;
        return "working";
      },
    });
    expect(sends).toBe(0);
    expect(stop.kind).toBe("cancelled");
  });

  test("a failure while waiting is reported, not swallowed", async () => {
    const stop = await runGoalLoop({
      iterations: 1,
      goal: () => "ship it",
      waitUntilReady: async () => {
        throw new Error("gave up waiting");
      },
      send: async () => "working",
    });
    expect(stop.kind === "error" && stop.message).toContain("gave up waiting");
  });
});

describe("describeStop", () => {
  const cases: [GoalLoopStop, string][] = [
    [{ kind: "met", iteration: 2 }, "goal met after 2"],
    [{ kind: "plan-gated", iteration: 1 }, "plan refused"],
    [{ kind: "cancelled", iteration: 3 }, "cancelled after 3"],
    [{ kind: "error", iteration: 1, message: "boom" }, "boom"],
    [{ kind: "no-goal" }, "no goal"],
    [{ kind: "limit", iteration: 20 }, "20-iteration limit"],
  ];

  test("every stop reason produces a message", () => {
    for (const [stop, expected] of cases) {
      expect(describeStop(stop)).toContain(expected);
    }
  });

  test("no stop reason renders as empty, so the user is never left guessing", () => {
    for (const [stop] of cases) expect(describeStop(stop).trim()).not.toBe("");
  });
});
