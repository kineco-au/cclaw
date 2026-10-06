/** `cclaw profile …` */

import { join } from "node:path";
import { PROJECTS_PATH_LIMIT, profilePaths, resolvePaths } from "../env.ts";
import {
  createProfile,
  defaultProfile,
  launchEnv,
  listProfiles,
  readProfileMeta,
  setDefaultProfile,
  type CredMode,
} from "../profile.ts";
import {
  fileClear,
  fileSet,
  getKey,
  keychainAvailable,
  keychainClear,
  keychainSet,
  repairFileMode,
  validateKey,
} from "../creds.ts";
import { resolveCursorBinary } from "../cursor.ts";
import { createStyler } from "../ui/style.ts";

export async function profileCommand(args: string[]): Promise<number> {
  const s = createStyler();
  const paths = resolvePaths();
  const [sub, ...rest] = args;

  switch (sub) {
    case undefined:
    case "list": {
      const names = await listProfiles(paths);
      const def = await defaultProfile(paths);
      if (names.length === 0) {
        process.stdout.write(`no profiles yet. Run ${s.bold("cclaw setup")}\n`);
        return 0;
      }
      for (const n of names) {
        const meta = await readProfileMeta(profilePaths(paths, n));
        const mark = n === def ? s.green("*") : " ";
        process.stdout.write(`${mark} ${n.padEnd(18)} ${s.dim(meta?.credMode ?? "inherit")}\n`);
      }
      return 0;
    }

    case "create": {
      const name = rest[0];
      if (name === undefined) {
        process.stderr.write(
          "usage: cclaw profile create <name> [--cred keychain|file] [--import-from <dir>]\n",
        );
        return 2;
      }
      let cred: CredMode = "inherit";
      let importFrom: string | undefined;
      for (let i = 1; i < rest.length; i++) {
        if (rest[i] === "--cred" && rest[i + 1] !== undefined) {
          const v = rest[i + 1];
          if (v === "keychain" || v === "file" || v === "inherit") cred = v;
          i++;
        } else if (rest[i] === "--import-from" && rest[i + 1] !== undefined) {
          importFrom = rest[i + 1];
          i++;
        }
      }
      try {
        const pp = await createProfile(paths, name, {
          credMode: cred,
          ...(importFrom !== undefined ? { importFrom } : {}),
        });
        process.stdout.write(`${s.green("created")} profile '${name}' at ${pp.dir}\n`);
        const projects = join(pp.cursorDataDir, "projects");
        if (projects.length > PROJECTS_PATH_LIMIT) {
          process.stdout.write(
            s.yellow(
              `warning: data path is ${projects.length} chars, over Cursor's ${PROJECTS_PATH_LIMIT} limit;\n` +
                `Cursor will silently relocate its projects dir. Use a shorter name or CCLAW_HOME.\n`,
            ),
          );
        }
        return 0;
      } catch (err) {
        process.stderr.write(
          `${s.red("error")} ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return 1;
      }
    }

    case "use": {
      const name = rest[0];
      if (name === undefined) {
        process.stderr.write("usage: cclaw profile use <name>\n");
        return 2;
      }
      const names = await listProfiles(paths);
      if (!names.includes(name)) {
        process.stderr.write(`${s.red("error")} no such profile: ${name}\n`);
        return 1;
      }
      await setDefaultProfile(paths, name);
      process.stdout.write(`${s.green("ok")} default profile is now '${name}'\n`);
      return 0;
    }

    case "show": {
      const name = rest[0] ?? (await defaultProfile(paths));
      const pp = profilePaths(paths, name);
      const meta = await readProfileMeta(pp);
      if (meta === null) {
        process.stderr.write(`${s.red("error")} no such profile: ${name}\n`);
        return 1;
      }
      process.stdout.write(`${s.bold(name)}\n`);
      process.stdout.write(`  created   ${meta.createdAt}\n`);
      process.stdout.write(`  identity  ${meta.credMode}\n`);
      if (meta.credMode === "inherit") {
        process.stdout.write(
          s.yellow(
            "            this profile uses the machine-wide Cursor login.\n" +
              "            On macOS that is a single global keychain slot, so every\n" +
              "            'inherit' profile shares one identity. Attach an API key\n" +
              "            (cclaw profile cred set) for a genuinely separate identity.\n",
          ),
        );
      }
      process.stdout.write(`\n  ${s.dim("environment exported on launch:")}\n`);
      for (const [k, v] of Object.entries(launchEnv(pp, paths))) {
        process.stdout.write(`    ${k}=${v}\n`);
      }
      return 0;
    }

    case "delete": {
      const name = rest[0];
      const purge = rest.includes("--purge");
      if (name === undefined) {
        process.stderr.write("usage: cclaw profile delete <name> [--purge]\n");
        return 2;
      }
      if (name === (await defaultProfile(paths))) {
        process.stderr.write(
          `${s.red("error")} '${name}' is the default profile; set another first (cclaw profile use <name>)\n`,
        );
        return 1;
      }
      const pp = profilePaths(paths, name);
      if ((await readProfileMeta(pp)) === null) {
        process.stderr.write(`${s.red("error")} no such profile: ${name}\n`);
        return 1;
      }
      if (purge) {
        await keychainClear(name);
        await fileClear(join(pp.dir, "credentials"));
      }
      const { rm } = await import("node:fs/promises");
      await rm(pp.dir, { recursive: true, force: true });
      process.stdout.write(
        `${s.green("ok")} deleted profile '${name}'${purge ? " and its credentials" : ""}\n`,
      );
      return 0;
    }

    case "cred": {
      const action = rest[0];
      const name = rest[1] ?? (await defaultProfile(paths));
      const pp = profilePaths(paths, name);
      const credsPath = join(pp.dir, "credentials");

      if (action === "clear") {
        await keychainClear(name);
        await fileClear(credsPath);
        process.stdout.write(
          `${s.green("ok")} cleared credentials for '${name}' (now inheriting the shared login)\n`,
        );
        return 0;
      }
      if (action === "test") {
        const meta = await readProfileMeta(pp);
        const bin = await resolveCursorBinary();
        if (bin === null) {
          process.stderr.write(`${s.red("error")} Cursor CLI not found\n`);
          return 1;
        }
        const key = await getKey({ mode: meta?.credMode ?? "inherit", profile: name, credsPath });
        if (key === null) {
          process.stdout.write(`'${name}' has no key of its own; it uses the shared login\n`);
          return 0;
        }
        const res = await validateKey(key, bin.path);
        process.stdout.write(
          res.ok
            ? `${s.green("ok")} key valid for ${res.email ?? "unknown account"}\n`
            : `${s.red("fail")} key rejected by Cursor\n`,
        );
        return res.ok ? 0 : 1;
      }
      if (action === "set") {
        if (process.stdin.isTTY === true) {
          process.stderr.write(
            'pipe the key in, so it never lands in your shell history:\n  printf %s "$KEY" | cclaw profile cred set ' +
              `${name}\n`,
          );
          return 2;
        }
        const key = (await new Response(Bun.stdin.stream()).text()).trim();
        if (key === "") {
          process.stderr.write(`${s.red("error")} no key on stdin\n`);
          return 2;
        }
        const useKeychain = keychainAvailable();
        const stored = useKeychain ? await keychainSet(name, key) : false;
        if (!stored) await fileSet(credsPath, key);
        const mode: CredMode = stored ? "keychain" : "file";
        const { readFile, writeFile } = await import("node:fs/promises");
        const meta = JSON.parse(await readFile(pp.profileFile, "utf8")) as Record<string, unknown>;
        meta.credMode = mode;
        await writeFile(pp.profileFile, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
        await repairFileMode(credsPath);
        process.stdout.write(`${s.green("ok")} stored key for '${name}' (${mode})\n`);
        return 0;
      }
      process.stderr.write("usage: cclaw profile cred set|clear|test [<name>]\n");
      return 2;
    }

    default:
      process.stderr.write(`unknown subcommand: profile ${sub}\n`);
      return 2;
  }
}
