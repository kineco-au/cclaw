/**
 * `cclaw loop` — run a prompt (or the profile's goal) repeatedly, unattended.
 *
 * Modelled on OpenClaw's cron/standing-grant shape: scheduled work with an
 * expiring mandate rather than an open-ended licence. Because nobody is present
 * to answer a prompt, this is deliberately conservative:
 *
 *   - every loop has a hard iteration count AND a wall-clock budget
 *   - permissions are refused, so the agent cannot be silently authorised while
 *     unattended; it reports what it would need instead
 *   - it runs read-only (ACP plan mode is not exposed, so we simply decline
 *     tool permissions) unless --write is passed
 *   - a completion sentinel lets the agent end the loop early
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { profilePaths, resolvePaths } from "../env.ts";
import { defaultProfile, ensureProfile, launchEnv } from "../profile.ts";
import { readGoal } from "../goal.ts";
import { AcpClient, denyAll, type PermissionVerdict } from "../acp/client.ts";
import { createStyler } from "../ui/style.ts";

export const GOAL_MET_SENTINEL = "GOAL-MET";

const DEFAULT_MAX_ITERATIONS = 20;
const DEFAULT_BUDGET_MINUTES = 120;

export interface LoopOptions {
  profile?: string;
  prompt?: string;
  intervalSeconds: number;
  maxIterations: number;
  budgetMinutes: number;
  write: boolean;
  once: boolean;
}

export function parseDuration(value: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(value.trim());
  if (m?.[1] === undefined) return null;
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  switch (m[2]) {
    case "h":
      return Math.round(n * 3600);
    case undefined:
    case "m":
      return Math.round(n * 60);
    case "s":
      return Math.round(n);
    default:
      return null;
  }
}

export function parseLoopArgs(args: string[]): { opts: LoopOptions; error?: string } {
  const opts: LoopOptions = {
    intervalSeconds: 300,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    budgetMinutes: DEFAULT_BUDGET_MINUTES,
    write: false,
    once: false,
  };
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = args[i + 1];
    if (a === "--max" && v !== undefined) {
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) return { opts, error: "--max must be a positive integer" };
      opts.maxIterations = n;
      i++;
    } else if (a === "--budget" && v !== undefined) {
      const secs = parseDuration(v);
      if (secs === null || secs === 0) return { opts, error: `could not read --budget ${v}` };
      opts.budgetMinutes = Math.max(1, Math.round(secs / 60));
      i++;
    } else if (a === "--every" && v !== undefined) {
      const secs = parseDuration(v);
      if (secs === null) return { opts, error: `could not read --every ${v}` };
      opts.intervalSeconds = secs;
      i++;
    } else if (a === "--write") {
      opts.write = true;
    } else if (a === "--once") {
      opts.once = true;
    } else if (a !== undefined && !a.startsWith("--")) {
      words.push(a);
    }
  }
  if (words.length > 0) opts.prompt = words.join(" ");
  return { opts };
}

export async function loopCommand(args: string[], profileArg?: string): Promise<number> {
  const s = createStyler();
  const { opts, error } = parseLoopArgs(args);
  if (error !== undefined) {
    process.stderr.write(`${s.red("error")} ${error}\n`);
    return 2;
  }

  const paths = resolvePaths();
  const name = profileArg ?? opts.profile ?? (await defaultProfile(paths));
  const { pp } = await ensureProfile(paths, name);
  const logPath = join(profilePaths(paths, name).logDir, "loop.jsonl");
  await mkdir(profilePaths(paths, name).logDir, { recursive: true });

  const goal = await readGoal(pp.goalFile);
  const prompt = opts.prompt ?? goal?.text;
  if (prompt === undefined) {
    process.stderr.write(
      `${s.red("error")} nothing to work on. Pass a prompt, or set a goal:\n  cclaw goal set "..."\n`,
    );
    return 2;
  }

  const iterations = opts.once ? 1 : opts.maxIterations;
  const deadline = Date.now() + opts.budgetMinutes * 60_000;

  process.stdout.write(
    `${s.bold("loop")} ${name} · ${iterations} iteration(s) max · ${opts.budgetMinutes}m budget · ` +
      `every ${opts.intervalSeconds}s · ${opts.write ? s.yellow("write enabled") : "read-only"}\n`,
  );
  process.stdout.write(`${s.dim(`objective: ${prompt}`)}\n\n`);

  // Unattended means nobody can answer a prompt. Refusing is the safe default;
  // with --write we still refuse, because an allow would be unsupervised.
  const resolvePermission = async (
    req: Parameters<typeof denyAll>[0],
  ): Promise<PermissionVerdict> => {
    const title = (req.toolCall as { title?: string } | undefined)?.title ?? "a tool call";
    process.stdout.write(`${s.yellow("  refused")} ${title} ${s.dim("(unattended)")}\n`);
    return await denyAll(req);
  };

  let stopped = "budget";
  for (let i = 1; i <= iterations; i++) {
    if (Date.now() >= deadline) {
      stopped = "budget";
      break;
    }
    const started = Date.now();
    const chunks: string[] = [];
    const client = new AcpClient({
      cwd: process.cwd(),
      env: launchEnv(pp, paths),
      resolvePermission,
      events: {
        onUpdate: (n) => {
          const u = n.update as { sessionUpdate?: string; content?: { text?: string } } | undefined;
          if (u?.sessionUpdate === "agent_message_chunk" && typeof u.content?.text === "string") {
            chunks.push(u.content.text);
          }
        },
      },
    });

    let reply = "";
    try {
      await client.start();
      const sid = await client.newSession();
      const instruction =
        `${prompt}\n\n` +
        `You are running unattended, iteration ${i} of ${iterations}. Tool permissions will be ` +
        `refused, so report what you would need rather than retrying. When the objective is ` +
        `fully met, reply with ${GOAL_MET_SENTINEL} on its own line.`;
      await client.prompt(sid, instruction);
      reply = chunks.join("");
    } catch (err) {
      reply = `error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      await client.stop();
    }

    const elapsed = Math.round((Date.now() - started) / 1000);
    const met = reply.includes(GOAL_MET_SENTINEL);
    const summary = reply.replace(/\s+/gu, " ").trim().slice(0, 160);
    process.stdout.write(
      `${s.dim(`iter ${String(i).padStart(2)}`)} ${s.dim(`${elapsed}s`)}  ${met ? s.green("GOAL-MET") : summary || s.dim("(no output)")}\n`,
    );
    await appendFile(
      logPath,
      `${JSON.stringify({ at: new Date().toISOString(), iteration: i, elapsedSeconds: elapsed, met, reply })}\n`,
    );

    if (met) {
      stopped = "goal met";
      break;
    }
    if (i === iterations) {
      stopped = "iteration limit";
      break;
    }
    const waitMs = Math.min(opts.intervalSeconds * 1000, Math.max(0, deadline - Date.now()));
    if (waitMs <= 0) {
      stopped = "budget";
      break;
    }
    await new Promise((r) => setTimeout(r, waitMs));
  }

  process.stdout.write(`\n${s.bold("stopped")}: ${stopped}\n${s.dim(`log: ${logPath}`)}\n`);
  return 0;
}
