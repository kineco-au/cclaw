/**
 * Default Cursor policy, Claude-Code parity.
 *
 * Only `cli-config.json` and `permissions.json` honour CURSOR_CONFIG_DIR, so
 * those are the per-profile files. `sandbox.json`, `hooks.json` and `mcp.json`
 * are hardcoded by Cursor to ~/.cursor and therefore shared across profiles —
 * which is why sandbox policy lives in cli-config.json's `sandbox` block here
 * rather than in the global sandbox.json.
 */

import type { JsonObject } from "./merge.ts";

export interface TemplateVars {
  /** Absolute path to the statusline entrypoint Cursor will spawn. */
  statusLineCommand: string;
  /** The user's home directory, expanded now because `~` support in permission globs is unverified. */
  home: string;
}

/**
 * Keys we always assert.
 *
 * Note what is deliberately NOT here: sensitive CLIs such as `aws` are absent
 * from `deny`. `deny` is a hard block with no prompt, so denying `aws` would
 * make temporary-vs-permanent consent impossible. Under `approvalMode:
 * "allowlist"` anything missing from `allow` already prompts, which is the
 * Claude Code behaviour. `deny` is reserved for things that must never happen
 * regardless of a tired user clicking yes.
 *
 * There is also no blanket `Write(**)`: the real write boundary is the sandbox's
 * workspace scope, and shadowing it with a permission rule would fight it.
 */
export function cliConfigEnforce(v: TemplateVars): JsonObject {
  const h = v.home;
  return {
    version: 1,
    approvalMode: "allowlist",
    sandbox: {
      mode: "enabled",
      readBoundary: "workspace",
      networkAccess: "user_config_with_defaults",
    },
    statusLine: {
      type: "command",
      command: v.statusLineCommand,
      updateIntervalMs: 1000,
      timeoutMs: 2000,
      padding: 0,
    },
    permissions: {
      // Deliberately minimal, and this was tightened after testing showed the
      // first draft leaking. Two rules were actively dangerous:
      //
      //   Read(**)   - permitted ANY absolute path, so workspace confinement
      //                was defeated and /etc/hosts read freely.
      //   Shell(ls)  - permitted enumerating any directory. Cursor keeps
      //                ~/.ssh readable regardless of sandbox settings, so a
      //                blanket shell allow bypassed the Read() denies below
      //                and listed private key filenames.
      //
      // Nothing here takes an arbitrary path. File reads are left to prompt,
      // and the read-only git verbs are safe because git is repo-scoped.
      allow: [
        "Shell(pwd)",
        "Shell(echo)",
        "Shell(printf)",
        "Shell(date)",
        "Shell(uname)",
        "Shell(basename)",
        "Shell(dirname)",
        "Shell(true)",
        "Shell(which)",
        "Shell(git:status*)",
        "Shell(git:log*)",
        "Shell(git:diff*)",
        "Shell(git:show*)",
        "Shell(git:branch*)",
        "Shell(git:rev-parse*)",
        "Shell(git:ls-files*)",
      ],
      // IMPORTANT: this is a denylist, not a boundary.
      //
      // Testing established that Cursor permits the agent's internal Read tool
      // to read any absolute path by default, in BOTH the ACP and the native
      // path, and that neither `sandbox.readBoundary: "workspace"` nor a global
      // sandbox.json with `type: workspace_readwrite` confines it. A blanket
      // `Read(/**)` deny does confine it, but also blocks the workspace itself,
      // because workspace paths are absolute and deny beats allow — so no
      // carve-out is expressible.
      //
      // Requirement "restrict itself to the directory it is started in" is
      // therefore NOT achievable for reads through Cursor's permission model.
      // What follows is defence in depth over the locations that matter, and it
      // can be bypassed by any path not listed here.
      deny: [
        "Read(**/.env)",
        "Read(**/.env.*)",
        "Read(**/*.pem)",
        "Read(**/*.key)",
        "Read(**/id_rsa*)",
        "Read(**/id_ed25519*)",
        "Read(**/.netrc)",
        "Read(/etc/**)",
        "Read(/private/etc/**)",
        "Read(/var/root/**)",
        `Read(${h}/.ssh/**)`,
        `Read(${h}/.aws/**)`,
        `Read(${h}/.config/gcloud/**)`,
        `Read(${h}/.kube/**)`,
        `Read(${h}/.docker/config.json)`,
        `Read(${h}/.npmrc)`,
        `Read(${h}/.netrc)`,
        `Read(${h}/.gnupg/**)`,
        `Read(${h}/Library/Keychains/**)`,
        `Read(${h}/.cursor/auth.json)`,
        `Read(${h}/.cclaw/**)`,
        `Write(${h}/.ssh/**)`,
        `Write(${h}/.aws/**)`,
        `Write(${h}/.config/gcloud/**)`,
        `Write(${h}/.kube/**)`,
        `Write(${h}/.cursor/**)`,
        `Write(${h}/.cclaw/**)`,
        "Write(/etc/**)",
        "Write(/usr/**)",
        "Shell(sudo)",
        "Shell(doas)",
        "Shell(su)",
        "Shell(security)",
        "Shell(launchctl)",
        "Shell(systemctl)",
        "Shell(dd)",
        "Shell(diskutil)",
        "Shell(git:push --force*)",
        "Shell(npm:publish*)",
      ],
    },
  };
}

/** Applied only where the user has no value of their own. */
export function cliConfigDefaults(): JsonObject {
  return {
    display: {
      mode: "zen",
      showLineNumbers: false,
      showThinkingBlocks: true,
      showStatusIndicators: true,
      showStatusLineRunningTime: true,
    },
    notifications: true,
    hints: true,
    rewind: true,
    modelSlashCommands: true,
    autoAcceptWebSearch: false,
    attribution: { attributeCommitsToAgent: false, attributePRsToAgent: false },
    editor: { vimMode: false },
  };
}

/**
 * Natural-language steering for `auto-review` mode. Idle under our default
 * `allowlist` mode, but seeded so the posture survives a user switching modes.
 */
export function permissionsSeed(): JsonObject {
  return {
    autoRun: {
      allow_instructions: [
        "Read-only inspection of files inside the current workspace is fine.",
        "Running the project's own test suite, linters and formatters is fine.",
      ],
      block_instructions: [
        "Every AWS CLI command should go through approval first.",
        "Every gcloud, az, kubectl, helm, terraform, pulumi or databricks command should go through approval first.",
        "Any command that reads or writes credentials, SSH keys, .env files or keychain entries should go through approval first.",
        "Any command that writes, moves or deletes files outside the current workspace should go through approval first.",
        "Any command that pushes to a git remote, publishes a package, or deploys should go through approval first.",
      ],
    },
  };
}

/**
 * Commands requiring explicit consent.
 *
 * This is a consent-UX layer, not a security boundary: `bash -c 'aws ...'`,
 * backticks and aliases evade name matching. The sandbox and `permissions.deny`
 * are the boundary.
 */
export const SENSITIVE_TOOLS: readonly string[] = [
  "aws",
  "gcloud",
  "az",
  "kubectl",
  "helm",
  "terraform",
  "pulumi",
  "databricks",
  "gh",
  "glab",
  "docker",
  "ssh",
  "scp",
  "rsync",
  "psql",
  "mysql",
  "bq",
  "snowsql",
];
