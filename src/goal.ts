/**
 * Session goals.
 *
 * A goal is a persistent objective for a profile: it shows in the footer of
 * both `cclaw chat` and `cclaw raw` (via the status line), and it is injected
 * into every Cursor session as a rule so the agent actually sees it.
 *
 * The rule file is what makes this more than decoration. Cursor reads
 * `.cursor/rules/`, `AGENTS.md` and `CLAUDE.md`, so writing the goal into the
 * profile's rules directory means it applies to interactive and ACP sessions
 * alike without us re-sending it each turn.
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface Goal {
  text: string;
  setAt: string;
}

export const GOAL_RULE_FILENAME = "cclaw-goal.mdc";

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

export async function readGoal(goalFile: string): Promise<Goal | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(goalFile, "utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const text = (parsed as { text?: unknown }).text;
    const setAt = (parsed as { setAt?: unknown }).setAt;
    if (typeof text !== "string" || text === "") return null;
    return { text, setAt: typeof setAt === "string" ? setAt : "" };
  } catch {
    return null;
  }
}

/** The rule text Cursor will read. Kept short: it is prepended to every turn. */
export function goalRuleBody(text: string): string {
  return `---
description: The user's standing goal for this session
alwaysApply: true
---

# Standing goal

${text}

Work toward this goal. If it is already met, say so plainly rather than
inventing further work.
`;
}

export async function setGoal(params: {
  goalFile: string;
  rulesDir: string;
  text: string;
}): Promise<Goal> {
  const text = params.text.trim();
  if (text === "") throw new Error("a goal cannot be empty");
  const goal: Goal = { text, setAt: new Date().toISOString() };
  await writeAtomic(params.goalFile, `${JSON.stringify(goal, null, 2)}\n`);
  await writeAtomic(join(params.rulesDir, GOAL_RULE_FILENAME), goalRuleBody(text));
  return goal;
}

export async function clearGoal(params: { goalFile: string; rulesDir: string }): Promise<void> {
  await rm(params.goalFile, { force: true });
  await rm(join(params.rulesDir, GOAL_RULE_FILENAME), { force: true });
}

/**
 * Remove the rule while keeping the saved text.
 *
 * The rule file is what makes a goal act on a session, so its presence means
 * "actively being worked". A new session stands any saved goal down, which is
 * what keeps a fresh session genuinely fresh: without this the agent would
 * still see the goal every turn even though the TUI never mentioned it.
 */
export async function standDownGoal(rulesDir: string): Promise<void> {
  await rm(join(rulesDir, GOAL_RULE_FILENAME), { force: true });
}

/** Whether a goal is currently armed, i.e. its rule is on disk. */
export async function goalIsArmed(rulesDir: string): Promise<boolean> {
  try {
    await stat(join(rulesDir, GOAL_RULE_FILENAME));
    return true;
  } catch {
    return false;
  }
}
