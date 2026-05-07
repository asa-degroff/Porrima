import { useState, useEffect, useCallback, useRef } from "react";
import { getSlotAssignments, type SlotAssignment } from "../api/client";

interface UseSlotAssignmentsReturn {
  /** Map of chatId → slot assignment */
  assignments: Map<string, SlotAssignment>;
  /** Whether the initial fetch has completed */
  loaded: boolean;
  /** Manual refresh function */
  refresh: () => Promise<void>;
}

const POLL_INTERVAL_MS = 3_000;

export function useSlotAssignments(): UseSlotAssignmentsReturn {
  const [assignments, setAssignments] = useState<Map<string, SlotAssignment>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const mountedRef = useRef(true);

  const fetchData = useCallback(async () => {
    try {
      const data = await getSlotAssignments();
      if (mountedRef.current) {
        const map = new Map<string, SlotAssignment>();
        for (const a of data) {
          map.set(a.chatId, a);
        }
        setAssignments(map);
        setLoaded(true);
      }
    } catch (err) {
      // Non-fatal — slot binding may be disabled or server unavailable
      if (mountedRef.current && !loaded) {
        setLoaded(true);
      }
    }
  }, []); // stable — no deps that change

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

  return { assignments, loaded, refresh };
}
