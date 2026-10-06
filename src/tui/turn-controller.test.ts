import { describe, expect, test } from "bun:test";
import { TurnController, type TurnControllerHooks } from "./turn-controller.ts";

interface Harness {
  ctl: TurnController;
  said: string[];
  echoed: string[];
  sent: string[];
  aborts: number;
  denies: number;
  changes: number;
  /** Finish the in-flight turn. */
  finish: () => Promise<void>;
  setPromptPending: (v: boolean) => void;
}

function harness(): Harness {
  const said: string[] = [];
  const echoed: string[] = [];
  const sent: string[] = [];
  let aborts = 0;
  let denies = 0;
  let changes = 0;
  let promptPending = false;
  let resolveTurn: (() => void) | null = null;

  const hooks: TurnControllerHooks = {
    send: (text) => {
      sent.push(text);
      return new Promise<void>((resolve) => {
        resolveTurn = resolve;
      });
    },
    abort: () => {
      aborts += 1;
    },
    denyPrompt: () => {
      denies += 1;
    },
    promptPending: () => promptPending,
    echo: (t) => echoed.push(t),
    say: (t) => said.push(t),
    changed: () => {
      changes += 1;
    },
    onError: (e) => said.push(`error:${String(e)}`),
  };

  const h: Harness = {
    ctl: new TurnController(hooks),
    said,
    echoed,
    sent,
    get aborts() {
      return aborts;
    },
    get denies() {
      return denies;
    },
    get changes() {
      return changes;
    },
    finish: async () => {
      resolveTurn?.();
      resolveTurn = null;
      // Let the finally/drain microtasks run.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    setPromptPending: (v) => {
      promptPending = v;
    },
  } as Harness;
  return h;
}

describe("submit", () => {
  test("sends immediately when idle", () => {
    const h = harness();
    expect(h.ctl.submit("hello")).toBe("sent");
    expect(h.sent).toEqual(["hello"]);
    expect(h.echoed).toEqual(["hello"]);
    expect(h.ctl.busy).toBe(true);
  });

  test("queues rather than dropping while a turn is in flight", () => {
    const h = harness();
    h.ctl.submit("first");
    expect(h.ctl.submit("second")).toBe("queued");
    // The previous behaviour silently discarded this.
    expect(h.sent).toEqual(["first"]);
    expect(h.ctl.queued).toEqual(["second"]);
    expect(h.said.join()).toContain("Queued: second");
  });

  test("ignores empty and whitespace-only input", () => {
    const h = harness();
    expect(h.ctl.submit("")).toBe("ignored");
    expect(h.ctl.submit("   ")).toBe("ignored");
    expect(h.sent).toEqual([]);
  });

  test("trims the submitted text", () => {
    const h = harness();
    h.ctl.submit("  padded  ");
    expect(h.sent).toEqual(["padded"]);
  });
});

describe("draining the queue", () => {
  test("sends queued messages in order after the turn ends", async () => {
    const h = harness();
    h.ctl.submit("one");
    h.ctl.submit("two");
    h.ctl.submit("three");
    expect(h.sent).toEqual(["one"]);
    await h.finish();
    expect(h.sent).toEqual(["one", "two"]);
    await h.finish();
    expect(h.sent).toEqual(["one", "two", "three"]);
    await h.finish();
    expect(h.ctl.busy).toBe(false);
    expect(h.ctl.queued).toEqual([]);
  });

  test("goes idle when nothing is queued", async () => {
    const h = harness();
    h.ctl.submit("only");
    await h.finish();
    expect(h.ctl.busy).toBe(false);
  });

  test("a turn that throws still drains the queue", async () => {
    const said: string[] = [];
    let first = true;
    const ctl = new TurnController({
      send: async (t) => {
        said.push(t);
        if (first) {
          first = false;
          throw new Error("boom");
        }
      },
      abort: () => {},
      denyPrompt: () => {},
      promptPending: () => false,
      echo: () => {},
      say: () => {},
      changed: () => {},
      onError: () => said.push("handled"),
    });
    ctl.submit("a");
    ctl.submit("b");
    await new Promise((r) => setTimeout(r, 5));
    expect(said).toContain("handled");
    expect(said).toContain("b");
  });
});

