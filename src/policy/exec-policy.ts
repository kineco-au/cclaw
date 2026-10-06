/**
 * Command execution policy.
 *
 * The five-mode model is ported from OpenClaw's exec policy
 * (src/infra/exec-policy.ts and its approvals core), reimplemented in
 * TypeScript rather than copied, because upstream's version is layered over its
 * gateway approval store and config schema.
 *
 * `matchesExecAllowlistPattern` is a close port of upstream's
 * src/infra/exec-allowlist-pattern.ts, including its macOS `/private/var`
 * normalisation — that detail matters, as macOS resolves `/tmp` to
 * `/private/tmp` and a naive matcher silently fails to match.
 *
 * Scope: this governs commands *we* gate before handing a decision back over
 * ACP. It is a consent layer, not a sandbox — see SECURITY notes in templates.ts.
 */

import { homedir, platform } from "node:os";
import { posix, win32 } from "node:path";
import { escapeRegExp } from "../tui/view/shims/regexp.ts";

/** Upstream's five modes, with the security/ask semantics they resolve to. */
export type ExecMode = "deny" | "allowlist" | "ask" | "auto" | "full";
export type ExecSecurity = "deny" | "allowlist" | "full";
export type ExecAsk = "off" | "on-miss";

export interface ExecPolicy {
  mode: ExecMode;
  security: ExecSecurity;
  ask: ExecAsk;
}

const MODE_TABLE: Record<ExecMode, { security: ExecSecurity; ask: ExecAsk }> = {
  // Block everything.
  deny: { security: "deny", ask: "off" },
  // Allowlist only; a miss is a silent denial.
  allowlist: { security: "allowlist", ask: "off" },
  // Allowlist, and ask a human on a miss. This is our default.
  ask: { security: "allowlist", ask: "on-miss" },
  // Allowlist, ask on miss, but a reviewer may answer first. We treat the
  // reviewer as absent and fall back to asking, so `auto` is never weaker
  // than `ask` here.
  auto: { security: "allowlist", ask: "on-miss" },
  // No ordinary prompts.
  full: { security: "full", ask: "off" },
};

export function resolveExecPolicy(mode: ExecMode): ExecPolicy {
  const row = MODE_TABLE[mode];
  return { mode, security: row.security, ask: row.ask };
}

// --- allowlist pattern matching (ported) ------------------------------------

const GLOB_REGEX_CACHE_LIMIT = 512;
const globRegexCache = new Map<string, RegExp>();

function expandHomePrefix(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return `${homedir()}/${value.slice(2)}`;
  return value;
}

function normalizeMatchTarget(value: string): string {
  if (platform() === "win32") {
    const stripped = value.replace(/^\\\\[?.]\\/, "");
    return stripped.replace(/\\/g, "/").toLowerCase();
  }
  const normalized = value.replace(/\\\\/g, "/");
  if (platform() === "darwin") {
    // macOS resolves /tmp and /var through /private; without this a pattern
    // written as /var/... never matches a realpath of /private/var/...
    if (normalized === "/private/var") return "/var";
    if (normalized.startsWith("/private/var/")) return normalized.slice("/private".length);
    if (normalized === "/private/tmp") return "/tmp";
    if (normalized.startsWith("/private/tmp/")) return normalized.slice("/private".length);
  }
  return normalized;
}

function hasDotPathSegment(value: string): boolean {
  return value
    .replace(/\\/g, "/")
    .split("/")
    .some((segment) => segment === "." || segment === "..");
}

function normalizeDotPathSegments(value: string): string {
  const normalized = platform() === "win32" ? win32.normalize(value) : posix.normalize(value);
  return normalizeMatchTarget(normalized);
}

function compileGlobRegex(pattern: string): RegExp {
  const cacheKey = `${platform()}:${pattern}`;
  const cached = globRegexCache.get(cacheKey);
  if (cached) return cached;

  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern.charAt(i);
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        regex += ".*";
        i += 2;
        continue;
      }
      regex += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      regex += "[^/]";
      i += 1;
      continue;
    }
    regex += escapeRegExp(ch);
    i += 1;
  }
  regex += "$";

  const compiled = new RegExp(regex, platform() === "win32" ? "i" : "");
  if (globRegexCache.size >= GLOB_REGEX_CACHE_LIMIT) globRegexCache.clear();
  globRegexCache.set(cacheKey, compiled);
  return compiled;
}

