/**
 * TuiBackend implemented over Cursor's ACP server.
 *
 * Satisfies OpenClaw's TuiBackend contract (see ./contract.ts) so its view
 * layer can be reused unmodified. Where Cursor has no equivalent of an
 * OpenClaw gateway concept we synthesise the minimum the contract requires and
 * say so, rather than inventing data that looks real.
 *
 * Deliberate gaps, all verified against the live CLI:
 *   - Token/context fields stay undefined. Cursor reports no token, usage or
 *     context-window information over ACP, and advertises none in
 *     agentCapabilities. The footer renders unknown. `cclaw raw` is the mode
 *     where a real figure exists, via Cursor's statusLine.
 *   - Agents: Cursor is a single agent, so listAgents returns one synthetic row.
 *   - Plugin approvals and task suggestions are omitted (optional in the
 *     contract) because Cursor has no such concept.
 */

import type {
  AgentsListResult,
  CommandEntry,
  SessionsPatchResult,
} from "@openclaw/gateway-protocol";
import { AcpClient, type PermissionResolver } from "../acp/client.ts";
import { cursorAbout } from "../cursor.ts";
import { derivedContextWindow, fetchCatalogue, type ModelEntry } from "../models.ts";
import type {
  ChatSendOptions,
  TuiBackend,
  TuiChatSendResult,
  TuiModelChoice,
  TuiSessionDescription,
  TuiSessionList,
  TuiSessionMutationResult,
} from "./contract.ts";

/** Cursor presents as one agent; the contract requires an id. */
export const CURSOR_AGENT_ID = "cursor";
const PROVIDER = "cursor";

interface SessionRecord {
  key: string;
  acpSessionId: string;
  createdAt: number;
  updatedAt: number;
  /** Accumulated turn text, so loadHistory and /resume have something real. */
  transcript: TranscriptEntry[];
  model?: string;
  title?: string;
}

export type TranscriptEntry = { role: "user" | "assistant" | "thought"; text: string };

/**
 * A tool call, as the view needs it.
 *
 * ACP sends `tool_call` once and then `tool_call_update` repeatedly against the
 * same `toolCallId`, so the view upserts rather than appends.
 */
export interface ToolEvent {
  phase: "start" | "update";
  toolCallId: string;
  /** Human title from the agent, e.g. "Read src/cli.ts". */
  title?: string;
  /** The agent's own tool name when it sends one; falls back to `kind`. */
  name?: string;
  kind?: string;
  status?: "pending" | "in_progress" | "completed" | "failed";
  /** Arguments, when the agent chose to echo them. */
  rawInput?: unknown;
  rawOutput?: unknown;
  /** Flattened text of the content blocks, including a summary of any diff. */
  output?: string;
  /** Files the call touched, for the header line. */
  locations?: string[];
}

export interface AcpBackendOptions {
  cwd: string;
  env?: Record<string, string>;
  resolvePermission?: PermissionResolver;
  /** Called for each streamed chunk so a view can render incrementally. */
  onChunk?: (sessionKey: string, kind: "message" | "thought", text: string) => void;
  /** Called for every tool-call lifecycle event. */
  onTool?: (sessionKey: string, ev: ToolEvent) => void;
  /** Called when Cursor advertises its slash-command catalogue. */
  onCommands?: (commands: CommandEntry[]) => void;
  binary?: string;
}

export class AcpTuiBackend implements Partial<TuiBackend> {
  private readonly client: AcpClient;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly byAcpId = new Map<string, string>();
  private readonly runs = new Map<string, AbortController>();
  private commands: CommandEntry[] = [];
  private started = false;
  private modelCache?: TuiModelChoice[];

