/**
 * User-defined slash commands: one markdown file per command.
 *
 * `<profile>/commands/review.md` becomes `/review`. The body is a prompt
 * template sent to the agent; optional YAML-ish frontmatter supplies the
 * description and argument hint shown in the autocomplete.
 *
 *   ---
 *   description: review the staged diff
 *   argument-hint: [path]
 *   ---
 *   Review the staged changes in $ARGUMENTS and list only real defects.
 *
 * Frontmatter is parsed with a deliberately small line-based reader rather than
 * a YAML dependency: two scalar keys do not justify one, and a parser that
 * accepts arbitrary YAML would invite files this feature cannot honour.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface UserCommand {
  name: string;
  description: string;
  argumentHint?: string;
  /** The prompt template, with placeholders unexpanded. */
  template: string;
  /** Absolute path, for error messages. */
  path: string;
}

/** Command names must be typeable after a slash and unambiguous. */
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function isValidCommandName(name: string): boolean {
  return NAME_RE.test(name);
}

interface Parsed {
  description: string;
  argumentHint?: string;
  template: string;
}

/** Split frontmatter from the body and read the two keys we support. */
export function parseCommandFile(text: string): Parsed {
  const normalised = text.replace(/\r\n/g, "\n");
  let body = normalised;
  let description = "";
  let argumentHint: string | undefined;

  if (normalised.startsWith("---\n")) {
    const end = normalised.indexOf("\n---", 3);
    if (end !== -1) {
      const block = normalised.slice(4, end + 1);
      body = normalised.slice(end + 4).replace(/^\n/, "");
      for (const line of block.split("\n")) {
        const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
        if (m === null) continue;
        const key = m[1]?.toLowerCase();
        // Quotes are optional; strip a matched pair if present.
        const value = (m[2] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
        if (key === "description") description = value;
        else if (key === "argument-hint" || key === "argumenthint") argumentHint = value;
      }
    }
  }

  return {
    description,
    ...(argumentHint !== undefined && argumentHint !== "" ? { argumentHint } : {}),
    template: body.trim(),
  };
}

/**
 * Substitute arguments into a template.
 *
 * `$ARGUMENTS` takes everything, `$1`…`$9` take positional words. A template
 * with no placeholder gets the arguments appended, so `/review src/x.ts` is
 * useful even when the file's author did not think about arguments.
 */
export function expandTemplate(template: string, arg: string): string {
  const words = arg.trim() === "" ? [] : arg.trim().split(/\s+/);
  const hasArguments = template.includes("$ARGUMENTS");
  const hasPositional = /\$[1-9]/.test(template);

  // An unfilled placeholder takes its preceding space with it, so a template
  // invoked bare reads as a sentence: "Review $ARGUMENTS and list" with no
  // argument becomes "Review and list", not "Review  and list".
  const trimmed = arg.trim();
  let out =
    trimmed === ""
      ? template.replace(/[ \t]*\$ARGUMENTS/g, "")
      : template.replaceAll("$ARGUMENTS", trimmed);
  out = out.replace(/[ \t]*\$([1-9])/g, (whole, d: string) => {
    const word = words[Number.parseInt(d, 10) - 1];
    if (word !== undefined) return whole.replace(`$${d}`, word);
    return "";
  });

  if (!hasArguments && !hasPositional && arg.trim() !== "") {
    out = `${out}\n\n${arg.trim()}`;
  }
  return out.trim();
}

/**
 * Load every command file in a directory. A missing directory is not an error:
 * the feature is opt-in by creating files.
 */
export async function loadUserCommands(dir: string): Promise<UserCommand[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: UserCommand[] = [];
  for (const file of names.sort()) {
    if (!file.endsWith(".md")) continue;
    const name = file.slice(0, -3).toLowerCase();
    if (!isValidCommandName(name)) continue;
    const path = join(dir, file);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const parsed = parseCommandFile(text);
    // A file with no body has no prompt to send, so it is not a command.
    if (parsed.template === "") continue;
    out.push({
      name,
      description: parsed.description === "" ? `custom: ${name}` : parsed.description,
      ...(parsed.argumentHint !== undefined ? { argumentHint: parsed.argumentHint } : {}),
      template: parsed.template,
      path,
    });
  }
  return out;
}
