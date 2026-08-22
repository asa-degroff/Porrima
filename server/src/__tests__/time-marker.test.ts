import { describe, expect, it } from "vitest";
import { applyTimeMarker, createTimeMarkerState } from "../services/time-marker.js";
import { wrapToolsWithTimeMarker } from "../services/agent-tools.js";

const MIN = 60_000;

function textResult(text: string) {
  return { content: [{ type: "text", text }], details: {} };
}

function firstText(result: any): string {
  return result.content.find((part: any) => part.type === "text")?.text ?? "";
}

describe("createTimeMarkerState", () => {
  it("disables markers for 0, negative, undefined, or non-finite intervals", () => {
    expect(createTimeMarkerState(0, 1000)).toBeNull();
    expect(createTimeMarkerState(-5, 1000)).toBeNull();
    expect(createTimeMarkerState(undefined, 1000)).toBeNull();
    expect(createTimeMarkerState(NaN, 1000)).toBeNull();
    expect(createTimeMarkerState(Infinity, 1000)).toBeNull();
  });

  it("creates state with the interval in ms and the loop start", () => {
    const state = createTimeMarkerState(15, 5000);
    expect(state).not.toBeNull();
    expect(state?.intervalMs).toBe(15 * MIN);
    expect(state?.loopStartMs).toBe(5000);
    expect(state?.lastMarkerMs).toBeNull();
    expect(state?.markerCount).toBe(0);
  });
});

describe("applyTimeMarker", () => {
  it("returns the same result unchanged when state is null", () => {
    const result = textResult("hi");
    expect(applyTimeMarker(result, null)).toBe(result);
  });

  it("returns the same result unchanged before the gate elapses", () => {
    const state = createTimeMarkerState(15, 0)!;
    const result = textResult("hi");
    expect(applyTimeMarker(result, state, 14 * MIN + 59_999)).toBe(result);
    expect(state.markerCount).toBe(0);
    expect(state.lastMarkerMs).toBeNull();
  });

  it("fires at exactly the interval with a turn-start delta", () => {
    const state = createTimeMarkerState(15, 0)!;
    const result = applyTimeMarker(textResult("hi"), state, 15 * MIN);
    expect(firstText(result)).toBe(`hi\n\n[time: 1970-01-01 00:15 UTC — 15m since turn start]`);
    expect(state.lastMarkerMs).toBe(15 * MIN);
    expect(state.markerCount).toBe(1);
  });

  it("does not fire a second marker before the next interval", () => {
    const state = createTimeMarkerState(15, 0)!;
    applyTimeMarker(textResult("one"), state, 15 * MIN);
    const second = textResult("two");
    expect(applyTimeMarker(second, state, 25 * MIN)).toBe(second);
    expect(state.markerCount).toBe(1);
  });

  it("anchors later markers to the previous marker", () => {
    const state = createTimeMarkerState(15, 0)!;
    applyTimeMarker(textResult("one"), state, 15 * MIN);
    const result = applyTimeMarker(textResult("two"), state, 52 * MIN);
    expect(firstText(result)).toBe("two\n\n[time: 1970-01-01 00:52 UTC — 37m since last marker]");
    expect(state.markerCount).toBe(2);
  });

  it("formats hour-scale deltas as Hh Mm", () => {
    const state = createTimeMarkerState(15, 0)!;
    applyTimeMarker(textResult("one"), state, 15 * MIN);
    const result = applyTimeMarker(textResult("two"), state, (15 + 65) * MIN);
    expect(firstText(result)).toBe("two\n\n[time: 1970-01-01 01:20 UTC — 1h 05m since last marker]");
  });

  it("appends a text part to image-only results", () => {
    const state = createTimeMarkerState(15, 0)!;
    const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
    const result = applyTimeMarker({ content: [image], details: {} }, state, 15 * MIN);
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual(image);
    expect(result.content[1].type).toBe("text");
    expect((result.content[1] as any).text).toContain("since turn start");
  });

  it("marks the existing text part of multi-part results and leaves images untouched", () => {
    const state = createTimeMarkerState(15, 0)!;
    const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
    const result = applyTimeMarker(
      { content: [{ type: "text", text: "body" }, image], details: {} },
      state,
      15 * MIN,
    );
    expect(result.content).toHaveLength(2);
    expect(firstText(result)).toContain("body");
    expect(firstText(result)).toContain("[time:");
    expect(result.content[1]).toEqual(image);
  });

  it("preserves extra result fields and does not mutate the input", () => {
    const state = createTimeMarkerState(15, 0)!;
    const input = {
      content: [{ type: "text", text: "hi" }],
      details: {},
      usage: { input: 1, output: 2 },
    };
    const result = applyTimeMarker(input, state, 15 * MIN);
    expect(result.usage).toEqual({ input: 1, output: 2 });
    expect(result).not.toBe(input);
    expect(input.content[0].text).toBe("hi");
    expect(firstText(result)).toContain("[time:");
  });

  it("emits at most one marker across a parallel batch completing at the same instant", () => {
    const state = createTimeMarkerState(15, 0)!;
    const a = applyTimeMarker(textResult("a"), state, 15 * MIN);
    const b = applyTimeMarker(textResult("b"), state, 15 * MIN);
    const marked = [a, b].filter((r) => firstText(r).includes("[time:")).length;
    expect(marked).toBe(1);
    expect(state.markerCount).toBe(1);
  });
});

