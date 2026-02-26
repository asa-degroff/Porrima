import { useState, useEffect, useCallback } from "react";
import {
  fetchChats,
  createChat as apiCreateChat,
  deleteChat as apiDeleteChat,
} from "../api/client";
import type { ChatListItem } from "../types";

export function useChats() {
  const [chats, setChats] = useState<ChatListItem[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const list = await fetchChats();
      setChats(list);
    } catch {
      // silently fail
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const createChat = useCallback(
    async (modelId: string) => {
      const chat = await apiCreateChat(modelId);
      await refresh();
      return chat;
    },
    [refresh]
  );

  const removeChat = useCallback(
    async (id: string) => {
      await apiDeleteChat(id);
      await refresh();
    },
    [refresh]
  );

  return { chats, loading, createChat, removeChat, refresh };
}
