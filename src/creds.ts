/**
 * Per-profile Cursor API keys.
 *
 * On macOS the Cursor web login lives in the system keychain under service
 * `cursor-access-token`, a single global slot, and the auth file path derives
 * from homedir() and ignores CURSOR_CONFIG_DIR. So profiles share one
 * signed-in identity unless each carries its own CURSOR_API_KEY. That is a
 * Cursor constraint; `cclaw profile show` states it rather than implying
 * isolation we cannot deliver.
 *
 * We never read, write or delete Cursor's own keychain items — only our own,
 * under the service name `cclaw`.
 */

import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { dirname } from "node:path";

export type CredMode = "inherit" | "keychain" | "file";

export const KEYCHAIN_SERVICE = "cclaw";

export function keychainAccount(profile: string): string {
  return `apikey:${profile}`;
}

export function keychainAvailable(): boolean {
  return platform() === "darwin" && Bun.which("security") !== null;
}

async function run(cmd: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return { ok: code === 0, out };
  } catch {
    return { ok: false, out: "" };
  }
}

export async function keychainSet(profile: string, key: string): Promise<boolean> {
  if (!keychainAvailable()) return false;
  // -U updates in place. -T pre-trusts the reader so routine launches do not
  // raise a GUI prompt every time.
  const r = await run([
    "security",
    "add-generic-password",
    "-U",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    keychainAccount(profile),
    "-D",
    "cclaw Cursor API key",
    "-T",
    "/usr/bin/security",
    "-w",
    key,
  ]);
  return r.ok;
}

export async function keychainGet(profile: string): Promise<string | null> {
  if (!keychainAvailable()) return null;
  const r = await run([
    "security",
    "find-generic-password",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    keychainAccount(profile),
    "-w",
  ]);
  const value = r.out.trim();
  return r.ok && value !== "" ? value : null;
}

export async function keychainClear(profile: string): Promise<void> {
  if (!keychainAvailable()) return;
  await run([
    "security",
    "delete-generic-password",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    keychainAccount(profile),
  ]);
}

export async function fileSet(credsPath: string, key: string): Promise<void> {
  await mkdir(dirname(credsPath), { recursive: true, mode: 0o700 });
  const tmp = `${credsPath}.${process.pid}.tmp`;
  await writeFile(tmp, `CURSOR_API_KEY=${key}\n`, { mode: 0o600 });
  await rename(tmp, credsPath);
  await chmod(credsPath, 0o600);
}

/**
 * Read a file-stored key. Parsed, never sourced or eval'd, so a tampered file
 * cannot execute anything.
 */
export async function fileGet(credsPath: string): Promise<string | null> {
  try {
    const text = await readFile(credsPath, "utf8");
    for (const line of text.split("\n")) {
      const m = /^CURSOR_API_KEY=(.*)$/.exec(line);
      if (m?.[1] !== undefined && m[1].trim() !== "") return m[1].trim();
    }
    return null;
  } catch {
    return null;
  }
}

export async function fileClear(credsPath: string): Promise<void> {
  await rm(credsPath, { force: true });
}

/** Tighten a credentials file that is more permissive than 0600. */
export async function repairFileMode(credsPath: string): Promise<"ok" | "fixed" | "absent"> {
  try {
    const st = await stat(credsPath);
    const mode = st.mode & 0o777;
    if (mode === 0o600) return "ok";
    await chmod(credsPath, 0o600);
    return "fixed";
  } catch {
    return "absent";
  }
}

export async function getKey(params: {
  mode: CredMode;
  profile: string;
  credsPath: string;
}): Promise<string | null> {
  if (params.mode === "keychain") return await keychainGet(params.profile);
  if (params.mode === "file") return await fileGet(params.credsPath);
  return null;
}

/** Validate a key against Cursor in a scratch config dir, leaving the profile alone. */
export async function validateKey(
  key: string,
  agentBin: string,
): Promise<{ ok: boolean; email?: string }> {
  const { mkdtemp, rm: rmdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "cclaw-key-"));
  try {
    const proc = Bun.spawn([agentBin, "status", "--format", "json"], {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, CURSOR_CONFIG_DIR: dir, CURSOR_API_KEY: key },
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const parsed: unknown = JSON.parse(out);
    const authed = (parsed as { isAuthenticated?: unknown }).isAuthenticated === true;
    const email = (parsed as { userInfo?: { email?: unknown } }).userInfo?.email;
    return authed ? { ok: true, ...(typeof email === "string" ? { email } : {}) } : { ok: false };
  } catch {
    return { ok: false };
  } finally {
    await rmdir(dir, { recursive: true, force: true });
  }
}
