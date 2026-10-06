/** The cclaw banner, with colour, width and suppression ladders. */

import { createStyler, type Styler } from "./style.ts";

/** ANSI-Shadow rendering of the cclaw wordmark. Every line is 43 columns. */
const ART = [
  " ██████╗ ██████╗ ██╗      █████╗ ██╗    ██╗",
  "██╔════╝██╔════╝ ██║     ██╔══██╗██║    ██║",
  "██║     ██║      ██║     ███████║██║ █╗ ██║",
  "██║     ██║      ██║     ██╔══██║██║███╗██║",
  "╚██████╗╚██████╗ ███████╗██║  ██║╚███╔███╔╝",
  " ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝ ",
] as const;

const INDENT = "   ";
/** Widest art line (43) plus indent; below this the banner collapses to one line. */
const MIN_WIDTH = 47;

export interface BannerOptions {
  /** Single dim line under the art, e.g. "work · Claude Opus 5.5 · ctx 4%". */
  subtitle?: string;
  /** Explicit suppression, from --no-banner. */
  suppress?: boolean;
  env?: Record<string, string | undefined>;
  isTty?: boolean;
  columns?: number;
  styler?: Styler;
}

/**
 * Terminal width. `process.stdout.columns` is undefined when stdout is not a
 * tty, so COLUMNS is honoured as a fallback — otherwise a narrow terminal that
 * pipes our output would still get the wide art.
 */
function terminalColumns(env: Record<string, string | undefined>): number {
  const fromStream = process.stdout.columns;
  if (typeof fromStream === "number" && fromStream > 0) return fromStream;
  const fromEnv = Number.parseInt(env.COLUMNS ?? "", 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return 80;
}

/**
 * Suppression ladder, first match wins. Headless output must stay parseable and
 * art must never land in a pipe or a log.
 */
export function bannerSuppressed(opts: BannerOptions = {}): boolean {
  const env = opts.env ?? process.env;
  if (env.CCLAW_BANNER_FORCE === "1") return false;
  if (opts.suppress === true) return true;
  if (env.CCLAW_NO_BANNER === "1") return true;
  if (env.CCLAW_QUIET === "1") return true;
  if (env.CCLAW_HEADLESS === "1") return true;
  if (env.TERM === "dumb") return true;
  const isTty = opts.isTty ?? process.stdout.isTTY === true;
  return !isTty;
}

/** Render the banner as a string. Empty when suppressed. */
export function renderBanner(opts: BannerOptions = {}): string {
  if (bannerSuppressed(opts)) return "";
  const env = opts.env ?? process.env;
  const isTty = opts.isTty ?? process.stdout.isTTY === true;
  const s = opts.styler ?? createStyler(env, isTty);
  const columns = opts.columns ?? terminalColumns(env);

  const lines: string[] = [];
  if (columns < MIN_WIDTH) {
    lines.push(s.bold(s.pink(" cclaw ")));
    if (opts.subtitle) lines.push(s.dim(`  ${opts.subtitle}`));
    return lines.join("\n") + "\n";
  }

  lines.push("");
  for (const row of ART) lines.push(s.pink(INDENT + row));
  if (opts.subtitle) lines.push(s.dim(INDENT + opts.subtitle));
  lines.push("");
  return lines.join("\n") + "\n";
}

export function printBanner(opts: BannerOptions = {}): void {
  const out = renderBanner(opts);
  if (out !== "") process.stdout.write(out);
}
