#!/usr/bin/env bun
/** cclaw entrypoint: argument dispatch only. */

import { CCLAW_VERSION } from "./env.ts";
import { doctor } from "./commands/doctor.ts";
import { printBanner } from "./ui/banner.ts";
import { createStyler } from "./ui/style.ts";

const USAGE = `cclaw - a Claude-Code-shaped terminal agent running on the Cursor CLI

USAGE
  cclaw                               start the chat TUI
  cclaw <command> [args...]
  cclaw -p "<prompt>" [options]       run one prompt headlessly and print the reply

COMMANDS
  chat                               start the cclaw TUI (our UI, Cursor over ACP)
  raw [-- <cursor args>]             run Cursor's own TUI under a cclaw profile.
                                     The only mode with a live context-window
                                     figure, since Cursor exposes it solely
                                     through its statusLine.
  setup                              create the profile and seed its policy
  doctor [--deep]                    diagnose dependencies, auth and policy

  profile list | create | use | show | delete | cred
  model   list [--all] | config <spec> | use <id> | info
  grant   list | add <cmd> | rm <cmd> | block <cmd> | prune
  goal    show | set "<objective>" | clear
  loop    [prompt] [--every 5m] [--max N] [--budget 2h] [--once] [--write]

  statusline                         internal: Cursor's statusLine command
  version                            print the version
  help                               this message

OPTIONS
  -p, --print [prompt...]            headless: one prompt, reply on stdout.
                                     Reads stdin when piped or given '-'.
      --output-format <text|json>    headless output shape (default text)
  -r, --resume <selector>            headless: carry a prior session's context
  -P, --profile <name>               use this profile for this run
      --no-banner                    suppress the banner
      --dry-run                      print the command and env, then exit
  -h, --help                         this message

ENVIRONMENT
  CCLAW_HOME                         state root (default ~/.cclaw)
  CCLAW_CURSOR_BIN                   override Cursor CLI discovery
  NO_COLOR                           disable colour
`;

interface Parsed {
  command: string;
  args: string[];
  profile?: string;
  noBanner: boolean;
  deep: boolean;
  dryRun: boolean;
  print: boolean;
  help: boolean;
}

export function parseArgv(argv: string[]): Parsed {
  const out: Parsed = {
    command: "",
    args: [],
    noBanner: false,
    deep: false,
    dryRun: false,
    print: false,
    help: false,
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (a === "--no-banner") {
      out.noBanner = true;
      continue;
    }
    if (a === "--deep") {
      out.deep = true;
      continue;
    }
    if (a === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    if (a === "-p" || a === "--print") {
      out.print = true;
      continue;
    }
    if (a === "-P" || a === "--profile") {
      const next = argv[i + 1];
      if (next !== undefined) {
        out.profile = next;
        i++;
      }
      continue;
    }
    if (out.command === "" && !out.print && !a.startsWith("-")) {
      out.command = a;
      continue;
    }
    rest.push(a);
  }
  out.args = rest;
  return out;
}

async function main(): Promise<number> {
  const parsed = parseArgv(process.argv.slice(2));
  const s = createStyler();

  if (parsed.help) {
    printBanner({ suppress: parsed.noBanner, subtitle: `v${CCLAW_VERSION}` });
    process.stdout.write(USAGE);
    return 0;
  }

  if (parsed.print) {
    const { printCommand } = await import("./commands/print.ts");
    return await printCommand(parsed.args, parsed.profile);
  }

  switch (parsed.command) {
    case "help":
      printBanner({ suppress: parsed.noBanner, subtitle: `v${CCLAW_VERSION}` });
      process.stdout.write(USAGE);
      return 0;

    case "version":
      process.stdout.write(`${CCLAW_VERSION}\n`);
      return 0;

    case "doctor":
      printBanner({ suppress: parsed.noBanner, subtitle: "diagnostics" });
      return await doctor({ deep: parsed.deep, profile: parsed.profile });

    case "":
    case "chat": {
      const { runChatApp } = await import("./tui/app.ts");
      const { resolvePaths } = await import("./env.ts");
      const { ensureProfile, launchEnv, resolveProfileName } = await import("./profile.ts");
      const paths = resolvePaths();
      const name = await resolveProfileName(paths, parsed.profile);
      const { pp } = await ensureProfile(paths, name);
      return await runChatApp({
        cwd: process.cwd(),
        profile: name,
        env: launchEnv(pp, paths),
        paths,
        profilePaths: pp,
      });
    }

    case "setup": {
      const { setupCommand } = await import("./commands/setup.ts");
      return await setupCommand(parsed.profile);
    }

    case "profile": {
      const { profileCommand } = await import("./commands/profile.ts");
      return await profileCommand(parsed.args);
    }

    case "model": {
      const { modelCommand } = await import("./commands/model.ts");
      return await modelCommand(parsed.args, parsed.profile);
    }

    case "grant": {
      const { grantCommand } = await import("./commands/grant.ts");
      return await grantCommand(parsed.args, parsed.profile);
    }

    case "goal": {
      const { goalCommand } = await import("./commands/goal.ts");
      return await goalCommand(parsed.args, parsed.profile);
    }

    case "loop": {
      const { loopCommand } = await import("./commands/loop.ts");
      return await loopCommand(parsed.args, parsed.profile);
    }

    case "raw": {
      const { raw } = await import("./commands/raw.ts");
      return await raw({
        profile: parsed.profile,
        noBanner: parsed.noBanner,
        dryRun: parsed.dryRun,
        passthrough: parsed.args,
      });
    }

    case "statusline": {
      // Spawned by Cursor with the status payload on stdin.
      const { runStatusline } = await import("./statusline.ts");
      await runStatusline();
      return 0;
    }

    default:
      process.stderr.write(`${s.red("unknown command")} '${parsed.command}'\n\n${USAGE}`);
      return 2;
  }
}

if (import.meta.main) {
  process.exit(await main());
}
