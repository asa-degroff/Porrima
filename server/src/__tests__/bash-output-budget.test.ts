import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
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
  return import("../services/workspace.js");
}

afterEach(() => {
  delete process.env.PORRIMA_DATA_DIR;
  delete process.env.PORRIMA_TOOL_OUTPUT_DIR;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("bash output budget", () => {
  it("renders the recovery pointer before the window and sizes the window to the budget", async () => {
    const dataDir = makeTempDir("porrima-bash-budget-");
    const cwd = makeTempDir("porrima-bash-cwd-");
    const { LocalWorkspaceAdapter } = await loadWorkspace(dataDir);
    const adapter = new LocalWorkspaceAdapter(cwd);

    const result = await adapter.bash(
      { command: "seq 1 20000", timeout: 10 },
      undefined,
      { chatId: "chat-bash", resultBudgetChars: 30_000 },
    );

    expect(result.isError).toBe(false);
    // (30,000 - 8 KiB headroom) = 21,808-byte window.
    expect(result.content.startsWith("[output truncated")).toBe(true);
    expect(result.content.indexOf("read_file")).toBeGreaterThanOrEqual(0);
    expect(result.content.indexOf("read_file")).toBeLessThan(512);
    expect(result.content.length).toBeLessThanOrEqual(30_000);

    const path = result.content.match(/Use read_file\(path="([^"]+)"/)?.[1];
    expect(path).toBeTruthy();
    expect(existsSync(path!)).toBe(true);
    expect(readFileSync(path!, "utf8").length).toBeGreaterThan(21_808);
  }, 15_000);

  it("does not add a header when the output fits", async () => {
    const dataDir = makeTempDir("porrima-bash-small-");
    const cwd = makeTempDir("porrima-bash-cwd-");
    const { LocalWorkspaceAdapter } = await loadWorkspace(dataDir);
    const adapter = new LocalWorkspaceAdapter(cwd);

    const result = await adapter.bash(
      { command: "printf 'hello\\n'", timeout: 10 },
      undefined,
      { chatId: "chat-bash-small", resultBudgetChars: 30_000 },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toBe("hello\n");
    expect(result.content).not.toContain("read_file");
    expect(result.content).not.toContain("output truncated");
  }, 15_000);
});