import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { sendMessage, editMessage as apiEditMessage, enqueueMessage as apiEnqueueMessage, stopChat as apiStopChat, fetchChat as apiFetchChat, fetchChatMessages, getChatStatus, reconnectChat } from "../api/client";
import type { StreamCallbacks, ToolStatus, StreamWarning } from "../api/client";
import type { Artifact, ChatMessage, GeneratedImage, ImageAttachment, InlineVisual, MessageSegment, MessageUsage } from "../types";
import { useStreamingTTS } from "./useStreamingTTS";
import {
  enqueueMessage,
  dequeueMessage,
  getQueuedMessagesForChat,
  setCachedChat,
} from "../lib/db";
import type { Chat } from "../types";

/** Per-chat streaming state stored when the chat is not actively displayed */
interface BackgroundStream {
  content: string;
  thinking: string;
  tools: ToolStatus[];
  artifacts: Artifact[];
  visuals: InlineVisual[];
  generatedImages: GeneratedImage[];
  messages: ChatMessage[];
  streaming: boolean;
  waitingForInput: boolean;
  error: string | null;
  warning: StreamWarning | null;
  compacting: boolean;
  compaction: CompactionInfo | null;
  doneCalled: boolean;
  abortController: AbortController | null;
  chatRef: Chat | null;
  messageOffset: number;
  messageTotal: number;
  /** Client-side segments built during streaming for interleaved rendering */
  segments: MessageSegment[];
  seqCounter: number;
  /** Thinking duration tracking */
  thinkingActive: boolean;
  thinkingAccumulatedMs: number;
  thinkingLastStart: number;
}

/** Module-level store — survives hook re-renders and chat switches */
const bgStreams = new Map<string, BackgroundStream>();

/** Per-chat draft state stored when user is typing a message */
interface Draft {
  text: string;
  images: ImageAttachment[];
}

type CompactionPhase = "pre_send" | "mid_turn" | "end_turn" | "manual";

interface CompactionInfo {
  removedCount: number;
  remainingCount: number;
  summaryMessage?: ChatMessage | null;
  phase?: CompactionPhase;
  continues?: boolean;
  midTurn?: boolean;
  cycle?: number;
  estimatedTokens?: number;
}

const drafts = new Map<string, Draft>();
const MESSAGE_PAGE_SIZE = 200;

/** Check if a chat has an active or completed background stream */
export function hasBackgroundStream(chatId: string): boolean {
  return bgStreams.has(chatId);
}

/** Get draft for a chat */
export function getDraft(chatId: string): Draft | undefined {
  return drafts.get(chatId);
}

/** Set draft for a chat */
export function setDraft(chatId: string, text: string, images: ImageAttachment[]): void {
  drafts.set(chatId, { text, images });
}

/** Clear draft for a chat */
export function clearDraft(chatId: string): void {
  drafts.delete(chatId);
}

/** Get chat IDs with active (still streaming) background streams */
export function getStreamingChatIds(): string[] {
  return Array.from(bgStreams.entries())
    .filter(([, bg]) => bg.streaming)
    .map(([id]) => id);
}

function createBgStream(chatRef: Chat | null, messageOffset = chatRef?.messageOffset ?? 0, messageTotal = chatRef?.messageTotal ?? chatRef?.messages?.length ?? 0): BackgroundStream {
  return {
    content: "",
    thinking: "",
    tools: [],
    artifacts: [],
    visuals: [],
    generatedImages: [],
    messages: [],
    streaming: true,
    waitingForInput: false,
    error: null,
    warning: null,
    compacting: false,
    compaction: null,
    doneCalled: false,
    abortController: null,
    chatRef,
    messageOffset,
    messageTotal,
    segments: [],
    seqCounter: 0,
    thinkingActive: false,
    thinkingAccumulatedMs: 0,
    thinkingLastStart: 0,
  };
}

function cloneMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => ({
    ...m,
    images: m.images ? m.images.map((img) => ({ ...img })) : undefined,
    toolCalls: m.toolCalls ? m.toolCalls.map((tc) => ({ ...tc, arguments: { ...(tc.arguments ?? {}) } })) : undefined,
    toolResults: m.toolResults ? m.toolResults.map((tr) => ({ ...tr })) : undefined,
    artifacts: m.artifacts ? m.artifacts.map((artifact) => ({ ...artifact })) : undefined,
    generatedImages: m.generatedImages ? m.generatedImages.map((image) => ({ ...image })) : undefined,
    visuals: m.visuals ? m.visuals.map((visual) => ({ ...visual })) : undefined,
    segments: m.segments ? m.segments.map((segment) => ({ ...segment })) : undefined,
  }));
}

function makeAssistantPlaceholder(bg: BackgroundStream): ChatMessage {
  return {
    role: "assistant",
    content: bg.content,
    thinking: bg.thinking || undefined,
    thinkingDurationMs: bg.thinkingAccumulatedMs || undefined,
    timestamp: Date.now(),
    segments: bg.segments.length ? bg.segments.map((s) => ({ ...s })) : undefined,
  };
}

function withLiveAssistant(messages: ChatMessage[], bg: BackgroundStream): ChatMessage[] {
  const next = cloneMessages(messages);
  const last = next[next.length - 1];
  const liveAssistant = makeAssistantPlaceholder(bg);

  if (last?.role === "assistant" && !last._isCompactionSummary) {
    next[next.length - 1] = {
      ...last,
      ...liveAssistant,
      timestamp: last.timestamp || liveAssistant.timestamp,
      _inProgress: last._inProgress,
      _isSystemMessage: last._isSystemMessage,
    };
  } else {
    next.push(liveAssistant);
  }

  return next;
}

