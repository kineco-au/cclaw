import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { ApprovalStore } from "./approvals.ts";
import { commandFromRequest, createPermissionResolver, type AskChoiceKind } from "./resolver.ts";

/** Cursor's real option set, observed from a live ACP permission request. */
const CURSOR_OPTIONS = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
];

function request(command: string): RequestPermissionRequest {
  return {
    sessionId: "s1",
    toolCall: { title: `\`${command}\``, rawInput: { command } },
    options: CURSOR_OPTIONS,
  } as unknown as RequestPermissionRequest;
}

async function store(withSession = true): Promise<ApprovalStore> {
  const dir = await mkdtemp(join(tmpdir(), "cclaw-res-"));
  return new ApprovalStore({
    grantsFile: join(dir, "grants.json"),
    runDir: join(dir, "run"),
    ...(withSession ? { sessionId: "sess-1" } : {}),
  });
}

interface Harness {
  resolve: (cmd: string) => Promise<{ kind: string; optionId?: string }>;
  asked: { choices: { kind: AskChoiceKind; label: string }[] }[];
  notices: string[];
  store: ApprovalStore;
}

async function harness(
  answer: AskChoiceKind | null,
  opts: { withSession?: boolean; sensitive?: string[] } = {},
): Promise<Harness> {
  const s = await store(opts.withSession ?? true);
  const asked: Harness["asked"] = [];
  const notices: string[] = [];
  const resolver = createPermissionResolver({
    mode: "ask",
    allow: ["ls"],
    cwd: "/repo",
    store: s,
    sensitive: opts.sensitive ?? ["aws"],
    onNotice: (t) => notices.push(t),
    askUser: async (ctx) => {
      asked.push({ choices: ctx.choices });
      return answer;
    },
  });
  return {
    resolve: async (cmd) => (await resolver(request(cmd))) as { kind: string; optionId?: string },
    asked,
    notices,
    store: s,
  };
}

describe("the permission prompt's choices", () => {
  test("offers once, session, always and reject for a sensitive command", async () => {
    const h = await harness("reject");
    await h.resolve("aws --version");
    expect(h.asked[0]?.choices.map((c) => c.kind)).toEqual(["once", "session", "always", "reject"]);
  });

  test("labels say plainly what each one does", async () => {
    const h = await harness("reject");
    await h.resolve("aws --version");
    const byKind = new Map(h.asked[0]?.choices.map((c) => [c.kind, c.label]));
    expect(byKind.get("session")).toBe("Allow this session");
    expect(byKind.get("always")).toBe("Allow always");
  });

  test("omits the session choice when no session is available to scope it to", async () => {
    const h = await harness("reject", { withSession: false });
    await h.resolve("aws --version");
    expect(h.asked[0]?.choices.map((c) => c.kind)).toEqual(["once", "always", "reject"]);
  });
});

describe("what each choice records", () => {
  test("'always' records a permanent grant", async () => {
    const h = await harness("always");
    await h.resolve("aws --version");
    expect(await h.store.lookup({ command: "aws", cwd: "/repo" })).toEqual({ scope: "profile" });
    expect(h.notices.join()).toContain("permanently");
  });

  test("'always' asks Cursor to remember it too", async () => {
    const h = await harness("always");
    const verdict = await h.resolve("aws --version");
    expect(verdict).toEqual({ kind: "allow", optionId: "allow-always" });
  });

  test("'session' records a session grant only", async () => {
    const h = await harness("session");
    await h.resolve("aws --version");
    expect(await h.store.lookup({ command: "aws", cwd: "/repo" })).toEqual({ scope: "session" });
    expect(h.notices.join()).toContain("this session");
  });

  test("'session' authorises only this invocation with Cursor", async () => {
    // Our own grant covers the repeat; Cursor must not be told "always".
    const h = await harness("session");
    expect(await h.resolve("aws --version")).toEqual({ kind: "allow", optionId: "allow-once" });
  });

  test("'once' records nothing at all", async () => {
    const h = await harness("once");
    await h.resolve("aws --version");
    expect(await h.store.lookup({ command: "aws", cwd: "/repo" })).toBeNull();
  });

  test("'reject' records nothing and refuses", async () => {
    const h = await harness("reject");
    const verdict = await h.resolve("aws --version");
    expect(verdict).toEqual({ kind: "reject", optionId: "reject-once" });
    expect(await h.store.lookup({ command: "aws", cwd: "/repo" })).toBeNull();
  });

  test("dismissing the prompt refuses", async () => {
    const h = await harness(null);
    expect((await h.resolve("aws --version")).kind).toBe("reject");
  });
});

describe("grants suppress the prompt", () => {
  test("a recorded grant means the next call is not asked about", async () => {
    const h = await harness("always");
    await h.resolve("aws --version");
    expect(h.asked).toHaveLength(1);
    await h.resolve("aws s3 ls");
    // Still one: the second call was covered by the grant.
    expect(h.asked).toHaveLength(1);
  });

  test("a blocked command is refused without asking", async () => {
    const h = await harness("always");
    await h.store.block("aws");
    const verdict = await h.resolve("aws --version");
    expect(verdict.kind).toBe("reject");
    expect(h.asked).toHaveLength(0);
  });
});

describe("non-shell requests", () => {
  test("a tool call with no command line is allowed without a prompt", async () => {
    const h = await harness("reject");
    const resolver = createPermissionResolver({
      mode: "ask",
      allow: [],
      cwd: "/repo",
      store: h.store,
      askUser: async () => "reject",
    });
    const req = { sessionId: "s", toolCall: { title: "Read file" }, options: CURSOR_OPTIONS };
    const out = (await resolver(req as unknown as RequestPermissionRequest)) as { kind: string };
    // Cursor's own permission config governs these; we only gate what we parse.
    expect(out.kind).toBe("allow");
  });
});

describe("commandFromRequest", () => {
  test("prefers the explicit argument over the title", () => {
    expect(commandFromRequest(request("aws s3 ls"))).toBe("aws s3 ls");
  });
});
