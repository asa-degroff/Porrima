import { existsSync } from "fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  disposeAllKernels,
  disposeKernel,
  executeInKernel,
  isKernelWedge,
  killKernelJob,
  listKernelJobs,
  sweepKernelJournals,
  tailKernelJob,
  type KernelJobInfo,
  type KernelRunOutcome,
} from "./python-kernel.js";
import { listSupervised } from "./process-supervisor.js";

// The manager consults the global system-pause setting before starting a
// background job; mock it so tests never read or write the real settings DB.
vi.mock("./system-pause.js", () => ({
  getStoredSystemPauseState: async () => ({
    active: false,
    pending: false,
    startedAt: null,
    until: null,
    indefinite: false,
  }),
}));

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
  opts: { timeoutMs?: number; signal?: AbortSignal; onUpdate?: (text: string) => void; background?: boolean } = {},
): Promise<KernelRunOutcome> {
  return executeInKernel({
    chatId,
    cwd: root,
    code,
    timeoutMs: opts.timeoutMs ?? 30_000,
    signal: opts.signal,
    onUpdate: opts.onUpdate,
    background: opts.background,
  });
}

async function waitForJob(
  chatId: string,
  pred: (jobs: KernelJobInfo[]) => boolean,
  timeoutMs = 8000,
): Promise<KernelJobInfo[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const jobs = listKernelJobs(chatId);
    if (pred(jobs)) return jobs;
    await delay(50);
  }
  throw new Error(`job did not settle: ${JSON.stringify(listKernelJobs(chatId))}`);
}

interface KernelOutcome {
  mode: "kernel";
  content: string;
  isError: boolean;
  jobId?: string;
  images?: Array<{ data: string; mimeType: string }>;
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

