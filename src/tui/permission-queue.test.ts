import { describe, expect, test } from "bun:test";
import { PermissionQueue } from "./permission-queue.ts";

interface Ctx {
  title: string;
}

/** A queue plus a record of which requests were answered, and with what. */
function harness(): {
  q: PermissionQueue<Ctx, string>;
  add: (title: string) => void;
  answers: Map<string, string | null>;
} {
  const q = new PermissionQueue<Ctx, string>();
  const answers = new Map<string, string | null>();
  return {
    q,
    answers,
    add: (title) => {
      q.push({ title }, (a) => answers.set(title, a));
    },
  };
}

describe("PermissionQueue", () => {
  test("a second request does not discard the first", async () => {
    // The reported bug: a goal loop stopped dead after two permission
    // requests, because the first promise was never resolved.
    const h = harness();
    h.add("read a.ts");
    h.add("run ls");
    expect(h.q.size).toBe(2);
    h.q.answerHead("once");
    h.q.answerHead("once");
    expect(h.answers.get("read a.ts")).toBe("once");
    expect(h.answers.get("run ls")).toBe("once");
  });

  test("answers are applied in arrival order", () => {
    const h = harness();
    for (const t of ["first", "second", "third"]) h.add(t);
    h.q.answerHead("a");
    h.q.answerHead("b");
    h.q.answerHead("c");
    expect([...h.answers]).toEqual([
      ["first", "a"],
      ["second", "b"],
      ["third", "c"],
    ]);
  });

  test("the head is what the user is being asked about", () => {
    const h = harness();
    h.add("one");
    h.add("two");
    expect(h.q.head?.title).toBe("one");
    expect(h.q.answerHead("x")?.title).toBe("two");
    expect(h.q.head?.title).toBe("two");
  });

  test("answering the last one empties the queue", () => {
    const h = harness();
    h.add("only");
    expect(h.q.answerHead("x")).toBeUndefined();
    expect(h.q.waiting).toBe(false);
    expect(h.q.size).toBe(0);
  });

  test("push reports the position, so only the head is announced", () => {
    const h = harness();
    const q = h.q;
    expect(q.push({ title: "a" }, () => {})).toBe(1);
    expect(q.push({ title: "b" }, () => {})).toBe(2);
    expect(q.push({ title: "c" }, () => {})).toBe(3);
  });

  test("denyAll resolves every outstanding request", () => {
    // Leaving any unresolved blocks the agent on a promise nobody will settle.
    const h = harness();
    for (const t of ["a", "b", "c"]) h.add(t);
    expect(h.q.denyAll()).toBe(3);
    expect([...h.answers.values()]).toEqual([null, null, null]);
    expect(h.q.waiting).toBe(false);
  });

  test("denyAll on an empty queue is harmless", () => {
    const h = harness();
    expect(h.q.denyAll()).toBe(0);
  });

  test("answering an empty queue does nothing rather than throwing", () => {
    const h = harness();
    expect(h.q.answerHead("x")).toBeUndefined();
    expect(h.answers.size).toBe(0);
  });

  test("a request can be answered with a denial", () => {
    const h = harness();
    h.add("risky");
    h.q.answerHead(null);
    expect(h.answers.get("risky")).toBeNull();
  });

  test("the queue is reusable after being drained", () => {
    const h = harness();
    h.add("a");
    h.q.answerHead("x");
    h.add("b");
    expect(h.q.head?.title).toBe("b");
    h.q.answerHead("y");
    expect(h.answers.get("b")).toBe("y");
  });

  test("every request is settled no matter how the queue is drained", async () => {
    // The invariant that matters: an unsettled promise hangs the turn.
    const q = new PermissionQueue<Ctx, string>();
    const promises = ["a", "b", "c", "d"].map(
      (title) =>
        new Promise<string | null>((resolve) => {
          q.push({ title }, resolve);
        }),
    );
    q.answerHead("once");
    q.answerHead(null);
    q.denyAll();
    expect(await Promise.all(promises)).toEqual(["once", null, null, null]);
  });
});
