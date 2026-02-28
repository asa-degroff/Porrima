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
} from "../lib/db";
import type { ChatListItem, ChatType } from "../types";

export function useChats() {
  const [chats, setChats] = useState<ChatListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [isFromCache, setIsFromCache] = useState(false);

  const refresh = useCallback(async () => {
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
      // else silently fail
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const createChat = useCallback(
    async (modelId: string, type: ChatType = "quick") => {
      const chat = await apiCreateChat(modelId, type);
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
