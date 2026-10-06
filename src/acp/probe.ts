/**
 * ACP handshake probe.
 *
 * Connects to `cursor-agent acp` and reports what the agent advertises:
 * protocol version, capabilities, auth methods, and (critically) whether any
 * token-usage or context-window information is exposed. Cursor's ACP surface is
 * undocumented and the subcommand is hidden, so this is how we learn its shape
 * rather than guessing.
 */

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { resolveCursorBinary } from "../cursor.ts";

export interface ProbeResult {
  ok: boolean;
  binary?: string;
  initialize?: unknown;
  /** Every session/update payload seen, for shape discovery. */
  updates: unknown[];
  permissionRequests: unknown[];
  stderr: string;
  error?: string;
}

/** Adapt Bun's FileSink stdin to the WritableStream the SDK expects. */
function sinkToWritable(sink: {
  write: (c: Uint8Array) => void;
  flush: () => void;
  end: () => void;
}): WritableStream<Uint8Array> {
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

export interface ProbeOptions {
  /** Send a trivial prompt to observe streamed updates. Costs a model request. */
  prompt?: string;
  cwd?: string;
  timeoutMs?: number;
  /**
   * CURSOR_CONFIG_DIR for the spawned agent, so the probe can select a model
   * without touching the user's real config. On a Free plan only `auto` works.
   */
  configDir?: string;
}

export async function probeAcp(opts: ProbeOptions = {}): Promise<ProbeResult> {
  const result: ProbeResult = { ok: false, updates: [], permissionRequests: [], stderr: "" };

  const bin = await resolveCursorBinary();
  if (!bin) {
    result.error = "Cursor CLI not found";
    return result;
  }
  result.binary = bin.path;

  const proc = Bun.spawn([bin.path, "acp"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd ?? process.cwd(),
    env: {
      ...process.env,
      ...(opts.configDir !== undefined ? { CURSOR_CONFIG_DIR: opts.configDir } : {}),
    },
  });

  // Drain stderr concurrently; the agent logs there and a full pipe would block it.
  const stderrDone = new Response(proc.stderr).text().then((t) => {
    result.stderr = t;
  });

  const handler: Pick<Client, "requestPermission" | "sessionUpdate"> = {
    requestPermission(params: RequestPermissionRequest): RequestPermissionResponse {
      result.permissionRequests.push(params);
      // Refuse everything: a probe must never authorise work on the host.
      // Prefer an explicit reject option so the agent gets a clean answer;
      // otherwise cancel. Never fall back to options[0] — in ACP that is
      // conventionally "allow once".
      const reject = params.options?.find((o) =>
        /reject|deny/i.test(`${o.kind ?? ""} ${o.optionId}`),
      );
      return reject
        ? { outcome: { outcome: "selected", optionId: reject.optionId } }
        : { outcome: { outcome: "cancelled" } };
    },
    sessionUpdate(params: SessionNotification): void {
      result.updates.push(params);
    },
  };

  const stream = ndJsonStream(sinkToWritable(proc.stdin), proc.stdout);
  const conn = new ClientSideConnection(() => handler as Client, stream);

  const timeout = opts.timeoutMs ?? 45_000;
  const deadline = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`ACP probe timed out after ${timeout}ms`)), timeout),
  );

  try {
    result.initialize = await Promise.race([
      conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "cclaw", version: "0.1.0" },
      }),
      deadline,
    ]);
    result.ok = true;

    if (opts.prompt !== undefined) {
      const session = await Promise.race([
        conn.newSession({ cwd: opts.cwd ?? process.cwd(), mcpServers: [] }),
        deadline,
      ]);
      const sessionId = (session as { sessionId?: string }).sessionId;
      if (sessionId !== undefined) {
        await Promise.race([
          conn.prompt({
            sessionId,
            prompt: [{ type: "text", text: opts.prompt }],
          }),
          deadline,
        ]);
      }
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    try {
      proc.kill();
    } catch {
      // already exited
    }
    await Promise.race([stderrDone, new Promise((r) => setTimeout(r, 500))]);
  }

  return result;
}
