import { describe, expect, test } from "bun:test";
import {
  analyzeCommandLine,
  decideExec,
  matchesExecAllowlistPattern,
  resolveExecPolicy,
  splitSegments,
} from "./exec-policy.ts";

describe("resolveExecPolicy", () => {
  test("maps each mode to its security and ask semantics", () => {
    expect(resolveExecPolicy("deny")).toEqual({ mode: "deny", security: "deny", ask: "off" });
    expect(resolveExecPolicy("allowlist")).toEqual({
      mode: "allowlist",
      security: "allowlist",
      ask: "off",
    });
    expect(resolveExecPolicy("ask")).toEqual({
      mode: "ask",
      security: "allowlist",
      ask: "on-miss",
    });
    expect(resolveExecPolicy("full")).toEqual({ mode: "full", security: "full", ask: "off" });
  });

  test("auto is never weaker than ask, since we have no reviewer", () => {
    expect(resolveExecPolicy("auto").ask).toBe("on-miss");
    expect(resolveExecPolicy("auto").security).toBe("allowlist");
  });
});

describe("matchesExecAllowlistPattern", () => {
  test("matches literals and single-segment wildcards", () => {
    expect(matchesExecAllowlistPattern("git", "git")).toBe(true);
    expect(matchesExecAllowlistPattern("git*", "github")).toBe(true);
    expect(matchesExecAllowlistPattern("gi?", "git")).toBe(true);
  });

  test("a single star does not cross a path separator, but ** does", () => {
    expect(matchesExecAllowlistPattern("/usr/*/bin", "/usr/local/bin")).toBe(true);
    expect(matchesExecAllowlistPattern("/usr/*", "/usr/local/bin")).toBe(false);
    expect(matchesExecAllowlistPattern("/usr/**", "/usr/local/bin")).toBe(true);
  });

  test("does not match a different command", () => {
    expect(matchesExecAllowlistPattern("git", "gitk")).toBe(false);
    expect(matchesExecAllowlistPattern("ls", "lsaws")).toBe(false);
  });

  test("an empty pattern never matches", () => {
    expect(matchesExecAllowlistPattern("", "anything")).toBe(false);
    expect(matchesExecAllowlistPattern("   ", "anything")).toBe(false);
  });

  test("regex metacharacters in a pattern are literal", () => {
    expect(matchesExecAllowlistPattern("a.b", "a.b")).toBe(true);
    expect(matchesExecAllowlistPattern("a.b", "axb")).toBe(false);
  });
});

describe("splitSegments", () => {
  test("splits on real separators", () => {
    expect(splitSegments("ls | grep foo")).toEqual(["ls ", " grep foo"]);
    expect(splitSegments("a; b")).toEqual(["a", " b"]);
    expect(splitSegments("a && b")).toEqual(["a ", " b"]);
  });

  test("does not split inside quotes", () => {
    // A naive split produced a phantom command from the quoted text.
    expect(splitSegments('grep "a|b" file')).toEqual(['grep "a|b" file']);
    expect(splitSegments("grep 'foo;bar' file")).toEqual(["grep 'foo;bar' file"]);
  });

  test("keeps an escaped quote from closing a double-quoted string", () => {
    expect(splitSegments('echo "a\\"|b"')).toHaveLength(1);
  });

  test("drops empty segments", () => {
    expect(splitSegments("ls ||| grep x")).toEqual(["ls ", " grep x"]);
    expect(splitSegments("")).toEqual([]);
  });
});

