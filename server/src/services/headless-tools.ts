import type { AgentTool } from "@earendil-works/pi-agent-core";

/**
 * Headless runs (automation, cross-chat wake, synthesis) must keep the exact
 * same tool schema as interactive turns. Tool definitions render into the
 * system prompt, so dropping a tool shifts the token stream at the tools block
 * and invalidates the chat's entire KV prefix (a full re-prefill — observed
 * live on 10-05 when automations filtered `ask_user` while the send path kept
 * it).
 *
 * `ask_user` cannot execute without a live user, so keep its schema —
 * name/description/parameters are byte-identical — and swap only the executor
 * for a headless-safe one that tells the model to proceed without input.
 * Never re-filter this tool out of a headless tool array.
 */
export function withHeadlessAskUser(tools: AgentTool[]): AgentTool[] {
  return tools.map((tool) => {
    if (tool.name !== "ask_user") return tool;
    return {
      ...tool,
      execute: async () => ({
        content: [
          {
            type: "text" as const,
            text:
              "ask_user is unavailable in headless runs (no live user is connected to this turn). " +
              "Proceed with your best judgment and state any assumptions you make.",
          },
        ],
        details: {},
      }),
    };
  });
}
