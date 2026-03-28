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
import type { ChatListItem, ChatType } from "../types";

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
    async (modelId: string, type: ChatType = "quick", projectId?: string) => {
      const chat = await apiCreateChat(modelId, type, projectId);
      // Optimistic update: insert the new chat at the top of the list immediately
      const newItem: ChatListItem = {
        id: chat.id,
        title: chat.title,
        type: chat.type,
        lastModified: chat.lastModified,
        preview: "",
        ...(chat.projectId ? { projectId: chat.projectId } : {}),
      };
      setChats((prev) => [newItem, ...prev]);
      // Background refresh to sync with server (debounced)
      refresh();
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

  return { chats, loading, createChat, removeChat, refresh, refreshImmediate, isFromCache };
}
