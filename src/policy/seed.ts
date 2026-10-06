/**
 * Writing policy to disk: back up, merge, write atomically, verify.
 *
 * Cursor stages its own atomic rewrites of these files, so we refuse to write
 * while an agent is running rather than race it. Invalid JSON on disk is never
 * "repaired" by clobbering — we stop and say where the backups are.
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { enforcedScalarsPresent, mergePolicy, sortKeys, type JsonObject } from "./merge.ts";

export const BACKUP_KEEP = 10;

export type SeedOutcome =
  | { status: "unchanged"; path: string }
  | { status: "written"; path: string; backup?: string }
  | { status: "refused"; path: string; reason: string };

/**
 * Processes that hold the config open and would race our write. Cursor also
 * runs long-lived `worker-server` helpers which do NOT write cli-config.json;
 * matching those would block seeding indefinitely, so they are excluded.
 */
const CONFIG_WRITER_RE = /(^|\/)(cursor-agent|agent)(\s|$)|index\.js\s+(acp|agent|tui)(\s|$)/;
const HELPER_RE = /worker-server|worker\b/;

/** Decide from a full command line whether this process may write our config. */
export function isConfigWriterLine(line: string, selfPid?: number): boolean {
  const trimmed = line.trim();
  if (trimmed === "") return false;
  if (HELPER_RE.test(trimmed)) return false;
  if (selfPid !== undefined && new RegExp(`^${selfPid}\\s`).test(trimmed)) return false;
  return CONFIG_WRITER_RE.test(trimmed);
}

/**
 * Is a Cursor process live that could be writing the config we are about to?
 *
 * Uses `ps` rather than `pgrep -a`: macOS pgrep has no -a flag, so it returns
 * bare PIDs and any command-line matching silently never fires.
 */
export async function agentRunning(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["ps", "-Ao", "pid=,command="], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.split("\n").some((line) => isConfigWriterLine(line, process.pid));
  } catch {
    // ps unavailable: do not block the user on a diagnostic we cannot run.
    return false;
  }
}

async function readJsonObject(path: string): Promise<JsonObject | "missing" | "invalid"> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return "missing";
  }
  if (text.trim() === "") return "missing";
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "invalid";
    return parsed as JsonObject;
  } catch {
    return "invalid";
  }
}

async function backup(path: string, backupsDir: string): Promise<string | undefined> {
  try {
    await stat(path);
  } catch {
    return undefined;
  }
  await mkdir(backupsDir, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const dest = join(backupsDir, `${basename(path)}.${stamp}.bak`);
  await writeFile(dest, await readFile(path));
  await prune(backupsDir, basename(path));
  return dest;
}

async function prune(backupsDir: string, prefix: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(backupsDir);
  } catch {
    return;
  }
  const mine = entries.filter((e) => e.startsWith(`${prefix}.`) && e.endsWith(".bak")).sort();
  // Names embed an ISO timestamp, so lexical order is chronological.
  for (const old of mine.slice(0, Math.max(0, mine.length - BACKUP_KEEP))) {
    await rm(join(backupsDir, old), { force: true });
  }
}

/** Write via a temp file in the same directory, so the rename is atomic. */
async function writeAtomic(path: string, text: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.cclaw.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, text, { mode: 0o644 });
  await rename(tmp, path);
}

export interface SeedRequest {
  path: string;
  defaults?: JsonObject;
  enforce: JsonObject;
  backupsDir: string;
  /** Skip the running-agent guard. Only for tests. */
  skipAgentCheck?: boolean;
}

export async function seedPolicyFile(req: SeedRequest): Promise<SeedOutcome> {
  const { path, enforce } = req;

  if (req.skipAgentCheck !== true && (await agentRunning())) {
    return {
      status: "refused",
      path,
      reason: "a Cursor agent is running; quit it and retry (we would race its own writes)",
    };
  }

  const existing = await readJsonObject(path);
  if (existing === "invalid") {
    return {
      status: "refused",
      path,
      reason: `not valid JSON; refusing to touch it. Backups: ${req.backupsDir}`,
    };
  }

  const merged = mergePolicy({
    existing: existing === "missing" ? {} : existing,
    defaults: req.defaults ?? {},
    enforce,
  });
  const text = `${JSON.stringify(merged, null, 2)}\n`;

  if (existing !== "missing") {
    const before = `${JSON.stringify(sortKeys(existing), null, 2)}\n`;
    if (before === text) return { status: "unchanged", path };
  }

  const madeBackup = await backup(path, req.backupsDir);
  await writeAtomic(path, text);

  const after = await readJsonObject(path);
  if (after === "missing" || after === "invalid" || !enforcedScalarsPresent(after, enforce)) {
    return { status: "refused", path, reason: "post-write verification failed" };
  }
  return { status: "written", path, backup: madeBackup };
}
