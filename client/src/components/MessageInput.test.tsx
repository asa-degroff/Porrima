// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageInput } from "./MessageInput";

/** The real draft store is a module-level Map in hooks/useChat. Mocking it keeps
 *  this test on the sink — how the composer rebuilds itself from stored text —
 *  without importing the chat hook's transport layer. */
const drafts = new Map<string, { text: string; images: unknown[] }>();
vi.mock("../hooks/useChat", () => ({
  getDraft: (chatId: string) => drafts.get(chatId),
  setDraft: (chatId: string, text: string, images: unknown[]) => {
    drafts.set(chatId, { text, images });
  },
  clearDraft: (chatId: string) => {
    drafts.delete(chatId);
  },
}));

/**
 * jsdom ships neither `innerText` nor `ResizeObserver`, and both are load-bearing
 * here: the composer's whole text pipeline reads `el.innerText`, and a layout
 * effect observes the container. Left unstubbed, the component would be tested
 * against a world where its own text extraction returns undefined.
 * `textContent` is a faithful stand-in for these cases — the composer holds only
 * text nodes and inline chip spans, and `<br>` is the one construct where the
 * two getters actually differ.
 */
if (!("innerText" in HTMLElement.prototype)) {
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get() {
      return this.textContent ?? "";
    },
    set(value: string) {
      this.textContent = value;
    },
  });
}

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof (globalThis as any).ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = StubResizeObserver;
  (window as any).ResizeObserver = StubResizeObserver;
}

const PAYLOAD = '<img src=x onerror="window.__composerPwned = 1">';

const editor = () => screen.getByRole("textbox") as HTMLElement;

afterEach(() => {
  cleanup();
});

describe("MessageInput draft round-trip", () => {
  it("restores typed markup as text, never as live elements", async () => {
    const user = userEvent.setup();
    drafts.clear();
    const onSend = vi.fn();

    const view = render(
      <MessageInput chatId="chat-a" onSend={onSend} disabled={false} availableSkills={["deploy"]} />,
    );

    await user.click(editor());
    await user.paste(`ship ${PAYLOAD} please`);

    // The stored draft is plain text.
    expect(drafts.get("chat-a")?.text).toBe(`ship ${PAYLOAD} please`);

    // Switch away (saves chat-a) and back (restores chat-a).
    view.rerender(<MessageInput chatId="chat-b" onSend={onSend} disabled={false} availableSkills={["deploy"]} />);
    view.rerender(<MessageInput chatId="chat-a" onSend={onSend} disabled={false} availableSkills={["deploy"]} />);

    const el = editor();
    expect(el.children).toHaveLength(0);
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("[onerror]")).toBeNull();
    expect(el.textContent).toBe(`ship ${PAYLOAD} please`);
    expect((window as any).__composerPwned).toBeUndefined();
  });

  it("rebuilds recognized skill chips on restore, text preserved", async () => {
    const user = userEvent.setup();
    drafts.clear();
    const onSend = vi.fn();

    const view = render(
      <MessageInput chatId="chat-c" onSend={onSend} disabled={false} availableSkills={["deploy"]} />,
    );

    await user.click(editor());
    await user.paste("run /deploy now");

    view.rerender(<MessageInput chatId="chat-d" onSend={onSend} disabled={false} availableSkills={["deploy"]} />);
    view.rerender(<MessageInput chatId="chat-c" onSend={onSend} disabled={false} availableSkills={["deploy"]} />);

    const el = editor();
    const chips = el.querySelectorAll("span[data-skill]");
    expect(chips).toHaveLength(1);
    expect(chips[0].getAttribute("data-skill")).toBe("deploy");
    expect(chips[0].getAttribute("contenteditable")).toBe("false");
    expect(el.textContent).toBe("run /deploy now");
  });
});