  it("reaps child groups when a cell dies to an interrupt", async () => {
    const outcome = kernel(
      await run(
        "chat-j",
        "import subprocess, time\np = subprocess.Popen(['sleep','30'])\nprint('child', p.pid)\ntime.sleep(30)",
        { timeoutMs: 500 },
      ),
    );
    expect(outcome.isError).toBe(true);
    const childPid = Number(/child (\d+)/.exec(outcome.content)![1]);
    // Give the reap thread its TERM grace.
    await delay(900);
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  it("leaves child groups when the cell handles the interrupt", async () => {
    const outcome = kernel(
      await run(
        "chat-k",
        "import subprocess, time\np = subprocess.Popen(['sleep','30'])\nprint('child', p.pid)\ntry:\n    time.sleep(30)\nexcept KeyboardInterrupt:\n    pass\nprint('handled')",
        { timeoutMs: 500 },
      ),
    );
    const childPid = Number(/child (\d+)/.exec(outcome.content)![1]);
    expect(outcome.content).toContain("handled");
    // Past the L2 grace: a settled cell must not trigger the escalation.
    await delay(400);
    expect(() => process.kill(childPid, 0)).not.toThrow();
    try {
      process.kill(childPid, "SIGKILL");
    } catch {
      // already gone
    }
  });

  it("ignores external SIGINT; only protocol interrupts cancel cells", async () => {
    const pending = run("chat-l", "import time\ntime.sleep(0.6)\nprint('done')");
    await delay(250);
    const entry = listSupervised().find((item) => item.key === "kernel:chat-l");
    expect(entry).toBeTruthy();
    process.kill(entry!.pid, "SIGINT");
    const outcome = kernel(await pending);
    expect(outcome.isError).toBe(false);
    expect(outcome.content).toContain("done");
  });

  it("throttles live view updates for a fast-printing cell", async () => {
    const views: string[] = [];
    const outcome = kernel(
      await run("chat-m", "for i in range(500):\n    print(i)", { onUpdate: (text) => views.push(text) }),
    );
    expect(outcome.isError).toBe(false);
    // 500 prints must not produce 500 update callbacks; the final result
    // carries the full output regardless.
    expect(views.length).toBeGreaterThan(0);
    expect(views.length).toBeLessThan(50);
  });

  it("streams bounded view updates", async () => {
    const views: string[] = [];
    const outcome = kernel(
      await run("chat-i", "print('one'); print('two')", { onUpdate: (text) => views.push(text) }),
    );
    expect(outcome.isError).toBe(false);
    expect(views.length).toBeGreaterThan(0);
    expect(views[0]).toContain("one");
    // The final result (not the throttled live view) carries the full output.
    expect(outcome.content).toContain("two");
  });

  describe("background jobs", () => {
    it("acks immediately and completes asynchronously", async () => {
      const started = Date.now();
      const ack = kernel(
        await run("job-a", "import time\ntime.sleep(0.4)\nprint('job output')\n11", { background: true }),
      );
      expect(ack.jobId).toBeTruthy();
      expect(Date.now() - started).toBeLessThan(300);

      await waitForJob("job-a", (jobs) => jobs[0]?.status === "done");
      const tail = tailKernelJob("job-a", ack.jobId!, 10);
      expect(tail.found).toBe(true);
      expect(tail.text).toContain("job output");
    });

    it("times out a background job", async () => {
      const ack = kernel(await run("job-b", "import time\ntime.sleep(30)", { background: true, timeoutMs: 400 }));
      expect(ack.jobId).toBeTruthy();
      const jobs = await waitForJob("job-b", (entries) => entries[0]?.status !== "running");
      expect(jobs[0].status).toBe("error");
      expect(jobs[0].timedOut).toBe(true);
    });

    it("kills a background job without losing the kernel", async () => {
      const ack = kernel(await run("job-c", "import time\ntime.sleep(30)", { background: true }));
      expect(killKernelJob("job-c", ack.jobId!).ok).toBe(true);
      await waitForJob("job-c", (entries) => entries[0]?.status !== "running");
      const after = kernel(await run("job-c", "print('alive')"));
      expect(after.isError).toBe(false);
      expect(after.content).toContain("alive");
    });

    it("force-kills the kernel as a last resort", async () => {
      const ack = kernel(await run("job-d", "import time\ntime.sleep(30)", { background: true }));
      expect(killKernelJob("job-d", ack.jobId!, true).ok).toBe(true);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && listKernelJobs("job-d").length > 0) await delay(50);
      expect(listKernelJobs("job-d")).toHaveLength(0);
      // A fresh kernel is created lazily for the next call.
      const after = kernel(await run("job-d", "print('fresh')"));
      expect(after.content).toContain("fresh");
    });

    it("enforces the per-kernel job cap", async () => {
      for (let i = 0; i < 4; i++) {
        const ack = kernel(await run("job-cap", "import time\ntime.sleep(20)", { background: true }));
        expect(ack.jobId).toBeTruthy();
      }
      const fifth = kernel(await run("job-cap", "print('x')", { background: true }));
      expect(fifth.isError).toBe(true);
      expect(fifth.content).toContain("job limit");
    });

    it("enforces the box-wide job cap", async () => {
      for (let i = 0; i < 4; i++) {
        kernel(await run("job-box-a", "import time\ntime.sleep(20)", { background: true }));
        kernel(await run("job-box-b", "import time\ntime.sleep(20)", { background: true }));
      }
      const ninth = kernel(await run("job-box-c", "print('x')", { background: true }));
      expect(ninth.isError).toBe(true);
      expect(ninth.content).toContain("job limit");
    });

    it("rejects a foreground cell while a job runs, then allows it after", async () => {
      kernel(await run("job-fg-a", "import time\ntime.sleep(2)", { background: true }));
      const jobId = listKernelJobs("job-fg-a")[0]?.id;
      expect(jobId).toBeDefined();
      const rejected = kernel(await run("job-fg-a", "print('never queued')"));
      expect(rejected.isError).toBe(true);
      expect(rejected.content).toContain("foreground execution rejected");
      expect(rejected.content).toContain(jobId!);
      expect(rejected.content).toContain("python_jobs");
      const settled = await waitForJob(
        "job-fg-a",
        (jobs) => jobs.every((job) => job.status !== "running"),
      );
      expect(settled[0]?.status).toBe("done");
      const after = kernel(await run("job-fg-a", "print('after')"));
      expect(after.isError).toBe(false);
      expect(after.content).toContain("after");
    });
  });

  describe("snapshot / restore", () => {
    it("snapshots on disposal and restores on the next kernel", async () => {
      await run("p3-a", "x = 42\ndata = {'k': [1, 2, 3]}");
      await delay(1800); // debounce
      await disposeKernel("p3-a"); // flush, keep state for restore

      const outcome = kernel(await run("p3-a", "print(x)\nprint(data['k'])"));
      expect(outcome.content).toContain("restored");
      expect(outcome.content).toContain("42");
      expect(outcome.content).toContain("[1, 2, 3]");
    });

    it("does not overwrite a snapshot after a failed restore", async () => {
      await run("p3-b", "x = 1");
      await delay(1800);
      const payload = join(root, "p3-b", "namespace.pkl");
      await writeFile(payload, "garbage");

      // Crash the kernel so no graceful flush rewrites the payload.
      const entry = listSupervised().find((item) => item.key === "kernel:p3-b");
      expect(entry).toBeTruthy();
      process.kill(entry!.pid, "SIGKILL");
      await delay(300);

      const outcome = kernel(await run("p3-b", "y = 2"));
      expect(outcome.content).toContain("restore failed");
      await delay(1800);
      expect(await readFile(payload, "utf8")).toBe("garbage");
    });

    it("attaches images from emit() display events", async () => {
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      const outcome = kernel(await run("p3-c", `emit({"image/png": "${png}"})`));
      expect(outcome.isError).toBe(false);
      expect(outcome.images).toHaveLength(1);
      expect(outcome.images![0].mimeType).toBe("image/png");
      expect(outcome.images![0].data).toBe(png);
    });

    it("keeps young state directories and their snapshots at startup", async () => {
      await run("p3-keep", "x = 7");
      await delay(1800); // debounce writes namespace.pkl + manifest.json
      const dir = join(root, "p3-keep");
      expect(existsSync(join(dir, "namespace.pkl"))).toBe(true);

      await sweepKernelJournals();
      expect(existsSync(join(dir, "namespace.pkl"))).toBe(true);
      expect(existsSync(join(dir, "manifest.json"))).toBe(true);

      await disposeKernel("p3-keep");
      const outcome = kernel(await run("p3-keep", "print(x)"));
      expect(outcome.content).toContain("restored");
      expect(outcome.content).toContain("7");
    });

    it("expires old state directories at startup", async () => {
      const dir = join(root, "p3-old");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "namespace.pkl"), "old");
      const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
      await utimes(dir, old, old);
      await sweepKernelJournals();
      expect(existsSync(dir)).toBe(false);
    });

    it("does not backfill driver internals and skips emit in snapshots", async () => {
      await run("p3-guard", "x = 5");
      await delay(1800);
      const manifest = JSON.parse(await readFile(join(root, "p3-guard", "manifest.json"), "utf8"));
      expect(manifest.savedNames).toContain("x");
      expect(manifest.savedNames).not.toContain("emit");

      await disposeKernel("p3-guard");
      const outcome = kernel(
        await run(
          "p3-guard",
          "print('main' in globals(), 'PROTOCOL_VERSION' in globals())\nemit({'text/plain': 'ok'})",
        ),
      );
      expect(outcome.content).toContain("restored");
      expect(outcome.content).toContain("False False");
      expect(outcome.isError).toBe(false);
    });
  });
});
