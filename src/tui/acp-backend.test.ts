import { describe, expect, test } from "bun:test";
import { CURSOR_AGENT_ID, toModelChoice } from "./acp-backend.ts";

describe("toModelChoice", () => {
  test("maps a catalogue entry onto the contract shape", () => {
    const c = toModelChoice(
      { id: "claude-opus-5-5-high", displayName: "Claude Opus 5.5 1M High" },
      false,
    );
    expect(c.id).toBe("claude-opus-5-5-high");
    expect(c.name).toBe("Claude Opus 5.5 1M High");
    expect(c.provider).toBe("cursor");
    expect(c.available).toBe(true);
  });

  test("carries a derived context window when one can be inferred", () => {
    const c = toModelChoice({ id: "x", displayName: "Model 1M High" }, false);
    expect(c.contextWindow).toBe(1_000_000);
  });

  test("omits the context window rather than guessing when none is derivable", () => {
    const c = toModelChoice({ id: "composer-2.5", displayName: "Composer 2.5" }, false);
    expect(c.contextWindow).toBeUndefined();
  });

  test("on a Free plan only auto is available", () => {
    const auto = toModelChoice({ id: "auto", displayName: "Auto (default)" }, true);
    expect(auto.available).toBe(true);
    expect(auto.unavailableReason).toBeUndefined();

    const named = toModelChoice({ id: "gpt-5.2", displayName: "GPT-5.2" }, true);
    expect(named.available).toBe(false);
    // The contract's unavailableReason is a fixed union with no member meaning
    // "plan forbids this", so it is deliberately left unset.
    expect(named.unavailableReason).toBeUndefined();
  });

  test("on a paid plan every model is available", () => {
    expect(toModelChoice({ id: "gpt-5.2", displayName: "GPT-5.2" }, false).available).toBe(true);
  });
});

describe("agent identity", () => {
  test("Cursor presents as a single agent", () => {
    // The contract requires an agent id; Cursor has no multi-agent concept, so
    // this is synthesised and must stay stable for view code that keys off it.
    expect(CURSOR_AGENT_ID).toBe("cursor");
  });
});
