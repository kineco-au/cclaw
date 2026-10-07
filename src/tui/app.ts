/**
 * The cclaw chat application.
 *
 * Wires OpenClaw's ported view layer (ChatLog, CustomEditor, theme) to our ACP
 * backend, with the exec policy and approval store deciding permissions. This
 * file is ours: upstream's own entry point, src/tui/tui.ts, is not ported
 * because it is bootstrap rather than view — it reaches into OpenClaw's strict
 * config loader, gateway and state locks, logging subsystem and process
 * supervisor, none of which exist here.
 */

import {
  CombinedAutocompleteProvider,
  Container,
  Text,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { join } from "node:path";
import { buildCommands, GOAL_ITERATIONS, runSlash, type CommandContext } from "./commands.ts";
import { isPlanGated } from "../plan-gate.ts";
import { carriedMessage, compactPrompt, isPlausibleSummary, type CarriedKind } from "./compact.ts";
import { loadUserCommands, type UserCommand } from "./user-commands.ts";
import {
  appendTurn,
  listSessions as listSavedSessions,
  newSessionId,
  pruneSessions,
  readSession,
  renderTranscript,
  resolveSelector,
  startSession,
  type SessionSummary,
} from "./sessions.ts";
import type { CommandEntry } from "@openclaw/gateway-protocol";
import { renderToolEvent, StreamRouter } from "./stream-render.ts";
import { PermissionQueue } from "./permission-queue.ts";
import {
  clearGoal as clearGoalFiles,
  setGoal as setGoalFiles,
  standDownGoal,
  type Goal,
} from "../goal.ts";
import { cursorAbout, resolveCursorBinary } from "../cursor.ts";
import { describeStop, runGoalLoop } from "./goal-loop.ts";
import { appendHistory, loadHistory, seedEditorHistory } from "./history.ts";
import { TurnController } from "./turn-controller.ts";
import { ChatLog } from "./view/components/chat-log.ts";
import { PromptEditor } from "./prompt-editor.ts";
import { TuiProcessTerminal } from "./view/process-terminal.ts";
import { editorTheme, tuiTheme } from "./view/theme/theme.ts";
import { AcpTuiBackend } from "./acp-backend.ts";
import { ApprovalStore } from "../policy/approvals.ts";
import {
  createPermissionResolver,
  type AskChoiceKind,
  type AskContext,
} from "../policy/resolver.ts";
import { SENSITIVE_TOOLS } from "../policy/templates.ts";
import { readPolicyFromConfig } from "../policy/profile-policy.ts";
import type { ExecMode } from "../policy/exec-policy.ts";
import { readGoal } from "../goal.ts";
import type { ProfilePaths, Paths } from "../env.ts";

const SESSION_KEY = "tui:local";

export interface AppOptions {
  cwd: string;
  profile: string;
  env?: Record<string, string>;
  binary?: string;
  paths: Paths;
  profilePaths: ProfilePaths;
  /** Overrides the profile's configured mode, for one run. */
  mode?: ExecMode;
}

export async function runChatApp(opts: AppOptions): Promise<number> {
  const tui = new TuiMainScreen(new TuiProcessTerminal());

  const header = new Text("", 1, 0);
  const chatLog = new ChatLog(180);
  const footer = new Text("", 1, 0);
  const editor = new PromptEditor(tui, editorTheme);
  editor.setPromptStyle({ prompt: (p) => tuiTheme.accent(p) });
  // Up/Down browsing is pi-tui's; it only needs the entries.
  seedEditorHistory(editor, await loadHistory(opts.profilePaths.historyFile));

  const root = new Container();
  root.addChild(header);
  root.addChild(chatLog);
  root.addChild(footer);
  root.addChild(editor);

  /** Routes streamed chunks into chat-log runs; see stream-render.ts. */
  const stream = new StreamRouter({
    update: (runId, text) => chatLog.updateAssistant(text, runId),
    finalize: (runId, text) => chatLog.finalizeAssistant(text, runId),
  });
  const permissions = new PermissionQueue<AskContext, AskChoiceKind>();
  let busy = false;
  let model = "…";
  /** Context waiting to be prepended to the next message, and what it is. */
  let carried: string | null = null;
  let carriedLabel: CarriedKind = "summary";
  /** Cursor's own slash commands, which arrive by notification after connect. */
  let cursorCommands: CommandEntry[] = [];
  let userCommands: UserCommand[] = await loadUserCommands(opts.profilePaths.commandsDir);
  /** The on-disk session being recorded, and its id. */
  let sessionId = newSessionId();
  /** The header is written on the first real turn, not on an idle TUI. */
  let recordStarted = false;
  /** True while session/load replays history, so the replay is not re-rendered. */
  let replaying = false;

  /** Kept on disk but not in effect: /goal resume takes it up. */
  const savedGoal: Goal | null = await readGoal(opts.profilePaths.goalFile);
  let goal: Goal | null = null;
  const { allow, deny } = await readPolicyFromConfig(opts.profilePaths.cursorConfigDir);
  const rulesDir = join(opts.profilePaths.cursorConfigDir, "rules");
  // The rule is what makes a goal act on a turn, so a session that has not
  // adopted one must not leave it armed from last time.
  if (savedGoal !== null) await standDownGoal(rulesDir);
  let turns = 0;
  let loopRunning = false;
  /** Set by Esc so a loop stops between iterations, not just mid-turn. */
  let loopAbort = false;
  let plan: string | undefined;
  /** Set once the controller exists; setFooter is defined before it. */
  let turns_controller: TurnController | undefined;
  const grantCounts = { permanent: 0, session: 0 };

  const setFooter = (): void => {
    const head = permissions.head;
    if (head !== undefined) {
      const behind = permissions.size - 1;
      const queued = behind > 0 ? ` ${tuiTheme.dim(`+${behind} waiting`)}` : "";
      const choices = head.choices
        .map((c, i) => `${tuiTheme.accent(String(i + 1))} ${c.label}`)
        .join("   ");
      footer.setText(
        `${tuiTheme.error("permission")}  ${choices}   ${tuiTheme.dim("esc denies")}${queued}`,
      );
    } else {
      const state = loopRunning
        ? tuiTheme.accent("loop…")
        : busy
          ? tuiTheme.accent("working…")
          : tuiTheme.dim("ready");
      const mode = backend.sessionModes(SESSION_KEY).current;
      const modePart = mode === undefined || mode === "agent" ? "" : ` · ${tuiTheme.error(mode)}`;
      const goalPart = goal === null ? "" : ` · ${tuiTheme.accentSoft(`goal: ${goal.text}`)}`;
      const queuedCount = turns_controller?.queued.length ?? 0;
      const queuedPart = queuedCount === 0 ? "" : ` · ${tuiTheme.accent(`${queuedCount} queued`)}`;
      // Say so while a summary is pending: the next message carries it, and
      // that is otherwise invisible.
      const carriedPart =
        carried === null ? "" : ` · ${tuiTheme.accentSoft(`${carriedLabel} pending`)}`;
      const escHint = busy || loopRunning ? ` ${tuiTheme.dim("esc cancels")}` : "";
      footer.setText(
        `${state}  ${tuiTheme.dim(`${opts.profile} · ${model} · ctx unknown`)}` +
          `${modePart}${goalPart}${queuedPart}${carriedPart}${escHint}`,
      );
    }
    tui.requestRender();
  };

  /** Show the prompt for one request. Called as each reaches the front. */
  const announcePermission = (ctx: AskContext): void => {
    chatLog.addSystem(
      `Permission needed: ${ctx.toolTitle} — ${ctx.reason}\n` +
        ctx.choices.map((c, i) => `  ${i + 1}. ${c.label} — ${c.hint}`).join("\n"),
    );
  };

  /** Reassigned once commandContext exists; the backend callback needs it first. */
  let refreshCompletions = (): void => {};

  const store = new ApprovalStore({
    grantsFile: opts.profilePaths.grantsFile,
    runDir: opts.paths.run,
    sessionId: `chat-${process.pid}`,
  });

  const resolvePermission = createPermissionResolver({
    mode: opts.mode ?? "ask",
    allow,
    deny,
    strictInlineEval: true,
    cwd: opts.cwd,
    store,
    sensitive: SENSITIVE_TOOLS,
    onNotice: (text) => {
      chatLog.addSystem(text);
      tui.requestRender();
    },
    askUser: (ctx) =>
      new Promise<AskChoiceKind | null>((resolve) => {
        const position = permissions.push(ctx, resolve);
        // Only the head is being asked about; the rest are announced as they
        // come to the front, so the log is not flooded mid-turn.
        if (position === 1) announcePermission(ctx);
        setFooter();
      }),
  });

  const backend = new AcpTuiBackend({
    cwd: opts.cwd,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.binary !== undefined ? { binary: opts.binary } : {}),
    resolvePermission,
    onChunk: (_key, kind, text) => {
      if (replaying) return;
      stream.chunk(kind, text);
      tui.requestRender();
    },
    onTool: (_key, ev) => {
      if (replaying) return;
      renderToolEvent(
        {
          startTool: (id, name, args) => void chatLog.startTool(id, name, args),
          updateToolResult: (id, result, o) => void chatLog.updateToolResult(id, result, o),
        },
        ev,
      );
      tui.requestRender();
    },
    onCommands: (commands) => {
      // Cursor advertises these after the session opens, so the autocomplete
      // has to be rebuilt rather than built once at startup.
      cursorCommands = commands;
      refreshCompletions();
      chatLog.addSystem(`${commands.length} Cursor commands available (type / to see them).`);
      tui.requestRender();
    },
  });

  // Answer a pending permission prompt by number, or esc to deny.
  tui.addInputListener((data: string) => {
    const head = permissions.head;
    if (head === undefined) return { data };
    if (data === "\x1b") {
      // The controller denies every outstanding prompt and stops its turn.
      controller.cancel();
      return { consume: true };
    }
    const n = Number.parseInt(data.trim(), 10);
    const choice = Number.isFinite(n) ? head.choices[n - 1] : undefined;
    if (choice === undefined) return { consume: true };
    const next = permissions.answerHead(choice.kind);
    if (next !== undefined) announcePermission(next);
    setFooter();
    return { consume: true };
  });

  let exiting = false;
  const shutdown = async (code: number): Promise<void> => {
    if (exiting) return;
    exiting = true;
    try {
      // Session-scoped grants must not outlive the session.
      await store.clearSession();
      await backend.stop();
    } catch {
      // already down
    }
    tui.stop();
    process.exit(code);
  };

  editor.onEscape = () => {
    // Cancelling the turn alone would let the loop start the next iteration,
    // leaving no way to stop a goal that is not converging.
    if (loopRunning) loopAbort = true;
    controller.cancel();
  };

  editor.onCtrlC = () => {
    void shutdown(0);
  };
  editor.onCtrlD = () => {
    void shutdown(0);
  };

  const say = (text: string): void => {
    chatLog.addSystem(text);
    tui.requestRender();
  };

  const sessionsDir = opts.profilePaths.sessionsDir;

  /** Record the turn on disk so /resume can replay it in a later run. */
  const persist = async (entry: { role: "user" | "assistant"; text: string }): Promise<void> => {
    try {
      if (!recordStarted) {
        await startSession(sessionsDir, {
          id: sessionId,
          acpSessionId: backend.acpSessionId(SESSION_KEY) ?? "",
          cwd: opts.cwd,
          startedAt: Date.now(),
          ...(goal !== null ? { goal: goal.text } : {}),
        });
        recordStarted = true;
      }
      await appendTurn(sessionsDir, sessionId, entry);
    } catch {
      // History is a convenience; never fail a turn over it.
    }
  };

  /** Send one turn to the agent and stream the reply into the log. */
  const send = async (text: string): Promise<string> => {
    stream.beginTurn();
    turns += 1;
    // A carried summary is cleared only once its turn has gone out: dropping it
    // on a failed send would lose the one record of the compacted session.
    const summary = carried;
    const message = summary === null ? text : carriedMessage(summary, text, carriedLabel);
    await persist({ role: "user", text: message });
    await backend.sendChat({ sessionKey: SESSION_KEY, message });
    carried = null;
    setFooter();
    // The reply may still have an open reasoning run if the turn produced no
    // message at all, so close it before reading the text.
    stream.closeThought();
    const reply = stream.reply();
    if (reply !== "") await persist({ role: "assistant", text: reply });
    return reply;
  };

  // Queueing and Esc-cancel live in TurnController: it is a state machine, and
  // racing a live model through a PTY is a poor way to verify one.
  const controller = new TurnController({
    send: async (text) => {
      await send(text);
    },
    abort: () => {
      void backend.abortChat({ sessionKey: SESSION_KEY }).catch(() => {
        // Already finished.
      });
    },
    denyPrompt: () => {
      const denied = permissions.denyAll();
      if (denied > 1) say(`Denied ${denied} permission requests.`);
    },
    promptPending: () => permissions.waiting,
    echo: (text) => chatLog.addUser(text),
    say,
    changed: () => {
      busy = controller.busy;
      setFooter();
    },
    onError: (err) => {
      say(`Error: ${err instanceof Error ? err.message : String(err)}`);
    },
  });
  turns_controller = controller;

  const commandContext: CommandContext = {
    models: () => backend.sessionModels(SESSION_KEY),
    modes: () => backend.sessionModes(SESSION_KEY),
    switchModel: async (id) => {
      const ok = await backend.switchModel(SESSION_KEY, id);
      // Refresh the footer so the header line matches reality immediately.
      if (ok) {
        const sm = backend.sessionModels(SESSION_KEY);
        model = sm.available.find((m) => m.modelId === sm.current)?.name ?? sm.current ?? model;
      }
      setFooter();
      return ok;
    },
    switchMode: async (id) => {
      const ok = await backend.switchMode(SESSION_KEY, id);
      setFooter();
      return ok;
    },
    showGoal: () => goal?.text ?? null,
    savedGoal: () => (goal === null ? (savedGoal?.text ?? null) : null),
    resumeGoal: async () => {
      if (savedGoal === null) return false;
      goal = await setGoalFiles({
        goalFile: opts.profilePaths.goalFile,
        rulesDir,
        text: savedGoal.text,
      });
      setFooter();
      say(`Goal resumed: ${savedGoal.text}`);
      if (loopRunning) {
        say("A loop is already running; it will pick up the new goal.");
        return true;
      }
      say(
        `Working toward it, up to ${GOAL_ITERATIONS} iterations. Esc stops.` +
          (controller.busy ? " Starting once the current turn finishes." : ""),
      );
      void commandContext.runLoop(GOAL_ITERATIONS);
      return true;
    },
    setGoal: async (text) => {
      goal = await setGoalFiles({ goalFile: opts.profilePaths.goalFile, rulesDir, text });
      setFooter();
    },
    clearGoal: async () => {
      await clearGoalFiles({ goalFile: opts.profilePaths.goalFile, rulesDir });
      goal = null;
      setFooter();
    },
    grant: async (command) => {
      await store.grant({ command, cwd: opts.cwd, scope: "profile" });
    },
    newSession: async () => {
      await backend.resetSession(SESSION_KEY);
      chatLog.clearAll();
      stream.clear();
      turns = 0;
      // /clear means start empty; inheriting an earlier summary would not be.
      carried = null;
      // A new ACP session cannot be resumed through the old record's id, so it
      // gets a record of its own.
      sessionId = newSessionId();
      recordStarted = false;
      setFooter();
    },
    sendPrompt: (text) => {
      controller.submit(text);
    },
    thinking: () => stream.showsThinking,
    setThinking: (on) => {
      stream.setThinking(on);
    },
    cursorCommands: () =>
      cursorCommands.map((c) => ({ name: c.name, description: c.description ?? "" })),
    userCommands: () => userCommands,
    listSessions: async () => await listSavedSessions(sessionsDir),
    resume: async (selector) => {
      const all = await listSavedSessions(sessionsDir);
      const picked = resolveSelector(all, selector);
      if (picked === undefined) return { kind: "not-found", selector };
      if (picked.acpSessionId === "") {
        return { kind: "failed", reason: "that record has no Cursor session id" };
      }
      const file = await readSession(sessionsDir, picked.id);
      if (file === null) return { kind: "failed", reason: "the transcript could not be read" };
      let mode: "native" | "replayed" = "native";
      try {
        // Suppress rendering: per the ACP spec the agent replays the whole
        // conversation as session/update notifications during a load, and we
        // replay our own copy below. Rendering both would duplicate it.
        replaying = true;
        await backend.resumeSession(SESSION_KEY, picked.acpSessionId, file.entries);
      } catch {
        // Cursor advertises loadSession but refuses ids it wrote itself, so a
        // failure here is expected rather than exceptional. Fall back to a
        // fresh session carrying the transcript as text: the conversation is
        // ours on disk, so resume does not depend on the agent's cooperation.
        mode = "replayed";
        try {
          await backend.resetSession(SESSION_KEY);
        } catch (err) {
          return { kind: "failed", reason: err instanceof Error ? err.message : String(err) };
        }
      } finally {
        replaying = false;
      }
      chatLog.clearAll();
      stream.clear();
      for (const entry of file.entries) {
        if (entry.role === "user") chatLog.addUser(entry.text);
        else if (entry.role === "assistant") chatLog.finalizeAssistant(entry.text, entry.text);
      }
      turns = picked.turns;
      carried = mode === "native" ? null : renderTranscript(file.entries);
      carriedLabel = "transcript";
      if (mode === "native") {
        // Continue appending to the record we just re-opened.
        sessionId = picked.id;
        recordStarted = true;
      } else {
        // A new ACP session id means a new record; the old file stays intact.
        sessionId = newSessionId();
        recordStarted = false;
      }
      // Restore the goal this session was working, so resuming a conversation
      // resumes what it was for. Older records carry no goal and stay goalless.
      if (picked.goal !== undefined && picked.goal !== "") {
        goal = await setGoalFiles({
          goalFile: opts.profilePaths.goalFile,
          rulesDir,
          text: picked.goal,
        });
      } else if (goal !== null) {
        await clearGoalFiles({ goalFile: opts.profilePaths.goalFile, rulesDir });
        goal = null;
      }
      setFooter();
      return { kind: "resumed", session: picked, mode };
    },
    busy: () => controller.busy,
    compact: async (focus) => {
      if (turns === 0) return { kind: "nothing" };
      const before = turns;
      // Deliberately not routed through the controller: this is one request
      // with a reply we consume ourselves rather than render as a turn.
      const summary = (await send(compactPrompt(focus))).trim();
      // Cursor reports a plan refusal as a normal reply with end_turn, so the
      // only available check is whether this looks like a summary at all.
      if (!isPlausibleSummary(summary)) return { kind: "unusable", reply: summary };
      await backend.resetSession(SESSION_KEY);
      chatLog.clearAll();
      stream.clear();
      turns = 0;
      carried = summary;
      carriedLabel = "summary";
      sessionId = newSessionId();
      recordStarted = false;
      setFooter();
      return { kind: "compacted", turns: before, summary };
    },
    say,
    quit: () => {
      void shutdown(0);
    },
    usage: () => ({
      profile: opts.profile,
      ...(plan !== undefined ? { plan } : {}),
      cwd: opts.cwd,
      turns,
      grants: { permanent: grantCounts.permanent, session: grantCounts.session },
    }),
    loopRunning: () => loopRunning,
    runLoop: async (iterations) => {
      loopRunning = true;
      loopAbort = false;
      setFooter();
      try {
        const stop = await runGoalLoop({
          iterations,
          goal: () => goal?.text ?? null,
          send,
          onIteration: (i, of) => say(`working the goal — ${i}/${of}`),
          aborted: () => loopAbort,
          // runLoop sends outside the TurnController, so without this a loop
          // started mid-turn would put two prompts on one session at once.
          waitUntilReady: async () => {
            while (controller.busy && !loopAbort) {
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          },
        });
        say(describeStop(stop));
      } finally {
        loopRunning = false;
        loopAbort = false;
        setFooter();
      }
    },
  };

  refreshCompletions = (): void => {
    editor.setAutocompleteProvider?.(
      new CombinedAutocompleteProvider(buildCommands(commandContext), opts.cwd),
    );
  };
  refreshCompletions();

  editor.onSubmit = (value: string) => {
    const text = value.trim();
    if (text === "") return;
    editor.setText("");

    editor.addToHistory(text);
    void appendHistory(opts.profilePaths.historyFile, text).catch(() => {
      // History is a convenience; never fail a turn over it.
    });

    if (text.startsWith("/")) {
      void runSlash(text, commandContext).catch((err: unknown) => {
        say(`Error: ${err instanceof Error ? err.message : String(err)}`);
      });
      return;
    }

    // Queues automatically when a turn is already running.
    controller.submit(text);
  };

  header.setText(`${tuiTheme.accent("cclaw")} ${tuiTheme.dim(`${opts.profile} · ${opts.cwd}`)}`);
  setFooter();
  tui.addChild(root);
  // Without this the editor never receives keystrokes.
  tui.setFocus(editor);
  tui.start();

  try {
    await backend.start();
    await backend.createSession({ key: SESSION_KEY });
    // Prefer the session's own model list: session/new advertises exactly what
    // this session will accept, unlike the account-wide text catalogue.
    const sessionModels = backend.sessionModels(SESSION_KEY);
    model =
      sessionModels.available.find((m) => m.modelId === sessionModels.current)?.name ??
      sessionModels.current ??
      "unknown";

    const bin = await resolveCursorBinary();
    if (bin !== null) plan = (await cursorAbout(bin.path))?.subscriptionTier;
    const listed = await store.list();
    grantCounts.permanent = listed.profile.length;
    grantCounts.session = listed.session.length;

    chatLog.addSystem(
      `Connected to Cursor over ACP · policy: ${opts.mode ?? "ask"} · ` +
        `${sessionModels.available.length} models available.`,
    );
    chatLog.addSystem("Type / for commands (Tab completes), @ for files. Ctrl+C to exit.");
    // A session never starts with a goal in effect; a saved one is offered.
    if (savedGoal !== null) {
      chatLog.addSystem(
        `saved goal: ${savedGoal.text}\n` +
          `  /goal resume   take it up        /goal clear   forget it`,
      );
    }
    setFooter();
  } catch (err) {
    chatLog.addSystem(`Failed to connect: ${err instanceof Error ? err.message : String(err)}`);
    setFooter();
  }

  await new Promise<void>(() => {});
  return 0;
}
