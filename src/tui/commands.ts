/**
 * Slash commands for the chat TUI.
 *
 * Shaped for pi-tui's `CombinedAutocompleteProvider`, which handles both `/`
 * command completion and `@` file completion. `getArgumentCompletions` is what
 * makes `/model <tab>` offer the live model list rather than making you type an
 * id like `claude-opus-5-5[context=300k,effort=medium,fast=false]` by hand.
 *
 * Model and mode come from the ACP session itself (session/new advertises both),
 * so the completions are exactly what this session will accept.
 */

import type { AutocompleteItem, SlashCommand } from "@earendil-works/pi-tui";

export interface CommandContext {
  /** Models the live session will accept. */
  models: () => { current?: string; available: { modelId: string; name: string }[] };
  modes: () => {
    current?: string;
    available: { id: string; name: string; description?: string }[];
  };
  switchModel: (modelId: string) => Promise<boolean>;
  switchMode: (modeId: string) => Promise<boolean>;
  setGoal: (text: string) => Promise<void>;
  clearGoal: () => Promise<void>;
  showGoal: () => string | null;
  grant: (command: string) => Promise<void>;
  newSession: () => Promise<void>;
  say: (text: string) => void;
  quit: () => void;
  /** Static facts for /usage: Cursor reports no token usage over ACP. */
  usage: () => {
    profile: string;
    plan?: string;
    cwd: string;
    turns: number;
    grants: { permanent: number; session: number };
  };
  /** Run n iterations of the goal in this session, reporting progress. */
  runLoop: (iterations: number) => Promise<void>;
  loopRunning: () => boolean;
  /** True while a turn is in flight. */
  busy: () => boolean;
  /** Summarise this session, then replace it with a fresh one. */
  compact: (focus?: string) => Promise<CompactOutcome>;
}

export type CompactOutcome =
  /** The session was replaced; the summary is carried into the next message. */
  | { kind: "compacted"; turns: number; summary: string }
  /** The reply was not a usable summary, so the session was left untouched. */
  | { kind: "unusable"; reply: string }
  /** No turns yet — there is no context to summarise. */
  | { kind: "nothing" };

export interface CommandResult {
  handled: boolean;
}

/** Shorten a parameterised model id for display: keeps the id, drops the noise. */
export function shortModelLabel(modelId: string, name: string): string {
  const params = /\[(.+)\]$/.exec(modelId)?.[1];
  if (params === undefined) return name;
  const ctx = /context=([0-9]+[kKmM]?)/.exec(params)?.[1];
  const effort = /(?:reasoning_)?effort=([a-z]+)/.exec(params)?.[1];
  const bits = [ctx, effort].filter((b): b is string => b !== undefined);
  return bits.length > 0 ? `${name} (${bits.join(", ")})` : name;
}

export function buildCommands(ctx: CommandContext): SlashCommand[] {
  return [
    {
      name: "model",
      description: "switch the model for this session",
      argumentHint: "<model>",
      getArgumentCompletions: (prefix: string): AutocompleteItem[] => {
        const { available, current } = ctx.models();
        const needle = prefix.trim().toLowerCase();
        // Count names so a duplicate falls back to the id rather than becoming
        // ambiguous. Names are unique in practice, but inserting a name that
        // matches two models would make the choice arbitrary.
        const nameCounts = new Map<string, number>();
        for (const m of available) {
          nameCounts.set(m.name, (nameCounts.get(m.name) ?? 0) + 1);
        }
        return available
          .filter(
            (m) =>
              needle === "" ||
              m.name.toLowerCase().includes(needle) ||
              m.modelId.toLowerCase().includes(needle),
          )
          .map((m) => ({
            // Insert the readable name, not the raw id. Cursor's id for Auto is
            // `default[]`, and named models carry their whole parameter list —
            // completing those into the prompt is unreadable. runSlash resolves
            // a name back to its id by exact match before any partial match.
            value: (nameCounts.get(m.name) ?? 0) > 1 ? m.modelId : m.name,
            label: m.modelId === current ? `${m.name} ✓` : m.name,
            description: shortModelLabel(m.modelId, m.name),
          }));
      },
    },
    {
      name: "mode",
      description: "switch between agent, plan and ask",
      argumentHint: "<mode>",
      getArgumentCompletions: (prefix: string): AutocompleteItem[] => {
        const { available, current } = ctx.modes();
        const needle = prefix.trim().toLowerCase();
        return available
          .filter((m) => needle === "" || m.id.toLowerCase().startsWith(needle))
          .map((m) => ({
            value: m.id,
            label: m.id === current ? `${m.name} ✓` : m.name,
            ...(m.description !== undefined ? { description: m.description } : {}),
          }));
      },
    },
    {
      name: "goal",
      description: "show, set or clear the standing goal",
      argumentHint: "[objective|clear]",
      getArgumentCompletions: (prefix: string): AutocompleteItem[] => {
        const current = ctx.showGoal();
        const items: AutocompleteItem[] = [
          { value: "clear", label: "clear", description: "remove the standing goal" },
        ];
        if (current !== null) {
          items.unshift({ value: current, label: current, description: "the current goal" });
        }
        const needle = prefix.trim().toLowerCase();
        return items.filter((i) => needle === "" || i.value.toLowerCase().includes(needle));
      },
    },
    {
      name: "loop",
      description: "work the goal for N iterations in this session",
      argumentHint: "[iterations]",
      getArgumentCompletions: (prefix: string): AutocompleteItem[] =>
        ["3", "5", "10"]
          .filter((n) => prefix.trim() === "" || n.startsWith(prefix.trim()))
          .map((n) => ({ value: n, label: n, description: `${n} iterations` })),
    },
    {
      name: "compact",
      description: "summarise this session and continue in a fresh one",
      argumentHint: "[what to keep]",
    },
    { name: "usage", description: "session, plan and grant summary" },
    {
      name: "grant",
      description: "permanently allow a sensitive command",
      argumentHint: "<command>",
    },
    { name: "clear", description: "start a new session" },
    { name: "help", description: "list these commands" },
    { name: "exit", description: "exit cclaw" },
  ];
}

