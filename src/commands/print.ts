/**
 * `cclaw -p` — run one prompt non-interactively and print the result.
 *
 * The scriptable counterpart to `cclaw chat`: no TUI, prompt from arguments or
 * stdin, reply on stdout, diagnostics on stderr so `text` output stays
 * pipeable. Permissions reuse the interactive resolver with a refusing
 * `askUser`, so allowlist entries and grants from `cclaw grant add` still pass
 * while anything needing consent is declined and reported — nobody is present
 * to answer, the same reasoning as `cclaw loop`.
 *
 * Turns are recorded to the session store, so a scripted run can be picked up
 * later with `/resume` in the TUI.
 */

import { AcpTuiBackend, type ToolEvent, type TranscriptEntry } from "../tui/acp-backend.ts";
import { carriedMessage } from "../tui/compact.ts";
import {
  appendTurn,
  listSessions,
  newSessionId,
  pruneSessions,
  readSession,
  renderTranscript,
  resolveSelector,
  startSession,
} from "../tui/sessions.ts";
import { createPermissionResolver, ApprovalStore } from "../policy/resolver.ts";
import { readPolicyFromConfig } from "../policy/profile-policy.ts";
import { SENSITIVE_TOOLS } from "../policy/templates.ts";
import { resolvePaths } from "../env.ts";
import type { ExecMode } from "../policy/exec-policy.ts";
import { ensureProfile, launchEnv, resolveProfileName } from "../profile.ts";
import { createStyler } from "../ui/style.ts";

export type OutputFormat = "text" | "json";

export interface PrintOptions {
  prompt?: string;
  format: OutputFormat;
  /** Session selector to carry context from, as `/resume` accepts. */
  resume?: string;
  profile?: string;
  mode?: ExecMode;
}

export interface PrintArgs {
  opts: PrintOptions;
  error?: string;
}

const FORMATS = new Set<string>(["text", "json"]);

/**
 * Parse the arguments after `-p`. Everything not a recognised flag becomes the
 * prompt, so quoting is optional: `cclaw -p fix the build` works.
 */
export function parsePrintArgs(args: readonly string[]): PrintArgs {
  const opts: PrintOptions = { format: "text" };
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = args[i + 1];
    if (a === undefined) continue;
    if (a === "--output-format" || a === "--format") {
      if (v === undefined) return { opts, error: `${a} needs a value (text or json)` };
      if (!FORMATS.has(v)) return { opts, error: `unknown output format '${v}'` };
      opts.format = v as OutputFormat;
      i++;
      continue;
    }
    if (a === "--json") {
      opts.format = "json";
      continue;
    }
    if (a === "--resume" || a === "-r") {
      if (v === undefined) return { opts, error: `${a} needs a session selector` };
      opts.resume = v;
      i++;
      continue;
    }
    if (a.startsWith("-") && a !== "-") return { opts, error: `unknown option '${a}'` };
    words.push(a);
  }
  const prompt = words.join(" ").trim();
  if (prompt !== "" && prompt !== "-") opts.prompt = prompt;
  return { opts };
}

/**
 * Cursor streams a plan refusal as an ordinary reply and still reports
 * `stopReason: "end_turn"`, so neither the protocol nor the transcript marks it
 * as a failure — the same trap that made `/compact` discard a live session.
 * Headless runs feed CI and scripts, where exiting 0 on a non-answer is worse
 * than failing, so the one known gate string is matched explicitly rather than
 * inferred from reply length.
 */
export function isPlanGated(reply: string): boolean {
  return /upgrade your plan/i.test(reply);
}

export interface PrintResult {
  reply: string;
  sessionId: string;
  stopReason: string;
  /** Tool calls the agent completed, in order. */
  tools: { name: string; status: string }[];
  /** Permission requests declined because the run is unattended. */
  refused: string[];
  isError: boolean;
}

/** Render a result in the requested format. `text` is just the reply. */
export function formatResult(result: PrintResult, format: OutputFormat): string {
  if (format === "json") return `${JSON.stringify(result, null, 2)}\n`;
  return result.reply.endsWith("\n") || result.reply === "" ? result.reply : `${result.reply}\n`;
}

/** Read a prompt from stdin, for `cclaw -p -` and piped input. */
export async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Uint8Array);
  return Buffer.concat(chunks).toString("utf8").trim();
}

const SESSION_KEY = "print:local";

