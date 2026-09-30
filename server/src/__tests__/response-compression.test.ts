import compression from "compression";
import express from "express";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { responseCompression, shouldCompress } from "../middleware/compression.js";

const require = createRequire(import.meta.url);

// Streaming regression guard.
//
// `compressible("text/event-stream")` returns true, so compression's
// default filter gzips SSE responses and holds every frame until
// res.end(). A chat turn that should stream tokens then delivers them in
// one burst — which looks like a hung request followed by a sudden
// wall of text. These tests assert frames actually arrive incrementally
// so a future change to the filter cannot silently reintroduce that.

function listen(app: express.Express): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Milliseconds between each SSE frame the server emits. */
const FRAME_INTERVAL_MS = 60;
const FRAME_COUNT = 4;

/**
 * Records the wall-clock offset of every SSE frame as the client receives
 * it. Returns both the offsets and the Content-Encoding header.
 */
function collectSseFrames(port: number, path: string) {
  return new Promise<{ offsets: number[]; contentEncoding: string | null }>((resolve, reject) => {
    const offsets: number[] = [];
    const started = Date.now();
    const req = http.get(
      { port, path, headers: { "Accept-Encoding": "gzip, deflate, br" } },
      (res) => {
        const contentEncoding = res.headers["content-encoding"] ?? null;
        let buffer = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (frame.includes("data:")) offsets.push(Date.now() - started);
            boundary = buffer.indexOf("\n\n");
          }
        });
        res.on("end", () => resolve({ offsets, contentEncoding }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
  });
}

function measureBody(port: number, path: string) {
  return new Promise<{ bytes: number; contentEncoding: string | null }>((resolve, reject) => {
    http.get(
      { port, path, headers: { "Accept-Encoding": "gzip, deflate, br" } },
      (res) => {
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
        });
        res.on("end", () =>
          resolve({ bytes, contentEncoding: res.headers["content-encoding"] ?? null }),
        );
        res.on("error", reject);
      },
    ).on("error", reject);
  });
}

describe("response compression filter", () => {
  it("rejects text/event-stream even though compressible() accepts it", () => {
    // Guards the premise of the whole middleware: if this ever flips to
    // false, the explicit exclusion can be dropped.
    expect(compressibleTypeIsTruthy("text/event-stream")).toBe(true);

    const res = { getHeader: (name: string) => (name === "Content-Type" ? "text/event-stream" : undefined) };
    expect(shouldCompress({} as never, res as never)).toBe(false);
  });

  it("rejects text/event-stream declared via res.writeHead()", () => {
    // chat.ts streaming endpoints and routes/images.ts set the type
    // through writeHead rather than setHeader.
    const headers: Record<string, string> = {};
    const res = {
      writeHead(_status: number, h: Record<string, string>) {
        Object.assign(headers, h);
      },
      getHeader: (name: string) => headers[name],
    };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    expect(shouldCompress({} as never, res as never)).toBe(false);
  });

  it("rejects application/octet-stream binary downloads", () => {
    const res = {
      getHeader: (name: string) =>
        name === "Content-Type" ? "application/octet-stream" : undefined,
    };
    expect(shouldCompress({} as never, res as never)).toBe(false);
  });

  it("rejects already-encoded and no-transform responses", () => {
    const encoded = {
      getHeader: (name: string) =>
        name === "Content-Type" ? "application/json" : name === "Content-Encoding" ? "gzip" : undefined,
    };
    expect(shouldCompress({} as never, encoded as never)).toBe(false);

    const noTransform = {
      getHeader: (name: string) =>
        name === "Content-Type" ? "application/json" : name === "Cache-Control" ? "no-cache, no-transform" : undefined,
    };
    expect(shouldCompress({} as never, noTransform as never)).toBe(false);
  });

  it("allows JSON and HTML responses through", () => {
    for (const type of ["application/json", "text/html; charset=utf-8"]) {
      const res = { getHeader: (name: string) => (name === "Content-Type" ? type : undefined) };
      const req = { headers: { "accept-encoding": "gzip, deflate, br" } };
      expect(shouldCompress(req as never, res as never)).toBe(true);
    }
  });
});

function compressibleTypeIsTruthy(type: string): boolean {
  const compressible = require("compressible") as (t: string) => boolean | undefined;
  return Boolean(compressible(type));
}

describe("compression over a live express app", () => {
  let server: http.Server;
  let port: number;
  const bigPayload = { messages: Array.from({ length: 400 }, (_, i) => ({ i, content: "x".repeat(700) })) };
  const bigJson = JSON.stringify(bigPayload);

  beforeAll(async () => {
    const app = express();
    app.use(responseCompression());

    // Mirrors ensureSSEStream in routes/chat.ts: type set via writeHead and
    // only `no-cache` (no `no-transform`). This is the shape that the
    // default filter would buffer, so the test below is the one that
    // matters.
    app.get("/sse", (_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      let i = 0;
      const timer = setInterval(() => {
        res.write(`event: tick\ndata: ${++i}\n\n`);
        if (i >= FRAME_COUNT) {
          clearInterval(timer);
          res.end();
        }
      }, FRAME_INTERVAL_MS);
    });

    // Mirrors GET /api/chats/:id — the cold chat-switch payload.
    app.get("/big", (_req, res) => {
      res.json(bigPayload);
    });

    server = await listen(app);
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await close(server);
  });

  it("delivers SSE frames incrementally instead of buffering them", async () => {
    const { offsets, contentEncoding } = await collectSseFrames(port, "/sse");

    expect(offsets).toHaveLength(FRAME_COUNT);
    expect(contentEncoding).toBeNull();

    // The decisive assertion: frames must be spread across the stream, not
    // delivered together at the end. Unfiltered compression yields 0
    // incremental frames and a single burst.
    const spread = offsets[offsets.length - 1] - offsets[0];
    expect(spread).toBeGreaterThan(FRAME_INTERVAL_MS * (FRAME_COUNT - 1) * 0.5);
  });

  it("compresses the large chat-window payload", async () => {
    const { bytes, contentEncoding } = await measureBody(port, "/big");

    expect(contentEncoding).toBe("br");
    expect(bytes).toBeLessThan(bigJson.length * 0.5);
  });
});
