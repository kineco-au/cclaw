/**
 * The approval store.
 *
 * Ported in spirit from OpenClaw's approval model, whose sharpest idea is that
 * a grant binds to the **exact argv and the exact cwd**, not to a command name.
 * "Allow always" for `aws s3 ls` in one repo must not silently authorise
 * `aws s3 rm` or the same command somewhere else.
 *
 * Three scopes, which is what makes the temporary-vs-permanent distinction real:
 *   session   - lives in run/<id>.json, deleted when the session ends
 *   profile   - persists in the profile's grants.json
 *   never     - a profile-scoped block that beats everything
 *
 * Standing grants may expire, so a broad grant can be time-boxed rather than
 * forever.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

export type GrantScope = "session" | "profile";
export type ApprovalDecision = "allow-once" | "allow-always" | "deny";

export interface GrantRecord {
  /** The command basename, for display and for name-level grants. */
  command: string;
  /** Full argv as a single normalised string; absent for a name-level grant. */
  argv?: string;
  /** Resolved cwd the grant is bound to; absent means any directory. */
  cwd?: string;
  grantedAt: string;
  /** ISO timestamp after which the grant is ignored. */
  expiresAt?: string;
}

interface GrantsFile {
  version: 1;
  profile: Record<string, GrantRecord>;
  never: Record<string, { blockedAt: string }>;
}

interface SessionFile {
  version: 1;
  startedAt: string;
  grants: Record<string, GrantRecord>;
}

/**
 * A fresh object every call. This must NOT be a shared constant: the fallback
 * is mutated by grant()/block(), and a shared one leaked grants between store
 * instances and across scopes — a session grant resurfaced as a profile grant.
 */
function emptyGrants(): GrantsFile {
  return { version: 1, profile: {}, never: {} };
}

/**
 * Key a grant by command + argv + cwd so it cannot leak across directories or
 * argument sets. A name-level grant (no argv) keys on the command and cwd only.
 */
