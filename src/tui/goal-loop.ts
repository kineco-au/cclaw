/**
 * Working a goal over several turns.
 *
 * Extracted from the app because this is the behaviour `/goal` exists for, and
 * while it lived in a closure inside `runChatApp` the only way to check it was
 * to drive a PTY. The loop decides when to stop; the caller renders.
 */

import { isPlanGated } from "../plan-gate.ts";

export const GOAL_MET_SENTINEL = "GOAL-MET";

export type GoalLoopStop =
  | { kind: "met"; iteration: number }
  | { kind: "plan-gated"; iteration: number }
  | { kind: "cancelled"; iteration: number }
  | { kind: "error"; iteration: number; message: string }
  | { kind: "no-goal" }
  | { kind: "limit"; iteration: number };

export interface GoalLoopDeps {
  /** Hard cap on turns. There is no unbounded mode: turns cost money. */
  iterations: number;
  /** Read afresh each turn, so clearing the goal mid-loop ends it. */
  goal: () => string | null;
  send: (message: string) => Promise<string>;
  /** Progress, one line per turn. */
  onIteration?: (iteration: number, of: number) => void;
  /** True once the user has asked to stop. */
  aborted?: () => boolean;
  /**
   * Awaited before each turn. Lets the loop start immediately while an
   * ordinary turn is still in flight, rather than refusing and asking the user
   * to run /loop themselves, without sending two prompts at once.
   */
  waitUntilReady?: () => Promise<void>;
}

/** The instruction appended so the agent can end the loop itself. */
export function goalPrompt(objective: string, iteration: number, of: number): string {
  return (
    `${objective}\n\nThis is iteration ${iteration} of ${of}. When the objective is ` +
    `fully met, reply with ${GOAL_MET_SENTINEL} on its own line.`
  );
}

/** A one-line account of why the loop ended. */
export function describeStop(stop: GoalLoopStop): string {
  switch (stop.kind) {
    case "met":
      return `stopped: goal met after ${stop.iteration} iteration(s)`;
    case "plan-gated":
      return "stopped: your plan refused the turn. /model or `cclaw model list`.";
    case "cancelled":
      return `stopped: cancelled after ${stop.iteration} iteration(s)`;
    case "error":
      return `stopped: ${stop.message}`;
    case "no-goal":
      return "stopped: no goal to work on";
    case "limit":
      return `stopped: reached the ${stop.iteration}-iteration limit without meeting the goal`;
  }
}

/**
 * Run the goal until it is met, refused, cancelled, or the cap is reached.
 *
 * Never throws: a failing turn becomes an `error` stop so the caller can always
 * report something. Returning silently is the one outcome ruled out.
 */
export async function runGoalLoop(deps: GoalLoopDeps): Promise<GoalLoopStop> {
  const { iterations } = deps;
  if (iterations <= 0) return { kind: "limit", iteration: 0 };

  for (let i = 1; i <= iterations; i++) {
    const objective = deps.goal();
    if (objective === null || objective.trim() === "") {
      return i === 1 ? { kind: "no-goal" } : { kind: "cancelled", iteration: i - 1 };
    }

    if (deps.waitUntilReady !== undefined) {
      try {
        await deps.waitUntilReady();
      } catch (err) {
        return {
          kind: "error",
          iteration: i,
          message: err instanceof Error ? err.message : String(err),
        };
      }
      // Cancelling while we waited must not then fire a turn.
      if (deps.aborted?.() === true) return { kind: "cancelled", iteration: i - 1 };
    }

    deps.onIteration?.(i, iterations);

    let reply: string;
    try {
      reply = await deps.send(goalPrompt(objective, i, iterations));
    } catch (err) {
      return {
        kind: "error",
        iteration: i,
        message: err instanceof Error ? err.message : String(err),
      };
    }

    if (reply.includes(GOAL_MET_SENTINEL)) return { kind: "met", iteration: i };
    // Burning the whole budget on refusals teaches nothing and still bills.
    if (isPlanGated(reply)) return { kind: "plan-gated", iteration: i };
    if (deps.aborted?.() === true) return { kind: "cancelled", iteration: i };
  }
  return { kind: "limit", iteration: iterations };
}
