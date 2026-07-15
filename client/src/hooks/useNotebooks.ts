import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchUserNotebooks,
  fetchAgentNotebooks,
  createNotebookEntry,
  updateNotebookEntry,
  deleteNotebookEntry,
  fetchUserUIState,
  saveUserUIState,
  searchNotebooks,
  OfflineError,
} from "../api/client";
import { readStoredValue, writeStoredValue } from "../lib/storage";
import type { NotebookEntry, NotebookIndex, NotebookLink, NotebookSearchResult, ImageAttachment } from "../types";

const NOTEBOOK_LAST_SEEN_KEY = "porrima-notebook-agent-last-seen";
const LEGACY_NOTEBOOK_LAST_SEEN_KEY = "quje-notebook-agent-last-seen";

interface NotebookRefreshOptions {
  /** Hide the existing snapshot until the fresh indexes arrive. */
  blocking?: boolean;
}

export function useNotebooks() {
  const [userNotebooks, setUserNotebooks] = useState<NotebookIndex>({ entries: [], lastActivityDate: null });
  const [agentNotebooks, setAgentNotebooks] = useState<NotebookIndex>({ entries: [], lastActivityDate: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notebookLastSeen, setNotebookLastSeen] = useState<string | null>(null);
  const [synced, setSynced] = useState(false);
  const [searchResults, setSearchResults] = useState<NotebookSearchResult[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const refreshRequestRef = useRef(0);
  const hasLoadedRef = useRef(false);

  // Load last-seen from server on mount
  useEffect(() => {
    fetchUserUIState()
      .then((state) => {
        if (state.notebookLastSeen) {
          setNotebookLastSeen(state.notebookLastSeen);
        }
        setSynced(true);
      })
      .catch((err) => {
        console.warn("Failed to load notebook last-seen from server:", err);
        // Fall back to localStorage for backward compatibility
        const local = readStoredValue(NOTEBOOK_LAST_SEEN_KEY, LEGACY_NOTEBOOK_LAST_SEEN_KEY);
        if (local) setNotebookLastSeen(local);
        setSynced(true);
      });
  }, []);

  const refresh = useCallback(async ({ blocking = false }: NotebookRefreshOptions = {}) => {
    const requestId = ++refreshRequestRef.current;
    if (blocking) setLoading(true);

    try {
      const [user, agent] = await Promise.all([
        fetchUserNotebooks(),
        fetchAgentNotebooks(),
      ]);
      if (requestId !== refreshRequestRef.current) return;

      setUserNotebooks(user);
      setAgentNotebooks(agent);
      setError(null);
      hasLoadedRef.current = true;
    } catch (e) {
      if (requestId !== refreshRequestRef.current) return;

      // Preserve a previously loaded snapshot during transient background
      // failures. The initial load still surfaces an actionable error.
      if (!hasLoadedRef.current) {
        if (e instanceof OfflineError) {
          setError("Network unavailable");
        } else {
          setError(e instanceof Error ? e.message : "Failed to load notebooks");
        }
      }
    } finally {
      if (requestId === refreshRequestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh({ blocking: true });
  }, [refresh]);

  const createUserEntry = useCallback(
    async (content: string, images?: ImageAttachment[]) => {
      const entry = await createNotebookEntry('user', content, images);
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

  const hasUnreadAgentEntries = useCallback(() => {
    if (!agentNotebooks.lastActivityDate) return false;
    if (!notebookLastSeen) return true;
    return new Date(agentNotebooks.lastActivityDate) > new Date(notebookLastSeen);
  }, [agentNotebooks.lastActivityDate, notebookLastSeen]);

  const markAgentEntriesSeen = useCallback(() => {
    const now = new Date().toISOString();
    setNotebookLastSeen(now);
    
    // Save to server
    saveUserUIState({ notebookLastSeen: now }).catch((err) => {
      console.warn("Failed to save notebook last-seen to server:", err);
    });
    
    // Also save to localStorage for backward compatibility and offline support
    writeStoredValue(NOTEBOOK_LAST_SEEN_KEY, now, LEGACY_NOTEBOOK_LAST_SEEN_KEY);
  }, []);

  const searchNotebookEntries = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      setSearchQuery('');
      return;
    }
    setSearchQuery(query);
    setIsSearching(true);
    try {
      const { results } = await searchNotebooks(query);
      setSearchResults(results);
    } catch (e) {
      console.error('[notebook] Search failed:', e);
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  }, []);

  const clearSearch = useCallback(() => {
    setSearchResults([]);
    setSearchQuery('');
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
    hasUnreadAgentEntries,
    markAgentEntriesSeen,
    refresh,
    searchResults,
    searchQuery,
    isSearching,
    searchNotebookEntries,
    clearSearch,
  };
}
