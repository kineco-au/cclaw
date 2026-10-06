/**
 * Reading a profile's allow/deny lists out of its Cursor config.
 *
 * Shared by `cclaw chat` and `cclaw -p` so both runs enforce the same policy.
 * Cursor stores entries in its own grammar (`Shell(ls)`, `Shell(git:status*)`)
 * while our matcher works on bare command names, so entries are unwrapped and
 * anything that is not a shell rule is dropped.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ProfilePolicy {
  allow: string[];
  deny: string[];
}

/** Unwrap `Shell(cmd)` / `Shell(cmd:args*)` entries to bare command names. */
export function unwrapShellEntries(entries: readonly string[]): string[] {
  return entries
    .map((e) => /^Shell\(([^:)]+)/.exec(e)?.[1])
    .filter((e): e is string => e !== undefined);
}

/** Pull allow/deny out of a parsed cli-config.json, tolerating any shape. */
export function policyFromConfig(raw: unknown): ProfilePolicy {
  const perms = (raw as { permissions?: { allow?: unknown; deny?: unknown } } | null)?.permissions;
  const pick = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    allow: unwrapShellEntries(pick(perms?.allow)),
    deny: unwrapShellEntries(pick(perms?.deny)),
  };
}

/**
 * Read the profile's policy. A missing or malformed config yields empty lists
 * rather than an error: the resolver's own mode then decides, which fails shut
 * under `ask` and `allowlist`.
 */
export async function readPolicyFromConfig(cursorConfigDir: string): Promise<ProfilePolicy> {
  try {
    return policyFromConfig(
      JSON.parse(await readFile(join(cursorConfigDir, "cli-config.json"), "utf8")),
    );
  } catch {
    return { allow: [], deny: [] };
  }
}
