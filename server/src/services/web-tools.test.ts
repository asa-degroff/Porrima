import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildWebSearchTool,
  buildWebTools,
  executeWebTool,
  resolveWebSearchProvider,
} from "./web-tools.js";
import { getSettings } from "./chat-storage.js";

// The executors read the provider + keys from settings; pin per test.
vi.mock("./chat-storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chat-storage.js")>();
  return { ...actual, getSettings: vi.fn() };
});

afterEach(() => {
  vi.mocked(getSettings).mockReset();
});

function schemaProps(tool: ReturnType<typeof buildWebSearchTool>): string[] {
  const params = tool.parameters as { properties: Record<string, unknown> };
  return Object.keys(params.properties).sort();
}

describe("buildWebSearchTool (provider-specific schemas)", () => {
  it("brave: the flattest surface (query + count)", () => {
    const tool = buildWebSearchTool("brave");
    expect(tool.name).toBe("web_search");
    expect(schemaProps(tool)).toEqual(["count", "query"]);
    expect(tool.description).toContain("Brave");
  });

  it("exa: search modes, content options, and filters", () => {
    const tool = buildWebSearchTool("exa");
    expect(schemaProps(tool)).toEqual([
      "contents",
      "count",
      "endPublishedDate",
      "includeDomains",
      "query",
      "searchType",
      "startPublishedDate",
    ]);
    const params = tool.parameters as any;
    expect(params.properties.searchType.enum).toEqual(["auto", "neural", "keyword", "hybrid", "deep"]);
    expect(tool.description).toContain("Exa");
  });

  it("tavily: verticals, freshness, answer and raw content", () => {
    const tool = buildWebSearchTool("tavily");
    expect(schemaProps(tool)).toEqual([
      "count",
      "endPublishedDate",
      "excludeDomains",
      "includeAnswer",
      "includeDomains",
      "includeRawContent",
      "query",
      "searchDepth",
      "startPublishedDate",
      "timeRange",
      "topic",
    ]);
    expect(tool.description).toContain("Tavily");
  });

  it("deepseek: query, count, need_content — with operator hints in the description", () => {
    const tool = buildWebSearchTool("deepseek");
    expect(schemaProps(tool)).toEqual(["count", "need_content", "query"]);
    const params = tool.parameters as any;
    expect(params.properties.count).toMatchObject({ minimum: 1, maximum: 50 });
    expect(params.properties.query.description).toContain("site:");
    expect(params.properties.query.description).toContain("after:");
    expect(params.properties.need_content.description).toContain("default false");
    expect(tool.description).toContain("DeepSeek");
    expect(tool.description).toContain("need_content");
  });

  it("no provider surface leaks into any schema", () => {
    for (const provider of ["brave", "exa", "tavily", "deepseek"] as const) {
      const params = buildWebSearchTool(provider).parameters as any;
      expect(params.properties.provider).toBeUndefined();
      expect(params.properties.providerOptions).toBeUndefined();
    }
  });

  it("buildWebTools: provider web_search plus the static web_fetch", () => {
    const tools = buildWebTools("deepseek");
    expect(tools.map((t) => t.name)).toEqual(["web_search", "web_fetch"]);
  });
});

describe("resolveWebSearchProvider", () => {
  it("accepts each configured provider and falls back to brave", () => {
    expect(resolveWebSearchProvider({ defaultWebSearchProvider: "deepseek" })).toBe("deepseek");
    expect(resolveWebSearchProvider({ defaultWebSearchProvider: "exa" })).toBe("exa");
    expect(resolveWebSearchProvider({ defaultWebSearchProvider: "tavily" })).toBe("tavily");
    expect(resolveWebSearchProvider({ defaultWebSearchProvider: "brave" })).toBe("brave");
    expect(resolveWebSearchProvider({ defaultWebSearchProvider: undefined })).toBe("brave");
    expect(resolveWebSearchProvider({ defaultWebSearchProvider: "bogus" })).toBe("brave");
    expect(resolveWebSearchProvider(null)).toBe("brave");
  });
});

describe("executeWebTool (deepseek guards, no network)", () => {
  it("rejects a provider argument that conflicts with settings", async () => {
    vi.mocked(getSettings).mockResolvedValue({ defaultWebSearchProvider: "brave" } as any);
    const result = await executeWebTool({
      type: "toolCall",
      id: "tc-1",
      name: "web_search",
      arguments: { query: "test", provider: "deepseek" },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no longer a parameter");
    expect(result.content).toContain("brave");
  });

  it("reports a missing key without calling the API", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    vi.mocked(getSettings).mockResolvedValue({ defaultWebSearchProvider: "deepseek" } as any);
    const result = await executeWebTool({
      type: "toolCall",
      id: "tc-2",
      name: "web_search",
      arguments: { query: "test" },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no API key configured");
    expect(result.content).toContain("DEEPSEEK_API_KEY");
  });
});
