/**
 * PORTED FROM OpenClaw: src/tui/components/user-message.ts
 * Upstream: https://github.com/openclaw/openclaw (MIT) - commit in PROVENANCE.md
 *
 * Verbatim except import specifiers, which are rewritten to cclaw path aliases
 * and local shims. Do not reshape the component API.
 */
import { tuiTheme as theme } from "../theme/theme.ts";
import { MarkdownMessageComponent } from "./markdown-message.ts";
import type { TuiImageRenderer } from "./message-images.ts";

/** Markdown chat-log row styled as user input. */
export class UserMessageComponent extends MarkdownMessageComponent {
  constructor(text: string, imageRenderer?: TuiImageRenderer) {
    super(
      text,
      1,
      {
        bgColor: (line) => theme.userBg(line),
        color: (line) => theme.userText(line),
      },
      {
        preserveOrderedListMarkers: true,
        preserveBackslashEscapes: true,
      },
      imageRenderer,
    );
  }
}