describe("cancel", () => {
  test("stops a running turn", () => {
    const h = harness();
    h.ctl.submit("long");
    expect(h.ctl.cancel()).toEqual({ kind: "turn-cancelled" });
    expect(h.aborts).toBe(1);
    expect(h.said.join()).toContain("Cancelled.");
  });

  test("denies a pending prompt and stops its turn", () => {
    const h = harness();
    h.ctl.submit("needs a tool");
    h.setPromptPending(true);
    expect(h.ctl.cancel()).toEqual({ kind: "prompt-denied" });
    expect(h.denies).toBe(1);
    // The turn must stop too, or the spinner hangs after a refusal.
    expect(h.aborts).toBe(1);
    expect(h.said.join()).toContain("Denied and cancelled.");
  });

  test("the prompt takes priority over the running turn", () => {
    const h = harness();
    h.ctl.submit("x");
    h.setPromptPending(true);
    expect(h.ctl.cancel().kind).toBe("prompt-denied");
  });

  test("discards the queue once nothing is running", () => {
    const h = harness();
    h.ctl.submit("running");
    h.ctl.submit("queued one");
    h.ctl.submit("queued two");
    // First Esc stops the turn.
    expect(h.ctl.cancel().kind).toBe("turn-cancelled");
    expect(h.ctl.queued).toHaveLength(2);
  });

  test("a cancelled turn does not then run the work that was queued behind it", async () => {
    const h = harness();
    h.ctl.submit("running");
    h.ctl.submit("queued");
    h.ctl.cancel();
    await h.finish();
    // Continuing would run work the user had just interrupted.
    expect(h.sent).toEqual(["running"]);
    expect(h.ctl.queued).toEqual([]);
    expect(h.said.join()).toContain("Discarded 1 queued message.");
  });

  test("pluralises the discard notice", async () => {
    const h = harness();
    h.ctl.submit("running");
    h.ctl.submit("a");
    h.ctl.submit("b");
    h.ctl.cancel();
    await h.finish();
    expect(h.said.join()).toContain("Discarded 2 queued messages.");
  });

  test("a second Esc while still cancelling escalates to the queue", () => {
    const h = harness();
    h.ctl.submit("running");
    h.ctl.submit("queued");
    expect(h.ctl.cancel().kind).toBe("turn-cancelled");
    // The turn runs until the agent acknowledges the abort, so repeating
    // "Cancelled." would be useless; the second press clears the queue instead.
    expect(h.ctl.cancel()).toEqual({ kind: "queue-discarded", count: 1 });
  });

  test("with nothing running at all, cancel discards the queue directly", async () => {
    const h = harness();
    h.ctl.submit("running");
    await h.finish();
    // Idle now. Queue something by faking a busy turn, then clear it.
    h.ctl.submit("next");
    h.ctl.submit("queued");
    h.ctl.cancel();
    expect(h.ctl.cancel()).toEqual({ kind: "queue-discarded", count: 1 });
  });

  test("does nothing when idle and empty", () => {
    const h = harness();
    expect(h.ctl.cancel()).toEqual({ kind: "nothing" });
    expect(h.aborts).toBe(0);
    expect(h.said).toEqual([]);
  });

  test("a later turn after a cancel runs normally", async () => {
    const h = harness();
    h.ctl.submit("first");
    h.ctl.cancel();
    await h.finish();
    expect(h.ctl.submit("second")).toBe("sent");
    expect(h.sent).toEqual(["first", "second"]);
  });
});

describe("state reporting", () => {
  test("notifies on every state change so the footer can follow", () => {
    const h = harness();
    const before = h.changes;
    h.ctl.submit("x");
    expect(h.changes).toBeGreaterThan(before);
  });

  test("clearQueue reports how many it dropped", () => {
    const h = harness();
    h.ctl.submit("running");
    h.ctl.submit("a");
    h.ctl.submit("b");
    expect(h.ctl.clearQueue()).toBe(2);
    expect(h.ctl.queued).toEqual([]);
  });
});