export function grantKey(params: { command: string; argv?: string; cwd?: string }): string {
  const argv = normaliseArgv(params.argv);
  const cwd = params.cwd === undefined ? "*" : resolve(params.cwd);
  const raw = `${params.command}\u0000${argv ?? "*"}\u0000${cwd}`;
  // Hashed so arbitrary argv cannot collide with JSON keys or grow unbounded.
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

/** Collapse whitespace so cosmetic differences do not defeat a grant. */
export function normaliseArgv(argv?: string): string | undefined {
  if (argv === undefined) return undefined;
  const collapsed = argv.replace(/\s+/gu, " ").trim();
  return collapsed === "" ? undefined : collapsed;
}

export function isExpired(record: GrantRecord, now: Date = new Date()): boolean {
  if (record.expiresAt === undefined) return false;
  const at = Date.parse(record.expiresAt);
  return Number.isFinite(at) && at <= now.getTime();
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export interface ApprovalStoreOptions {
  grantsFile: string;
  /** Directory holding per-session grant files. */
  runDir: string;
  sessionId?: string;
}

export class ApprovalStore {
  constructor(private readonly opts: ApprovalStoreOptions) {}

  /** Whether a session-scoped grant can be recorded at all. */
  hasSession(): boolean {
    return this.opts.sessionId !== undefined;
  }

  private sessionPath(): string | undefined {
    if (this.opts.sessionId === undefined) return undefined;
    return join(this.opts.runDir, `${this.opts.sessionId}.json`);
  }

  /** never > session > profile. Expired records are ignored. */
  async lookup(params: {
    command: string;
    argv?: string;
    cwd?: string;
  }): Promise<{ scope: GrantScope | "never" } | null> {
    const grants = await readJson<GrantsFile>(this.opts.grantsFile, emptyGrants());
    if (grants.never?.[params.command] !== undefined) return { scope: "never" };

    const exact = grantKey(params);
    const nameLevel = grantKey({ command: params.command, cwd: params.cwd });

    const sessionPath = this.sessionPath();
    if (sessionPath !== undefined) {
      const session = await readJson<SessionFile>(sessionPath, {
        version: 1,
        startedAt: "",
        grants: {},
      });
      for (const key of [exact, nameLevel]) {
        const rec = session.grants[key];
        if (rec !== undefined && !isExpired(rec)) return { scope: "session" };
      }
    }

    for (const key of [exact, nameLevel]) {
      const rec = grants.profile?.[key];
      if (rec !== undefined && !isExpired(rec)) return { scope: "profile" };
    }
    return null;
  }

  /** Record a grant. `allow-once` is intentionally not stored. */
  async grant(params: {
    command: string;
    argv?: string;
    cwd?: string;
    scope: GrantScope;
    expiresInDays?: number;
  }): Promise<void> {
    const record: GrantRecord = {
      command: params.command,
      ...(normaliseArgv(params.argv) !== undefined
        ? { argv: normaliseArgv(params.argv) as string }
        : {}),
      ...(params.cwd !== undefined ? { cwd: resolve(params.cwd) } : {}),
      grantedAt: new Date().toISOString(),
      ...(params.expiresInDays !== undefined
        ? {
            expiresAt: new Date(Date.now() + params.expiresInDays * 86_400_000).toISOString(),
          }
        : {}),
    };
    const key = grantKey(params);

    if (params.scope === "session") {
      const path = this.sessionPath();
      if (path === undefined) throw new Error("no session id: cannot store a session grant");
      const file = await readJson<SessionFile>(path, {
        version: 1,
        startedAt: new Date().toISOString(),
        grants: {},
      });
      file.grants[key] = record;
      await writeJson(path, file);
      return;
    }

    const grants = await readJson<GrantsFile>(this.opts.grantsFile, emptyGrants());
    grants.profile ??= {};
    grants.profile[key] = record;
    delete grants.never?.[params.command];
    await writeJson(this.opts.grantsFile, grants);
  }

  /** Block a command for this profile; beats any grant. */
  async block(command: string): Promise<void> {
    const grants = await readJson<GrantsFile>(this.opts.grantsFile, emptyGrants());
    grants.never ??= {};
    grants.never[command] = { blockedAt: new Date().toISOString() };
    grants.profile ??= {};
    for (const [key, rec] of Object.entries(grants.profile)) {
      if (rec.command === command) delete grants.profile[key];
    }
    await writeJson(this.opts.grantsFile, grants);
  }

  /** Remove every profile grant and block for a command. */
  async revoke(command: string): Promise<void> {
    const grants = await readJson<GrantsFile>(this.opts.grantsFile, emptyGrants());
    grants.profile ??= {};
    for (const [key, rec] of Object.entries(grants.profile)) {
      if (rec.command === command) delete grants.profile[key];
    }
    delete grants.never?.[command];
    await writeJson(this.opts.grantsFile, grants);
  }

  async list(): Promise<{
    profile: GrantRecord[];
    never: string[];
    session: GrantRecord[];
    expired: GrantRecord[];
  }> {
    const grants = await readJson<GrantsFile>(this.opts.grantsFile, emptyGrants());
    const all = Object.values(grants.profile ?? {});
    const profile = all.filter((r) => !isExpired(r));
    const expired = all.filter((r) => isExpired(r));
    const session: GrantRecord[] = [];
    const path = this.sessionPath();
    if (path !== undefined) {
      const file = await readJson<SessionFile>(path, { version: 1, startedAt: "", grants: {} });
      session.push(...Object.values(file.grants).filter((r) => !isExpired(r)));
    }
    return { profile, never: Object.keys(grants.never ?? {}), session, expired };
  }

  /** Drop this session's grants. Called when a session ends. */
  async clearSession(): Promise<void> {
    const path = this.sessionPath();
    if (path !== undefined) await rm(path, { force: true });
  }

  /** Remove session grant files for sessions that are no longer running. */
  async pruneSessions(keepSessionIds: readonly string[]): Promise<number> {
    let removed = 0;
    let entries: string[];
    try {
      entries = await readdir(this.opts.runDir);
    } catch {
      return 0;
    }
    const keep = new Set(keepSessionIds);
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      if (keep.has(name.slice(0, -5))) continue;
      await rm(join(this.opts.runDir, name), { force: true });
      removed += 1;
    }
    return removed;
  }
}
