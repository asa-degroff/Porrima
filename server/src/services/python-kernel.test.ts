import { existsSync, readFileSync } from "fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "fs/promises";
import { spawn } from "child_process";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRemoteKernelLaunchLine,
  disposeAllKernels,
  disposeKernel,
  executeInKernel,
  isKernelWedge,
  killKernelJob,
  listKernelJobs,
  localDriverInfo,
  sweepKernelJournals,
  tailKernelJob,
  type KernelHost,
  type KernelJobInfo,
  type KernelRunOutcome,
  type KernelSpawnPlan,
  type KernelToolCallResult,
  type KernelToolDispatcher,
} from "./python-kernel.js";
import { listSupervised } from "./process-supervisor.js";
import { closeJobView, getJobView, initJobView } from "./job-view.js";

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
  initJobView(join(root, "porrima.db"));
  process.env.PORRIMA_KERNEL_ROOT = root;
  // Fast interrupt escalation for tests (driver) and a matching wedge deadline
  // (manager).
  process.env.PORRIMA_KERNEL_L2_GRACE_MS = "300";
  process.env.PORRIMA_KERNEL_WEDGE_GRACE_MS = "1000";
  // The spill store is sandboxed for the whole file, not per test. Set it per
  // test and one test that forgets lands its output in the real tool-output
  // store: the P4b delivery test wrote a 1.3 MB job spill to
  // ~/.porrima/tool-output/r-job/ on every run.
  process.env.PORRIMA_TOOL_OUTPUT_DIR = join(root, "tool-output");
});

