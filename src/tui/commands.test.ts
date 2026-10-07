import { describe, expect, test } from "bun:test";
import {
  buildCommands,
  describeSession,
  GOAL_ITERATIONS,
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
    savedGoal: () => null,
    reloadSkills: async () => {
      said.push("<skills reloaded>");
      return { kind: "reloaded", skills: 19, own: 2, contextCarried: false };
    },
    resumeGoal: async () => {
      said.push("<goal resumed>");
      return true;
    },
    loopRunning: () => false,
    runLoop: async () => {
      said.push("<loop started>");
    },
    busy: () => false,
    compact: async () => ({ kind: "compacted", turns: 3, summary: "we did things" }),
    sendPrompt: (t) => said.push(`<prompt>${t}`),
    thinking: () => false,
    setThinking: () => {},
    cursorCommands: () => [],
    userCommands: () => [],
    listSessions: async () => [],
    resume: async (selector) => ({ kind: "not-found", selector }),
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
    expect(said.some((s) => s.includes("Goal set: ship it"))).toBe(true);
    said.length = 0;
    await runSlash("/goal", c);
    expect(said.at(-1)).toContain("Goal: ship it");
    await runSlash("/goal clear", c);
    expect(said.at(-1)).toContain("cleared");
  });

  test("/goal reports a saved goal rather than claiming none is set", async () => {
    const { c, said } = ctx({ savedGoal: () => "get the build green" });
    await runSlash("/goal", c);
    expect(said[0]).toContain("No goal in effect");
    expect(said[0]).toContain("get the build green");
    expect(said[0]).toContain("/goal resume");
  });

  test("/goal resume takes up the saved goal", async () => {
    const { c, said } = ctx({ savedGoal: () => "get the build green" });
    await runSlash("/goal resume", c);
    expect(said).toContain("<goal resumed>");
  });

  test("/goal resume says so when there is nothing saved", async () => {
    const { c, said } = ctx({ resumeGoal: async () => false });
    await runSlash("/goal resume", c);
    expect(said.at(-1)).toContain("No saved goal");
  });

  test("/goal resume does not re-adopt a goal already in effect", async () => {
    const { c, said } = ctx({ showGoal: () => "already working this" });
    await runSlash("/goal resume", c);
    expect(said).not.toContain("<goal resumed>");
    expect(said[0]).toContain("already in effect");
  });

  test("/goal resume is not treated as a new goal named 'resume'", async () => {
    // Otherwise the standing objective would literally become "resume".
    const { c, said } = ctx({ savedGoal: () => "x" });
    await runSlash("/goal resume", c);
    expect(said.some((s) => s.includes("Goal set: resume"))).toBe(false);
  });

  test("/goal offers resume in its completions only when something is saved", async () => {
    const withSaved = buildCommands(ctx({ savedGoal: () => "ship it" }).c);
    const goalCmd = withSaved.find((c) => c.name === "goal");
    const items = await goalCmd?.getArgumentCompletions?.("");
    expect(items?.map((i) => i.value)).toContain("resume");

    const without = buildCommands(ctx().c);
    const bare = await without.find((c) => c.name === "goal")?.getArgumentCompletions?.("");
    expect(bare?.map((i) => i.value)).not.toContain("resume");
  });

  test("/goal starts working the goal, not just recording it", async () => {
    // Setting a goal and stopping was the bug: a goal is to be pursued.
    const { c, said } = ctx();
    await runSlash("/goal get the build green", c);
    expect(said.at(-1)).toBe("<loop started>");
    expect(said.some((s) => s.includes(`${GOAL_ITERATIONS} iterations`))).toBe(true);
    expect(said.some((s) => s.includes("Esc stops"))).toBe(true);
  });

  test("/goal with no argument shows without starting work", async () => {
    const { c, said } = ctx();
    await runSlash("/goal", c);
    expect(said).not.toContain("<loop started>");
  });

  test("/goal clear does not start work", async () => {
    const { c, said } = ctx();
    await runSlash("/goal clear", c);
    expect(said).not.toContain("<loop started>");
  });

  test("/goal starts the loop even while a turn is running", async () => {
    // Deferring and telling the user to run /loop themselves was the bug:
    // setting a goal should begin work, waiting for the turn if need be.
    const { c, said } = ctx({ busy: () => true });
    await runSlash("/goal ship it", c);
    expect(said.some((s) => s.includes("Goal set: ship it"))).toBe(true);
    expect(said).toContain("<loop started>");
    expect(said.some((s) => s.includes("once the current turn finishes"))).toBe(true);
  });

  test("/goal does not start a second loop", async () => {
    const { c, said } = ctx({ loopRunning: () => true });
    await runSlash("/goal ship it", c);
    expect(said.some((s) => s.includes("Goal set: ship it"))).toBe(true);
    expect(said).not.toContain("<loop started>");
    expect(said.at(-1)).toContain("already running");
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

describe("/thinking", () => {
  test("reports the current state with no argument", async () => {
    const { c, said } = ctx();
    await runSlash("/thinking", c);
    expect(said.join()).toContain("hidden");
  });

  test("turns reasoning on and off", async () => {
    let on = false;
    const { c, said } = ctx({ thinking: () => on, setThinking: (v) => void (on = v) });
    await runSlash("/thinking on", c);
    expect(on).toBe(true);
    await runSlash("/thinking off", c);
    expect(on).toBe(false);
    expect(said.join()).toContain("Reasoning");
  });

  test("rejects anything but on and off", async () => {
    let calls = 0;
    const { c, said } = ctx({ setThinking: () => void (calls += 1) });
    await runSlash("/thinking maybe", c);
    expect(calls).toBe(0);
    expect(said.join()).toContain("Usage:");
  });

  test("is case-insensitive", async () => {
    let on = false;
    const { c } = ctx({ setThinking: (v) => void (on = v) });
    await runSlash("/thinking ON", c);
    expect(on).toBe(true);
  });

  test("marks the active state in completions", async () => {
    const entry = buildCommands(ctx({ thinking: () => true }).c).find((x) => x.name === "thinking");
    const items = (await entry?.getArgumentCompletions?.("")) ?? [];
    const labels = items.map((i) => i.label);
    expect(labels).toContain("on ✓");
    expect(labels).toContain("off");
  });
});

describe("/resume", () => {
  const sessions = [
    {
      id: "aaa",
      acpSessionId: "x",
      cwd: "/r",
      startedAt: 0,
      updatedAt: 1_760_000_000_000,
      turns: 4,
      firstPrompt: "fix the build",
    },
    {
      id: "bbb",
      acpSessionId: "y",
      cwd: "/r",
      startedAt: 0,
      updatedAt: 1_750_000_000_000,
      turns: 1,
    },
  ];

  test("lists sessions when given no argument", async () => {
    const { c, said } = ctx({ listSessions: async () => sessions });
    await runSlash("/resume", c);
    expect(said.join("\n")).toContain("fix the build");
    expect(said.join("\n")).toContain("1.");
  });

  test("says so when nothing has been saved", async () => {
    const { c, said } = ctx({ listSessions: async () => [] });
    await runSlash("/resume", c);
    expect(said.join()).toContain("No saved sessions");
  });

  test("says so when the transcript had to be replayed instead of reopened", async () => {
    const { c, said } = ctx({
      listSessions: async () => sessions,
      resume: async () => ({ kind: "resumed", session: sessions[0]!, mode: "replayed" }),
    });
    await runSlash("/resume 1", c);
    expect(said.join()).toContain("Resumed");
    expect(said.join()).toContain("carried into your next message");
  });

  test("stays quiet about the mechanism on a native resume", async () => {
    const { c, said } = ctx({
      listSessions: async () => sessions,
      resume: async () => ({ kind: "resumed", session: sessions[0]!, mode: "native" }),
    });
    await runSlash("/resume 1", c);
    expect(said.join()).not.toContain("carried into");
  });

  test("passes the selector through and reports success", async () => {
    const seen: string[] = [];
    const { c, said } = ctx({
      listSessions: async () => sessions,
      resume: async (sel) => {
        seen.push(sel);
        return { kind: "resumed", session: sessions[0]!, mode: "native" };
      },
    });
    await runSlash("/resume 1", c);
    expect(seen).toEqual(["1"]);
    expect(said.join()).toContain("Resumed");
  });

  test("reports an unmatched selector", async () => {
    const { c, said } = ctx({ listSessions: async () => sessions });
    await runSlash("/resume zzz", c);
    expect(said.join()).toContain("No session matches 'zzz'");
  });

  test("surfaces the reason when the resume itself fails", async () => {
    const { c, said } = ctx({
      listSessions: async () => sessions,
      resume: async () => ({ kind: "failed", reason: "agent refused" }),
    });
    await runSlash("/resume 1", c);
    expect(said.join()).toContain("agent refused");
  });

  test("refuses while a turn is in flight, and does not resume", async () => {
    let calls = 0;
    const { c, said } = ctx({
      busy: () => true,
      resume: async (selector) => {
        calls += 1;
        return { kind: "not-found", selector };
      },
    });
    await runSlash("/resume 1", c);
    expect(calls).toBe(0);
    expect(said.join()).toContain("Esc cancels");
  });

  test("describeSession shows the turn count and prompt", () => {
    const line = describeSession(sessions[0]!);
    expect(line).toContain("4 turns");
    expect(line).toContain("fix the build");
  });

  test("describeSession truncates a long prompt and flattens newlines", () => {
    const line = describeSession({ ...sessions[0]!, firstPrompt: `${"x".repeat(80)}\nmore` });
    expect(line).toContain("…");
    expect(line).not.toContain("\n");
  });

  test("describeSession tolerates a session with no prompt", () => {
    expect(describeSession(sessions[1]!)).toContain("(no prompt)");
  });
});

describe("discovered commands", () => {
  const cursor = [
    { name: "cursor-thing", description: "a Cursor built-in" },
    { name: "model", description: "Cursor's own model command" },
  ];
  const mine = [
    {
      name: "review",
      description: "review the diff",
      template: "Review $ARGUMENTS",
      path: "/p/review.md",
    },
    { name: "clear", description: "shadow attempt", template: "nope", path: "/p/clear.md" },
  ];

  test("lists Cursor's commands alongside ours", () => {
    const names = buildCommands(ctx({ cursorCommands: () => cursor }).c).map((c) => c.name);
    expect(names).toContain("cursor-thing");
    expect(names).toContain("model");
  });

  test("ours win a name collision, so /model stays the switcher", () => {
    const cmds = buildCommands(ctx({ cursorCommands: () => cursor }).c);
    expect(cmds.filter((c) => c.name === "model")).toHaveLength(1);
    expect(cmds.find((c) => c.name === "model")?.description).toBe(
      "switch the model for this session",
    );
  });

  test("a user's file wins over a Cursor command of the same name", () => {
    const cmds = buildCommands(
      ctx({
        cursorCommands: () => [{ name: "review", description: "cursor review" }],
        userCommands: () => mine,
      }).c,
    );
    expect(cmds.filter((c) => c.name === "review")).toHaveLength(1);
    expect(cmds.find((c) => c.name === "review")?.description).toBe("review the diff");
  });

  test("a user file cannot shadow a built-in", () => {
    const cmds = buildCommands(ctx({ userCommands: () => mine }).c);
    expect(cmds.find((c) => c.name === "clear")?.description).toBe("start a new session");
  });

  test("a user command sends its expanded template as a prompt", async () => {
    const { c, said } = ctx({ userCommands: () => mine });
    await runSlash("/review src/a.ts", c);
    expect(said.join()).toContain("<prompt>Review src/a.ts");
  });

  test("a Cursor command is forwarded verbatim for Cursor to parse", async () => {
    const { c, said } = ctx({ cursorCommands: () => cursor });
    await runSlash("/cursor-thing arg here", c);
    expect(said.join()).toContain("<prompt>/cursor-thing arg here");
  });

  test("a Cursor command with no argument keeps its leading slash", async () => {
    const { c, said } = ctx({ cursorCommands: () => cursor });
    await runSlash("/cursor-thing", c);
    expect(said.join()).toContain("<prompt>/cursor-thing");
  });

  test("an unknown name is still reported rather than sent to the agent", async () => {
    const { c, said } = ctx();
    await runSlash("/nonsense", c);
    expect(said.join()).toContain("Unknown command '/nonsense'");
    expect(said.join()).not.toContain("<prompt>");
  });

  test("a description-less Cursor command still gets a label", () => {
    const cmds = buildCommands(ctx({ cursorCommands: () => [{ name: "x", description: "" }] }).c);
    expect(cmds.find((c) => c.name === "x")?.description).toBe("cursor");
  });
});

describe("skills in the command list", () => {
  const catalogue = [
    { name: "morning", description: "Render the morning brief. (user skill)" },
    { name: "autopilot", description: "Keep going autonomously. (builtin skill)" },
    { name: "worktree", description: "Manage worktrees" },
    { name: ".trash-1789-abc-computer-use", description: "junk (user skill)" },
    {
      name: "synced-8506bf56-96a3-4ed2-ae4c-5cb817ed78c2-browser",
      description: "junk (user skill)",
    },
  ];

  test("a user skill is labelled as a skill in the completions", () => {
    const cmds = buildCommands(ctx({ cursorCommands: () => catalogue }).c);
    expect(cmds.find((c) => c.name === "morning")?.description).toBe(
      "skill · Render the morning brief.",
    );
  });

  test("Cursor's own skills are distinguished from your own", () => {
    const cmds = buildCommands(ctx({ cursorCommands: () => catalogue }).c);
    expect(cmds.find((c) => c.name === "autopilot")?.description).toStartWith("cursor skill · ");
    expect(cmds.find((c) => c.name === "worktree")?.description).toStartWith("cursor · ");
  });

  test("deleted-plugin leftovers are not offered", () => {
    const names = buildCommands(ctx({ cursorCommands: () => catalogue }).c).map((c) => c.name);
    expect(names).not.toContain(".trash-1789-abc-computer-use");
    expect(names.some((n) => n.startsWith("synced-8506bf56"))).toBe(false);
    expect(names).toContain("morning");
  });

  test("/skills groups yours before Cursor's and counts them", async () => {
    const { c, said } = ctx({ cursorCommands: () => catalogue });
    await runSlash("/skills", c);
    expect(said[0]).toContain("Your skills (1)");
    expect(said[0]).toContain("/morning");
    expect(said[0]).toContain("Cursor's skills (1)");
    expect(said[0]).toContain("/autopilot");
    // Plain commands are not skills.
    expect(said[0]).not.toContain("/worktree");
    expect(said[0]?.indexOf("Your skills")).toBeLessThan(said[0]?.indexOf("Cursor's skills") ?? 0);
  });

  test("/skills says so when there are none", async () => {
    const { c, said } = ctx({ cursorCommands: () => [] });
    await runSlash("/skills", c);
    expect(said[0]).toContain("No skills found");
  });

  test("/reload-skills reloads and reports the counts", async () => {
    const { c, said } = ctx();
    await runSlash("/reload-skills", c);
    expect(said).toContain("<skills reloaded>");
    expect(said.at(-1)).toContain("19 skill(s)");
    expect(said.at(-1)).toContain("2 profile command(s)");
  });

  test("/reload-skills refuses mid-turn rather than dropping the session", async () => {
    // Reloading replaces the ACP session, so doing it mid-turn would lose it.
    const { c, said } = ctx({ busy: () => true });
    await runSlash("/reload-skills", c);
    expect(said).not.toContain("<skills reloaded>");
    expect(said[0]).toContain("Wait for the current turn");
  });

  test("/reload-skills explains when context had to be carried", async () => {
    const { c, said } = ctx({
      reloadSkills: async () => ({ kind: "reloaded", skills: 3, own: 0, contextCarried: true }),
    });
    await runSlash("/reload-skills", c);
    expect(said.at(-1)).toContain("carried into your next message");
  });

  test("/reload-skills reports a failure instead of claiming success", async () => {
    const { c, said } = ctx({
      reloadSkills: async () => ({ kind: "failed", reason: "no session" }),
    });
    await runSlash("/reload-skills", c);
    expect(said.at(-1)).toContain("Could not reload: no session");
  });
});
