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

/** How often to poll the server for chat list changes (ms). Keeps the sidebar
 *  in sync across devices and picks up titles/preview changes from background
 *  automations, server-side message sends, etc. */
const CHAT_LIST_POLL_INTERVAL_MS = 30_000;

export function useChats() {
  const [chats, setChats] = useState<ChatListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [isFromCache, setIsFromCache] = useState(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const locallyDeletedChatIdsRef = useRef<Set<string>>(new Set());
  const pendingCreateChatsRef = useRef<Map<string, Promise<Chat | null>>>(new Map());

  const filterDeletedChats = useCallback((items: ChatListItem[]) => {
    const deletedIds = locallyDeletedChatIdsRef.current;
    if (deletedIds.size === 0) return items;
    return items.filter((chat) => !deletedIds.has(chat.id));
  }, []);

  const refreshNow = useCallback(async (forceFresh: boolean = false) => {
    if (forceFresh) {
      await clearCachedChatList().catch(() => {});
    }

    try {
      const list = filterDeletedChats(await fetchChats());
      setChats(list);
      setIsFromCache(false);
      setCachedChatList(list).catch(() => {});
    } catch (e) {
      if (e instanceof OfflineError) {
        const cached = await getCachedChatList();
        if (cached) {
          setChats(filterDeletedChats(cached));
          setIsFromCache(true);
        }
      }
    }
    setLoading(false);
  }, [filterDeletedChats]);

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

  // Periodic sidebar refresh: keeps the chat list in sync with server changes
  // (titles, previews, lastModified, new/deleted chats from other devices).
  // Skips when the tab is hidden to avoid wasting network/battery.
  useEffect(() => {
    let cancelled = false;
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      // Refresh immediately when returning from background — stale data is
      // likely if the user was active on another device.
      refreshNow(false).catch(() => {});
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    pollTimerRef.current = setInterval(() => {
      if (cancelled || document.visibilityState !== "visible") return;
      refreshNow(false).catch(() => {});
    }, CHAT_LIST_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
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
      locallyDeletedChatIdsRef.current.delete(id);
      setChats((prev) => [newItem, ...prev]);

      // Fire server creation in background. Do NOT call refresh() on success —
      // the optimistic insert is sufficient. The background poll (30s) will sync
      // state naturally. Calling refresh() here caused a race condition where
      // the debounced 300ms fetchChats() replaced the local state before the
      // server had indexed the new chat, briefly removing it from the sidebar.
      const pendingCreate = apiCreateChat(id, modelId, type, projectId)
        .then((created) => created)
        .catch(() => {
          // Roll back optimistic entry on failure
          if (!locallyDeletedChatIdsRef.current.has(id)) {
            setChats((prev) => prev.filter((c) => c.id !== id));
          }
          return null;
        })
        .finally(() => {
          pendingCreateChatsRef.current.delete(id);
        });
      pendingCreateChatsRef.current.set(id, pendingCreate);

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
    []
  );

  const removeChat = useCallback(
    async (id: string) => {
      locallyDeletedChatIdsRef.current.add(id);
      // Optimistic update: remove from list immediately
      setChats((prev) => prev.filter((c) => c.id !== id));
      const pendingCreate = pendingCreateChatsRef.current.get(id);
      if (pendingCreate) {
        await pendingCreate;
      }
      await apiDeleteChat(id);
      clearCachedChat(id).catch(() => {});
      clearCachedChatList().catch(() => {});
      // Background refresh to sync with server (debounced)
      refresh(true);
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

  return { chats, loading, createChat, removeChat, updateChatTitle, refresh, refreshImmediate, isFromCache, refreshNow };
}
