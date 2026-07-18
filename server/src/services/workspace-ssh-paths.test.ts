import { describe, expect, it, vi } from "vitest";
import type { SshConnection } from "../types.js";
import { SshWorkspaceAdapter } from "./workspace.js";

const connection: SshConnection = {
  id: "ssh-test",
  name: "test",
  host: "example.invalid",
  port: 22,
  username: "agent",
  knownHostsMode: "strict",
  enabled: true,
  allowBash: true,
  allowFileWrite: true,
  allowAbsolutePaths: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastModified: "2026-01-01T00:00:00.000Z",
};

describe("SSH workspace path policy", () => {
  it("resolves paths and rejects escapes after symlink/parent expansion", async () => {
    const workspace = new SshWorkspaceAdapter(connection, "/srv/project");
    const exec = vi.spyOn(workspace, "exec")
      .mockResolvedValueOnce({ content: "/usr/bin/python3", isError: false })
      .mockResolvedValueOnce({ content: "blocked", isError: true });

    await workspace.readFile({ path: "../outside.txt" });

    const remoteCommand = String(exec.mock.calls[1][0]);
    expect(remoteCommand).toContain("candidate.resolve()");
    expect(remoteCommand).toContain("target.relative_to(root)");
    expect(remoteCommand).toContain("Path(raw).expanduser()");
    expect(exec.mock.calls[1][2]).toContain('"path":"../outside.txt"');
  });

  it("runs Python in the configured remote root", async () => {
    const workspace = new SshWorkspaceAdapter({ ...connection, id: "ssh-python-test" }, "/srv/project");
    const exec = vi.spyOn(workspace, "exec")
      .mockResolvedValueOnce({ content: "/usr/bin/python3", isError: false })
      .mockResolvedValueOnce({ content: "ok", isError: false });

    const result = await workspace.runPython({ code: "print('ok')", argv: ["one"] });

    expect(result).toEqual({ content: "ok", isError: false });
    expect(exec.mock.calls[1][0]).toContain("cd -- '/srv/project'");
    expect(exec.mock.calls[1][0]).toContain("'/usr/bin/python3' - 'one'");
    expect(exec.mock.calls[1][2]).toBe("print('ok')");
  });

  it("spills large Bash output inside the remote workspace", async () => {
    const workspace = new SshWorkspaceAdapter({ ...connection, id: "ssh-bash-test" }, "/srv/project");
    const exec = vi.spyOn(workspace, "exec").mockResolvedValue({ content: "ok", isError: false });

    await workspace.bash({ command: "yes line | head -100000" });

    const remoteCommand = String(exec.mock.calls[0][0]);
    expect(remoteCommand).toContain(".porrima-tool-output/bash-");
    expect(remoteCommand).toContain("tail -c 102400");
    expect(remoteCommand).toContain("Use read_file");
  });

  it("checks glob matches as well as the requested base directory", async () => {
    const workspace = new SshWorkspaceAdapter({ ...connection, id: "ssh-glob-test" }, "/srv/project");
    const exec = vi.spyOn(workspace, "exec")
      .mockResolvedValueOnce({ content: "/usr/bin/python3", isError: false })
      .mockResolvedValueOnce({ content: "blocked", isError: true });

    await workspace.listFiles({ path: ".", pattern: "../outside/**" });

    expect(String(exec.mock.calls[1][0])).toContain("Glob pattern escapes the configured SSH workspace root");
  });
});
