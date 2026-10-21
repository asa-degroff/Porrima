// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThinkingBlock } from "./ThinkingBlock";

// The thinking body is a vertical scroll box. `overflow-y: auto` alone also makes
// it horizontally scrollable (CSS computes overflow-x to auto whenever the other
// axis is non-visible), so any line the browser cannot break — a long file path,
// a row id, a digest — paints a horizontal scrollbar. That bar is always useless
// on a phone: the box is ~300px wide and the overflowing fragment is a few pixels
// of one token. The invariant is that the scroll box has no horizontal axis and
// the text breaks instead of overflowing it.
const UNBREAKABLE = "reading /home/asa/quje-agent/server/src/services/assistant-boundary.ts and chatMessagesToHydratedPiMessages";

async function expandedThinking() {
  const user = userEvent.setup();
  const { container } = render(
    <ThinkingBlock thinking={UNBREAKABLE} isStreaming={false} thinkingDurationMs={4200} />
  );
  await user.click(container.querySelector("button") as HTMLElement);
  return container;
}

describe("ThinkingBlock scroll-box shape", () => {
  it("clips the horizontal axis on the vertical scroll box", async () => {
    const container = await expandedThinking();
    const box = container.querySelector(".overflow-y-auto") as HTMLElement;
    expect(box).toBeTruthy();
    expect(box.className).toContain("overflow-x-hidden");
  });

  it("breaks long tokens instead of overflowing them", async () => {
    const container = await expandedThinking();
    const pre = container.querySelector("pre") as HTMLElement;
    expect(pre).toBeTruthy();
    expect(pre.className).toContain("whitespace-pre-wrap");
    expect(pre.className).toContain("break-words");
  });
});
