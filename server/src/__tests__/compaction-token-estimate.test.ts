import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../types.js";
import { estimateContextTokens, estimateContextTokensWithExactToolResults } from "../services/compaction.js";
import { estimateTextTokens, isDenseTokenText } from "../services/token-count.js";

function denseSvg(lines = 140): string {
  return Array.from({ length: lines }, (_, i) => {
    const y = (i * 5.037).toFixed(2);
    const next = (i * 5.037 + 4.94).toFixed(2);
    return `<polygon points="0.00,${y} 250.00,${next} 500.00,${y}" fill="rgba(42,42,46,0.38)"/>`;
  }).join("\n");
}

describe("token estimation for dense tool results", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses a denser estimate for SVG-like tool output than prose", () => {
    const svg = denseSvg();
    const prose = "This is a normal English sentence with ordinary spacing and punctuation. ".repeat(200);

    const svgEstimate = estimateTextTokens(svg, "tool_result");
    const proseEstimate = estimateTextTokens(prose);

    expect(svgEstimate).toBeGreaterThan(Math.ceil(svg.length / 2));
    expect(proseEstimate).toBeLessThan(Math.ceil(prose.length / 3));
  });

  it("does not treat punctuation-heavy tables as dense solely from separators", () => {
    const table = [
      "| component | status | notes |",
      "| estimator | reviewing | separators should not dominate the estimate |",
      "| compaction | stable | exact counting handles large risky tool results |",
    ].join("\n").repeat(120);

    expect(isDenseTokenText(table)).toBe(false);
    expect(estimateTextTokens(table, "tool_result")).toBeLessThanOrEqual(Math.ceil(table.length / 2));
  });

  it("counts same-row tool results as additions after a usage anchor", () => {
    const svg = denseSvg();
    const usageTotal = 86_311;
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: "Find and inspect the latest SVG visual.",
        timestamp: 1,
      },
      {
        role: "assistant",
        content: "",
        thinking: "The latest visual is building_corner_up.svg. Let me read it.",
        usage: { input: 86_252, output: 59, totalTokens: usageTotal },
        toolCalls: [{ id: "call_1", name: "read_file", arguments: { path: "/tmp/building_corner_up.svg" } }],
        toolResults: [{
          toolCallId: "call_1",
          toolName: "read_file",
          content: svg,
          isError: false,
        }],
        timestamp: 2,
      },
    ];

    const estimate = estimateContextTokens(messages, "You are helpful.", []);
    const toolResultEstimate = estimateTextTokens(svg, "tool_result");

    expect(estimate).toBeGreaterThan(usageTotal + toolResultEstimate);
  });

  it("can refine risky post-usage tool results with llama.cpp tokenization", async () => {
    const content = `<svg>${"1.00,2.00 ".repeat(500)}</svg>`;
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        usage: { input: 10_000, output: 20, totalTokens: 10_020 },
        toolResults: [{
          toolCallId: "call_1",
          toolName: "read_file",
          content,
          isError: false,
        }],
        timestamp: 1,
      },
    ];
    const approximate = estimateContextTokens(messages, "System prompt", []);

    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ tokens: Array.from({ length: 8_000 }, (_, i) => i) }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )));

    const refined = await estimateContextTokensWithExactToolResults(
      messages,
      "System prompt",
      [],
      {
        baseUrl: "http://localhost:32100",
        modelId: "test-model",
        minToolResultChars: 1,
      },
    );

    expect(refined.approximateTokens).toBe(approximate);
    expect(refined.exactToolResultCount).toBe(1);
    expect(refined.estimatedTokens).toBeGreaterThan(approximate);
  });
});