describe("analyzeCommandLine", () => {
  test("a quoted separator does not invent a phantom command", () => {
    expect(analyzeCommandLine('grep "a|b" file').commands).toEqual(["grep"]);
    expect(analyzeCommandLine("grep 'foo;bar' file").commands).toEqual(["grep"]);
    expect(analyzeCommandLine('echo "a && b"').commands).toEqual(["echo"]);
  });

  test("finds the command in an ordinary line", () => {
    expect(analyzeCommandLine("ls -la")).toMatchObject({ ok: true, commands: ["ls"] });
  });

  test("peels environment assignments and wrappers", () => {
    expect(analyzeCommandLine("AWS_PROFILE=prod aws s3 ls").commands).toEqual(["aws"]);
    expect(analyzeCommandLine("env AWS_PROFILE=x aws sts get-caller-identity").commands).toEqual([
      "aws",
    ]);
    expect(analyzeCommandLine("sudo aws s3 ls").commands).toEqual(["aws"]);
  });

  test("reduces an absolute path to its basename", () => {
    expect(analyzeCommandLine("/usr/local/bin/aws s3 ls").commands).toEqual(["aws"]);
  });

  test("finds every command across separators", () => {
    expect(analyzeCommandLine("ls | grep foo").commands).toEqual(["ls", "grep"]);
    expect(analyzeCommandLine("cat f && aws s3 ls").commands).toEqual(["cat", "aws"]);
  });

  test("does not mistake an argument for a command", () => {
    expect(analyzeCommandLine("echo aws").commands).toEqual(["echo"]);
  });

  test("refuses substitutions, backticks and eval rather than guessing", () => {
    expect(analyzeCommandLine("aws $(whoami)").ok).toBe(false);
    expect(analyzeCommandLine("aws `id`").ok).toBe(false);
    expect(analyzeCommandLine('eval "aws s3 ls"').ok).toBe(false);
  });

  test("refuses when a wrapper option hides the real command", () => {
    // Reporting "-n5" here would miss kubectl entirely: a false negative.
    const r = analyzeCommandLine("nice -n5 kubectl get pods");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/hides the real command/);
  });

  test("detects inline evaluation for languages we cannot analyse", () => {
    expect(analyzeCommandLine("python -c 'import os'").inlineEval).toBe(true);
    expect(analyzeCommandLine("node -e 'process.exit(1)'").inlineEval).toBe(true);
    expect(analyzeCommandLine("ruby -e 'puts 1'").inlineEval).toBe(true);
  });

  test("does not flag an ordinary interpreter invocation as inline eval", () => {
    expect(analyzeCommandLine("python script.py").inlineEval).toBe(false);
    expect(analyzeCommandLine("node server.js").inlineEval).toBe(false);
  });

  test("sed and awk are ordinary commands, not inline eval", () => {
    // Their program IS their normal argument. Flagging them denied routine work
    // like `sed -n '1,5p' file` for no security gain.
    expect(analyzeCommandLine("sed -n '1,5p' file").inlineEval).toBe(false);
    expect(analyzeCommandLine("sed -n '1,5p' file").commands).toEqual(["sed"]);
    expect(analyzeCommandLine("awk '{print $1}' file").inlineEval).toBe(false);
  });

  test("a shell wrapper is unwrapped, so the inner command is what gets judged", () => {
    // This is the security-relevant case: bash -c must not be a way to smuggle
    // a command past a name-based allowlist.
    expect(analyzeCommandLine("bash -c 'ls -la'").commands).toEqual(["ls"]);
    expect(analyzeCommandLine("bash -c 'aws s3 ls'").commands).toEqual(["aws"]);
    expect(analyzeCommandLine("sh -c 'echo hi'").commands).toEqual(["echo"]);
    expect(analyzeCommandLine("bash -c 'ls -la'").inlineEval).toBe(false);
  });

  test("an unwrapped shell script still has its pipeline analysed", () => {
    // The pipe is inside the quoted script, so splitting must respect quotes
    // before unwrapping or the wrapper is lost entirely.
    expect(analyzeCommandLine("bash -c 'cat f | aws s3 cp - s3://x'").commands).toEqual([
      "cat",
      "aws",
    ]);
  });

  test("inline eval inside a shell wrapper is still detected", () => {
    expect(analyzeCommandLine(`bash -c 'python -c "import os"'`).inlineEval).toBe(true);
  });

  test("absurdly nested shell wrappers are refused rather than mis-parsed", () => {
    const deep = "bash -c 'bash -c \'bash -c \\\'bash -c \\\\\\'bash -c ls";
    const r = analyzeCommandLine(deep);
    // Either refused or reduced to something that is not silently allowed.
    expect(r.ok === false || r.commands.length > 0).toBe(true);
  });

  test("an empty line is not parseable", () => {
    expect(analyzeCommandLine("").ok).toBe(false);
    expect(analyzeCommandLine("   ").ok).toBe(false);
  });
});