/** Glob match for an allowlist entry against a command or path. */
export function matchesExecAllowlistPattern(pattern: string, target: string): boolean {
  const trimmed = pattern.trim();
  if (trimmed === "") return false;
  const expanded = trimmed.startsWith("~") ? expandHomePrefix(trimmed) : trimmed;
  const hasWildcard = /[*?]/.test(expanded);
  let normalizedPattern = normalizeMatchTarget(expanded);
  let normalizedTarget = normalizeMatchTarget(target);
  // Normalise only the target: glob patterns are operator-authored and
  // normalising them can change wildcard structure such as `*/..`.
  if (hasWildcard && hasDotPathSegment(normalizedTarget)) {
    normalizedTarget = normalizeDotPathSegments(normalizedTarget);
  }
  return compileGlobRegex(normalizedPattern).test(normalizedTarget);
}

// --- command analysis -------------------------------------------------------

/** Wrappers that prefix a real command and must be peeled before matching. */
const WRAPPERS = new Set([
  "env",
  "sudo",
  "doas",
  "nohup",
  "command",
  "time",
  "xargs",
  "nice",
  "stdbuf",
  "setsid",
]);

/**
 * Shells whose `-c` argument is itself a shell command we can analyse. These are
 * unwrapped rather than refused: the agent routinely runs work through
 * `bash -c '...'`, so treating that as opaque would deny everything, and
 * allowlisting it would make it a bypass. Looking inside is the only coherent
 * option.
 */
const SHELL_WRAPPERS: Record<string, readonly string[]> = {
  bash: ["-c"],
  sh: ["-c"],
  zsh: ["-c"],
  dash: ["-c"],
  ksh: ["-c"],
};

/**
 * Interpreters that execute code in a language we cannot analyse, so the
 * command name genuinely tells you nothing about what will run.
 *
 * Deliberately NOT here: `sed` and `awk`. Their program is their ordinary
 * argument, and `sed -n '1,5p' file` is routine — flagging them denied common
 * work for no security gain.
 */
const INLINE_EVAL: Record<string, readonly string[]> = {
  python: ["-c"],
  python3: ["-c"],
  node: ["-e", "--eval", "-p", "--print"],
  bun: ["-e", "--eval"],
  deno: ["eval"],
  ruby: ["-e"],
  perl: ["-e", "-E"],
  php: ["-r"],
  osascript: ["-e"],
};

/** Strip one layer of matching quotes from a shell word. */
function unquote(value: string): string {
  const first = value.charAt(0);
  if ((first === '"' || first === "'") && value.endsWith(first) && value.length >= 2) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * If a segment is `bash -c '<script>'`, return the inner script, so
 * `bash -c 'aws s3 ls'` is judged as `aws s3 ls`.
 */
function shellWrappedScript(parts: readonly string[]): string | null {
  const head = parts[0];
  if (head === undefined) return null;
  const base = head.split("/").pop() ?? head;
  const flags = SHELL_WRAPPERS[base];
  if (flags === undefined) return null;
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined) continue;
    if (flags.includes(part)) {
      const script = parts
        .slice(i + 1)
        .join(" ")
        .trim();
      return script === "" ? null : unquote(script);
    }
  }
  return null;
}

/** Guards against a pathological `bash -c 'bash -c "bash -c ..."'` chain. */
const MAX_UNWRAP_DEPTH = 4;

/**
 * Split a command line on shell separators, ignoring separators inside quotes.
 *
 * A naive split tore quoted text apart: `grep "a|b" file` yielded a phantom
 * command `b"`, and `bash -c 'cat f | aws ...'` lost the wrapper entirely.
 */
