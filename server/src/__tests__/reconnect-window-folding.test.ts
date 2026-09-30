import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Pins the reconnect-path round trip.
 *
 * tryReconnect used to probe liveness and then fetch the message window as two
 * sequential requests, because the resync snapshot only carries a live turn's
 * uncommitted tail — the committed history has to come from a windowed fetch
 * (see buildResyncMessage and the reattach comment in routes/chat.ts).
 *
 * The obvious "just fire both in parallel" fix is a regression here: the
 * client's recently-streaming marker is set on send and only expires after
 * RECENTLY_STREAMING_TTL_MS, so a probe that finds no live stream is the common
 * case and would throw away a full window download every time. The server
 * instead folds the window into the probe, and only pays for the DB read when
 * a stream is genuinely live.
 */

const CHAT_ID = "reconnect-window-test";
const MESSAGE_COUNT = 5;

type Handler = (req: any, res: any) => unknown;

let homeDir: string;
let chatRouter: any;
let chatStorage: typeof import("../services/chat-storage.js");
let liveStreams: typeof import("../services/live-streams.js").liveStreams;
let statusHandler: Handler;

beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), "porrima-reconnect-window-"));
  mkdirSync(join(homeDir, ".porrima"), { recursive: true });

  vi.resetModules();
  vi.doMock("os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("os")>();
    return { ...actual, homedir: () => homeDir };
  });

  // Imported together, after the homedir mock, so the router and the assertions
  // share one chat-storage instance and one liveStreams map.
  chatStorage = await import("../services/chat-storage.js");
  liveStreams = (await import("../services/live-streams.js")).liveStreams;
  chatRouter = (await import("../routes/chat.js")).default;

  // Express 5 keeps `route.methods` as an object keyed by verb, so match on the
  // path and the presence of a `get` key.
  const layer = chatRouter.stack.find(
    (entry: any) =>
      entry.route?.path === "/status/:chatId" && entry.route?.methods?.get !== undefined,
  );
  if (!layer) throw new Error("GET /status/:chatId not found on chatRouter");
  statusHandler = layer.route.stack[0].handle as Handler;

  // createChat is not idempotent, so seed the fixture once.
  const now = new Date("2026-05-24T00:00:00.000Z").toISOString();
  await chatStorage.createChat({
    id: CHAT_ID,
    title: "Reconnect Window Test",
    type: "agent",
    modelId: "test-model",
    systemPrompt: "You are helpful.",
    messages: Array.from({ length: MESSAGE_COUNT }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `message ${i}`,
      timestamp: 1_000 + i,
    })),
    createdAt: now,
    lastModified: now,
  });
});

afterAll(() => {
  rmSync(homeDir, { recursive: true, force: true });
  vi.doUnmock("os");
  vi.resetModules();
});

function fakeRes() {
  const state: { payload: any } = { payload: undefined };
  const res: any = {
    statusCode: 200,
    json(body: unknown) {
      state.payload = body;
      return res;
    },
  };
  return { res, state };
}

function fakeReq(query: Record<string, string> = {}) {
  return { params: { chatId: CHAT_ID }, query };
}

function fakeLiveStream() {
  return {
    ended: false,
    abort: { signal: { aborted: false } },
    subscribers: new Set<unknown>(),
  } as any;
}

async function callStatus(query: Record<string, string> = {}) {
  const { res, state } = fakeRes();
  await statusHandler(fakeReq(query), res);
  return state.payload;
}

afterEach(() => {
  liveStreams.delete(CHAT_ID);
});

describe("GET /api/chat/status/:chatId window folding", () => {
  it("returns no window when no stream is active, even with includeWindow", async () => {
    const payload = await callStatus({ includeWindow: "1", messageLimit: "200" });

    expect(payload.active).toBe(false);
    // The point of the design: an idle probe stays cheap rather than
    // downloading a window nobody will use.
    expect(payload).not.toHaveProperty("window");
  });

  it("returns no window for an ended or aborted stream", async () => {
    for (const mutate of [
      (s: any) => { s.ended = true; },
      (s: any) => { s.abort.signal.aborted = true; },
    ]) {
      const stream = fakeLiveStream();
      mutate(stream);
      liveStreams.set(CHAT_ID, stream);

      const payload = await callStatus({ includeWindow: "1" });

      expect(payload.active).toBe(false);
      expect(payload).not.toHaveProperty("window");
      liveStreams.delete(CHAT_ID);
    }
  });

  it("returns the window for a live stream, in the same shape as the chat route", async () => {
    liveStreams.set(CHAT_ID, fakeLiveStream());

    const payload = await callStatus({ includeWindow: "1", messageLimit: "200" });

    expect(payload.active).toBe(true);
    expect(payload.window).toBeTruthy();
    // Same shape GET /api/chats/:id?messageLimit=200 returns, so the client can
    // use it as a drop-in for the standalone fetch it used to make.
    expect(payload.window.messages).toHaveLength(MESSAGE_COUNT);
    expect(payload.window.messageOffset).toBe(0);
    expect(payload.window.messageTotal).toBe(MESSAGE_COUNT);
    expect(payload.window.hasMoreMessages).toBe(false);
  });

  it("honours messageLimit when trimming the window", async () => {
    liveStreams.set(CHAT_ID, fakeLiveStream());

    const payload = await callStatus({ includeWindow: "1", messageLimit: "2" });

    expect(payload.window.messages).toHaveLength(2);
    // A windowed read reports where it starts, which the client needs to keep
    // its "load earlier messages" offset correct.
    expect(payload.window.messageOffset).toBe(MESSAGE_COUNT - 2);
    expect(payload.window.hasMoreMessages).toBe(true);
  });

  it("defaults to a full-size window when messageLimit is absent or unusable", async () => {
    liveStreams.set(CHAT_ID, fakeLiveStream());

    const queries: Record<string, string>[] = [
      { includeWindow: "1" },
      { includeWindow: "1", messageLimit: "junk" },
    ];
    for (const query of queries) {
      const payload = await callStatus(query);
      expect(payload.window.messages).toHaveLength(MESSAGE_COUNT);
      expect(payload.window.messageOffset).toBe(0);
    }
  });

  it("omits the window when includeWindow is absent or explicitly off", async () => {
    liveStreams.set(CHAT_ID, fakeLiveStream());

    const queries: Record<string, string>[] = [{}, { includeWindow: "0" }];
    for (const query of queries) {
      const payload = await callStatus(query);
      expect(payload.active).toBe(true);
      expect(payload).not.toHaveProperty("window");
    }
  });

  it("keeps reporting subscribers so the probe stays backward compatible", async () => {
    const stream = fakeLiveStream();
    stream.subscribers.add({});
    stream.subscribers.add({});
    liveStreams.set(CHAT_ID, stream);

    const payload = await callStatus();

    expect(payload.active).toBe(true);
    expect(payload.subscribers).toBe(2);
  });

  it("returns no window for an unknown chat id rather than erroring", async () => {
    liveStreams.set("no-such-chat-id", fakeLiveStream());
    const { res, state } = fakeRes();

    await statusHandler({ params: { chatId: "no-such-chat-id" }, query: { includeWindow: "1" } }, res);
    liveStreams.delete("no-such-chat-id");

    expect(state.payload.active).toBe(true);
    expect(state.payload).not.toHaveProperty("window");
  });
});
