import { useState, useEffect, useCallback, useRef } from "react";
import { getCacheResidency, type CacheResidency } from "../api/client";

interface UseCacheResidencyReturn {
  /** Map of chatId -> observed prompt-cache residency. */
  residency: Map<string, CacheResidency>;
  loaded: boolean;
  refresh: () => Promise<void>;
}

const POLL_INTERVAL_MS = 3_000;

export function useCacheResidency(): UseCacheResidencyReturn {
  const [residency, setResidency] = useState<Map<string, CacheResidency>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const mountedRef = useRef(true);

  const fetchData = useCallback(async () => {
    try {
      const data = await getCacheResidency();
      if (mountedRef.current) {
        const map = new Map<string, CacheResidency>();
        for (const item of data) {
          if ((item.active || item.warm) && !map.has(item.chatId)) {
            map.set(item.chatId, item);
          }
        }
        setResidency(map);
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

  return { residency, loaded, refresh };
}
