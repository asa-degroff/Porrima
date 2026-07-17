import { describe, expect, it } from "vitest";
import { getAgentToolDefinitions, getAgentTools, type ToolSideEffects } from "./agent-tools.js";

const effects: ToolSideEffects = {
  onArtifact: () => {},
  onVisual: () => {},
  onAskUser: () => {},
};

describe("agent tool registry", () => {
  it("keeps metadata and runtime chat-type gating aligned", () => {
    const systemDefinitions = getAgentToolDefinitions("system").map((tool) => tool.name);
    const systemRuntime = getAgentTools("system", effects, 32768, undefined, "system").map((tool) => tool.name);

    expect(systemDefinitions).toEqual(systemRuntime);
    expect(systemDefinitions).not.toContain("ask_user");
    expect(systemDefinitions).not.toContain("install_skill");
    expect(systemDefinitions).not.toContain("update_automation");
    expect(getAgentToolDefinitions("agent").map((tool) => tool.name)).toContain("schedule_reminder");
  });

  it("serializes mutating tools while retaining parallel reads", () => {
    const byName = new Map(getAgentTools("chat-1", effects).map((tool) => [tool.name, tool]));

    expect(byName.get("write_file")?.executionMode).toBe("sequential");
    expect(byName.get("run_python")?.executionMode).toBe("sequential");
    expect(byName.get("web_fetch")?.executionMode).toBe("sequential");
    expect(byName.get("read_file")?.executionMode).toBeUndefined();
    expect(byName.get("web_search")?.executionMode).toBeUndefined();
  });

  it("keeps p5 guidance out of the repeated tool schema", () => {
    const tools = getAgentTools("chat-1", effects);
    const artifactSchemas = tools
      .filter((tool) => tool.name === "create_artifact" || tool.name === "update_artifact")
      .map((tool) => JSON.stringify(tool));

    expect(artifactSchemas.join("\n")).not.toContain("prefer instance mode");
    expect(artifactSchemas.join("\n")).not.toContain("randomSeed");
  });

  it("uses bounded web schemas and domain-neutral pagination", () => {
    const byName = new Map(getAgentTools("chat-1", effects).map((tool) => [tool.name, tool]));
    const searchSchema = byName.get("web_search")?.parameters as any;
    const fetchTool = byName.get("web_fetch")!;
    const fetchSchema = fetchTool.parameters as any;

    expect(searchSchema.properties.provider.enum).toEqual(["brave", "exa", "tavily"]);
    expect(searchSchema.properties.providerOptions.additionalProperties).toBe(false);
    expect(fetchSchema.properties.offset.minimum).toBe(0);
    expect(fetchSchema.properties.limit.maximum).toBe(50000);
    expect(fetchTool.description).not.toContain("file path");
  });
});