describe("wrapToolsWithTimeMarker", () => {
  function fakeTool(name: string): any {
    return {
      name,
      label: name,
      execute: async (_toolCallId: string, _params: unknown) => textResult(`result of ${name}`),
    };
  }

  it("passes tools through untouched when state is null", async () => {
    const tool = fakeTool("bash");
    const wrapped = wrapToolsWithTimeMarker([tool], null);
    expect(wrapped).toEqual([tool]);
    expect(wrapped[0].execute).toBe(tool.execute);
  });

  it("shares one gate across wrapped tools (at most one marker per batch)", async () => {
    const state = createTimeMarkerState(15, 0)!;
    const [a, b] = wrapToolsWithTimeMarker([fakeTool("bash"), fakeTool("read_file")], state);
    const [ra, rb] = await Promise.all([
      a.execute("c1", {}),
      b.execute("c2", {}),
    ]);
    // Real Date.now() makes the gate nondeterministic here; assert structure:
    // exactly the two results exist, each is a valid result, and at most one
    // carries a marker (gate state is shared and synchronous).
    const marked = [ra, rb].filter((r) => firstText(r).includes("[time:")).length;
    expect(marked).toBeLessThanOrEqual(1);
    expect(state.markerCount).toBe(marked);
    expect(firstText(ra)).toContain("result of bash");
    expect(firstText(rb)).toContain("result of read_file");
  });

  it("never marks when the loop is younger than the interval", async () => {
    // Fresh state at loopStart = now → gate cannot have elapsed.
    const state = createTimeMarkerState(1440, Date.now())!;
    const [a] = wrapToolsWithTimeMarker([fakeTool("bash")], state);
    const ra = await a.execute("c1", {});
    expect(firstText(ra)).not.toContain("[time:");
    expect(state.markerCount).toBe(0);
  });
});

describe("getAgentTools time-marker integration", () => {
  const noopEffects = {
    onArtifact: () => {},
    onVisual: () => {},
    onAskUser: () => {},
  };

  it("marks the first tool result when the gate has already elapsed", async () => {
    const { getAgentTools } = await import("../services/agent-tools.js");
    // Loop started 20 minutes ago, 15-minute interval → gate already open.
    const state = createTimeMarkerState(15, Date.now() - 20 * MIN)!;
    const tools = getAgentTools("probe-chat", noopEffects as any, 32768, undefined, "agent", state);
    const bash = tools.find((t) => t.name === "bash");
    expect(bash).toBeDefined();
    const result = await bash!.execute("tc-1", { command: "echo marker-probe" } as any);
    expect(firstText(result)).toContain("marker-probe");
    expect(firstText(result)).toMatch(/\n\n\[time: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC — 20m since turn start\]\s*$/);
    expect(state.markerCount).toBe(1);
  });

  it("leaves results untouched while the loop is younger than the interval", async () => {
    const { getAgentTools } = await import("../services/agent-tools.js");
    const state = createTimeMarkerState(15, Date.now())!;
    const tools = getAgentTools("probe-chat", noopEffects as any, 32768, undefined, "agent", state);
    const bash = tools.find((t) => t.name === "bash");
    const result = await bash!.execute("tc-2", { command: "echo no-marker" } as any);
    expect(firstText(result)).toContain("no-marker");
    expect(firstText(result)).not.toContain("[time:");
    expect(state.markerCount).toBe(0);
  });
});
