import { describe, expect, test } from "bun:test";
import {
  buildCommands,
  parseSlash,
  runSlash,
  shortModelLabel,
  type CommandContext,
} from "./commands.ts";

function ctx(overrides: Partial<CommandContext> = {}): { c: CommandContext; said: string[] } {
  const said: string[] = [];
  let goal: string | null = null;
  const c: CommandContext = {
    models: () => ({
      current: "default[]",
      available: [
        { modelId: "default[]", name: "Auto" },
        { modelId: "composer-2.5[fast=true]", name: "composer-2.5" },
        { modelId: "claude-opus-5-5[context=300k,effort=medium]", name: "claude-opus-5-5" },
      ],
    }),
    modes: () => ({
      current: "agent",
      available: [
        { id: "agent", name: "Agent", description: "Full tool access" },
        { id: "plan", name: "Plan", description: "Read-only" },
        { id: "ask", name: "Ask", description: "Q&A only" },
      ],
    }),
    switchModel: async () => true,
    switchMode: async () => true,
    showGoal: () => goal,
    setGoal: async (t) => {
      goal = t;
    },
    clearGoal: async () => {
      goal = null;
    },
    grant: async () => {},
    newSession: async () => {},
    say: (t) => said.push(t),
    quit: () => said.push("<quit>"),
    usage: () => ({
      profile: "default",
      plan: "Free",
      cwd: "/repo",
      turns: 3,
      grants: { permanent: 1, session: 2 },
    }),
    loopRunning: () => false,
    runLoop: async () => {
      said.push("<loop started>");
    },
    busy: () => false,
    compact: async () => ({ kind: "compacted", turns: 3, summary: "we did things" }),
    ...overrides,
  };
  return { c, said };
}

describe("parseSlash", () => {
  test("splits a command from its argument", () => {
    expect(parseSlash("/model opus")).toEqual({ name: "model", arg: "opus" });
    expect(parseSlash("/model")).toEqual({ name: "model", arg: "" });
  });

  test("keeps multi-word arguments intact", () => {
    expect(parseSlash("/goal get the build green")?.arg).toBe("get the build green");
  });

  test("lowercases only the command name", () => {
    expect(parseSlash("/MODEL Opus")).toEqual({ name: "model", arg: "Opus" });
  });

  test("returns null for ordinary prompts, so they go to the agent", () => {
    expect(parseSlash("what does this do?")).toBeNull();
    expect(parseSlash("  not a command")).toBeNull();
  });
});

describe("shortModelLabel", () => {
  test("surfaces the context window and effort from a parameterised id", () => {
    expect(shortModelLabel("claude-opus-5-5[context=300k,effort=medium]", "claude-opus-5-5")).toBe(
      "claude-opus-5-5 (300k, medium)",
    );
  });

  test("reads reasoning_effort as well as effort", () => {
    expect(shortModelLabel("grok-4.7[context=256k,reasoning_effort=high]", "grok")).toBe(
      "grok (256k, high)",
    );
  });

  test("falls back to the plain name when there are no parameters", () => {
    expect(shortModelLabel("default[]", "Auto")).toBe("Auto");
    expect(shortModelLabel("plain", "Plain")).toBe("Plain");
  });
});