  constructor(private readonly opts: AcpBackendOptions) {
    this.client = new AcpClient({
      cwd: opts.cwd,
      env: opts.env,
      binary: opts.binary,
      resolvePermission: opts.resolvePermission,
      events: {
        onUpdate: (n) => {
          this.ingest(n);
        },
      },
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.client.start();
    this.started = true;
  }

  /** Route an ACP notification into our session state. */
  private ingest(n: { sessionId?: string; update?: Record<string, unknown> }): void {
    const key = n.sessionId === undefined ? undefined : this.byAcpId.get(n.sessionId);
    const rec = key === undefined ? undefined : this.sessions.get(key);
    const update = n.update ?? {};
    const kind = String(update.sessionUpdate ?? "");

    switch (kind) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const text = extractText(update.content);
        if (text === "" || rec === undefined || key === undefined) return;
        const role = kind === "agent_thought_chunk" ? "thought" : "assistant";
        const last = rec.transcript.at(-1);
        if (last?.role === role) last.text += text;
        else rec.transcript.push({ role, text });
        rec.updatedAt = Date.now();
        this.opts.onChunk?.(key, role === "thought" ? "thought" : "message", text);
        return;
      }
      case "session_info_update": {
        const title = typeof update.title === "string" ? update.title : undefined;
        if (rec !== undefined && title !== undefined) rec.title = title;
        return;
      }
      case "available_commands_update": {
        // Cursor's slash-command catalogue, surfaced through listCommands.
        const raw = update.availableCommands ?? update.commands;
        if (Array.isArray(raw)) {
          this.commands = raw.map(toCommandEntry).filter(isCommand);
          this.opts.onCommands?.(this.commands);
        }
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        if (key === undefined) return;
        const ev = toToolEvent(update, kind === "tool_call" ? "start" : "update");
        if (ev === null) return;
        if (rec !== undefined) rec.updatedAt = Date.now();
        this.opts.onTool?.(key, ev);
        return;
      }
      default:
        return;
    }
  }

  // --- required contract methods -------------------------------------------

  async stop(): Promise<void> {
    for (const ctl of this.runs.values()) ctl.abort();
    this.runs.clear();
    await this.client.stop();
    this.started = false;
  }

  async createSession(opts: { key: string }): Promise<TuiSessionMutationResult> {
    await this.start();
    const acpSessionId = await this.client.newSession({ cwd: this.opts.cwd });
    const now = Date.now();
    const rec: SessionRecord = {
      key: opts.key,
      acpSessionId,
      createdAt: now,
      updatedAt: now,
      transcript: [],
    };
    this.sessions.set(opts.key, rec);
    this.byAcpId.set(acpSessionId, opts.key);
    return { ok: true, key: opts.key, entry: { ...this.infoFor(rec), sessionId: acpSessionId } };
  }

  async sendChat(opts: ChatSendOptions): Promise<TuiChatSendResult> {
    await this.start();
    let rec = this.sessions.get(opts.sessionKey);
    if (rec === undefined) {
      await this.createSession({ key: opts.sessionKey });
      rec = this.sessions.get(opts.sessionKey);
    }
    if (rec === undefined) throw new Error(`could not open session ${opts.sessionKey}`);

    // Record the user's turn too: without it the transcript cannot be replayed
    // on resume, since it would hold only one side of the conversation.
    rec.transcript.push({ role: "user", text: opts.message });
    rec.updatedAt = Date.now();

    const runId = opts.runId ?? crypto.randomUUID();
    const ctl = new AbortController();
    this.runs.set(runId, ctl);
    try {
      const res = await this.client.prompt(rec.acpSessionId, opts.message);
      return { runId, status: res.stopReason };
    } finally {
      this.runs.delete(runId);
    }
  }

  async abortChat(opts: {
    sessionKey: string;
    runId?: string;
  }): Promise<{ ok: boolean; aborted: boolean; runIds?: string[] }> {
    const rec = this.sessions.get(opts.sessionKey);
    if (rec === undefined) return { ok: false, aborted: false };
    const ids = opts.runId !== undefined ? [opts.runId] : [...this.runs.keys()];
    for (const id of ids) this.runs.get(id)?.abort();
    await this.client.cancel(rec.acpSessionId);
    return { ok: true, aborted: ids.length > 0, runIds: ids };
  }

  /** The full transcript, for persistence and replay on resume. */
  transcriptOf(key: string): readonly TranscriptEntry[] {
    return this.sessions.get(key)?.transcript ?? [];
  }

  /** The ACP session id, which is what `session/load` resumes against. */
  acpSessionId(key: string): string | undefined {
    return this.sessions.get(key)?.acpSessionId;
  }

