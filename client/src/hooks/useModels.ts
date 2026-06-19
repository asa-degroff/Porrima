import { useState, useEffect, useCallback } from "react";
import { fetchModels, refreshModels } from "../api/client";
import type { InferenceModel } from "../types";

const MODEL_POLL_INTERVAL_MS = 30_000;

export function useModels() {
  const [models, setModels] = useState<InferenceModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((source: "init" | "refresh") => {
    const fn = source === "init" ? fetchModels : refreshModels;
    if (source === "refresh") setLoading(true);
    fn()
      .then((nextModels) => {
        setModels(nextModels);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load("init");
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "hidden") load("init");
    }, MODEL_POLL_INTERVAL_MS);
    const refreshOnFocus = () => load("init");
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [load]);

  const refresh = useCallback(() => load("refresh"), [load]);

  return { models, loading, error, refresh };
}
