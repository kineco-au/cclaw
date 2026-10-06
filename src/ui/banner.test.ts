import { describe, expect, test } from "bun:test";
import { bannerSuppressed, renderBanner } from "./banner.ts";
import { colourEnabled, createStyler, detectDepth } from "./style.ts";

const tty = { isTty: true, columns: 100 };

describe("bannerSuppressed", () => {
  test("suppressed when not a tty, so art never lands in a pipe", () => {
    expect(bannerSuppressed({ env: {}, isTty: false })).toBe(true);
  });

  test("suppressed by --no-banner and by the env flags", () => {
    expect(bannerSuppressed({ ...tty, suppress: true, env: {} })).toBe(true);
    expect(bannerSuppressed({ ...tty, env: { CCLAW_NO_BANNER: "1" } })).toBe(true);
    expect(bannerSuppressed({ ...tty, env: { CCLAW_QUIET: "1" } })).toBe(true);
  });

  test("suppressed in headless mode, where stdout must stay parseable", () => {
    expect(bannerSuppressed({ ...tty, env: { CCLAW_HEADLESS: "1" } })).toBe(true);
  });

  test("suppressed on a dumb terminal", () => {
    expect(bannerSuppressed({ ...tty, env: { TERM: "dumb" } })).toBe(true);
  });

  test("shown on a tty with no suppressing flags", () => {
    expect(bannerSuppressed({ ...tty, env: { TERM: "xterm-256color" } })).toBe(false);
  });
});

describe("renderBanner", () => {
  test("returns empty string when suppressed", () => {
    expect(renderBanner({ env: {}, isTty: false })).toBe("");
  });

  test("renders the full six-line wordmark on a wide terminal", () => {
    const out = renderBanner({ ...tty, env: { TERM: "xterm-256color" } });
    expect(out).toContain("███████╗");
    // six art lines, plus leading/trailing blanks
    expect(out.split("\n").filter((l) => l.includes("█")).length).toBe(5);
  });

  test("NO_COLOR output contains no escape sequences", () => {
    const out = renderBanner({ ...tty, env: { NO_COLOR: "1", TERM: "xterm-256color" } });
    expect(out).toContain("███████╗");
    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(out)).toBe(false);
  });

  test("truecolor output uses the exact SEEK pink", () => {
    const out = renderBanner({ ...tty, env: { COLORTERM: "truecolor", TERM: "xterm" } });
    expect(out).toContain("38;2;230;2;120");
  });

  test("collapses to one line on a narrow terminal", () => {
    const out = renderBanner({ isTty: true, columns: 30, env: { NO_COLOR: "1", TERM: "xterm" } });
    expect(out).toContain("cclaw");
    expect(out).not.toContain("███████╗");
  });

  test("honours COLUMNS when stdout is not a tty, so piping a narrow terminal still collapses", () => {
    const out = renderBanner({
      isTty: true,
      env: { NO_COLOR: "1", TERM: "xterm", COLUMNS: "30" },
    });
    expect(out).toContain("cclaw");
    expect(out).not.toContain("██████╗");
  });

  test("includes the subtitle when given", () => {
    const out = renderBanner({
      ...tty,
      env: { NO_COLOR: "1", TERM: "xterm" },
      subtitle: "work · ctx 4%",
    });
    expect(out).toContain("work · ctx 4%");
  });
});

describe("colour detection", () => {
  test("NO_COLOR wins over everything", () => {
    expect(detectDepth({ NO_COLOR: "1", COLORTERM: "truecolor" })).toBe("none");
    expect(colourEnabled({ NO_COLOR: "1" }, true)).toBe(false);
  });

  test("detects truecolor and 256-colour terminals", () => {
    expect(detectDepth({ COLORTERM: "truecolor" })).toBe("truecolor");
    expect(detectDepth({ TERM: "xterm-256color" })).toBe("ansi256");
  });

  test("never styles a non-tty", () => {
    expect(colourEnabled({ COLORTERM: "truecolor" }, false)).toBe(false);
  });

  test("styler is a no-op passthrough when disabled", () => {
    const s = createStyler({ NO_COLOR: "1" }, true);
    expect(s.enabled).toBe(false);
    expect(s.pink("x")).toBe("x");
    expect(s.dim("x")).toBe("x");
  });
});
