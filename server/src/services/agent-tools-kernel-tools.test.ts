// Kernel-origin tool dispatch through the REAL registry seam
// (docs/design/kernel-codemode.md §4.9, Phase A slice 1). The kernel manager
// and run_python's withMutationLock usage are live; only the workspace adapter
// is faked, so "a foreground cell's bash resolves while run_python holds the
// workspace label lock" is an end-to-end assertion, not a mock echo.
//
// If the dispatcher were ever "fixed" to reuse the model-level bash execute
// (which acquires `workspace:<label>`), this whole file deadlocks: the nested
// call queues behind the label lock that the very run_python execute it rides
// on is holding. The cell's own timeout + vitest turn that into a loud
// failure — the §4.9 rule pinned as behavior.

import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  rootPath: "/tmp",
  bashCalls: [] as Array<{ args: Record<string, any>; opts: Record<string, any> }>,
  failNextBash: false,
}));

vi.mock("./workspace.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workspace.js")>();
  const adapter = {
    kind: "local" as const,
    get label(): string {
      return fake.rootPath;
    },
    async readFile(args: Record<string, any>) {
      return { content: `file:${String(args.path)}`, isError: false };
    },
    async bash(args: Record<string, any>, _signal?: AbortSignal, opts: Record<string, any> = {}) {
      fake.bashCalls.push({ args, opts });
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (fake.failNextBash) {
        return { content: `boom: ${String(args.command)} exited 1`, isError: true };
      }
      return { content: `ran: ${String(args.command)}`, isError: false };
    },
    async listFiles() {
      return { content: "", isError: false };
    },
    async writeFile() {
      return { content: "", isError: false };
    },
    async editFile() {
      return { content: "", isError: false };
    },
    async runPython() {
      throw new Error("one-shot path must not run while the kernel is live");
    },
  };
  return { ...actual, getWorkspaceForProject: () => Promise.resolve(adapter as any) };
});

const CHAT = "k-tools-chat";
const effects = { onArtifact: () => {}, onVisual: () => {}, onAskUser: () => {} };

let dataDir = "";
let kernelRootDir = "";
let current: { agentTools: typeof import("./agent-tools.js"); kernel: typeof import("./python-kernel.js") } | null = null;

// paths.ts pins APP_DATA_DIR at module load, so agent-tools (and its
// chat-storage graph) must import AFTER the env is set — the established
// resetModules + dynamic-import pattern from agent-tools-artifact-update.test.
async function setup() {
  vi.resetModules();
  dataDir = await mkdtemp(join(tmpdir(), "porrima-ktools-"));
  kernelRootDir = await mkdtemp(join(tmpdir(), "porrima-ktools-kernels-"));
  fake.rootPath = dataDir;
  process.env.PORRIMA_DATA_DIR = dataDir;
  process.env.PORRIMA_KERNEL_ROOT = kernelRootDir;
  process.env.PORRIMA_KERNEL_TOOLS = "1";
  const agentTools = await import("./agent-tools.js");
  const kernel = await import("./python-kernel.js");
  current = { agentTools, kernel };
  return current;
}

function resultText(result: { content: unknown }): string {
  const content = result.content as Array<{ text?: string }>;
  return content.map((part) => part?.text ?? "").join("\n");
}

beforeEach(() => {
  fake.bashCalls = [];
  fake.failNextBash = false;
});

afterEach(async () => {
  if (current) await current.kernel.disposeAllKernels();
  current = null;
  delete process.env.PORRIMA_KERNEL_TOOLS;
  delete process.env.PORRIMA_DATA_DIR;
  delete process.env.PORRIMA_KERNEL_ROOT;
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  if (kernelRootDir) await rm(kernelRootDir, { recursive: true, force: true });
});

describe("kernel tool dispatch through the registry (slice 1)", () => {
  it("kernel-origin bash resolves while run_python holds the workspace mutation lock", async () => {
    const { agentTools } = await setup();
    const runPython = agentTools.getAgentTools(CHAT, effects).find((tool) => tool.name === "run_python")!;
    const result = await runPython.execute(
      "call-1",
      { code: 'out = await tools.bash(command="echo hi from kernel")\nprint(out)', timeout: 60 },
      new AbortController().signal,
    );
    expect(resultText(result)).toContain("ran: echo hi from kernel");
    expect(fake.bashCalls).toHaveLength(1);
    // chatId opts into the shared spill store (full output stays on disk for
    // oversized results); no lock acquisition happens on this path.
    expect(fake.bashCalls[0].opts.chatId).toBe(CHAT);
  }, 30_000);

  it("routes kernel read_file through the same dispatcher", async () => {
    const { agentTools } = await setup();
    const runPython = agentTools.getAgentTools(CHAT, effects).find((tool) => tool.name === "run_python")!;
    const result = await runPython.execute(
      "call-2",
      { code: 'print(await tools.read_file(path="a.txt"))', timeout: 60 },
      new AbortController().signal,
    );
    expect(resultText(result)).toContain("file:a.txt");
  }, 30_000);

  it("surfaces a non-zero bash exit as KernelToolError carrying the output", async () => {
    await setup();
    fake.failNextBash = true;
    const { agentTools } = current!;
    const runPython = agentTools.getAgentTools(CHAT, effects).find((tool) => tool.name === "run_python")!;
    // A failed cell flows through wrapResult's error branch (thrown, not
    // resolved) — same wire shape as a model-level tool failure.
    const error = await runPython
      .execute("call-3", { code: 'await tools.bash(command="false")', timeout: 60 }, new AbortController().signal)
      .then(() => null, (e: any) => e);
    expect(error).toBeTruthy();
    expect(error.message).toContain("KernelToolError");
    expect(error.message).toContain("boom: false exited 1");

    // The namespace survives the failed cell (interrupt-ladder contract).
    const after = await runPython.execute(
      "call-4",
      { code: 'print("still alive")', timeout: 60 },
      new AbortController().signal,
    );
    expect(resultText(after)).toContain("still alive");
  }, 30_000);

  it("absent-from-allowlist tools are absent from the namespace, not discouraged", async () => {
    const { agentTools } = await setup();
    const runPython = agentTools.getAgentTools(CHAT, effects).find((tool) => tool.name === "run_python")!;
    // edit_file is tier 2: the namespace is built from the dispatcher's list,
    // so there is no attribute to call — AttributeError before any RPC.
    const error = await runPython
      .execute("call-5", { code: 'await tools.edit_file(path="x", content="y")', timeout: 60 }, new AbortController().signal)
      .then(() => null, (e: any) => e);
    expect(error).toBeTruthy();
    expect(error.message).toContain("AttributeError");
  }, 30_000);

  it("passes bash args through untouched for the adapter to apply its own limits", async () => {
    const { agentTools } = await setup();
    const runPython = agentTools.getAgentTools(CHAT, effects).find((tool) => tool.name === "run_python")!;
    const result = await runPython.execute(
      "call-6",
      { code: 'await tools.bash(command="sleepy", timeout=90)', timeout: 60 },
      new AbortController().signal,
    );
    expect(resultText(result)).toContain("ran: sleepy");
    expect(fake.bashCalls[0].args).toEqual({ command: "sleepy", timeout: 90 });
  }, 30_000);
});
