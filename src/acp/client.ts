/**
 * ACP client for `cursor-agent acp`.
 *
 * Wraps the official @agentclientprotocol/sdk with the lifecycle a TUI needs:
 * spawn, initialize, authenticate, create/load sessions, stream updates, and
 * answer permission requests through a pluggable policy.
 *
 * Verified against Cursor build 2026.08.11-e8db854, which negotiates ACP v1 and
 * advertises: loadSession, mcpCapabilities{http,sse},
 * promptCapabilities{image}, sessionCapabilities{list}, and one auth method
 * `cursor_login`. It reports no token, usage or context-window information in
 * any update — which is why `cclaw raw` exists as the escape hatch.
 */

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { resolveCursorBinary } from "../cursor.ts";

/** What the host decides when the agent asks to do something. */
export type PermissionVerdict =
  { kind: "allow"; optionId: string } | { kind: "reject"; optionId?: string } | { kind: "cancel" };

/** Supplied by the host (TUI or policy engine) to answer permission requests. */
export type PermissionResolver = (req: RequestPermissionRequest) => Promise<PermissionVerdict>;

export interface AcpClientEvents {
  /** Every session/update notification, already narrowed by sessionId. */
  onUpdate?: (n: SessionNotification) => void;
  /** The agent process died or the stream closed. */
  onClose?: (info: { code: number | null; stderr: string }) => void;
  /** Diagnostic text from the agent's stderr. */
  onStderr?: (chunk: string) => void;
}

export interface AcpClientOptions {
  cwd: string;
  /** Per-profile CURSOR_CONFIG_DIR / CURSOR_DATA_DIR and friends. */
  env?: Record<string, string>;
  resolvePermission?: PermissionResolver;
  events?: AcpClientEvents;
  /** Override binary discovery, for tests. */
  binary?: string;
}

/**
 * Deny by default.
 *
 * Prefers an explicit reject option so the agent gets a clean answer. It never
 * falls back to options[0], which in ACP is conventionally "allow once" —
 * getting this wrong silently authorises work, so it is deliberate.
 */
export const denyAll: PermissionResolver = async (req) => {
  const reject = req.options?.find((o) => /reject|deny/i.test(`${o.kind ?? ""} ${o.optionId}`));
  return reject ? { kind: "reject", optionId: reject.optionId } : { kind: "cancel" };
};

export class AcpClient {
  private proc?: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private conn?: ClientSideConnection;
  private initResult?: InitializeResponse;
  /** The in-flight handshake, so concurrent callers await one start. */
  private startPromise?: Promise<InitializeResponse>;
  private stderrBuf = "";
  private closed = false;

  constructor(private readonly opts: AcpClientOptions) {}

  get capabilities(): InitializeResponse | undefined {
    return this.initResult;
  }

  get running(): boolean {
    return this.proc !== undefined && !this.closed;
  }

  /**
   * Spawn the agent and complete the ACP handshake.
   *
   * Safe to call concurrently: `conn` is assigned before `initialize` resolves,
   * so a second caller landing in that window used to see a connection with no
   * init result and throw. Callers now share one in-flight handshake.
   */
  async start(): Promise<InitializeResponse> {
    if (this.initResult !== undefined) return this.initResult;
    if (this.startPromise === undefined) {
      this.startPromise = this.handshake().catch((err: unknown) => {
        // Let a later call retry rather than caching the failure forever.
        this.startPromise = undefined;
        throw err;
      });
    }
    return await this.startPromise;
  }

