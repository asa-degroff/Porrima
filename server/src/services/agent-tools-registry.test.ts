import { describe, expect, it, vi } from "vitest";
import { getAgentToolDefinitions, getAgentTools, type ToolSideEffects } from "./agent-tools.js";

// getAgentTools reads the web-search provider from settings; pin it so the
// suite never opens the live data dir and the web_search schema is
// deterministic (brave).
vi.mock("./chat-storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chat-storage.js")>();
  return { ...actual, getSettings: vi.fn(async () => ({ defaultWebSearchProvider: "brave" })) };
});


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
  it("keeps metadata and runtime chat-type gating aligned", async () => {
    const systemDefinitions = (await getAgentToolDefinitions("system")).map((tool) => tool.name);
    const systemRuntime = (await getAgentTools("system", effects, 32768, undefined, "system")).map((tool) => tool.name);

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
    // be present too — jobs is the only completion read between scheduled runs
    // and the only model-reachable kill/wedge escape. jobs is the general
    // surface; python_jobs is the deprecated alias for one release.
    expect(systemDefinitions).toContain("jobs");
    expect(systemDefinitions).toContain("python_jobs");
    expect((await getAgentToolDefinitions("agent")).map((tool) => tool.name)).toContain("schedule_reminder");
    expect((await getAgentToolDefinitions("agent")).map((tool) => tool.name)).toContain("schedule_chat_message");
    expect((await getAgentToolDefinitions("agent")).map((tool) => tool.name)).toContain("list_chats");
  });

  it("serializes mutating tools while retaining parallel reads", async () => {
    const byName = new Map((await getAgentTools("chat-1", effects)).map((tool) => [tool.name, tool]));

    expect(byName.get("write_file")?.executionMode).toBe("sequential");
    expect(byName.get("run_python")?.executionMode).toBe("sequential");
    expect(byName.get("jobs")?.executionMode).toBe("sequential");
    expect(byName.get("web_fetch")?.executionMode).toBe("sequential");
    expect(byName.get("read_file")?.executionMode).toBeUndefined();
    expect(byName.get("web_search")?.executionMode).toBeUndefined();
  });

  it("normalizes ask_user preset answers before notifying the route", async () => {
    const onAskUser = vi.fn();
    const tools = await getAgentTools("chat-1", { onArtifact: () => {}, onVisual: () => {}, onAskUser });
    const ask = tools.find((t) => t.name === "ask_user")!;

    // Trim, dedupe, drop non-strings/empties, cap at 6.
    await ask.execute("a1", {
      question: "Which name?",
      options: ["  Ann ", "Ann", "", "Ben", 42, "Cleo", "Dee", "Eve", "Fay", "Gus"],
    });
    expect(onAskUser).toHaveBeenCalledWith("Which name?", "a1", ["Ann", "Ben", "Cleo", "Dee", "Eve", "Fay"]);

    // Fewer than two usable options degrades to a plain free-form ask.
    onAskUser.mockClear();
    await ask.execute("a2", { question: "Proceed?", options: ["Yes", "", " "] });
    expect(onAskUser).toHaveBeenCalledWith("Proceed?", "a2", undefined);

    // Options absent keeps the legacy two-arg call shape.
    onAskUser.mockClear();
    await ask.execute("a3", { question: "Proceed?" });
    expect(onAskUser).toHaveBeenCalledWith("Proceed?", "a3", undefined);
  });

  it("resolves run_python timeout defaults by execution path", async () => {
    const { executeInKernel } = await import("./python-kernel.js");
    const spy = executeInKernel as unknown as ReturnType<typeof vi.fn>;
    const py = (await getAgentTools("chat-1", effects)).find((t) => t.name === "run_python")!;

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
    const py = (await getAgentTools("system", effects, 32768, undefined, "system"))
      .find((t) => t.name === "run_python")!;

    await py.execute("t1", { code: "1", background: true });
    expect(spy.mock.calls.at(-1)?.[0]).toMatchObject({ chatId: "system", background: true });

    // No chat-type stateless notice — the kernel path answers for system
    // chats now; only remote workspaces and fallbacks carry notices.
    const resultText = JSON.stringify(await py.execute("t2", { code: "1" }));
    expect(resultText).not.toContain("stateless mode in this chat type");
  });

  it("keeps p5 guidance out of the repeated tool schema", async () => {
    const tools = await getAgentTools("chat-1", effects);
    const artifactSchemas = tools
      .filter((tool) => tool.name === "create_artifact" || tool.name === "update_artifact")
      .map((tool) => JSON.stringify(tool));

    expect(artifactSchemas.join("\n")).not.toContain("prefer instance mode");
    expect(artifactSchemas.join("\n")).not.toContain("randomSeed");
  });

  it("uses provider-specific web schemas and domain-neutral pagination", async () => {
    const byName = new Map((await getAgentTools("chat-1", effects)).map((tool) => [tool.name, tool]));
    const searchTool = byName.get("web_search")!;
    const searchSchema = searchTool.parameters as any;
    const fetchTool = byName.get("web_fetch")!;
    const fetchSchema = fetchTool.parameters as any;

    // brave is the pinned settings provider: only its parameters reach the
    // schema, and the multi-provider surface (provider / providerOptions) is
    // gone.
    expect(Object.keys(searchSchema.properties).sort()).toEqual(["count", "query"]);
    expect(searchSchema.properties.provider).toBeUndefined();
    expect(searchSchema.properties.providerOptions).toBeUndefined();
    expect(searchTool.description).toContain("Brave");
    expect(fetchSchema.properties.offset.minimum).toBe(0);
    expect(fetchSchema.properties.limit.maximum).toBe(50000);
    expect(fetchTool.description).not.toContain("file path");
  });
});
