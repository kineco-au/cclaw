/**
 * PORTED FROM OpenClaw: src/shared/regexp.ts (MIT) - commit in PROVENANCE.md
 */

/** Escape text so it can be embedded literally inside a RegExp pattern. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
