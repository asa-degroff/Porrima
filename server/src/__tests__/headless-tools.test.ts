import { describe, expect, it, vi } from "vitest";
import { withHeadlessAskUser } from "../services/headless-tools.js";

describe("withHeadlessAskUser", () => {
  it("keeps the ask_user schema byte-identical and swaps only the executor", async () => {
    const originalExecute = vi.fn();
    const askUser: any = {
      name: "ask_user",
      description: "Pause and ask the user a question.",
      parameters: {
        type: "object",
        properties: { question: { type: "string" } },
        required: ["question"],
      },
      execute: originalExecute,
    };
    const bash: any = { name: "bash", description: "Run a command.", parameters: {}, execute: vi.fn() };

    const [mappedAsk, mappedBash] = withHeadlessAskUser([askUser, bash]);

    // Schema fields must serialize identically — tool schemas render into the
    // system prompt, so any difference busts the KV prefix.
    expect(mappedAsk.name).toBe(askUser.name);
    expect(mappedAsk.description).toBe(askUser.description);
    expect(mappedAsk.parameters).toBe(askUser.parameters);
    // Only behavior changes.
    expect(mappedAsk.execute).not.toBe(originalExecute);
    expect(mappedBash).toBe(bash);

    const result: any = await mappedAsk.execute("call-1", { question: "Continue?" });
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("unavailable in headless runs");
    expect(originalExecute).not.toHaveBeenCalled();
  });

  it("is a no-op for tool arrays without ask_user", () => {
    const tools: any[] = [{ name: "bash" }, { name: "read_file" }];
    expect(withHeadlessAskUser(tools)).toEqual(tools);
  });
});
