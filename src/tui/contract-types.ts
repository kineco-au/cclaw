/**
 * PORTED FROM OpenClaw: src/tui/tui-types.ts and src/tui/tui-session-info.ts
 *
 * Upstream: https://github.com/openclaw/openclaw (MIT)
 * Commit:   see PROVENANCE.md
 *
 * Only the two types `TuiBackend` actually references are ported here, kept
 * field-for-field so upstream view code keeps compiling.
 *
 * Three upstream types are resolved differently, to avoid vendoring OpenClaw's
 * zod config layer (src/config alone is ~1,461 files):
 *   - GatewayAgentRuntime: derived from the vendored AgentSummary, exactly as
 *     upstream's src/shared/session-types.ts derives it.
 *   - ResponseUsageMode:   a file-local union upstream; copied verbatim.
 *   - SessionScope:        behind a zod schema we deliberately do not vendor.
 *     It is a display-only field, so it is widened to `string` here. Narrow it
 *     if the ported view layer ever needs the exact union.
 */

import type { AgentSummary, SessionGoal } from "@openclaw/gateway-protocol";
import type { FastMode } from "@openclaw/normalization-core/string-coerce";

/** Runtime selection metadata for an agent row. Upstream derives this identically. */
export type GatewayAgentRuntime = NonNullable<AgentSummary["agentRuntime"]>;

/** Upstream: file-local in tui-types.ts. */
export type ResponseUsageMode = "on" | "off" | "tokens" | "full";

/**
 * Session-key ownership model. Upstream narrows this via a zod schema in
 * src/config/types.base.ts; widened here, see the module note above.
 */
export type SessionScope = string;

/**
 * Per-session metadata the TUI footer renders.
 *
 * Note the token fields: OpenClaw's footer shows context and token usage, but
 * Cursor exposes none of it over ACP (verified — no token, usage or context
 * field appears in any session/update, and none is advertised in
 * agentCapabilities). Our backend therefore leaves them undefined and the
 * footer renders unknown. `cclaw raw` is the mode where a real figure exists.
 */
export type SessionInfo = {
  thinkingLevel?: string;
  thinkingLevels?: Array<{ id: string; label: string }>;
  fastMode?: FastMode;
  verboseLevel?: string;
  traceLevel?: string;
  reasoningLevel?: string;
  model?: string;
  modelProvider?: string;
  agentRuntime?: GatewayAgentRuntime;
  contextTokens?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  /**
   * True when `totalTokens` is a known-fresh value (e.g. 0 on a brand-new
   * session) rather than an unknown/stale total. Lets the footer render `0`
   * instead of `?` for fresh sessions.
   */
  totalTokensFresh?: boolean;
  goal?: SessionGoal;
  responseUsage?: ResponseUsageMode;
  /** Resolved effective usage mode (session override -> config -> default -> off). */
  effectiveResponseUsage?: ResponseUsageMode;
  updatedAt?: number | null;
  displayName?: string;
};

/** Fallbacks applied when a session row omits a field. */
export type SessionInfoDefaults = {
  model?: string | null;
  modelProvider?: string | null;
  contextTokens?: number | null;
  thinkingLevels?: Array<{ id: string; label: string }>;
};
