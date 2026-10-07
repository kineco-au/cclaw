/**
 * Skills, as Cursor reports them.
 *
 * Cursor discovers skills from `.claude/skills/`, `.cursor/skills/`, `.codex/`
 * and your plugins, then advertises each as a slash command over
 * `available_commands_update`. It tags the description `(user skill)` or
 * `(builtin skill)`, which is the only thing distinguishing a skill from an
 * ordinary command — so that tag is what we classify on rather than scanning
 * the filesystem ourselves and risking a different answer.
 */

export type CommandKind = "user-skill" | "builtin-skill" | "command";

export interface CatalogueEntry {
  name: string;
  description: string;
}

export interface ClassifiedCommand extends CatalogueEntry {
  kind: CommandKind;
  /** The description with the tag removed and trimmed to one line. */
  summary: string;
}

const TAG_RE = /\s*\((user|builtin|project)\s+skill\)\s*$/i;

/**
 * Names Cursor should not be advertising.
 *
 * Deleted plugins leave `.trash-<timestamp>-…` directories that Cursor still
 * indexes, and a synced plugin's directory id becomes part of the name. Both
 * are unusable noise in a completion list.
 */
export function isUsableCommandName(name: string): boolean {
  if (name.trim() === "") return false;
  if (name.startsWith(".")) return false;
  // A 32-hex-and-dashes blob is a directory id, not something anyone types.
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(name)) return false;
  return true;
}

/** Collapse to one line and bound it, keeping whole sentences where possible. */
export function shortDescription(text: string, max = 80): string {
  const line = text.replace(TAG_RE, "").replace(/\s+/gu, " ").trim();
  if (line === "") return "";
  if (line.length <= max) return line;
  // The author's own first sentence beats a truncation, whenever it fits.
  const sentence = line.indexOf(". ");
  if (sentence !== -1 && sentence + 1 <= max) return line.slice(0, sentence + 1);
  const space = line.slice(0, max).lastIndexOf(" ");
  return `${line.slice(0, space > max / 3 ? space : max - 1)}…`;
}

export function classify(entry: CatalogueEntry): ClassifiedCommand {
  const tag = TAG_RE.exec(entry.description)?.[1]?.toLowerCase();
  const kind: CommandKind =
    tag === "user" || tag === "project"
      ? "user-skill"
      : tag === "builtin"
        ? "builtin-skill"
        : "command";
  return { ...entry, kind, summary: shortDescription(entry.description) };
}

/** Classify a catalogue, dropping entries nobody could use. */
export function classifyCatalogue(entries: readonly CatalogueEntry[]): ClassifiedCommand[] {
  return entries.filter((e) => isUsableCommandName(e.name)).map(classify);
}

export function isSkill(c: ClassifiedCommand): boolean {
  return c.kind !== "command";
}

/** Skills only, user-defined first, each group alphabetical. */
export function listSkills(entries: readonly CatalogueEntry[]): ClassifiedCommand[] {
  const skills = classifyCatalogue(entries).filter(isSkill);
  const rank = (c: ClassifiedCommand): number => (c.kind === "user-skill" ? 0 : 1);
  return skills.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
