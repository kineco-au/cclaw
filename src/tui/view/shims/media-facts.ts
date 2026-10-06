/**
 * ADAPTER for OpenClaw's src/media/media-facts.ts.
 *
 * Upstream reads "media facts" that OpenClaw's gateway persists alongside a
 * message, so images dropped from the content array can still be rendered.
 * It is 521 lines and depends on the @openclaw/media-core package.
 *
 * Cursor's ACP stream carries images inline in the content blocks and persists
 * no such sidecar, so there are never any facts to read. `readPersistedMediaFacts`
 * therefore returns undefined — truthfully, rather than fabricating entries —
 * and the ported `tui-images.ts` falls back to the inline content path, which
 * is the one that actually has data.
 *
 * `isImageMediaFact` is kept functional so this stays correct if a future
 * backend does supply facts.
 */

export type MediaFact = {
  url?: string;
  path?: string;
  mimeType?: string;
  kind?: string;
};

export type MediaFactInput = MediaFact;

/** Always undefined for an ACP backend: Cursor persists no media-fact sidecar. */
export function readPersistedMediaFacts(_message: object): MediaFact[] | undefined {
  return undefined;
}

export function isImageMediaFact(fact: MediaFactInput): boolean {
  if (typeof fact.mimeType === "string" && fact.mimeType.startsWith("image/")) return true;
  if (fact.kind === "image") return true;
  const target = fact.url ?? fact.path;
  if (typeof target !== "string") return false;
  return /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)(\?|#|$)/i.test(target);
}
