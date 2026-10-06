/** Filesystem layout and process environment for cclaw. */

import { homedir } from "node:os";
import { join } from "node:path";

export const CCLAW_VERSION = "0.1.0";

/** Cursor silently relocates its projects dir beyond this length. Keep paths short. */
export const PROJECTS_PATH_LIMIT = 84;

export interface Paths {
  /** State root, default ~/.cclaw. */
  home: string;
  /** Global config: default profile and the resolved Cursor binary. */
  configFile: string;
  /** Per-session scratch, cleared when a session ends. */
  run: string;
  profiles: string;
}

export function resolvePaths(env: Record<string, string | undefined> = process.env): Paths {
  const home = env.CCLAW_HOME && env.CCLAW_HOME !== "" ? env.CCLAW_HOME : join(homedir(), ".cclaw");
  return {
    home,
    configFile: join(home, "config.json"),
    run: join(home, "run"),
    profiles: join(home, "profiles"),
  };
}

export interface ProfilePaths {
  name: string;
  dir: string;
  /**
   * Exported as CURSOR_CONFIG_DIR. Verified to hold cli-config.json,
   * permissions.json and — despite the name — chats/.
   */
  cursorConfigDir: string;
  /** Exported as CURSOR_DATA_DIR. Verified to hold projects/. */
  cursorDataDir: string;
  profileFile: string;
  modelsFile: string;
  grantsFile: string;
  dirsFile: string;
  goalFile: string;
  historyFile: string;
  /** Session transcripts, one JSONL file each, for /resume. */
  sessionsDir: string;
  /** User-defined slash commands: one markdown file per command. */
  commandsDir: string;
  contextCacheFile: string;
  backupsDir: string;
  logDir: string;
}

export function profilePaths(paths: Paths, name: string): ProfilePaths {
  const dir = join(paths.profiles, name);
  return {
    name,
    dir,
    cursorConfigDir: join(dir, "config"),
    cursorDataDir: join(dir, "data"),
    profileFile: join(dir, "profile.json"),
    modelsFile: join(dir, "models.json"),
    grantsFile: join(dir, "grants.json"),
    dirsFile: join(dir, "dirs.json"),
    goalFile: join(dir, "goal.json"),
    historyFile: join(dir, "history.jsonl"),
    sessionsDir: join(dir, "sessions"),
    commandsDir: join(dir, "commands"),
    contextCacheFile: join(dir, "context-cache.json"),
    backupsDir: join(dir, "backups"),
    logDir: join(dir, "log"),
  };
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export function isValidProfileName(name: string): boolean {
  return NAME_RE.test(name);
}
