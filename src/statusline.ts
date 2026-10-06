#!/usr/bin/env bun
/**
 * Cursor `statusLine` command.
 *
 * Cursor spawns this per refresh with the status payload on stdin and renders
 * whatever we print on stdout. This is the ONE place a real context-window
 * figure is available: `context_window.context_window_size` is not exposed by
 * any Cursor CLI command, SDK type, or over ACP. That is why `cclaw raw` exists.
 *
 * Rules: never crash, never print anything but the status line, stay fast.
 */

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { humaniseTokens } from "./models.ts";
import { createStyler } from "./ui/style.ts";

/** The payload Cursor sends, as observed in the shipped bundle. */
export interface StatusPayload {
  session_id?: string;
  render_width_chars?: number;
  cwd?: string;
  autorun?: boolean;
  model?: { id?: string; display_name?: string; param_summary?: string; max_mode?: boolean };
  workspace?: { current_dir?: string; project_dir?: string; added_dirs?: string[] };
  context_window?: {
    total_input_tokens?: number | null;
    total_output_tokens?: number | null;
    context_window_size?: number | null;
    used_percentage?: number | null;
    remaining_percentage?: number | null;
    current_usage?: number | null;
  };
  session_name?: string;
  vim?: { mode?: string };
  worktree?: { name?: string; path?: string };
}

export interface RenderOptions {
  profile?: string;
  goal?: string;
  colour?: boolean;
}

function shortenPath(p: string | undefined, home: string | undefined): string {
  if (p === undefined || p === "") return "";
  if (home !== undefined && home !== "" && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}

/**
 * Build the status line. Pure, so it can be tested against real payloads.
 */
export function renderStatus(
  payload: StatusPayload,
  opts: RenderOptions = {},
  env: Record<string, string | undefined> = {},
): string {
  const s = createStyler(
    opts.colour === true ? { CCLAW_COLOUR_FORCE: "1" } : { NO_COLOR: "1" },
    true,
  );
  const parts: string[] = [];

  if (opts.profile !== undefined && opts.profile !== "") parts.push(s.pink(opts.profile));

  const model = payload.model?.display_name ?? payload.model?.id;
  if (model !== undefined && model !== "") {
    parts.push(payload.model?.max_mode === true ? `${model} (max)` : model);
  }

  // The context figure. Absent or zero means Cursor did not report one, and we
  // say "unknown" rather than invent a denominator.
  const cw = payload.context_window;
  if (cw !== undefined) {
    const size = typeof cw.context_window_size === "number" ? cw.context_window_size : 0;
    const used = typeof cw.total_input_tokens === "number" ? cw.total_input_tokens : null;
    const pct = typeof cw.used_percentage === "number" ? cw.used_percentage : null;
    if (size > 0) {
      const usedLabel = used !== null ? humaniseTokens(used) : "?";
      const pctLabel = pct !== null ? ` (${pct.toFixed(0)}%)` : "";
      const text = `ctx ${usedLabel}/${humaniseTokens(size)}${pctLabel}`;
      // Warn as the window fills; this is the number people actually act on.
      parts.push(pct !== null && pct >= 80 ? s.yellow(text) : text);
    } else if (used !== null && used > 0) {
      parts.push(`ctx ${humaniseTokens(used)}/unknown`);
    }
  }

  if (opts.goal !== undefined && opts.goal !== "") {
    parts.push(s.blue(`goal: ${opts.goal}`));
  }

  const dir = shortenPath(payload.workspace?.current_dir ?? payload.cwd, env.HOME);
  if (dir !== "") parts.push(s.dim(dir));

  const extra = payload.workspace?.added_dirs?.length ?? 0;
  if (extra > 0) parts.push(s.dim(`+${extra} dir${extra === 1 ? "" : "s"}`));

  if (payload.vim?.mode !== undefined && payload.vim.mode !== "") {
    parts.push(s.dim(payload.vim.mode.toUpperCase()));
  }

  let line = parts.join(s.dim(" · "));

  // Respect the width Cursor gives us so the line never wraps.
  const width = payload.render_width_chars;
  if (typeof width === "number" && width > 8) {
    // Measure without escape sequences.
    const visible = line.replace(/\x1b\[[0-9;]*m/g, "");
    if (visible.length > width) {
      // Truncate conservatively on the plain text to avoid cutting mid-escape.
      const plain = visible.slice(0, width - 1);
      line = `${plain}…`;
    }
  }
  return line;
}

/** Cache an observed window size so other commands can report it later. */
async function cacheContextWindow(cacheFile: string, modelId: string, size: number): Promise<void> {
  if (modelId === "" || size <= 0) return;
  try {
    await mkdir(dirname(cacheFile), { recursive: true });
    let doc: { version: number; models: Record<string, unknown> } = { version: 1, models: {} };
    try {
      const parsed: unknown = JSON.parse(await readFile(cacheFile, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        doc = parsed as typeof doc;
        doc.models ??= {};
      }
    } catch {
      // fresh cache
    }
    doc.models[modelId] = { size, observedAt: new Date().toISOString(), source: "statusline" };
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`);
    await rename(tmp, cacheFile);
  } catch {
    // A status line must never fail because a cache write did.
  }
}

/** Read the payload from stdin and print the status line. */
export async function runStatusline(): Promise<void> {
  let raw = "";
  try {
    raw = await new Response(Bun.stdin.stream()).text();
  } catch {
    return;
  }
  let payload: StatusPayload = {};
  try {
    payload = JSON.parse(raw) as StatusPayload;
  } catch {
    // Unparseable payload: print nothing rather than garbage.
    return;
  }

  const profile = process.env.CCLAW_PROFILE;
  const profileDir = process.env.CCLAW_PROFILE_DIR;

  let goal: string | undefined;
  if (profileDir !== undefined) {
    try {
      const g: unknown = JSON.parse(await readFile(join(profileDir, "goal.json"), "utf8"));
      if (typeof g === "object" && g !== null && "text" in g) {
        const t = (g as { text?: unknown }).text;
        if (typeof t === "string" && t !== "") goal = t;
      }
    } catch {
      // no goal set
    }
  }

  process.stdout.write(renderStatus(payload, { profile, goal, colour: true }, process.env));

  if (profileDir !== undefined) {
    const size = payload.context_window?.context_window_size;
    const modelId = payload.model?.id ?? "";
    if (typeof size === "number" && size > 0) {
      await cacheContextWindow(join(profileDir, "context-cache.json"), modelId, size);
    }
    if (process.env.CCLAW_STATUSLINE_DEBUG === "1") {
      try {
        await appendFile(join(profileDir, "log", "statusline.jsonl"), `${raw.trim()}\n`);
      } catch {
        // debug only
      }
    }
  }
}

if (import.meta.main) {
  await runStatusline();
}