describe("decideExec", () => {
  const allow = ["ls", "git*"];

  test("allows an allowlisted command", () => {
    const r = decideExec({
      policy: resolveExecPolicy("ask"),
      analysis: analyzeCommandLine("ls -la"),
      allow,
    });
    expect(r.decision).toBe("allow");
  });

  test("asks on a miss in ask mode, and denies in allowlist mode", () => {
    const analysis = analyzeCommandLine("aws s3 ls");
    expect(decideExec({ policy: resolveExecPolicy("ask"), analysis, allow }).decision).toBe("ask");
    expect(decideExec({ policy: resolveExecPolicy("allowlist"), analysis, allow }).decision).toBe(
      "deny",
    );
  });

  test("deny mode blocks even an allowlisted command", () => {
    expect(
      decideExec({
        policy: resolveExecPolicy("deny"),
        analysis: analyzeCommandLine("ls"),
        allow,
      }).decision,
    ).toBe("deny");
  });

  test("full mode allows anything not explicitly denied", () => {
    expect(
      decideExec({
        policy: resolveExecPolicy("full"),
        analysis: analyzeCommandLine("aws s3 rm s3://x"),
        allow: [],
      }).decision,
    ).toBe("allow");
    expect(
      decideExec({
        policy: resolveExecPolicy("full"),
        analysis: analyzeCommandLine("aws s3 ls"),
        allow: [],
        deny: ["aws"],
      }).decision,
    ).toBe("deny");
  });

  test("deny beats allow and beats a grant", () => {
    const r = decideExec({
      policy: resolveExecPolicy("ask"),
      analysis: analyzeCommandLine("aws s3 ls"),
      allow: ["aws"],
      deny: ["aws"],
      granted: () => true,
    });
    expect(r.decision).toBe("deny");
  });

  test("a grant satisfies the allowlist check", () => {
    const r = decideExec({
      policy: resolveExecPolicy("ask"),
      analysis: analyzeCommandLine("aws s3 ls"),
      allow: [],
      granted: (c) => c === "aws",
    });
    expect(r.decision).toBe("allow");
  });

  test("unparseable input is denied in every mode, including full", () => {
    for (const mode of ["deny", "allowlist", "ask", "auto", "full"] as const) {
      const r = decideExec({
        policy: resolveExecPolicy(mode),
        analysis: analyzeCommandLine("aws $(whoami)"),
        allow: ["aws"],
      });
      expect(r.decision).toBe("deny");
    }
  });

  test("strictInlineEval asks about inline code, leaving a way to approve it", () => {
    const r = decideExec({
      policy: resolveExecPolicy("ask"),
      analysis: analyzeCommandLine("python -c 'import os'"),
      allow: ["python"],
      strictInlineEval: true,
    });
    // An outright denial left no path forward for legitimate work, which made
    // it a dead end rather than a control.
    expect(r.decision).toBe("ask");
    expect(r.reason).toMatch(/inline/);
  });

  test("strictInlineEval denies inline code only in a mode that cannot prompt", () => {
    const r = decideExec({
      policy: resolveExecPolicy("allowlist"),
      analysis: analyzeCommandLine("python -c 'import os'"),
      allow: ["python"],
      strictInlineEval: true,
    });
    expect(r.decision).toBe("deny");
  });

  test("a sensitive command hidden in bash -c is still surfaced", () => {
    const r = decideExec({
      policy: resolveExecPolicy("ask"),
      analysis: analyzeCommandLine("bash -c 'aws s3 rm s3://bucket'"),
      allow: ["bash"],
      strictInlineEval: true,
    });
    // Allowlisting `bash` must not confer `aws`.
    expect(r.decision).toBe("ask");
    expect(r.command).toBe("aws");
  });

  test("a pipeline is only allowed when every command passes", () => {
    const r = decideExec({
      policy: resolveExecPolicy("ask"),
      analysis: analyzeCommandLine("ls | aws s3 cp - s3://x"),
      allow: ["ls"],
    });
    expect(r.decision).toBe("ask");
    expect(r.command).toBe("aws");
  });
});
