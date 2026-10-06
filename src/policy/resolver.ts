/**
 * Turns an ACP permission request into a decision, using the exec policy and
 * the approval store, and asking the user only when policy says to.
 *
 * ACP gives us the tool call and a set of options whose ids Cursor chooses
 * (observed: allow-once / allow-always / reject-once). We map our decision onto
 * whichever options are actually offered rather than assuming they exist.
 *
 * The important behaviour: for a sensitive command, Cursor's "allow always" is
 * recorded as a **session** grant, not a permanent one. Permanence is a separate,
 * deliberate act (`cclaw grant add`), so "always" cannot quietly become forever.
 */

import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import type { PermissionVerdict } from "../acp/client.ts";
import { ApprovalStore } from "./approvals.ts";
import { analyzeCommandLine, decideExec, resolveExecPolicy, type ExecMode } from "./exec-policy.ts";

/**
 * What the user can choose. These are OUR semantics, not Cursor's: we render the
 * prompt, so we decide what is on offer and then map the choice onto whichever
 * option id Cursor actually advertised.
 *
 *   once    - this invocation only
 *   session - every matching call until this session ends
 *   always  - permanently, for this profile and directory
 *   reject  - refuse this invocation
 */
export type AskChoiceKind = "once" | "session" | "always" | "reject";

export interface AskChoice {
  kind: AskChoiceKind;
  label: string;
  hint: string;
}

export interface AskContext {
  /** The command line, when the request is a shell execution. */
  command?: string;
  toolTitle: string;
  reason: string;
  choices: AskChoice[];
}

/** How the host asks the user. Returns the chosen kind, or null to deny. */
export type AskUser = (ctx: AskContext) => Promise<AskChoiceKind | null>;

export interface ResolverOptions {
  mode: ExecMode;
  allow: readonly string[];
  deny?: readonly string[];
  strictInlineEval?: boolean;
  cwd: string;
  store: ApprovalStore;
  askUser: AskUser;
  /** Commands that always require consent, even if allowlisted. */
  sensitive?: readonly string[];
  onNotice?: (text: string) => void;
}

function classify(optionId: string, name?: string): "allow" | "allow-always" | "reject" {
  const s = `${optionId} ${name ?? ""}`.toLowerCase();
  if (/reject|deny|no/.test(s)) return "reject";
  if (/always/.test(s)) return "allow-always";
  return "allow";
}

