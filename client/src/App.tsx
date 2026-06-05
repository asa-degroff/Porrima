import { useState, useCallback, useMemo, useEffect, lazy, Suspense, useRef } from "react";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { NotebookView } from "./components/NotebookView";
import { SettingsModal } from "./components/SettingsModal";
import { MemoryDebugPanel } from "./components/MemoryDebugPanel";
import { ModelStatsModal } from "./components/ModelStatsModal";
import { CreateProjectModal } from "./components/CreateProjectModal";
import { LoginPage } from "./components/LoginPage";

const ImageSandbox = lazy(() => import("./components/ImageSandbox").then((m) => ({ default: m.ImageSandbox })));

const RippleGridBackground = lazy(() =>
  import("./components/RippleGridBackground").then((m) => ({ default: m.RippleGridBackground }))
);
const ScanLinesBackground = lazy(() =>
  import("./components/ScanLinesBackground").then((m) => ({ default: m.ScanLinesBackground }))
);
const RippleDotsBackground = lazy(() =>
  import("./components/RippleDotsBackground").then((m) => ({ default: m.RippleDotsBackground }))
);
const GraphPaperBackground = lazy(() =>
  import("./components/GraphPaperBackground").then((m) => ({ default: m.GraphPaperBackground }))
);
import { useChats } from "./hooks/useChats";
import { useChat, hasBackgroundStream, getStreamingChatIds } from "./hooks/useChat";
import { useProjects } from "./hooks/useProjects";
import { useModels } from "./hooks/useModels";
import { useSettings } from "./hooks/useSettings";
import { useAuth } from "./hooks/useAuth";
import { useOnlineStatus } from "./hooks/useOnlineStatus";
import { useKeyboardInset } from "./hooks/useKeyboardInset";
import { fetchChat, fetchChatHeader, updateChat as apiUpdateChat } from "./api/client";
import { setCachedChat, getCachedChat, clearCachedChat } from "./lib/db";
import { readStoredValue, removeStoredValue, writeStoredValue } from "./lib/storage";
import { HapticsProvider } from "./hooks/useHaptics";
import { ActivityStyleProvider } from "./hooks/useActivityStyle";
import { useTTS } from "./hooks/useTTS";
import { TTSControlBar } from "./components/TTSControlBar";
import { useNotebooks } from "./hooks/useNotebooks";
import { useCacheResidency } from "./hooks/useCacheResidency";
import { fetchSystemStats, updateSystemStatsSettings } from "./api/client";
import type { SystemStatsSample } from "./types";
import { fetchUserUIState, saveUserUIState, fetchSynthesisStatus, triggerSleepMode, triggerSynthesis, triggerWakeCycle, pauseSystem, resumeSystem } from "./api/client";
import { PinnedItemProvider } from "./contexts/PinnedItemContext";
import type { Chat, ChatType, CornerShape, CornerRadius } from "./types";

const CORNER_SHAPE_KEY = "porrima-corner-shape";
const LEGACY_CORNER_SHAPE_KEY = "quje-corner-shape";
const CORNER_RADIUS_KEY = "porrima-corner-radius";
const LEGACY_CORNER_RADIUS_KEY = "quje-corner-radius";
const ACTIVE_CHAT_KEY = "porrima-active-chat-id";
const LEGACY_ACTIVE_CHAT_KEY = "quje-active-chat-id";
const ACTIVE_VIEW_KEY = "porrima-active-view";
const LEGACY_ACTIVE_VIEW_KEY = "quje-active-view";
const TTS_AUTO_READ_MESSAGES_KEY = "porrima-tts-auto-read-messages";
const LEGACY_TTS_AUTO_READ_MESSAGES_KEY = "quje-tts-auto-read-messages";
const INITIAL_MESSAGE_LIMIT = 200;
const ACTIVE_CHAT_HEADER_POLL_INTERVAL_MS = 5_000;
const PCI_ADDRESS_RE = /^[0-9a-fA-F]{4}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}\.[0-7]$/;

function normalizeSystemStatsHiddenGpus(ids: string[] | undefined): string[] {
  return Array.from(new Set((ids ?? []).filter((id) => PCI_ADDRESS_RE.test(id))));
}

function readCachedCornerShape(): CornerShape {
  try {
    return readStoredValue(CORNER_SHAPE_KEY, LEGACY_CORNER_SHAPE_KEY) === "squircle" ? "squircle" : "round";
  } catch {
    return "round";
  }
}

function readCachedCornerRadius(): CornerRadius {
  try {
    const v = readStoredValue(CORNER_RADIUS_KEY, LEGACY_CORNER_RADIUS_KEY);
    return v === "compact" || v === "generous" ? v : "default";
  } catch {
    return "default";
  }
}

// Apply cached appearance settings before first render so the login screen
// reflects the user's choice without waiting for the (auth-gated) /api/settings.
if (typeof document !== "undefined") {
  document.documentElement.setAttribute("data-corner", readCachedCornerShape());
  document.documentElement.setAttribute("data-radius", readCachedCornerRadius());
}