  /**
   * Re-open a previous ACP session and seed our record with its transcript.
   *
   * `loadSession` is advertised by Cursor (`agentCapabilities.loadSession`).
   * Per the spec the agent replays the conversation as `session/update`
   * notifications during the load, so the caller must suppress rendering while
   * this runs or the replay lands in the log twice.
   */
  async resumeSession(
    key: string,
    acpSessionId: string,
    transcript: TranscriptEntry[],
  ): Promise<void> {
    await this.start();
    const old = this.sessions.get(key);
    if (old !== undefined) this.byAcpId.delete(old.acpSessionId);
    const now = Date.now();
    this.sessions.set(key, {
      key,
      acpSessionId,
      createdAt: now,
      updatedAt: now,
      transcript: [...transcript],
    });
    this.byAcpId.set(acpSessionId, key);
    await this.client.loadSession(acpSessionId, this.opts.cwd);
  }

  async loadHistory(opts: { sessionKey: string; limit?: number }): Promise<unknown> {
    const rec = this.sessions.get(opts.sessionKey);
    if (rec === undefined) return { messages: [] };
    const all = rec.transcript.filter((t) => t.role === "assistant");
    const messages = opts.limit !== undefined ? all.slice(-opts.limit) : all;
    return { messages: messages.map((m) => ({ role: "assistant", text: m.text })) };
  }

