import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import type { Server } from "http";
import express from "express";

/**
 * Request-log recorder + routes (docs/design/request-viewer.md).
 *
 * Isolated via the data-dir env override instead of mocking `os` (same
 * pattern as memory-tools.test.ts): a fresh temp dir per test file run,
 * `vi.resetModules()`, then dynamic imports so the service resolves its DB
 * path against the scratch dir. A second raw connection is opened for blob
 * table introspection (dedup/vacuum assertions) — WAL allows it.
 *
 * Covers: start/end recording + id-only events, newest-first listing, blob
 * dedup + rehydration, 50/chat retention pruning, throttled blob vacuum,
 * latest-recorded-system-prompt resolution (incl. the defensive branches),
 * chat scoping, the in-process HTTP routes, and restart hygiene
 * (in_progress rows marked aborted on re-init).
 */

type RL = typeof import("../services/request-log.js");
type RLEvent = import("../services/request-log.js").LlmRequestEvent;

const MAIN_CHAT = "rl-test-main";
const ROUTES_CHAT = "rl-test-routes";
const ISOLATION_CHAT = "rl-test-isolation";
const RESTART_CHAT = "rl-test-restart";

const TURN_MAIN = "rl-turn-main";
const TURN_ROUTES = "rl-turn-routes";
const TURN_ISOLATION = "rl-turn-isolation";
const TURN_RESTART = "rl-turn-restart";

const systemMsg = { role: "system", content: "You are Porrima. FROZEN MEMORIES HERE." };
const userMsg = { role: "user", content: "hello, what's the weather tool story" };
const assistantMsg = {
  role: "assistant",
  content: null,
  tool_calls: [
    { id: "c1", type: "function", function: { name: "web_fetch", arguments: '{"url":"https://example.com"}' } },
  ],
};
const toolMsg = { role: "tool", tool_call_id: "c1", content: "weather: sun, 21C" };
const tools = [
  { type: "function", function: { name: "web_fetch", description: "fetch", parameters: { type: "object" } } },
];

let homeDir = "";
let dataDir = "";
let rl: RL;
let events: RLEvent[] = [];
let unsub: (() => void) | undefined;
let inspect: Database.Database;
let server: Server;

beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), "porrima-request-log-"));
  dataDir = join(homeDir, ".porrima");
  mkdirSync(dataDir, { recursive: true });
  process.env.PORRIMA_DATA_DIR = dataDir;
  vi.resetModules();

  rl = await import("../services/request-log.js");
  const routes = await import("../routes/request-log.js");
  unsub = rl.onLlmRequestEvent((ev) => events.push(ev));

  inspect = new Database(join(dataDir, "porrima.db"));

  const app = express();
  app.use("/api/llm-requests", routes.default);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
});

afterAll(async () => {
  unsub?.();
  inspect?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  rmSync(homeDir, { recursive: true, force: true });
});

function blobCount(): number {
  return (inspect.prepare("SELECT COUNT(*) AS n FROM llm_request_blobs").get() as { n: number }).n;
}

function blobExistsFor(text: string): boolean {
  const row = inspect
    .prepare("SELECT hash FROM llm_request_blobs WHERE text = ?")
    .get(text);
  return row !== undefined;
}

function recordRequest(iteration: number, body: Record<string, unknown>, chatId = MAIN_CHAT) {
  rl.recordLlmRequestStart({
    chatId,
    requestId: `${TURN_MAIN}:${iteration}`,
    turnId: TURN_MAIN,
    iteration,
    modelId: "test-model",
    provider: "llamacpp",
    body,
    requestDigest: `digest-${iteration}`,
  });
}

// Seed the two prefix-sharing requests (iteration 2 = iteration 1 + tool round).
beforeAll(() => {
  recordRequest(1, { model: "test-model", stream: true, stream_options: { include_usage: true }, cache_prompt: true, id_slot: 3, messages: [systemMsg, userMsg], tools });
  rl.recordLlmRequestEnd({
    chatId: MAIN_CHAT,
    requestId: `${TURN_MAIN}:1`,
    status: "done",
    output: { content: [{ type: "text", text: "checking" }], stopReason: "toolUse", usage: { input: 120, output: 30, cacheRead: 100 } },
    cachedTokens: 100,
    durationMs: 950,
  });

  recordRequest(2, { model: "test-model", stream: true, cache_prompt: true, messages: [systemMsg, userMsg, assistantMsg, toolMsg], tools });
  rl.recordLlmRequestEnd({
    chatId: MAIN_CHAT,
    requestId: `${TURN_MAIN}:2`,
    status: "done",
    output: { content: [{ type: "text", text: "It is sunny, 21C." }], stopReason: "stop", usage: { input: 260, output: 12, cacheRead: 240 } },
    cachedTokens: 240,
    durationMs: 610,
  });
});

