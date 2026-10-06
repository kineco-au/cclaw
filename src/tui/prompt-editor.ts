/**
 * The input field, with a left indent and a `>` prompt.
 *
 * A subclass rather than an edit to `view/components/custom-editor.ts`: that
 * file is ported from OpenClaw and kept verbatim so refreshes stay clean diffs.
 *
 * The indent is the Editor's own `paddingX`, so wrapping, borders and the
 * autocomplete popup all lay themselves out correctly. The only thing this
 * class does is swap the leading padding of the first input line for "> ".
 *
 * An earlier version reduced the width and rebuilt the borders by hand. That
 * assumed `super.render()` returns exactly [border, content, border] — but when
 * the autocomplete popup is open it also returns a separator and one row per
 * suggestion. The "bottom border" was then whatever the last row happened to
 * be, and rebuilding it from its first glyph obliterated the suggestion: typing
 * `/ex` showed an empty list instead of `exit`. Hence: touch one line, nothing
 * else.
 */

import { CustomEditor } from "./view/components/custom-editor.ts";

const PROMPT = "> ";
/** One space of indent plus the prompt, as the Editor's own padding. */
const PADDING_X = 1 + PROMPT.length;
/** super.render() returns the top border first, so the input begins here. */
const FIRST_CONTENT_LINE = 1;

export interface PromptEditorStyle {
  /** Colours the prompt character. */
  prompt: (s: string) => string;
}

export class PromptEditor extends CustomEditor {
  private promptStyle: PromptEditorStyle = { prompt: (s) => s };

  setPromptStyle(style: PromptEditorStyle): void {
    this.promptStyle = style;
  }

  /** The indent every line gets, including wrapped continuations. */
  get promptPadding(): number {
    return PADDING_X;
  }

  override render(width: number): string[] {
    // paddingX must be applied here rather than in the constructor: the base
    // class reads it during render, and setting it up front keeps the subclass
    // free of constructor plumbing.
    if (this.getPaddingX() !== PADDING_X) this.setPaddingX(PADDING_X);

    const lines = super.render(width);
    const line = lines[FIRST_CONTENT_LINE];
    if (line === undefined) return lines;

    // Swap the leading indent for " > ". Done on the raw string so the line's
    // width is unchanged; if the expected padding is not there (an unexpected
    // layout), the line is left exactly as the base class produced it.
    const indent = " ".repeat(PADDING_X);
    if (!line.startsWith(indent)) return lines;

    const out = [...lines];
    out[FIRST_CONTENT_LINE] = `${" ".repeat(PADDING_X - PROMPT.length)}${this.promptStyle.prompt(
      PROMPT,
    )}${line.slice(PADDING_X)}`;
    return out;
  }
}
