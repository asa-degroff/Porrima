import { useState, useCallback } from "react";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { useChats } from "./hooks/useChats";
import { useChat } from "./hooks/useChat";
import { useModels } from "./hooks/useModels";
import { updateChat as apiUpdateChat } from "./api/client";
import type { Chat } from "./types";

export default function App() {
  const { models } = useModels();
  const { chats, createChat, removeChat, refresh } = useChats();
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const { messages, streaming, error, send, abort, loadMessages } =
    useChat(activeChatId);

  // Fetch full chat when selecting one (we need messages)
  const selectChat = useCallback(
    async (id: string) => {
      setActiveChatId(id);
      try {
        // Fetch full chat data including messages via GET /api/chats/:id
        // Since we don't have this route, let's add logic to get it
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

  const handleNewChat = useCallback(async () => {
    const defaultModel = models[0]?.id || "qwen3:8b";
    const chat = await createChat(defaultModel);
    setActiveChatId(chat.id);
    setActiveChat(chat);
    loadMessages([]);
  }, [models, createChat, loadMessages]);

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

  return (
    <div className="flex h-screen">
      <Sidebar
        chats={chats}
        activeChatId={activeChatId}
        onSelectChat={selectChat}
        onNewChat={handleNewChat}
        onDeleteChat={handleDeleteChat}
      />
      <ChatView
        chatId={activeChatId}
        chatTitle={activeChat?.title || "New Chat"}
        messages={messages}
        streaming={streaming}
        error={error}
        models={models}
        selectedModelId={activeChat?.modelId || models[0]?.id || ""}
        onSend={handleSend}
        onAbort={abort}
        onModelChange={handleModelChange}
      />
    </div>
  );
}
