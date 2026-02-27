import { useState, useCallback, useMemo } from "react";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { SettingsModal } from "./components/SettingsModal";
import { useChats } from "./hooks/useChats";
import { useChat } from "./hooks/useChat";
import { useModels } from "./hooks/useModels";
import { useSettings } from "./hooks/useSettings";
import { updateChat as apiUpdateChat } from "./api/client";
import type { Chat, ChatType } from "./types";

export default function App() {
  const { models } = useModels();
  const { chats, createChat, removeChat, refresh } = useChats();
  const { settings, updateSettings } = useSettings();
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
    abort,
    loadMessages,
  } = useChat(activeChatId);

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
        const res = await fetch(`/api/chats/${id}`);
        if (res.ok) {
          const chat: Chat = await res.json();
          setActiveChat(chat);
          loadMessages(chat.messages);
        }
      } catch {
        // fallback
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
    (text: string) => {
      send(text);
      // Refresh chat list after a short delay to pick up title changes
      setTimeout(() => refresh(), 500);
      setTimeout(() => refresh(), 2000);
    },
    [send, refresh]
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
    <div className="flex h-screen">
      <Sidebar
        chats={chats}
        activeChatId={activeChatId}
        onSelectChat={selectChat}
        onNewChat={handleNewChat}
        onDeleteChat={handleDeleteChat}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <ChatView
        chatId={activeChatId}
        chatTitle={activeChat?.title || "New Chat"}
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
        />
      )}
    </div>
  );
}
