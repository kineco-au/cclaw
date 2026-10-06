/**
 * Merge-not-clobber JSON policy seeding.
 *
 * Precedence: defaults < existing < enforce.
 *   defaults — our opinion, applied only where the user has no value
 *   existing — whatever is on disk, including Cursor's own managed fields
 *   enforce  — keys we own and always assert
 *
 * Objects merge recursively and scalars take the higher-precedence value, but
 * arrays would otherwise be replaced wholesale, so named array paths are
 * unioned instead. Cursor rewrites these files itself and silently drops keys
 * it does not recognise, so we never store our own metadata here.
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

/** Array paths merged by union rather than replacement. */
export const UNION_PATHS: readonly string[][] = [
  ["permissions", "allow"],
  ["permissions", "deny"],
  ["sandbox", "networkAllowlist"],
  ["sandbox", "additionalReadPaths"],
  ["autoRun", "allow_instructions"],
  ["autoRun", "block_instructions"],
];

function isPlainObject(v: Json | undefined): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Recursive merge where `b` wins. Arrays are replaced, not concatenated. */
export function deepMerge(a: Json, b: Json): Json {
  if (!isPlainObject(a) || !isPlainObject(b)) return b;
  const out: JsonObject = { ...a };
  for (const [k, bv] of Object.entries(b)) {
    const av = out[k];
    out[k] = isPlainObject(av) && isPlainObject(bv) ? deepMerge(av, bv) : bv;
  }
  return out;
}

function getPath(obj: Json, path: readonly string[]): Json | undefined {
  let cur: Json | undefined = obj;
  for (const seg of path) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function setPath(obj: JsonObject, path: readonly string[], value: Json): void {
  let cur: JsonObject = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    if (seg === undefined) return;
    const next = cur[seg];
    if (!isPlainObject(next)) cur[seg] = {};
    cur = cur[seg] as JsonObject;
  }
  const last = path[path.length - 1];
  if (last !== undefined) cur[last] = value;
}

/** Order-preserving union: existing entries keep their position, ours append. */
export function unionArrays(a: Json | undefined, b: Json | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const src of [a, b]) {
    if (!Array.isArray(src)) continue;
    for (const v of src) {
      if (typeof v !== "string") continue;
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

export interface MergeInput {
  existing: JsonObject;
  defaults: JsonObject;
  enforce: JsonObject;
}

/**
 * Produce the merged document. Pure: no IO, so it is cheap to test exhaustively.
 */
export function mergePolicy({ existing, defaults, enforce }: MergeInput): JsonObject {
  let merged = deepMerge(deepMerge(defaults, existing), enforce) as JsonObject;

  for (const path of UNION_PATHS) {
    const union = unionArrays(getPath(existing, path), getPath(enforce, path));
    if (union.length > 0) setPath(merged, path, union);
  }

  // Keep allow and deny non-contradictory so `policy show` is truthful. Cursor
  // enforces deny-beats-allow regardless; this only avoids authoring nonsense.
  const allow = getPath(merged, ["permissions", "allow"]);
  const deny = getPath(merged, ["permissions", "deny"]);
  if (Array.isArray(allow) && Array.isArray(deny)) {
    const denySet = new Set(deny.filter((d): d is string => typeof d === "string"));
    setPath(
      merged,
      ["permissions", "allow"],
      allow.filter((a): a is string => typeof a === "string" && !denySet.has(a)),
    );
  }

  merged = sortKeys(merged) as JsonObject;
  return merged;
}

/** Stable key order, so an unchanged merge is byte-identical and detectable. */
export function sortKeys(v: Json): Json {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (!isPlainObject(v)) return v;
  const out: JsonObject = {};
  for (const k of Object.keys(v).sort()) {
    const val = v[k];
    if (val !== undefined) out[k] = sortKeys(val);
  }
  return out;
}

/**
 * Did every enforced scalar land? Array members are unioned rather than
 * replaced, so their positions legitimately differ and are not compared.
 */
export function enforcedScalarsPresent(result: Json, enforce: Json): boolean {
  const walk = (node: Json, path: string[]): boolean => {
    if (Array.isArray(node)) return true;
    if (isPlainObject(node)) {
      return Object.entries(node).every(([k, v]) => walk(v, [...path, k]));
    }
    return getPath(result, path) === node;
  };
  return walk(enforce, []);
}

/** Expand @@PLACEHOLDER@@ tokens in a policy template. */
export function renderTemplate(text: string, vars: Record<string, string>): string {
  let out = text;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`@@${k}@@`, v);
  }
  return out;
}