  async listSessions(): Promise<TuiSessionList> {
    const rows = [...this.sessions.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((rec) => ({
        ...this.infoFor(rec),
        key: rec.key,
        sessionId: rec.acpSessionId,
        provider: PROVIDER,
        derivedTitle: rec.title,
        lastMessagePreview: rec.transcript.at(-1)?.text.slice(0, 120),
      }));
    return {
      ts: Date.now(),
      path: this.opts.cwd,
      count: rows.length,
      totalCount: rows.length,
      hasMore: false,
      sessions: rows,
    };
  }

  async describeSession(opts: { sessionKey: string }): Promise<TuiSessionDescription> {
    const list = await this.listSessions();
    return { session: list.sessions.find((s) => s.key === opts.sessionKey) ?? null };
  }

  async resetSession(key: string): Promise<TuiSessionMutationResult> {
    const old = this.sessions.get(key);
    if (old !== undefined) {
      this.byAcpId.delete(old.acpSessionId);
      this.sessions.delete(key);
    }
    return await this.createSession({ key });
  }

  /** Models this session can switch between, straight from session/new. */
  sessionModels(key: string): { current?: string; available: { modelId: string; name: string }[] } {
    const rec = this.sessions.get(key);
    if (rec === undefined) return { available: [] };
    const models = this.client.info(rec.acpSessionId).models;
    return {
      ...(models?.currentModelId !== undefined ? { current: models.currentModelId } : {}),
      available: (models?.availableModels ?? []).map((m) => ({
        modelId: m.modelId,
        name: m.name ?? m.modelId,
      })),
    };
  }

  /** Modes this session can switch between: agent / plan / ask. */
  sessionModes(key: string): {
    current?: string;
    available: { id: string; name: string; description?: string }[];
  } {
    const rec = this.sessions.get(key);
    if (rec === undefined) return { available: [] };
    const modes = this.client.info(rec.acpSessionId).modes;
    return {
      ...(modes?.currentModeId !== undefined ? { current: modes.currentModeId } : {}),
      available: (modes?.availableModes ?? []).map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        ...(m.description !== undefined ? { description: m.description } : {}),
      })),
    };
  }

  /** Switch model on the live session. False when the agent will not do it. */
  async switchModel(key: string, modelId: string): Promise<boolean> {
    const rec = this.sessions.get(key);
    if (rec === undefined) return false;
    const ok = await this.client.setModel(rec.acpSessionId, modelId);
    if (ok) {
      rec.model = modelId;
      rec.updatedAt = Date.now();
    }
    return ok;
  }

  async switchMode(key: string, modeId: string): Promise<boolean> {
    const rec = this.sessions.get(key);
    if (rec === undefined) return false;
    return await this.client.setMode(rec.acpSessionId, modeId);
  }

  async patchSession(opts: { key: string; [k: string]: unknown }): Promise<SessionsPatchResult> {
    const rec = this.sessions.get(opts.key);
    // Model is the one mutation Cursor supports per session. This used to only
    // update our local record and report ok, which looked like a switch while
    // telling Cursor nothing; it now actually calls session/set_config_option.
    const model = typeof opts.model === "string" ? opts.model : undefined;
    let applied = false;
    if (rec !== undefined && model !== undefined) {
      applied = await this.switchModel(opts.key, model);
    }
    // The contract types `ok` as the literal `true`, so a failed switch has to
    // throw rather than report — otherwise the view would believe it worked.
    if (model !== undefined && !applied) {
      throw new Error(`this session will not switch to '${model}'`);
    }
    return {
      ok: true,
      path: this.opts.cwd,
      key: opts.key,
      entry: rec === undefined ? {} : { ...this.infoFor(rec) },
      ...(model !== undefined ? { resolved: { model, modelProvider: PROVIDER } } : {}),
    };
  }

  async listAgents(): Promise<AgentsListResult> {
    // Cursor is a single agent. The contract requires this shape, so it is
    // synthesised rather than left empty.
    return {
      defaultId: CURSOR_AGENT_ID,
      mainKey: CURSOR_AGENT_ID,
      scope: "global",
      agents: [{ id: CURSOR_AGENT_ID, name: "Cursor" }],
    };
  }

  async getGatewayStatus(): Promise<unknown> {
    const caps = this.client.capabilities;
    return {
      ok: this.client.running,
      transport: "acp",
      protocolVersion: caps?.protocolVersion,
      agentCapabilities: caps?.agentCapabilities,
      cwd: this.opts.cwd,
      // No gateway exists; this is the ACP connection's health.
      gateway: null,
    };
  }

  async listModels(): Promise<TuiModelChoice[]> {
    if (this.modelCache !== undefined) return this.modelCache;
    const [cat, about] = await Promise.all([this.catalogue(), this.about()]);
    // A Free plan only permits `auto`; marking the rest unavailable is more
    // honest than listing ~60 models the account cannot actually use.
    const freeTier = /free/i.test(about?.subscriptionTier ?? "");
    this.modelCache = cat.models.map((m) => toModelChoice(m, freeTier));
    return this.modelCache;
  }

  private async catalogue(): Promise<{ models: ModelEntry[] }> {
    const { resolveCursorBinary } = await import("../cursor.ts");
    const bin = this.opts.binary ?? (await resolveCursorBinary())?.path;
    if (bin === undefined) return { models: [] };
    return await fetchCatalogue(bin);
  }

  private async about(): Promise<{ subscriptionTier?: string } | null> {
    const { resolveCursorBinary } = await import("../cursor.ts");
    const bin = this.opts.binary ?? (await resolveCursorBinary())?.path;
    if (bin === undefined) return null;
    return await cursorAbout(bin);
  }

  // --- optional contract methods we can honour -----------------------------

  async listCommands(): Promise<CommandEntry[]> {
    return this.commands;
  }

  getKnownModels(): TuiModelChoice[] | undefined {
    return this.modelCache;
  }

  // --- helpers -------------------------------------------------------------

  /**
   * Session metadata for the footer. Token and context fields are deliberately
   * omitted: Cursor reports none of them over ACP.
   */
  private infoFor(rec: SessionRecord): {
    model?: string;
    modelProvider: string;
    updatedAt: number;
    displayName?: string;
  } {
    return {
      ...(rec.model !== undefined ? { model: rec.model } : {}),
      modelProvider: PROVIDER,
      updatedAt: rec.updatedAt,
      ...(rec.title !== undefined ? { displayName: rec.title } : {}),
    };
  }
}

/**
 * Map a Cursor catalogue row onto the contract's model shape.
 *
 * No cast: the contract's `unavailableReason` is a fixed union
 * ("missing-auth" | "auth-failed" | "cooldown") with no member meaning "your
 * plan forbids this", and `contextWindow` is a number. An earlier version cast
 * through `as` and silently produced a stringified window and free-text reason.
 * Plan-restricted models are therefore marked unavailable with no reason code;
 * the human explanation belongs in our own UI, not in this field.
 */
