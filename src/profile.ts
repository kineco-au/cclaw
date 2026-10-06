/**
 * Profile lifecycle.
 *
 * A profile is isolation via two environment variables that Cursor honours.
 * Verified live, including which holds what — the split is not what the names
 * suggest and is undocumented:
 *   CURSOR_CONFIG_DIR -> cli-config.json, permissions.json, chats/
 *   CURSOR_DATA_DIR   -> projects/
 * In the shipped bundle the chats path is `join(configDir(), "chats")`, so chat
 * history follows the CONFIG dir. Both are set per profile, so session history
 * is isolated either way.
 *
 * Credentials are the limit of that isolation. On macOS the web login lives in
 * the system keychain under service `cursor-access-token`, a single global slot,
 * and the auth file path derives from homedir() and ignores CURSOR_CONFIG_DIR.
 * So profiles share one signed-in identity unless each carries its own
 * CURSOR_API_KEY. `show` states this plainly rather than implying otherwise.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  isValidProfileName,
  profilePaths,
  resolvePaths,
  type Paths,
  type ProfilePaths,
} from "./env.ts";

export type CredMode = "inherit" | "keychain" | "file";

export interface ProfileMeta {
  version: 1;
  name: string;
  createdAt: string;
  credMode: CredMode;
  identityEmail: string | null;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function profileExists(paths: Paths, name: string): Promise<boolean> {
  return await Bun.file(profilePaths(paths, name).profileFile).exists();
}

export async function listProfiles(paths: Paths): Promise<string[]> {
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(paths.profiles, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export async function defaultProfile(paths: Paths): Promise<string> {
  const cfg = await readJson<{ defaultProfile?: string }>(paths.configFile);
  return cfg?.defaultProfile ?? "default";
}

export async function setDefaultProfile(paths: Paths, name: string): Promise<void> {
  const cfg = (await readJson<Record<string, unknown>>(paths.configFile)) ?? { version: 1 };
  cfg.defaultProfile = name;
  await writeJsonAtomic(paths.configFile, cfg);
}

/** Explicit flag, then env, then the recorded default. */
export async function resolveProfileName(
  paths: Paths,
  explicit?: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  if (explicit !== undefined && explicit !== "") return explicit;
  if (env.CCLAW_PROFILE !== undefined && env.CCLAW_PROFILE !== "") return env.CCLAW_PROFILE;
  return await defaultProfile(paths);
}

export interface CreateOptions {
  credMode?: CredMode;
  /** Copy cli-config.json and permissions.json from an existing Cursor config dir. */
  importFrom?: string;
}

export async function createProfile(
  paths: Paths,
  name: string,
  opts: CreateOptions = {},
): Promise<ProfilePaths> {
  if (!isValidProfileName(name)) {
    throw new Error(
      `invalid profile name '${name}' (letters, digits, - and _; must start alphanumeric; max 32 chars)`,
    );
  }
  const pp = profilePaths(paths, name);
  if (await profileExists(paths, name)) throw new Error(`profile '${name}' already exists`);

  await mkdir(pp.dir, { recursive: true, mode: 0o700 });
  for (const d of [pp.cursorConfigDir, pp.cursorDataDir, pp.backupsDir, pp.logDir]) {
    await mkdir(d, { recursive: true });
  }

  if (opts.importFrom !== undefined) {
    for (const f of ["cli-config.json", "permissions.json"]) {
      const src = join(opts.importFrom, f);
      if (await Bun.file(src).exists()) {
        await writeFile(join(pp.cursorConfigDir, f), await readFile(src));
      }
    }
  }

  const meta: ProfileMeta = {
    version: 1,
    name,
    createdAt: new Date().toISOString(),
    credMode: opts.credMode ?? "inherit",
    identityEmail: null,
  };
  await writeJsonAtomic(pp.profileFile, meta);
  await writeJsonAtomic(pp.modelsFile, { version: 1, active: null, allow: [], refreshedAt: null });
  await writeJsonAtomic(pp.grantsFile, { version: 1, permanent: {}, never: {} });
  await writeJsonAtomic(pp.dirsFile, { version: 1, allowed: [] });
  await writeJsonAtomic(pp.contextCacheFile, { version: 1, models: {} });
  return pp;
}

export async function readProfileMeta(pp: ProfilePaths): Promise<ProfileMeta | null> {
  return await readJson<ProfileMeta>(pp.profileFile);
}

export interface LaunchEnv {
  [k: string]: string;
}

/**
 * The exact environment a launch exports. Single source of truth, so
 * `profile show` and `--dry-run` cannot drift from what actually runs.
 */
export function launchEnv(
  pp: ProfilePaths,
  paths: Paths,
  opts: { statusLineDir?: string; apiKey?: string } = {},
): LaunchEnv {
  const env: LaunchEnv = {
    CURSOR_CONFIG_DIR: pp.cursorConfigDir,
    CURSOR_DATA_DIR: pp.cursorDataDir,
    CCLAW_PROFILE: pp.name,
    CCLAW_PROFILE_DIR: pp.dir,
    CCLAW_HOME: paths.home,
  };
  if (opts.apiKey !== undefined && opts.apiKey !== "") env.CURSOR_API_KEY = opts.apiKey;
  return env;
}

/** Ensure the default profile exists, creating it on first use. */
export async function ensureProfile(
  paths: Paths,
  name: string,
): Promise<{ pp: ProfilePaths; created: boolean }> {
  if (await profileExists(paths, name)) {
    return { pp: profilePaths(paths, name), created: false };
  }
  const pp = await createProfile(paths, name);
  return { pp, created: true };
}

export { profilePaths, resolvePaths };
