import { existsSync, readFileSync } from "fs";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "fs/promises";
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
        const firstPid = Number(await readFile(pidfile, "utf8"));
        expect(firstPid).toBeGreaterThan(0);
        expect(pidAlive(firstPid)).toBe(true);

        const second = spawn("bash", ["-c", line], { stdio: ["pipe", "ignore", "ignore"], detached: true });
        await waitUntil(async () => {
          const pid = Number(await readFile(pidfile, "utf8").catch(() => "0"));
          return pid !== firstPid && pidAlive(pid);
        }, 15_000, "second driver to take over");
        expect(pidAlive(firstPid)).toBe(false);

        const finalPid = Number(await readFile(pidfile, "utf8"));
        try { process.kill(finalPid, "SIGKILL"); } catch { /* gone */ }
      } finally {
        try { first.kill(); } catch { /* already exited */ }
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
