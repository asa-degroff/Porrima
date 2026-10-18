import { describe, expect, it, vi } from "vitest";
import { getAgentToolDefinitions, getAgentTools, type ToolSideEffects } from "./agent-tools.js";
import { BROWSER_TOOLS, executeBrowserTool } from "./browser-tools.js";
import type { ToolCall } from "@earendil-works/pi-ai";

// getAgentTools reads the web-search provider from settings; pin it so the
// suite never opens the live data dir and the web_search schema is
// deterministic (brave).
vi.mock("./chat-storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chat-storage.js")>();
  return { ...actual, getSettings: vi.fn(async () => ({ defaultWebSearchProvider: "brave" })) };
});


const effects: ToolSideEffects = {
  onArtifact: () => {},
  onVisual: () => {},
  onAskUser: () => {},
};

const BROWSER_TOOL_NAMES = BROWSER_TOOLS.map((tool) => tool.name);

function call(name: string, args: Record<string, any>): ToolCall {
  return { type: "toolCall", id: "t1", name, arguments: args };
}

describe("browser tool registry", () => {
  it("registers all six browser tools in sequential mode", async () => {
    const byName = new Map((await getAgentTools("chat-1", effects)).map((tool) => [tool.name, tool]));
    for (const name of BROWSER_TOOL_NAMES) {
      expect(byName.get(name)?.executionMode, name).toBe("sequential");
    }
  });

  it("exposes browser tools in agent chat definitions", async () => {
    const names = (await getAgentToolDefinitions("agent")).map((tool) => tool.name);
    for (const name of BROWSER_TOOL_NAMES) {
      expect(names).toContain(name);
    }
  });

  it("keeps snapshot and navigation schemas bounded", () => {
    const byName = new Map(BROWSER_TOOLS.map((tool) => [tool.name, tool]));
    const snapshotSchema = byName.get("browser_snapshot")!.parameters as any;
    const navSchema = byName.get("browser_navigate")!.parameters as any;
    const clickSchema = byName.get("browser_click")!.parameters as any;
    const hoverSchema = byName.get("browser_hover")!.parameters as any;

    expect(snapshotSchema.properties.limit.maximum).toBe(300);
    expect(snapshotSchema.properties.limit.minimum).toBe(10);
    expect(navSchema.properties.timeout.minimum).toBe(5);
    expect(navSchema.properties.timeout.maximum).toBe(60);
    expect(clickSchema.properties.ref.type).toBe("integer");
    expect(hoverSchema.properties.ref.type).toBe("integer");
  });

  it("keeps the combined browser schema compact", () => {
    const serialized = JSON.stringify(BROWSER_TOOLS);
    // Sanity bound: five lean tools should stay well under a few KB of schema.
    expect(serialized.length).toBeLessThan(4000);
  });

  it("rejects non-http(s) URLs without launching a browser", async () => {
    const result = await executeBrowserTool(call("browser_navigate", { url: "javascript:alert(1)" }), "chat-1");
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("http:// or https://");
  });

  it("rejects malformed refs without launching a browser", async () => {
    const result = await executeBrowserTool(call("browser_click", { ref: -3 }), "chat-1");
    expect(result.isError).toBe(true);
  });

  it("rejects malformed hover refs without launching a browser", async () => {
    const result = await executeBrowserTool(call("browser_hover", { ref: 0 }), "chat-1");
    expect(result.isError).toBe(true);
  });
});