/** Extract the command line from an ACP permission request, if it has one. */
export function commandFromRequest(req: RequestPermissionRequest): string | undefined {
  const call = req.toolCall as
    { title?: string; rawInput?: Record<string, unknown>; kind?: string } | undefined;
  const raw = call?.rawInput;
  for (const key of ["command", "cmd"]) {
    const v = raw?.[key];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  // Cursor renders shell calls with the command in backticks in the title.
  const title = call?.title;
  if (typeof title === "string") {
    const backticked = /`([^`]+)`/.exec(title);
    if (backticked?.[1] !== undefined) return backticked[1];
  }
  return undefined;
}

export function createPermissionResolver(
  opts: ResolverOptions,
): (req: RequestPermissionRequest) => Promise<PermissionVerdict> {
  const policy = resolveExecPolicy(opts.mode);
  const sensitive = new Set(opts.sensitive ?? []);

  return async (req) => {
    const options = (req.options ?? []).map((o) => ({
      optionId: o.optionId,
      label: String(o.name ?? o.optionId),
      kind: classify(o.optionId, o.name === null ? undefined : o.name),
    }));
    const rejectOption = options.find((o) => o.kind === "reject");
    const allowOnce = options.find((o) => o.kind === "allow");
    const allowAlways = options.find((o) => o.kind === "allow-always");

    const deny = (reason: string): PermissionVerdict => {
      opts.onNotice?.(`Denied: ${reason}`);
      return rejectOption !== undefined
        ? { kind: "reject", optionId: rejectOption.optionId }
        : { kind: "cancel" };
    };

    const command = commandFromRequest(req);
    const toolTitle =
      (req.toolCall as { title?: string } | undefined)?.title ?? command ?? "a tool call";

    // A non-shell tool call has no command line to analyse. Those are governed
    // by Cursor's own permission config; we only gate what we can reason about.
    if (command === undefined) {
      if (allowOnce === undefined) return deny("no allow option offered");
      return { kind: "allow", optionId: allowOnce.optionId };
    }

    const analysis = analyzeCommandLine(command);

    // Resolve the store once per command, up front: decideExec is synchronous
    // and the lookups are async.
    const grants = new Map<string, "never" | "granted" | "none">();
    for (const cmd of analysis.commands) {
      const found = await opts.store.lookup({ command: cmd, argv: command, cwd: opts.cwd });
      grants.set(cmd, found === null ? "none" : found.scope === "never" ? "never" : "granted");
    }

    // A blocked command is refused without asking.
    for (const [cmd, state] of grants) {
      if (state === "never") return deny(`'${cmd}' is blocked for this profile`);
    }

    // A sensitive command always needs consent, even if the allowlist would
    // permit it — that is the whole point of the sensitive list. An existing
    // grant (session or profile) is the only thing that skips the prompt.
    const ungrantedSensitive = analysis.commands.find(
      (cmd) => sensitive.has(cmd) && grants.get(cmd) !== "granted",
    );

    const decision =
      ungrantedSensitive !== undefined
        ? {
            decision: "ask" as const,
            reason: `'${ungrantedSensitive}' is a sensitive command and needs your consent`,
            command: ungrantedSensitive,
          }
        : decideExec({
            policy,
            analysis,
            allow: opts.allow,
            ...(opts.deny !== undefined ? { deny: opts.deny } : {}),
            ...(opts.strictInlineEval !== undefined
              ? { strictInlineEval: opts.strictInlineEval }
              : {}),
            granted: (cmd) => grants.get(cmd) === "granted",
          });

    if (decision.decision === "deny") return deny(decision.reason);

    if (decision.decision === "allow") {
      if (allowOnce === undefined) return deny("no allow option offered");
      return { kind: "allow", optionId: allowOnce.optionId };
    }

    // Ask. The choices offered are ours; only "always" depends on Cursor having
    // advertised an allow-always option, since that is the one we also want
    // Cursor itself to remember.
    const target = decision.command;
    const choices: AskChoice[] = [{ kind: "once", label: "Allow once", hint: "just this command" }];
    if (target !== undefined && opts.store.hasSession()) {
      choices.push({
        kind: "session",
        label: "Allow this session",
        hint: `every '${target}' until this session ends`,
      });
    }
    if (target !== undefined) {
      choices.push({
        kind: "always",
        label: "Allow always",
        hint: `every '${target}' in this directory, permanently`,
      });
    }
    choices.push({ kind: "reject", label: "Reject", hint: "refuse this command" });

    const chosen = await opts.askUser({
      ...(command !== undefined ? { command } : {}),
      toolTitle,
      reason: decision.reason,
      choices,
    });
    if (chosen === null || chosen === "reject") return deny("you declined");

    if (target !== undefined && (chosen === "session" || chosen === "always")) {
      const scope = chosen === "always" ? "profile" : "session";
      try {
        await opts.store.grant({ command: target, cwd: opts.cwd, scope });
        opts.onNotice?.(
          chosen === "always"
            ? `'${target}' is now allowed permanently in ${opts.cwd}. Undo with: cclaw grant rm ${target}`
            : `'${target}' is allowed for this session.`,
        );
      } catch {
        // Recording failed (e.g. no session id): the single call still proceeds.
      }
    }

    // Tell Cursor to remember it too when the grant is permanent, so its own
    // allowlist agrees with ours; otherwise authorise just this invocation.
    if (chosen === "always" && allowAlways !== undefined) {
      return { kind: "allow", optionId: allowAlways.optionId };
    }
    if (allowOnce !== undefined) return { kind: "allow", optionId: allowOnce.optionId };
    if (allowAlways !== undefined) return { kind: "allow", optionId: allowAlways.optionId };
    return deny("no allow option offered");
  };
}

export { ApprovalStore };
