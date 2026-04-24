import { useState, useEffect, useCallback } from "react";
import { fetchModels } from "../api/client";
import type { OllamaModel } from "../types";

export function useModels() {
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchModels();
      setModels(next);
      return next;
    } catch (e: any) {
      setError(e.message);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { models, loading, error, refresh };
}
