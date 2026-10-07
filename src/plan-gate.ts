/**
 * Detecting Cursor's plan refusal.
 *
 * A plan-gated turn streams "Upgrade your plan to continue" as an ordinary
 * assistant reply and still reports `stopReason: "end_turn"`, so neither the
 * protocol nor the transcript marks it as a failure. Anything that treats a
 * reply as success has to check for it: without this, `cclaw -p` exits 0 on a
 * non-answer and a goal loop burns its whole iteration budget on refusals.
 */

export function isPlanGated(reply: string): boolean {
  return /upgrade your plan/i.test(reply);
}
