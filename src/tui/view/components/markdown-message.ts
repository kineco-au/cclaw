/**
 * PORTED FROM OpenClaw: src/tui/components/markdown-message.ts
 * Upstream: https://github.com/openclaw/openclaw (MIT) - commit in PROVENANCE.md
 *
 * Verbatim except import specifiers, which are rewritten to cclaw path aliases
 * and local shims. Do not reshape the component API.
 */
import {
  Container,
  Spacer,
  type DefaultTextStyle,
  type MarkdownOptions,
} from "@earendil-works/pi-tui";
import { markdownTheme } from "../theme/theme.ts";
import type { TuiImageSource } from "../tui-images.ts";
import { HyperlinkMarkdown } from "./hyperlink-markdown.ts";
import { MessageImages, type TuiImageRenderer } from "./message-images.ts";

export class MarkdownMessageComponent extends Container {
  private body: HyperlinkMarkdown;
  private images: MessageImages;

  constructor(
    text: string,
    y: number,
    defaultTextStyle?: DefaultTextStyle,
    options?: MarkdownOptions,
    imageRenderer?: TuiImageRenderer,
  ) {
    super();
    this.body = new HyperlinkMarkdown(text, 0, y, markdownTheme, defaultTextStyle, options);
    this.addChild(new Spacer(1));
    this.addChild(this.body);
    this.images = new MessageImages(imageRenderer);
    this.addChild(this.images);
  }

  setText(text: string) {
    this.body.setText(text);
  }

  setImages(images: readonly TuiImageSource[]) {
    this.images.setImages(images);
  }

  dispose() {
    this.images.dispose();
  }
}