export function toModelChoice(m: ModelEntry, freeTier: boolean): TuiModelChoice {
  const ctx = derivedContextWindow(m.id, m.displayName);
  const usable = !freeTier || m.id === "auto";
  return {
    id: m.id,
    name: m.displayName,
    provider: PROVIDER,
    ...(ctx > 0 ? { contextWindow: ctx } : {}),
    available: usable,
  };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content !== null && typeof content === "object") {
    const t = (content as { text?: unknown }).text;
    if (typeof t === "string") return t;
  }
  return "";
}

/**
 * Map one entry from Cursor's `available_commands_update` onto the contract's
 * CommandEntry.
 *
 * `source`, `scope` and `acceptsArgs` are required and were previously omitted
 * behind an `as` cast, which fed the view malformed rows. Cursor's slash
 * commands are built into the agent and invoked from the prompt line, so they
 * are "native" source with "both" scope.
 */
function toCommandEntry(raw: unknown): CommandEntry | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const o = raw as { name?: unknown; description?: unknown; input?: unknown };
  if (typeof o.name !== "string" || o.name === "") return undefined;
  return {
    name: o.name,
    description: typeof o.description === "string" ? o.description : "",
    source: "native",
    scope: "both",
    // Cursor advertises an `input` hint when a command takes arguments.
    acceptsArgs: o.input !== undefined && o.input !== null,
  };
}

function isCommand(v: CommandEntry | undefined): v is CommandEntry {
  return v !== undefined;
}

const TOOL_STATUSES = new Set(["pending", "in_progress", "completed", "failed"]);

/**
 * Flatten `ToolCallContent[]` into displayable text.
 *
 * Three block types exist. `content` carries ordinary content blocks, `terminal`
 * references a terminal we never created (we advertise no terminal methods, so
 * it can only be reported, not read), and `diff` carries oldText/newText for a
 * path. A diff is summarised to a line count here rather than rendered: real
 * diff rendering is its own piece of work, and dropping the block silently
 * would make an edit look like it did nothing.
 */
export function flattenToolContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as {
      type?: unknown;
      content?: unknown;
      text?: unknown;
      path?: unknown;
      oldText?: unknown;
      newText?: unknown;
      terminalId?: unknown;
    };
    if (b.type === "diff") {
      const path = typeof b.path === "string" ? b.path : "file";
      const before = typeof b.oldText === "string" ? b.oldText : "";
      const after = typeof b.newText === "string" ? b.newText : "";
      const removed = before === "" ? 0 : before.split("\n").length;
      const added = after === "" ? 0 : after.split("\n").length;
      parts.push(`${path}  +${added} -${removed}`);
      continue;
    }
    if (b.type === "terminal") {
      const id = typeof b.terminalId === "string" ? b.terminalId : "";
      parts.push(id === "" ? "[terminal]" : `[terminal ${id}]`);
      continue;
    }
    // type: "content" nests a content block; some agents inline text directly.
    const text = extractText(b.content) || extractText(b);
    if (text !== "") parts.push(text);
  }
  return parts.join("\n");
}

/** Map a `tool_call` or `tool_call_update` payload onto a ToolEvent. */
export function toToolEvent(
  update: Record<string, unknown>,
  phase: "start" | "update",
): ToolEvent | null {
  const id = update.toolCallId;
  // Without an id there is nothing to upsert against, so the event is unusable.
  if (typeof id !== "string" || id === "") return null;
  const status =
    typeof update.status === "string" && TOOL_STATUSES.has(update.status)
      ? (update.status as ToolEvent["status"])
      : undefined;
  const output = flattenToolContent(update.content);
  const locations = Array.isArray(update.locations)
    ? update.locations
        .map((l) =>
          l !== null && typeof l === "object" && typeof (l as { path?: unknown }).path === "string"
            ? (l as { path: string }).path
            : undefined,
        )
        .filter((p): p is string => p !== undefined)
    : undefined;
  return {
    phase,
    toolCallId: id,
    ...(typeof update.title === "string" ? { title: update.title } : {}),
    ...(typeof update.name === "string" ? { name: update.name } : {}),
    ...(typeof update.kind === "string" ? { kind: update.kind } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
    ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
    ...(output !== "" ? { output } : {}),
    ...(locations !== undefined && locations.length > 0 ? { locations } : {}),
  };
}
