/**
 * PORTED FROM OpenClaw: src/tui/tui-formatters.ts (the renderable-text subset)
 * Upstream: https://github.com/openclaw/openclaw (MIT) - commit in PROVENANCE.md
 *
 * Only the text-sanitising half is ported. The rest of upstream's
 * tui-formatters formats OpenClaw's own message payloads (reply-payload, media
 * facts, inbound meta, token footers) and pulls in the auto-reply and agents
 * subsystems plus two more workspace packages. Our backend produces ACP content
 * blocks instead, so that logic does not apply — but `sanitizeRenderableText` is
 * a terminal-safety function with no OpenClaw concepts in it, and the view layer
 * depends on it, so it is reproduced verbatim.
 */

import { stripAnsi } from "@openclaw/terminal-core/ansi";

const REPLACEMENT_CHAR_RE = /�/g;
const RENDER_CONTROL_CHARS_RE = new RegExp(
  String.raw`[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]`,
  "g",
);
const BINARY_LINE_REPLACEMENT_THRESHOLD = 12;
const RTL_SCRIPT_RE = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/;
const BIDI_CONTROL_RE = /[؜‎‏‪-‮⁦-⁩]/;
const BIDI_CONTROL_GLOBAL_RE = /[؜‎‏‪-‮⁦-⁩]/g;
const RTL_ISOLATE_START = "⁧";
const RTL_ISOLATE_END = "⁩";

function redactBinaryLikeLine(line: string): string {
  const replacementCount = (line.match(REPLACEMENT_CHAR_RE) || []).length;
  if (
    replacementCount >= BINARY_LINE_REPLACEMENT_THRESHOLD &&
    replacementCount * 2 >= line.length
  ) {
    return "[binary data omitted]";
  }
  return line;
}

/** Strip ANSI, control characters and bidi overrides; redact binary-looking lines. */
export function sanitizeTerminalControlsAndBinary(text: string): string {
  const hasAnsi = text.includes("\u001b") || text.includes("\u009b") || text.includes("\u009d");
  const withoutAnsi = hasAnsi ? stripAnsi(text) : text;
  const withoutControlChars = withoutAnsi.replace(RENDER_CONTROL_CHARS_RE, "");
  const withoutBidiControls = BIDI_CONTROL_RE.test(withoutControlChars)
    ? withoutControlChars.replace(BIDI_CONTROL_GLOBAL_RE, "")
    : withoutControlChars;
  return withoutBidiControls.includes("�")
    ? withoutBidiControls
        .split("\n")
        .map((line) => redactBinaryLikeLine(line))
        .join("\n")
    : withoutBidiControls;
}

function applyRtlIsolation(text: string): string {
  if (!RTL_SCRIPT_RE.test(text)) {
    return text;
  }
  return text
    .split("\n")
    .map((line) =>
      RTL_SCRIPT_RE.test(line) ? `${RTL_ISOLATE_START}${line}${RTL_ISOLATE_END}` : line,
    )
    .join("\n");
}

/** Wrap RTL lines in isolates so mixed-direction text cannot scramble the layout. */
export function isolateRtlRenderedLine(line: string): string {
  if (!RTL_SCRIPT_RE.test(line) || !RTL_SCRIPT_RE.test(stripAnsi(line))) {
    return line;
  }
  const padding = line.match(/^(\s*)(.*\S)(\s*)$/u);
  if (!padding) {
    return line;
  }
  return `${padding[1]}${RTL_ISOLATE_START}${padding[2]}${RTL_ISOLATE_END}${padding[3]}`;
}

/** Multi-line safe text, newlines preserved. */
export function sanitizeRenderableText(text: string): string {
  return applyRtlIsolation(sanitizeTerminalControlsAndBinary(text));
}

/** Single-line safe text: whitespace collapsed, for titles and list rows. */
export function sanitizeRenderableLine(text: string): string {
  const line = sanitizeTerminalControlsAndBinary(text).replace(/\s+/gu, " ").trim();
  return applyRtlIsolation(line);
}
