// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToolCallDisplay } from "./ToolCallDisplay";
import type { ChatToolCall, ChatToolResult } from "../types";

// Grouped tool calls already live inside a max-height scroller. An expanded
// chip must not add a second scroll box of its own — the group scroller owns
// the overflow, so the expanded body grows inline. Standalone chips keep the
// bounded body (there is no outer scroller to fall back on).

function callFor(name: string, args: Record<string, any>): ChatToolCall {
  return { id: "call-1", name, arguments: args };
}

function resultFor(name: string, content: string): ChatToolResult {
  return { toolCallId: "call-1", toolName: name, content, isError: false };
}

async function expandedResultBody(
  name: string,
  args: Record<string, any>,
  content: string,
  inGroup: boolean,
): Promise<HTMLElement> {
  const user = userEvent.setup();
  const { container } = render(
    <ToolCallDisplay
      toolCall={callFor(name, args)}
      toolResult={resultFor(name, content)}
      inGroup={inGroup}
    />
  );
  await user.click(container.querySelector("button") as HTMLElement);
  const pre = container.querySelector("pre") as HTMLElement;
  return pre.parentElement as HTMLElement;
}

describe("ToolCallDisplay expanded body inside a tool group", () => {
  it("keeps its own scroll box when standalone", async () => {
    const body = await expandedResultBody("read_file", { path: "/tmp/a.txt" }, "contents", false);
    expect(body.className).toContain("max-h-[300px]");
    expect(body.className).toContain("overflow-auto");
  });

  it("grows inline instead of nesting a scroll box", async () => {
    const body = await expandedResultBody("read_file", { path: "/tmp/a.txt" }, "contents", true);
    expect(body.className).not.toContain("max-h-[300px]");
    expect(body.className).not.toContain("overflow-auto");
    expect(body.className).not.toContain("overflow-y-auto");
  });

  it("drops the bash output scroll box too", async () => {
    const body = await expandedResultBody("bash", { command: "ls" }, "a.txt", true);
    expect(body.className).not.toContain("max-h-[300px]");
    expect(body.className).not.toContain("custom-scrollbar");
  });

  it("collapses when the expanded body is clicked", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ToolCallDisplay
        toolCall={callFor("read_file", { path: "/tmp/a.txt" })}
        toolResult={resultFor("read_file", "contents")}
        inGroup
      />
    );
    await user.click(container.querySelector("button") as HTMLElement);
    const pre = container.querySelector("pre") as HTMLElement;
    await user.click(pre);
    expect(container.querySelector("pre")).toBeNull();
  });

  it("keeps the card open when a control inside it is clicked", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ToolCallDisplay
        toolCall={callFor("read_file", { path: "/tmp/a.txt" })}
        toolResult={resultFor("read_file", "contents")}
        inGroup
      />
    );
    await user.click(container.querySelector("button") as HTMLElement);
    const callRow = container.querySelectorAll("button")[1] as HTMLElement;
    expect(callRow.textContent).toContain("Call");
    await user.click(callRow);
    // The call row toggles its own body; it must not fold the whole chip.
    expect(container.querySelectorAll("button").length).toBe(2);
    expect(container.querySelector("pre")).toBeTruthy();
  });
});
