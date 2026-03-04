import { useState, useCallback, useMemo, useEffect, lazy, Suspense, useRef } from "react";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { SettingsModal } from "./components/SettingsModal";
import { LoginPage } from "./components/LoginPage";
import { ImageSandbox } from "./components/ImageSandbox";

const RippleGridBackground = lazy(() =>
  import("./components/RippleGridBackground").then((m) => ({ default: m.RippleGridBackground }))
);
import { useChats } from "./hooks/useChats";
import { useChat, hasBackgroundStream } from "./hooks/useChat";
import { useModels } from "./hooks/useModels";
import { useSettings } from "./hooks/useSettings";
import { useAuth } from "./hooks/useAuth";
import { useOnlineStatus } from "./hooks/useOnlineStatus";
import { useKeyboardInset } from "./hooks/useKeyboardInset";
import { updateChat as apiUpdateChat } from "./api/client";
import { setCachedChat, getCachedChat, clearCachedChat } from "./lib/db";
import { HapticsProvider } from "./hooks/useHaptics";
import { useTTS } from "./hooks/useTTS";
import type { Chat, ChatType } from "./types";

function AuthenticatedApp({ onLogout }: { onLogout: () => void }) {
  const { models } = useModels();
  const { chats, createChat, removeChat, refresh } = useChats();
  const { settings, updateSettings } = useSettings();
  const { isOnline } = useOnlineStatus();
  const keyboardInset = useKeyboardInset();
  const prevOnlineRef = useRef(isOnline);
  const { playbackState, loadSettings: loadTtsSettings, updateSettings: updateTtsSettings, play: playTts, stop: stopTts } = useTTS();
  const [activeChatId, setActiveChatId] = useState<string | null>(() => {
    return sessionStorage.getItem("activeChatId");
  });
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [imageSandboxOpen, setImageSandboxOpen] = useState(false);
  const {
    messages,
    streaming,
    streamingThinking,
    activeTools,
    artifacts,
    generatedImages,
    waitingForInput,
    totalUsage,
    compaction,
    error,
    warning,
    send,
    editMessage,
    abort,
    loadMessages,
    setActiveChatData,
    processQueue,
    queueProcessing,
  } = useChat(activeChatId);

  // Persist active chat ID across reloads
  useEffect(() => {
    if (activeChatId) {
      sessionStorage.setItem("activeChatId", activeChatId);
    } else {
      sessionStorage.removeItem("activeChatId");
    }
  }, [activeChatId]);

  // Restore active chat on mount
  useEffect(() => {
    if (activeChatId && !activeChat) {
      selectChat(activeChatId);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load TTS settings on mount
  useEffect(() => {
    loadTtsSettings();
  }, [loadTtsSettings]);

  // Handle auto-read for new assistant messages
  const lastMessageRef = useRef<string>("");
  
  useEffect(() => {
    if (messages.length === 0) return;
    
    const lastMsg = messages[messages.length - 1];
    const lastMsgKey = `${lastMsg.role}-${lastMsg.content}-${lastMsg.timestamp}`;
    
    // Check if this is a new assistant message
    if (lastMsg.role === "assistant" && lastMsgKey !== lastMessageRef.current) {
      lastMessageRef.current = lastMsgKey;
      
      // Only auto-read if enabled and not currently playing
      // Note: autoReadEnabled is stored in server TTS settings, not local settings
      // We'll check a local state for this instead
    }
  }, [messages]);

  // Process message queue when coming back online
  useEffect(() => {
    if (isOnline && !prevOnlineRef.current) {
      refresh();
      processQueue();
    }
    prevOnlineRef.current = isOnline;
  }, [isOnline, refresh, processQueue]);

  // Find context window for active model (chat override takes precedence)
  const contextWindow = useMemo(() => {
    if (activeChat?.contextWindow) return activeChat.contextWindow;
    const model = models.find((m) => m.id === activeChat?.modelId);
    return model?.contextWindow || 32768;
  }, [models, activeChat]);

  // Fetch full chat when selecting one (we need messages)
  // Cache-first: show IDB cached data immediately, then refresh from server
  const selectChat = useCallback(
    async (id: string) => {
      setActiveChatId(id);

      // If this chat has a background stream (active or recently completed),
      // the useChat effect will restore its state — skip loadMessages to avoid
      // overwriting with stale data from cache/server.
      const hasBg = hasBackgroundStream(id);

      // Show cached data immediately for instant feel
      const cached = await getCachedChat(id);
      if (cached) {
        setActiveChat(cached);
        setActiveChatData(cached);
        if (!hasBg) loadMessages(cached.messages);
      }

      // Fetch fresh data from server in parallel
      try {
        const res = await fetch(`/api/chats/${id}`, { credentials: "include" });
        if (res.ok) {
          const chat: Chat = await res.json();
          setActiveChat(chat);
          setActiveChatData(chat);
          if (!hasBg) loadMessages(chat.messages);
          setCachedChat(chat).catch(() => {});
        } else if (!cached) {
          setActiveChatId(null);
          setActiveChat(null);
        }
      } catch {
        // Network error — if we already showed cached data, that's fine
        if (!cached) {
          setActiveChatId(null);
          setActiveChat(null);
        }
      }
    },
    [loadMessages, setActiveChatData]
  );

  const handleNewChat = useCallback(async (type: ChatType = "quick") => {
    try {
      const modelId = settings.defaultModelId || models[0]?.id || "qwen3:8b";
      const chat = await createChat(modelId, type);
      setActiveChatId(chat.id);
      setActiveChat(chat);
      setActiveChatData(chat);
      loadMessages([]);
    } catch {
      // Can't create chats offline
    }
  }, [settings.defaultModelId, models, createChat, loadMessages, setActiveChatData]);

  const handleDeleteChat = useCallback(
    async (id: string) => {
      await removeChat(id);
      clearCachedChat(id).catch(() => {});
      if (activeChatId === id) {
        setActiveChatId(null);
        setActiveChat(null);
        loadMessages([]);
      }
    },
    [activeChatId, removeChat, loadMessages]
  );

  const handleSend = useCallback(
    (text: string, images?: import("./types").ImageAttachment[]) => {
      send(text, images);
      // Refresh chat list after a short delay to pick up title changes
      setTimeout(() => refresh(), 500);
      setTimeout(() => refresh(), 2000);
    },
    [send, refresh]
  );

  const handleEditMessage = useCallback(
    (index: number, newText: string) => {
      editMessage(index, newText);
      // Refresh chat list after a short delay to pick up title changes
      setTimeout(() => refresh(), 500);
      setTimeout(() => refresh(), 2000);
    },
    [editMessage, refresh]
  );

  const hasActiveChat = activeChat != null;

  const handleModelChange = useCallback(
    async (modelId: string) => {
      if (!activeChatId || !hasActiveChat) return;
      await apiUpdateChat(activeChatId, { modelId });
      setActiveChat((prev) => (prev ? { ...prev, modelId } : prev));
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
  const modelContextWindow = useMemo(() => {
    const model = models.find((m) => m.id === activeChat?.modelId);
    return model?.contextWindow || 32768;
  }, [models, activeChat?.modelId]);

  const handleOpenSettings = useCallback(() => setSettingsOpen(true), []);
  const handleCloseSidebar = useCallback(() => setSidebarOpen(false), []);
  const handleOpenSidebar = useCallback(() => setSidebarOpen(true), []);
  const handleOpenImageSandbox = useCallback(() => setImageSandboxOpen(true), []);
  const handleCloseImageSandbox = useCallback(() => setImageSandboxOpen(false), []);
  const handleCloseSettings = useCallback(() => setSettingsOpen(false), []);
  const handleSaveSettings = useCallback(
    async (s: import("./types").Settings) => {
      await updateSettings(s);
      setSettingsOpen(false);
    },
    [updateSettings]
  );

  return (
    <div className="flex h-full overflow-hidden relative" style={keyboardInset ? { paddingBottom: keyboardInset } : undefined}>
      {settings.theme === "ripple-grid" && (
        <Suspense fallback={null}>
          <RippleGridBackground />
        </Suspense>
      )}
      <Sidebar
        chats={chats}
        activeChatId={activeChatId}
        onSelectChat={(id) => { selectChat(id); setImageSandboxOpen(false); }}
        onNewChat={(type) => { handleNewChat(type); setImageSandboxOpen(false); }}
        onDeleteChat={handleDeleteChat}
        onOpenSettings={handleOpenSettings}
        onOpenImageSandbox={handleOpenImageSandbox}
        isOpen={sidebarOpen}
        onClose={handleCloseSidebar}
      />
      {sidebarOpen && (
        <div className="fixed inset-0 z-20 bg-black/50 md:hidden" onClick={handleCloseSidebar} />
      )}
      {imageSandboxOpen ? (
        <ImageSandbox onClose={handleCloseImageSandbox} />
      ) : (
      <ChatView
        chatId={activeChatId}
        chatTitle={activeChat?.title || "New Chat"}
        onOpenSidebar={handleOpenSidebar}
        messages={messages}
        streaming={streaming}
        streamingThinking={streamingThinking}
        activeTools={activeTools}
        artifacts={artifacts}
        generatedImages={generatedImages}
        totalUsage={totalUsage}
        compaction={compaction}
        contextWindow={contextWindow}
        error={error}
        warning={warning}
        models={models}
        selectedModelId={activeChat?.modelId || models[0]?.id || ""}
        systemPrompt={activeChat?.systemPrompt || "You are a helpful assistant."}
        systemPromptPresets={settings.systemPromptPresets}
        ttsAutoReadEnabled={playbackState.isPlaying || playbackState.isPaused}
        onTtsAutoReadToggle={() => {}}
        onReadAloud={playTts}
        onSend={handleSend}
        onEditMessage={handleEditMessage}
        onAbort={abort}
        onModelChange={handleModelChange}
        onSystemPromptChange={handleSystemPromptChange}
        onContextWindowChange={handleContextWindowChange}
        modelContextWindow={modelContextWindow}
        hasContextWindowOverride={activeChat?.contextWindow != null}
        waitingForInput={waitingForInput}
        isOnline={isOnline}
        queueProcessing={queueProcessing}
      />
      )}
      {settingsOpen && (
        <SettingsModal
          settings={settings}
          models={models}
          onSave={handleSaveSettings}
          onClose={handleCloseSettings}
          onLogout={onLogout}
        />
      )}
      
      {/* TTS Control Bar */}
      {(playbackState.isPlaying || playbackState.isPaused) && (
        <div className="fixed bottom-0 left-0 right-0 z-40">
          <div className="bg-[#1a1a2e]/95 backdrop-blur-md border-t border-white/10 py-2 px-4">
            <div className="max-w-4xl mx-auto flex items-center gap-3">
              <button
                onClick={() => playbackState.isPlaying ? stopTts() : playbackState.isPaused && playTts(lastMessageRef.current ? messages[messages.length-1]?.content || "" : "")}
                className="w-9 h-9 rounded-full bg-white/10 border border-white/20 text-white/60 flex items-center justify-center hover:bg-white/20 hover:text-white/80 transition-colors shrink-0"
                title="Stop"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                </svg>
              </button>
              <div className="flex-1 min-w-0">
                <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-400/60 transition-all duration-300 animate-pulse"
                    style={{ width: playbackState.isPlaying ? "100%" : "30%" }}
                  />
                </div>
                <div className="flex justify-between mt-1 text-[10px] text-white/40">
                  <span>{playbackState.isPlaying ? "Playing..." : "Paused"}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const { authState, error, register, login, logout } = useAuth();

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
      />
    );
  }

  return (
    <HapticsProvider>
      <AuthenticatedApp onLogout={logout} />
    </HapticsProvider>
  );
}
