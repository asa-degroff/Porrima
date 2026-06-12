import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface AppBuildInfo {
  version: string;
  gitCommit: string | null;
  gitBranch: string | null;
  buildTime: string;
  releaseChannel: string;
}

export interface AppUpdateStatus {
  current: AppBuildInfo;
  latest: {
    version: string;
    tagName: string;
    name: string | null;
    htmlUrl: string;
    publishedAt: string | null;
  } | null;
  updateAvailable: boolean;
  checkedAt: string;
  error?: string;
}

const DEFAULT_GITHUB_REPO = "asa-degroff/porrima";
const CACHE_TTL_MS = 15 * 60 * 1000;

let cachedStatus: AppUpdateStatus | null = null;
let cachedAtMs = 0;
let cachedBuildInfo: AppBuildInfo | null = null;

function readJsonFile<T>(url: URL): T | null {
  try {
    return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as T;
  } catch {
    return null;
  }
}

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function loadBakedBuildInfo(): AppBuildInfo | null {
  const info = readJsonFile<Partial<AppBuildInfo>>(new URL("../build-info.json", import.meta.url));
  if (!info?.version || !info.buildTime) return null;
  return {
    version: String(info.version),
    gitCommit: info.gitCommit || null,
    gitBranch: info.gitBranch || null,
    buildTime: String(info.buildTime),
    releaseChannel: info.releaseChannel || "stable",
  };
}

function loadPackageVersion(): string {
  const packageJson = readJsonFile<{ version?: string }>(new URL("../../../package.json", import.meta.url));
  return packageJson?.version || "0.0.0-dev";
}

export function getAppBuildInfo(): AppBuildInfo {
  if (!cachedBuildInfo) {
    cachedBuildInfo = loadBakedBuildInfo() || {
      version: loadPackageVersion(),
      gitCommit: git(["rev-parse", "--short=12", "HEAD"]),
      gitBranch: git(["branch", "--show-current"]),
      buildTime: new Date().toISOString(),
      releaseChannel: "dev",
    };
  }
  return {
    version: process.env.PORRIMA_VERSION || cachedBuildInfo.version,
    gitCommit: process.env.PORRIMA_GIT_COMMIT || cachedBuildInfo.gitCommit,
    gitBranch: process.env.PORRIMA_GIT_BRANCH || cachedBuildInfo.gitBranch,
    buildTime: process.env.PORRIMA_BUILD_TIME || cachedBuildInfo.buildTime,
    releaseChannel: process.env.PORRIMA_RELEASE_CHANNEL || cachedBuildInfo.releaseChannel,
  };
}

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

export function compareSemverLike(a: string, b: string): number | null {
  const parse = (value: string): number[] | null => {
    const match = normalizeVersion(value).match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] > right[i]) return 1;
    if (left[i] < right[i]) return -1;
  }
  return 0;
}

function getGithubRepo(): string {
  const repo = (process.env.PORRIMA_GITHUB_REPO || DEFAULT_GITHUB_REPO).trim();
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? repo : DEFAULT_GITHUB_REPO;
}

async function fetchLatestRelease() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`https://api.github.com/repos/${getGithubRepo()}/releases/latest`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "porrima-update-check",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`GitHub returned HTTP ${res.status}`);
    }
    return await res.json() as {
      tag_name?: string;
      name?: string | null;
      html_url?: string;
      published_at?: string | null;
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkForAppUpdate(options: { force?: boolean } = {}): Promise<AppUpdateStatus> {
  const nowMs = Date.now();
  if (!options.force && cachedStatus && nowMs - cachedAtMs < CACHE_TTL_MS) {
    return cachedStatus;
  }

  const current = getAppBuildInfo();
  const checkedAt = new Date(nowMs).toISOString();

  try {
    const release = await fetchLatestRelease();
    const tagName = release.tag_name || "";
    const htmlUrl = release.html_url || `https://github.com/${getGithubRepo()}/releases/latest`;
    const comparison = tagName ? compareSemverLike(current.version, tagName) : null;
    const status: AppUpdateStatus = {
      current,
      latest: tagName
        ? {
            version: normalizeVersion(tagName),
            tagName,
            name: release.name || null,
            htmlUrl,
            publishedAt: release.published_at || null,
          }
        : null,
      updateAvailable: comparison === -1,
      checkedAt,
    };
    cachedStatus = status;
    cachedAtMs = nowMs;
    return status;
  } catch (err) {
    const status: AppUpdateStatus = {
      current,
      latest: null,
      updateAvailable: false,
      checkedAt,
      error: err instanceof Error ? err.message : "Unable to check GitHub releases",
    };
    cachedStatus = status;
    cachedAtMs = nowMs;
    return status;
  }
}
