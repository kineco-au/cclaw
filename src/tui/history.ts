/**
 * Prompt history, persisted per profile.
 *
 * pi-tui's Editor already implements up/down history browsing — including the
 * guards that keep the arrows working as caret movement in multi-line input
 * (history only triggers on the first/last visual line). It just needs feeding:
 * `addToHistory` on submit, and seeding on startup so history survives a restart.
 *
 * Stored as JSONL rather than one-entry-per-line text because prompts can
 * contain newlines, and a line-based format would split them. A corrupt or
 * half-written line is skipped rather than discarding the whole file.
 */

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Kept a little above pi-tui's in-memory cap of 100 so a restart still has depth. */
export const HISTORY_FILE_LIMIT = 200;

/** Parse JSONL history, newest last. Bad lines are skipped, not fatal. */
export function parseHistory(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      const t = (parsed as { t?: unknown }).t;
      if (typeof t === "string" && t.trim() !== "") out.push(t);
    } catch {
      // A truncated final line from an interrupted write: skip it.
    }
  }
  return out;
}

export function serialiseHistory(entries: readonly string[]): string {
  return entries.map((t) => `${JSON.stringify({ t })}\n`).join("");
}

/** Read history oldest-first. */
export async function loadHistory(path: string): Promise<string[]> {
  try {
    return parseHistory(await readFile(path, "utf8"));
  } catch {
    return [];
  }
}

/**
 * Append one entry, skipping blanks and consecutive duplicates to match the
 * editor's own behaviour. Rewrites the file when it grows past the cap.
 */
export async function appendHistory(path: string, text: string): Promise<void> {
  const entry = text.trim();
  if (entry === "") return;
  const existing = await loadHistory(path);
  if (existing.at(-1) === entry) return;

  await mkdir(dirname(path), { recursive: true });
  if (existing.length + 1 > HISTORY_FILE_LIMIT) {
    const trimmed = [...existing, entry].slice(-HISTORY_FILE_LIMIT);
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, serialiseHistory(trimmed), { mode: 0o600 });
    await rename(tmp, path);
    return;
  }
  await appendFile(path, serialiseHistory([entry]), { mode: 0o600 });
}

/**
 * Seed the editor. Oldest first, because the editor unshifts each entry, so
 * feeding in order leaves the most recent at the front where Up finds it first.
 */
export function seedEditorHistory(
  editor: { addToHistory: (text: string) => void },
  entries: readonly string[],
): void {
  for (const entry of entries.slice(-100)) editor.addToHistory(entry);
}
