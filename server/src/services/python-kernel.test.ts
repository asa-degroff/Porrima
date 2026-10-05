import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  disposeAllKernels,
  executeInKernel,
  isKernelWedge,
  sweepKernelJournals,
  type KernelRunOutcome,
} from "./python-kernel.js";
import { listSupervised } from "./process-supervisor.js";

const roots: string[] = [];
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "porrima-kernel-"));
  roots.push(root);
  process.env.PORRIMA_KERNEL_ROOT = root;
  // Fast interrupt escalation for tests (driver) and a matching wedge deadline
  // (manager).
  process.env.PORRIMA_KERNEL_L2_GRACE_MS = "300";
  process.env.PORRIMA_KERNEL_WEDGE_GRACE_MS = "1000";
});

afterEach(async () => {
  await disposeAllKernels();
  delete process.env.PORRIMA_KERNEL_ROOT;
  delete process.env.PORRIMA_KERNEL_L2_GRACE_MS;
  delete process.env.PORRIMA_KERNEL_WEDGE_GRACE_MS;
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function run(
  chatId: string,
  code: string,
  opts: { timeoutMs?: number; signal?: AbortSignal; onUpdate?: (text: string) => void } = {},
): Promise<KernelRunOutcome> {
  return executeInKernel({
    chatId,
    cwd: root,
    code,
    timeoutMs: opts.timeoutMs ?? 30_000,
    signal: opts.signal,
    onUpdate: opts.onUpdate,
  });
}

interface KernelOutcome {
  mode: "kernel";
  content: string;
  isError: boolean;
}

/** Narrow to the kernel outcome (throws on fallback). */
function kernel(outcome: KernelRunOutcome): KernelOutcome {
  if (outcome.mode !== "kernel") throw new Error(`expected kernel outcome, got ${outcome.reason}`);
  return outcome;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("python kernel manager", () => {
  it("persists the namespace and returns trailing expressions", async () => {
    const first = kernel(await run("chat-a", "x = 41"));
    expect(first.isError).toBe(false);

    const second = kernel(await run("chat-a", "x + 1"));
    expect(second.isError).toBe(false);
    expect(second.content).toContain("42");
  });

  it("supports top-level await and stdout", async () => {
    const outcome = kernel(await run("chat-b", "import asyncio\nawait asyncio.sleep(0.01)\nprint('await ok')"));
    expect(outcome.isError).toBe(false);
    expect(outcome.content).toContain("await ok");
  });

  it("keeps the namespace after a failing cell", async () => {
    await run("chat-c", "y = 5");
    const failed = kernel(await run("chat-c", "raise ValueError('boom')"));
    expect(failed.isError).toBe(true);
    expect(failed.content).toContain("ValueError");

    const after = kernel(await run("chat-c", "y"));
    expect(after.isError).toBe(false);
    expect(after.content).toContain("5");
  });

  it("formats stderr separately from stdout", async () => {
    const outcome = kernel(await run("chat-d", "import sys\nprint('out'); print('err', file=sys.stderr)"));
    expect(outcome.content).toContain("out");
    expect(outcome.content).toContain("[stderr] err");
  });

  it("times out a sync cell and preserves the namespace", async () => {
    const outcome = kernel(await run("chat-e", "import time\ntime.sleep(30)", { timeoutMs: 500 }));
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("timed out");

    const after = kernel(await run("chat-e", "print('alive')"));
    expect(after.isError).toBe(false);
    expect(after.content).toContain("alive");
  });

  it("aborts a running cell on signal", async () => {
    const controller = new AbortController();
    const pending = run("chat-f", "import time\ntime.sleep(30)", { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    const outcome = kernel(await pending);
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("aborted");
  });

  it("flags a wedged kernel and degrades the next call to one-shot", async () => {
    const wedgeCode =
      "import time\nwhile True:\n    try:\n        time.sleep(0.05)\n    except BaseException:\n        pass";
    const outcome = kernel(await run("chat-g", wedgeCode, { timeoutMs: 300 }));
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("wedged");
    expect(isKernelWedge("chat-g")).toBe(true);

    const next = await run("chat-g", "print('stateless')");
    expect(next.mode).toBe("fallback");
    if (next.mode === "fallback") expect(next.reason).toBe("wedge");
  });

  it("kills journaled child groups on the startup sweep", async () => {
    const outcome = kernel(
      await run("chat-h", "import subprocess\np = subprocess.Popen(['sleep','60'])\nprint('child', p.pid)"),
    );
    expect(outcome.isError).toBe(false);
    const childPid = Number(/child (\d+)/.exec(outcome.content)![1]);
    expect(Number.isFinite(childPid)).toBe(true);

    // Simulate a server crash: SIGKILL the kernel leader; the setsid'd child
    // survives with only the journal recording it.
    const entry = listSupervised().find((item) => item.key === "kernel:chat-h");
    expect(entry).toBeTruthy();
    process.kill(entry!.pid, "SIGKILL");
    await delay(300);

    const reaped = await sweepKernelJournals();
    expect(reaped).toBeGreaterThanOrEqual(1);
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  it("streams bounded view updates", async () => {
    const views: string[] = [];
    const outcome = kernel(
      await run("chat-i", "print('one'); print('two')", { onUpdate: (text) => views.push(text) }),
    );
    expect(outcome.isError).toBe(false);
    expect(views.length).toBeGreaterThan(0);
    expect(views[views.length - 1]).toContain("two");
  });
});
