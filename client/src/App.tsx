import { useState, useCallback, useMemo, useEffect } from "react";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { SettingsModal } from "./components/SettingsModal";
import { LoginPage } from "./components/LoginPage";
import { RippleGridBackground } from "./components/RippleGridBackground";
import { useChats } from "./hooks/useChats";
import { useChat } from "./hooks/useChat";
import { useModels } from "./hooks/useModels";
import { useSettings } from "./hooks/useSettings";
import { useAuth } from "./hooks/useAuth";
import { updateChat as apiUpdateChat } from "./api/client";
import type { Chat, ChatType } from "./types";

function AuthenticatedApp({ onLogout }: { onLogout: () => void }) {
  const { models } = useModels();
  const { chats, createChat, removeChat, refresh } = useChats();
  const { settings, updateSettings } = useSettings();
  const [activeChatId, setActiveChatId] = useState<string | null>(() => {
    return sessionStorage.getItem("activeChatId");
  });
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const {
    messages,
    streaming,
    streamingThinking,
    activeTools,
    artifacts,
    waitingForInput,
    totalUsage,
    error,
    send,
    editMessage,
    abort,
    loadMessages,
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

  // Find context window for active model (chat override takes precedence)
  const contextWindow = useMemo(() => {
    if (activeChat?.contextWindow) return activeChat.contextWindow;
    const model = models.find((m) => m.id === activeChat?.modelId);
    return model?.contextWindow || 32768;
  }, [models, activeChat]);

  // Fetch full chat when selecting one (we need messages)
  const selectChat = useCallback(
    async (id: string) => {
      setActiveChatId(id);
      try {
        const res = await fetch(`/api/chats/${id}`, { credentials: "include" });
        if (res.ok) {
          const chat: Chat = await res.json();
          setActiveChat(chat);
          loadMessages(chat.messages);
        } else {
          setActiveChatId(null);
          setActiveChat(null);
        }
      } catch {
        setActiveChatId(null);
        setActiveChat(null);
      }
    },
    [loadMessages]
  );

  const handleNewChat = useCallback(async (type: ChatType = "quick") => {
    const modelId = settings.defaultModelId || models[0]?.id || "qwen3:8b";
    const chat = await createChat(modelId, type);
    setActiveChatId(chat.id);
    setActiveChat(chat);
    loadMessages([]);
  }, [settings.defaultModelId, models, createChat, loadMessages]);

  const handleDeleteChat = useCallback(
    async (id: string) => {
      await removeChat(id);
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

  const handleModelChange = useCallback(
    async (modelId: string) => {
      if (!activeChatId || !activeChat) return;
      await apiUpdateChat(activeChatId, { modelId });
      setActiveChat((prev) => (prev ? { ...prev, modelId } : prev));
    },
    [activeChatId, activeChat]
  );

  const handleSystemPromptChange = useCallback(
    async (systemPrompt: string) => {
      if (!activeChatId || !activeChat) return;
      await apiUpdateChat(activeChatId, { systemPrompt });
      setActiveChat((prev) => (prev ? { ...prev, systemPrompt } : prev));
    },
    [activeChatId, activeChat]
  );

  const handleContextWindowChange = useCallback(
    async (value: number | null) => {
      if (!activeChatId || !activeChat) return;
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
    [activeChatId, activeChat]
  );

  // Model default context window (for reset-to-default in editor)
  const modelContextWindow = useMemo(() => {
    const model = models.find((m) => m.id === activeChat?.modelId);
    return model?.contextWindow || 32768;
  }, [models, activeChat?.modelId]);

  return (
    <div className="flex h-screen overflow-hidden relative">
      {settings.theme === "ripple-grid" && <RippleGridBackground />}
      <Sidebar
        chats={chats}
        activeChatId={activeChatId}
        onSelectChat={selectChat}
        onNewChat={handleNewChat}
        onDeleteChat={handleDeleteChat}
        onOpenSettings={() => setSettingsOpen(true)}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      {sidebarOpen && (
        <div className="fixed inset-0 z-20 bg-black/50 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}
      <ChatView
        chatId={activeChatId}
        chatTitle={activeChat?.title || "New Chat"}
        onOpenSidebar={() => setSidebarOpen(true)}
        messages={messages}
        streaming={streaming}
        streamingThinking={streamingThinking}
        activeTools={activeTools}
        artifacts={artifacts}
        totalUsage={totalUsage}
        contextWindow={contextWindow}
        error={error}
        models={models}
        selectedModelId={activeChat?.modelId || models[0]?.id || ""}
        systemPrompt={activeChat?.systemPrompt || "You are a helpful assistant."}
        onSend={handleSend}
        onEditMessage={handleEditMessage}
        onAbort={abort}
        onModelChange={handleModelChange}
        onSystemPromptChange={handleSystemPromptChange}
        onContextWindowChange={handleContextWindowChange}
        modelContextWindow={modelContextWindow}
        hasContextWindowOverride={activeChat?.contextWindow != null}
        waitingForInput={waitingForInput}
      />
      {settingsOpen && (
        <SettingsModal
          settings={settings}
          models={models}
          onSave={async (s) => {
            await updateSettings(s);
            setSettingsOpen(false);
          }}
          onClose={() => setSettingsOpen(false)}
          onLogout={onLogout}
        />
      )}
    </div>
  );
}

export default function App() {
  const { authState, error, register, login, logout } = useAuth();

  if (authState === "loading") {
    return (
      <div className="flex items-center justify-center h-screen">
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

  return <AuthenticatedApp onLogout={logout} />;
}
