/** Terminal colour support detection and the SEEK palette. */

export type ColourDepth = "truecolor" | "ansi256" | "ansi16" | "none";

/** SEEK brand colours, from seek-oss/braid-design-system `palette.ts`. */
export const SEEK = {
  /** seekPink.500 — the wordmark colour. */
  pink: [230, 2, 120] as const,
  /** seekBlue.500 — too dark for a dark terminal; reserved for light backgrounds. */
  blue: [13, 56, 128] as const,
  /** seekBlueLight.500 — the readable blue on both themes. */
  blueLight: [75, 132, 231] as const,
} as const;

export function detectDepth(env: Record<string, string | undefined> = process.env): ColourDepth {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  if (env.TERM === "dumb") return "none";
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") return "truecolor";
  if (env.TERM?.includes("256color")) return "ansi256";
  if (env.TERM === undefined || env.TERM === "") return "none";
  return "ansi16";
}

/**
 * Whether styled output is appropriate. Respects NO_COLOR and refuses to emit
 * escapes into a pipe, so redirected output stays clean.
 */
export function colourEnabled(
  env: Record<string, string | undefined> = process.env,
  isTty: boolean = process.stdout.isTTY === true,
): boolean {
  if (env.CCLAW_COLOUR_FORCE === "1") return true;
  if (!isTty) return false;
  return detectDepth(env) !== "none";
}

const RESET = "\x1b[0m";

function rgb(c: readonly [number, number, number], depth: ColourDepth): string {
  switch (depth) {
    case "truecolor":
      return `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
    case "ansi256":
      // Nearest 256-palette entries for the SEEK pink and light blue.
      return c === SEEK.pink ? "\x1b[38;5;198m" : "\x1b[38;5;69m";
    case "ansi16":
      return c === SEEK.pink ? "\x1b[1;35m" : "\x1b[1;34m";
    case "none":
      return "";
  }
}

export interface Styler {
  readonly enabled: boolean;
  pink(s: string): string;
  blue(s: string): string;
  dim(s: string): string;
  bold(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
  green(s: string): string;
}

export function createStyler(
  env: Record<string, string | undefined> = process.env,
  isTty: boolean = process.stdout.isTTY === true,
): Styler {
  const on = colourEnabled(env, isTty);
  const depth = on ? detectDepth(env) : "none";
  // CCLAW_COLOUR_FORCE is a test hook; assume truecolor when it is the only reason we are on.
  const effective: ColourDepth = on && depth === "none" ? "truecolor" : depth;
  const wrap = (open: string) => (s: string) => (on && open !== "" ? `${open}${s}${RESET}` : s);
  return {
    enabled: on,
    pink: wrap(rgb(SEEK.pink, effective)),
    blue: wrap(rgb(SEEK.blueLight, effective)),
    dim: wrap(on ? "\x1b[2m" : ""),
    bold: wrap(on ? "\x1b[1m" : ""),
    red: wrap(on ? "\x1b[31m" : ""),
    yellow: wrap(on ? "\x1b[33m" : ""),
    green: wrap(on ? "\x1b[32m" : ""),
  };
}
