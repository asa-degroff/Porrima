import { useState, useEffect, useCallback } from "react";
import {
  fetchUserNotebooks,
  fetchAgentNotebooks,
  createNotebookEntry,
  updateNotebookEntry,
  deleteNotebookEntry,
  triggerAgentNotebookReview,
  OfflineError,
} from "../api/client";
import type { NotebookEntry, NotebookIndex, NotebookLink } from "../types";

const LAST_SEEN_KEY = "quje-notebook-agent-last-seen";

export function useNotebooks() {
  const [userNotebooks, setUserNotebooks] = useState<NotebookIndex>({ entries: [], lastActivityDate: null });
  const [agentNotebooks, setAgentNotebooks] = useState<NotebookIndex>({ entries: [], lastActivityDate: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [user, agent] = await Promise.all([
        fetchUserNotebooks(),
        fetchAgentNotebooks(),
      ]);
      setUserNotebooks(user);
      setAgentNotebooks(agent);
      setError(null);
    } catch (e) {
      if (e instanceof OfflineError) {
        setError("Network unavailable");
      } else {
        setError(e instanceof Error ? e.message : "Failed to load notebooks");
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const createUserEntry = useCallback(
    async (content: string) => {
      const entry = await createNotebookEntry('user', content);
      await refresh();
      return entry;
    },
    [refresh]
  );

  const createAgentEntry = useCallback(
    async (content: string) => {
      const entry = await createNotebookEntry('agent', content);
      await refresh();
      return entry;
    },
    [refresh]
  );

  const updateEntry = useCallback(
    async (author: 'user' | 'agent', id: string, updates: { content?: string; links?: NotebookLink }) => {
      const entry = await updateNotebookEntry(author, id, updates);
      await refresh();
      return entry;
    },
    [refresh]
  );

  const removeEntry = useCallback(
    async (author: 'user' | 'agent', id: string) => {
      await deleteNotebookEntry(author, id);
      await refresh();
    },
    [refresh]
  );

  const triggerAgentReview = useCallback(async () => {
    const result = await triggerAgentNotebookReview();
    await refresh();
    return result;
  }, [refresh]);

  const hasUnreadAgentEntries = useCallback(() => {
    if (!agentNotebooks.lastActivityDate) return false;
    const lastSeen = localStorage.getItem(LAST_SEEN_KEY);
    if (!lastSeen) return true;
    return new Date(agentNotebooks.lastActivityDate) > new Date(lastSeen);
  }, [agentNotebooks.lastActivityDate]);

  const markAgentEntriesSeen = useCallback(() => {
    localStorage.setItem(LAST_SEEN_KEY, new Date().toISOString());
  }, []);

  return {
    userNotebooks,
    agentNotebooks,
    loading,
    error,
    createUserEntry,
    createAgentEntry,
    updateEntry,
    removeEntry,
    triggerAgentReview,
    hasUnreadAgentEntries,
    markAgentEntriesSeen,
    refresh,
  };
}
