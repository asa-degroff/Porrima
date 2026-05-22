import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Artifact, InlineVisual } from "../types.js";
import type { ToolSideEffects } from "./agent-tools.js";

let dataDir: string;

async function loadAgentTools() {
  vi.resetModules();
  dataDir = await mkdtemp(join(tmpdir(), "porrima-agent-tools-"));
  process.env.PORRIMA_DATA_DIR = dataDir;
  return import("./agent-tools.js");
}

function createEffects() {
  const artifacts: Artifact[] = [];
  const visuals: InlineVisual[] = [];
  const effects: ToolSideEffects = {
    onArtifact: (artifact) => artifacts.push(artifact),
    onVisual: (visual) => visuals.push(visual),
    onAskUser: () => {},
  };
  return { effects, artifacts, visuals };
}

describe("agent artifact update tool", () => {
  beforeEach(() => {
    delete process.env.PORRIMA_DATA_DIR;
  });

  afterEach(async () => {
    delete process.env.PORRIMA_DATA_DIR;
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("registers only one update_artifact executor", async () => {
    const { getAgentTools } = await loadAgentTools();
    const { effects } = createEffects();
    const tools = getAgentTools("chat-1", effects);

    expect(tools.filter((tool) => tool.name === "update_artifact")).toHaveLength(1);
  });

  it("updates visuals through update_artifact", async () => {
    const { executeTool } = await loadAgentTools();
    const { effects, artifacts, visuals } = createEffects();

    const createResult = await executeTool({
      id: "create-visual",
      name: "create_visual",
      arguments: {
        title: "Inline chart",
        html: "<html><head></head><body>v1</body></html>",
      },
    }, "chat-1", effects);

    expect(createResult.isError).toBe(false);
    expect(visuals).toHaveLength(1);
    const visualId = visuals[0].id;

    const updateResult = await executeTool({
      id: "update-visual",
      name: "update_artifact",
      arguments: {
        artifactId: visualId,
        html: "<html><head></head><body>v2</body></html>",
        changeSummary: "Updated body text",
      },
    }, "chat-1", effects);

    expect(updateResult.isError).toBe(false);
    expect(updateResult.content).toContain("Visual updated to version 2");
    expect(artifacts).toHaveLength(0);
    expect(visuals).toHaveLength(2);
    expect(visuals[1]).toMatchObject({
      id: visualId,
      url: `/api/visuals/${visualId}/versions/2`,
      version: 2,
    });

    const updatedHtml = await readFile(
      join(dataDir, "visuals", visualId, "versions", "2", "index.html"),
      "utf-8",
    );
    expect(updatedHtml).toContain("v2");
  });
});
