import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../types";
import {
  deleteMessageEditDraft,
  getMessageEditDraft,
  pickMessageEditDraft,
  stashMessageEditDraft,
} from "./message-edit-drafts";

const user = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  role: "user",
  content: "original",
  timestamp: 1000,
  ...overrides,
});

// The draft map is module-global; each test uses its own chatId so entries
// cannot bleed across tests (the key includes the chatId).
describe("message edit drafts", () => {
  it("survives a poll reload that replaces an identity-less row and changes its timestamp", () => {
    const chatId = "chat-reload";
    // Optimistic local row: no _rowId, no _rowSequence.
    stashMessageEditDraft(chatId, user(), 3, { text: "typed", images: [] });

    // Server reload replaces the row at the same absolute index with a copy
    // that carries row identity and a fresh server timestamp.
    const serverRow = user({ timestamp: 2000, _rowId: "row-1", _rowSequence: 7 });
    const found = pickMessageEditDraft(chatId, serverRow, 3);

    expect(found?.draft?.text).toBe("typed");
    expect(found?.key).toBe(`${chatId}:pos:3:user`);
  });

  it("survives a row gaining sequence and row identity in place", () => {
    const chatId = "chat-identity";
    const localRow = user();
    stashMessageEditDraft(chatId, localRow, 0, { text: "typed", images: [] });

    const synced = { ...localRow, _rowSequence: 4, _rowId: "row-9" };
    expect(pickMessageEditDraft(chatId, synced, 0)?.draft?.text).toBe("typed");
  });

  it("survives a rebase that renumbers the sequence", () => {
    const chatId = "chat-rebase";
    const row = user({ _rowSequence: 5 });
    stashMessageEditDraft(chatId, row, 2, { text: "typed", images: [] });

    const renumbered = { ...row, _rowSequence: 11 };
    expect(pickMessageEditDraft(chatId, renumbered, 2)?.draft?.text).toBe("typed");
  });

  it("does not leak a draft to a different index, role, or chat", () => {
    const chatId = "chat-isolation";
    stashMessageEditDraft(chatId, user({ timestamp: 111 }), 1, { text: "typed", images: [] });

    expect(pickMessageEditDraft(chatId, user({ timestamp: 222 }), 2)?.draft).toBeUndefined();
    expect(
      pickMessageEditDraft(chatId, { ...user({ timestamp: 111 }), role: "assistant" }, 1)?.draft
    ).toBeUndefined();
    expect(pickMessageEditDraft("chat-other", user({ timestamp: 111 }), 1)?.draft).toBeUndefined();
  });

  it("falls back to the timestamp key when the row has no index", () => {
    const chatId = "chat-no-index";
    stashMessageEditDraft(chatId, user(), null, { text: "typed", images: [] });

    expect(pickMessageEditDraft(chatId, user(), null)?.draft?.text).toBe("typed");
  });

  it("delete frees the row's slot", () => {
    const chatId = "chat-delete";
    stashMessageEditDraft(chatId, user(), 0, { text: "typed", images: [] });
    const { key } = pickMessageEditDraft(chatId, user(), 0)!;

    deleteMessageEditDraft(key);

    expect(getMessageEditDraft(key)).toBeUndefined();
  });
});
