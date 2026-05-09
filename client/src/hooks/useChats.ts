import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchChats,
  createChat as apiCreateChat,
  deleteChat as apiDeleteChat,
  OfflineError,
} from "../api/client";
import {
  setCachedChatList,
  getCachedChatList,
  clearCachedChat,
  clearCachedChatList,
} from "../lib/db";
import type { Chat, ChatListItem, ChatType } from "../types";

export function useChats() {
  const [chats, setChats] = useState<ChatListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [isFromCache, setIsFromCache] = useState(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshNow = useCallback(async (forceFresh: boolean = false) => {
    if (forceFresh) {
      await clearCachedChatList().catch(() => {});
    }

    try {
      const list = await fetchChats();
      setChats(list);
      setIsFromCache(false);
      setCachedChatList(list).catch(() => {});
    } catch (e) {
      if (e instanceof OfflineError) {
        const cached = await getCachedChatList();
        if (cached) {
          setChats(cached);
          setIsFromCache(true);
        }
      }
    }
    setLoading(false);
  }, []);

  // Debounced refresh: collapses multiple rapid calls into one
  const refresh = useCallback((forceFresh: boolean = false) => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshNow(forceFresh);
    }, 300);
  }, [refreshNow]);

  // Immediate refresh variant for cases that need it (e.g. initial load)
  const refreshImmediate = useCallback(async (forceFresh: boolean = false) => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    await refreshNow(forceFresh);
  }, [refreshNow]);

  useEffect(() => {
    refreshNow(true);
  }, [refreshNow]);

  const createChat = useCallback(
    (modelId: string, type: ChatType = "quick", projectId?: string) => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const title = type === "agent" ? "New Agent Chat" : "New Chat";
      const chatType = type === "agent" ? "agent" as const : "quick" as const;

      // Optimistic update: insert immediately before server round-trip
      const newItem: ChatListItem = {
        id,
        title,
        type: chatType,
        lastModified: now,
        preview: "",
        ...(projectId ? { projectId } : {}),
      };
      setChats((prev) => [newItem, ...prev]);

      // Fire server creation in background; refresh list when done
      apiCreateChat(id, modelId, type, projectId)
        .then(() => refresh())
        .catch(() => {
          // Roll back optimistic entry on failure
          setChats((prev) => prev.filter((c) => c.id !== id));
        });

      // Return a minimal Chat object so the caller can set it active immediately
      const chat: Chat = {
        id,
        title,
        type: chatType,
        modelId,
        systemPrompt: "",
        messages: [],
        createdAt: now,
        lastModified: now,
        ...(projectId ? { projectId } : {}),
      };
      return chat;
    },
    [refresh]
  );

  const removeChat = useCallback(
    async (id: string) => {
      // Optimistic update: remove from list immediately
      setChats((prev) => prev.filter((c) => c.id !== id));
      await apiDeleteChat(id);
      clearCachedChat(id).catch(() => {});
      // Background refresh to sync with server (debounced)
      refresh();
    },
    [refresh]
  );

  // Optimistic title update — mutates the local list immediately so the sidebar
  // reflects the new title without waiting for a full API re-fetch.
  const updateChatTitle = useCallback((chatId: string, title: string) => {
    setChats((prev) =>
      prev.map((c) => (c.id === chatId ? { ...c, title } : c))
    );
  }, []);

  return { chats, loading, createChat, removeChat, updateChatTitle, refresh, refreshImmediate, isFromCache };
}
