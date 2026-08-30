import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TTSWorker } from "../services/tts-worker-pool.js";
import type { TTSSettings } from "../types/tts.js";

// The worker pool spawns `resolveTtsPython(backend)` with the worker script.
// Point it at node itself with our fake protocol worker (fixture below), so
// tests exercise the real spawn/protocol/reset machinery without kokoro.
vi.mock("../services/tts-python.js", () => ({
  resolveTtsPython: vi.fn(async () => ({
    pythonPath: process.execPath,
    source: "test-fake",
    requiredImports: [],
  })),
  getTtsPythonStatus: vi.fn(async () => ({
    available: true,
    pythonPath: process.execPath,
    source: "test-fake",
    requiredImports: [],
  })),
}));

const FAKE_WORKER = fileURLToPath(new URL("./fixtures/tts-fake-worker.mjs", import.meta.url));
const SETTINGS = {} as TTSSettings;

let countFile = "";
const workers: TTSWorker[] = [];

beforeEach(() => {
  countFile = join(mkdtempSync(join(tmpdir(), "tts-worker-")), "spawns");
  process.env.FAKE_WORKER_COUNT_FILE = countFile;
});

function makeWorker(requestTimeoutMs?: number): TTSWorker {
  const w = new TTSWorker("kokoro", { scriptPath: FAKE_WORKER, requestTimeoutMs });
  workers.push(w);
  return w;
}

function spawnCount(): number {
  if (!existsSync(countFile)) return 0;
  return readFileSync(countFile, "utf8").trim().split("\n").filter(Boolean).length;
}

async function waitUntil(fn: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

afterEach(async () => {
  for (const w of workers.splice(0)) {
    w.destroy();
  }
  await new Promise((r) => setTimeout(r, 150)); // let SIGTERM land
  rmSync(countFile, { force: true });
  delete process.env.FAKE_WORKER_COUNT_FILE;
});

describe("TTSWorker (fake protocol worker)", () => {
  it("synthesizes through the JSON-lines protocol", async () => {
    const w = makeWorker();
    await w.initialize();
    expect(w.ready).toBe(true);

    const result = await w.synthesize({ text: "hello world", settings: SETTINGS });
    expect(Buffer.from(result.audioBase64, "base64").toString()).toContain("fake-audio");
    expect(result.duration).toBe(1.0);
    expect(result.sampleRate).toBe(24000);
  });

  it("spawns exactly one process under concurrent initialize()", async () => {
    const w = makeWorker();
    await Promise.all([w.initialize(), w.initialize(), w.initialize()]);
    expect(spawnCount()).toBe(1);
    expect(w.ready).toBe(true);
  });

  it("re-initializes after a failed init instead of re-joining the stale promise", async () => {
    const w = makeWorker();
    const first = w.initialize();
    // Concurrent caller must share the same in-flight promise...
    const shared = w.initialize();
    await Promise.all([first, shared]);
    expect(spawnCount()).toBe(1);
    // ...and a later init (after killing the process) starts a fresh spawn.
    (w as unknown as { proc: { kill: (s?: string) => void } | null }).proc?.kill("SIGKILL");
    await waitUntil(() => !w.ready, 3000);
    await w.initialize();
    expect(spawnCount()).toBe(2);
    expect(w.ready).toBe(true);
  });

  it("recovers from an unexpected process death", async () => {
    const w = makeWorker();
    await w.initialize();
    (w as unknown as { proc: { kill: (s?: string) => void } | null }).proc?.kill("SIGKILL");
    await waitUntil(() => !w.ready, 3000);

    await w.initialize();
    expect(spawnCount()).toBe(2);
    const result = await w.synthesize({ text: "after crash", settings: SETTINGS });
    expect(result.duration).toBe(1.0);
  });

  it("resets a wedged worker on request timeout and respawns", async () => {
    const w = makeWorker(300); // 300ms request timeout
    await w.initialize();
    expect(spawnCount()).toBe(1);

    const hung = w.synthesize({ text: "HANG", settings: SETTINGS }).then(
      () => { throw new Error("expected the hung request to reject"); },
      (err: Error) => err,
    );
    const err = await hung;
    expect(err.message).toMatch(/timed out after 0.3s/);

    // The wedged process is replaced and a fresh worker comes up.
    await waitUntil(() => w.ready, 10_000);
    expect(spawnCount()).toBe(2);

    // The replacement stays healthy and serves new requests.
    const a = await w.synthesize({ text: "after reset A", settings: SETTINGS });
    const b = await w.synthesize({ text: "after reset B", settings: SETTINGS });
    expect(a.duration).toBe(1.0);
    expect(b.duration).toBe(1.0);
    expect(spawnCount()).toBe(2); // no further resets
  });

  it("rejects requests queued behind a wedge early when the worker resets", async () => {
    const w = makeWorker(300);
    await w.initialize();

    const first = w.synthesize({ text: "HANG first", settings: SETTINGS }).then(
      () => { throw new Error("expected rejection"); },
      (err: Error) => err,
    );
    const second = w.synthesize({ text: "HANG second", settings: SETTINGS }).then(
      () => { throw new Error("expected rejection"); },
      (err: Error) => err,
    );

    const [e1, e2] = await Promise.all([first, second]);
    // The first timeout fires, resets the worker, and the second request is
    // rejected by the reset — not left to burn its own full timeout.
    expect(e1.message).toMatch(/timed out/);
    expect(e2.message).toMatch(/reset/);

    await waitUntil(() => w.ready, 10_000);
    const after = await w.synthesize({ text: "healthy again", settings: SETTINGS });
    expect(after.duration).toBe(1.0);
  });
});
