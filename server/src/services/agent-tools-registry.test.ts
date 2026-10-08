import { describe, expect, it, vi } from "vitest";
import { getAgentToolDefinitions, getAgentTools, type ToolSideEffects } from "./agent-tools.js";

// Spy on the kernel boundary so timeout-resolution tests never spawn a
// real kernel process.
vi.mock("./python-kernel.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./python-kernel.js")>();
  return {
    ...actual,
    executeInKernel: vi.fn(async () => ({ mode: "kernel", content: "1", isError: false })),
  };
});

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
    // Automation management stays available in system/headless chats —
    // reminder chaining from within automation runs is deliberate.
    expect(systemDefinitions).toContain("schedule_reminder");
    expect(systemDefinitions).toContain("list_automations");
    expect(systemDefinitions).toContain("update_automation");
    // Cross-chat messaging is available to system/headless chats too (a
    // verification turn can report its result to a target thread).
    expect(systemDefinitions).toContain("schedule_chat_message");
    expect(systemDefinitions).toContain("list_chats");
    // The persistent kernel runs in system chats, so its control surface must
    // be present too — python_jobs is the only completion read between
    // scheduled runs and the only model-reachable kill/wedge escape.
    expect(systemDefinitions).toContain("python_jobs");
    expect(getAgentToolDefinitions("agent").map((tool) => tool.name)).toContain("schedule_reminder");
    expect(getAgentToolDefinitions("agent").map((tool) => tool.name)).toContain("schedule_chat_message");
    expect(getAgentToolDefinitions("agent").map((tool) => tool.name)).toContain("list_chats");
  });

  it("serializes mutating tools while retaining parallel reads", () => {
    const byName = new Map(getAgentTools("chat-1", effects).map((tool) => [tool.name, tool]));

    expect(byName.get("write_file")?.executionMode).toBe("sequential");
    expect(byName.get("run_python")?.executionMode).toBe("sequential");
    expect(byName.get("web_fetch")?.executionMode).toBe("sequential");
    expect(byName.get("read_file")?.executionMode).toBeUndefined();
    expect(byName.get("web_search")?.executionMode).toBeUndefined();
  });

  it("resolves run_python timeout defaults by execution path", async () => {
    const { executeInKernel } = await import("./python-kernel.js");
    const spy = executeInKernel as unknown as ReturnType<typeof vi.fn>;
    const py = getAgentTools("chat-1", effects).find((t) => t.name === "run_python")!;

    // Background with no timeout defaults to the background ceiling.
    await py.execute("t1", { code: "1", background: true });
    expect(spy.mock.calls.at(-1)?.[0].timeoutMs).toBe(3600_000);
    expect(spy.mock.calls.at(-1)?.[0].background).toBe(true);

    // Foreground with no timeout keeps the 30 s fast-fail signal.
    await py.execute("t2", { code: "1" });
    expect(spy.mock.calls.at(-1)?.[0].timeoutMs).toBe(30_000);

    // Explicit timeouts pass through (background).
    await py.execute("t3", { code: "1", background: true, timeout: 45 });
    expect(spy.mock.calls.at(-1)?.[0].timeoutMs).toBe(45_000);

    // Foreground is still clamped to its 300 s max.
    await py.execute("t4", { code: "1", timeout: 400 });
    expect(spy.mock.calls.at(-1)?.[0].timeoutMs).toBe(300_000);
  });

  it("routes system-chat run_python through the persistent kernel", async () => {
    const { executeInKernel } = await import("./python-kernel.js");
    const spy = executeInKernel as unknown as ReturnType<typeof vi.fn>;
    const py = getAgentTools("system", effects, 32768, undefined, "system")
      .find((t) => t.name === "run_python")!;

    await py.execute("t1", { code: "1", background: true });
    expect(spy.mock.calls.at(-1)?.[0]).toMatchObject({ chatId: "system", background: true });

    // No chat-type stateless notice — the kernel path answers for system
    // chats now; only remote workspaces and fallbacks carry notices.
    const resultText = JSON.stringify(await py.execute("t2", { code: "1" }));
    expect(resultText).not.toContain("stateless mode in this chat type");
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
