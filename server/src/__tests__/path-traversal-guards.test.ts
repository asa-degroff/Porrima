import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isNumericVersion, isSafePathSegment, resolveWithin } from "../utils/safe-path.js";
import { isValidSshHost, isValidSshTarget, isValidSshUsername } from "../utils/ssh-target.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Load a service with `homedir()` pointed at a scratch directory, so the
 *  module-level `appDataPath(...)` constants stay inside the test. */
async function loadWithHome<T>(homeDir: string, specifier: string): Promise<T> {
  vi.resetModules();
  vi.doMock("os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("os")>();
    return { ...actual, homedir: () => homeDir };
  });
  return (await import(specifier)) as unknown as T;
}

afterEach(() => {
  vi.doUnmock("os");
  vi.resetModules();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("path segment guard", () => {
  it("rejects separators, traversal, NUL and empty segments", () => {
    for (const bad of ["..", ".", "", "a/b", "a\\b", "a\0b", "../../etc/passwd"]) {
      expect(isSafePathSegment(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(isSafePathSegment(undefined)).toBe(false);
    expect(isSafePathSegment(42)).toBe(false);
  });

  it("accepts ids, uuids and history filenames", () => {
    expect(isSafePathSegment("system")).toBe(true);
    expect(isSafePathSegment("9f1c2a3b-4d5e-6f70-8192-a3b4c5d6e7f8")).toBe(true);
    expect(isSafePathSegment("persona-2026-10-21T12-00-00.md")).toBe(true);
  });

  it("only accepts non-negative integer versions", () => {
    expect(isNumericVersion("3")).toBe(true);
    expect(isNumericVersion("../3")).toBe(false);
    expect(isNumericVersion("3.0")).toBe(false);
    expect(isNumericVersion("-1")).toBe(false);
  });

  it("resolveWithin keeps paths under the root and rejects escapes", () => {
    const root = join(tmpdir(), "porrima-safe-path-root");
    expect(resolveWithin(root, "chat1", "index.html")).toBe(join(root, "chat1", "index.html"));
    expect(resolveWithin(root, "..")).toBeNull();
    expect(resolveWithin(root, "a/../../b")).toBeNull();
    expect(resolveWithin(root)).toBe(root);
  });
});

describe("request-derived filesystem keys", () => {
  it("user image storage refuses traversal for reads and deletes", async () => {
    const homeDir = makeTempDir("porrima-image-guard-");
    const victimDir = join(homeDir, ".porrima", "victim");
    mkdirSync(victimDir, { recursive: true });
    writeFileSync(join(victimDir, "keep.txt"), "keep");

    const storage = await loadWithHome<typeof import("../services/user-image-storage.js")>(
      homeDir,
      "../services/user-image-storage.js",
    );

    expect(() => storage.getUserImageDir("../victim")).toThrow(/Invalid image id/);
    expect(await storage.deleteUserImage("../victim")).toBe(false);
    expect(existsSync(join(victimDir, "keep.txt"))).toBe(true);
  });

  it("tool output paths refuse traversal in the chat id", async () => {
    const homeDir = makeTempDir("porrima-spill-guard-");
    const store = await loadWithHome<typeof import("../services/tool-output-store.js")>(
      homeDir,
      "../services/tool-output-store.js",
    );

    expect(() => store.toolOutputDir("a/../../..")).toThrow(/Invalid chat id/);
    await expect(store.ensureToolOutputDir("../../etc")).rejects.toThrow(/Invalid chat id/);
    expect(store.toolOutputDir("chat1")).toBe(join(homeDir, ".porrima", "tool-output", "chat1"));
  });

  it("persona and extraction prompt history refuse traversal", async () => {
    const homeDir = makeTempDir("porrima-history-guard-");
    mkdirSync(join(homeDir, ".porrima"), { recursive: true });
    writeFileSync(join(homeDir, ".porrima", "secret.txt"), "secret");

    const persona = await loadWithHome<typeof import("../services/persona-store.js")>(
      homeDir,
      "../services/persona-store.js",
    );
    expect(await persona.getPersonaVersion("../secret.txt")).toBeNull();

    const extraction = await loadWithHome<typeof import("../services/extraction-prompt-store.js")>(
      homeDir,
      "../services/extraction-prompt-store.js",
    );
    expect(await extraction.getExtractionPromptVersion("../secret.txt")).toBeNull();
  });

  it("artifact writers refuse unsafe ids", async () => {
    const homeDir = makeTempDir("porrima-artifact-guard-");
    const sandbox = await loadWithHome<typeof import("../services/sandbox.js")>(
      homeDir,
      "../services/sandbox.js",
    );

    await expect(sandbox.updateArtifact("../escape", "<html></html>")).rejects.toThrow(/Invalid artifact id/);
    await expect(sandbox.updateVisual("../escape", "<html></html>")).rejects.toThrow(/Invalid visual id/);
  });
});

describe("ssh target validation", () => {
  it("rejects option-shaped hosts, usernames and targets", () => {
    const payload = "-oProxyCommand=/bin/sh -c 'id > /tmp/pwned'";
    expect(isValidSshHost(payload)).toBe(false);
    expect(isValidSshUsername(payload)).toBe(false);
    expect(isValidSshTarget(payload)).toBe(false);
  });

  it("accepts hostnames, addresses and user@host targets", () => {
    expect(isValidSshHost("example.com")).toBe(true);
    expect(isValidSshHost("10.0.0.5")).toBe(true);
    expect(isValidSshHost("[::1]")).toBe(true);
    expect(isValidSshUsername("deploy")).toBe(true);
    expect(isValidSshUsername(undefined)).toBe(true);
    expect(isValidSshTarget("deploy@example.com")).toBe(true);
  });
});

describe("llama service unit rendering", () => {
  it("rejects newline injection and quotes reasoningFormat", async () => {
    const dir = makeTempDir("porrima-llama-config-");
    const binaryPath = join(dir, "llama-server");
    const modelPath = join(dir, "model.gguf");
    writeFileSync(binaryPath, "");
    writeFileSync(modelPath, "");

    const config = await import("../services/llama-service-config.js");
    const base = {
      mode: "single" as const,
      binaryPath,
      modelPath,
      host: "127.0.0.1",
      port: 32100,
      gpuLayers: 0,
      ctxSize: 4096,
      extraArgs: [],
      environment: [],
    };

    await expect(
      config.validateServiceConfig("inference", {
        ...base,
        reasoningFormat: "deepseek\nExecStartPre=/bin/sh -c 'id > /tmp/pwned'",
      }),
    ).rejects.toThrow(/reasoningFormat/);

    await config.validateServiceConfig("inference", { ...base, reasoningFormat: "deepseek" });
    const rendered = config
      .renderServiceExecStart("inference", { ...base, reasoningFormat: "deepseek" })
      .replace(/\\/g, " ")
      .replace(/\s+/g, " ");
    expect(rendered).toContain("--reasoning-format 'deepseek'");
  });
});