describe("buildCommands", () => {
  const { c } = ctx();
  const commands = buildCommands(c);

  test("exposes the commands the user asked for", () => {
    const names = commands.map((x) => x.name);
    for (const expected of ["model", "mode", "goal", "loop", "usage", "grant", "exit", "help"]) {
      expect(names).toContain(expected);
    }
  });

  test("/model completes from the live session model list", () => {
    const model = commands.find((x) => x.name === "model");
    const items = model?.getArgumentCompletions?.("") as { value: string; label: string }[];
    expect(items).toHaveLength(3);
    // The active model is marked, which is what makes the picker readable.
    expect(items.find((i) => i.label.startsWith("Auto"))?.label).toContain("✓");
  });

  test("completion inserts the readable name, not Cursor's raw id", () => {
    // Cursor's id for Auto is `default[]`, and named models carry their whole
    // parameter list; completing those into the prompt is unreadable.
    const model = commands.find((x) => x.name === "model");
    const items = model?.getArgumentCompletions?.("") as { value: string }[];
    expect(items.map((i) => i.value)).toEqual(["Auto", "composer-2.5", "claude-opus-5-5"]);
    expect(items.map((i) => i.value).join()).not.toContain("default[]");
    expect(items.map((i) => i.value).join()).not.toContain("[context=");
  });

  test("an inserted name resolves back to the right model", async () => {
    const picked: string[] = [];
    const { c } = ctx({
      switchModel: async (id) => {
        picked.push(id);
        return true;
      },
    });
    // What completion inserts must be what the matcher accepts.
    await runSlash("/model Auto", c);
    expect(picked).toEqual(["default[]"]);
  });

  test("a duplicated name falls back to the id, so the choice is never ambiguous", () => {
    const { c } = ctx({
      models: () => ({
        current: "a",
        available: [
          { modelId: "a", name: "same" },
          { modelId: "b", name: "same" },
        ],
      }),
    });
    const model = buildCommands(c).find((x) => x.name === "model");
    const items = model?.getArgumentCompletions?.("") as { value: string }[];
    expect(items.map((i) => i.value)).toEqual(["a", "b"]);
  });

  test("/model completions filter on name or id", () => {
    const model = commands.find((x) => x.name === "model");
    const byName = model?.getArgumentCompletions?.("opus") as { value: string }[];
    expect(byName).toHaveLength(1);
    expect(byName[0]?.value).toBe("claude-opus-5-5");
    // Typing part of the raw id still finds it.
    const byId = model?.getArgumentCompletions?.("context=300k") as { value: string }[];
    expect(byId).toHaveLength(1);
  });

  test("/mode completes the three modes with their descriptions", () => {
    const mode = commands.find((x) => x.name === "mode");
    const items = mode?.getArgumentCompletions?.("") as { value: string; description?: string }[];
    expect(items.map((i) => i.value)).toEqual(["agent", "plan", "ask"]);
    expect(items[1]?.description).toBe("Read-only");
  });

  test("/loop suggests iteration counts", () => {
    const loop = commands.find((x) => x.name === "loop");
    const items = loop?.getArgumentCompletions?.("") as { value: string }[];
    expect(items.map((i) => i.value)).toEqual(["3", "5", "10"]);
  });
});

describe("runSlash", () => {
  test("passes ordinary text through unhandled", async () => {
    const { c } = ctx();
    expect(await runSlash("hello there", c)).toEqual({ handled: false });
  });

  test("/model with no argument lists the models and marks the active one", async () => {
    const { c, said } = ctx();
    await runSlash("/model", c);
    expect(said[0]).toContain("composer-2.5");
    expect(said[0]).toContain("*");
  });

  test("/model switches on a partial match", async () => {
    const { c, said } = ctx();
    await runSlash("/model opus", c);
    expect(said[0]).toContain("Model is now");
    expect(said[0]).toContain("claude-opus-5-5");
  });

  test("/model reports a refused switch rather than claiming success", async () => {
    const { c, said } = ctx({ switchModel: async () => false });
    await runSlash("/model opus", c);
    expect(said[0]).toContain("would not switch");
  });

  test("/model says so when nothing matches", async () => {
    const { c, said } = ctx();
    await runSlash("/model nonsense", c);
    expect(said[0]).toContain("No model matches");
  });

  test("/mode switches and flags read-only modes", async () => {
    const { c, said } = ctx();
    await runSlash("/mode plan", c);
    expect(said[0]).toContain("read-only");
  });

  test("/goal sets, shows and clears", async () => {
    const { c, said } = ctx();
    await runSlash("/goal ship it", c);
    expect(said.at(-1)).toContain("Goal set: ship it");
    await runSlash("/goal", c);
    expect(said.at(-1)).toContain("Goal: ship it");
    await runSlash("/goal clear", c);
    expect(said.at(-1)).toContain("cleared");
  });

  test("/usage reports what we know and is honest about tokens", async () => {
    const { c, said } = ctx();
    await runSlash("/usage", c);
    expect(said[0]).toContain("Free");
    expect(said[0]).toContain("turns     3");
    expect(said[0]).toContain("1 permanent, 2 session");
    expect(said[0]).toContain("not reported over ACP");
  });

  test("/loop refuses without a goal", async () => {
    const { c, said } = ctx();
    await runSlash("/loop", c);
    expect(said[0]).toContain("No goal to work on");
  });

  test("/loop runs once a goal exists, and bounds the iteration count", async () => {
    const { c, said } = ctx();
    await runSlash("/goal x", c);
    await runSlash("/loop 5", c);
    expect(said.at(-1)).toBe("<loop started>");
    await runSlash("/loop 500", c);
    expect(said.at(-1)).toContain("1-50");
  });

  test("/loop will not start a second loop", async () => {
    const { c, said } = ctx({ loopRunning: () => true });
    await runSlash("/loop", c);
    expect(said[0]).toContain("already running");
  });

  test("/exit and /quit both quit", async () => {
    const a = ctx();
    await runSlash("/exit", a.c);
    expect(a.said).toContain("<quit>");
    const b = ctx();
    await runSlash("/quit", b.c);
    expect(b.said).toContain("<quit>");
  });

  test("/help lists every command", async () => {
    const { c, said } = ctx();
    await runSlash("/help", c);
    for (const name of ["/model", "/mode", "/goal", "/loop", "/usage", "/grant", "/exit"]) {
      expect(said[0]).toContain(name);
    }
  });

  test("an unknown command is reported, not sent to the agent", async () => {
    const { c, said } = ctx();
    const r = await runSlash("/nope", c);
    expect(r.handled).toBe(true);
    expect(said[0]).toContain("Unknown command");
  });
});

