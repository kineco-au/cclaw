/**
 * `cclaw raw` — the Cursor-direct escape hatch.
 *
 * Runs Cursor's own TUI under a cclaw profile, with our status line wired in.
 * This is the only path on which a real context-window figure is available:
 * `context_window_size` is delivered solely by Cursor's `statusLine` and is not
 * exposed by any CLI command, SDK type, or over ACP.
 *
 * It seeds policy then hands the terminal to Cursor; we add no UI of our own
 * beyond one banner line.
 */

import { isAbsolute, resolve } from "node:path";
import { resolveCursorBinary, CURSOR_INSTALL_CMD } from "../cursor.ts";
import { resolvePaths } from "../env.ts";
import { ensureProfile, launchEnv, resolveProfileName } from "../profile.ts";
import { seedPolicyFile } from "../policy/seed.ts";
import { cliConfigDefaults, cliConfigEnforce, permissionsSeed } from "../policy/templates.ts";
import { printBanner } from "../ui/banner.ts";
import { createStyler } from "../ui/style.ts";

/**
 * How Cursor should invoke our status line.
 *
 * When running from a compiled binary, that binary is the command. Under `bun
 * run`, we need the interpreter plus the entry script, both absolute, because
 * Cursor spawns this with an arbitrary cwd.
 */
export function selfStatusLineCommand(
  execPath: string = process.execPath,
  mainPath: string = Bun.main,
): string {
  const isCompiled = !/\b(bun|bun-debug|node)\b$/.test(execPath);
  if (isCompiled) return `${quote(execPath)} statusline`;
  const main = isAbsolute(mainPath) ? mainPath : resolve(mainPath);
  return `${quote(execPath)} run ${quote(main)} statusline`;
}

function quote(p: string): string {
  return /[\s"']/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p;
}

export interface RawOptions {
  profile?: string;
  noBanner?: boolean;
  dryRun?: boolean;
  /** Extra arguments passed straight through to the Cursor CLI. */
  passthrough?: string[];
}

export async function raw(opts: RawOptions = {}): Promise<number> {
  const s = createStyler();
  const paths = resolvePaths();

  const bin = await resolveCursorBinary();
  if (!bin) {
    process.stderr.write(
      `${s.red("Cursor CLI not found")}\ninstall it with: ${CURSOR_INSTALL_CMD}\n`,
    );
    return 1;
  }

  const name = await resolveProfileName(paths, opts.profile);
  const { pp, created } = await ensureProfile(paths, name);
  if (created) process.stderr.write(`${s.dim(`created profile '${name}'`)}\n`);

  // Re-assert policy on every launch: Cursor rewrites these files itself, and a
  // merge is cheap. seedPolicyFile reports "unchanged" when nothing moved.
  const vars = {
    statusLineCommand: selfStatusLineCommand(),
    home: process.env.HOME ?? "",
  };
  const seeds = [
    {
      path: `${pp.cursorConfigDir}/cli-config.json`,
      defaults: cliConfigDefaults(),
      enforce: cliConfigEnforce(vars),
      backupsDir: pp.backupsDir,
    },
    {
      path: `${pp.cursorConfigDir}/permissions.json`,
      enforce: permissionsSeed(),
      backupsDir: pp.backupsDir,
    },
  ];

  for (const seed of seeds) {
    const outcome = await seedPolicyFile(seed);
    if (outcome.status === "refused") {
      process.stderr.write(`${s.yellow("policy not applied")}: ${outcome.reason}\n`);
    }
  }

  const env = launchEnv(pp, paths);
  const args = ["--workspace", process.cwd(), ...(opts.passthrough ?? [])];

  if (opts.dryRun === true) {
    process.stdout.write(`${bin.path} ${args.join(" ")}\n`);
    for (const [k, v] of Object.entries(env)) process.stdout.write(`${k}=${v}\n`);
    return 0;
  }

  printBanner({
    suppress: opts.noBanner,
    subtitle: `${name} · cursor ${bin.name} · raw mode`,
  });

  // Hand over the terminal. Cursor's TUI owns stdio from here.
  const proc = Bun.spawn([bin.path, ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, ...env },
    cwd: process.cwd(),
  });
  return await proc.exited;
}
