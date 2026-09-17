import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { delimiter, join } from "path";

export function findChromePath(): string | null {
  const candidates = [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// When remote debugging is enabled (Chrome 144+ exposes the toggle at
// chrome://inspect/#remote-debugging), Chrome writes DevToolsActivePort into
// its user data dir. Reading it is how the official chrome-devtools-mcp finds
// and attaches to a running Chrome; probe the common Linux profile locations.
const CHROME_USER_DATA_DIR_CANDIDATES = [
  "~/.config/google-chrome",
  "~/.config/google-chrome-beta",
  "~/.config/google-chrome-unstable",
  "~/.config/chromium",
  "~/snap/chromium/common/chromium",
  "~/.var/app/com.google.Chrome/config/google-chrome",
  "~/.var/app/org.chromium.Chromium/config/chromium",
];

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Chrome user data dirs to probe for a running instance, in order.
 * PORRIMA_BROWSER_USER_DATA_DIR overrides them (path-delimiter separated).
 */
export function chromeUserDataDirs(): string[] {
  const override = process.env.PORRIMA_BROWSER_USER_DATA_DIR?.trim();
  if (override) {
    return override
      .split(delimiter)
      .map((entry) => expandHome(entry.trim()))
      .filter(Boolean);
  }
  return CHROME_USER_DATA_DIR_CANDIDATES.map(expandHome);
}

export interface DevToolsActiveTarget {
  userDataDir: string;
  port: number;
  webSocketPath: string;
}

/** Parse a DevToolsActivePort file: line 1 is the port, line 2 the browser WS path. */
export function parseDevToolsActivePort(content: string, userDataDir: string): DevToolsActiveTarget | null {
  const [rawPort, rawPath] = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!rawPort || !rawPath) return null;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!rawPath.startsWith("/")) return null;
  return { userDataDir, port, webSocketPath: rawPath };
}

export function readDevToolsActivePort(userDataDir: string): DevToolsActiveTarget | null {
  try {
    return parseDevToolsActivePort(readFileSync(join(userDataDir, "DevToolsActivePort"), "utf8"), userDataDir);
  } catch {
    return null;
  }
}

async function isDevToolsEndpointLive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * First running Chrome with an active remote debugging endpoint, if any.
 * A DevToolsActivePort file alone is not enough — stale files survive crashes,
 * so the endpoint must answer before we try to attach.
 */
export async function discoverDevToolsTarget(): Promise<DevToolsActiveTarget | null> {
  for (const dir of chromeUserDataDirs()) {
    const target = readDevToolsActivePort(dir);
    if (!target) continue;
    if (await isDevToolsEndpointLive(target.port)) return target;
  }
  return null;
}