export async function printCommand(args: readonly string[], profile?: string): Promise<number> {
  const s = createStyler();
  const { opts, error } = parsePrintArgs(args);
  if (profile !== undefined) opts.profile = profile;
  if (error !== undefined) {
    process.stderr.write(`${s.red("error")} ${error}\n`);
    return 2;
  }

  // A piped prompt is as valid as an argument one, so only complain when
  // there is neither.
  let prompt = opts.prompt;
  if (prompt === undefined && !process.stdin.isTTY) prompt = await readStdin();
  if (prompt === undefined || prompt === "") {
    process.stderr.write(
      `${s.red("error")} nothing to do. Pass a prompt:\n  cclaw -p "what changed in src?"\n`,
    );
    return 2;
  }

  const paths = resolvePaths();
  const name = await resolveProfileName(paths, opts.profile);
  const { pp } = await ensureProfile(paths, name);
  const { allow, deny } = await readPolicyFromConfig(pp.cursorConfigDir);

  const refused: string[] = [];
  const store = new ApprovalStore({
    grantsFile: pp.grantsFile,
    runDir: paths.run,
    sessionId: `print-${process.pid}`,
  });
  const resolvePermission = createPermissionResolver({
    mode: opts.mode ?? "ask",
    allow,
    deny,
    strictInlineEval: true,
    cwd: process.cwd(),
    store,
    sensitive: SENSITIVE_TOOLS,
    // Nobody is present to consent, so every ask is a refusal. Allowlist hits
    // and stored grants never reach here.
    askUser: async (ctx) => {
      refused.push(ctx.command ?? ctx.toolTitle);
      return null;
    },
  });

  const tools: { name: string; status: string }[] = [];
  const chunks: string[] = [];
  const backend = new AcpTuiBackend({
    cwd: process.cwd(),
    env: launchEnv(pp, paths),
    resolvePermission,
    onChunk: (_key, kind, text) => {
      if (kind === "message") chunks.push(text);
    },
    onTool: (_key, ev: ToolEvent) => {
      const label = ev.title ?? ev.name ?? ev.kind ?? "tool";
      const status = ev.status ?? "pending";
      const last = tools.at(-1);
      if (last?.name === label) last.status = status;
      else tools.push({ name: label, status });
    },
  });

  let carried: string | null = null;
  if (opts.resume !== undefined) {
    const sessions = await listSessions(pp.sessionsDir);
    const picked = resolveSelector(sessions, opts.resume);
    if (picked === undefined) {
      process.stderr.write(`${s.red("error")} no session matching '${opts.resume}'\n`);
      return 2;
    }
    const file = await readSession(pp.sessionsDir, picked.id);
    if (file !== null) carried = renderTranscript(file.entries);
  }

  const message = carried === null ? prompt : carriedMessage(carried, prompt, "transcript");
  const sessionId = newSessionId();
  let stopReason = "error";
  let isError = false;

  try {
    await backend.start();
    const res = await backend.sendChat({ sessionKey: SESSION_KEY, message });
    stopReason = res.status ?? "end_turn";
    const acpSessionId = backend.acpSessionId(SESSION_KEY) ?? "";
    await startSession(pp.sessionsDir, {
      id: sessionId,
      acpSessionId,
      cwd: process.cwd(),
      startedAt: Date.now(),
    });
    for (const entry of recordable(message, chunks.join(""))) {
      await appendTurn(pp.sessionsDir, sessionId, entry);
    }
    await pruneSessions(pp.sessionsDir);
  } catch (err) {
    isError = true;
    process.stderr.write(`${s.red("error")} ${err instanceof Error ? err.message : String(err)}\n`);
  } finally {
    await backend.stop();
  }

  const reply = chunks.join("").trim();
  const gated = isPlanGated(reply);
  const result: PrintResult = {
    reply,
    sessionId,
    stopReason,
    tools,
    refused,
    isError: isError || reply === "" || gated,
  };
  process.stdout.write(formatResult(result, opts.format));
  if (gated) {
    process.stderr.write(
      `${s.red("error")} the agent refused: this plan will not run the configured model.\n` +
        `${s.dim("  cclaw model list   shows what this plan allows")}\n`,
    );
  }
  if (opts.format === "text" && refused.length > 0) {
    process.stderr.write(
      `${s.yellow("refused")} ${refused.length} permission request(s) (unattended): ${refused.join(", ")}\n`,
    );
  }
  return result.isError ? 1 : 0;
}

/** The turns worth persisting: the prompt always, the reply when there is one. */
export function recordable(message: string, reply: string): TranscriptEntry[] {
  const out: TranscriptEntry[] = [{ role: "user", text: message }];
  if (reply.trim() !== "") out.push({ role: "assistant", text: reply });
  return out;
}
