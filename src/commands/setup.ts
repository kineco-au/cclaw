/**
 * `cclaw setup` — create a profile if needed and seed its policy.
 *
 * Re-runnable by design: seeding is a merge, so running it again reports
 * "unchanged" rather than clobbering anything the user has since edited. This
 * is the same code path install.sh uses, so there is one implementation of
 * "make this profile ready".
 */

import { resolvePaths } from "../env.ts";
import { ensureProfile, resolveProfileName } from "../profile.ts";
import { seedPolicyFile } from "../policy/seed.ts";
import { cliConfigDefaults, cliConfigEnforce, permissionsSeed } from "../policy/templates.ts";
import { selfStatusLineCommand } from "./raw.ts";
import { cursorStatus, resolveCursorBinary } from "../cursor.ts";
import { createStyler } from "../ui/style.ts";

export async function setupCommand(profileArg?: string): Promise<number> {
  const s = createStyler();
  const paths = resolvePaths();
  const name = await resolveProfileName(paths, profileArg);
  const { pp, created } = await ensureProfile(paths, name);

  process.stdout.write(
    created
      ? `${s.green("ok")} created profile '${name}'\n`
      : `${s.dim(`profile '${name}' already exists`)}\n`,
  );

  const vars = { statusLineCommand: selfStatusLineCommand(), home: process.env.HOME ?? "" };
  const seeds = [
    {
      label: "cli-config.json",
      path: `${pp.cursorConfigDir}/cli-config.json`,
      defaults: cliConfigDefaults(),
      enforce: cliConfigEnforce(vars),
      backupsDir: pp.backupsDir,
    },
    {
      label: "permissions.json",
      path: `${pp.cursorConfigDir}/permissions.json`,
      enforce: permissionsSeed(),
      backupsDir: pp.backupsDir,
    },
  ];

  let failed = false;
  for (const seed of seeds) {
    const outcome = await seedPolicyFile(seed);
    switch (outcome.status) {
      case "written":
        process.stdout.write(`${s.green("ok")} ${seed.label} seeded\n`);
        break;
      case "unchanged":
        process.stdout.write(`${s.dim(`${seed.label} already up to date`)}\n`);
        break;
      case "deferred":
        // Nothing is broken and nothing is missing, so this must not fail the
        // install: re-running later picks it up.
        process.stdout.write(`${s.yellow("warn")} ${seed.label}: ${outcome.reason}\n`);
        break;
      case "refused":
        process.stdout.write(`${s.red("fail")} ${seed.label}: ${outcome.reason}\n`);
        failed = true;
        break;
    }
  }

  const bin = await resolveCursorBinary();
  if (bin === null) {
    process.stdout.write(`${s.yellow("warn")} Cursor CLI not found; run ./install.sh\n`);
    return 1;
  }
  const status = await cursorStatus(bin.path);
  process.stdout.write(
    status.authenticated
      ? `${s.green("ok")} signed in as ${status.email ?? "unknown"}\n`
      : `${s.yellow("warn")} not signed in — run: ${bin.path} login\n`,
  );

  process.stdout.write(
    `\n${s.dim("policy: workspace-scoped sandbox, ask-on-miss approvals, sensitive CLIs gated")}\n`,
  );
  process.stdout.write(`${s.dim("next:")} cclaw        ${s.dim("# start the chat TUI")}\n`);
  return failed ? 1 : 0;
}
