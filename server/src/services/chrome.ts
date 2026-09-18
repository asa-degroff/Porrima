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

/**
 * First Chrome user-data dir with a parseable DevToolsActivePort file, if any.
 *
 * Deliberately no network liveness probe here. The previous probe — HTTP GET
 * /json/version — is exactly the surface Chrome 152's consent-mode remote
 * debugging does NOT serve: a browser enabled via the
 * chrome://inspect/#remote-debugging toggle exposes a WebSocket-only
 * endpoint, the legacy /json/* HTTP routes answer 404, and the WS handshake
 * itself stays PENDING until the user approves the "allow remote debugging"
 * prompt in the UI. A pre-flight probe therefore cannot distinguish
 * "waiting for consent" from "dead", and a fast timeout probe is worse:
 * the consent prompt never gets a chance to appear, so the attach path can
 * never be reached (observed 09-18: live consent-mode Chrome at 127.0.0.1:9222
 * answered 404 on /json/version, the probe classified it dead, and the
 * session silently fell back to a private headless browser).
 *
 * Liveness is established by the attach attempt itself (openBrowserSession
 * in browser-session.ts): a dead endpoint fails fast with connection
 * refused, a live one connects immediately (consent already granted) or
 * waits for the user to approve. Stale files that survive a crash are
 * handled by that same fast failure.
 */
export async function discoverDevToolsTarget(): Promise<DevToolsActiveTarget | null> {
  for (const dir of chromeUserDataDirs()) {
    const target = readDevToolsActivePort(dir);
    if (target) return target;
  }
  return null;
}