function AuthenticatedApp({ onLogout }: { onLogout: () => void }) {
  const { models, refresh: refreshModels } = useModels();
  const { chats, createChat, removeChat, updateChatTitle, refresh, refreshImmediate } = useChats();
  const { projects, createProject, removeProject } = useProjects();
  const { settings, updateSettings, loading: settingsLoading } = useSettings();
  const { isOnline } = useOnlineStatus();
  const keyboardInset = useKeyboardInset();
  const prevOnlineRef = useRef(isOnline);
  const selectChatRef = useRef<((id: string) => Promise<void>) | null>(null);
  const streamingRef = useRef(false);
  const tts = useTTS();
  const { settings: ttsSettings, playbackState, loadSettings: loadTtsSettings, updateSettings: updateTtsSettings, play: playTts, stop: stopTts, pause: pauseTts, resume: resumeTts, setContinuationWaiting: setTtsContinuationWaiting, handleAgentAudioChunk, handleAgentAudioDone, cleanupLiveAudio } = tts;
  const {
    userNotebooks,
    agentNotebooks,
    loading: notebooksLoading,
    error: notebooksError,
    createUserEntry,
    createAgentEntry,
    updateEntry,
    removeEntry,
    triggerAgentReview,
    hasUnreadAgentEntries,
    markAgentEntriesSeen,
    searchResults: notebookSearchResults,
    searchQuery: notebookSearchQuery,
    isSearching: isSearchingNotebooks,
    searchNotebookEntries,
    clearSearch: clearNotebookSearch,
  } = useNotebooks();
  const { residency: cacheResidency, refresh: refreshCacheResidency } = useCacheResidency();
  const [activeView, setActiveView] = useState<'chats' | 'notebooks'>('chats');
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const activeChatIdStateRef = useRef<string | null>(null);
  const activeChatStateRef = useRef<Chat | null>(null);
  const [lastActiveChatId, setLastActiveChatId] = useState<string | null>(settings.lastActiveChatId || null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [memoryDebugOpen, setMemoryDebugOpen] = useState(false);
  const [modelStatsOpen, setModelStatsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [imageSandboxOpen, setImageSandboxOpen] = useState(false);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [uiStateSynced, setUiStateSynced] = useState(false);
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [synthesisComplete, setSynthesisComplete] = useState(false);
  const [sleepModeActive, setSleepModeActive] = useState(false);
  const [isExtractionRunning, setIsExtractionRunning] = useState(false);
  const [sleepCycleActive, setSleepCycleActive] = useState(false);
  const [isWakeCycleRunning, setIsWakeCycleRunning] = useState(false);
  const [isAutomationRunning, setIsAutomationRunning] = useState(false);
  const [systemPause, setSystemPause] = useState<import("./types").SystemPauseStatus | null>(null);
  const [cacheWarmingChatIds, setCacheWarmingChatIds] = useState<Set<string>>(() => new Set());
  const [cacheWarmErrors, setCacheWarmErrors] = useState<Map<string, string>>(() => new Map());

  useEffect(() => {
    activeChatIdStateRef.current = activeChatId;
  }, [activeChatId]);

  useEffect(() => {
    activeChatStateRef.current = activeChat;
  }, [activeChat]);

  // System stats polling
  const [systemStatsHistory, setSystemStatsHistory] = useState<SystemStatsSample[]>([]);
  const [systemStatsCurrent, setSystemStatsCurrent] = useState<SystemStatsSample | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const data = await fetchSystemStats();
        if (!cancelled) {
          setSystemStatsCurrent(data.current);
          setSystemStatsHistory(data.history);
        }
      } catch (e: any) {
        if (!cancelled) console.warn("[system-stats] Poll failed:", e.message);
      }
    }
    poll();
    const timer = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // Sync hidden GPU settings to server whenever they change
  useEffect(() => {
    const hiddenGpus = normalizeSystemStatsHiddenGpus(settings.systemStatsHiddenGpus);
    updateSystemStatsSettings({ hiddenGpus }).catch(() => {});
  }, [settings.systemStatsHiddenGpus]);

  // Load UI state from server on mount
  // Priority: URL ?chat= param > SW-stored push-click payload > server state > localStorage
  // The URL param is set by the service worker when opening from a push notification.
  // The SW also stores the last push-click payload — we request it as a fallback in case
  // the postMessage arrived before our listener was attached (race on background→foreground).
  // We call selectChat directly here rather than relying on the restore effect,
  // because selectChatRef isn't populated until after effects run in order.
  useEffect(() => {
    // Check for ?chat= URL parameter (push notification deep-link)
    const urlParams = new URLSearchParams(window.location.search);
    const urlChatId = urlParams.get("chat");
    if (urlChatId) {
      setActiveChatId(urlChatId);
      selectChat(urlChatId);
      setUiStateSynced(true);
      return;
    }

    // Fallback: ask the SW for a stored push-click payload. This covers the
    // race where the SW's postMessage fired before our listener was attached.
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      navigator.serviceWorker.ready.then((reg) => {
        if (reg.active) {
          reg.active.postMessage({ kind: "get-last-push-click" });

          let handled = false;
          const handler = (e: MessageEvent) => {
            if (handled) return;
            if (e.data?.kind === "last-push-click" && e.data.payload?.chatId) {
              handled = true;
              const chatId = e.data.payload.chatId;
              setActiveChatId(chatId);
              selectChat(chatId);
              setUiStateSynced(true);
              return;
            }
            // Not our response — fall through to server state
            handled = true;
            loadServerState();
          };
          navigator.serviceWorker.addEventListener("message", handler);

          // Timeout: if the SW doesn't respond quickly, fall through.
          setTimeout(() => {
            if (!handled) {
              handled = true;
              loadServerState();
            }
          }, 500);
          return;
        }
      }).catch(() => {});
    }

    loadServerState();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectChat is useCallback-stable; this effect runs once on mount

    function loadServerState() {
      fetchUserUIState()
        .then((state) => {
          if (state.activeChatId) {
            setActiveChatId(state.activeChatId);
            selectChat(state.activeChatId);
          }
          if (state.activeView) setActiveView(state.activeView as 'chats' | 'notebooks');
          if (state.activeView === 'image-sandbox') setImageSandboxOpen(true);
          setUiStateSynced(true);
        })
        .catch((err) => {
          console.warn("Failed to load UI state from server, using localStorage:", err);
          const cachedChatId = readStoredValue(ACTIVE_CHAT_KEY, LEGACY_ACTIVE_CHAT_KEY);
          if (cachedChatId) {
            setActiveChatId(cachedChatId);
            selectChat(cachedChatId);
          }
          if (readStoredValue(ACTIVE_VIEW_KEY, LEGACY_ACTIVE_VIEW_KEY) === "image-sandbox") {
            setImageSandboxOpen(true);
          }
          setUiStateSynced(true);
        });
    }
  }, []);

  // Poll synthesis status. Synthesis runs server-side as a background task
  // (the HTTP trigger returns 202 Accepted immediately and can outlast any
  // proxy idle timeout), so the UI watches for the isSynthesizing flag going
  // true → false to know when a run finished and flash "Complete".
  const wasSynthesizingRef = useRef(false);
  useEffect(() => {
    const poll = async () => {
      try {
        const status = await fetchSynthesisStatus();
        const prev = wasSynthesizingRef.current;
        wasSynthesizingRef.current = status.isSynthesizing;
        setIsSynthesizing(status.isSynthesizing);
        setIsAutomationRunning(!!status.isAutomationRunning && !status.isSynthesizing && !status.isWakeCycleRunning);
        setIsExtractionRunning(status.isExtractionRunning);
        setSystemPause(status.systemPause);
        setSleepCycleActive(status.sleepCycleActive);
        setIsWakeCycleRunning(status.isWakeCycleRunning);
        if (status.isSynthesizing) {
          setSynthesisComplete(false);
        } else if (prev) {
          // Transition from active → idle: synthesis just finished.
          setSynthesisComplete(true);
          setTimeout(() => setSynthesisComplete(false), 5000);
        }
      } catch {
        // Ignore polling errors
      }
    };
    poll();
    const interval = setInterval(poll, 10000);
    return () => clearInterval(interval);
  }, []);

  // Persist lastActiveChatId to settings (debounced, so we don't churn writes)
  useEffect(() => {
    if (!lastActiveChatId) return;
    const timer = setTimeout(async () => {
      await updateSettings({ lastActiveChatId } as import("./types").Settings);
    }, 1000);
    return () => clearTimeout(timer);
  }, [lastActiveChatId, updateSettings]);
  const {
    messages,
    messageOffset,
    messageTotal,
    hasMoreMessages,
    olderMessagesLoading,
    streaming,
    streamingThinking,
    streamingThinkingActive,
    streamingThinkingAccumulatedMs,
    streamingThinkingLastStartRef,
    activeTools,
    artifacts,
    generatedImages,
    waitingForInput,
    totalUsage,
    isUsageEstimated,
    compacting,
    compaction,
    modelProgress,
    inferenceActivityPhase,
    error,
    warning,
    streamingSegmentIndex,
    hasBackgroundActivity,
    send,
    reportArtifactRuntimeError,
    editMessage,
    retryMessage,
    abort,
    loadMessages,
    loadOlderMessages,
    setActiveChatData,
    processQueue,
    queueProcessing,
    titleUpdate,
    hasCompactionSummary,
    reconnecting,
  } = useChat(activeChatId);

  // Any chat streaming — includes background chats so the sidebar indicator stays correct when viewing a different chat
  const anyStreaming = streaming || getStreamingChatIds().length > 0;

  const applyLoadedChat = useCallback((chat: Chat) => {
    if (activeChatIdStateRef.current !== chat.id) return false;
    if (streamingRef.current || hasBackgroundStream(chat.id)) return false;

    activeChatStateRef.current = chat;
    setActiveChat(chat);
    setActiveChatData(chat);
    loadMessages(chat.messages, {
      offset: chat.messageOffset ?? 0,
      total: chat.messageTotal ?? chat.messages.length,
    });
    setCachedChat(chat).catch(() => {});
    return true;
  }, [loadMessages, setActiveChatData]);

  const refreshActiveChatFromServer = useCallback(async (
    id: string,
    options: { force?: boolean; priority?: "high" | "low" | "auto" } = {}
  ) => {
    if (activeChatIdStateRef.current !== id) return false;
    if (streamingRef.current || hasBackgroundStream(id)) return false;

    const header = await fetchChatHeader(id, { priority: options.priority });
    if (activeChatIdStateRef.current !== id) return false;
    if (streamingRef.current || hasBackgroundStream(id)) return false;

    const current = activeChatStateRef.current?.id === id ? activeChatStateRef.current : null;
    const currentTotal = current ? current.messageTotal ?? current.messages.length : -1;
    const isStale =
      options.force ||
      !current ||
      header.lastModified > current.lastModified ||
      header.messageCount !== currentTotal;

    if (!isStale) return false;

    const chat = await fetchChat(id, { messageLimit: INITIAL_MESSAGE_LIMIT });
    if (activeChatIdStateRef.current !== id) return false;
    if (streamingRef.current || hasBackgroundStream(id)) return false;

    const applied = applyLoadedChat(chat);
    if (applied) refresh();
    return applied;
  }, [applyLoadedChat, refresh]);

  // Apply theme to document
  useEffect(() => {
    const theme = settings.theme || 'default';
    document.documentElement.setAttribute('data-theme', theme);
    
    // Update PWA theme-color meta tag
    const themeColorMeta = document.getElementById('theme-color-meta');
    if (themeColorMeta) {
      const themeColors: Record<string, string> = {
        default: '#0f172a',
        ocean: '#0c1929',
        forest: '#0a1a0f',
        crimson: '#1a0a0f',
        mono: '#0a0a0a',
        strawberry: '#1a010b',
        coffee: '#0f0a07',
        emerald: '#041a10',
        copper: '#140a07',
        'oxidized-copper': '#051210',
        iron: '#121214',
        rust: '#1a0e06',
      };
      themeColorMeta.setAttribute('content', themeColors[theme] || '#0f172a');
    }
  }, [settings.theme]);

  // Apply flat background toggle
  useEffect(() => {
    if (settings.flatBackground) {
      document.documentElement.setAttribute('data-flat-bg', '');
    } else {
      document.documentElement.removeAttribute('data-flat-bg');
    }
  }, [settings.flatBackground]);

  // Apply chromatic aberration toggle (default on when undefined)
  useEffect(() => {
    const enabled = settings.chromaticAberration ?? true;
    if (enabled) {
      document.documentElement.removeAttribute('data-chromatic-aberration');
    } else {
      document.documentElement.setAttribute('data-chromatic-aberration', 'off');
    }
  }, [settings.chromaticAberration]);

  // Apply mouse warp toggle (default on when undefined)
  useEffect(() => {
    const enabled = settings.mouseWarp ?? true;
    if (enabled) {
      document.documentElement.removeAttribute('data-mouse-warp');
    } else {
      document.documentElement.setAttribute('data-mouse-warp', 'off');
    }
  }, [settings.mouseWarp]);

  // Apply corner shape (and mirror to localStorage so the login screen can honor it)
  useEffect(() => {
    const shape = settings.cornerShape || 'round';
    document.documentElement.setAttribute('data-corner', shape);
    try { writeStoredValue(CORNER_SHAPE_KEY, shape, LEGACY_CORNER_SHAPE_KEY); } catch {}
  }, [settings.cornerShape]);

  // Apply corner radius scale (and mirror to localStorage)
  useEffect(() => {
    const radius = settings.cornerRadius || 'default';
    document.documentElement.setAttribute('data-radius', radius);
    try { writeStoredValue(CORNER_RADIUS_KEY, radius, LEGACY_CORNER_RADIUS_KEY); } catch {}
  }, [settings.cornerRadius]);

  // Apply background effect
  useEffect(() => {
    if (settings.backgroundEffect === 'ripple-grid' && !imageSandboxOpen) {
      // Ripple grid is rendered conditionally below
    }
  }, [settings.backgroundEffect, imageSandboxOpen]);

  // Persist active view and chat ID to server with debounce
  useEffect(() => {
    if (!uiStateSynced) return;

    // Also save to localStorage for backward compatibility and offline support
    if (activeChatId) {
      writeStoredValue(ACTIVE_CHAT_KEY, activeChatId, LEGACY_ACTIVE_CHAT_KEY);
    } else {
      removeStoredValue(ACTIVE_CHAT_KEY, LEGACY_ACTIVE_CHAT_KEY);
    }

    const timer = setTimeout(() => {
      saveUserUIState({ activeChatId }).catch((err) => {
        console.warn("Failed to save active chat ID to server:", err);
      });
    }, 500);

    return () => clearTimeout(timer);
  }, [activeChatId, uiStateSynced]);

  useEffect(() => {
    if (!uiStateSynced) return;

    // Also save to localStorage for backward compatibility and offline support
    writeStoredValue(ACTIVE_VIEW_KEY, activeView, LEGACY_ACTIVE_VIEW_KEY);

    const timer = setTimeout(() => {
      saveUserUIState({ activeView }).catch((err) => {
        console.warn("Failed to save active view to server:", err);
      });
    }, 500);

    return () => clearTimeout(timer);
  }, [activeView, uiStateSynced]);

  // Load TTS settings on mount
  useEffect(() => {
    loadTtsSettings();
  }, [loadTtsSettings]);

  // Listen for live agent audio chunks from the chat SSE stream
  const liveTtsAudioSeenChatRef = useRef<string | null>(null);

  useEffect(() => {
    if (!ttsSettings.enabled) return;

    const chunkHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { chatId: string; chunk: { chunkId: string; index?: number; totalChunks?: number; data: string; mimeType: string; sampleRate: number; duration?: number } };
      // Only process audio for the currently active chat
      if (detail.chatId !== activeChatId) return;
      liveTtsAudioSeenChatRef.current = detail.chatId;
      handleAgentAudioChunk(detail.chunk);
    };
    const doneHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { chatId: string };
      if (detail.chatId !== activeChatId) return;
      handleAgentAudioDone();
    };
    window.addEventListener("agent-audio-chunk", chunkHandler);
    window.addEventListener("agent-audio-done", doneHandler);
    return () => {
      window.removeEventListener("agent-audio-chunk", chunkHandler);
      window.removeEventListener("agent-audio-done", doneHandler);
    };
  }, [activeChatId, ttsSettings.enabled, handleAgentAudioChunk, handleAgentAudioDone]);

  useEffect(() => {
    return () => {
      cleanupLiveAudio();
    };
  }, [activeChatId, cleanupLiveAudio]);

  // Handle auto-read for newly completed assistant messages.
  const autoReadChatIdRef = useRef<string | null>(null);
  const lastAutoReadMessageRef = useRef<string>("");
  const autoReadAwaitingInitialMessagesRef = useRef(false);
  const autoReadPendingTurnRef = useRef(false);
  const autoReadSawStreamingRef = useRef(false);
  const autoReadStreamingCompletedRef = useRef(false);
  const latestMessagesRef = useRef(messages);
  const latestActiveChatIdRef = useRef(activeChatId);
  const manualReadAloudFollowRef = useRef<{
    id: number;
    chatId: string | null;
    cursor: number;
    timer: number | null;
  } | null>(null);
  const manualReadAloudFollowIdRef = useRef(0);
  const continueManualReadAloudFollowRef = useRef<(id: number) => void>(() => {});

  // Keep streamingRef in sync so async callbacks (TTS onPlaybackEnd) read the live value
  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);

  useEffect(() => {
    latestMessagesRef.current = messages;
    const follow = manualReadAloudFollowRef.current;
    if (follow?.timer != null && follow.chatId === latestActiveChatIdRef.current) {
      window.clearTimeout(follow.timer);
      follow.timer = null;
      continueManualReadAloudFollowRef.current(follow.id);
    }
  }, [messages]);

  useEffect(() => {
    latestActiveChatIdRef.current = activeChatId;
  }, [activeChatId]);

  const clearManualReadAloudFollow = useCallback(() => {
    const follow = manualReadAloudFollowRef.current;
    if (follow?.timer != null) {
      window.clearTimeout(follow.timer);
    }
    manualReadAloudFollowRef.current = null;
    manualReadAloudFollowIdRef.current += 1;
    setTtsContinuationWaiting(false);
  }, [setTtsContinuationWaiting]);

  const continueManualReadAloudFollow = useCallback((id: number) => {
    const follow = manualReadAloudFollowRef.current;
    if (!follow || follow.id !== id || follow.chatId !== latestActiveChatIdRef.current) return;
    const streamStillActive = streamingRef.current && follow.chatId === latestActiveChatIdRef.current;

    if (follow.timer != null) {
      window.clearTimeout(follow.timer);
      follow.timer = null;
    }

    const latestMessages = latestMessagesRef.current;
    const lastMessage = latestMessages[latestMessages.length - 1];
    const latestText = lastMessage?.role === "assistant" ? lastMessage.content || "" : "";

    if (latestText.length < follow.cursor) {
      if (!streamStillActive) {
        clearManualReadAloudFollow();
        return;
      }
      follow.cursor = 0;
    }

    const unreadText = latestText.slice(follow.cursor);
    follow.cursor = latestText.length;

    if (unreadText.trim()) {
      setTtsContinuationWaiting(false);
      void playTts(unreadText, {
        onPlaybackEnd: () => continueManualReadAloudFollowRef.current(id),
      });
      return;
    }

    if (streamStillActive) {
      setTtsContinuationWaiting(true);
      follow.timer = window.setTimeout(() => {
        const current = manualReadAloudFollowRef.current;
        if (current?.id === id) {
          current.timer = null;
        }
        continueManualReadAloudFollowRef.current(id);
      }, 300);
      return;
    }

    clearManualReadAloudFollow();
  }, [clearManualReadAloudFollow, playTts, setTtsContinuationWaiting]);

  useEffect(() => {
    continueManualReadAloudFollowRef.current = continueManualReadAloudFollow;
  }, [continueManualReadAloudFollow]);

  useEffect(() => {
    clearManualReadAloudFollow();
  }, [activeChatId, clearManualReadAloudFollow]);

  useEffect(() => {
    return () => clearManualReadAloudFollow();
  }, [clearManualReadAloudFollow]);

  const handleReadAloud = useCallback((text: string) => {
    clearManualReadAloudFollow();

    const latestMessages = latestMessagesRef.current;
    const lastMessage = latestMessages[latestMessages.length - 1];
    const shouldFollowStreamingMessage =
      streamingRef.current &&
      latestActiveChatIdRef.current != null &&
      lastMessage?.role === "assistant" &&
      (lastMessage.content || "") === text;

    if (!shouldFollowStreamingMessage) {
      void playTts(text);
      return;
    }

    const id = manualReadAloudFollowIdRef.current + 1;
    manualReadAloudFollowIdRef.current = id;
    manualReadAloudFollowRef.current = {
      id,
      chatId: latestActiveChatIdRef.current,
      cursor: text.length,
      timer: null,
    };

    void playTts(text, {
      onPlaybackEnd: () => continueManualReadAloudFollowRef.current(id),
    });
  }, [clearManualReadAloudFollow, playTts]);

  const handleStandaloneReadAloud = useCallback((text: string) => {
    clearManualReadAloudFollow();
    void playTts(text);
  }, [clearManualReadAloudFollow, playTts]);

  const handleStopTts = useCallback(() => {
    clearManualReadAloudFollow();
    stopTts();
  }, [clearManualReadAloudFollow, stopTts]);

  const getAutoReadMessageId = useCallback((message: typeof messages[number]) => {
    let hash = 0;
    const input = `${message.role}:${message.timestamp}:${message.content}`;
    for (let i = 0; i < input.length; i++) {
      hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
    }
    return `${message.timestamp}:${(hash >>> 0).toString(36)}`;
  }, []);

  const hasAutoReadMessage = useCallback((chatId: string, message: typeof messages[number]) => {
    try {
      const raw = readStoredValue(TTS_AUTO_READ_MESSAGES_KEY, LEGACY_TTS_AUTO_READ_MESSAGES_KEY);
      if (!raw) return false;
      const ids = JSON.parse(raw);
      return Array.isArray(ids) && ids.includes(`${chatId}:${getAutoReadMessageId(message)}`);
    } catch {
      return false;
    }
  }, [getAutoReadMessageId]);

  const markAutoReadMessage = useCallback((chatId: string, message: typeof messages[number]) => {
    try {
      const raw = readStoredValue(TTS_AUTO_READ_MESSAGES_KEY, LEGACY_TTS_AUTO_READ_MESSAGES_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      const ids = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
      const nextId = `${chatId}:${getAutoReadMessageId(message)}`;
      const next = ids.includes(nextId) ? ids : [...ids, nextId];
      writeStoredValue(TTS_AUTO_READ_MESSAGES_KEY, JSON.stringify(next.slice(-500)), LEGACY_TTS_AUTO_READ_MESSAGES_KEY);
    } catch {
      // Auto-read deduplication is best-effort; playback should still work if storage is unavailable.
    }
  }, [getAutoReadMessageId]);
  
  useEffect(() => {
    const lastMsg = messages[messages.length - 1];
    const lastMsgKey = lastMsg
      ? `${activeChatId ?? "no-chat"}:${lastMsg.role}:${lastMsg.timestamp}:${lastMsg.content}`
      : `${activeChatId ?? "no-chat"}:empty`;

    // Switching chats or loading history should not read an old assistant message.
    if (autoReadChatIdRef.current !== activeChatId) {
      autoReadChatIdRef.current = activeChatId;
      autoReadAwaitingInitialMessagesRef.current = true;
      autoReadPendingTurnRef.current = false;
      autoReadSawStreamingRef.current = false;
      autoReadStreamingCompletedRef.current = false;
      lastAutoReadMessageRef.current = lastMsgKey;
      return;
    }

    if (streaming) {
      if (autoReadPendingTurnRef.current) {
        autoReadSawStreamingRef.current = true;
      }
      autoReadStreamingCompletedRef.current = false;
      return;
    }

    if (autoReadSawStreamingRef.current) {
      autoReadSawStreamingRef.current = false;
      autoReadStreamingCompletedRef.current = true;
    }

    if (!lastMsg || lastAutoReadMessageRef.current === lastMsgKey) return;

    if (autoReadAwaitingInitialMessagesRef.current && !autoReadStreamingCompletedRef.current) {
      autoReadAwaitingInitialMessagesRef.current = false;
      lastAutoReadMessageRef.current = lastMsgKey;
      if (activeChatId && lastMsg.role === "assistant") {
        markAutoReadMessage(activeChatId, lastMsg);
      }
      return;
    }

    lastAutoReadMessageRef.current = lastMsgKey;

    if (
      !autoReadPendingTurnRef.current ||
      !autoReadStreamingCompletedRef.current ||
      lastMsg.role !== "assistant" ||
      !lastMsg.content.trim() ||
      !ttsSettings.enabled ||
      !ttsSettings.autoReadEnabled ||
      lastMsg._isAutomationMessage ||
      (activeChatId ? hasAutoReadMessage(activeChatId, lastMsg) : false) ||
      liveTtsAudioSeenChatRef.current === activeChatId ||
      playbackState.isPlaying ||
      playbackState.isPaused ||
      playbackState.isLoading
    ) {
      if (activeChatId && liveTtsAudioSeenChatRef.current === activeChatId) {
        markAutoReadMessage(activeChatId, lastMsg);
      }
      if (lastMsg.role === "user") {
        liveTtsAudioSeenChatRef.current = null;
      }
      if (lastMsg.role === "assistant") {
        autoReadPendingTurnRef.current = false;
      }
      autoReadStreamingCompletedRef.current = false;
      return;
    }

    if (activeChatId) {
      markAutoReadMessage(activeChatId, lastMsg);
    }
    autoReadPendingTurnRef.current = false;
    autoReadStreamingCompletedRef.current = false;
    handleStandaloneReadAloud(lastMsg.content);
  }, [
    activeChatId,
    hasAutoReadMessage,
    handleStandaloneReadAloud,
    markAutoReadMessage,
    messages,
    playbackState.isLoading,
    playbackState.isPaused,
    playbackState.isPlaying,
    streaming,
    ttsSettings.autoReadEnabled,
    ttsSettings.enabled,
  ]);

  // Process message queue when coming back online
  useEffect(() => {
    if (isOnline && !prevOnlineRef.current) {
      refreshImmediate();
      processQueue();
    }
    prevOnlineRef.current = isOnline;
  }, [isOnline, refreshImmediate, processQueue]);

  // Refresh active chat data when the tab becomes visible (e.g. after using
  // another device). Keeps the view in sync with server without a full reload.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      if (!activeChatId) return;

      // Refresh the chat list sidebar (titles, previews, ordering)
      refresh();
      refreshActiveChatFromServer(activeChatId).catch(() => {});
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [activeChatId, refresh, refreshActiveChatFromServer]);

  // Lightweight active-chat freshness polling. This picks up server-side turns
  // from automations/system chat and changes made on other devices while the
  // current tab remains visible.
  useEffect(() => {
    if (!activeChatId) return;
    if (activeView !== "chats" || imageSandboxOpen) return;

    let cancelled = false;
    const pollActiveChat = () => {
      if (cancelled) return;
      if (document.visibilityState !== "visible") return;
      const id = activeChatIdStateRef.current;
      if (!id) return;
      refreshActiveChatFromServer(id, { priority: "low" }).catch(() => {});
    };

    const timer = window.setInterval(pollActiveChat, ACTIVE_CHAT_HEADER_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeChatId, activeView, imageSandboxOpen, refreshActiveChatFromServer]);

  // Update chat title when LLM-generated title arrives
  useEffect(() => {
    if (!titleUpdate) return;
    // Update the active chat header immediately
    if (titleUpdate.chatId === activeChatId) {
      setActiveChat((prev) => prev ? { ...prev, title: titleUpdate.title } : prev);
    }
    // Optimistic sidebar update — no need to wait for debounced API re-fetch
    updateChatTitle(titleUpdate.chatId, titleUpdate.title);
  }, [titleUpdate]); // eslint-disable-line react-hooks/exhaustive-deps

  // Filter models for the chat header selector (favorites mode)
  const headerModels = useMemo(() => {
    if (!settings.showOnlyFavorites || !settings.favoriteModels?.length) return models;
    const favSet = new Set(settings.favoriteModels);
    const filtered = models.filter((m) => favSet.has(m.id));
    // Always include the currently selected model even if not favorited
    const selectedId = activeChat?.modelId || settings.defaultModelId;
    if (selectedId && !filtered.some((m) => m.id === selectedId)) {
      const selected = models.find((m) => m.id === selectedId);
      if (selected) filtered.unshift(selected);
    }
    return filtered.length > 0 ? filtered : models;
  }, [models, settings.showOnlyFavorites, settings.favoriteModels, activeChat, settings.defaultModelId]);

  // Find context window for active model
  // Priority: chat override → detected value → fallback
  // Must match server-side getEffectiveContextWindow priority order
  const contextWindow = useMemo(() => {
    if (activeChat?.contextWindow) return activeChat.contextWindow;
    const modelId = activeChat?.modelId || settings.defaultModelId;
    const model = models.find((m) => m.id === modelId);
    return model?.contextWindow || 32768;
  }, [models, activeChat, settings.defaultModelId]);

  // Fetch full chat when selecting one (we need messages)
  // Cache-first: show IDB cached data immediately, refresh from server in background
  const selectChat = useCallback(
    async (id: string) => {
      setActiveChatId(id);
      activeChatIdStateRef.current = id;

      // If this chat has a background stream (active or recently completed),
      // the useChat effect will restore its state — skip loadMessages to avoid
      // overwriting with stale data from cache/server.
      // Show cached data immediately for instant feel.
      // Chromium can throw UnknownError ("Failed to read large IndexedDB value")
      // on oversized entries — treat any failure as a cache miss and self-heal.
      let cached: Chat | null = null;
      try {
        cached = await getCachedChat(id);
      } catch {
        clearCachedChat(id).catch(() => {});
      }
      if (cached) {
        setActiveChat(cached);
        activeChatStateRef.current = cached;
        setActiveChatData(cached);
        if (!hasBackgroundStream(id)) {
          loadMessages(cached.messages, {
            offset: cached.messageOffset ?? 0,
            total: cached.messageTotal ?? cached.messages.length,
          });
        }

        // Always validate cached chat content against the cheap server header.
        // The cached lastModified is the content version, not the time we read
        // the cache, so a local freshness window can hide autonomous/device
        // updates that happened after this client last loaded the chat.
        refreshActiveChatFromServer(id).catch(() => {});
        return;
      }

      // No cache — must fetch from server (blocking)
      try {
        const chat = await fetchChat(id, { messageLimit: INITIAL_MESSAGE_LIMIT });
        if (activeChatIdStateRef.current !== id) return;
        setActiveChat(chat);
        activeChatStateRef.current = chat;
        setActiveChatData(chat);
        if (!hasBackgroundStream(id)) {
          loadMessages(chat.messages, {
            offset: chat.messageOffset ?? 0,
            total: chat.messageTotal ?? chat.messages.length,
          });
        }
        setCachedChat(chat).catch(() => {});
      } catch {
        setActiveChatId(null);
        activeChatIdStateRef.current = null;
        setActiveChat(null);
        activeChatStateRef.current = null;
      }
    },
    [loadMessages, refreshActiveChatFromServer, setActiveChatData]
  );

  // Keep ref in sync so the push-click listener always uses the latest selectChat
  useEffect(() => {
    selectChatRef.current = selectChat;
  }, [selectChat]);

  // Handle push notification clicks from the service worker.
  // When the user taps a notification, the SW posts a "push-click" message
  // with the target chatId — we navigate to that chat.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    const handler = (event: MessageEvent) => {
      const data = event.data;
      if (!data || data.kind !== "push-click") return;
      const chatId = data.payload?.chatId;
      if (chatId && selectChatRef.current) {
        selectChatRef.current(chatId);
      }
    };

    navigator.serviceWorker.addEventListener("message", handler);
    return () => navigator.serviceWorker.removeEventListener("message", handler);
  }, []);

  const handleNewChat = useCallback((type: ChatType = "quick", projectId?: string) => {
    const modelId = settings.defaultModelId || models[0]?.id || "qwen3:8b";
    const chat = createChat(modelId, type, projectId);
    setActiveChatId(chat.id);
    activeChatIdStateRef.current = chat.id;
    setActiveChat(chat);
    activeChatStateRef.current = chat;
    setActiveChatData(chat);
    loadMessages([]);
  }, [settings.defaultModelId, models, createChat, loadMessages, setActiveChatData]);

  const handleDeleteChat = useCallback(
    async (id: string) => {
      await removeChat(id);
      clearCachedChat(id).catch(() => {});
      if (lastActiveChatId === id) {
        setLastActiveChatId(null);
      }
      if (activeChatId === id) {
        setActiveChatId(null);
        activeChatIdStateRef.current = null;
        setActiveChat(null);
        activeChatStateRef.current = null;
        loadMessages([]);
      }
    },
    [activeChatId, lastActiveChatId, removeChat, loadMessages]
  );

  const handleNewProject = useCallback(() => {
    setProjectModalOpen(true);
  }, []);

  const handleCreateProject = useCallback(async (name: string, path: string, locationType?: "local" | "ssh", sshConnectionId?: string) => {
    await createProject(name, path, locationType, sshConnectionId);
    refresh();
  }, [createProject, refresh]);

  const handleDeleteProject = useCallback(async (id: string) => {
    try {
      await removeProject(id);
    } catch (e: any) {
      console.error("[projects] delete failed:", e);
    }
  }, [removeProject]);

  const handleSend = useCallback(
    (text: string, images?: import("./types").ImageAttachment[]) => {
      if (activeChatId) setLastActiveChatId(activeChatId);
      autoReadPendingTurnRef.current = true;
      send(text, images);
    },
    [activeChatId, send]
  );

  const handleEditMessage = useCallback(
    (index: number, newText: string, images?: import("./types").ImageAttachment[], messageSequence?: number) => {
      if (activeChatId) setLastActiveChatId(activeChatId);
      autoReadPendingTurnRef.current = true;
      editMessage(index, newText, images, messageSequence);
    },
    [activeChatId, editMessage]
  );

  const handleRetryMessage = useCallback(
    (index: number, messageSequence?: number) => {
      if (activeChatId) setLastActiveChatId(activeChatId);
      autoReadPendingTurnRef.current = true;
      retryMessage(index, messageSequence);
    },
    [activeChatId, retryMessage]
  );

  const hasActiveChat = activeChat != null;

  const handleModelChange = useCallback(
    async (modelId: string) => {
      if (!activeChatId || !hasActiveChat) return;
      const updated = await apiUpdateChat(activeChatId, { modelId });
      setActiveChat((prev) =>
        prev
          ? { ...prev, modelId, contextWindow: updated.contextWindow }
          : prev
      );
    },
    [activeChatId, hasActiveChat]
  );

  const handleSystemPromptChange = useCallback(
    async (systemPrompt: string) => {
      if (!activeChatId || !hasActiveChat) return;
      await apiUpdateChat(activeChatId, { systemPrompt });
      setActiveChat((prev) => (prev ? { ...prev, systemPrompt } : prev));
    },
    [activeChatId, hasActiveChat]
  );

  const handleContextWindowChange = useCallback(
    async (value: number | null) => {
      if (!activeChatId || !hasActiveChat) return;
      await apiUpdateChat(activeChatId, { contextWindow: value });
      setActiveChat((prev) => {
        if (!prev) return prev;
        if (value === null) {
          const { contextWindow: _, ...rest } = prev;
          return rest as Chat;
        }
        return { ...prev, contextWindow: value };
      });
    },
    [activeChatId, hasActiveChat]
  );

  // Model default context window (for reset-to-default in editor)
  // Same priority as contextWindow but without per-chat override
  const modelContextWindow = useMemo(() => {
    const modelId = activeChat?.modelId || settings.defaultModelId;
    const model = models.find((m) => m.id === modelId);
    return model?.contextWindow || 32768;
  }, [models, activeChat?.modelId, settings.defaultModelId]);

  const handleOpenSettings = useCallback(() => setSettingsOpen(true), []);
  const handleCloseSidebar = useCallback(() => setSidebarOpen(false), []);
  const handleOpenSidebar = useCallback(() => setSidebarOpen(true), []);
  const handleOpenImageSandbox = useCallback(() => {
    setActiveView('chats');
    setImageSandboxOpen(true);
    saveUserUIState({ activeView: 'image-sandbox' }).catch((err) => {
      console.warn("Failed to save image sandbox state to server:", err);
    });
  }, []);

  const handleCloseImageSandbox = useCallback(() => {
    setImageSandboxOpen(false);
    saveUserUIState({ activeView: activeView }).catch((err) => {
      console.warn("Failed to save active view to server:", err);
    });
  }, [activeView]);
  const handleCloseSettings = useCallback(() => setSettingsOpen(false), []);
  const handleApplySettings = useCallback(
    async (s: import("./types").Settings) => {
      await updateSettings(s);
    },
    [updateSettings]
  );
  const handleSaveSettings = useCallback(
    async (s: import("./types").Settings) => {
      await updateSettings(s);
      setSettingsOpen(false);
    },
    [updateSettings]
  );
  const handleSwitchView = useCallback((view: 'chats' | 'notebooks') => {
    setActiveView(view);
    setSidebarOpen(false);
  }, []);

  // Synthesis handlers. Trigger dispatches the run server-side (202 Accepted)
  // Release the system to autonomous mode. Stamps sleepModeTriggeredAt which
  // immediately activates the sleep cycle. No longer dispatches synthesis —
  // the scheduler runs synthesis/wake on their normal schedule.
  const handleSynthesisSleep = useCallback(async () => {
    if (isSynthesizing) return;
    setSleepModeActive(true);
    try {
      await triggerSleepMode();
      // Sleep cycle will activate immediately on next poll tick.
      // No synthesis dispatch — the scheduler handles scheduling.
    } catch (e: any) {
      console.error("Sleep mode failed:", e.message);
    } finally {
      setTimeout(() => setSleepModeActive(false), 5000);
    }
  }, [isSynthesizing]);

  const handleSynthesisRun = useCallback(async () => {
    if (isSynthesizing) return;
    setSynthesisComplete(false);
    try {
      await triggerSynthesis();
      setIsSynthesizing(true);
      wasSynthesizingRef.current = true;
    } catch (e: any) {
      console.error("Synthesis failed:", e.message);
    }
  }, [isSynthesizing]);

  const handleWakeRun = useCallback(async () => {
    if (isWakeCycleRunning) return;
    try {
      await triggerWakeCycle();
      setIsWakeCycleRunning(true);
    } catch (e: any) {
      console.error("Wake cycle failed:", e.message);
    }
  }, [isWakeCycleRunning]);

  const handlePauseSystem = useCallback(async (durationMs: number | null) => {
    try {
      const next = await pauseSystem(durationMs === null ? { indefinite: true } : { durationMs });
      setSystemPause(next);
    } catch (e: any) {
      console.error("System pause failed:", e.message);
      throw e;
    }
  }, []);

  const handleResumeSystem = useCallback(async () => {
    try {
      const next = await resumeSystem();
      setSystemPause(next);
    } catch (e: any) {
      console.error("System resume failed:", e.message);
      throw e;
    }
  }, []);

  // Close image sandbox when switching to notebooks
  useEffect(() => {
    if (activeView === 'notebooks' && imageSandboxOpen) {
      setImageSandboxOpen(false);
    }
  }, [activeView, imageSandboxOpen]);

  const handleSendToNotebook = useCallback(async (chatId: string, chatTitle: string) => {
    try {
      const entry = await createUserEntry(`Linked from chat: **${chatTitle}**`);
      if (entry) {
        await updateEntry('user', entry.id, {
          links: { chats: [{ chatId, title: chatTitle }] },
        });
      }
      setActiveView('notebooks');
      setSidebarOpen(false);
    } catch (e) {
      console.error("[send-to-notebook] failed:", e);
    }
  }, [createUserEntry, updateEntry]);

  const handleWarmCache = useCallback(async (chatId: string) => {
    setCacheWarmErrors((prev) => {
      if (!prev.has(chatId)) return prev;
      const next = new Map(prev);
      next.delete(chatId);
      return next;
    });
    setCacheWarmingChatIds((prev) => {
      if (prev.has(chatId)) return prev;
      const next = new Set(prev);
      next.add(chatId);
      return next;
    });
    try {
      const { warmCache } = await import("./api/client");
      const result = await warmCache(chatId, "user-requested");
      if (result.warmed) {
        const tokens = result.tokensEvaluated || 0;
        const ms = result.promptMs || 0;
        const speed = ms > 0 ? (tokens / (ms / 1000)).toFixed(0) : "—";
        console.log(`[cache-warm] ${chatId}: warmed ${tokens} tokens in ${ms}ms (~${speed} t/s)`);
      } else {
        throw new Error(result.error || "Cache warm failed");
      }
    } catch (e: any) {
      const message = e?.message || "Cache warm failed";
      console.error("[cache-warm] failed:", e);
      setCacheWarmErrors((prev) => {
        const next = new Map(prev);
        next.set(chatId, message);
        return next;
      });
      window.setTimeout(() => {
        setCacheWarmErrors((prev) => {
          if (prev.get(chatId) !== message) return prev;
          const next = new Map(prev);
          next.delete(chatId);
          return next;
        });
      }, 15_000);
    } finally {
      setCacheWarmingChatIds((prev) => {
        if (!prev.has(chatId)) return prev;
        const next = new Set(prev);
        next.delete(chatId);
        return next;
      });
      await refreshCacheResidency?.();
    }
  }, [refreshCacheResidency]);

  // Keyboard inset only - TTS bar is handled within ChatView
  const totalBottomInset = keyboardInset || 0;

  const activityStyle = {
    shape: settings.activityShape || 'octahedron',
    hue: settings.activityHue ?? 38,
    saturation: settings.activitySaturation ?? 85,
  }

  return (
    <HapticsProvider enabled={settings.hapticsEnabled !== false}>
    <ActivityStyleProvider value={activityStyle}>
    <div className="flex h-full overflow-hidden relative isolate" style={totalBottomInset ? { paddingBottom: totalBottomInset } : undefined}>
      {settings.backgroundEffect === "ripple-grid" && (
        <Suspense fallback={null}>
          <RippleGridBackground />
        </Suspense>
      )}
      {settings.backgroundEffect === "scan-lines" && (
        <Suspense fallback={null}>
          <ScanLinesBackground />
        </Suspense>
      )}
      {settings.backgroundEffect === "ripple-dots" && (
        <Suspense fallback={null}>
          <RippleDotsBackground />
        </Suspense>
      )}
      {settings.backgroundEffect === "graph-paper" && (
        <Suspense fallback={null}>
          <GraphPaperBackground />
        </Suspense>
      )}
      <Sidebar
        chats={chats}
        projects={projects}
        activeChatId={activeView === 'chats' ? activeChatId : null}
        activeView={activeView}
        onSelectChat={(id) => { selectChat(id); setImageSandboxOpen(false); setActiveView('chats'); }}
        onSwitchView={handleSwitchView}
        onNewChat={(type, projectId) => { handleNewChat(type, projectId); setImageSandboxOpen(false); setActiveView('chats'); }}
        onNewProject={handleNewProject}
        onDeleteChat={handleDeleteChat}
        onDeleteProject={handleDeleteProject}
        onSendToNotebook={handleSendToNotebook}
        onWarmCache={handleWarmCache}
        cacheWarmingChatIds={cacheWarmingChatIds}
        cacheWarmErrors={cacheWarmErrors}
        onOpenSettings={handleOpenSettings}
        onOpenMemoryDebug={() => setMemoryDebugOpen(true)}
        onOpenModelStats={() => setModelStatsOpen(true)}
        onOpenImageSandbox={handleOpenImageSandbox}
        isOpen={sidebarOpen}
        onClose={handleCloseSidebar}
        onOpen={handleOpenSidebar}
        isStreaming={anyStreaming}
        hasUnreadNotebooks={hasUnreadAgentEntries()}
        ttsBarVisible={playbackState.isPlaying || playbackState.isPaused || playbackState.isLoading}
        hasBackgroundActivity={hasBackgroundActivity}
        lastActiveChatId={lastActiveChatId}
        cacheResidency={cacheResidency}
        isSynthesizing={isSynthesizing}
        isAutomationRunning={isAutomationRunning}
        synthesisComplete={synthesisComplete}
        sleepModeActive={sleepModeActive}
        sleepCycleActive={sleepCycleActive}
        isExtractionRunning={isExtractionRunning}
        isWakeCycleRunning={isWakeCycleRunning}
        systemPause={systemPause}
        onPauseSystem={handlePauseSystem}
        onResumeSystem={handleResumeSystem}
        onSynthesisSleep={handleSynthesisSleep}
        isImageSandboxOpen={imageSandboxOpen}
        systemStatsHistory={systemStatsHistory}
        systemStatsCurrent={systemStatsCurrent}
        systemStatsHiddenGpus={settings.systemStatsHiddenGpus}
        showSystemStats={settings.systemStatsEnabled ?? false}
        agentName={settings.agentName}
      />
      {/* Backdrop is now rendered inside Sidebar with gesture-tracked opacity */}
      {imageSandboxOpen ? (
        <ImageSandbox
          defaultModelId={activeChat?.modelId || settings.defaultModelId || models[0]?.id || ""}
          onClose={handleCloseImageSandbox}
        />
      ) : activeView === 'notebooks' ? (
        <NotebookView
          userNotebooks={userNotebooks}
          agentNotebooks={agentNotebooks}
          loading={notebooksLoading}
          error={notebooksError}
          onCreateUserEntry={async (content, images) => { return await createUserEntry(content, images); }}
          onCreateAgentEntry={async (content) => { await createAgentEntry(content); }}
          onUpdateEntry={async (author, id, updates) => { await updateEntry(author, id, updates); }}
          onDeleteEntry={async (author, id) => { await removeEntry(author, id); }}
          onReadAloud={ttsSettings.enabled ? handleStandaloneReadAloud : undefined}
          onTriggerAgentReview={async () => { return await triggerAgentReview(); }}
          chats={chats}
          onChatSelect={(chatId) => { selectChat(chatId); setActiveView('chats'); setImageSandboxOpen(false); }}
          onVisible={markAgentEntriesSeen}
          onOpenSidebar={() => setSidebarOpen(true)}
          searchResults={notebookSearchResults}
          searchQuery={notebookSearchQuery}
          isSearching={isSearchingNotebooks}
          onSearch={searchNotebookEntries}
          onClearSearch={clearNotebookSearch}
        />
      ) : (
      <ChatView
        chatId={activeChatId}
        chatTitle={activeChat?.title || "New Chat"}
        onOpenSidebar={handleOpenSidebar}
        messages={messages}
        messageOffset={messageOffset}
        messageTotal={messageTotal}
        hasMoreMessages={hasMoreMessages}
        olderMessagesLoading={olderMessagesLoading}
        onLoadOlderMessages={loadOlderMessages}
        streaming={streaming}
        streamingThinking={streamingThinking}
        streamingThinkingActive={streamingThinkingActive}
        streamingThinkingAccumulatedMs={streamingThinkingAccumulatedMs}
        streamingThinkingLastStartRef={streamingThinkingLastStartRef}
        activeTools={activeTools}
        artifacts={artifacts}
        generatedImages={generatedImages}
        totalUsage={totalUsage}
        isUsageEstimated={isUsageEstimated}
        compacting={compacting}
        compaction={compaction}
        modelProgress={modelProgress}
        inferenceActivityPhase={inferenceActivityPhase}
        hasCompactionSummary={hasCompactionSummary}
        contextWindow={contextWindow}
        error={error}
        warning={warning}
        models={headerModels}
        selectedModelId={activeChat?.modelId || settings.defaultModelId || models[0]?.id || ""}
        systemPrompt={activeChat?.systemPrompt || "You are a helpful assistant."}
        systemPromptPresets={settings.systemPromptPresets}
        chatType={activeChat?.type}
        isSynthesizing={isSynthesizing}
        ttsEnabled={ttsSettings.enabled}
        ttsAutoReadEnabled={ttsSettings.autoReadEnabled}
        playbackState={playbackState}
        ttsBarVisible={playbackState.isPlaying || playbackState.isPaused || playbackState.isLoading}
        onTtsAutoReadToggle={(enabled) => {
          void updateTtsSettings({ autoReadEnabled: enabled });
          if (enabled) {
            const lastAssistantMsg = [...messages].reverse().find(m => m.role === "assistant" && m.content);
            if (lastAssistantMsg) {
              handleStandaloneReadAloud(lastAssistantMsg.content);
            }
          } else {
            handleStopTts();
          }
        }}
        onReadAloud={ttsSettings.enabled ? handleReadAloud : undefined}
        onSend={handleSend}
        onEditMessage={handleEditMessage}
        onRetryMessage={handleRetryMessage}
        onAbort={abort}
        onModelChange={handleModelChange}
        onSystemPromptChange={handleSystemPromptChange}
        onContextWindowChange={handleContextWindowChange}
        modelContextWindow={modelContextWindow}
        hasContextWindowOverride={activeChat?.contextWindow != null}
        waitingForInput={waitingForInput}
        isOnline={isOnline}
        queueProcessing={queueProcessing}
        reconnecting={reconnecting}
        activeSkills={activeChat?.activeSkills}
        projectId={activeChat?.projectId}
        streamingSegmentIndex={streamingSegmentIndex}
        onArtifactRuntimeError={reportArtifactRuntimeError}
        headerImageEnabled={settings.headerImageEnabled}
        headerImageId={settings.headerImageId}
      />
      )}
      {settingsOpen && !settingsLoading && (
        <SettingsModal
          settings={settings}
          models={models}
          refreshModels={refreshModels}
          onApply={handleApplySettings}
          onSave={handleSaveSettings}
          onClose={handleCloseSettings}
          onLogout={onLogout}
        />
      )}
      <MemoryDebugPanel isOpen={memoryDebugOpen} onClose={() => setMemoryDebugOpen(false)} />
      <ModelStatsModal isOpen={modelStatsOpen} onClose={() => setModelStatsOpen(false)} />
      {projectModalOpen && (
        <CreateProjectModal
          onClose={() => setProjectModalOpen(false)}
          onCreate={handleCreateProject}
        />
      )}
      
      {/* TTS Control Bar */}
      {(playbackState.isPlaying || playbackState.isPaused || playbackState.isLoading) && (
        <div className="fixed bottom-0 left-0 right-0 z-40">
          <TTSControlBar
            playbackState={playbackState}
            onPause={() => pauseTts()}
            onResume={() => resumeTts()}
            onStop={handleStopTts}
          />
        </div>
      )}
    </div>
    </ActivityStyleProvider>
    </HapticsProvider>
  );
}

export default function App() {
  const { authState, error, register, login, logout } = useAuth();
  const { settings: appSettings, loading: settingsLoading } = useSettings();

  // Apply corner shape and radius as soon as settings are available.
  // Before settings load (or when the user isn't authenticated yet and /api/settings
  // returns 401), fall back to the cached value from localStorage so the login screen
  // still reflects the saved preference.
  useEffect(() => {
    if (!settingsLoading) {
      document.documentElement.setAttribute('data-corner', appSettings.cornerShape || readCachedCornerShape());
      document.documentElement.setAttribute('data-radius', appSettings.cornerRadius || readCachedCornerRadius());
    }
  }, [appSettings.cornerShape, appSettings.cornerRadius, settingsLoading]);

  if (authState === "loading") {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-6 h-6 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
      </div>
    );
  }

  if (authState === "needs-setup" || authState === "needs-login") {
    return (
      <LoginPage
        authState={authState}
        error={error}
        onRegister={register}
        onLogin={login}
        agentName={appSettings.agentName}
        cornerShape={appSettings.cornerShape || readCachedCornerShape()}
      />
    );
  }

  return (
    <PinnedItemProvider>
      <AuthenticatedApp onLogout={logout} />
    </PinnedItemProvider>
  );
}
