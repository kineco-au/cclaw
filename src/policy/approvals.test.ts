import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalStore, grantKey, isExpired, normaliseArgv } from "./approvals.ts";

async function store(sessionId?: string): Promise<ApprovalStore> {
  const dir = await mkdtemp(join(tmpdir(), "cclaw-appr-"));
  return new ApprovalStore({
    grantsFile: join(dir, "grants.json"),
    runDir: join(dir, "run"),
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
}

describe("grantKey", () => {
  test("the same command, argv and cwd produce the same key", () => {
    const a = grantKey({ command: "aws", argv: "aws s3 ls", cwd: "/repo" });
    const b = grantKey({ command: "aws", argv: "aws s3 ls", cwd: "/repo" });
    expect(a).toBe(b);
  });

  test("different argv produces a different key, so a grant cannot widen", () => {
    const ls = grantKey({ command: "aws", argv: "aws s3 ls", cwd: "/repo" });
    const rm = grantKey({ command: "aws", argv: "aws s3 rm s3://x", cwd: "/repo" });
    expect(ls).not.toBe(rm);
  });

  test("different cwd produces a different key, so a grant cannot leak across repos", () => {
    const a = grantKey({ command: "aws", argv: "aws s3 ls", cwd: "/repo-a" });
    const b = grantKey({ command: "aws", argv: "aws s3 ls", cwd: "/repo-b" });
    expect(a).not.toBe(b);
  });

  test("cosmetic whitespace differences do not defeat a grant", () => {
    const a = grantKey({ command: "aws", argv: "aws   s3  ls", cwd: "/repo" });
    const b = grantKey({ command: "aws", argv: "aws s3 ls", cwd: "/repo" });
    expect(a).toBe(b);
  });

  test("a name-level grant differs from an argv-level one", () => {
    const name = grantKey({ command: "aws", cwd: "/repo" });
    const exact = grantKey({ command: "aws", argv: "aws s3 ls", cwd: "/repo" });
    expect(name).not.toBe(exact);
  });
});

describe("normaliseArgv", () => {
  test("collapses whitespace and treats blank as absent", () => {
    expect(normaliseArgv("a   b")).toBe("a b");
    expect(normaliseArgv("   ")).toBeUndefined();
    expect(normaliseArgv(undefined)).toBeUndefined();
  });
});

describe("isExpired", () => {
  test("a grant with no expiry never expires", () => {
    expect(isExpired({ command: "x", grantedAt: "now" })).toBe(false);
  });

  test("respects the expiry instant", () => {
    const rec = { command: "x", grantedAt: "", expiresAt: "2026-01-01T00:00:00.000Z" };
    expect(isExpired(rec, new Date("2025-12-31T23:59:59Z"))).toBe(false);
    expect(isExpired(rec, new Date("2026-01-02T00:00:00Z"))).toBe(true);
  });

  test("an unparseable expiry is treated as no expiry rather than as expired", () => {
    expect(isExpired({ command: "x", grantedAt: "", expiresAt: "nonsense" })).toBe(false);
  });
});

describe("ApprovalStore", () => {
  let s: ApprovalStore;
  const req = { command: "aws", argv: "aws s3 ls", cwd: "/repo" };

  beforeEach(async () => {
    s = await store("sess-1");
  });

  test("nothing is granted by default", async () => {
    expect(await s.lookup(req)).toBeNull();
  });

  test("a profile grant is found", async () => {
    await s.grant({ ...req, scope: "profile" });
    expect(await s.lookup(req)).toEqual({ scope: "profile" });
  });

  test("a session grant is found and is distinguishable from a profile grant", async () => {
    await s.grant({ ...req, scope: "session" });
    expect(await s.lookup(req)).toEqual({ scope: "session" });
  });

  test("a grant does not widen to different arguments", async () => {
    await s.grant({ ...req, scope: "profile" });
    expect(await s.lookup({ command: "aws", argv: "aws s3 rm s3://x", cwd: "/repo" })).toBeNull();
  });

  test("a grant does not leak into another directory", async () => {
    await s.grant({ ...req, scope: "profile" });
    expect(await s.lookup({ ...req, cwd: "/elsewhere" })).toBeNull();
  });

  test("a name-level grant covers any arguments in that directory", async () => {
    await s.grant({ command: "aws", cwd: "/repo", scope: "profile" });
    expect(await s.lookup({ command: "aws", argv: "aws s3 rm s3://x", cwd: "/repo" })).toEqual({
      scope: "profile",
    });
  });

  test("clearing the session removes session grants but keeps profile grants", async () => {
    await s.grant({ ...req, scope: "session" });
    await s.grant({ command: "kubectl", cwd: "/repo", scope: "profile" });
    await s.clearSession();
    expect(await s.lookup(req)).toBeNull();
    expect(await s.lookup({ command: "kubectl", cwd: "/repo" })).toEqual({ scope: "profile" });
  });

  test("a block beats a grant", async () => {
    await s.grant({ ...req, scope: "profile" });
    await s.block("aws");
    expect(await s.lookup(req)).toEqual({ scope: "never" });
  });

  test("granting after a block lifts the block", async () => {
    await s.block("aws");
    await s.grant({ ...req, scope: "profile" });
    expect(await s.lookup(req)).toEqual({ scope: "profile" });
  });

  test("revoke removes both grants and blocks", async () => {
    await s.grant({ ...req, scope: "profile" });
    await s.revoke("aws");
    expect(await s.lookup(req)).toBeNull();
    await s.block("aws");
    await s.revoke("aws");
    expect(await s.lookup(req)).toBeNull();
  });

  test("an expired standing grant is ignored", async () => {
    await s.grant({ ...req, scope: "profile", expiresInDays: -1 });
    expect(await s.lookup(req)).toBeNull();
    const listed = await s.list();
    expect(listed.profile).toHaveLength(0);
    expect(listed.expired).toHaveLength(1);
  });

  test("an unexpired standing grant is honoured", async () => {
    await s.grant({ ...req, scope: "profile", expiresInDays: 7 });
    expect(await s.lookup(req)).toEqual({ scope: "profile" });
  });

  test("list reports each scope separately", async () => {
    await s.grant({ ...req, scope: "profile" });
    await s.grant({ command: "kubectl", argv: "kubectl get pods", cwd: "/repo", scope: "session" });
    await s.block("terraform");
    const listed = await s.list();
    expect(listed.profile.map((g) => g.command)).toEqual(["aws"]);
    expect(listed.session.map((g) => g.command)).toEqual(["kubectl"]);
    expect(listed.never).toEqual(["terraform"]);
  });

  test("a session grant without a session id is refused rather than silently global", async () => {
    const noSession = await store();
    await expect(noSession.grant({ ...req, scope: "session" })).rejects.toThrow(/session id/);
  });

  test("pruneSessions removes files for sessions that are gone", async () => {
    await s.grant({ ...req, scope: "session" });
    expect(await s.pruneSessions(["sess-1"])).toBe(0);
    expect(await s.lookup(req)).toEqual({ scope: "session" });
    expect(await s.pruneSessions([])).toBe(1);
    expect(await s.lookup(req)).toBeNull();
  });
});
