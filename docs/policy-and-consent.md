# cclaw policy and consent

Three pieces, in `src/policy/`:

| File                | Role                                                    |
| ------------------- | ------------------------------------------------------- |
| `exec-policy.ts`    | the five-mode model and command analysis                |
| `approvals.ts`      | the grant store — what has been consented to            |
| `resolver.ts`       | maps a decision onto the ACP options actually offered   |
| `profile-policy.ts` | reads allow/deny out of the profile's `cli-config.json` |
| `templates.ts`      | seeded defaults, `SENSITIVE_TOOLS`                      |

## Rules that are not negotiable

These came from the project owner directly. Do not relax them.

1. **"Allow always" means forever; there is a separate session-scoped option.**
   Both must exist and be distinct in any consent UI.
2. **"Allow always" on a _sensitive_ command records a session grant, not a
   permanent one.** `cclaw grant add` is the only permanent route. A sensitive
   command must never become permanently allowed by a single keystroke in a
   prompt.
3. **Unattended runs refuse consent.** `cclaw loop` and `cclaw -p` pass an
   `askUser` that declines and reports what it would have needed. Nobody is
   present to answer, so an allow would be unsupervised. Follow this in any new
   non-interactive path.
4. **Never widen the default allowlist to anything that takes an arbitrary
   path.** See the leak below.

## The five modes

`ExecMode = "deny" | "allowlist" | "ask" | "auto" | "full"`

`auto` resolves **no weaker than `ask`**, because cclaw has no reviewer to
auto-approve on your behalf. Keep it that way.

## Grants

Bound to **exact command + exact argv + exact cwd**, hashed. Scopes:
`session` / `profile` / `never`. Standing grants can expire.

Precision is the point: a grant for `aws sts get-caller-identity` in one
directory must not authorise `aws s3 rm` anywhere.

## Command analysis is deliberately conservative

`matchesExecAllowlistPattern` is a close port and includes the macOS
`/private/var` and `/private/tmp` normalisation that a naive matcher silently
fails.

Analysis **fails shut** on anything ambiguous: command substitution, backticks,
`eval`, and wrapper options (`nice -n5 kubectl` must not be read as the command
`nice`). Inline-eval detection covers `python -c`, `node -e`, `sed` and
similar. If you are unsure whether to classify something, refuse it.

## What is a boundary and what is not

**Read this before claiming cclaw confines anything.**

- **Shell commands are gateable.** They raise permission requests, and policy
  is enforced over ACP — verified: with `deny: ["Read(/etc/**)"]` a read of
  `/etc/hosts` was blocked and the agent's shell fallback raised a request our
  resolver rejected.
- **File reads cannot be confined to the working directory.** Cursor's internal
  Read tool may read **any absolute path by default**, raising no permission
  request. Verified non-working mitigations: `sandbox.mode: "enabled"` with
  `readBoundary: "workspace"`; a global `~/.cursor/sandbox.json` with
  `type: "workspace_readwrite"`. A blanket `Read(/**)` deny _does_ confine it
  but also blocks the workspace, because workspace paths are absolute and deny
  beats allow — no carve-out is expressible.
- **This is Cursor-wide, not an ACP regression.** The native non-ACP path
  behaves identically, so `cclaw raw` does not escape it either.

Therefore the sensitive-tree denylist in `templates.ts` (`/etc`, `~/.ssh`,
`~/.aws`, `~/.gnupg`, `~/Library/Keychains`, `**/.env`, `**/*.pem`, …) is
**defence in depth, not a boundary** — any path not listed is still readable.
It is labelled as such in the source and in `README.md`. Keep that labelling
honest; do not describe it as a sandbox.

## Four real bugs this area has produced

Recognise the shapes; they recur.

1. **The default policy leaked.** `Read(**)` permitted any absolute path and
   `Shell(ls)` permitted enumerating any directory. Together they let the agent
   read `/etc/hosts` and list `~/.ssh`, naming private keys. The allowlist is
   now 16 entries, **none of which takes an arbitrary path**.
2. **A shared mutable fallback leaked grants across stores.** `EMPTY_GRANTS`
   was a module-level constant used as a default _and then mutated_, so a
   session grant resurfaced as a profile grant. It is now a factory. Never
   return a shared mutable default.
3. **The resolver pre-granted everything.** `granted: (cmd) => !sensitive.has(cmd)`
   treated every non-sensitive command as already approved, making the
   allowlist meaningless. The store is now consulted, and sensitive commands
   bypass an allowlist hit.
4. **`agentRunning()` never fired.** It used `pgrep -fa`, but **macOS pgrep has
   no `-a`**, so it parsed bare PIDs that could never match. Now uses
   `ps -Ao pid=,command=`.

## Using the resolver in a new host

Only `askUser` differs between hosts. Build the rest identically so every
surface enforces one policy:

```ts
const { allow, deny } = await readPolicyFromConfig(pp.cursorConfigDir);
const store = new ApprovalStore({
  grantsFile: pp.grantsFile,
  runDir: paths.run,
  sessionId: `<host>-${process.pid}`,
});
const resolvePermission = createPermissionResolver({
  mode: "ask",
  allow,
  deny,
  strictInlineEval: true,
  cwd: process.cwd(),
  store,
  sensitive: SENSITIVE_TOOLS,
  askUser: /* interactive prompt, or refuse when unattended */,
});
```

`src/commands/print.ts` is the reference for the unattended form;
`src/tui/app.ts` for the interactive one. **Do not fork the resolver** — a
second policy implementation is how surfaces drift apart.

## Verifying a policy change

Unit tests are necessary but have missed real leaks here. Also run it:

```bash
bun run cclaw grant list
bun run cclaw -p "run aws sts get-caller-identity"   # expect refusal, reported
bun run cclaw grant add aws
```

Then confirm the grant is bound to the cwd you expect and that a fresh session
does not inherit a session-scoped grant.
