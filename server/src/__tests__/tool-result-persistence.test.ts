import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Direct contract tests for buildPersistedToolResult (routes/chat.ts) — the
 * ONE constructor for rows entering state.allToolResults. The wire/replay
 * shape test pins the endpoints (normalize + replay); this pins the plumbing
 * in between: how a tool_execution_end event becomes a persisted row.
 */
const PNG_DATA = Buffer.from("png-bytes").toString("base64");
const JPG_DATA = Buffer.from("jpg-bytes").toString("base64");

async function loadChatRoute(homeDir: string) {
  vi.resetModules();
  vi.doMock("os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("os")>();
    return {
      ...actual,
      homedir: () => homeDir,
    };
  });

  const { mkdirSync } = await import("fs");
  mkdirSync(join(homeDir, ".porrima"), { recursive: true });
  const chat = await import("../routes/chat.js");
  return chat;
}

interface ToolEndEvent {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  result?: { content?: string | any[] } | null;
}

function makeEvent(overrides: Partial<ToolEndEvent> = {}): ToolEndEvent {
  return {
    toolCallId: "call-1",
    toolName: "browser_screenshot",
    isError: false,
    result: {
      content: [
        { type: "text", text: "Screenshot of http://x/front.png" },
        { type: "image", data: PNG_DATA, mimeType: "image/png", name: "browser-screenshot" },
      ],
    },
    ...overrides,
  };
}

let spies: ReturnType<typeof vi.spyOn>[] = [];

/**
 * Silence the console AND register every spy for restoration in afterEach —
 * an unregistered spyOn on a shared object like console survives into the
 * next test (vitest returns the same installed spy, so call history leaks
 * between tests). Returns the warn spy for assertions.
 */
function quietConsole() {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  spies.push(
    warn,
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
  );
  return warn;
}

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  spies = [];
  vi.doUnmock("os");
  vi.resetModules();
});

describe("buildPersistedToolResult", () => {
  it("persists string content as text without images", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-trp-string-"));
    try {
      quietConsole();
      const { buildPersistedToolResult } = await loadChatRoute(homeDir);
      const row = await buildPersistedToolResult({
        toolCallId: "call-s",
        toolName: "bash",
        isError: false,
        result: { content: "hello string" },
      });
      expect(row).toEqual({
        toolCallId: "call-s",
        toolName: "bash",
        content: "hello string",
        isError: false,
      });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("persists images to disk and references them by id", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-trp-disk-"));
    try {
      quietConsole();
      const { buildPersistedToolResult } = await loadChatRoute(homeDir);
      const row = await buildPersistedToolResult(makeEvent());

      expect(row.content).toBe("Screenshot of http://x/front.png");
      expect(row.images).toHaveLength(1);
      const img = row.images![0];
      // Data stripped from the row; the disk file is the source of truth.
      expect(img.data).toBeUndefined();
      expect(img.id).toBeTruthy();
      expect(img.mimeType).toBe("image/png");
      expect(img.name).toBe("tool-result-call-1.png");
      expect(img.url).toBe(`/api/tool-result-images/${img.id}/image.png`);
      expect(
        existsSync(join(homeDir, ".porrima", "tool-result-images", img.id!, "image.png"))
      ).toBe(true);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("keeps multi-image order and per-image mime types", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-trp-multi-"));
    try {
      quietConsole();
      const { buildPersistedToolResult } = await loadChatRoute(homeDir);
      const row = await buildPersistedToolResult(
        makeEvent({
          toolCallId: "call-m",
          result: {
            content: [
              { type: "text", text: "two pages" },
              { type: "image", data: PNG_DATA, mimeType: "image/png" },
              { type: "image", data: JPG_DATA, mimeType: "image/jpeg" },
            ],
          },
        })
      );
      expect(row.images).toHaveLength(2);
      expect(row.images![0].name).toBe("tool-result-call-m.png");
      expect(row.images![0].mimeType).toBe("image/png");
      expect(row.images![1].name).toBe("tool-result-call-m.jpg");
      expect(row.images![1].mimeType).toBe("image/jpeg");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("warns loudly when text does not lead (single-leading-text-item convention)", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-trp-textlast-"));
    try {
      const warnSpy = quietConsole();
      const { buildPersistedToolResult } = await loadChatRoute(homeDir);
      const row = await buildPersistedToolResult(
        makeEvent({
          result: {
            content: [
              { type: "image", data: PNG_DATA, mimeType: "image/png" },
              { type: "text", text: "arrives too late for the row" },
            ],
          },
        })
      );
      // The row keeps content[0].text — an image has none — so the text is
      // lost from history; the warning is what makes that visible.
      expect(row.content).toBe("");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("single-leading-text-item");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("warns loudly on multiple text items", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-trp-twotext-"));
    try {
      const warnSpy = quietConsole();
      const { buildPersistedToolResult } = await loadChatRoute(homeDir);
      await buildPersistedToolResult(
        makeEvent({
          result: {
            content: [
              { type: "text", text: "first" },
              { type: "text", text: "second" },
            ],
          },
        })
      );
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("single-leading-text-item");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("handles a missing result without throwing", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-trp-null-"));
    try {
      quietConsole();
      const { buildPersistedToolResult } = await loadChatRoute(homeDir);
      const row = await buildPersistedToolResult({
        toolCallId: "call-u",
        toolName: "mystery",
        isError: true,
        result: null,
      });
      expect(row).toEqual({
        toolCallId: "call-u",
        toolName: "mystery",
        content: "",
        isError: true,
      });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("falls back to inline base64 when disk persist fails", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-trp-diskfail-"));
    try {
      const { buildPersistedToolResult } = await loadChatRoute(homeDir);
      // Block the images directory with a regular file so mkdir throws.
      writeFileSync(join(homeDir, ".porrima", "tool-result-images"), "blocker");
      quietConsole();
      const row = await buildPersistedToolResult(makeEvent());
      expect(row.content).toBe("Screenshot of http://x/front.png");
      expect(row.images).toHaveLength(1);
      const img = row.images![0];
      // Graceful degradation: the row keeps the bytes, replay still works,
      // no id to hydrate from.
      expect(img.data).toBe(PNG_DATA);
      expect(img.id).toBeUndefined();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