export function splitSegments(line: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (quote !== null) {
      current += ch;
      // A backslash-escaped quote inside a double-quoted string does not close it.
      if (ch === quote && !(quote === '"' && line.charAt(i - 1) === "\\")) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.filter((s) => s.trim() !== "");
}

export interface CommandAnalysis {
  /** False when the line cannot be parsed confidently; callers must fail shut. */
  ok: boolean;
  reason?: string;
  /** Basenames of every binary the line would invoke. */
  commands: string[];
  /** True when an interpreter would run code supplied inline. */
  inlineEval: boolean;
}

/**
 * Conservative analysis of a shell command line.
 *
 * Deliberately refuses rather than guesses: substitutions, backticks and `eval`
 * can hide anything, and a wrapper followed by an option (`nice -n5 kubectl`)
 * makes the real binary ambiguous. Reporting the flag as the command would be a
 * security-relevant false negative, so those return ok: false.
 */
export function analyzeCommandLine(line: string, depth = 0): CommandAnalysis {
  if (/\$\(|`|\beval\b/.test(line)) {
    return { ok: false, reason: "contains substitution or eval", commands: [], inlineEval: false };
  }
  if (depth > MAX_UNWRAP_DEPTH) {
    return {
      ok: false,
      reason: "shell wrappers nested too deeply",
      commands: [],
      inlineEval: false,
    };
  }

  const commands: string[] = [];
  let inlineEval = false;

  for (const rawSegment of splitSegments(line)) {
    let seg = rawSegment.trim();
    if (seg === "") continue;

    for (;;) {
      const before = seg;
      seg = seg.replace(/^\s+/, "");
      const assignment = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s*/.exec(seg);
      if (assignment) {
        seg = seg.slice(assignment[0].length);
      } else {
        const word = seg.split(/\s+/)[0] ?? "";
        if (WRAPPERS.has(word)) seg = seg.slice(word.length);
        else break;
      }
      if (seg === "" || seg === before) break;
    }

    const parts = seg.split(/\s+/).filter((p) => p !== "");
    const head = parts[0];
    if (head === undefined) continue;
    if (head.startsWith("-")) {
      return {
        ok: false,
        reason: "wrapper option hides the real command",
        commands: [],
        inlineEval: false,
      };
    }

    // `bash -c '<script>'` is the agent's normal transport. Analyse the script
    // rather than the shell, so the decision is about what actually runs.
    const inner = shellWrappedScript(parts);
    if (inner !== null) {
      const nested = analyzeCommandLine(inner, depth + 1);
      if (!nested.ok) return nested;
      commands.push(...nested.commands);
      if (nested.inlineEval) inlineEval = true;
      continue;
    }

    const base = head.split("/").pop() ?? head;
    commands.push(base);

    const evalFlags = INLINE_EVAL[base];
    if (evalFlags !== undefined && parts.slice(1).some((p) => evalFlags.includes(p))) {
      inlineEval = true;
    }
  }

  if (commands.length === 0) {
    return { ok: false, reason: "no command found", commands: [], inlineEval: false };
  }
  return { ok: true, commands, inlineEval };
}

// --- the decision -----------------------------------------------------------

export type ExecDecision = "allow" | "deny" | "ask";

export interface DecideInput {
  policy: ExecPolicy;
  analysis: CommandAnalysis;
  /** Allowlist entries, matched against each command basename. */
  allow: readonly string[];
  /** Deny entries. Deny always beats allow. */
  deny?: readonly string[];
  /** Refuse inline-eval invocations outright. */
  strictInlineEval?: boolean;
  /** Commands already granted for this session or profile. */
  granted?: (command: string) => boolean;
}

export interface DecisionResult {
  decision: ExecDecision;
  /** Why, in words suitable for showing the user. */
  reason: string;
  /** The command that drove the decision, when one did. */
  command?: string;
}

export function decideExec(input: DecideInput): DecisionResult {
  const { policy, analysis } = input;

  // Unparseable input fails shut regardless of mode.
  if (!analysis.ok) {
    return { decision: "deny", reason: analysis.reason ?? "could not parse the command" };
  }
  if (policy.security === "deny") {
    return { decision: "deny", reason: "execution is disabled (mode: deny)" };
  }
  // Inline code asks rather than denies. The command name genuinely does not
  // describe what runs, so it warrants a prompt — but an outright denial left
  // no way to approve legitimate work, which made it a dead end rather than a
  // control. Only unparseable input and an explicit deny are terminal.
  if (input.strictInlineEval === true && analysis.inlineEval) {
    if (policy.ask === "on-miss") {
      return {
        decision: "ask",
        reason: "runs code supplied inline, so the command name does not describe what executes",
      };
    }
    return {
      decision: "deny",
      reason: "runs code supplied inline and this mode cannot prompt",
    };
  }

  const denyList = input.deny ?? [];
  for (const cmd of analysis.commands) {
    if (denyList.some((p) => matchesExecAllowlistPattern(p, cmd))) {
      return { decision: "deny", reason: `'${cmd}' is explicitly denied`, command: cmd };
    }
  }

  if (policy.security === "full") {
    return { decision: "allow", reason: "all commands permitted (mode: full)" };
  }

  for (const cmd of analysis.commands) {
    const allowed =
      input.allow.some((p) => matchesExecAllowlistPattern(p, cmd)) || input.granted?.(cmd) === true;
    if (!allowed) {
      return policy.ask === "on-miss"
        ? { decision: "ask", reason: `'${cmd}' is not on the allowlist`, command: cmd }
        : { decision: "deny", reason: `'${cmd}' is not on the allowlist`, command: cmd };
    }
  }

  return { decision: "allow", reason: "every command is allowlisted or granted" };
}
