import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function loadWorkspace(dataDir: string) {
  vi.resetModules();
  process.env.PORRIMA_DATA_DIR = dataDir;
  process.env.PORRIMA_TOOL_OUTPUT_DIR = join(dataDir, "tool-output");
  const workspace = await import("../services/workspace.js");
  return workspace;
}

async function waitForDeath(pid: number, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function readPid(path: string): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return Number(readFileSync(path, "utf-8"));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`PID file ${path} was not written`);
}

afterEach(() => {
  delete process.env.PORRIMA_DATA_DIR;
  delete process.env.PORRIMA_TOOL_OUTPUT_DIR;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const GRANDCHILD_SCRIPT = `
import subprocess, sys, time
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
open("child.pid", "w").write(str(child.pid))
time.sleep(60)
`;

describe("one-shot Python supervision", () => {
  it("kills subprocess grandchildren on timeout", async () => {
    const dataDir = makeTempDir("porrima-oneshot-timeout-");
    const cwd = makeTempDir("porrima-oneshot-cwd-");
    const { LocalWorkspaceAdapter } = await loadWorkspace(dataDir);
    const adapter = new LocalWorkspaceAdapter(cwd);

    const result = await adapter.runPython(
      { code: GRANDCHILD_SCRIPT, timeout: 1 },
      undefined,
      { chatId: "chat-timeout" },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("timed out after 1s");
    const childPid = await readPid(join(cwd, "child.pid"));
    expect(await waitForDeath(childPid)).toBe(true);
  }, 15_000);

  it("kills subprocess grandchildren on abort", async () => {
    const dataDir = makeTempDir("porrima-oneshot-abort-");
    const cwd = makeTempDir("porrima-oneshot-cwd-");
    const { LocalWorkspaceAdapter } = await loadWorkspace(dataDir);
    const adapter = new LocalWorkspaceAdapter(cwd);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    try {
      const result = await adapter.runPython(
        { code: GRANDCHILD_SCRIPT, timeout: 30 },
        controller.signal,
        { chatId: "chat-abort" },
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("aborted");
      const childPid = await readPid(join(cwd, "child.pid"));
      expect(await waitForDeath(childPid)).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  }, 15_000);

  it("bounds model-facing output and spills the rest", async () => {
    const dataDir = makeTempDir("porrima-oneshot-output-");
    const cwd = makeTempDir("porrima-oneshot-cwd-");
    const { LocalWorkspaceAdapter } = await loadWorkspace(dataDir);
    const adapter = new LocalWorkspaceAdapter(cwd);

    const result = await adapter.runPython(
      { code: "for i in range(20000):\n    print('A' * 100)\n", timeout: 30 },
      undefined,
      { chatId: "chat-output" },
    );

    expect(result.isError).toBe(false);
    expect(result.content.length).toBeLessThan(110 * 1024);
    expect(result.content).toContain("saved to");

    const spillDir = join(dataDir, "tool-output", "chat-output");
    const files = readdirSync(spillDir);
    expect(files.length).toBeGreaterThan(0);
    const spill = readFileSync(join(spillDir, files[0]), "utf-8");
    expect(spill.length).toBeGreaterThan(1_500_000);
  }, 15_000);

  it("keeps complete stdout for internal maxBuffer callers and rejects overflow", async () => {
    const dataDir = makeTempDir("porrima-oneshot-internal-");
    const cwd = makeTempDir("porrima-oneshot-cwd-");
    const { LocalWorkspaceAdapter } = await loadWorkspace(dataDir);
    const adapter = new LocalWorkspaceAdapter(cwd);

    const ok = await adapter.runPython(
      { code: "print('{\"ok\": true}')", timeout: 30 },
      undefined,
      { maxBuffer: 1024 },
    );
    expect(ok.isError).toBe(false);
    expect(ok.content.trim()).toBe('{"ok": true}');

    const overflow = await adapter.runPython(
      { code: "print('x' * 5000)", timeout: 30 },
      undefined,
      { maxBuffer: 1024 },
    );
    expect(overflow.isError).toBe(true);
    expect(overflow.content).toContain("exceeded 1024 bytes");
  }, 15_000);
});