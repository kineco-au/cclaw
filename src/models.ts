/**
 * Parsing Cursor's model catalogue.
 *
 * `agent models` has no --format json (confirmed via `agent help models`), so
 * the only source is its text output: `id - Display Name` lines under an
 * "Available models" header. Real output contains zero-width spaces (U+200B)
 * and non-breaking spaces, which corrupt naive matching, so sanitising comes
 * first. A parse that yields nothing must never overwrite a good cache.
 */

import { runCursor } from "./cursor.ts";

export interface ModelEntry {
  id: string;
  displayName: string;
}

const ZERO_WIDTH = /[​‌‍﻿]/g;
const NBSP = / /g;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Strip invisible characters and escapes that break line matching. */
export function sanitiseCatalogue(raw: string): string {
  return raw.replace(ANSI, "").replace(ZERO_WIDTH, "").replace(NBSP, " ");
}

const LINE_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s+-\s+(.+)$/;

/** Parse `agent models` output into entries. Unparseable lines are dropped. */
export function parseModels(raw: string): ModelEntry[] {
  const out: ModelEntry[] = [];
  const seen = new Set<string>();
  for (const line of sanitiseCatalogue(raw).split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const m = LINE_RE.exec(trimmed);
    if (!m) continue;
    const id = m[1];
    const displayName = m[2]?.trim();
    if (id === undefined || displayName === undefined || displayName === "") continue;
    // The header "Available models" would otherwise never match LINE_RE, but
    // guard against any future "Foo - Bar" heading sneaking through.
    if (id.includes(" ")) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, displayName });
  }
  return out;
}

export interface CatalogueResult {
  models: ModelEntry[];
  raw: string;
  /** False when the command failed or parsed to nothing, so callers keep the cache. */
  usable: boolean;
}

export async function fetchCatalogue(bin: string): Promise<CatalogueResult> {
  let r = await runCursor(bin, ["models"], { timeoutMs: 60_000 });
  if (!r.ok || sanitiseCatalogue(r.stdout).trim() === "") {
    // Secondary source; the flag form is documented separately from the subcommand.
    r = await runCursor(bin, ["--list-models"], { timeoutMs: 60_000 });
  }
  const models = r.ok ? parseModels(r.stdout) : [];
  return { models, raw: r.stdout, usable: r.ok && models.length > 0 };
}

/**
 * Context window implied by a model's identity.
 *
 * Cursor publishes no machine-readable context window, so this reads what the
 * catalogue does expose: a bracketed `context=` parameter, or a size baked into
 * the display name ("Claude Opus 5.5 1M High"). Returns 0 when nothing can be
 * derived — callers must render "unknown" rather than invent a figure.
 */
export function derivedContextWindow(id: string, displayName = ""): number {
  const bracket = /context=([0-9]+(?:\.[0-9]+)?)([kKmM]?)/.exec(id);
  if (bracket) return scale(bracket[1], bracket[2]);
  const named = /\b([0-9]+(?:\.[0-9]+)?)([MK])\b/.exec(displayName);
  if (named) return scale(named[1], named[2]);
  return 0;
}

function scale(num: string | undefined, suffix: string | undefined): number {
  if (num === undefined) return 0;
  const n = Number.parseFloat(num);
  if (!Number.isFinite(n)) return 0;
  switch (suffix?.toLowerCase()) {
    case "m":
      return Math.round(n * 1_000_000);
    case "k":
      return Math.round(n * 1_000);
    default:
      return Math.round(n);
  }
}

/** Humanise a token count: 1000000 -> "1.0M", 272000 -> "272K". */
export function humaniseTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "unknown";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}
