/**
 * ADAPTER for OpenClaw's src/agents/tool-display.ts.
 *
 * Not a port. Upstream resolves tool presentation from a large TOOL_DISPLAY_CONFIG
 * table keyed by OpenClaw's own tool names, and pulls in tool-display-call,
 * -config and -exec plus the redaction layer. Cursor's tools arrive over ACP
 * with their own names and argument shapes, so that table would not match
 * anything.
 *
 * The contract kept is the one the ported `components/tool-execution.ts`
 * depends on: `resolveToolDisplay` returning a `ToolDisplay`, and
 * `formatToolDetail` turning it into one compact line.
 */

export type ToolDetailMode = "compact" | "full" | "off";

export type ToolDisplay = {
  name: string;
  title: string;
  label: string;
  verb?: string;
  detail?: string;
};

/** Argument keys worth surfacing, in priority order, across common tools. */
const DETAIL_KEYS = [
  "command",
  "cmd",
  "file_path",
  "filePath",
  "path",
  "file",
  "pattern",
  "query",
  "url",
  "prompt",
  "description",
] as const;

/**
 * `read_file` -> `Read File`; `mcp__foo__bar` -> `Foo Bar`.
 *
 * A name that already contains a space is a label someone composed, not a
 * tool identifier, so it is left alone. Title-casing it produced rows like
 * `Read Src/cli Ts` from `Read src/cli.ts`.
 */
function humanise(name: string): string {
  if (/\s/.test(name.trim())) return name.trim();
  const stripped = name.replace(/^mcp__/, "").replace(/__/g, " ");
  const words = stripped.split(/[\s_\-.]+/).filter((w) => w !== "");
  if (words.length === 0) return "Tool";
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/**
 * A readable summary of whatever arguments are left.
 *
 * The component's own fallback is `JSON.stringify(args)`, which renders rows
 * like `Execute {"title":"…"}`. Returning a `key: value` line instead keeps
 * that path from ever being reached, including for tools whose arguments use
 * keys we do not know.
 */
function summariseArgs(rec: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(rec)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "object") continue;
    const text = String(value).replace(/\s+/gu, " ").trim();
    if (text === "") continue;
    parts.push(`${key}: ${text.length > 60 ? `${text.slice(0, 59)}…` : text}`);
    if (parts.length === 3) break;
  }
  return parts.length === 0 ? undefined : parts.join("  ");
}

function firstDetail(args: unknown): string | undefined {
  if (args === null || typeof args !== "object") {
    return typeof args === "string" && args !== "" ? args : undefined;
  }
  const rec = args as Record<string, unknown>;
  for (const key of DETAIL_KEYS) {
    const v = rec[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return summariseArgs(rec);
}

export function resolveToolDisplay(params: {
  name?: string;
  args?: unknown;
  meta?: string;
  detailMode?: ToolDetailMode;
}): ToolDisplay {
  const name = (params.name ?? "tool").trim() || "tool";
  const title = humanise(name);
  const detail =
    params.detailMode === "off" ? undefined : (params.meta ?? firstDetail(params.args));
  return { name, title, label: title, ...(detail !== undefined ? { detail } : {}) };
}

/** Collapse a detail to a single line and bound its length for the title row. */
export function formatToolDetail(display: ToolDisplay): string | undefined {
  if (display.detail === undefined) return undefined;
  const line = display.detail.replace(/\s+/gu, " ").trim();
  if (line === "") return undefined;
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}
