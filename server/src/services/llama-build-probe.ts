import { execFile } from "child_process";
import { readdirSync, readFileSync, readlinkSync } from "fs";

/**
 * Resolve the llama.cpp build identity of the server at `baseUrl`, for
 * snapshot invalidation (docs/design/kv-snapshot-parking.md §2.5/§5.4).
 *
 * The authoritative source is the running binary itself:
 *   1. find the server process (cmdline carries `--port <port>` and the
 *      binary basename contains "llama"),
 *   2. read its real path from /proc/<pid>/exe (survives symlink swaps),
 *   3. run `<bin> --version` and parse `version: X (build N, commit C)`.
 *
 * `/server_info` is NOT a stable endpoint (absent on b11552 — it 404s into
 * the static-file handler), so it is kept only as a legacy fallback for
 * builds that do expose it. Unknown build → "" (the restore gate then
 * passes vacuously; llama.cpp's own checkpoint-appendix version checks in
 * the save files are the backstop).
 *
 * Returns "" on any failure — callers treat an empty tag as "unknown",
 * never as "compatible with everything".
 */
export async function resolveLlamaBuildTag(baseUrl: string): Promise<string> {
  const tag = await tagFromRunningBinary(baseUrl);
  if (tag) return tag;
  return tagFromServerInfo(baseUrl);
}

function parsePort(baseUrl: string): number | null {
  try {
    const url = new URL(baseUrl);
    return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

async function tagFromRunningBinary(baseUrl: string): Promise<string> {
  const port = parsePort(baseUrl);
  if (port == null) return "";
  try {
    const pid = findLlamaServerPid(port);
    if (pid == null) return "";
    const bin = readlinkSync(`/proc/${pid}/exe`);
    const stdout = await execFileAsync(bin, ["--version"], 5_000);
    return parseVersionOutput(stdout);
  } catch {
    return "";
  }
}

function execFileAsync(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/** Find a live llama.cpp server process listening on `port`. */
export function findLlamaServerPid(port: number): number | null {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let cmdline = "";
    try {
      cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
    } catch {
      continue;
    }
    const args = cmdline.split("\0").filter(Boolean);
    if (args.length === 0) continue;
    if (!/llama/.test(args[0] ?? "")) continue;
    const idx = args.indexOf("--port");
    if (idx >= 0 && args[idx + 1] === String(port)) return Number(entry);
  }
  return null;
}

/** Parse `version: 0.6.0-dev (build 11552, commit 23b0202a1)` → `b11552-23b0202a1`. */
export function parseVersionOutput(stdout: string): string {
  const match = stdout.match(/build\s+(\d+)(?:,\s*commit\s+([0-9a-fA-F]+))?/i);
  if (!match) return "";
  return match[2] ? `b${match[1]}-${match[2].toLowerCase()}` : `b${match[1]}`;
}

/** Legacy fallback: builds that expose GET /server_info. */
async function tagFromServerInfo(baseUrl: string): Promise<string> {
  try {
    const response = await fetch(`${baseUrl}/server_info`, { signal: AbortSignal.timeout(5_000) });
    const body: any = await response.json().catch(() => null);
    if (!response.ok || !body) return "";
    return String(body.build_number ? `b${body.build_number}` : body.version || "").trim();
  } catch {
    return "";
  }
}