describe("/compact", () => {
  test("reports the turn count and shows the summary", async () => {
    const { c, said } = ctx();
    await runSlash("/compact", c);
    expect(said.join("\n")).toContain("Compacted 3 turns into a summary");
    expect(said.join("\n")).toContain("we did things");
  });

  test("singularises a one-turn session", async () => {
    const { c, said } = ctx({
      compact: async () => ({ kind: "compacted", turns: 1, summary: "s" }),
    });
    await runSlash("/compact", c);
    expect(said.join("\n")).toContain("Compacted 1 turn into");
  });

  test("passes a focus argument through", async () => {
    const seen: (string | undefined)[] = [];
    const { c } = ctx({
      compact: async (focus) => {
        seen.push(focus);
        return { kind: "compacted", turns: 2, summary: "s" };
      },
    });
    await runSlash("/compact keep the migration details", c);
    expect(seen).toEqual(["keep the migration details"]);
  });

  test("passes undefined rather than an empty focus", async () => {
    const seen: (string | undefined)[] = [];
    const { c } = ctx({
      compact: async (focus) => {
        seen.push(focus);
        return { kind: "compacted", turns: 2, summary: "s" };
      },
    });
    await runSlash("/compact", c);
    expect(seen).toEqual([undefined]);
  });

  test("says so when there is nothing to compact", async () => {
    const { c, said } = ctx({ compact: async () => ({ kind: "nothing" }) });
    await runSlash("/compact", c);
    expect(said.join("\n")).toContain("no turns yet");
  });

  test("an empty summary leaves the session alone", async () => {
    const { c, said } = ctx({ compact: async () => ({ kind: "unusable", reply: "" }) });
    await runSlash("/compact", c);
    // Clearing on an empty summary would lose the context and replace it with
    // nothing, which is strictly worse than not compacting.
    expect(said.join("\n")).toContain("No summary came back");
    expect(said.join("\n")).toContain("left as it was");
  });

  test("shows the reply when it was too short to be a summary", async () => {
    // Observed live: a plan-gated turn streams this as ordinary assistant
    // prose and reports end_turn, so the user needs to see it to know why.
    const { c, said } = ctx({
      compact: async () => ({ kind: "unusable", reply: "Upgrade your plan to continue" }),
    });
    await runSlash("/compact", c);
    expect(said.join("\n")).toContain("too short to be a summary");
    expect(said.join("\n")).toContain("Upgrade your plan to continue");
  });

  test("refuses while a turn is in flight, and does not call compact", async () => {
    let called = 0;
    const { c, said } = ctx({
      busy: () => true,
      compact: async () => {
        called += 1;
        return { kind: "nothing" };
      },
    });
    await runSlash("/compact", c);
    expect(called).toBe(0);
    expect(said.join("\n")).toContain("Esc cancels");
  });

  test("refuses while a loop is running", async () => {
    let called = 0;
    const { c } = ctx({
      loopRunning: () => true,
      compact: async () => {
        called += 1;
        return { kind: "nothing" };
      },
    });
    await runSlash("/compact", c);
    expect(called).toBe(0);
  });

  test("is listed, completable and described", () => {
    const entry = buildCommands(ctx().c).find((cmd) => cmd.name === "compact");
    expect(entry).toBeDefined();
    expect(entry?.description).toContain("summarise");
  });
});