afterEach(async () => {
  await disposeAllKernels();
  closeJobView();
  delete process.env.PORRIMA_KERNEL_ROOT;
  delete process.env.PORRIMA_KERNEL_L2_GRACE_MS;
  delete process.env.PORRIMA_KERNEL_WEDGE_GRACE_MS;
  delete process.env.PORRIMA_KERNEL_TOOLS;
  delete process.env.PORRIMA_KERNEL_TOOL_CALLS_MAX;
  delete process.env.PORRIMA_TOOL_OUTPUT_DIR;
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function run(
  chatId: string,
  code: string,
  opts: {
    timeoutMs?: number;
    signal?: AbortSignal;
    onUpdate?: (text: string) => void;
    background?: boolean;
    toolDispatcher?: KernelToolDispatcher;
    host?: KernelHost;
    resultBudgetChars?: number;
  } = {},
): Promise<KernelRunOutcome> {
  return executeInKernel({
    chatId,
    cwd: root,
    code,
    timeoutMs: opts.timeoutMs ?? 30_000,
    signal: opts.signal,
    onUpdate: opts.onUpdate,
    background: opts.background,
    toolDispatcher: opts.toolDispatcher,
    host: opts.host,
    resultBudgetChars: opts.resultBudgetChars,
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

async function waitUntil(
  pred: () => boolean | Promise<boolean>,
  timeoutMs = 8000,
  message = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${message}`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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


  describe("foreground output budgets", () => {
    // The tool-result wrapper head-keeps at max(8000, contextWindow * 4 * 0.15)
    // characters. The cell's inline parts are sized from the same number so the
    // wrapper never has to cut anything — least of all a spill pointer.
    const BUDGET = Math.floor(262144 * 4 * 0.15); // 157,286 at the live window

    function remoteHost(): KernelHost {
      const driver = localDriverInfo();
      if (!driver) throw new Error("driver unavailable");
      // Fake transport, real local driver: only the manager's spill decision
      // keys on host.kind.
      return {
        kind: "ssh:test",
        failureReason: "transport",
        async prepare(chatId: string, cwd: string) {
          const stateDir = join(root, "ssh-fg-state", chatId);
          await mkdir(stateDir, { recursive: true, mode: 0o700 }).catch(() => {});
          return {
            command: process.env.PORRIMA_PYTHON || "python3",
            args: ["-u", driver.path],
            cwd,
            env: { ...process.env, PORRIMA_KERNEL_DIR: stateDir, PYTHONDONTWRITEBYTECODE: "1" },
            stateDir,
            driverHash: driver.hash,
          };
        },
        async readSnapshotManifest() {
          return null;
        },
        async statMtime() {
          return null;
        },
        async removeState() {},
      };
    }

    it("fits a chatty cell inside the wrapper budget with the pointers first", async () => {
      const outcome = kernel(
        await run("fg-window", 'print("A" * 2_000_000)\nprint("B" * 200_000)', {
          resultBudgetChars: BUDGET,
        }),
      );
      expect(outcome.isError).toBe(false);
      expect(outcome.content.length).toBeLessThanOrEqual(BUDGET);
      expect(outcome.content.startsWith("[output truncated")).toBe(true);
      const path = outcome.content.match(/full output -> (\S+)/)?.[1];
      expect(path).toBeTruthy();
      // The pointer the model is handed is a file that holds the whole stream.
      const saved = readFileSync(path!, "utf8");
      expect(saved.length).toBeGreaterThanOrEqual(2_000_000);
      expect(saved).toContain("B".repeat(1000));
    });

    it("keeps the pointer header ahead of a traceback", async () => {
      const outcome = kernel(
        await run("fg-raise", 'print("C" * 1_500_000)\nraise ValueError("boom")', {
          resultBudgetChars: BUDGET,
        }),
      );
      expect(outcome.isError).toBe(true);
      expect(outcome.content.length).toBeLessThanOrEqual(BUDGET);
      // The head the wrapper keeps starts with where the output actually is.
      expect(outcome.content.slice(0, 1024)).toContain("full output ->");
      expect(outcome.content).toContain("ValueError: boom");
    });

    it("spills a sub-ceiling stream when the render allowance trims it", async () => {
      const outcome = kernel(
        await run(
          "fg-trim",
          [
            "import sys",
            'print("A" * 80000)',
            'print("B" * 2000, file=sys.stderr)',
            '"R" * 5000',
          ].join("\n"),
          { resultBudgetChars: BUDGET },
        ),
      );
      expect(outcome.isError).toBe(false);
      expect(outcome.content.startsWith("[output truncated")).toBe(true);
      // 80 KB is under the 100 KiB capture ceiling, so without the render-time
      // spill the pointer could only say "no copy was written".
      const path = outcome.content.match(/stdout: .*full output -> (\S+)/)?.[1];
      expect(path).toBeTruthy();
      expect(readFileSync(path!, "utf8").length).toBeGreaterThanOrEqual(80_000);
    });

    it("streams a live view far smaller than the settled window", async () => {
      process.env.PORRIMA_TOOL_OUTPUT_DIR = join(root, "tool-output-fg-view");
      const views: string[] = [];
      const outcome = kernel(
        await run("fg-view", "for i in range(20000):\n    print('x' * 200)", {
          onUpdate: (text) => views.push(text),
        }),
      );
      expect(outcome.isError).toBe(false);
      expect(views.length).toBeGreaterThan(1);
      // Each tick ships the view, not the window: the cost of a chatty cell is
      // its duration, not duration x window.
      expect(Math.max(...views.map((v) => v.length))).toBeLessThanOrEqual(16 * 1024 * 2 + 32);
    });

    it("stops forwarding at the driver's per-cell ceiling", async () => {
      process.env.PORRIMA_TOOL_OUTPUT_DIR = join(root, "tool-output-fg-cap");
      process.env.PORRIMA_KERNEL_MAX_CELL_STREAM_BYTES = "1048576"; // 1MB
      try {
        const outcome = kernel(
          await run("fg-cap", 'print("D" * 3_000_000)', { resultBudgetChars: BUDGET }),
        );
        expect(outcome.isError).toBe(false);
        expect(outcome.content).toContain("output-forwarding cap");
        // 3MB printed, 1MB forwarded: the reported total is the forwarded total.
        expect(outcome.content).toContain("1MB total");
      } finally {
        delete process.env.PORRIMA_KERNEL_MAX_CELL_STREAM_BYTES;
      }
    });

    it("truncates a remote cell honestly — no pointer into the server-local store", async () => {
      process.env.PORRIMA_TOOL_OUTPUT_DIR = join(root, "tool-output-ssh-fg");
      const outcome = kernel(
        await run("ssh-fg", 'print("E" * 500_000)', {
          resultBudgetChars: BUDGET,
          host: remoteHost(),
        }),
      );
      expect(outcome.isError).toBe(false);
      expect(outcome.content).toContain("no copy was written (the kernel runs on another host)");
      expect(outcome.content).not.toContain("read_file");
      expect(outcome.content).not.toContain(process.env.PORRIMA_TOOL_OUTPUT_DIR!);
      expect(existsSync(join(process.env.PORRIMA_TOOL_OUTPUT_DIR!, "ssh-fg"))).toBe(false);
    });
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

    it("records the background cell in the job view", async () => {
      const ack = kernel(
        await run("job-view", "import time\ntime.sleep(0.2)\nprint('cell-view')", {
          background: true,
        }),
      );
      expect(ack.jobId).toBeTruthy();
      await waitForJob("job-view", (jobs) => jobs[0]?.status === "done");
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && getJobView(ack.jobId!)?.state !== "finished") {
        await delay(50);
      }
      const view = getJobView(ack.jobId!);
      expect(view?.state).toBe("finished");
      expect(view?.source).toBe("kernel");
      expect(view?.command).toContain("cell-view");
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
      expect(rejected.content).toContain("jobs");
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

  // -------------------------------------------------------------------------
  // Remote kernel host (docs/design/remote-python-kernel.md, P4a)
  //
  // FakeRemoteHost reproduces the SSH host contract without a network:
  // prepare() stages the driver into a fake home and returns a launch plan
  // that runs the REAL buildRemoteKernelLaunchLine through bash — exercising
  // the quoting, the PORRIMA_KERNEL_DIR prefix, host-side state placement,
  // the driver boot self-heal, and the manager's host seam (manifest stat,
  // removeState, fallback reason).
  // -------------------------------------------------------------------------
  describe("remote kernel host (P4a)", () => {
    let home: string;

    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), "porrima-sshhome-"));
    });

    afterEach(async () => {
      await rm(home, { recursive: true, force: true });
    });

    const stagedDriver = (h: string) => join(h, ".porrima", "kernel", "porrima_kernel.py");
    const remoteStateDir = (h: string, chatId: string) => join(h, ".porrima", "kernels", chatId);
    // The pidfile is compact JSON {"pid": int, "startId": str} (legacy files
    // hold a bare pid); startId is the identity guard for the predecessor
    // kill (remote-python-kernel.md §4.4).
    const readPidfile = async (stateDir: string): Promise<{ pid: number; startId: string | null }> => {
      const raw = (await readFile(join(stateDir, "kernel.pid"), "utf8").catch(() => "")).trim();
      try {
        const record = JSON.parse(raw);
        if (record && typeof record.pid === "number") {
          return { pid: record.pid, startId: typeof record.startId === "string" ? record.startId : null };
        }
      } catch {
        /* legacy bare-pid format */
      }
      return { pid: Number(raw), startId: null };
    };

    function makeRemoteHost(opts: { tamperHash?: string; skipStage?: boolean } = {}): KernelHost {
      return {
        kind: "ssh:fake-host",
        failureReason: "transport",
        async prepare(chatId: string): Promise<KernelSpawnPlan | null> {
          const driver = localDriverInfo();
          if (!driver) return null;
          const target = stagedDriver(home);
          if (!opts.skipStage) {
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, driver.text);
          }
          const stateDir = remoteStateDir(home, chatId);
          const line = buildRemoteKernelLaunchLine({
            root: home,
            pythonPath: process.env.PORRIMA_PYTHON || "python3",
            driverPath: target,
            stateDir,
          });
          return {
            command: "bash",
            args: ["-c", line],
            cwd: process.cwd(),
            env: { ...process.env },
            stateDir,
            driverHash: opts.tamperHash ?? driver.hash,
          };
        },
        async readSnapshotManifest(stateDir: string): Promise<string | null> {
          const payload = join(stateDir, "namespace.pkl");
          const manifest = join(stateDir, "manifest.json");
          if (!existsSync(payload) || !existsSync(manifest)) return null;
          return readFile(manifest, "utf8").catch(() => null);
        },
        async statMtime(path: string): Promise<number | null> {
          return (await stat(path).catch(() => null))?.mtimeMs ?? null;
        },
        async removeState(chatId: string): Promise<void> {
          await rm(remoteStateDir(home, chatId), { recursive: true, force: true }).catch(() => {});
        },
        // P4b: mirrors the ssh host contract — output lands inside the
        // "workspace" (the fake home) and the footer is workspace-relative.
        async deliverJobOutput(chatId: string, jobId: string, content: string): Promise<string | null> {
          const rel = `.porrima-tool-output/py-${jobId.slice(0, 8)}.txt`;
          const abs = join(home, ".porrima-tool-output", `py-${jobId.slice(0, 8)}.txt`);
          await mkdir(dirname(abs), { recursive: true });
          await writeFile(abs, content);
          return rel;
        },
      };
    }

    function remoteRun(
      chatId: string,
      code: string,
      host: KernelHost,
      opts: { timeoutMs?: number; background?: boolean } = {},
    ): Promise<KernelRunOutcome> {
      return executeInKernel({
        chatId,
        cwd: `ssh:fake-host:${home}`,
        code,
        timeoutMs: opts.timeoutMs ?? 30_000,
        background: opts.background,
        host,
      });
    }

    it("builds a launch line that survives hostile path characters", () => {
      const line = buildRemoteKernelLaunchLine({
        root: `/it's a "root"`,
        pythonPath: "python3",
        driverPath: `/home/u/.porrima/kernel/porrima_kernel.py`,
        stateDir: `/home/u/.porrima/kernels/automation:abc`,
      });
      expect(line).toContain(`cd -- '/it'\\''s a "root"'`);
      expect(line).toContain(`PORRIMA_KERNEL_DIR='/home/u/.porrima/kernels/automation:abc'`);
      expect(line).toContain(`PYTHONDONTWRITEBYTECODE=1 'python3' -u '/home/u/.porrima/kernel/porrima_kernel.py'`);
      // Functional proof: the quoted cd actually works with the apostrophe.
      expect(line.startsWith(`cd -- `)).toBe(true);
    }, 10_000);

    it("runs a foreground cell through the host plan with host-side state (§4.2)", async () => {
      const outcome = kernel(await remoteRun("r-1", "print(6*7)", makeRemoteHost()));
      expect(outcome.content).toContain("42");
      // Staged driver and boot artifacts live in the HOST tree, never the
      // local kernel root (PORRIMA_KERNEL_ROOT above).
      expect(existsSync(stagedDriver(home))).toBe(true);
      await waitUntil(() => existsSync(join(remoteStateDir(home, "r-1"), "kernel.pid")), 8000, "host pidfile");
      expect(existsSync(join(root, "r-1"))).toBe(false);
      await disposeKernel("r-1");
    }, 30_000);

    it("persists the namespace across host kernel generations via snapshot/restore (§3.2)", async () => {
      kernel(await remoteRun("r-2", "answer = 40 + 2", makeRemoteHost()));
      await disposeKernel("r-2", {});
      expect(existsSync(join(remoteStateDir(home, "r-2"), "namespace.pkl"))).toBe(true);

      const second = kernel(await remoteRun("r-2", "print(answer)", makeRemoteHost()));
      expect(second.content).toContain("restored");
      expect(second.content).toContain("42");
      await disposeKernel("r-2", { removeState: true });
      // removeState goes through the host handle (§4.4).
      expect(existsSync(remoteStateDir(home, "r-2"))).toBe(false);
    }, 30_000);

    it("degrades driver skew to the transport fallback, unstickily (§4.3, §4.9)", async () => {
      const skewed = await remoteRun("r-3", "print(1)", makeRemoteHost({ tamperHash: "deadbeefdeadbeef" }));
      expect(skewed).toEqual({ mode: "fallback", reason: "transport" });

      // Skew is stale staging, not protocol corruption: the next clean
      // attempt must get a real kernel, not a permanent disable.
      const ok = await remoteRun("r-3", "print(1)", makeRemoteHost());
      expect(ok.mode).toBe("kernel");
      await disposeKernel("r-3", { removeState: true });
    }, 30_000);

    it("delivers background job output model-side over the host (§4.6, P4b)", async () => {
      const ack = kernel(await remoteRun("r-job", 'print("x" * 1_300_000)', makeRemoteHost(), { background: true }));
      expect(ack.isError).toBe(false);
      expect(ack.jobId).toBeTruthy();
      const jobId = ack.jobId!;

      // Delivery happens after the status flip inside finishJob — wait on the
      // view carrying the host-relative path, not just the status.
      const jobs = await waitForJob("r-job", (js) => js.some((j) => j.id === jobId && j.status !== "running" && j.spillPath), 30_000);
      const job = jobs.find((j) => j.id === jobId)!;
      expect(job.status).toBe("done");
      // The footer is the HOST-relative path — the server-local capture
      // spill must never surface for a remote job.
      expect(job.spillPath).toBe(`.porrima-tool-output/py-${jobId.slice(0, 8)}.txt`);

      const delivered = join(home, ".porrima-tool-output", `py-${jobId.slice(0, 8)}.txt`);
      await waitUntil(() => existsSync(delivered), 5000, "delivered spill file");
      expect((await readFile(delivered, "utf8")).length).toBeGreaterThan(1_000_000);

      await disposeKernel("r-job", { removeState: true });
    }, 60_000);

    it("boot self-heal kills a predecessor holding the same state dir (§4.4)", async () => {
      const driver = localDriverInfo();
      expect(driver).not.toBeNull();
      const stateDir = remoteStateDir(home, "r-guard");
      const target = stagedDriver(home);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, driver!.text);
      const line = buildRemoteKernelLaunchLine({
        root: home,
        pythonPath: process.env.PORRIMA_PYTHON || "python3",
        driverPath: target,
        stateDir,
      });

      // stdio[0] stays an OPEN pipe: stdin EOF makes the driver shut down by
      // design, so a raw-spawned test driver must keep its "channel" alive.
      const first = spawn("bash", ["-c", line], { stdio: ["pipe", "ignore", "ignore"], detached: true });
      try {
        const pidfile = join(stateDir, "kernel.pid");
        await waitUntil(() => existsSync(pidfile), 15_000, "first driver pidfile");
        const firstRecord = await readPidfile(stateDir);
        expect(firstRecord.pid).toBeGreaterThan(0);
        expect(pidAlive(firstRecord.pid)).toBe(true);
        // The identity guard ships with the pidfile: the first driver must
        // have recorded its own start id (what the second generation matches).
        expect(firstRecord.startId).toBeTruthy();

        const second = spawn("bash", ["-c", line], { stdio: ["pipe", "ignore", "ignore"], detached: true });
        await waitUntil(async () => {
          const { pid } = await readPidfile(stateDir);
          return pid !== firstRecord.pid && pidAlive(pid);
        }, 15_000, "second driver to take over");
        expect(pidAlive(firstRecord.pid)).toBe(false);

        const finalPid = (await readPidfile(stateDir)).pid;
        try { process.kill(finalPid, "SIGKILL"); } catch { /* gone */ }
      } finally {
        try { first.kill(); } catch { /* already exited */ }
      }
    }, 40_000);

    it("boot self-heal spares a recycled pidfile pid (identity, not liveness, §4.4)", async () => {
      const driver = localDriverInfo();
      expect(driver).not.toBeNull();
      const stateDir = remoteStateDir(home, "r-recycled");
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      const target = stagedDriver(home);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, driver!.text);
      const line = buildRemoteKernelLaunchLine({
        root: home,
        pythonPath: process.env.PORRIMA_PYTHON || "python3",
        driverPath: target,
        stateDir,
      });

      // A live stranger whose pid is planted in the pidfile with a start id
      // no live process can have — the exact state of a recycled pid after
      // the predecessor died and the number was reused.
      const stranger = spawn(process.env.PORRIMA_PYTHON || "python3", ["-c", "import time; time.sleep(30)"], { stdio: "ignore", detached: true });
      let first: ReturnType<typeof spawn> | undefined;
      try {
        expect(stranger.pid).toBeGreaterThan(0);
        // Planted BEFORE the driver spawns: boot self-heal reads the
        // pidfile at boot, so the planted record must be in place.
        await writeFile(join(stateDir, "kernel.pid"), JSON.stringify({ pid: stranger.pid, startId: "proc:0" }));
        first = spawn("bash", ["-c", line], { stdio: ["pipe", "ignore", "ignore"], detached: true });
        await waitUntil(async () => {
          const { pid } = await readPidfile(stateDir);
          return pid !== stranger.pid && pidAlive(pid);
        }, 15_000, "fresh driver to rewrite the pidfile");
        // A start-id mismatch means the live pid is a stranger, not our
        // predecessor — boot self-heal must leave it alone.
        expect(pidAlive(stranger.pid!)).toBe(true);
        const finalPid = (await readPidfile(stateDir)).pid;
        try { process.kill(finalPid, "SIGKILL"); } catch { /* gone */ }
      } finally {
        try { process.kill(stranger.pid!, "SIGKILL"); } catch { /* gone */ }
        try { first?.kill(); } catch { /* already exited */ }
      }
    }, 40_000);

    it("boot self-heal spares a legacy bare-pid file pointing at a non-driver (§4.4)", async () => {
      const driver = localDriverInfo();
      expect(driver).not.toBeNull();
      const stateDir = remoteStateDir(home, "r-legacy");
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      const target = stagedDriver(home);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, driver!.text);
      const line = buildRemoteKernelLaunchLine({
        root: home,
        pythonPath: process.env.PORRIMA_PYTHON || "python3",
        driverPath: target,
        stateDir,
      });

      // Legacy format (pre-identity-guard): a bare pid of a live process
      // whose argv is not the staged driver — no positive identity match.
      const stranger = spawn(process.env.PORRIMA_PYTHON || "python3", ["-c", "import time; time.sleep(30)"], { stdio: "ignore", detached: true });
      let first: ReturnType<typeof spawn> | undefined;
      try {
        expect(stranger.pid).toBeGreaterThan(0);
        // Planted BEFORE the driver spawns (same ordering constraint).
        await writeFile(join(stateDir, "kernel.pid"), String(stranger.pid));
        first = spawn("bash", ["-c", line], { stdio: ["pipe", "ignore", "ignore"], detached: true });
        await waitUntil(async () => {
          const { pid } = await readPidfile(stateDir);
          return pid !== stranger.pid && pidAlive(pid);
        }, 15_000, "fresh driver to rewrite the pidfile");
        expect(pidAlive(stranger.pid!)).toBe(true);
        const finalPid = (await readPidfile(stateDir)).pid;
        try { process.kill(finalPid, "SIGKILL"); } catch { /* gone */ }
      } finally {
        try { process.kill(stranger.pid!, "SIGKILL"); } catch { /* gone */ }
        try { first?.kill(); } catch { /* already exited */ }
      }
    }, 40_000);

    it("boot self-heal reaps journaled children of a crashed kernel (§4.4)", async () => {
      const stateDir = remoteStateDir(home, "r-sweep");
      await mkdir(stateDir, { recursive: true, mode: 0o700 });

      // An orphaned child as the "previous kernel's child", plus a torn tail
      // line the reader must tolerate (§4.15). Node's `detached` spawn runs
      // setsid(2) itself, so the child leads its own group (pgid == pid) —
      // exactly what the Popen patch journals.
      const sleeper = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
      const sleeperPid = sleeper.pid!;
      expect(pidAlive(sleeperPid)).toBe(true);
      const statText = readFileSync(`/proc/${sleeperPid}/stat`, "utf8");
      const startId = `proc:${statText.slice(statText.lastIndexOf(")") + 2).split(" ")[19]}`;
      await writeFile(
        join(stateDir, "children.jsonl"),
        `${JSON.stringify({ version: 1, pid: sleeperPid, pgid: sleeperPid, startId, cell: null, active: true, recordedAt: new Date().toISOString() })}\n{"version":1,"pi`,
      );

      kernel(await remoteRun("r-sweep", "print('booted')", makeRemoteHost()));
      await waitUntil(() => !pidAlive(sleeperPid), 10_000, "stale journaled child to be reaped");
      await waitUntil(async () => (await readFile(join(stateDir, "children.jsonl"), "utf8")).length === 0, 5_000, "journal truncate");
      await disposeKernel("r-sweep", { removeState: true });
    }, 60_000);
  });
});

