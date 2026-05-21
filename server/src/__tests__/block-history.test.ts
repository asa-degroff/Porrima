import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

async function loadMemoryStorage(homeDir: string) {
  vi.resetModules();
  vi.doMock("os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("os")>();
    return {
      ...actual,
      homedir: () => homeDir,
    };
  });
  return import("../services/memory-storage.js");
}

afterEach(() => {
  vi.doUnmock("os");
  vi.resetModules();
});

describe("block revision history", () => {
  const mkHomeDir = () => mkdtempSync(join(tmpdir(), "porrima-block-history-"));

  it("captures history entries on content edits and returns oldest-first timeline", async () => {
    const homeDir = mkHomeDir();
    try {
      const {
        createMemoryBlock,
        getMemoryBlock,
        updateMemoryBlock,
        getBlockHistory,
      } = await loadMemoryStorage(homeDir);

      const now = new Date().toISOString();
      createMemoryBlock({
        id: "blk-hist-v0",
        name: "History Test",
        description: "testing history",
        content: "version 0",
        scope: "global",
        projectId: "",
        createdAt: now,
        updatedAt: now,
        updatedBy: "agent",
        supersededBy: undefined,
        supersedes: undefined,
      });

      // Edit twice — should produce 2 history snapshots + 1 current.
      updateMemoryBlock("blk-hist-v0", { content: "version 1", updatedBy: "agent" });
      updateMemoryBlock("blk-hist-v0", { content: "version 2", updatedBy: "user" });

      const history = getBlockHistory("blk-hist-v0");
      expect(history).toHaveLength(3);

      // Order: oldest first.
      expect(history[0].content).toBe("version 0");
      expect(history[1].content).toBe("version 1");
      expect(history[2].content).toBe("version 2");

      // The last entry is the live block (same id).
      const live = getMemoryBlock("blk-hist-v0");
      expect(history[2].id).toBe(live!.id);
      expect(history[2].content).toBe(live!.content);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("preserves createdAt from the original block, not updatedAt", async () => {
    const homeDir = mkHomeDir();
    try {
      const { createMemoryBlock, updateMemoryBlock, getBlockHistory } =
        await loadMemoryStorage(homeDir);

      const createdAt = new Date("2025-01-01T00:00:00.000Z").toISOString();
      const updatedAt = new Date("2025-03-15T12:00:00.000Z").toISOString();
      createMemoryBlock({
        id: "blk-created-at",
        name: "Created At Test",
        description: "",
        content: "original",
        scope: "global",
        projectId: "",
        createdAt,
        updatedAt,
        updatedBy: "agent",
        supersededBy: undefined,
        supersedes: undefined,
      });

      // Edit content — trigger should snapshot old row including createdAt.
      updateMemoryBlock("blk-created-at", { content: "edited" });

      const history = getBlockHistory("blk-created-at");
      expect(history).toHaveLength(2);
      // The history snapshot should keep the original createdAt, NOT the
      // updatedAt value that was on the row at the time of the edit.
      expect(history[0].createdAt).toBe(createdAt);
      expect(history[0].createdAt).not.toBe(updatedAt);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("does not create history entries for scope-only changes", async () => {
    const homeDir = mkHomeDir();
    try {
      const { createMemoryBlock, updateMemoryBlock, getBlockHistory } =
        await loadMemoryStorage(homeDir);

      const now = new Date().toISOString();
      createMemoryBlock({
        id: "blk-scope-only",
        name: "Scope Only",
        description: "",
        content: "unchanged",
        scope: "global",
        projectId: "",
        createdAt: now,
        updatedAt: now,
        updatedBy: "agent",
        supersededBy: undefined,
        supersedes: undefined,
      });

      // Change scope but not content/name/description.
      updateMemoryBlock("blk-scope-only", { scope: "archived" });

      const history = getBlockHistory("blk-scope-only");
      // Only the current block — no history snapshot because content didn't change.
      expect(history).toHaveLength(1);
      expect(history[0].content).toBe("unchanged");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("creates history entries for name and description changes", async () => {
    const homeDir = mkHomeDir();
    try {
      const { createMemoryBlock, updateMemoryBlock, getBlockHistory } =
        await loadMemoryStorage(homeDir);

      const now = new Date().toISOString();
      createMemoryBlock({
        id: "blk-name-desc",
        name: "Original Name",
        description: "Original desc",
        content: "same content",
        scope: "global",
        projectId: "",
        createdAt: now,
        updatedAt: now,
        updatedBy: "agent",
        supersededBy: undefined,
        supersedes: undefined,
      });

      // Edit name only.
      updateMemoryBlock("blk-name-desc", { name: "New Name" });
      // Edit description only.
      updateMemoryBlock("blk-name-desc", { description: "New desc" });

      const history = getBlockHistory("blk-name-desc");
      // 2 history snapshots + current = 3.
      expect(history).toHaveLength(3);
      expect(history[0].name).toBe("Original Name");
      expect(history[1].name).toBe("New Name");
      expect(history[1].description).toBe("Original desc");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("cleans up history rows when a block is deleted", async () => {
    const homeDir = mkHomeDir();
    try {
      const {
        createMemoryBlock,
        updateMemoryBlock,
        getBlockHistory,
        deleteMemoryBlock,
        getDb,
      } = await loadMemoryStorage(homeDir);

      const now = new Date().toISOString();
      createMemoryBlock({
        id: "blk-delete-history",
        name: "Delete Me",
        description: "",
        content: "v0",
        scope: "global",
        projectId: "",
        createdAt: now,
        updatedAt: now,
        updatedBy: "agent",
        supersededBy: undefined,
        supersedes: undefined,
      });

      updateMemoryBlock("blk-delete-history", { content: "v1" });
      updateMemoryBlock("blk-delete-history", { content: "v2" });

      // Confirm history exists.
      expect(getBlockHistory("blk-delete-history")).toHaveLength(3);

      deleteMemoryBlock("blk-delete-history");

      // After deletion, history table should have zero rows for this block.
      const db = getDb();
      const rows = db
        .prepare("SELECT COUNT(*) AS cnt FROM memory_blocks_history WHERE blockId = ?")
        .get("blk-delete-history") as any;
      expect(rows.cnt).toBe(0);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("preserves projectId in history snapshots for project-scoped blocks", async () => {
    const homeDir = mkHomeDir();
    try {
      const { createMemoryBlock, updateMemoryBlock, getBlockHistory } =
        await loadMemoryStorage(homeDir);

      const now = new Date().toISOString();
      createMemoryBlock({
        id: "blk-proj-hist",
        name: "Project Block",
        description: "",
        content: "initial",
        scope: "project",
        projectId: "proj-123",
        createdAt: now,
        updatedAt: now,
        updatedBy: "agent",
        supersededBy: undefined,
        supersedes: undefined,
      });

      updateMemoryBlock("blk-proj-hist", { content: "edited" });

      const history = getBlockHistory("blk-proj-hist");
      expect(history).toHaveLength(2);
      // Both history snapshot and current should carry the projectId.
      expect(history[0].projectId).toBe("proj-123");
      expect(history[1].projectId).toBe("proj-123");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("returns only current block for a block with no edits", async () => {
    const homeDir = mkHomeDir();
    try {
      const { createMemoryBlock, getBlockHistory } =
        await loadMemoryStorage(homeDir);

      const now = new Date().toISOString();
      createMemoryBlock({
        id: "blk-no-history",
        name: "Fresh Block",
        description: "",
        content: "original",
        scope: "global",
        projectId: "",
        createdAt: now,
        updatedAt: now,
        updatedBy: "agent",
        supersededBy: undefined,
        supersedes: undefined,
      });

      const history = getBlockHistory("blk-no-history");
      // No edits → no history snapshots, just the current block.
      expect(history).toHaveLength(1);
      expect(history[0].content).toBe("original");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("uses distinct ids for history snapshots vs current block (React key stability)", async () => {
    const homeDir = mkHomeDir();
    try {
      const { createMemoryBlock, updateMemoryBlock, getBlockHistory } =
        await loadMemoryStorage(homeDir);

      const now = new Date().toISOString();
      createMemoryBlock({
        id: "blk-key-stability",
        name: "Key Test",
        description: "",
        content: "a",
        scope: "global",
        projectId: "",
        createdAt: now,
        updatedAt: now,
        updatedBy: "agent",
        supersededBy: undefined,
        supersedes: undefined,
      });

      updateMemoryBlock("blk-key-stability", { content: "b" });

      const history = getBlockHistory("blk-key-stability");
      expect(history).toHaveLength(2);

      // History snapshot ids are stringified rowids (numeric), while the current
      // block keeps its real id. They must be distinct for React key stability,
      // and the last entry must match the real block id for the "current" check.
      const [historicEntry, currentEntry] = history;
      expect(typeof historicEntry.id).toBe("string");
      // Rowid-based ids won't start with "blk-".
      expect(historicEntry.id).not.toBe("blk-key-stability");
      expect(currentEntry.id).toBe("blk-key-stability");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
