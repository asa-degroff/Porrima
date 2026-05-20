import { useState, useEffect, useCallback } from "react";
import { fetchSettings, updateSettings as apiUpdateSettings } from "../api/client";
import type { Settings } from "../types";

const DEFAULT_SETTINGS: Settings = {
  defaultModelId: "",
  defaultSystemPrompt: "You are a helpful assistant.",
  braveApiKey: "",
  exaApiKey: "",
  tavilyApiKey: "",
  braveSearchEnabled: true,
  exaSearchEnabled: false,
  tavilySearchEnabled: false,
  defaultWebSearchProvider: "brave",
  hapticsEnabled: true,
  readFileDefaultLines: 1000,
  readFileMaxBytes: 256 * 1024,
  crossProjectScoreMultiplier: 0.3,
  globalProjectScoreMultiplier: 1.0,
  retrievalDepthProfile: "balanced",
  rerankerTimeoutMs: 25_000,
};

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchSettings()
      .then(setSettings)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const updateSettings = useCallback(async (updated: Settings) => {
    const saved = await apiUpdateSettings(updated);
    setSettings(saved);
    return saved;
  }, []);

  return { settings, updateSettings, loading };
}
