/**
 * Turn lifecycle: what happens when you submit while busy, and what Esc cancels.
 *
 * Extracted from the app because it is a state machine, not UI, and racing a
 * live model through a PTY is a poor way to verify one. The app supplies the
 * side effects; everything here is deterministic and unit tested.
 *
 * Cancel escalates rather than doing everything at once, so each Esc has one
 * predictable effect:
 *   1. a pending permission prompt -> deny it AND stop the turn it belongs to
 *   2. a running turn              -> stop it
 *   3. queued messages             -> discard them
 */

export type SubmitOutcome = "sent" | "queued" | "ignored";

export type CancelOutcome =
  | { kind: "prompt-denied" }
  | { kind: "turn-cancelled" }
  | { kind: "queue-discarded"; count: number }
  | { kind: "nothing" };

export interface TurnControllerHooks {
  /** Run one turn. Resolves when the turn ends, however it ends. */
  send: (text: string) => Promise<void>;
  /** Ask the agent to stop the current turn. */
  abort: () => void;
  /** Deny a pending permission prompt, if one is open. */
  denyPrompt: () => void;
  /** True while a permission prompt is awaiting an answer. */
  promptPending: () => boolean;
  /** Echo the user's message into the transcript before sending. */
  echo: (text: string) => void;
  /** Surface a notice to the user. */
  say: (text: string) => void;
  /** Called whenever busy/queue state changes, so the footer can refresh. */
  changed: () => void;
  /** Report an error from a turn. */
  onError: (err: unknown) => void;
}

export class TurnController {
  private running = false;
  private cancelled = false;
  private readonly pending: string[] = [];

  constructor(private readonly hooks: TurnControllerHooks) {}

  get busy(): boolean {
    return this.running;
  }

  get queued(): readonly string[] {
    return this.pending;
  }

  /**
   * Submit a message. While a turn is in flight the message is queued rather
   * than dropped — silently discarding typed input was the previous behaviour
   * and the reason this class exists.
   */
  submit(text: string): SubmitOutcome {
    const trimmed = text.trim();
    if (trimmed === "") return "ignored";
    if (this.running) {
      this.pending.push(trimmed);
      this.hooks.say(`Queued: ${trimmed}`);
      this.hooks.changed();
      return "queued";
    }
    this.start(trimmed);
    return "sent";
  }

  /** Esc. Returns what it actually did, so the caller can report it. */
  cancel(): CancelOutcome {
    if (this.hooks.promptPending()) {
      this.hooks.denyPrompt();
      // Also stop the turn: leaving it running after refusing its tool call
      // just produces a stuck spinner.
      this.cancelled = true;
      this.hooks.abort();
      this.hooks.say("Denied and cancelled.");
      this.hooks.changed();
      return { kind: "prompt-denied" };
    }
    // A turn keeps running until the agent acknowledges the abort, so a second
    // Esc while already cancelling escalates to the queue instead of repeating
    // "Cancelled." at the user.
    if (this.running && !this.cancelled) {
      this.cancelled = true;
      this.hooks.abort();
      this.hooks.say("Cancelled.");
      this.hooks.changed();
      return { kind: "turn-cancelled" };
    }
    if (this.pending.length > 0) {
      const count = this.pending.length;
      this.pending.length = 0;
      this.hooks.say(`Discarded ${count} queued message${count === 1 ? "" : "s"}.`);
      this.hooks.changed();
      return { kind: "queue-discarded", count };
    }
    return { kind: "nothing" };
  }

  /** Drop anything queued without touching a running turn. */
  clearQueue(): number {
    const count = this.pending.length;
    this.pending.length = 0;
    if (count > 0) this.hooks.changed();
    return count;
  }

  private start(text: string): void {
    this.running = true;
    this.cancelled = false;
    this.hooks.echo(text);
    this.hooks.changed();
    void this.hooks
      .send(text)
      .catch((err: unknown) => {
        this.hooks.onError(err);
      })
      .finally(() => {
        this.running = false;
        this.hooks.changed();
        this.drain();
      });
  }

  /**
   * Send the next queued message. A cancel discards the rest: the queue was
   * typed in the expectation that the earlier turn would proceed, so continuing
   * after an interruption would run work the user just stopped.
   */
  private drain(): void {
    if (this.cancelled) {
      const dropped = this.clearQueue();
      if (dropped > 0) {
        this.hooks.say(`Discarded ${dropped} queued message${dropped === 1 ? "" : "s"}.`);
      }
      this.cancelled = false;
      return;
    }
    const next = this.pending.shift();
    if (next === undefined) return;
    this.hooks.changed();
    this.start(next);
  }
}
