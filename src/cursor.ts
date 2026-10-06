/**
 * Locating and talking to the Cursor CLI.
 *
 * The binary ships under two names: `agent` (current) and `cursor-agent`
 * (legacy alias). Both are symlinked into ~/.local/bin by Cursor's installer,
 * so resolution tries each in turn and then the versioned install directory.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const CURSOR_INSTALL_CMD = "curl https://cursor.com/install -fsS | bash";

/** Candidate names in preference order; `agent` is the current primary. */
const BIN_NAMES = ["agent", "cursor-agent"] as const;

export interface CursorBinary {
  path: string;
  /** The name it was found under, for diagnostics. */
  name: string;
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    const f = Bun.file(p);
    return await f.exists();
  } catch {
    return false;
  }
}

/** Find the Cursor CLI, or null when it is not installed. */
export async function resolveCursorBinary(
  env: Record<string, string | undefined> = process.env,
): Promise<CursorBinary | null> {
  if (env.CCLAW_CURSOR_BIN) {
    if (await isExecutable(env.CCLAW_CURSOR_BIN)) {
      return { path: env.CCLAW_CURSOR_BIN, name: "CCLAW_CURSOR_BIN" };
    }
  }
  for (const name of BIN_NAMES) {
    const found = Bun.which(name);
    if (found) return { path: found, name };
  }
  // Fall back to the versioned install dir, newest first, in case ~/.local/bin
  // is not on PATH for this process.
  const versions = join(homedir(), ".local", "share", "cursor-agent", "versions");
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(versions);
    for (const v of entries.sort().reverse()) {
      const candidate = join(versions, v, "cursor-agent");
      if (await isExecutable(candidate)) return { path: candidate, name: `versions/${v}` };
    }
  } catch {
    // no versioned install
  }
  return null;
}

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run a Cursor subcommand and capture output. Never throws. */
export async function runCursor(
  bin: string,
  args: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<RunResult> {
  try {
    const proc = Bun.spawn([bin, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    const timeout = opts.timeoutMs ?? 60_000;
    const timer = setTimeout(() => proc.kill(), timeout);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    return { ok: exitCode === 0, stdout, stderr, exitCode };
  } catch (err) {
    return { ok: false, stdout: "", stderr: String(err), exitCode: -1 };
  }
}

export interface CursorStatus {
  authenticated: boolean;
  email?: string;
  userId?: number;
  createdAt?: string;
}

/** `agent status --format json`, the supported non-interactive auth probe. */
export async function cursorStatus(bin: string): Promise<CursorStatus> {
  const r = await runCursor(bin, ["status", "--format", "json"], { timeoutMs: 30_000 });
  if (!r.ok) return { authenticated: false };
  try {
    const j = JSON.parse(r.stdout) as {
      isAuthenticated?: boolean;
      userInfo?: { email?: string; userId?: number; createdAt?: string };
    };
    return {
      authenticated: j.isAuthenticated === true,
      email: j.userInfo?.email,
      userId: j.userInfo?.userId,
      createdAt: j.userInfo?.createdAt,
    };
  } catch {
    return { authenticated: false };
  }
}

export interface CursorAbout {
  cliVersion?: string;
  model?: string;
  subscriptionTier?: string;
  osPlatform?: string;
  osArch?: string;
  userEmail?: string;
}

/** `agent about --format json`. Carries the subscription tier, which gates model access. */
export async function cursorAbout(bin: string): Promise<CursorAbout | null> {
  const r = await runCursor(bin, ["about", "--format", "json"], { timeoutMs: 30_000 });
  if (!r.ok) return null;
  try {
    return JSON.parse(r.stdout) as CursorAbout;
  } catch {
    return null;
  }
}

/** Does this build expose `agent acp`? It is hidden from --help but `help acp` succeeds. */
export async function hasAcp(bin: string): Promise<boolean> {
  const r = await runCursor(bin, ["help", "acp"], { timeoutMs: 15_000 });
  return r.ok && /ACP|Agent Client Protocol/i.test(r.stdout);
}
