import { useState, useCallback, useMemo, useEffect, lazy, Suspense, useRef } from "react";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { NotebookView } from "./components/NotebookView";
import { SettingsModal } from "./components/SettingsModal";
import { LoginPage } from "./components/LoginPage";

const ImageSandbox = lazy(() => import("./components/ImageSandbox").then((m) => ({ default: m.ImageSandbox })));

const RippleGridBackground = lazy(() =>
  import("./components/RippleGridBackground").then((m) => ({ default: m.RippleGridBackground }))
);
import { useChats } from "./hooks/useChats";
import { useChat, hasBackgroundStream } from "./hooks/useChat";
import { useProjects } from "./hooks/useProjects";
import { useModels } from "./hooks/useModels";
import { useSettings } from "./hooks/useSettings";
import { useAuth } from "./hooks/useAuth";
import { useOnlineStatus } from "./hooks/useOnlineStatus";
import { useKeyboardInset } from "./hooks/useKeyboardInset";
import { updateChat as apiUpdateChat } from "./api/client";
import { setCachedChat, getCachedChat, clearCachedChat } from "./lib/db";
import { HapticsProvider } from "./hooks/useHaptics";
import { useTTS } from "./hooks/useTTS";
import { TTSControlBar } from "./components/TTSControlBar";
import { useNotebooks } from "./hooks/useNotebooks";
import type { Chat, ChatType } from "./types";

