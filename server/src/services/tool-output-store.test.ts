import { mkdtemp, readdir, rm, utimes, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupChat,
  createSpillPath,
  ensureToolOutputDir,
  formatSpillFooter,
  pruneChat,
  sweepExpired,
  toolOutputDir,
} from "./tool-output-store.js";

const roots: string[] = [];
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "porrima-store-"));
  roots.push(root);
  process.env.PORRIMA_TOOL_OUTPUT_DIR = root;
});

afterEach(async () => {
  delete process.env.PORRIMA_TOOL_OUTPUT_DIR;
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("tool-output store", () => {
  it("lays out per-call spill paths", () => {
    expect(createSpillPath("chat1", "bash", "abc")).toBe(join(root, "chat1", "bash-abc.log"));
    expect(createSpillPath("chat1", "py", "cell1")).toBe(join(root, "chat1", "py-cell1.txt"));
  });

  it("formats the uncapped footer byte-compatibly with the bash pattern", () => {
    const footer = formatSpillFooter({
      path: "/tmp/x.log",
      totalBytes: 123456,
      windowBytes: 100 * 1024,
    });
    expect(footer).toBe(
      '\n\n[Output exceeded 100KB. The full output (121KB) was saved to: /tmp/x.log\n' +
        'Use read_file(path="/tmp/x.log", offset=N) to read more. The tail is shown above.]',
    );
  });

  it("formats the capped footer", () => {
    const footer = formatSpillFooter({
      path: "/tmp/x.log",
      totalBytes: 999999,
      windowBytes: 100 * 1024,
      capped: true,
      capBytes: 64 * 1024 * 1024,
    });
    expect(footer).toContain("The spill was capped at 64MB");
    expect(footer).toContain("read_file(path=\"/tmp/x.log\", offset=N)");
  });

  it("prunes a chat to the newest 64 files", async () => {
    await ensureToolOutputDir("chat1");
    const base = Date.now() - 100_000;
    for (let index = 0; index < 70; index++) {
      const file = createSpillPath("chat1", "bash", `id${index}`);
      await writeFile(file, "x");
      const stamp = new Date(base + index * 1000);
      await utimes(file, stamp, stamp);
    }
    const removed = await pruneChat("chat1");
    expect(removed).toBe(6);
    const remaining = await readdir(toolOutputDir("chat1"));
    expect(remaining).toHaveLength(64);
    expect(remaining).not.toContain("bash-id0.log");
    expect(remaining).toContain("bash-id69.log");
  });

  it("sweeps expired files and empty chat directories", async () => {
    await ensureToolOutputDir("chat-old");
    await ensureToolOutputDir("chat-new");
    const oldFile = createSpillPath("chat-old", "py", "old");
    const newFile = createSpillPath("chat-new", "py", "new");
    await writeFile(oldFile, "old");
    await writeFile(newFile, "new");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(oldFile, twoHoursAgo, twoHoursAgo);

    const removed = await sweepExpired(Date.now(), 60 * 60 * 1000);
    expect(removed).toBe(1);
    const rootEntries = await readdir(root);
    expect(rootEntries).not.toContain("chat-old");
    expect(rootEntries).toContain("chat-new");
  });

  it("removes a chat directory on cleanup", async () => {
    await ensureToolOutputDir("chat1");
    await writeFile(createSpillPath("chat1", "bash", "x"), "x");
    await cleanupChat("chat1");
    expect(await readdir(root)).not.toContain("chat1");
  });
});
