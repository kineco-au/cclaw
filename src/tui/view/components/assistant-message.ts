/**
 * PORTED FROM OpenClaw: src/tui/components/assistant-message.ts
 * Upstream: https://github.com/openclaw/openclaw (MIT) - commit in PROVENANCE.md
 *
 * Verbatim except import specifiers, which are rewritten to cclaw path aliases
 * and local shims. Do not reshape the component API.
 */
import { tuiTheme as theme } from "../theme/theme.ts";
import { MarkdownMessageComponent } from "./markdown-message.ts";
import type { TuiImageRenderer } from "./message-images.ts";

export class AssistantMessageComponent extends MarkdownMessageComponent {
  constructor(text: string, imageRenderer?: TuiImageRenderer) {
    super(
      text,
      0,
      {
        // Keep assistant body text in terminal default foreground so contrast
        // follows the user's terminal theme (dark or light).
        color: (line) => theme.assistantText(line),
      },
      undefined,
      imageRenderer,
    );
  }
}