/** Split "/model foo bar" into its name and argument. */
export function parseSlash(input: string): { name: string; arg: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1);
  const space = body.indexOf(" ");
  return space === -1
    ? { name: body.toLowerCase(), arg: "" }
    : { name: body.slice(0, space).toLowerCase(), arg: body.slice(space + 1).trim() };
}

/**
 * Run a slash command. Returns handled: false when the input is not a command,
 * so the caller sends it to the agent instead.
 */
export async function runSlash(input: string, ctx: CommandContext): Promise<CommandResult> {
  const parsed = parseSlash(input);
  if (parsed === null) return { handled: false };
  const { name, arg } = parsed;

  switch (name) {
    case "model": {
      const { available, current } = ctx.models();
      if (arg === "") {
        ctx.say(
          `Models for this session (${available.length}):\n` +
            available
              .map(
                (m) =>
                  `  ${m.modelId === current ? "*" : " "} ${shortModelLabel(m.modelId, m.name)}`,
              )
              .join("\n") +
            `\n\nSwitch with /model <name>, or press Tab to complete.`,
        );
        return { handled: true };
      }
      const needle = arg.toLowerCase();
      const match =
        available.find((m) => m.modelId.toLowerCase() === needle) ??
        available.find((m) => m.name.toLowerCase() === needle) ??
        available.find((m) => m.modelId.toLowerCase().includes(needle)) ??
        available.find((m) => m.name.toLowerCase().includes(needle));
      if (match === undefined) {
        ctx.say(`No model matches '${arg}'. Try /model to list them.`);
        return { handled: true };
      }
      ctx.say(
        (await ctx.switchModel(match.modelId))
          ? `Model is now ${shortModelLabel(match.modelId, match.name)}`
          : `This session would not switch to ${match.name}`,
      );
      return { handled: true };
    }

    case "mode": {
      const { available, current } = ctx.modes();
      if (arg === "") {
        ctx.say(
          `Modes:\n` +
            available
              .map(
                (m) =>
                  `  ${m.id === current ? "*" : " "} ${m.id.padEnd(6)} ${m.description ?? m.name}`,
              )
              .join("\n"),
        );
        return { handled: true };
      }
      const match = available.find((m) => m.id.toLowerCase().startsWith(arg.toLowerCase()));
      if (match === undefined) {
        ctx.say(`No mode matches '${arg}'. Options: ${available.map((m) => m.id).join(", ")}`);
        return { handled: true };
      }
      ctx.say(
        (await ctx.switchMode(match.id))
          ? `Mode is now ${match.id}${match.id === "agent" ? "" : " (read-only)"}`
          : `This session would not switch to ${match.id}`,
      );
      return { handled: true };
    }

    case "goal": {
      if (arg === "") {
        const current = ctx.showGoal();
        ctx.say(
          current === null ? "No goal set. Set one with /goal <objective>" : `Goal: ${current}`,
        );
        return { handled: true };
      }
      if (arg === "clear" || arg === "none") {
        await ctx.clearGoal();
        ctx.say("Goal cleared.");
        return { handled: true };
      }
      await ctx.setGoal(arg);
      ctx.say(`Goal set: ${arg}`);
      return { handled: true };
    }

    case "grant": {
      if (arg === "") {
        ctx.say("Usage: /grant <command>, e.g. /grant aws");
        return { handled: true };
      }
      await ctx.grant(arg);
      ctx.say(`'${arg}' is now permanently allowed in this directory.`);
      return { handled: true };
    }

    case "compact": {
      // Compaction is itself a turn, so it cannot share the session with one.
      if (ctx.busy() || ctx.loopRunning()) {
        ctx.say("Finish or cancel the current turn first — Esc cancels.");
        return { handled: true };
      }
      ctx.say("Compacting: asking for a summary of this session…");
      const outcome = await ctx.compact(arg === "" ? undefined : arg);
      switch (outcome.kind) {
        case "nothing":
          ctx.say("Nothing to compact — this session has no turns yet.");
          return { handled: true };
        case "unusable":
          // Never clear on a reply we cannot use: that loses the context and
          // puts nothing in its place. Show what came back, because when the
          // cause is a plan refusal the reply itself says so.
          ctx.say(
            outcome.reply === ""
              ? "No summary came back, so the session was left as it was."
              : "That reply was too short to be a summary, so the session was left as it " +
                  `was. Cursor said:\n\n${outcome.reply}`,
          );
          return { handled: true };
        case "compacted":
          ctx.say(
            `Compacted ${outcome.turns} turn${outcome.turns === 1 ? "" : "s"} into a summary, ` +
              `and started a fresh session. The summary goes with your next message.\n\n` +
              outcome.summary,
          );
          return { handled: true };
      }
    }

    case "clear":
    case "new": {
      await ctx.newSession();
      ctx.say("Started a new session.");
      return { handled: true };
    }

    case "help": {
      ctx.say(
        "Commands:\n" +
          buildCommands(ctx)
            .map((c) => {
              const left = `  /${c.name}${c.argumentHint === undefined ? "" : ` ${c.argumentHint}`}`;
              // padEnd alone loses the gap when an entry overflows the column.
              return `${left.padEnd(25)} ${c.description ?? ""}`.trimEnd();
            })
            .join("\n") +
          "\n\nTab completes commands and their arguments. @ completes file paths.",
      );
      return { handled: true };
    }

    case "usage": {
      const u = ctx.usage();
      const { current: modelId, available } = ctx.models();
      const { current: mode } = ctx.modes();
      const entry = available.find((m) => m.modelId === modelId);
      const modelLabel =
        entry === undefined ? (modelId ?? "unknown") : shortModelLabel(entry.modelId, entry.name);
      ctx.say(
        [
          `profile   ${u.profile}${u.plan === undefined ? "" : ` · plan ${u.plan}`}`,
          `model     ${modelLabel}`,
          `mode      ${mode ?? "unknown"}`,
          `directory ${u.cwd}`,
          `turns     ${u.turns} this session`,
          `grants    ${u.grants.permanent} permanent, ${u.grants.session} session`,
          "",
          // Being straight about this rather than showing a fabricated number:
          // Cursor's ACP sends no token, usage or cost field in any event, and
          // advertises none in agentCapabilities. The real figure exists only in
          // Cursor's own status line.
          "tokens    not reported over ACP — run `cclaw raw` for a live context figure",
        ].join("\n"),
      );
      return { handled: true };
    }

    case "loop": {
      if (ctx.loopRunning()) {
        ctx.say("A loop is already running.");
        return { handled: true };
      }
      if (ctx.showGoal() === null) {
        ctx.say("No goal to work on. Set one first: /goal <objective>");
        return { handled: true };
      }
      const n = arg === "" ? 3 : Number.parseInt(arg, 10);
      if (!Number.isFinite(n) || n <= 0 || n > 50) {
        ctx.say("Usage: /loop [iterations], 1-50. Defaults to 3.");
        return { handled: true };
      }
      void ctx.runLoop(n);
      return { handled: true };
    }

    case "quit":
    case "exit": {
      ctx.quit();
      return { handled: true };
    }

    default: {
      ctx.say(`Unknown command '/${name}'. Try /help.`);
      return { handled: true };
    }
  }
}
