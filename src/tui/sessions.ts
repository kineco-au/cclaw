/**
 * Persisted session transcripts, so a conversation survives leaving the TUI.
 *
 * One JSONL file per session under the profile's `sessions/` directory: a
 * header line holding the ACP session id, then one line per turn. JSONL rather
 * than a single JSON document because turns are appended one at a time and a
 * crash mid-write must not cost the whole file — a truncated last line is
 * dropped on read.
 *
 * Resume needs both halves. The transcript is ours and replays into the chat
 * log; the ACP session id is Cursor's and is what `session/load` restores the
 * model's own context from.
 */

import { appendFile, mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { TranscriptEntry } from "./acp-backend.ts";

/** Keep the directory bounded; oldest files are pruned past this. */
export const MAX_SESSIONS = 50;

export interface SessionHeader {
  v: 1;
  id: string;
  acpSessionId: string;
  cwd: string;
  startedAt: number;
  /** The goal being worked, so resuming restores it. Absent in older files. */
  goal?: string;
}

export interface SessionSummary {
  id: string;
  acpSessionId: string;
  cwd: string;
  startedAt: number;
  updatedAt: number;
  turns: number;
  /** The first thing the user typed, which is what makes a session findable. */
  firstPrompt?: string;
  /** The goal this session was working, if any. */
  goal?: string;
}

/** A session id that sorts chronologically and is safe as a filename. */
export function newSessionId(now = new Date()): string {
  const iso = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `${iso}-${Math.random().toString(36).slice(2, 8)}`;
}

const SESSION_FILE_RE = /^[0-9A-Za-z-]+\.jsonl$/;

function fileFor(dir: string, id: string): string {
  return join(dir, `${id}.jsonl`);
}

export async function startSession(dir: string, header: Omit<SessionHeader, "v">): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const line: SessionHeader = { v: 1, ...header };
  await appendFile(fileFor(dir, header.id), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  return header.id;
}

/** Append one turn. Never throws: losing history must not fail a turn. */
export async function appendTurn(dir: string, id: string, entry: TranscriptEntry): Promise<void> {
  try {
    await appendFile(fileFor(dir, id), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // History is a convenience, not part of the turn.
  }
}

/**
 * Parse a session file. Returns null when the header is missing or unreadable,
 * since a transcript with no ACP session id cannot be resumed.
 */
export function parseSessionFile(
  text: string,
): { header: SessionHeader; entries: TranscriptEntry[] } | null {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const first = lines.shift();
  if (first === undefined) return null;
  let header: SessionHeader;
  try {
    const raw: unknown = JSON.parse(first);
    const h = raw as Partial<SessionHeader>;
    if (typeof h.id !== "string" || typeof h.acpSessionId !== "string") return null;
    header = {
      v: 1,
      id: h.id,
      acpSessionId: h.acpSessionId,
      cwd: typeof h.cwd === "string" ? h.cwd : "",
      startedAt: typeof h.startedAt === "number" ? h.startedAt : 0,
      ...(typeof h.goal === "string" && h.goal !== "" ? { goal: h.goal } : {}),
    };
  } catch {
    return null;
  }
  const entries: TranscriptEntry[] = [];
  for (const line of lines) {
    try {
      const raw: unknown = JSON.parse(line);
      const e = raw as Partial<TranscriptEntry>;
      if (typeof e.text !== "string") continue;
      if (e.role !== "user" && e.role !== "assistant" && e.role !== "thought") continue;
      entries.push({ role: e.role, text: e.text });
    } catch {
      // A truncated final line from an interrupted write.
    }
  }
  return { header, entries };
}

export function summarise(
  header: SessionHeader,
  entries: TranscriptEntry[],
  updatedAt: number,
): SessionSummary {
  const firstPrompt = entries.find((e) => e.role === "user")?.text;
  return {
    id: header.id,
    acpSessionId: header.acpSessionId,
    cwd: header.cwd,
    startedAt: header.startedAt,
    updatedAt,
    turns: entries.filter((e) => e.role === "user").length,
    ...(firstPrompt !== undefined ? { firstPrompt } : {}),
    ...(header.goal !== undefined && header.goal !== "" ? { goal: header.goal } : {}),
  };
}

/** Sessions newest first. Unreadable or headerless files are skipped. */
export async function listSessions(dir: string): Promise<SessionSummary[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: SessionSummary[] = [];
  for (const name of names) {
    if (!SESSION_FILE_RE.test(name)) continue;
    const path = join(dir, name);
    try {
      const [text, st] = await Promise.all([readFile(path, "utf8"), stat(path)]);
      const parsed = parseSessionFile(text);
      if (parsed === null) continue;
      out.push(summarise(parsed.header, parsed.entries, st.mtimeMs));
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function readSession(
  dir: string,
  id: string,
): Promise<{ header: SessionHeader; entries: TranscriptEntry[] } | null> {
  try {
    return parseSessionFile(await readFile(fileFor(dir, id), "utf8"));
  } catch {
    return null;
  }
}

/** Drop the oldest sessions beyond MAX_SESSIONS. */
export async function pruneSessions(dir: string, keep = MAX_SESSIONS): Promise<number> {
  const all = await listSessions(dir);
  const doomed = all.slice(keep);
  let removed = 0;
  for (const s of doomed) {
    try {
      await unlink(fileFor(dir, s.id));
      removed += 1;
    } catch {
      continue;
    }
  }
  return removed;
}

/** Resolve "2", an id, or an id prefix to a session. Numbers are 1-based. */
export function resolveSelector(
  sessions: readonly SessionSummary[],
  selector: string,
): SessionSummary | undefined {
  const trimmed = selector.trim();
  if (trimmed === "") return undefined;
  if (/^\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    return n >= 1 && n <= sessions.length ? sessions[n - 1] : undefined;
  }
  return sessions.find((s) => s.id === trimmed) ?? sessions.find((s) => s.id.startsWith(trimmed));
}

/** Longest transcript we will carry into a fresh session as context. */
export const MAX_CARRY_CHARS = 12_000;

/**
 * Render a transcript as text, for carrying into a session that cannot inherit
 * it natively.
 *
 * Cursor advertises `loadSession: true`, but its persisted session record holds
 * only `{schemaVersion, cwd, title}` and `session/load` answers "Session not
 * found" for ids it has itself written. So resume cannot depend on the agent
 * restoring its own context; replaying the transcript as text is the path that
 * always works. Reasoning is left out: it is the model's own working notes, not
 * conversation, and it is the bulkiest thing in the file.
 *
 * Oldest turns are dropped first when over budget, since the recent ones
 * determine what happens next.
 */
export function renderTranscript(
  entries: readonly TranscriptEntry[],
  maxChars = MAX_CARRY_CHARS,
): string {
  const lines = entries
    .filter((e) => e.role !== "thought")
    .filter((e) => e.text.trim() !== "")
    .map((e) => `${e.role === "user" ? "User" : "Assistant"}: ${e.text.trim()}`);
  if (lines.length === 0) return "";

  const kept: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (total + line.length > maxChars && kept.length > 0) {
      kept.unshift(`[${i + 1} earlier turn${i === 0 ? "" : "s"} omitted]`);
      break;
    }
    kept.unshift(line);
    total += line.length;
  }
  return kept.join("\n\n");
}