function AuthenticatedApp({ onLogout }: { onLogout: () => void }) {
  const { models } = useModels();
  const { chats, createChat, removeChat, refresh } = useChats();
  const { projects, createProject, removeProject } = useProjects();
  const { settings, updateSettings } = useSettings();
  const { isOnline } = useOnlineStatus();
  const keyboardInset = useKeyboardInset();
  const prevOnlineRef = useRef(isOnline);
  const { playbackState, loadSettings: loadTtsSettings, updateSettings: updateTtsSettings, play: playTts, stop: stopTts, pause: pauseTts } = useTTS();
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
  } = useNotebooks();
  const [activeView, setActiveView] = useState<'chats' | 'notebooks'>('chats');
  const [activeChatId, setActiveChatId] = useState<string | null>(() => {
    return localStorage.getItem("quje-active-chat-id");
  });
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [imageSandboxOpen, setImageSandboxOpen] = useState(() => {
    return localStorage.getItem("quje-active-view") === "image-sandbox";
  });
  const {
    messages,
    streaming,
    streamingThinking,
    activeTools,
    artifacts,
    generatedImages,
    waitingForInput,
    totalUsage,
    compacting,
    compaction,
    error,
    warning,
    streamingSegmentIndex,
    send,
    editMessage,
    abort,
    loadMessages,
    setActiveChatData,
    processQueue,
    queueProcessing,
    titleUpdate,
  } = useChat(activeChatId);

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
      };
      themeColorMeta.setAttribute('content', themeColors[theme] || '#0f172a');
    }
  }, [settings.theme]);

  // Apply background effect
  useEffect(() => {
    if (settings.backgroundEffect === 'ripple-grid' && !imageSandboxOpen) {
      // Ripple grid is rendered conditionally below
    }
  }, [settings.backgroundEffect, imageSandboxOpen]);

  // Persist active view across reloads
  useEffect(() => {
    if (activeChatId) {
      localStorage.setItem("quje-active-chat-id", activeChatId);
    } else {
      localStorage.removeItem("quje-active-chat-id");
    }
  }, [activeChatId]);

  useEffect(() => {
    localStorage.setItem("quje-active-view", activeView);
  }, [activeView]);

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

  // Update chat title when LLM-generated title arrives
  useEffect(() => {
    if (!titleUpdate) return;
    if (titleUpdate.chatId === activeChatId) {
      setActiveChat((prev) => prev ? { ...prev, title: titleUpdate.title } : prev);
    }
    refresh();
  }, [titleUpdate]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const handleNewChat = useCallback(async (type: ChatType = "quick", projectId?: string) => {
    try {
      const modelId = settings.defaultModelId || models[0]?.id || "qwen3:8b";
      const chat = await createChat(modelId, type, projectId);
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

  const handleNewProject = useCallback(async () => {
    const name = prompt("Project name:");
    if (!name) return;
    const path = prompt("Project path (absolute):");
    if (!path) return;
    try {
      await createProject(name, path);
    } catch (e: any) {
      console.error("[projects] create failed:", e);
    }
  }, [createProject]);

  const handleDeleteProject = useCallback(async (id: string) => {
    try {
      await removeProject(id);
    } catch (e: any) {
      console.error("[projects] delete failed:", e);
    }
  }, [removeProject]);

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
  const handleSwitchView = useCallback((view: 'chats' | 'notebooks') => {
    setActiveView(view);
    setSidebarOpen(false);
    // Close image sandbox when switching views
    if (view === 'notebooks' && imageSandboxOpen) {
      setImageSandboxOpen(false);
    }
  }, [imageSandboxOpen]);

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

  // Keyboard inset only - TTS bar is handled within ChatView
  const totalBottomInset = keyboardInset || 0;

  return (
    <div className="flex h-full overflow-hidden relative" style={totalBottomInset ? { paddingBottom: totalBottomInset } : undefined}>
      {settings.backgroundEffect === "ripple-grid" && (
        <Suspense fallback={null}>
          <RippleGridBackground />
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
        onOpenSettings={handleOpenSettings}
        onOpenImageSandbox={handleOpenImageSandbox}
        isOpen={sidebarOpen}
        onClose={handleCloseSidebar}
        isStreaming={streaming}
        hasUnreadNotebooks={hasUnreadAgentEntries()}
        ttsBarVisible={playbackState.isPlaying || playbackState.isPaused || playbackState.isLoading}
      />
      {sidebarOpen && (
        <div className="fixed inset-0 z-20 bg-black/50 md:hidden" onClick={handleCloseSidebar} />
      )}
      {imageSandboxOpen ? (
        <ImageSandbox
          models={models}
          defaultModelId={activeChat?.modelId || settings.defaultModelId || models[0]?.id || ""}
          defaultVisionModelId={settings.defaultVisionModelId}
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
          onTriggerAgentReview={async () => { return await triggerAgentReview(); }}
          chats={chats}
          onChatSelect={(chatId) => { selectChat(chatId); setActiveView('chats'); setImageSandboxOpen(false); }}
          onVisible={markAgentEntriesSeen}
          onOpenSidebar={() => setSidebarOpen(true)}
        />
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
        compacting={compacting}
        compaction={compaction}
        contextWindow={contextWindow}
        error={error}
        warning={warning}
        models={models}
        selectedModelId={activeChat?.modelId || models[0]?.id || ""}
        systemPrompt={activeChat?.systemPrompt || "You are a helpful assistant."}
        systemPromptPresets={settings.systemPromptPresets}
        ttsAutoReadEnabled={playbackState.isPlaying || playbackState.isPaused}
        playbackState={playbackState}
        ttsBarVisible={playbackState.isPlaying || playbackState.isPaused || playbackState.isLoading}
        onTtsAutoReadToggle={(enabled) => {
          if (enabled) {
            const lastAssistantMsg = [...messages].reverse().find(m => m.role === "assistant" && m.content);
            if (lastAssistantMsg) {
              playTts(lastAssistantMsg.content);
            }
          } else {
            stopTts();
          }
        }}
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
        activeSkills={activeChat?.activeSkills}
        projectId={activeChat?.projectId}
        streamingSegmentIndex={streamingSegmentIndex}
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
      {(playbackState.isPlaying || playbackState.isPaused || playbackState.isLoading) && (
        <div className="fixed bottom-0 left-0 right-0 z-40">
          <TTSControlBar
            playbackState={playbackState}
            onPause={() => pauseTts()}
            onResume={() => {
              if (lastMessageRef.current) {
                const lastMsg = messages[messages.length - 1];
                if (lastMsg) playTts(lastMsg.content);
              }
            }}
            onStop={() => stopTts()}
          />
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
