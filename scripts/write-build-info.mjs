import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

const info = {
  version: String(packageJson.version || "0.0.0-dev"),
  gitCommit: process.env.GITHUB_SHA || git(["rev-parse", "--short=12", "HEAD"]) || null,
  gitBranch: process.env.GITHUB_REF_NAME || git(["branch", "--show-current"]) || null,
  buildTime: new Date().toISOString(),
  // Build-time channel baked into release artifacts. The server can still
  // override the reported channel at runtime with PORRIMA_RELEASE_CHANNEL.
  releaseChannel: process.env.PORRIMA_RELEASE_CHANNEL || "stable",
};

const outputPathArg = process.argv[2] || "server/dist/build-info.json";
const outputPath = isAbsolute(outputPathArg) ? outputPathArg : join(rootDir, outputPathArg);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(info, null, 2)}\n`);