export function useChat(chatId: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messageOffset, setMessageOffset] = useState(0);
  const [messageTotal, setMessageTotal] = useState(0);
  const [olderMessagesLoading, setOlderMessagesLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [streamingThinking, setStreamingThinking] = useState("");
  const [streamingThinkingActive, setStreamingThinkingActive] = useState(false);
  const [streamingThinkingAccumulatedMs, setStreamingThinkingAccumulatedMs] = useState(0);
  const streamingThinkingLastStartRef = useRef(0);
  const [activeTools, setActiveTools] = useState<ToolStatus[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [generatedImages, setGeneratedImages] = useState<GeneratedImage[]>([]);
  const [waitingForInput, setWaitingForInput] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<StreamWarning | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [compaction, setCompaction] = useState<CompactionInfo | null>(null);
  // Provisional token count from the most recent compaction event — used to
  // show an accurate (if approximate) context size between compaction and the
  // next assistant's real usage, so the indicator never reverts to
  // "context reset" while the chat still holds meaningful context.
  const [postCompactionEstimate, setPostCompactionEstimate] = useState<number | null>(null);
  const [queueProcessing, setQueueProcessing] = useState(false);
  const [titleUpdate, setTitleUpdate] = useState<{ chatId: string; title: string } | null>(null);
  const [streamingSegmentIndex, setStreamingSegmentIndex] = useState<number | null>(null);
  const [streamingUsage, setStreamingUsage] = useState<MessageUsage | null>(null);
  // Separate from streamingUsage because the server-side estimate reflects the
  // NEXT call's input (includes accumulated tool results), not the last call's
  // reported usage. When the estimate exceeds reported usage, we show it as a
  // provisional ~N / max in the indicator so the user sees the payload the
  // next iteration will actually send.
  const [streamingEstimate, setStreamingEstimate] = useState<number | null>(null);
  const [hasBackgroundActivity, setHasBackgroundActivity] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const doneCalledRef = useRef(false);
  const streamingContentRef = useRef("");
  const rafRef = useRef<number | null>(null);
  const activeChatRef = useRef<Chat | null>(null);
  const messageOffsetRef = useRef(0);
  const messageTotalRef = useRef(0);
  const olderMessagesLoadingRef = useRef(false);

  messageOffsetRef.current = messageOffset;
  messageTotalRef.current = messageTotal;

  /** Always reflects the currently displayed chatId */
  const activeChatIdRef = useRef<string | null>(chatId);
  activeChatIdRef.current = chatId;

  // Restore or reset streaming state when switching chats
  // IMPORTANT: Only depends on chatId to avoid race conditions with stale messages state
  useEffect(() => {
    // Cancel any pending rAF flush from previous chat's stream
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    const bg = chatId ? bgStreams.get(chatId) : undefined;
    if (bg) {
      // Sync accumulated segments to the last assistant message before restoring,
      // since the rAF flush that would normally do this was cancelled above
      if (bg.streaming || bg.segments.length > 0) {
        const last = bg.messages[bg.messages.length - 1];
        if (last?.role === "assistant") {
          last.content = bg.content;
          last.segments = bg.segments.map(s => ({ ...s }));
        }
      }
      // Restore streaming state from background (chat was switched away from mid-stream)
      setMessages([...bg.messages]);
      setMessageOffset(bg.messageOffset);
      setMessageTotal(Math.max(bg.messageTotal, bg.messageOffset + bg.messages.length));
      setOlderMessagesLoading(false);
      setStreaming(bg.streaming);
      streamingContentRef.current = bg.content;
      setStreamingThinking(bg.thinking);
      setStreamingThinkingActive(bg.thinkingActive);
      setStreamingThinkingAccumulatedMs(bg.thinkingAccumulatedMs);
      streamingThinkingLastStartRef.current = bg.thinkingActive ? bg.thinkingLastStart : 0;
      setActiveTools([...bg.tools]);
      setArtifacts([...bg.artifacts]);
      setGeneratedImages([...bg.generatedImages]);
      setWaitingForInput(bg.waitingForInput);
      setError(bg.error);
      setWarning(bg.warning);
      setCompacting(bg.compacting);
      setCompaction(bg.compaction);
      doneCalledRef.current = bg.doneCalled;
      abortRef.current = bg.abortController;

      if (!bg.streaming && bg.doneCalled) {
        // Stream fully finished while in background — clean up entry
        bgStreams.delete(chatId!);
        setStreamingSegmentIndex(null);
      }
    } else {
      // No background stream — fresh reset for new chat
      // In-progress state from persistence is handled by App.tsx selectChat logic
      // which checks for _inProgress flag before calling loadMessages
      setStreaming(false);
      setOlderMessagesLoading(false);
      setStreamingThinking("");
      setStreamingThinkingActive(false);
      setStreamingThinkingAccumulatedMs(0);
      streamingThinkingLastStartRef.current = 0;
      setActiveTools([]);
      setArtifacts([]);
      setGeneratedImages([]);
      setWaitingForInput(false);
      setError(null);
      setWarning(null);
      setCompacting(false);
      setCompaction(null);
      setPostCompactionEstimate(null);
      setStreamingSegmentIndex(null);
      setStreamingUsage(null);
      setStreamingEstimate(null);
    }
  }, [chatId]);

  // Reconnect to a server-side in-flight stream. Runs after the chat-switch
  // effect resets state. If the server reports an active stream for this chat
  // and nothing is tracked locally, attach via the reconnect endpoint — the
  // server replays buffered SSE events then continues live.
  useEffect(() => {
    if (!chatId) return;
    if (bgStreams.has(chatId)) return;

    let cancelled = false;
    (async () => {
      const status = await getChatStatus(chatId);
      if (cancelled) return;
      if (!status.active) return;
      // Chat may have switched away during the async check.
      if (chatId !== activeChatIdRef.current) return;
      if (bgStreams.has(chatId)) return;

      console.log(`[chat] reconnecting to in-flight stream for ${chatId} (${status.bufferedChunks} buffered chunks)`);
      let serverChat: Chat | null = null;
      try {
        serverChat = await apiFetchChat(chatId);
      } catch {
        serverChat = activeChatRef.current?.id === chatId ? activeChatRef.current : null;
      }
      if (cancelled) return;
      if (chatId !== activeChatIdRef.current) return;
      if (bgStreams.has(chatId)) return;

      const bg = createBgStream(serverChat ?? activeChatRef.current);
      bg.messages = withLiveAssistant(serverChat?.messages ?? activeChatRef.current?.messages ?? [], bg);
      bgStreams.set(chatId, bg);
      prepareStream();
      setMessages([...bg.messages]);
      setStreaming(true);
      if (serverChat) setActiveChatData(serverChat);

      const callbacks = makeStreamCallbacks(chatId);
      const controller = reconnectChat(chatId, callbacks);
      bg.abortController = controller;
      abortRef.current = controller;
    })();

    return () => {
      cancelled = true;
    };
    // makeStreamCallbacks/prepareStream are stable via useCallback; chatId is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  const loadMessages = useCallback((
    msgs: ChatMessage[],
    window?: { offset?: number; total?: number }
  ) => {
    setMessages(msgs);
    const offset = window?.offset ?? 0;
    setMessageOffset(offset);
    setMessageTotal(window?.total ?? offset + msgs.length);
  }, []);

  const loadOlderMessages = useCallback(async () => {
    const targetChatId = activeChatIdRef.current;
    const before = messageOffsetRef.current;
    if (!targetChatId || before <= 0 || olderMessagesLoadingRef.current) return false;

    olderMessagesLoadingRef.current = true;
    setOlderMessagesLoading(true);
    try {
      const page = await fetchChatMessages(targetChatId, {
        before,
        limit: MESSAGE_PAGE_SIZE,
      });
      if (activeChatIdRef.current !== targetChatId) return false;

      setMessages((prev) => {
        const overlap = Math.max(0, page.offset + page.messages.length - before);
        const prepend = overlap > 0 ? page.messages.slice(0, page.messages.length - overlap) : page.messages;
        return [...prepend, ...prev];
      });
      setMessageOffset(page.offset);
      setMessageTotal(page.total);
      return page.messages.length > 0;
    } finally {
      olderMessagesLoadingRef.current = false;
      if (activeChatIdRef.current === targetChatId) {
        setOlderMessagesLoading(false);
      }
    }
  }, []);

  // Store active chat reference for IDB caching
  const setActiveChatData = useCallback((chat: Chat | null) => {
    activeChatRef.current = chat;
    // Keep bgStream's chatRef up-to-date with latest metadata
    if (chat && bgStreams.has(chat.id)) {
      bgStreams.get(chat.id)!.chatRef = chat;
    }
  }, []);

  // Flush accumulated streaming content + segments to React state (batched per frame)
  const flushStreamingContent = useCallback(() => {
    const content = streamingContentRef.current;
    const chatId = activeChatIdRef.current;
    const bg = chatId ? bgStreams.get(chatId) : undefined;
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      // Skip flushing onto a steering placeholder — those deltas belong to the
      // previous turn and will be finalized via message_complete.
      if (last?.role === "assistant" && !last._steeringPending) {
        const segments = bg && bg.segments.length > 0 ? bg.segments.map(s => ({ ...s })) : undefined;
        const updated = prev.slice(0, -1);
        updated.push({ ...last, content, segments });
        return updated;
      }
      return prev;
    });
    rafRef.current = null;
  }, []);

  // Create chat-aware SSE callbacks that route to the correct bgStream
  const makeStreamCallbacks = useCallback(
    (streamChatId: string, onDoneExtra?: (msgs: ChatMessage[]) => void): StreamCallbacks => ({
      onDelta: (delta) => {
        const bg = bgStreams.get(streamChatId);
        if (!bg) return;
        if (bg.compacting) {
          bg.compacting = false;
          if (activeChatIdRef.current === streamChatId) setCompacting(false);
        }

        // Pause thinking timer on text output
        if (bg.thinkingActive) {
          bg.thinkingAccumulatedMs += Date.now() - bg.thinkingLastStart;
          bg.thinkingActive = false;
          if (activeChatIdRef.current === streamChatId) {
            setStreamingThinkingAccumulatedMs(bg.thinkingAccumulatedMs);
            setStreamingThinkingActive(false);
            streamingThinkingLastStartRef.current = 0;
          }
        }

        bg.content += delta;

        // Build streaming segments: append to current text segment or start a new one
        const lastSeg = bg.segments[bg.segments.length - 1];
        if (lastSeg?.type === "text") {
          lastSeg.content = (lastSeg.content || "") + delta;
        } else {
          bg.segments.push({ seq: bg.seqCounter++, type: "text", content: delta });
        }

        // Update last message in bgStream — but not a steering placeholder,
        // since these deltas belong to the pre-steering generation.
        const last = bg.messages[bg.messages.length - 1];
        if (last?.role === "assistant" && !last._steeringPending) {
          bg.messages[bg.messages.length - 1] = { ...last, content: bg.content };
        }

        // Sync to React state only if this stream is currently displayed
        if (activeChatIdRef.current === streamChatId) {
          streamingContentRef.current = bg.content;
          if (rafRef.current === null) {
            rafRef.current = requestAnimationFrame(flushStreamingContent);
          }
        }
      },
      onThinkingDelta: (delta) => {
        const bg = bgStreams.get(streamChatId);
        if (!bg) return;
        if (bg.compacting) {
          bg.compacting = false;
          if (activeChatIdRef.current === streamChatId) setCompacting(false);
        }
        bg.thinking += delta;

        // Start thinking timer if not already active
        if (!bg.thinkingActive) {
          bg.thinkingActive = true;
          bg.thinkingLastStart = Date.now();
        }

        if (activeChatIdRef.current === streamChatId) {
          setStreamingThinking(bg.thinking);
          if (!streamingThinkingLastStartRef.current) {
            streamingThinkingLastStartRef.current = bg.thinkingLastStart;
            setStreamingThinkingActive(true);
          }
        }
      },
      onGeneratedImage: (image) => {
        const bg = bgStreams.get(streamChatId);
        if (!bg) return;
        bg.generatedImages.push(image);

        // Add generated image segment
        bg.segments.push({ seq: bg.seqCounter++, type: "generated_image", generatedImage: image });

        if (activeChatIdRef.current === streamChatId) {
          setGeneratedImages([...bg.generatedImages]);
          // Generated image segments indicate text is complete
          setStreamingSegmentIndex(null);
          // Schedule segment flush
          if (rafRef.current === null) {
            streamingContentRef.current = bg.content;
            rafRef.current = requestAnimationFrame(flushStreamingContent);
          }
        }
      },
      onVisual: (visual) => {
        const bg = bgStreams.get(streamChatId);
        if (!bg) return;
        bg.visuals.push(visual);

        // Add visual segment
        bg.segments.push({ seq: bg.seqCounter++, type: "visual", visual });

        if (activeChatIdRef.current === streamChatId) {
          // Visual segments indicate text is complete
          setStreamingSegmentIndex(null);
          // Schedule segment flush
          if (rafRef.current === null) {
            streamingContentRef.current = bg.content;
            rafRef.current = requestAnimationFrame(flushStreamingContent);
          }
        }
      },
      onDone: ({ content: serverContent, thinking, thinkingDurationMs, usage, artifacts: doneArtifacts, generatedImages: doneImages, visuals: doneVisuals, toolCalls, toolResults, segments, waitingForInput: wfi, thinkingPromoted, recap }) => {
        const bg = bgStreams.get(streamChatId);
        if (!bg || bg.doneCalled) return;
        bg.doneCalled = true;
        bg.streaming = false;

        // If the server finalized with longer content than we streamed (e.g.
        // reasoning model emitted thinking only and the server promoted it to
        // content), trust the server's message over our local accumulator —
        // otherwise the user has to refresh to see the response.
        const finalContent =
          typeof serverContent === "string" && serverContent.length > bg.content.length
            ? serverContent
            : bg.content;
        if (finalContent !== bg.content) {
          bg.content = finalContent;
          if (activeChatIdRef.current === streamChatId) {
            streamingContentRef.current = finalContent;
          }
        }

        const finalSegments = segments || (bg.segments.length > 0 ? bg.segments.map((s) => ({ ...s })) : undefined);

        // Finalize last message with full metadata
        const last = bg.messages[bg.messages.length - 1];
        if (last?.role === "assistant") {
          bg.messages[bg.messages.length - 1] = {
            ...last,
            content: finalContent,
            thinking: thinkingPromoted ? undefined : (thinking || undefined),
            thinkingDurationMs: thinkingDurationMs || undefined,
            usage: usage || undefined,
            artifacts: doneArtifacts || undefined,
            generatedImages: doneImages || undefined,
            visuals: doneVisuals || undefined,
            toolCalls: toolCalls || undefined,
            toolResults: toolResults || undefined,
            segments: finalSegments,
            recap: recap || undefined,
          };
        }

        if (wfi) bg.waitingForInput = true;

        const isActive = activeChatIdRef.current === streamChatId;
        const finalMsgs = [...bg.messages];

        if (isActive) {
          // Active chat — sync to React state
          if (rafRef.current !== null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
          }
          setMessages(finalMsgs);
          setStreamingThinking("");
          setStreamingThinkingActive(false);
          setStreamingThinkingAccumulatedMs(0);
          streamingThinkingLastStartRef.current = 0;
          setStreaming(false);
          setStreamingSegmentIndex(null);
          setStreamingUsage(null);
          setStreamingEstimate(null);
          setMessageTotal((prev) => Math.max(prev, messageOffsetRef.current + finalMsgs.length));
          if (wfi) setWaitingForInput(true);
          bgStreams.delete(streamChatId);
        }

        // Update IDB cache (both active and background)
        const chatObj = isActive ? activeChatRef.current : bg.chatRef;
        if (chatObj) {
          const offset = isActive ? messageOffsetRef.current : bg.messageOffset;
          const total = Math.max(
            isActive ? messageTotalRef.current : bg.messageTotal,
            offset + finalMsgs.length
          );
          setCachedChat({
            ...chatObj,
            messages: finalMsgs,
            messageOffset: offset,
            messageTotal: total,
            hasMoreMessages: offset > 0,
          }).catch(() => {});
        }

        onDoneExtra?.(finalMsgs);
      },
      onToolStatus: (status) => {
        const bg = bgStreams.get(streamChatId);
        if (!bg) return;

        // Pause thinking timer on tool execution
        if (bg.thinkingActive) {
          bg.thinkingAccumulatedMs += Date.now() - bg.thinkingLastStart;
          bg.thinkingActive = false;
          if (activeChatIdRef.current === streamChatId) {
            setStreamingThinkingAccumulatedMs(bg.thinkingAccumulatedMs);
            setStreamingThinkingActive(false);
            streamingThinkingLastStartRef.current = 0;
          }
        }
        const existingIdx = bg.tools.findIndex(
          (t) => t.name === status.name && t.status === "running"
        );
        
        if (existingIdx >= 0 && status.status !== "running") {
          bg.tools[existingIdx] = status;
        } else if (status.status === "running") {
          bg.tools.push(status);
        }

        if (activeChatIdRef.current === streamChatId) {
          setActiveTools([...bg.tools]);
        }
      },
      onSegment: (segment) => {
        const bg = bgStreams.get(streamChatId);
        if (!bg) return;

        // For tool_result, insert immediately after its matching tool_call
        // so visual/artifact segments stay in the right position
        if (segment.type === "tool_result" && segment.toolResult) {
          const callIdx = bg.segments.findIndex(
            s => s.type === "tool_call" && s.toolCall?.id === segment.toolResult!.toolCallId
          );
          if (callIdx >= 0) {
            bg.segments.splice(callIdx + 1, 0, segment);
          } else {
            bg.segments.push(segment);
          }
        } else {
          bg.segments.push(segment);
        }

        if (activeChatIdRef.current === streamChatId) {
          // Track which segment is actively streaming
          if (segment.type === "text") {
            setStreamingSegmentIndex(bg.segments.length - 1);
          } else if (segment.type === "tool_call") {
            // Track tool_call segments so ScrollableToolContainer knows streaming is active
            setStreamingSegmentIndex(bg.segments.length - 1);
          } else if (segment.type === "tool_result" && segment.toolResult) {
            // tool_result is spliced after its matching tool_call, find its actual index
            const resultIdx = bg.segments.findIndex(
              s => s.type === "tool_result" && s.toolResult?.toolCallId === segment.toolResult!.toolCallId
            );
            if (resultIdx >= 0) {
              setStreamingSegmentIndex(resultIdx);
            }
          }
          if (rafRef.current === null) {
            streamingContentRef.current = bg.content;
            rafRef.current = requestAnimationFrame(flushStreamingContent);
          }
        }
      },
      onAskUser: (_question) => {
        const bg = bgStreams.get(streamChatId);
        if (bg) bg.waitingForInput = true;

        if (activeChatIdRef.current === streamChatId) {
          setWaitingForInput(true);
        }
      },
      onArtifact: (artifact) => {
        const bg = bgStreams.get(streamChatId);
        if (!bg) return;
        bg.artifacts.push(artifact);

        // Add artifact segment
        bg.segments.push({ seq: bg.seqCounter++, type: "artifact", artifact });

        if (activeChatIdRef.current === streamChatId) {
          setArtifacts([...bg.artifacts]);
          // Artifact segments indicate text is complete
          setStreamingSegmentIndex(null);
          // Schedule segment flush
          if (rafRef.current === null) {
            streamingContentRef.current = bg.content;
            rafRef.current = requestAnimationFrame(flushStreamingContent);
          }
        }
      },
      onIteration: (info) => {
        console.log(`[chat] iteration ${info.iteration}: stopReason=${info.stopReason} tools=${info.toolCount} est=${info.estimatedTokens ?? "?"}`);
        // Update live usage from iteration events so token indicator stays current during tool loops
        if (activeChatIdRef.current === streamChatId) {
          if (info.usage) setStreamingUsage(info.usage);
          if (typeof info.estimatedTokens === "number") setStreamingEstimate(info.estimatedTokens);
        }
      },
      onWarning: (w) => {
        console.warn(`[chat] warning: ${w.type} — ${w.message}`);
        const bg = bgStreams.get(streamChatId);
        if (bg) bg.warning = w;

        if (activeChatIdRef.current === streamChatId) {
          setWarning(w);
        }
      },
      onCompacting: () => {
        console.log(`[chat] compaction started`);
        const bg = bgStreams.get(streamChatId);
        if (bg) bg.compacting = true;
        if (activeChatIdRef.current === streamChatId) {
          setCompacting(true);
          // Don't show sidebar indicator — octahedron is shown inline in TokenIndicator
        }
      },
      onAgentOutputComplete: () => {
        // The model finished emitting visible output, but the SSE turn may
        // still be compacting, saving, or generating metadata. Keep the stream
        // active until `done` so reconnect, input locking, and background state
        // reflect the server-side lifecycle.
        if (activeChatIdRef.current === streamChatId) {
          setStreamingThinkingActive(false);
          setStreamingSegmentIndex(null);
        }
      },
      onCompaction: (info) => {
        console.log(`[chat] compaction: removed ${info.removedCount} messages, ${info.remainingCount} remaining`);
        const bg = bgStreams.get(streamChatId);
        const phase: CompactionPhase = info.phase ?? (info.midTurn ? "mid_turn" : "end_turn");
        const streamContinues = info.continues ?? (phase === "pre_send" || phase === "mid_turn");
        if (bg) {
          bg.compacting = false;
          bg.compaction = info;

          if (streamContinues) {
            bg.streaming = true;
            if (activeChatIdRef.current === streamChatId) {
              setStreaming(true);
              setStreamingSegmentIndex(null);
            }
          }

          if (phase === "pre_send" || phase === "end_turn") {
            // Reload messages from server to ensure correct ordering.
            // The server has the authoritative message order after compaction —
            // manual index splicing is fragile and causes ordering bugs. For
            // pre-send compaction, preserve the live assistant placeholder
            // because normal generation is about to resume on this SSE stream.
            apiFetchChat(streamChatId)
              .then((chat) => {
                if (chat) {
                  if (bgStreams.get(streamChatId) !== bg || bg.doneCalled) return;
                  setActiveChatData(chat);

                  if (streamContinues) {
                    bg.messages = withLiveAssistant(chat.messages, bg);
                    if (activeChatIdRef.current === streamChatId) {
                      setMessages([...bg.messages]);
                    }
                  } else {
                    bg.messages = cloneMessages(chat.messages);

                    const lastAssistant = [...chat.messages].reverse().find(
                      (m) => m.role === "assistant" && !m._isCompactionSummary
                    );
                    if (lastAssistant) {
                      if (!bg.content || lastAssistant.content.length >= bg.content.length) {
                        bg.content = lastAssistant.content;
                      }
                      bg.segments = lastAssistant.segments ? lastAssistant.segments.map(s => ({ ...s })) : bg.segments;
                      bg.seqCounter = Math.max(bg.seqCounter, bg.segments.length);
                      bg.thinking = lastAssistant.thinking || bg.thinking;
                    }
                    bg.tools = [];
                    bg.thinkingActive = false;
                    bg.thinkingAccumulatedMs = 0;
                    bg.thinkingLastStart = 0;

                    if (activeChatIdRef.current === streamChatId) {
                      streamingContentRef.current = bg.content;
                      setStreamingThinking(bg.thinking);
                      setStreamingThinkingActive(false);
                      setStreamingThinkingAccumulatedMs(0);
                      streamingThinkingLastStartRef.current = 0;
                      setActiveTools([]);
                      setMessages([...bg.messages]);
                    }
                  }
                }
              })
              .catch((err) => console.warn("[chat] Failed to sync messages after compaction:", err));
          }
        }
        if (activeChatIdRef.current === streamChatId) {
          setCompacting(false);
          setCompaction(info);
          if (typeof info.estimatedTokens === "number" && info.estimatedTokens > 0) {
            setPostCompactionEstimate(info.estimatedTokens);
          }
        }
      },
      onMessageComplete: (message) => {
        const bg = bgStreams.get(streamChatId);
        if (!bg) return;

        // Finalize the assistant message that just completed on the server.
        // Prefer an exact content match, but skip steering placeholders — when a
        // user steered mid-stream, the previous assistant's visible content is
        // frozen at the pre-steering text while bg.content kept accumulating,
        // so the content match won't hit; fall back to the most recent
        // non-placeholder assistant.
        const msgs = bg.messages;
        let matchedIdx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === "assistant" && !msgs[i]._steeringPending && msgs[i].content === bg.content) {
            matchedIdx = i;
            break;
          }
        }
        if (matchedIdx < 0) {
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === "assistant" && !msgs[i]._steeringPending) {
              matchedIdx = i;
              break;
            }
          }
        }
        if (matchedIdx >= 0) {
          msgs[matchedIdx] = { ...msgs[matchedIdx], ...message };
        }

        // Reset streaming accumulators for the next response
        bg.content = "";
        bg.thinking = "";
        bg.thinkingActive = false;
        bg.thinkingAccumulatedMs = 0;
        bg.thinkingLastStart = 0;
        bg.tools = [];
        bg.artifacts = [];
        bg.visuals = [];
        bg.generatedImages = [];
        bg.segments = [];
        bg.seqCounter = 0;

        if (activeChatIdRef.current === streamChatId) {
          streamingContentRef.current = "";
          setStreamingThinking("");
          setStreamingThinkingActive(false);
          setStreamingThinkingAccumulatedMs(0);
          streamingThinkingLastStartRef.current = 0;
          setActiveTools([]);
          setArtifacts([]);
          setGeneratedImages([]);
          setMessages([...bg.messages]);
        }
      },
      onFollowUpStart: (_data) => {
        // The server has picked up a queued message. If the client already
        // inserted a steering placeholder (via send() while streaming), just
        // clear its pending flag so deltas start flowing into it. Otherwise
        // this is a pure follow-up (e.g. queued while offline) — add a fresh
        // placeholder.
        const bg = bgStreams.get(streamChatId);
        if (!bg) return;

        const last = bg.messages[bg.messages.length - 1];
        if (last?.role === "assistant" && last._steeringPending) {
          const { _steeringPending, ...cleared } = last;
          void _steeringPending;
          bg.messages = [...bg.messages.slice(0, -1), cleared];
        } else {
          const placeholder: ChatMessage = {
            role: "assistant",
            content: "",
            timestamp: Date.now(),
          };
          bg.messages = [...bg.messages, placeholder];
        }

        if (activeChatIdRef.current === streamChatId) {
          setMessages([...bg.messages]);
        }

        console.log(`[chat] follow-up started for ${streamChatId}`);
      },
      onBackgroundActivity: (info) => {
        console.log(`[chat] background activity: ${info.type} for chat ${info.chatId}`);
        // Set background activity indicator for 5 seconds
        setHasBackgroundActivity(true);
        setTimeout(() => setHasBackgroundActivity(false), 5000);
      },
      onTitleUpdate: (chatId, title) => {
        setTitleUpdate({ chatId, title });
      },
      onError: (err) => {
        const bg = bgStreams.get(streamChatId);

        if (err.startsWith("__OFFLINE__:")) {
          const errorMsg = "Network unavailable — message queued";
          if (bg) {
            bg.streaming = false;
            bg.error = errorMsg;

            // Only enqueue for retry if the server never received the request.
            // If we received any streaming data (text, thinking, tool calls, etc.),
            // the server already processed the message — retrying would create
            // a duplicate. Only the initial fetch failure (no data received)
            // should be retried.
            const receivedData = bg.content.length > 0 || bg.thinking.length > 0 || bg.tools.length > 0 || bg.segments.length > 0;

            // Find and enqueue the last user message — only if no data was received
            const lastUserIdx = bg.messages.map((m) => m.role).lastIndexOf("user");
            if (lastUserIdx >= 0 && !receivedData) {
              const userMsg = bg.messages[lastUserIdx];
              enqueueMessage(streamChatId, userMsg.content, userMsg.images).catch(() => {});
              // Remove empty assistant placeholder
              const lastMsg = bg.messages[bg.messages.length - 1];
              if (lastMsg?.role === "assistant" && !lastMsg.content) {
                bg.messages = bg.messages.slice(0, -1);
              }
              bg.messages = bg.messages.map((m, i) =>
                i === lastUserIdx ? { ...m, queued: true } : m
              );
            } else if (receivedData) {
              // Server processed the message but connection dropped — don't retry.
              // The message is already persisted on the server side.
              // Remove the empty assistant placeholder to show the user message
              // as the last thing in the chat (the server's partial response will
              // be visible when they reconnect).
              const lastMsg = bg.messages[bg.messages.length - 1];
              if (lastMsg?.role === "assistant" && !lastMsg.content) {
                bg.messages = bg.messages.slice(0, -1);
              }
            }
          }

          if (activeChatIdRef.current === streamChatId) {
            setError(errorMsg);
            if (bg) setMessages([...bg.messages]);
            setStreaming(false);
            bgStreams.delete(streamChatId);
          }
        } else {
          if (bg) {
            bg.streaming = false;
            bg.error = err;
          }
          if (activeChatIdRef.current === streamChatId) {
            setError(err);
            setStreaming(false);
            bgStreams.delete(streamChatId);
          }
        }
      },
    }),
    [flushStreamingContent, setActiveChatData]
  );

  // Shared pre-stream state reset
  const prepareStream = useCallback(() => {
    setStreaming(true);
    setStreamingThinking("");
    setActiveTools([]);
    setArtifacts([]);
    setGeneratedImages([]);
    setWaitingForInput(false);
    setError(null);
    setWarning(null);
    setCompaction(null);
    setPostCompactionEstimate(null);
    doneCalledRef.current = false;
    streamingContentRef.current = "";
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const send = useCallback(
    (text: string, images?: ImageAttachment[]) => {
      if (!chatId) return;
      const targetChatId = chatId;

      const userMsg: ChatMessage = {
        role: "user",
        content: text,
        images: images?.length ? images : undefined,
        timestamp: Date.now(),
      };

      // If offline, queue the message
      if (!navigator.onLine) {
        const queuedMsg: ChatMessage = { ...userMsg, queued: true };
        setMessages((prev) => [...prev, queuedMsg]);
        enqueueMessage(targetChatId, text, images).catch(() => {});
        return;
      }

      // If streaming, enqueue the message for follow-up
      if (streaming) {
        const bg = bgStreams.get(targetChatId);
        // Append user msg + an empty assistant placeholder so the spinner stays
        // visible and an empty bubble renders during the gap before the server
        // picks up the queued message. _steeringPending gates delta application
        // so in-flight content from the pre-steering generation doesn't leak in.
        const placeholder: ChatMessage = {
          role: "assistant",
          content: "",
          timestamp: Date.now(),
          _steeringPending: true,
        };
        if (bg) {
          bg.messages = [...bg.messages, userMsg, placeholder];
        }
        setMessages((prev) => [...prev, userMsg, placeholder]);
        apiEnqueueMessage(targetChatId, text, images).catch((err) =>
          console.error("[chat] enqueue failed:", err)
        );
        return;
      }

      // Create bgStream entry for this chat's stream
      const bg = createBgStream(activeChatRef.current, messageOffsetRef.current, messageTotalRef.current);
      bgStreams.set(targetChatId, bg);

      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: "",
        timestamp: Date.now(),
      };

      // Update React state and bgStream messages together
      setMessages((prev) => {
        const next = [...prev, userMsg, assistantMsg];
        bg.messages = next;
        return next;
      });

      prepareStream();

      const callbacks = makeStreamCallbacks(targetChatId);
      const controller = sendMessage(targetChatId, text, callbacks, images);
      bg.abortController = controller;
      abortRef.current = controller;
    },
    [chatId, streaming, prepareStream, makeStreamCallbacks]
  );

  const editMessage = useCallback(
    (index: number, newText: string, images?: ImageAttachment[]) => {
      if (!chatId || streaming || !navigator.onLine) return;
      const targetChatId = chatId;
      const localIndex = index - messageOffsetRef.current;
      if (localIndex < 0 || localIndex >= messages.length) return;

      // Use provided images if explicitly passed (including empty array), otherwise preserve originals
      const originalMessage = messages[localIndex];
      if (!originalMessage) return;
      const originalImages = images !== undefined ? images : (originalMessage.images?.length ? originalMessage.images : undefined);

      // Create bgStream entry
      const bg = createBgStream(activeChatRef.current, messageOffsetRef.current, messageTotalRef.current);
      bgStreams.set(targetChatId, bg);

      // Truncate to edit point, add new user msg (with preserved images) + placeholder assistant msg
      setMessages((prev) => {
        const truncated = prev.slice(0, localIndex);
        const next = [
          ...truncated,
          { role: "user" as const, content: newText, images: originalImages, timestamp: Date.now() },
          { role: "assistant" as const, content: "", timestamp: Date.now() },
        ];
        bg.messages = next;
        return next;
      });
      bg.messageOffset = index;
      setMessageOffset(index);
      setMessageTotal(index + 2);

      prepareStream();

      const callbacks = makeStreamCallbacks(targetChatId);
      const controller = apiEditMessage(targetChatId, index, newText, callbacks, originalImages);
      bg.abortController = controller;
      abortRef.current = controller;
    },
    [chatId, streaming, messages, prepareStream, makeStreamCallbacks]
  );

  const retryMessage = useCallback(
    (index: number) => {
      const localIndex = index - messageOffsetRef.current;
      const msg = localIndex >= 0 ? messages[localIndex] : undefined;
      if (msg) {
        editMessage(index, msg.content, msg.images);
      }
    },
    [editMessage, messages]
  );

  const abort = useCallback(async () => {
    if (chatId) {
      const bg = bgStreams.get(chatId);
      if (bg) {
        // First, call the server-side stop endpoint to immediately abort the agent loop
        try {
          await apiStopChat(chatId);
        } catch (err) {
          console.error(`[chat] stop endpoint failed:`, err);
        }
        
        // Then abort the client-side SSE connection
        bg.abortController?.abort();
        bg.streaming = false;
        bgStreams.delete(chatId);
      }
    }
    // Also abort the local controller as a fallback
    abortRef.current?.abort();
    setStreaming(false);
  }, [chatId]);

  // Process queued messages for the current chat
  const processQueue = useCallback(async () => {
    if (!chatId || streaming || queueProcessing) return;
    const targetChatId = chatId;

    const queued = await getQueuedMessagesForChat(targetChatId);
    if (queued.length === 0) return;

    setQueueProcessing(true);

    for (const item of queued) {
      if (!navigator.onLine) break;

      // Remove "queued" flag from the user message in UI
      setMessages((prev) =>
        prev.map((m) =>
          m.queued && m.content === item.message ? { ...m, queued: false } : m
        )
      );

      // Send and wait for completion
      const sent = await new Promise<boolean>((resolve) => {
        // Create bgStream entry
        const bg = createBgStream(activeChatRef.current, messageOffsetRef.current, messageTotalRef.current);
        bgStreams.set(targetChatId, bg);

        prepareStream();

        // Add placeholder assistant message
        setMessages((prev) => {
          const next = [
            ...prev,
            { role: "assistant" as const, content: "", timestamp: Date.now() },
          ];
          bg.messages = next;
          return next;
        });

        const callbacks = makeStreamCallbacks(targetChatId, () => {
          resolve(true);
        });
        // Override onError to detect further offline
        const origOnError = callbacks.onError;
        callbacks.onError = (err) => {
          if (err.startsWith("__OFFLINE__:")) {
            resolve(false);
          } else {
            origOnError(err);
            resolve(true); // still dequeue on non-offline errors
          }
        };

        const controller = sendMessage(targetChatId, item.message, callbacks, item.images);
        bg.abortController = controller;
        abortRef.current = controller;
      });

      await dequeueMessage(item.id!);

      if (!sent) break; // network dropped mid-processing
    }

    setQueueProcessing(false);
  }, [chatId, streaming, queueProcessing, prepareStream, makeStreamCallbacks]);

  // Use live streaming usage (from iteration events) when available,
  // otherwise fall back to the last assistant message's usage.
  // This keeps the token indicator accurate during multi-iteration tool loops.
  // IMPORTANT: Skips compaction summaries since they don't have real usage data.
  // ALSO IMPORTANT: Skips messages from before a compaction summary — their usage
  // data reflects the pre-compaction context size and is stale.
  // Derive both the usage value and a flag for whether it's a post-compaction
  // estimate (vs. a real LLM-reported count). The flag lets the indicator
  // mark the number as provisional instead of rendering it identically to a
  // confirmed count.
  const { totalUsage, isUsageEstimated }: { totalUsage: MessageUsage; isUsageEstimated: boolean } = useMemo(() => {
    if (streamingUsage) {
      // During tool loops, the server sends a per-iteration `estimatedTokens`
      // that reflects the next call's input (includes accumulated tool
      // results). Reported usage covers only the previous iteration's
      // input+output, so when a big tool result landed between iterations the
      // estimate is meaningfully larger and is the truthful number to show.
      if (streamingEstimate && streamingEstimate > streamingUsage.totalTokens) {
        return {
          totalUsage: {
            input: streamingUsage.input,
            output: streamingUsage.output,
            totalTokens: streamingEstimate,
          },
          isUsageEstimated: true,
        };
      }
      return { totalUsage: streamingUsage, isUsageEstimated: false };
    }
    // Find the index of the last compaction summary — any usage data before it
    // is stale (reflects pre-compaction context size).
    let lastCompactionIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]._isCompactionSummary) {
        lastCompactionIdx = i;
        break;
      }
    }
    // Find the last REAL assistant message with usage that's AFTER any compaction
    for (let i = messages.length - 1; i >= 0; i--) {
      if (i <= lastCompactionIdx) break; // All messages before/at compaction are stale
      const msg = messages[i];
      if (msg.role === "assistant" && !msg._isCompactionSummary && msg.usage) {
        return { totalUsage: msg.usage, isUsageEstimated: false };
      }
    }
    // No real usage yet (typical between compaction and next assistant reply).
    // Fall back to the server's post-compaction estimate — unlike the old
    // zeroed-out fallback, this gives an accurate provisional count so the
    // indicator doesn't mislead the user with "context reset".
    if (lastCompactionIdx !== -1 && postCompactionEstimate && postCompactionEstimate > 0) {
      return {
        totalUsage: { input: postCompactionEstimate, output: 0, totalTokens: postCompactionEstimate },
        isUsageEstimated: true,
      };
    }
    return { totalUsage: { input: 0, output: 0, totalTokens: 0 }, isUsageEstimated: false };
  }, [messages, streamingUsage, streamingEstimate, postCompactionEstimate]);

  // Check if the chat has a compaction summary (for UI state)
  const hasCompactionSummary = useMemo(() => {
    return messages.some(m => m._isCompactionSummary);
  }, [messages]);

  return {
    messages,
    messageOffset,
    messageTotal: Math.max(messageTotal, messageOffset + messages.length),
    hasMoreMessages: messageOffset > 0,
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
    error,
    warning,
    streamingSegmentIndex,
    hasBackgroundActivity,
    send,
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
  };
}
