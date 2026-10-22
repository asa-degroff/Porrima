import { describe, expect, it } from "vitest";
import {
  buildRemotePythonCommand,
  buildRemotePythonKillCommand,
  type RemotePythonTools,
} from "../services/workspace.js";

function build(tools: RemotePythonTools, overrides: Partial<Parameters<typeof buildRemotePythonCommand>[0]> = {}) {
  return buildRemotePythonCommand({
    root: "/srv/project",
    pythonPath: "/usr/bin/python3",
    argv: ["input.pdf", "false", "false", "all"],
    timeoutSec: 30,
    tools,
    runId: "abc12345",
    ...overrides,
  });
}

describe("remote python wrapper", () => {
  it("uses setsid + timeout and records a pidfile when both exist", () => {
    const result = build({ timeout: true, setsid: true });
    expect(result.groupKill).toBe(true);
    expect(result.pidFile).toBe("$HOME/.porrima/tmp/run-abc12345.pid");
    expect(result.command).toContain("cd -- '/srv/project' || exit 1");
    expect(result.command).toContain(
      "setsid sh -c 'echo $$ > \"$1\"; shift; exec \"$@\"' sh \"$HOME/.porrima/tmp/run-abc12345.pid\" timeout -s TERM -k 5 30 '/usr/bin/python3' - 'input.pdf' 'false' 'false' 'all'",
    );
    expect(result.command).not.toContain("child=$!");
    expect(result.command).toContain("Python execution timed out after 30s");
  });

  it("keeps the pidfile and direct kill when only timeout exists", () => {
    const result = build({ timeout: true, setsid: false });
    expect(result.groupKill).toBe(false);
    expect(result.pidFile).toBeTruthy();
    expect(result.command).not.toContain("setsid ");
    expect(result.command).toContain("sh -c 'echo $$");
    expect(result.command).toContain("timeout -s TERM -k 5 30");
    expect(result.command).toContain("Python execution timed out after 30s");
  });

  it("uses setsid alone when only setsid exists", () => {
    const result = build({ timeout: false, setsid: true });
    expect(result.groupKill).toBe(true);
    expect(result.command).toContain("setsid sh -c");
    expect(result.command).not.toContain("timeout -s TERM");
    expect(result.command).not.toContain("Python execution timed out");
  });

  it("falls back to a plain command when neither tool exists", () => {
    const result = build({ timeout: false, setsid: false });
    expect(result.pidFile).toBeNull();
    expect(result.groupKill).toBe(false);
    expect(result.command).toBe("cd -- '/srv/project' || exit 1\n'/usr/bin/python3' - 'input.pdf' 'false' 'false' 'all'");
  });

  it("quotes roots and arguments that contain shell metacharacters", () => {
    const result = build(
      { timeout: false, setsid: false },
      { root: "/tmp/root with space", argv: ["a b", "$(id)"] },
    );
    expect(result.command).toContain("cd -- '/tmp/root with space'");
    expect(result.command).toContain("'a b' '$(id)'");
  });

  it("builds a group kill for setsid sessions and a direct kill otherwise", () => {
    const group = buildRemotePythonKillCommand("$HOME/.porrima/tmp/run-x.pid", true);
    expect(group).toContain('kill -TERM -- -"$pid"');
    expect(group).toContain('kill -KILL -- -"$pid"');
    expect(group).toContain('rm -f -- "$HOME/.porrima/tmp/run-x.pid"');

    const direct = buildRemotePythonKillCommand("$HOME/.porrima/tmp/run-x.pid", false);
    expect(direct).toContain('kill -TERM "$pid"');
    expect(direct).not.toContain('-"$pid"');
  });
});