  private async handshake(): Promise<InitializeResponse> {
    const bin = this.opts.binary ?? (await resolveCursorBinary())?.path;
    if (bin === undefined) throw new Error("Cursor CLI not found; cannot start ACP");

    const proc = Bun.spawn([bin, "acp"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: this.opts.cwd,
      env: { ...process.env, ...(this.opts.env ?? {}) },
    });
    this.proc = proc;

    void this.pumpStderr(proc.stderr);
    void proc.exited.then((code) => {
      this.closed = true;
      this.opts.events?.onClose?.({ code, stderr: this.stderrBuf });
    });

    const handler: Pick<Client, "requestPermission" | "sessionUpdate"> = {
      requestPermission: (req: RequestPermissionRequest): Promise<RequestPermissionResponse> =>
        this.handlePermission(req),
      sessionUpdate: (n: SessionNotification): void => {
        this.opts.events?.onUpdate?.(n);
      },
    };

    const stream = ndJsonStream(sinkToWritable(proc.stdin), proc.stdout);
    this.conn = new ClientSideConnection(() => handler as Client, stream);

    this.initResult = await this.conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        // We do not expose host filesystem or terminal methods to the agent:
        // file and command access go through Cursor's own sandbox and policy.
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "cclaw", version: "0.1.0" },
    });
    return this.initResult;
  }

  private async handlePermission(
    req: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const resolver = this.opts.resolvePermission ?? denyAll;
    let verdict: PermissionVerdict;
    try {
      verdict = await resolver(req);
    } catch {
      // A resolver that throws must not authorise anything.
      verdict = { kind: "cancel" };
    }
    switch (verdict.kind) {
      case "allow":
        return { outcome: { outcome: "selected", optionId: verdict.optionId } };
      case "reject":
        return verdict.optionId !== undefined
          ? { outcome: { outcome: "selected", optionId: verdict.optionId } }
          : { outcome: { outcome: "cancelled" } };
      case "cancel":
        return { outcome: { outcome: "cancelled" } };
    }
  }

  private async pumpStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = dec.decode(value, { stream: true });
        // Keep the tail only; agent logs can be long and we just want context
        // for an error message.
        this.stderrBuf = (this.stderrBuf + text).slice(-8192);
        this.opts.events?.onStderr?.(text);
      }
    } catch {
      // stream closed
    }
  }

  private requireConn(): ClientSideConnection {
    if (this.conn === undefined) throw new Error("ACP client not started");
    return this.conn;
  }

  /** Does the agent need authentication before sessions can be created? */
  authMethods(): { id: string; name?: string }[] {
    return (this.initResult?.authMethods ?? []).map((m) => ({ id: m.id, name: m.name }));
  }

  async authenticate(methodId: string): Promise<void> {
    await this.requireConn().authenticate({ methodId });
  }

  /**
   * Session capabilities Cursor advertises on session/new.
   *
   * Worth knowing: `models.availableModels` carries each model's parameters,
   * including `context=300k`, so this is a better model source than parsing
   * `agent models` text — and it is the only place a context window appears.
   */
  private sessionInfo = new Map<
    string,
    {
      models?: { currentModelId?: string; availableModels?: { modelId: string; name?: string }[] };
      modes?: {
        currentModeId?: string;
        availableModes?: { id: string; name?: string; description?: string }[];
      };
      configIds: Set<string>;
    }
  >();

  info(sessionId: string): {
    models?: { currentModelId?: string; availableModels?: { modelId: string; name?: string }[] };
    modes?: {
      currentModeId?: string;
      availableModes?: { id: string; name?: string; description?: string }[];
    };
    configIds: Set<string>;
  } {
    return this.sessionInfo.get(sessionId) ?? { configIds: new Set() };
  }

  async newSession(opts: { cwd?: string } = {}): Promise<string> {
    const res = await this.requireConn().newSession({
      cwd: opts.cwd ?? this.opts.cwd,
      mcpServers: [],
    });
    const raw = res as unknown as {
      models?: { currentModelId?: string; availableModels?: { modelId: string; name?: string }[] };
      modes?: {
        currentModeId?: string;
        availableModes?: { id: string; name?: string; description?: string }[];
      };
      configOptions?: { id?: string }[];
    };
    this.sessionInfo.set(res.sessionId, {
      ...(raw.models !== undefined ? { models: raw.models } : {}),
      ...(raw.modes !== undefined ? { modes: raw.modes } : {}),
      configIds: new Set(
        (raw.configOptions ?? [])
          .map((o) => o.id)
          .filter((id): id is string => typeof id === "string"),
      ),
    });
    return res.sessionId;
  }

  /**
   * Switch the model mid-session via session/set_config_option.
   *
   * Returns false when the agent does not advertise a `model` option, so
   * callers can tell "not supported" from "failed".
   */
  async setModel(sessionId: string, modelId: string): Promise<boolean> {
    const info = this.sessionInfo.get(sessionId);
    if (info !== undefined && !info.configIds.has("model")) return false;
    try {
      const res = await this.requireConn().setSessionConfigOption({
        sessionId,
        configId: "model",
        value: modelId,
      });
      const updated = (
        res as unknown as { configOptions?: { id?: string; currentValue?: string }[] }
      ).configOptions;
      const now = updated?.find((o) => o.id === "model")?.currentValue;
      const existing = this.sessionInfo.get(sessionId);
      if (existing?.models !== undefined && typeof now === "string") {
        existing.models.currentModelId = now;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Switch mode (agent / plan / ask). `plan` and `ask` are read-only. */
  async setMode(sessionId: string, modeId: string): Promise<boolean> {
    try {
      await this.requireConn().setSessionMode({ sessionId, modeId });
      const existing = this.sessionInfo.get(sessionId);
      if (existing?.modes !== undefined) existing.modes.currentModeId = modeId;
      return true;
    } catch {
      return false;
    }
  }

  /** Resume a prior session. Only valid when `loadSession` is advertised. */
  async loadSession(sessionId: string, cwd?: string): Promise<void> {
    await this.requireConn().loadSession({
      sessionId,
      cwd: cwd ?? this.opts.cwd,
      mcpServers: [],
    });
  }

  /** Send a prompt and resolve when the turn ends. Updates arrive via onUpdate. */
  async prompt(sessionId: string, text: string): Promise<{ stopReason: string }> {
    const res = await this.requireConn().prompt({
      sessionId,
      prompt: [{ type: "text", text }],
    });
    return { stopReason: String(res.stopReason ?? "end_turn") };
  }

  async cancel(sessionId: string): Promise<void> {
    await this.requireConn().cancel({ sessionId });
  }

  async stop(): Promise<void> {
    this.closed = true;
    try {
      this.proc?.kill();
    } catch {
      // already gone
    }
    await this.proc?.exited;
    // Drop the handshake so a later start() respawns instead of handing back
    // the result of a connection that is now dead.
    this.conn = undefined;
    this.initResult = undefined;
    this.startPromise = undefined;
    this.proc = undefined;
  }
}

/** Adapt Bun's FileSink stdin to the WritableStream the SDK expects. */
function sinkToWritable(sink: Bun.FileSink): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      sink.write(chunk);
      sink.flush();
    },
    close() {
      try {
        sink.end();
      } catch {
        // already closed
      }
    },
    abort() {
      try {
        sink.end();
      } catch {
        // already closed
      }
    },
  });
}