describe("recorder", () => {
  it("emits id-only start/end events (no bodies on the wire)", () => {
    const starts = events.filter((e) => e.type === "start" && e.requestId === `${TURN_MAIN}:1`);
    const ends = events.filter((e) => e.type === "end" && e.requestId === `${TURN_MAIN}:2`);
    expect(starts.length).toBe(1);
    expect(ends.length).toBe(1);
    const start = starts[0];
    expect(start.chatId).toBe(MAIN_CHAT);
    expect(start.turnId).toBe(TURN_MAIN);
    expect(start.iteration).toBe(1);
    expect(start.messageCount).toBe(2);
    expect(start.toolCount).toBe(1);
    // Frames carry ids + counters only — full bodies stay server-side.
    expect("body" in start).toBe(false);
    expect("messages" in start).toBe(false);
    const end = ends[0];
    expect(end.status).toBe("done");
    expect(end.stopReason).toBe("stop");
    expect(end.promptTokens).toBe(260);
    expect(end.completionTokens).toBe(12);
    expect(end.cachedTokens).toBe(240);
    expect(end.durationMs).toBe(610);
  });

  it("lists newest-first with stored summary metrics, purpose pinned to chat", () => {
    const list = rl.listLlmRequests(MAIN_CHAT);
    expect(list.map((r) => r.id)).toEqual([`${TURN_MAIN}:2`, `${TURN_MAIN}:1`]);
    const r2 = list[0];
    expect(r2.promptTokens).toBe(260);
    expect(r2.completionTokens).toBe(12);
    expect(r2.cachedTokens).toBe(240);
    expect(r2.durationMs).toBe(610);
    expect(r2.stopReason).toBe("stop");
    expect(r2.requestDigest).toBe("digest-2");
    expect(r2.purpose).toBe("chat");
    expect(r2.status).toBe("done");
  });

  it("rehydrates the exact wire body from content-addressed blobs", () => {
    const d = rl.getLlmRequestDetail(`${TURN_MAIN}:2`);
    expect(d).not.toBeNull();
    expect(d!.request?.messages.length).toBe(4);
    expect(d!.request?.messages[0]).toEqual(systemMsg);
    expect(d!.request?.messages[3]).toEqual(toolMsg);
    expect(d!.request?.params).toEqual(expect.objectContaining({ model: "test-model", cache_prompt: true }));
    expect(d!.request?.params).not.toHaveProperty("messages");
    expect(d!.request?.params).not.toHaveProperty("tools");
    expect(d!.request?.tools).toEqual(tools);
    expect(d!.request?.reclaimed).toBe(0);
    expect(d!.response?.content).toEqual([{ type: "text", text: "It is sunny, 21C." }]);
    expect(d!.response?.stopReason).toBe("stop");
  });

  it("dedups shared prefix messages into single blobs", () => {
    // Two requests carry 2 + 4 messages but only 4 distinct message bodies,
    // plus one shared tools array: 5 blobs total, not 7.
    expect(blobCount()).toBe(5);
    expect(blobExistsFor(JSON.stringify(systemMsg))).toBe(true);
  });

  it("marks an unknown-id end as a silent no-op", () => {
    const before = events.length;
    expect(() =>
      rl.recordLlmRequestEnd({ chatId: MAIN_CHAT, requestId: "no-such-request", status: "done", output: {} })
    ).not.toThrow();
    expect(events.length).toBe(before);
  });
});

describe("retention + blob vacuum", () => {
  it("prunes to 50 per chat and vacuums the pruned blobs", () => {
    for (let i = 3; i < 63; i++) {
      recordRequest(i, { model: "test-model", messages: [{ role: "user", content: `tick ${i}` }] });
    }
    const list = rl.listLlmRequests(MAIN_CHAT);
    expect(list.length).toBe(50);
    // Iterations 1-12 were pruned; their unique message blobs were reclaimed
    // by the throttled vacuum (fires every 20 inserts). Newest survives.
    expect(blobExistsFor(JSON.stringify({ role: "user", content: "tick 3" }))).toBe(false);
    expect(blobExistsFor(JSON.stringify({ role: "user", content: "tick 62" }))).toBe(true);
  });

  it("resolves the latest recorded system prompt, including the defensive branches", () => {
    // Latest row is a user-only tick request — no system message to resolve.
    expect(rl.getLatestRecordedSystemPrompt(MAIN_CHAT)).toBeNull();

    // Array-content system message resolves to its joined text parts.
    recordRequest(900, {
      model: "test-model",
      messages: [{ role: "system", content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] }],
    });
    expect(rl.getLatestRecordedSystemPrompt(MAIN_CHAT)).toBe("AB");

    // First message not a system message resolves to null.
    recordRequest(901, { model: "test-model", messages: [{ role: "user", content: "no system here" }] });
    expect(rl.getLatestRecordedSystemPrompt(MAIN_CHAT)).toBeNull();
  });

  it("clears a chat's rows and reclaims all of its blobs", () => {
    const removed = rl.clearLlmRequests(MAIN_CHAT);
    expect(removed).toBe(50);
    expect(rl.listLlmRequests(MAIN_CHAT).length).toBe(0);
    expect(rl.getLatestRecordedSystemPrompt(MAIN_CHAT)).toBeNull();
    expect(blobExistsFor(JSON.stringify(systemMsg))).toBe(false);
  });
});

