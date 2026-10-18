import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import type { Project } from "../types.js";

type StorageModule = typeof import("../services/chat-storage.js");

async function loadChatStorage(homeDir: string) {
  vi.resetModules();
  vi.doMock("os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("os")>();
    return {
      ...actual,
      homedir: () => homeDir,
    };
  });

  mkdirSync(join(homeDir, ".porrima"), { recursive: true });
  return import("../services/chat-storage.js");
}

function makeProject(id: string, opts: { pinned?: boolean; lastModified?: string } = {}): Project {
  const now = new Date("2026-10-17T00:00:00.000Z").toISOString();
  return {
    id,
    name: `Project ${id}`,
    path: `/tmp/porrima-test/${id}`,
    color: "emerald",
    pinned: opts.pinned ?? false,
    createdAt: now,
    lastModified: opts.lastModified ?? now,
  };
}

function ids(projects: Project[]): string[] {
  return projects.map((project) => project.id);
}

async function withStorage(homeDir: string, fn: (storage: StorageModule) => Promise<void>) {
  try {
    const storage = await loadChatStorage(homeDir);
    await fn(storage);
    storage.closeChatDb();
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.doUnmock("os");
  vi.resetModules();
});

describe("project rail ordering", () => {
  it("new projects land at the top of their group", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-project-order-"));
    await withStorage(homeDir, async (storage) => {
      await storage.createProject(makeProject("a"));
      await storage.createProject(makeProject("b"));
      await storage.createProject(makeProject("c"));
      expect(ids(await storage.listProjects())).toEqual(["c", "b", "a"]);
      await storage.createProject(makeProject("p", { pinned: true }));
      expect(ids(await storage.listProjects())).toEqual(["p", "c", "b", "a"]);
    });
  });

  it("lists projects by pinned group, then unpinned group, each in explicit order", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-project-order-"));
    await withStorage(homeDir, async (storage) => {
      await storage.createProject(makeProject("a"));
      await storage.createProject(makeProject("b"));
      await storage.createProject(makeProject("c"));
      await storage.createProject(makeProject("d"));
      // Pin d at the top of the pinned group; a moves to the top of the unpinned group.
      await storage.reorderProjects(["d"], ["a", "c", "b"]);
      const projects = await storage.listProjects();
      expect(ids(projects)).toEqual(["d", "a", "c", "b"]);
      expect(projects[0].pinned).toBe(true);
      expect(projects[1].pinned).toBe(false);
    });
  });

  it("reordering across the boundary pins and unpins projects", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-project-order-"));
    await withStorage(homeDir, async (storage) => {
      await storage.createProject(makeProject("a", { pinned: true }));
      await storage.createProject(makeProject("b", { pinned: true }));
      await storage.createProject(makeProject("c"));
      await storage.createProject(makeProject("d"));
      // a pinned at the top, b unpinned to the top of the unpinned group, d last.
      await storage.reorderProjects(["a"], ["b", "c", "d"]);
      const projects = await storage.listProjects();
      expect(ids(projects)).toEqual(["a", "b", "c", "d"]);
      expect(projects.map((project) => project.pinned)).toEqual([true, false, false, false]);
    });
  });

  it("a pin flip via updateProject moves the project to the top of its new group", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-project-order-"));
    await withStorage(homeDir, async (storage) => {
      await storage.createProject(makeProject("a"));
      await storage.createProject(makeProject("b"));
      await storage.createProject(makeProject("c"));
      // Unpinned group: c, b, a. Pin b.
      await storage.updateProject("b", { pinned: true });
      expect(ids(await storage.listProjects())).toEqual(["b", "c", "a"]);
      // Unpin b again: it lands at the top of the unpinned group.
      await storage.updateProject("b", { pinned: false });
      expect(ids(await storage.listProjects())).toEqual(["b", "c", "a"]);
    });
  });

  it("updating other fields does not disturb the explicit order", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-project-order-"));
    await withStorage(homeDir, async (storage) => {
      await storage.createProject(makeProject("a"));
      await storage.createProject(makeProject("b"));
      await storage.createProject(makeProject("c"));
      await storage.reorderProjects([], ["c", "a", "b"]);
      await storage.updateProject("b", { name: "Renamed" });
      const projects = await storage.listProjects();
      expect(ids(projects)).toEqual(["c", "a", "b"]);
      expect(projects.find((project) => project.id === "b")?.name).toBe("Renamed");
    });
  });

  it("deleteProject preserves the relative order of the remaining projects", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-project-order-"));
    await withStorage(homeDir, async (storage) => {
      await storage.createProject(makeProject("a"));
      await storage.createProject(makeProject("b"));
      await storage.createProject(makeProject("c"));
      await storage.deleteProject("b");
      expect(ids(await storage.listProjects())).toEqual(["c", "a"]);
    });
  });

  it("backfills sortOrder from the legacy implicit order on upgrade", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-project-order-"));
    mkdirSync(join(homeDir, ".porrima"), { recursive: true });
    // Pre-seed an old-schema database (no sortOrder column) with a known
    // lastModified order: d newest, then b, a; c is the only pinned project.
    const legacy = new Database(join(homeDir, ".porrima", "app.db"));
    legacy.exec(`
      CREATE TABLE chats (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        type TEXT NOT NULL,
        modelId TEXT NOT NULL,
        contextWindow INTEGER,
        projectId TEXT,
        activeSkills TEXT,
        messages JSON NOT NULL,
        createdAt TEXT NOT NULL,
        lastModified TEXT NOT NULL
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        locationType TEXT NOT NULL DEFAULT 'local',
        color TEXT NOT NULL DEFAULT 'emerald',
        pinned INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        lastModified TEXT NOT NULL
      );
    `);
    const insert = legacy.prepare(
      "INSERT INTO projects (id, name, path, color, pinned, createdAt, lastModified) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    insert.run("a", "A", "/tmp/a", "emerald", 0, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    insert.run("b", "B", "/tmp/b", "emerald", 0, "2026-02-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
    insert.run("c", "C", "/tmp/c", "emerald", 1, "2026-03-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z");
    insert.run("d", "D", "/tmp/d", "emerald", 0, "2026-04-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z");
    legacy.close();

    try {
      const storage = await loadChatStorage(homeDir);
      // Legacy display order: c (pinned) first, then unpinned by lastModified
      // descending: d, b, a.
      const projects = await storage.listProjects();
      expect(ids(projects)).toEqual(["c", "d", "b", "a"]);
      const rows = storage
        .getDb()
        .prepare("SELECT id, sortOrder FROM projects")
        .all() as { id: string; sortOrder: number }[];
      const byId = new Map(rows.map((row) => [row.id, row.sortOrder]));
      expect(byId.get("c")).toBe(0);
      expect(byId.get("d")).toBe(0);
      expect(byId.get("b")).toBe(1);
      expect(byId.get("a")).toBe(2);
      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
