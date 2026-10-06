/**
 * Compaction: trade a long session for a summary of it.
 *
 * Context lives inside Cursor's ACP session — we send only the latest message
 * and Cursor keeps the thread — so we cannot trim it, measure it, or inspect
 * it. The one thing we can do is ask the model to summarise what it has while
 * it still has it, start a fresh session, and carry the summary forward. That
 * makes the summary the model's own words about its own context, which is the
 * only source with the whole picture.
 *
 * The summary is prepended to the next message rather than sent as a turn of
 * its own: a standalone turn would spend a round trip on a reply to a summary
 * nobody asked a question about.
 */

/** The prompt that asks for the summary. Addressed to the successor session. */
export function compactPrompt(focus?: string): string {
  const lines = [
    "Summarise this conversation so that work can continue in a fresh session",
    "that has no other memory of it. Write notes to your successor, not a report",
    "to me. Cover, in this order:",
    "",
    "1. What I asked for, and every constraint or preference I stated.",
    "2. Decisions taken and the reason for each, including options rejected.",
    "3. Files created or changed, and what they now contain.",
    "4. Commands that worked, and ones that failed with their error text.",
    "5. What has been verified by running it, versus what is still assumed.",
    "6. What is outstanding, and the next concrete step.",
    "",
    "Preserve exact identifiers verbatim: paths, function and symbol names,",
    "flags, versions and error strings. Omit pleasantries, and omit anything",
    "that has since been superseded. Reply with the summary alone.",
  ];
  if (focus !== undefined && focus.trim() !== "") {
    lines.push("", `Give particular weight to: ${focus.trim()}`);
  }
  return lines.join("\n");
}

/**
 * Shortest reply we will accept as a summary of a session.
 *
 * Needed because Cursor delivers some failures as ordinary assistant prose:
 * a plan-gated turn streams "Upgrade your plan to continue" as an
 * `agent_message_chunk` and then reports `stopReason: "end_turn"`, so neither
 * the protocol nor the transcript marks it as an error. Treating that as a
 * summary would clear the session and keep one sentence in its place, which is
 * the one outcome compaction must never produce. A real summary of a session
 * worth compacting does not fit in a line, so refuse anything that does and
 * leave the context alone.
 */
export const MIN_SUMMARY_CHARS = 200;

/** Whether a reply is long enough to plausibly be a summary. */
export function isPlausibleSummary(reply: string): boolean {
  return reply.trim().length >= MIN_SUMMARY_CHARS;
}

const OPEN = "<compacted-context>";
const CLOSE = "</compacted-context>";

/** What the carried block holds: a model-written summary, or a real transcript. */
export type CarriedKind = "summary" | "transcript";

const PREAMBLE: Record<CarriedKind, string[]> = {
  summary: [
    "A summary of this conversation so far. The session it describes has been",
    "cleared, so this is all that remains of it. Treat it as established fact",
    "and continue from it.",
  ],
  transcript: [
    "The transcript of an earlier session, resumed. You do not hold it in",
    "context, so it is replayed here verbatim. Treat it as established fact",
    "and continue from it.",
  ],
};

/**
 * Prepend carried context to the next message. Tagged so the model can tell
 * recalled context from what the user just typed.
 *
 * The preamble must match what is actually carried: calling a replayed
 * transcript a summary of a cleared session tells the model two untrue things
 * about its own history.
 */
export function carriedMessage(
  carried: string,
  text: string,
  kind: CarriedKind = "summary",
): string {
  return [OPEN, ...PREAMBLE[kind], "", carried.trim(), CLOSE, "", text].join("\n");
}