// ---------------------------------------------------------------------------
// In-kernel tool composition — the protocol v2 reverse RPC channel
// (docs/design/kernel-codemode.md §4.8/§4.9, Phase A slice 0).
// ---------------------------------------------------------------------------

describe("kernel tools (protocol v2)", () => {
  it("round-trips a tool call through the reverse RPC channel", async () => {
    process.env.PORRIMA_KERNEL_TOOLS = "1";
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const dispatcher: KernelToolDispatcher = {
      tools: ["read_file"],
      call: async (tool, args): Promise<KernelToolCallResult> => {
        calls.push({ tool, args });
        return { ok: true, value: `content of ${String(args.path)}` };
      },
    };
    const outcome = kernel(
      await run("ktools-a", 'text = await tools.read_file(path="hello.txt")\nprint(text)', { toolDispatcher: dispatcher }),
    );
    expect(outcome.isError).toBe(false);
    expect(outcome.content).toContain("content of hello.txt");
    expect(calls).toEqual([{ tool: "read_file", args: { path: "hello.txt" } }]);
  });

  it("round-trips a structured value: JSON on the wire, a real dict in the cell (value_json)", async () => {
    process.env.PORRIMA_KERNEL_TOOLS = "1";
    // The code_search projection shape (docs/design/code-search.md §3.3):
    // the manager JSON-stringifies non-string values and flags value_json;
    // the driver decodes so the cell computes on a dict, not a string.
    const dispatcher: KernelToolDispatcher = {
      tools: ["code_search"],
      call: async (): Promise<KernelToolCallResult> => ({
        ok: true,
        value: { totalMatches: 2, matches: [{ file: "a.ts", text: "fn a() {}" }], unscanned: { py: 1 } },
      }),
    };
    const outcome = kernel(
      await run(
        "ktools-struct",
        [
          'out = await tools.code_search(pattern="function $NAME")',
          'assert isinstance(out, dict), f"cell got {type(out).__name__}, want dict"',
          'print(out["totalMatches"], out["matches"][0]["file"], out["unscanned"]["py"])',
        ].join("\n"),
        { toolDispatcher: dispatcher },
      ),
    );
    expect(outcome.isError).toBe(false);
    expect(outcome.content).toContain("2 a.ts 1");
  });

  it("exposes no tools namespace when the flag is off", async () => {
    const dispatcher: KernelToolDispatcher = {
      tools: ["read_file"],
      call: async (): Promise<KernelToolCallResult> => ({ ok: true, value: "x" }),
    };
    // PORRIMA_KERNEL_TOOLS unset: the manager never sends the tools field,
    // the driver builds nothing, the cell hits NameError — dark launch.
    const outcome = kernel(
      await run("ktools-b", 'await tools.read_file(path="x")', { toolDispatcher: dispatcher }),
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("NameError");
  });

  it("raises dispatcher rejections into the calling cell as KernelToolError", async () => {
    process.env.PORRIMA_KERNEL_TOOLS = "1";
    const dispatcher: KernelToolDispatcher = {
      tools: ["read_file"],
      call: async (): Promise<KernelToolCallResult> => ({ ok: false, error: "dispatcher refused: test policy" }),
    };
    const outcome = kernel(
      await run("ktools-c", 'await tools.read_file(path="x")', { toolDispatcher: dispatcher }),
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("KernelToolError");
    expect(outcome.content).toContain("dispatcher refused: test policy");
  });

  it("aborts the in-flight dispatch when the cell dies to the interrupt ladder", async () => {
    process.env.PORRIMA_KERNEL_TOOLS = "1";
    let sawAbort = false;
    const dispatcher: KernelToolDispatcher = {
      tools: ["read_file"],
      call: (_tool, _args, signal): Promise<KernelToolCallResult> =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            sawAbort = true;
            resolve({ ok: false, error: "aborted" });
          });
        }),
    };
    const controller = new AbortController();
    const pending = run("ktools-d", 'await tools.read_file(path="forever")', {
      signal: controller.signal,
      timeoutMs: 15_000,
      toolDispatcher: dispatcher,
    });
    setTimeout(() => controller.abort(), 300);
    const outcome = kernel(await pending);
    expect(outcome.isError).toBe(true);
    await waitUntil(() => sawAbort, 8000, "dispatcher signal abort");

    // The namespace survives (same contract as any interrupted cell).
    const after = kernel(
      await run("ktools-d", 'x = 7\nprint("alive", x)', { toolDispatcher: dispatcher }),
    );
    expect(after.isError).toBe(false);
    expect(after.content).toContain("alive 7");
  });

  it("serializes kernel-origin calls on the per-kernel FIFO", async () => {
    process.env.PORRIMA_KERNEL_TOOLS = "1";
    const events: string[] = [];
    const dispatcher: KernelToolDispatcher = {
      tools: ["read_file"],
      call: async (tool, args): Promise<KernelToolCallResult> => {
        events.push(`start:${String(args.path)}`);
        await delay(30);
        events.push(`end:${String(args.path)}`);
        return { ok: true, value: "v" };
      },
    };
    const outcome = kernel(
      await run(
        "ktools-e",
        'import asyncio\nawait asyncio.gather(tools.read_file(path="a"), tools.read_file(path="b"), tools.read_file(path="c"))',
        { toolDispatcher: dispatcher },
      ),
    );
    expect(outcome.isError).toBe(false);
    // Strict alternation: no two dispatches ever overlap (gather included).
    expect(events).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
  });

  it("enforces the per-cell call budget server-side", async () => {
    process.env.PORRIMA_KERNEL_TOOLS = "1";
    process.env.PORRIMA_KERNEL_TOOL_CALLS_MAX = "3";
    let dispatched = 0;
    const dispatcher: KernelToolDispatcher = {
      tools: ["read_file"],
      call: async (): Promise<KernelToolCallResult> => {
        dispatched++;
        return { ok: true, value: "v" };
      },
    };
    const outcome = kernel(
      await run(
        "ktools-f",
        'for i in range(4):\n    await tools.read_file(path=str(i))\nprint("done")',
        { toolDispatcher: dispatcher },
      ),
    );
    expect(outcome.isError).toBe(true);
    expect(dispatched).toBe(3);
    expect(outcome.content).toContain("budget exhausted");
  });

  it("dispatches from a background job keyed on the jobId", async () => {
    process.env.PORRIMA_KERNEL_TOOLS = "1";
    const dispatcher: KernelToolDispatcher = {
      tools: ["read_file"],
      call: async (_tool, args): Promise<KernelToolCallResult> => ({
        ok: true,
        value: `job-read:${String(args.path)}`,
      }),
    };
    const ack = kernel(
      await run(
        "ktools-g",
        'r = await tools.read_file(path="late")\nprint(r)',
        { background: true, toolDispatcher: dispatcher },
      ),
    );
    expect(ack.isError).toBe(false);
    expect(ack.jobId).toBeTruthy();
    await waitForJob("ktools-g", (jobs) => jobs.some((j) => j.status !== "running"));
    const tail = tailKernelJob("ktools-g", ack.jobId!, 40);
    expect(tail.found).toBe(true);
    expect(tail.text).toContain("job-read:late");
  });

  it("fails a kernel exit with outstanding dispatches cleanly (proc.exited cleanup)", async () => {
    process.env.PORRIMA_KERNEL_TOOLS = "1";
    const dispatcher: KernelToolDispatcher = {
      tools: ["read_file"],
      // Never resolves on its own; only the abort branch ends it.
      call: (_tool, _args, signal): Promise<KernelToolCallResult> =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ ok: false, error: "aborted" }));
        }),
    };
    const pending = run("ktools-h", 'await tools.read_file(path="hang")', {
      timeoutMs: 4_000,
      toolDispatcher: dispatcher,
    });
    // Force the kernel away underneath the awaited call: L3 dispose.
    await delay(300);
    await disposeKernel("ktools-h", { force: true });
    const outcome = kernel(await pending);
    expect(outcome.isError).toBe(true);
  });

  it("spills oversize results to the tool-output store and hands the cell a reference", async () => {
    process.env.PORRIMA_KERNEL_TOOLS = "1";
    process.env.PORRIMA_TOOL_OUTPUT_DIR = join(root, "tool-output");
    const big = "A".repeat(1_200_000); // over the spill threshold, under the inline cap
    const dispatcher: KernelToolDispatcher = {
      tools: ["web_fetch"],
      call: async (): Promise<KernelToolCallResult> => ({ ok: true, value: big }),
    };
    const code = [
      'r = await tools.web_fetch(url="https://example.test")',
      'print(type(r).__name__, r["spilled"], r["total_chars"])',
      'd = open(r["path"]).read()',
      'print("file", len(d), d == "A" * 1200000)',
      'print("head", len(r["head"]))',
    ].join("\n");
    const outcome = kernel(await run("ktools-spill", code, { toolDispatcher: dispatcher }));
    expect(outcome.isError).toBe(false);
    expect(outcome.content).toContain("dict True 1200000");
    expect(outcome.content).toContain("file 1200000 True");
    expect(outcome.content).toContain("head 4096");
    // The spill file lives in the shared store (retention inherits the
    // 64-per-chat / 24 h sweep rules).
    expect(existsSync(join(root, "tool-output", "ktools-spill"))).toBe(true);
  });

  it("keeps remote results inline-capped with the truncation marker — §4.9 carve-out", async () => {
    process.env.PORRIMA_KERNEL_TOOLS = "1";
    process.env.PORRIMA_TOOL_OUTPUT_DIR = join(root, "tool-output-ssh");
    const driver = localDriverInfo();
    if (!driver) throw new Error("driver unavailable");
    // Fake transport: kind says remote, but the process is the local driver —
    // only the manager's spill decision keys on host.kind (§4.9).
    const host: KernelHost = {
      kind: "ssh:test",
      failureReason: "transport",
      async prepare(chatId: string, cwd: string) {
        const stateDir = join(root, "ssh-state", chatId);
        await mkdir(stateDir, { recursive: true, mode: 0o700 }).catch(() => {});
        return {
          command: process.env.PORRIMA_PYTHON || "python3",
          args: ["-u", driver.path],
          cwd,
          env: { ...process.env, PORRIMA_KERNEL_DIR: stateDir, PYTHONDONTWRITEBYTECODE: "1" },
          stateDir,
          driverHash: driver.hash,
        };
      },
      async readSnapshotManifest() {
        return null;
      },
      async statMtime() {
        return null;
      },
      async removeState() {},
    };
    const huge = "B".repeat(2_200_000);
    const dispatcher: KernelToolDispatcher = {
      tools: ["web_fetch"],
      call: async (): Promise<KernelToolCallResult> => ({ ok: true, value: huge }),
    };
    const outcome = kernel(
      await run("ktools-ssh", 'r = await tools.web_fetch(url="x")\nprint(type(r).__name__)\nprint(r[-60:])', {
        toolDispatcher: dispatcher,
        host,
      }),
    );
    expect(outcome.isError).toBe(false);
    expect(outcome.content).toContain("str"); // never a spill dict on remote
    expect(outcome.content).toContain("[truncated: 2000000 of 2200000 chars]");
    const dir = join(root, "tool-output-ssh", "ktools-ssh");
    const names = existsSync(dir) ? await readdir(dir) : [];
    expect(names.filter((n) => n.startsWith("kernel-"))).toEqual([]);
  });

  it("delivers background job output to a remote host that owns delivery (P4b path)", async () => {
    process.env.PORRIMA_KERNEL_TOOLS = "1";
    process.env.PORRIMA_TOOL_OUTPUT_DIR = join(root, "tool-output-ssh");
    const driver = localDriverInfo();
    if (!driver) throw new Error("driver unavailable");
    let delivered: { jobId: string; content: string } | null = null;
    const host: KernelHost = {
      kind: "ssh:test",
      failureReason: "transport",
      async prepare(chatId: string, cwd: string) {
        const stateDir = join(root, "ssh-state", chatId);
        await mkdir(stateDir, { recursive: true, mode: 0o700 }).catch(() => {});
        return {
          command: process.env.PORRIMA_PYTHON || "python3",
          args: ["-u", driver.path],
          cwd,
          env: { ...process.env, PORRIMA_KERNEL_DIR: stateDir, PYTHONDONTWRITEBYTECODE: "1" },
          stateDir,
          driverHash: driver.hash,
        };
      },
      async readSnapshotManifest() {
        return null;
      },
      async statMtime() {
        return null;
      },
      async removeState() {},
      // P4b host with delivery capability: oversize job output lands on the
      // (here: local) "workspace" as a workspace-relative path.
      async deliverJobOutput(chatId: string, jobId: string, content: string) {
        delivered = { jobId, content };
        return `.porrima-tool-output/py-${jobId.slice(0, 8)}.txt`;
      },
    };
    const ack = kernel(await run("ktools-ssh-job", 'print("B" * 1_500_000)', { background: true, host }));
    expect(ack.jobId).toBeTruthy();
    await waitForJob("ktools-ssh-job", (jobs) => jobs.some((j) => j.status !== "running"), 20_000);
    expect(delivered).toBeTruthy();
    expect(delivered!.jobId).toBe(ack.jobId);
    expect(delivered!.content).toContain("BBBBB");
    // The view carries the workspace-relative delivered path, never the
    // server-local spill (§4.6).
    const jobs = listKernelJobs("ktools-ssh-job");
    expect(jobs[0]?.spillPath).toBe(`.porrima-tool-output/py-${ack.jobId!.slice(0, 8)}.txt`);
  });
});
