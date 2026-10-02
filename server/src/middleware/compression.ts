import compression from "compression";
import type { Request, Response } from "express";

/**
 * Content types that must never be compressed by this middleware.
 *
 * `text/event-stream` — the default `compression.filter` delegates to
 * `compressible()`, and `compressible("text/event-stream")` returns TRUE
 * (mime-db marks SSE as compressible). Compressing an SSE response holds
 * its frames until `res.end()`, so a stream that should deliver tokens
 * incrementally delivers them in one burst.
 *
 * The default filter does provide one escape hatch: it refuses to
 * compress responses carrying `Cache-Control: no-transform`. Only 2 of
 * this server's 4 SSE route files set that — routes/tts.ts and
 * routes/memory.ts. The others do not, including `ensureSSEStream`
 * in routes/chat.ts, which backs the main chat stream, the reconnect
 * stream and artifact auto-repair, and routes/embedding-migration.ts;
 * both set only `no-cache`. Those would all be buffered under the default
 * filter. Excluding by content type covers every one of them, plus any
 * SSE route added later, without depending on each route remembering to
 * set `no-transform`.
 *
 * `application/octet-stream` — `compressible()` also reports this as
 * compressible, so binary downloads (e.g. `.bin` tool-result images from
 * routes/tool-result-images.ts) would be re-encoded for no size gain.
 *
 * Images (png/webp/jxl/avif), fonts (woff2) and audio (wav) are already
 * reported non-compressible by `compressible()`, so the nine
 * `createReadStream().pipe(res)` image routes are safe without listing
 * them here.
 */
const NEVER_COMPRESS = /^(text\/event-stream|application\/octet-stream)\b/i;

/**
 * Compression filter for the API.
 *
 * Decides by response content type rather than by route, so a newly added
 * SSE endpoint is safe by default. This also covers routes that declare
 * the type via `res.writeHead(200, { "Content-Type": ... })` (chat.ts
 * streaming endpoints, routes/images.ts) — `res.getHeader()` reflects
 * headers set that way, so the filter sees them.
 */
export function shouldCompress(req: Request, res: Response): boolean {
  if (NEVER_COMPRESS.test(String(res.getHeader("Content-Type") || ""))) {
    return false;
  }
  // Never re-encode a response that is already encoded.
  if (res.getHeader("Content-Encoding")) {
    return false;
  }
  // Respect an explicit opt-out from intermediaries.
  if (String(res.getHeader("Cache-Control") || "").includes("no-transform")) {
    return false;
  }
  return compression.filter(req, res);
}

/**
 * Response compression for the API.
 *
 * The package defaults are already the right choice here: it prefers
 * `br` over `gzip` at brotli quality 4, which on a 200-message chat
 * window (1.4 MB) compresses to ~14% at ~6ms of CPU — a better ratio
 * *and* cheaper than gzip level 6 (~19% at ~14ms). The default 1 KB
 * `threshold` already skips the small polling responses
 * (`/api/system-stats` is ~90 bytes, `/api/settings/cache-residency` 2
 * bytes) so they cost nothing.
 */
export function responseCompression() {
  return compression({ filter: shouldCompress });
}
