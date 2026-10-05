import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalWorkspaceAdapter } from "./workspace.js";
import { killAllSupervised } from "./process-supervisor.js";
import type { CaptureSnapshot } from "./output-capture.js";

const roots: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "porrima-bash-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  // Reap daemonized groups left by the `cmd &` parity tests.
  await killAllSupervised({ graceMs: 200 });
  delete process.env.PORRIMA_TOOL_OUTPUT_DIR;
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("workspace bash execution", () => {
  it("runs a command in the workspace and merges stdout/stderr", async () => {
    const root = await tempDir();
    const workspace = new LocalWorkspaceAdapter(root);
    const result = await workspace.bash({ command: "echo out; echo err >&2" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("out");
    expect(result.content).toContain("err");
  });

  it("marks a nonzero exit as an error", async () => {
    const root = await tempDir();
    const workspace = new LocalWorkspaceAdapter(root);
    const result = await workspace.bash({ command: "echo bad; exit 3" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("bad");
  });

  it("times out and reports the captured output", async () => {
    const root = await tempDir();
    const workspace = new LocalWorkspaceAdapter(root);
    const result = await workspace.bash({ command: "echo before; sleep 10", timeout: 1 });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Command timed out after 1s");
    expect(result.content).toContain("before");
  });

  it("aborts on signal and preserves captured output", async () => {
    const root = await tempDir();
    const workspace = new LocalWorkspaceAdapter(root);
    const controller = new AbortController();
    const pending = workspace.bash({ command: "echo before; sleep 10" }, controller.signal);
    setTimeout(() => controller.abort(), 200);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Command aborted");
    expect(result.content).toContain("before");
  });

  it("does not let a daemonized grandchild hang the tool", async () => {
    const root = await tempDir();
    const workspace = new LocalWorkspaceAdapter(root);
    const started = Date.now();
    const result = await workspace.bash({ command: "sleep 5 & echo done" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("done");
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("returns for cmd & disown without waiting for the child", async () => {
    const root = await tempDir();
    const workspace = new LocalWorkspaceAdapter(root);
    const started = Date.now();
    const result = await workspace.bash({ command: "(sleep 5 &) ; echo done" });
    expect(result.content).toContain("done");
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("spills oversized output to the shared store", async () => {
    const root = await tempDir();
    const spillRoot = await tempDir();
    process.env.PORRIMA_TOOL_OUTPUT_DIR = spillRoot;
    const workspace = new LocalWorkspaceAdapter(root);
    const result = await workspace.bash(
      { command: "head -c 200000 /dev/zero | tr '\\0' 'x'" },
      undefined,
      { chatId: "chat-bash" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("[Output exceeded 100KB.");
    const match = result.content.match(/saved to: (.+\.log)/);
    expect(match).toBeTruthy();
    const spillPath = match![1];
    expect(spillPath.startsWith(join(spillRoot, "chat-bash"))).toBe(true);
    expect((await readFile(spillPath, "utf8")).length).toBe(200000);
  });

  it("does not spill when no chat key is provided", async () => {
    const root = await tempDir();
    const workspace = new LocalWorkspaceAdapter(root);
    const result = await workspace.bash({ command: "head -c 200000 /dev/zero | tr '\\0' 'x'" });
    expect(result.content).not.toContain("read_file");
  });

  it("hardens the environment against interactive prompts", async () => {
    const root = await tempDir();
    const workspace = new LocalWorkspaceAdapter(root);
    const result = await workspace.bash({
      command: 'echo "$TERM:$GIT_EDITOR:$GIT_TERMINAL_PROMPTS:$PAGER:$DEBIAN_FRONTEND"',
    });
    expect(result.content.trim()).toBe("dumb:true:0:cat:noninteractive");
  });

  it("streams bounded view updates", async () => {
    const root = await tempDir();
    const workspace = new LocalWorkspaceAdapter(root);
    const views: CaptureSnapshot[] = [];
    const result = await workspace.bash(
      { command: "printf hi" },
      undefined,
      { onUpdate: (view) => views.push(view) },
    );
    expect(result.content).toBe("hi");
    expect(views.length).toBeGreaterThanOrEqual(1);
    expect(views[views.length - 1].text).toBe("hi");
  });
});
