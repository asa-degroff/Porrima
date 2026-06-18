import { useState, useEffect, useCallback, useRef } from "react";
import { getCacheResidency, type CacheResidency } from "../api/client";

interface UseCacheResidencyReturn {
  /** Map of chatId -> observed prompt-cache residency. */
  residency: Map<string, CacheResidency>;
  /** Synthetic baseline warm used by newly created agent chats. */
  newChatBaselineResidency: CacheResidency | null;
  loaded: boolean;
  refresh: () => Promise<void>;
}

const POLL_INTERVAL_MS = 3_000;

export function useCacheResidency(): UseCacheResidencyReturn {
  const [residency, setResidency] = useState<Map<string, CacheResidency>>(new Map());
  const [newChatBaselineResidency, setNewChatBaselineResidency] = useState<CacheResidency | null>(null);
  const [loaded, setLoaded] = useState(false);
  const mountedRef = useRef(true);

  const fetchData = useCallback(async () => {
    try {
      const data = await getCacheResidency();
      if (mountedRef.current) {
        const map = new Map<string, CacheResidency>();
        let baseline: CacheResidency | null = null;
        for (const item of data) {
          if (!(item.active || item.warm)) continue;
          if (item.targetKind === "new-agent-chat") {
            if (!baseline) baseline = item;
            continue;
          }
          if (!map.has(item.chatId)) {
            map.set(item.chatId, item);
          }
        }
        setResidency(map);
        setNewChatBaselineResidency(baseline);
        setLoaded(true);
      }
    } catch {
      if (mountedRef.current) {
        setLoaded(true);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchData();
    const timer = setInterval(fetchData, POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [fetchData]);

  const refresh = useCallback(async () => {
    await fetchData();
  }, [fetchData]);

  return { residency, newChatBaselineResidency, loaded, refresh };
}
