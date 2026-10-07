import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isConfigWriterLine, seedPolicyFile } from "./seed.ts";

const enforce = { version: 1, approvalMode: "allowlist" };

async function tmp(): Promise<{ dir: string; path: string; backups: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cclaw-seed-"));
  return { dir, path: join(dir, "cli-config.json"), backups: join(dir, "backups") };
}

/**
 * Real `ps -Ao pid=,command=` lines observed on macOS while driving Cursor.
 * This guard silently never fired once because macOS pgrep lacks -a and
 * returned bare PIDs, so the shapes are pinned here.
 */
describe("isConfigWriterLine", () => {
  test("detects a live agent that could rewrite the config", () => {
    expect(
      isConfigWriterLine(
        "40983 /Users/adam/.local/share/cursor-agent/versions/2026.08.11-e8db854/node /Users/adam/.local/share/cursor-agent/versions/2026.08.11-e8db854/index.js acp",
      ),
    ).toBe(true);
    expect(isConfigWriterLine("123 /Users/adam/.local/bin/cursor-agent")).toBe(true);
    expect(isConfigWriterLine("124 /Users/x/.local/bin/agent acp")).toBe(true);
  });

  test("ignores unrelated binaries called 'agent'", () => {
    // These made setup report a running Cursor agent on machines that had
    // none, which failed the install.
    for (const line of [
      "501 /opt/datadog-agent/bin/agent/agent run",
      "502 /usr/local/bin/agent --config /etc/foo.yml",
      "503 /opt/buildkite-agent/bin/agent start",
      "504 /Applications/Xcode.app/Contents/Developer/usr/bin/agent",
      "505 /usr/bin/ssh-agent -l",
      "506 /opt/azure/agent listen",
    ]) {
      expect(isConfigWriterLine(line)).toBe(false);
    }
  });

  test("ignores Cursor's long-lived worker helpers, which do not write the config", () => {
    expect(
      isConfigWriterLine(
        "82329 /Users/adam/.local/share/cursor-agent/versions/2026.08.11-e8db854/node /Users/adam/.local/share/cursor-agent/versions/2026.08.11-e8db854/index.js worker-server",
      ),
    ).toBe(false);
  });

  test("ignores bare PIDs, the shape that made this silently always-false", () => {
    expect(isConfigWriterLine("13704")).toBe(false);
    expect(isConfigWriterLine("  90620  ")).toBe(false);
  });

  test("ignores unrelated processes and blank lines", () => {
    expect(isConfigWriterLine("500 /usr/bin/vim notes.txt")).toBe(false);
    expect(isConfigWriterLine("")).toBe(false);
    expect(isConfigWriterLine("   ")).toBe(false);
  });

  test("ignores our own process, so we never block on ourselves", () => {
    expect(isConfigWriterLine("777 /usr/local/bin/cursor-agent", 777)).toBe(false);
    expect(isConfigWriterLine("778 /usr/local/bin/cursor-agent", 777)).toBe(true);
  });
});

describe("seedPolicyFile", () => {
  test("creates the file when absent", async () => {
    const t = await tmp();
    const r = await seedPolicyFile({ ...t, enforce, backupsDir: t.backups, skipAgentCheck: true });
    expect(r.status).toBe("written");
    const written = JSON.parse(await readFile(t.path, "utf8")) as Record<string, unknown>;
    expect(written.approvalMode).toBe("allowlist");
  });

  test("is idempotent: a second seed reports unchanged and writes nothing", async () => {
    const t = await tmp();
    await seedPolicyFile({ ...t, enforce, backupsDir: t.backups, skipAgentCheck: true });
    const before = await readFile(t.path, "utf8");
    const r = await seedPolicyFile({ ...t, enforce, backupsDir: t.backups, skipAgentCheck: true });
    expect(r.status).toBe("unchanged");
    expect(await readFile(t.path, "utf8")).toBe(before);
  });

  test("preserves the user's own keys and backs up before changing", async () => {
    const t = await tmp();
    await writeFile(t.path, JSON.stringify({ version: 1, myKey: "keep", hints: false }));
    const r = await seedPolicyFile({ ...t, enforce, backupsDir: t.backups, skipAgentCheck: true });
    expect(r.status).toBe("written");
    if (r.status === "written") expect(r.backup).toBeDefined();
    const after = JSON.parse(await readFile(t.path, "utf8")) as Record<string, unknown>;
    expect(after.myKey).toBe("keep");
    expect(after.hints).toBe(false);
    expect(after.approvalMode).toBe("allowlist");
  });

  test("refuses to touch invalid JSON rather than clobbering it", async () => {
    const t = await tmp();
    await writeFile(t.path, "{ not valid json");
    const r = await seedPolicyFile({ ...t, enforce, backupsDir: t.backups, skipAgentCheck: true });
    expect(r.status).toBe("refused");
    // The original bytes must survive untouched.
    expect(await readFile(t.path, "utf8")).toBe("{ not valid json");
  });

  test("treats an empty file as absent rather than invalid", async () => {
    const t = await tmp();
    await writeFile(t.path, "");
    const r = await seedPolicyFile({ ...t, enforce, backupsDir: t.backups, skipAgentCheck: true });
    expect(r.status).toBe("written");
  });

  test("refuses a JSON array, since the config must be an object", async () => {
    const t = await tmp();
    await writeFile(t.path, "[1,2,3]");
    const r = await seedPolicyFile({ ...t, enforce, backupsDir: t.backups, skipAgentCheck: true });
    expect(r.status).toBe("refused");
  });
});

describe("seedPolicyFile with an agent running", () => {
  const busy = async (): Promise<string | null> => "999 /Users/x/.local/bin/cursor-agent acp";

  test("an already-seeded profile reports unchanged, not a problem", async () => {
    // The reported bug: re-running setup on an existing profile failed the
    // install even though there was nothing to write.
    const t = await tmp();
    await seedPolicyFile({ ...t, enforce, backupsDir: t.backups, skipAgentCheck: true });
    const r = await seedPolicyFile({
      ...t,
      enforce,
      backupsDir: t.backups,
      findConfigWriter: busy,
    });
    expect(r.status).toBe("unchanged");
  });

  test("a needed write defers rather than refusing, and leaves the file alone", async () => {
    const t = await tmp();
    await writeFile(t.path, JSON.stringify({ approvalMode: "full" }));
    const r = await seedPolicyFile({
      ...t,
      enforce,
      backupsDir: t.backups,
      findConfigWriter: busy,
    });
    expect(r.status).toBe("deferred");
    expect(JSON.parse(await readFile(t.path, "utf8"))).toEqual({ approvalMode: "full" });
  });

  test("the deferral names the process it detected", async () => {
    const t = await tmp();
    await writeFile(t.path, JSON.stringify({ approvalMode: "full" }));
    const r = await seedPolicyFile({
      ...t,
      enforce,
      backupsDir: t.backups,
      findConfigWriter: busy,
    });
    expect(r.status === "deferred" && r.reason).toContain("cursor-agent");
  });

  test("writes normally when no agent is found", async () => {
    const t = await tmp();
    const r = await seedPolicyFile({
      ...t,
      enforce,
      backupsDir: t.backups,
      findConfigWriter: async () => null,
    });
    expect(r.status).toBe("written");
  });
});