describe("chat scoping + routes", () => {
  beforeAll(() => {
    for (let i = 1; i <= 3; i++) {
      rl.recordLlmRequestStart({
        chatId: ROUTES_CHAT,
        requestId: `${TURN_ROUTES}:${i}`,
        turnId: TURN_ROUTES,
        iteration: i,
        modelId: "test-model",
        provider: "llamacpp",
        body: { model: "test-model", messages: [{ role: "user", content: `route tick ${i}` }] },
        requestDigest: `routes-digest-${i}`,
      });
    }
    rl.recordLlmRequestStart({
      chatId: ISOLATION_CHAT,
      requestId: `${TURN_ISOLATION}:1`,
      turnId: TURN_ISOLATION,
      iteration: 1,
      modelId: "test-model",
      provider: "llamacpp",
      body: { model: "test-model", messages: [{ role: "user", content: "isolation tick" }] },
      requestDigest: "isolation-digest-1",
    });
  });

  const base = "http://127.0.0.1:PORT/api/llm-requests";
  const url = (path: string) => {
    const port = (server.address() as { port: number }).port;
    return base.replace("PORT", String(port)) + path;
  };

  it("list is scoped per chat (no cross-chat leakage)", async () => {
    const mainRes = await fetch(url(`?chatId=${MAIN_CHAT}`));
    expect(mainRes.status).toBe(200);
    const mainJson = (await mainRes.json()) as { requests: unknown[] };
    expect(mainJson.requests.length).toBe(0); // cleared above

    const routesRes = await fetch(url(`?chatId=${ROUTES_CHAT}`));
    const routesJson = (await routesRes.json()) as { requests: unknown[] };
    expect(routesJson.requests.length).toBe(3);
  });

  it("rejects a list without chatId", async () => {
    const res = await fetch(url("/"));
    expect(res.status).toBe(400);
  });

  it("rehydrates a detail by id", async () => {
    const res = await fetch(url(`/${encodeURIComponent(`${TURN_ROUTES}:2`)}`));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { request: { messages: Array<{ content?: unknown }> } | null };
    expect(json.request?.messages.length).toBe(1);
    expect(json.request?.messages[0].content).toBe("route tick 2");
  });

  it("404s an unknown detail id", async () => {
    const res = await fetch(url("/does-not-exist"));
    expect(res.status).toBe(404);
  });

  it("clears a chat via DELETE and vacuums its blobs", async () => {
    const res = await fetch(url(`?chatId=${ROUTES_CHAT}`), { method: "DELETE" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { removed: number };
    expect(json.removed).toBe(3);
    expect(rl.listLlmRequests(ROUTES_CHAT).length).toBe(0);
    expect(blobExistsFor(JSON.stringify({ role: "user", content: "route tick 1" }))).toBe(false);
    // The isolation chat's blob survives — vacuum only reclaims unreferenced.
    expect(blobExistsFor(JSON.stringify({ role: "user", content: "isolation tick" }))).toBe(true);
  });
});

describe("restart hygiene", () => {
  it("marks stale in_progress rows aborted when the schema re-initializes", async () => {
    rl.recordLlmRequestStart({
      chatId: RESTART_CHAT,
      requestId: `${TURN_RESTART}:fresh`,
      turnId: TURN_RESTART,
      iteration: 1,
      modelId: "test-model",
      provider: "llamacpp",
      body: { model: "test-model", messages: [{ role: "user", content: "in flight at shutdown" }] },
    });
    expect(rl.listLlmRequests(RESTART_CHAT).find((r) => r.id === `${TURN_RESTART}:fresh`)?.status).toBe("in_progress");

    // Simulate a server restart: a fresh module instance re-runs initSchema
    // against the same DB (a restart always empties in-flight state).
    vi.resetModules();
    const fresh = await import("../services/request-log.js");
    const row = fresh.listLlmRequests(RESTART_CHAT).find((r) => r.id === `${TURN_RESTART}:fresh`);
    expect(row?.status).toBe("aborted");
    rl = fresh;
  });
});
