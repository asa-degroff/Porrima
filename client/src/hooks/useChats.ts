import { useState, useEffect, useCallback } from "react";
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

  const refresh = useCallback(async (forceFresh: boolean = false) => {
    if (forceFresh) {
      // Clear cache and force fresh fetch (e.g., after schema change)
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
      // else silently fail - cache may still be usable
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    // Force fresh fetch on initial load to ensure correct ordering after server restarts
    refresh(true);
  }, [refresh]);

  const createChat = useCallback(
    async (modelId: string, type: ChatType = "quick", projectId?: string) => {
      const chat = await apiCreateChat(modelId, type, projectId);
      await refresh();
      return chat;
    },
    [refresh]
  );

  const removeChat = useCallback(
    async (id: string) => {
      await apiDeleteChat(id);
      clearCachedChat(id).catch(() => {});
      await refresh();
    },
    [refresh]
  );

  return { chats, loading, createChat, removeChat, refresh, isFromCache };
}
