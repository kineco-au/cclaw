/** `cclaw model …` — curate which models a profile may use, and pick the active one. */

import { readFile, rename, writeFile } from "node:fs/promises";
import { profilePaths, resolvePaths } from "../env.ts";
import { defaultProfile, ensureProfile } from "../profile.ts";
import { cursorAbout, resolveCursorBinary } from "../cursor.ts";
import {
  derivedContextWindow,
  fetchCatalogue,
  humaniseTokens,
  type ModelEntry,
} from "../models.ts";
import { createStyler } from "../ui/style.ts";

interface ModelsFile {
  version: 1;
  active: string | null;
  allow: string[];
  refreshedAt: string | null;
  catalogue?: ModelEntry[];
}

async function readModels(path: string): Promise<ModelsFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed !== null && typeof parsed === "object") {
      const f = parsed as Partial<ModelsFile>;
      return {
        version: 1,
        active: f.active ?? null,
        allow: Array.isArray(f.allow)
          ? f.allow.filter((x): x is string => typeof x === "string")
          : [],
        refreshedAt: f.refreshedAt ?? null,
        ...(Array.isArray(f.catalogue) ? { catalogue: f.catalogue } : {}),
      };
    }
  } catch {
    // fall through
  }
  return { version: 1, active: null, allow: [], refreshedAt: null };
}

async function writeModels(path: string, value: ModelsFile): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, path);
}

/**
 * Parse a selection spec: `1,3,5-8`, `all`, `none`, `+claude*`, `-grok*`.
 * Returns the resulting id list.
 */
export function applySelectionSpec(
  spec: string,
  catalogue: readonly ModelEntry[],
  current: readonly string[],
): string[] {
  const ids = catalogue.map((m) => m.id);
  const out = new Set(current);
  for (const rawToken of spec.split(/[\s,]+/).filter((t) => t !== "")) {
    const token = rawToken.trim();
    if (token === "all") {
      for (const id of ids) out.add(id);
      continue;
    }
    if (token === "none") {
      out.clear();
      continue;
    }
    const sign = token.startsWith("+") ? 1 : token.startsWith("-") ? -1 : 0;
    const body = sign === 0 ? token : token.slice(1);
    const range = /^(\d+)-(\d+)$/.exec(body);
    if (range?.[1] !== undefined && range[2] !== undefined) {
      const from = Number.parseInt(range[1], 10);
      const to = Number.parseInt(range[2], 10);
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
        const id = ids[i - 1];
        if (id !== undefined) sign === -1 ? out.delete(id) : out.add(id);
      }
      continue;
    }
    if (/^\d+$/.test(body)) {
      const id = ids[Number.parseInt(body, 10) - 1];
      if (id !== undefined) sign === -1 ? out.delete(id) : out.add(id);
      continue;
    }
    if (/[*?]/.test(body)) {
      const re = new RegExp(
        `^${body
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".")}$`,
      );
      for (const id of ids.filter((i) => re.test(i))) {
        if (sign === -1) out.delete(id);
        else out.add(id);
      }
      continue;
    }
    if (ids.includes(body)) sign === -1 ? out.delete(body) : out.add(body);
  }
  // Keep catalogue order, and always keep `auto`: on a Free plan it is the only
  // model that works, so losing it would leave the profile unusable.
  const result = ids.filter((id) => out.has(id));
  if (ids.includes("auto") && !result.includes("auto")) result.unshift("auto");
  return result;
}

