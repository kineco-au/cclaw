/** Diagnostics: dependencies, auth, Cursor capabilities, profile health. */

import { platform, release } from "node:os";
import { join } from "node:path";
import { CCLAW_VERSION, PROJECTS_PATH_LIMIT, profilePaths, resolvePaths } from "../env.ts";
import {
  CURSOR_INSTALL_CMD,
  cursorAbout,
  cursorStatus,
  hasAcp,
  resolveCursorBinary,
  runCursor,
} from "../cursor.ts";
import { fetchCatalogue } from "../models.ts";
import { createStyler } from "../ui/style.ts";

export type Level = "ok" | "warn" | "fail" | "info";

export interface Check {
  level: Level;
  label: string;
  detail: string;
  /** Shown when the check is not ok. */
  remedy?: string;
}

export interface DoctorOptions {
  deep?: boolean;
  profile?: string;
}

export async function collectChecks(opts: DoctorOptions = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const paths = resolvePaths();

  checks.push({
    level: "info",
    label: "cclaw",
    detail: `${CCLAW_VERSION} on bun ${Bun.version} (${platform()} ${release()})`,
  });

  const bin = await resolveCursorBinary();
  if (!bin) {
    checks.push({
      level: "fail",
      label: "cursor cli",
      detail: "not found as `agent` or `cursor-agent`",
      remedy: `install it with: ${CURSOR_INSTALL_CMD}`,
    });
    return checks;
  }
  const ver = await runCursor(bin.path, ["--version"], { timeoutMs: 15_000 });
  checks.push({
    level: "ok",
    label: "cursor cli",
    detail: `${ver.stdout.trim() || "unknown version"} at ${bin.path}`,
  });

  // The ACP server is what our TUI speaks to. It is hidden from --help.
  const acp = await hasAcp(bin.path);
  checks.push(
    acp
      ? { level: "ok", label: "cursor acp", detail: "`agent acp` available" }
      : {
          level: "fail",
          label: "cursor acp",
          detail: "this Cursor build has no `acp` subcommand",
          remedy: "update the Cursor CLI: agent update",
        },
  );

  const status = await cursorStatus(bin.path);
  checks.push(
    status.authenticated
      ? { level: "ok", label: "cursor auth", detail: `signed in as ${status.email ?? "unknown"}` }
      : {
          level: "fail",
          label: "cursor auth",
          detail: "not signed in",
          remedy: "run: agent login   (or NO_OPEN_BROWSER=1 agent login over SSH)",
        },
  );

  const about = await cursorAbout(bin.path);
  if (about?.subscriptionTier) {
    const free = /free/i.test(about.subscriptionTier);
    checks.push({
      level: free ? "warn" : "ok",
      label: "cursor plan",
      detail: about.subscriptionTier,
      remedy: free
        ? "on the Free tier many catalogue models are unavailable or rate limited"
        : undefined,
    });
  }

  // Sandboxing is how we confine the agent to the working directory.
  if (platform() === "darwin") {
    const seatbelt = Bun.which("sandbox-exec");
    checks.push(
      seatbelt
        ? { level: "ok", label: "sandbox", detail: "macOS Seatbelt available" }
        : { level: "warn", label: "sandbox", detail: "sandbox-exec not found" },
    );
  } else if (platform() === "linux") {
    const lsm = Bun.file("/sys/kernel/security/lsm");
    let landlock = false;
    try {
      landlock = (await lsm.text()).includes("landlock");
    } catch {
      landlock = false;
    }
    checks.push(
      landlock
        ? { level: "ok", label: "sandbox", detail: "Landlock present" }
        : {
            level: "warn",
            label: "sandbox",
            detail: "no Landlock (needs kernel 6.2+ with CONFIG_SECURITY_LANDLOCK)",
            remedy: "directory confinement degrades to prompting on this host",
          },
    );
  }

  // Profile layout.
  const profileName = opts.profile ?? "default";
  const pp = profilePaths(paths, profileName);
  const exists = await Bun.file(pp.profileFile).exists();
  checks.push(
    exists
      ? { level: "ok", label: "profile", detail: `'${profileName}' at ${pp.dir}` }
      : {
          level: "warn",
          label: "profile",
          detail: `'${profileName}' not set up`,
          remedy: "run: cclaw setup",
        },
  );

  const projects = join(pp.cursorDataDir, "projects");
  if (projects.length > PROJECTS_PATH_LIMIT) {
    checks.push({
      level: "warn",
      label: "path length",
      detail: `${projects.length} chars exceeds Cursor's ${PROJECTS_PATH_LIMIT}-char limit`,
      remedy:
        "Cursor will silently relocate its projects dir; use a shorter profile name or CCLAW_HOME",
    });
  }

  // Every hook source Cursor reads, so surprising behaviour is never mysterious.
  const hookSources = [
    "/Library/Application Support/Cursor/hooks.json",
    join(process.env.HOME ?? "", ".cursor", "hooks.json"),
    join(process.cwd(), ".cursor", "hooks.json"),
    join(process.env.HOME ?? "", ".claude", "settings.json"),
    join(process.cwd(), ".claude", "settings.json"),
  ];
  const present: string[] = [];
  for (const h of hookSources) {
    if (await Bun.file(h).exists()) present.push(h);
  }
  checks.push({
    level: present.length > 0 ? "info" : "ok",
    label: "hook sources",
    detail: present.length > 0 ? present.join(", ") : "none",
    remedy: present.some((p) => p.includes(".claude"))
      ? "Cursor also reads ~/.claude/settings.json hooks, so your Claude Code hooks fire here too"
      : undefined,
  });

  if (opts.deep) {
    const cat = await fetchCatalogue(bin.path);
    checks.push(
      cat.usable
        ? { level: "ok", label: "model catalogue", detail: `${cat.models.length} models parsed` }
        : {
            level: "warn",
            label: "model catalogue",
            detail: "could not parse `agent models` output",
            remedy: "model curation will fall back to the cached list",
          },
    );
  }

  return checks;
}

const GLYPH: Record<Level, string> = { ok: "ok  ", warn: "warn", fail: "fail", info: "    " };

export async function doctor(opts: DoctorOptions = {}): Promise<number> {
  const s = createStyler();
  const checks = await collectChecks(opts);
  const paint = (l: Level, t: string) =>
    l === "ok" ? s.green(t) : l === "warn" ? s.yellow(t) : l === "fail" ? s.red(t) : s.dim(t);

  for (const c of checks) {
    process.stdout.write(`${paint(c.level, GLYPH[c.level])} ${c.label.padEnd(16)} ${c.detail}\n`);
    if (c.remedy) process.stdout.write(`${" ".repeat(22)}${s.dim(c.remedy)}\n`);
  }

  const failed = checks.filter((c) => c.level === "fail").length;
  const warned = checks.filter((c) => c.level === "warn").length;
  process.stdout.write(
    `\n${failed > 0 ? s.red(`${failed} failed`) : s.green("no failures")}${warned > 0 ? s.yellow(`, ${warned} warning${warned === 1 ? "" : "s"}`) : ""}\n`,
  );
  return failed > 0 ? 1 : 0;
}
