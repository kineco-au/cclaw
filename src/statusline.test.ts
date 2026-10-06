import { describe, expect, test } from "bun:test";
import { renderStatus, type StatusPayload } from "./statusline.ts";
import { selfStatusLineCommand } from "./commands/raw.ts";

/** The payload shape Cursor sends, taken from the shipped bundle. */
const FULL: StatusPayload = {
  session_id: "abc",
  render_width_chars: 120,
  cwd: "/home/u/proj",
  model: { id: "claude-opus-5-5-high", display_name: "Claude Opus 5.5 1M High", max_mode: false },
  workspace: { current_dir: "/home/u/proj", project_dir: "/home/u/proj", added_dirs: [] },
  context_window: {
    total_input_tokens: 42_300,
    total_output_tokens: 1_200,
    context_window_size: 1_000_000,
    used_percentage: 4.2,
    remaining_percentage: 95.8,
    current_usage: 43_500,
  },
};

const mono = { colour: false };
const env = { HOME: "/home/u" };

describe("renderStatus", () => {
  test("shows model and the real context window", () => {
    const out = renderStatus(FULL, mono, env);
    expect(out).toContain("Claude Opus 5.5 1M High");
    expect(out).toContain("ctx 42K/1.0M (4%)");
  });

  test("abbreviates the home directory", () => {
    expect(renderStatus(FULL, mono, env)).toContain("~/proj");
  });

  test("says unknown rather than inventing a denominator", () => {
    const out = renderStatus(
      { ...FULL, context_window: { total_input_tokens: 1_500, context_window_size: null } },
      mono,
      env,
    );
    expect(out).toContain("ctx 2K/unknown");
    expect(out).not.toContain("1.0M");
  });

  test("omits the context segment entirely when there is nothing to report", () => {
    const out = renderStatus({ ...FULL, context_window: {} }, mono, env);
    expect(out).not.toContain("ctx");
  });

  test("marks max mode", () => {
    const out = renderStatus(
      { ...FULL, model: { display_name: "Opus", max_mode: true } },
      mono,
      env,
    );
    expect(out).toContain("Opus (max)");
  });

  test("includes the profile and goal when supplied", () => {
    const out = renderStatus(FULL, { ...mono, profile: "work", goal: "ship it" }, env);
    expect(out).toContain("work");
    expect(out).toContain("goal: ship it");
  });

  test("counts extra workspace roots", () => {
    const out = renderStatus(
      { ...FULL, workspace: { current_dir: "/home/u/proj", added_dirs: ["/a", "/b"] } },
      mono,
      env,
    );
    expect(out).toContain("+2 dirs");
  });

  test("truncates to the width Cursor gives, so the line never wraps", () => {
    const out = renderStatus({ ...FULL, render_width_chars: 20 }, mono, env);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith("…")).toBe(true);
  });

  test("emits no escape sequences in mono mode", () => {
    const out = renderStatus(FULL, mono, env);
    expect(/\x1b\[/.test(out)).toBe(false);
  });

  test("an empty payload yields an empty line rather than throwing", () => {
    expect(renderStatus({}, mono, env)).toBe("");
  });

  test("falls back to the model id when there is no display name", () => {
    const out = renderStatus({ model: { id: "auto" } }, mono, env);
    expect(out).toContain("auto");
  });
});

describe("selfStatusLineCommand", () => {
  test("uses the compiled binary directly when compiled", () => {
    expect(selfStatusLineCommand("/usr/local/bin/cclaw", "/irrelevant")).toBe(
      "/usr/local/bin/cclaw statusline",
    );
  });

  test("uses interpreter plus absolute script under bun run", () => {
    expect(selfStatusLineCommand("/home/u/.bun/bin/bun", "/repo/src/cli.ts")).toBe(
      "/home/u/.bun/bin/bun run /repo/src/cli.ts statusline",
    );
  });

  test("quotes paths containing spaces, since Cursor runs this as a shell command", () => {
    const cmd = selfStatusLineCommand("/opt/my bun/bun", "/my repo/src/cli.ts");
    expect(cmd).toBe('"/opt/my bun/bun" run "/my repo/src/cli.ts" statusline');
  });
});
