import { useEffect, useState, useCallback, useRef } from "react";
import { ChatView } from "./ChatView";
import { useChat } from "../hooks/useChat";
import { useModels } from "../hooks/useModels";
import { useSettings } from "../hooks/useSettings";
import { useTTS } from "../hooks/useTTS";
import { fetchChat as apiFetchChat } from "../api/client";
import type { Chat } from "../types";

const DIRECTIONS_PROJECT_ID = "creative-engine-directions";

export function DirectionsChat() {
  const { models } = useModels();
  const { settings, updateSettings } = useSettings();
  const { settings: ttsSettings, playbackState, updateSettings: updateTtsSettings } = useTTS();
  const [chat, setChat] = useState<Chat | null>(null);
  const [loading, setLoading] = useState(true);
  const creatingRef = useRef(false);

  const {
    messages,
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
    compacting,
    compaction,
    error,
    warning,
    streamingSegmentIndex,
    hasBackgroundActivity,
    send,
    editMessage,
    abort,
    loadMessages,
    setActiveChatData,
    processQueue,
    queueProcessing,
    titleUpdate,
    hasCompactionSummary,
  } = useChat(chat?.id ?? null);

  // Find or create the directions chat on mount
  useEffect(() => {
    if (chat || creatingRef.current || !models.length) return;

    const initChat = async () => {
      creatingRef.current = true;
      try {
        // Fetch all chats and look for one with our projectId
        const response = await fetch("/api/chats", { credentials: "include" });
        if (!response.ok) throw new Error("Failed to fetch chats");
        const chats = await response.json();
        
        const existingChat = chats.find((c: Chat) => c.projectId === DIRECTIONS_PROJECT_ID);
        
        if (existingChat) {
          // Load existing chat
          const chatData = await apiFetchChat(existingChat.id);
          if (chatData) {
            setChat(chatData);
            loadMessages(chatData.messages);
            setActiveChatData(chatData);
          }
        } else {
          // Create new chat for the project
          const defaultModel = settings.defaultModelId || models[0]?.id || "llama3.2:3b";
          const res = await fetch("/api/chats", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: crypto.randomUUID(),
              modelId: defaultModel,
              type: "agent",
              projectId: DIRECTIONS_PROJECT_ID,
            }),
          });
          if (!res.ok) throw new Error("Failed to create chat");
          const newChat = await res.json();
          setChat(newChat);
          setActiveChatData(newChat);
        }
      } catch (err) {
        console.error("Failed to initialize directions chat:", err);
      } finally {
        creatingRef.current = false;
        setLoading(false);
      }
    };

    initChat();
  }, [models.length, settings.defaultModelId]);

  // Update chat reference when it changes
  useEffect(() => {
    if (chat) {
      setActiveChatData(chat);
    }
  }, [chat, setActiveChatData]);

  const handleModelChange = useCallback((modelId: string) => {
    if (!chat) return;
    fetch(`/api/chats/${chat.id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId }),
    }).catch(console.error);
  }, [chat]);

  const handleSystemPromptChange = useCallback((value: string) => {
    if (!chat) return;
    setChat((prev) => prev ? { ...prev, systemPrompt: value } : null);
  }, []);

  const handleContextWindowChange = useCallback((value: number | null) => {
    if (!chat) return;
    setChat((prev) => prev ? { ...prev, contextWindow: value ?? undefined } : null);
  }, [chat]);

  const handleTtsAutoReadToggle = useCallback((enabled: boolean) => {
    updateTtsSettings({ autoReadEnabled: enabled });
  }, [updateTtsSettings]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-white/30">
        <div className="text-center space-y-2">
          <div className="w-8 h-8 border-2 border-white/20 border-t-white/60 rounded-full animate-spin mx-auto" />
          <p className="text-sm">Loading creative directions...</p>
        </div>
      </div>
    );
  }

  if (!chat) {
    return (
      <div className="flex-1 flex items-center justify-center text-white/30">
        <div className="text-center space-y-2">
          <p className="text-sm">Failed to load directions chat</p>
        </div>
      </div>
    );
  }

  return (
    <ChatView
      chatId={chat.id}
      chatTitle="Creative Directions"
      messages={messages}
      streaming={streaming}
      streamingThinking={streamingThinking}
      streamingThinkingActive={streamingThinkingActive}
      streamingThinkingAccumulatedMs={streamingThinkingAccumulatedMs}
      streamingThinkingLastStartRef={streamingThinkingLastStartRef}
      activeTools={activeTools}
      artifacts={artifacts}
      generatedImages={generatedImages}
      totalUsage={totalUsage}
      compacting={compacting}
      compaction={compaction}
      hasCompactionSummary={hasCompactionSummary}
      contextWindow={chat.contextWindow || models.find((m) => m.id === chat.modelId)?.contextWindow || 32768}
      error={error}
      warning={warning}
      models={models}
      selectedModelId={chat.modelId}
      systemPrompt={chat.systemPrompt}
      systemPromptPresets={settings.systemPromptPresets}
      chatType={chat.type}
      ttsAutoReadEnabled={ttsSettings.autoReadEnabled}
      onTtsAutoReadToggle={handleTtsAutoReadToggle}
      playbackState={playbackState}
      ttsBarVisible={ttsSettings.enabled}
      waitingForInput={waitingForInput}
      streamingSegmentIndex={streamingSegmentIndex}
      onSend={send}
      onEditMessage={editMessage}
      onAbort={abort}
      onModelChange={handleModelChange}
      onSystemPromptChange={handleSystemPromptChange}
      onContextWindowChange={handleContextWindowChange}
      modelContextWindow={4096}
      hasContextWindowOverride={false}
      onOpenSidebar={() => {}}
      isOnline={navigator.onLine}
      queueProcessing={queueProcessing}
      projectId={chat.projectId}
      activeSkills={chat.activeSkills}
    />
  );
}