export async function modelCommand(args: string[], profileArg?: string): Promise<number> {
  const s = createStyler();
  const paths = resolvePaths();
  const name = profileArg ?? (await defaultProfile(paths));
  const { pp } = await ensureProfile(paths, name);
  const modelsPath = profilePaths(paths, name).modelsFile;
  const file = await readModels(modelsPath);
  const [sub, ...rest] = args;

  const bin = await resolveCursorBinary();
  if (bin === null) {
    process.stderr.write(`${s.red("error")} Cursor CLI not found\n`);
    return 1;
  }

  const refresh = async (): Promise<ModelEntry[]> => {
    const cat = await fetchCatalogue(bin.path);
    if (!cat.usable) {
      // Never clobber a good cache with an empty parse.
      process.stderr.write(s.yellow("warning: could not parse the model catalogue; using cache\n"));
      return file.catalogue ?? [];
    }
    file.catalogue = cat.models;
    file.refreshedAt = new Date().toISOString();
    await writeModels(modelsPath, file);
    return cat.models;
  };

  switch (sub) {
    case undefined:
    case "list": {
      const showAll = rest.includes("--all");
      const catalogue =
        rest.includes("--refresh") || file.catalogue === undefined
          ? await refresh()
          : file.catalogue;
      const about = await cursorAbout(bin.path);
      const free = /free/i.test(about?.subscriptionTier ?? "");
      const shown =
        showAll || file.allow.length === 0
          ? catalogue
          : catalogue.filter((m) => file.allow.includes(m.id));

      if (free) {
        process.stdout.write(
          s.yellow(`plan: ${about?.subscriptionTier ?? "Free"} — only 'auto' can actually run\n\n`),
        );
      }
      shown.forEach((m, i) => {
        const idx = String(catalogue.indexOf(m) + 1).padStart(3);
        const active = m.id === (file.active ?? "") ? s.green("*") : " ";
        const curated = file.allow.includes(m.id) ? "" : s.dim(" (not curated)");
        const ctx = derivedContextWindow(m.id, m.displayName);
        const ctxLabel = ctx > 0 ? s.dim(` ${humaniseTokens(ctx)}`) : "";
        const usable = free && m.id !== "auto" ? s.dim(" [plan]") : "";
        process.stdout.write(
          `${active}${idx}. ${m.id.padEnd(34)} ${m.displayName}${ctxLabel}${usable}${curated}\n`,
        );
        void i;
      });
      process.stdout.write(
        `\n${s.dim(`${shown.length} shown of ${catalogue.length}; curated: ${file.allow.length || "all"}`)}\n`,
      );
      return 0;
    }

    case "config": {
      const spec = rest.join(" ").trim();
      const catalogue = file.catalogue ?? (await refresh());
      if (spec === "") {
        process.stdout.write(
          "pass a selection spec, e.g.\n" +
            "  cclaw model config 1,3,5-8      pick by index (see cclaw model list --all)\n" +
            "  cclaw model config +claude*     add every id matching a glob\n" +
            "  cclaw model config -grok*       remove matching ids\n" +
            "  cclaw model config all | none\n",
        );
        return 2;
      }
      file.allow = applySelectionSpec(spec, catalogue, file.allow);
      if (file.active !== null && !file.allow.includes(file.active)) file.active = null;
      await writeModels(modelsPath, file);
      process.stdout.write(`${s.green("ok")} curated ${file.allow.length} model(s)\n`);
      for (const id of file.allow) process.stdout.write(`  ${id}\n`);
      return 0;
    }

    case "use": {
      const want = rest[0];
      if (want === undefined) {
        process.stderr.write("usage: cclaw model use <id|index>\n");
        return 2;
      }
      const catalogue = file.catalogue ?? (await refresh());
      const byIndex = /^\d+$/.test(want) ? catalogue[Number.parseInt(want, 10) - 1] : undefined;
      const chosen = byIndex?.id ?? want;
      if (!catalogue.some((m) => m.id === chosen)) {
        process.stderr.write(`${s.red("error")} unknown model: ${chosen}\n`);
        return 1;
      }
      if (file.allow.length > 0 && !file.allow.includes(chosen)) {
        process.stderr.write(
          `${s.red("error")} '${chosen}' is not curated for this profile; add it with: cclaw model config +${chosen}\n`,
        );
        return 1;
      }
      const entry = catalogue.find((m) => m.id === chosen);
      file.active = chosen;
      await writeModels(modelsPath, file);

      // Write Cursor's own shape so its TUI and ACP sessions both pick it up.
      const cfgPath = `${pp.cursorConfigDir}/cli-config.json`;
      let cfg: Record<string, unknown> = {};
      try {
        cfg = JSON.parse(await readFile(cfgPath, "utf8")) as Record<string, unknown>;
      } catch {
        cfg = { version: 1 };
      }
      cfg.model = {
        modelId: chosen,
        displayModelId: chosen,
        displayName: entry?.displayName ?? chosen,
        displayNameShort: entry?.displayName ?? chosen,
        aliases: [],
        maxMode: false,
      };
      cfg.selectedModel = { modelId: chosen, parameters: [] };
      cfg.hasChangedDefaultModel = true;
      const history = Array.isArray(cfg.modelSelectionHistory) ? cfg.modelSelectionHistory : [];
      cfg.modelSelectionHistory = [chosen, ...history.filter((h) => h !== chosen)].slice(0, 32);
      const tmp = `${cfgPath}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
      await rename(tmp, cfgPath);

      process.stdout.write(`${s.green("ok")} active model for '${name}' is ${chosen}\n`);
      return 0;
    }

    case "info": {
      const want = rest[0] ?? file.active;
      if (want === undefined || want === null) {
        process.stderr.write("usage: cclaw model info [<id>]\n");
        return 2;
      }
      const catalogue = file.catalogue ?? (await refresh());
      const entry = catalogue.find((m) => m.id === want);
      if (entry === undefined) {
        process.stderr.write(`${s.red("error")} unknown model: ${want}\n`);
        return 1;
      }
      const ctx = derivedContextWindow(entry.id, entry.displayName);
      process.stdout.write(`${s.bold(entry.id)}\n  name     ${entry.displayName}\n`);
      process.stdout.write(
        `  context  ${
          ctx > 0
            ? `${humaniseTokens(ctx)} ${s.dim("(derived from the model name; Cursor publishes no figure)")}`
            : s.dim("unknown — Cursor publishes no context window and none could be derived")
        }\n`,
      );
      process.stdout.write(
        `  usage    ${s.dim("live token usage is only available in `cclaw raw`, via Cursor's status line")}\n`,
      );
      return 0;
    }

    default:
      process.stderr.write(`unknown subcommand: model ${sub}\n`);
      return 2;
  }
}
