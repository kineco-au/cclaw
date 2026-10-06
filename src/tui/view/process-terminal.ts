/**
 * PORTED FROM OpenClaw: src/tui/tui-process-terminal.ts
 * Upstream: https://github.com/openclaw/openclaw (MIT) - commit in PROVENANCE.md
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { ProcessTerminal } from "@earendil-works/pi-tui";

export class TuiProcessTerminal extends ProcessTerminal {
  override start(onInput: (data: string) => void, onResize: () => void): void {
    // Stdio can predate CLI startup; callbacks must retain its resource lifecycle context.
    super.start(AsyncLocalStorage.bind(onInput), AsyncLocalStorage.bind(onResize));
  }
}
