import { useState, useEffect, useCallback } from "react";
import { fetchModels, refreshModels } from "../api/client";
import type { InferenceModel } from "../types";

export function useModels() {
  const [models, setModels] = useState<InferenceModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((source: "init" | "refresh") => {
    const fn = source === "init" ? fetchModels : refreshModels;
    if (source === "refresh") setLoading(true);
    fn()
      .then(setModels)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load("init");
  }, [load]);

  const refresh = useCallback(() => load("refresh"), [load]);

  return { models, loading, error, refresh };
}
