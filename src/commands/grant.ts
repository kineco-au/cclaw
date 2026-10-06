/** `cclaw grant …` — the permanent half of the temporary/permanent consent split. */

import { join } from "node:path";
import { profilePaths, resolvePaths } from "../env.ts";
import { defaultProfile, ensureProfile } from "../profile.ts";
import { ApprovalStore } from "../policy/approvals.ts";
import { SENSITIVE_TOOLS } from "../policy/templates.ts";
import { createStyler } from "../ui/style.ts";

function storeFor(home: string, profile: string): ApprovalStore {
  const paths = resolvePaths();
  const pp = profilePaths(paths, profile);
  return new ApprovalStore({ grantsFile: pp.grantsFile, runDir: join(home, "run") });
}

export async function grantCommand(args: string[], profileArg?: string): Promise<number> {
  const s = createStyler();
  const paths = resolvePaths();
  const name = profileArg ?? (await defaultProfile(paths));
  await ensureProfile(paths, name);
  const store = storeFor(paths.home, name);
  const [sub, ...rest] = args;

  switch (sub) {
    case undefined:
    case "list": {
      const listed = await store.list();
      process.stdout.write(`${s.bold(`grants for '${name}'`)}\n`);
      process.stdout.write(`\n  ${s.dim("permanent")}\n`);
      if (listed.profile.length === 0) process.stdout.write("    none\n");
      for (const g of listed.profile) {
        const scope = g.argv === undefined ? "any arguments" : g.argv;
        const where = g.cwd ?? "any directory";
        const until = g.expiresAt === undefined ? "" : s.dim(` until ${g.expiresAt.slice(0, 10)}`);
        process.stdout.write(
          `    ${s.green("+")} ${g.command.padEnd(12)} ${s.dim(`${scope} in ${where}`)}${until}\n`,
        );
      }
      process.stdout.write(`\n  ${s.dim("session")}\n`);
      if (listed.session.length === 0) process.stdout.write("    none\n");
      for (const g of listed.session) {
        process.stdout.write(
          `    ${s.yellow("~")} ${g.command} ${s.dim("(cleared when the session ends)")}\n`,
        );
      }
      process.stdout.write(`\n  ${s.dim("blocked")}\n`);
      if (listed.never.length === 0) process.stdout.write("    none\n");
      for (const c of listed.never) process.stdout.write(`    ${s.red("-")} ${c}\n`);
      if (listed.expired.length > 0) {
        process.stdout.write(`\n  ${s.dim(`${listed.expired.length} expired grant(s) ignored`)}\n`);
      }
      return 0;
    }

    case "add": {
      const cmd = rest[0];
      if (cmd === undefined) {
        process.stderr.write(
          'usage: cclaw grant add <command> [--cwd <dir>] [--argv "<exact command line>"] [--days N]\n',
        );
        return 2;
      }
      let cwd: string | undefined = process.cwd();
      let argv: string | undefined;
      let days: number | undefined;
      for (let i = 1; i < rest.length; i++) {
        const flag = rest[i];
        const value = rest[i + 1];
        if (flag === "--cwd" && value !== undefined) {
          cwd = value;
          i++;
        } else if (flag === "--any-dir") {
          cwd = undefined;
        } else if (flag === "--argv" && value !== undefined) {
          argv = value;
          i++;
        } else if (flag === "--days" && value !== undefined) {
          const n = Number.parseInt(value, 10);
          if (Number.isFinite(n) && n > 0) days = n;
          i++;
        }
      }
      await store.grant({
        command: cmd,
        ...(argv !== undefined ? { argv } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        scope: "profile",
        ...(days !== undefined ? { expiresInDays: days } : {}),
      });
      const scopeText = argv === undefined ? "any arguments" : `exactly \`${argv}\``;
      const whereText = cwd === undefined ? "any directory" : cwd;
      process.stdout.write(
        `${s.green("ok")} '${cmd}' granted for ${scopeText} in ${whereText}` +
          `${days === undefined ? "" : `, expiring in ${days} day(s)`}\n`,
      );
      if (!SENSITIVE_TOOLS.includes(cmd)) {
        process.stdout.write(
          s.dim(`note: '${cmd}' is not on the sensitive list, so it may not have needed a grant\n`),
        );
      }
      return 0;
    }

    case "rm":
    case "remove":
    case "revoke": {
      const cmd = rest[0];
      if (cmd === undefined) {
        process.stderr.write("usage: cclaw grant rm <command>\n");
        return 2;
      }
      await store.revoke(cmd);
      process.stdout.write(
        `${s.green("ok")} removed grants and blocks for '${cmd}'; it will prompt again\n`,
      );
      return 0;
    }

    case "block":
    case "never": {
      const cmd = rest[0];
      if (cmd === undefined) {
        process.stderr.write("usage: cclaw grant block <command>\n");
        return 2;
      }
      await store.block(cmd);
      process.stdout.write(
        `${s.green("ok")} '${cmd}' is blocked for '${name}' and will be refused without asking\n`,
      );
      return 0;
    }

    case "prune": {
      const removed = await store.pruneSessions([]);
      process.stdout.write(`${s.green("ok")} removed ${removed} stale session grant file(s)\n`);
      return 0;
    }

    default:
      process.stderr.write(`unknown subcommand: grant ${sub}\n`);
      return 2;
  }
}
