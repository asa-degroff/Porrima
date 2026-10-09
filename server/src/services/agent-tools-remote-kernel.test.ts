import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentTools, type ToolSideEffects } from "./agent-tools.js";

// Kernel boundary mocked (spied); workspace resolution swapped per test.
// Real modules are spread in so transitive imports of these files keep
// working — only getWorkspaceForProject is replaced.
vi.mock("./python-kernel.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./python-kernel.js")>();
  return {
    ...actual,
    executeInKernel: vi.fn(async () => ({ mode: "kernel", content: "kernel-out", isError: false })),
  };
});

let workspaceStub: any;
vi.mock("./workspace.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workspace.js")>();
  return {
    ...actual,
    getWorkspaceForProject: vi.fn(async () => workspaceStub),
  };
});

const effects: ToolSideEffects = {
  onArtifact: () => {},
  onVisual: () => {},
  onAskUser: () => {},
};

const fakeHost = { kind: "ssh:test-host", failureReason: "transport" } as any;

function runPythonTool() {
  return getAgentTools("chat-r", effects, 32768, undefined, "agent", null).find((t) => t.name === "run_python")!;
}

async function kernelSpy() {
  const { executeInKernel } = await import("./python-kernel.js");
  return executeInKernel as unknown as ReturnType<typeof vi.fn>;
}

beforeEach(async () => {
  workspaceStub = undefined;
  (await kernelSpy()).mockClear();
});

describe("run_python remote kernel routing (P4a)", () => {
  it("local workspaces run on the kernel with the default local host", async () => {
    const runPython = vi.fn(async () => ({ content: "one-shot", isError: false }));
    workspaceStub = { kind: "local", label: "/home/user", runPython };

    await runPythonTool().execute("t1", { code: "1" });

    const spy = await kernelSpy();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].host).toBeUndefined(); // manager defaults to localKernelHost
    expect(runPython).not.toHaveBeenCalled();
  });

  it("ssh workspaces with a host route through executeInKernel with it", async () => {
    workspaceStub = {
      kind: "ssh",
      label: "ssh:host:/root",
      runPython: vi.fn(),
      createKernelHost: async () => fakeHost,
    };

    const spy = await kernelSpy();
    await runPythonTool().execute("t2", { code: "1" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].host).toBe(fakeHost);
  });

  it("background over an ssh host runs as a real background job (P4b)", async () => {
    workspaceStub = {
      kind: "ssh",
      label: "ssh:host:/root",
      runPython: vi.fn(),
      createKernelHost: async () => fakeHost,
    };

    const spy = await kernelSpy();
    await runPythonTool().execute("t3", { code: "1", background: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].background).toBe(true);
    expect(spy.mock.calls[0][0].timeoutMs).toBe(3_600_000);
    expect(spy.mock.calls[0][0].host).toBe(fakeHost);
  });

  it("ssh without a host stays per-call with the stateless notice", async () => {
    const runPython = vi.fn(async () => ({ content: "one-shot", isError: false }));
    workspaceStub = { kind: "ssh", label: "ssh:host:/root", runPython, createKernelHost: async () => null };

    const spy = await kernelSpy();
    await runPythonTool().execute("t4", { code: "1", background: true });
    expect(spy).not.toHaveBeenCalled();
    expect(runPython).toHaveBeenCalledTimes(1);
  });

  it("the transport fallback reason has a notice", async () => {
    workspaceStub = {
      kind: "ssh",
      label: "ssh:host:/root",
      runPython: vi.fn(async () => ({ content: "per-call out", isError: false })),
      createKernelHost: async () => fakeHost,
    };
    const spy = await kernelSpy();
    spy.mockImplementationOnce(async () => ({ mode: "fallback", reason: "transport" }));

    const result: any = await runPythonTool().execute("t5", { code: "1" });
    expect(JSON.stringify(result.content)).toContain("remote session unavailable; ran per-call this call");
  });
});
