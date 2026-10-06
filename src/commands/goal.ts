/** `cclaw goal …` */

import { join } from "node:path";
import { profilePaths, resolvePaths } from "../env.ts";
import { defaultProfile, ensureProfile } from "../profile.ts";
import { clearGoal, readGoal, setGoal } from "../goal.ts";
import { createStyler } from "../ui/style.ts";

export async function goalCommand(args: string[], profileArg?: string): Promise<number> {
  const s = createStyler();
  const paths = resolvePaths();
  const name = profileArg ?? (await defaultProfile(paths));
  await ensureProfile(paths, name);
  const pp = profilePaths(paths, name);
  const rulesDir = join(pp.cursorConfigDir, "rules");
  const [sub, ...rest] = args;

  switch (sub) {
    case undefined:
    case "show": {
      const goal = await readGoal(pp.goalFile);
      if (goal === null) {
        process.stdout.write(
          `no goal set for '${name}'\n${s.dim('set one with: cclaw goal set "..."')}\n`,
        );
        return 0;
      }
      process.stdout.write(`${s.bold("goal")}  ${goal.text}\n`);
      if (goal.setAt !== "") process.stdout.write(`${s.dim(`set ${goal.setAt}`)}\n`);
      process.stdout.write(
        `${s.dim(`injected as a Cursor rule, so it applies to both cclaw chat and cclaw raw`)}\n`,
      );
      return 0;
    }

    case "set": {
      const text = rest.join(" ").trim();
      if (text === "") {
        process.stderr.write('usage: cclaw goal set "<objective>"\n');
        return 2;
      }
      try {
        const goal = await setGoal({ goalFile: pp.goalFile, rulesDir, text });
        process.stdout.write(`${s.green("ok")} goal set for '${name}': ${goal.text}\n`);
        process.stdout.write(
          `${s.dim("written to the profile's .cursor rules, so every session carries it")}\n`,
        );
        return 0;
      } catch (err) {
        process.stderr.write(
          `${s.red("error")} ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return 1;
      }
    }

    case "clear": {
      await clearGoal({ goalFile: pp.goalFile, rulesDir });
      process.stdout.write(`${s.green("ok")} cleared the goal for '${name}'\n`);
      return 0;
    }

    default:
      process.stderr.write(`unknown subcommand: goal ${sub}\n`);
      return 2;
  }
}
