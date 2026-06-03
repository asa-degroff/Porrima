import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { sendMessage, editMessage as apiEditMessage, enqueueMessage as apiEnqueueMessage, stopChat as apiStopChat, fetchChat as apiFetchChat, fetchChatMessages, getChatStatus, reconnectChat, queueArtifactErrorRepair, streamArtifactErrorRepair } from "../api/client";
import type { ArtifactRuntimeErrorReport, StreamCallbacks, ToolStatus, StreamWarning } from "../api/client";
import type { Artifact, ChatMessage, GeneratedImage, ImageAttachment, InferenceActivityPhase, InlineVisual, MessageSegment, MessageUsage, ModelProgress } from "../types";
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
  modelProgress: ModelProgress | null;
  inferenceActivityPhase: InferenceActivityPhase | null;
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
    modelProgress: null,
    inferenceActivityPhase: "prefill",
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
      _toolLoopId: last._toolLoopId,
      _toolLoopFragment: last._toolLoopFragment,
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
  const [reconnecting, setReconnecting] = useState(false);
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
  const [modelProgress, setModelProgress] = useState<ModelProgress | null>(null);
  const [inferenceActivityPhase, setInferenceActivityPhase] = useState<InferenceActivityPhase | null>(null);
  // Provisional token count from the most recent compaction event — used to
  // show an accurate (if approximate) context size between compaction and the
  // next assistant's real usage, so the indicator never reverts to
  // "context reset" while the chat still holds meaningful context.
  const [postCompactionEstimate, setPostCompactionEstimate] = useState<number | null>(null);
  const [queueProcessing, setQueueProcessing] = useState(false);
  const [titleUpdate, setTitleUpdate] = useState<{ chatId: string; title: string } | null>(null);
  const [streamingSegmentIndex, setStreamingSegmentIndex] = useState<number | null>(null);
  const [streamingUsage, setStreamingUsage] = useState<MessageUsage | null>(null);
  // Separate from streamingUsage because the server-side display estimate
  // reflects the NEXT call's input (includes accumulated tool results), not the
  // last call's reported usage. When it exceeds reported usage, we show it as a
  // provisional ~N / max in the indicator.
  const [streamingEstimate, setStreamingEstimate] = useState<number | null>(null);
  const [hasBackgroundActivity, setHasBackgroundActivity] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const doneCalledRef = useRef(false);
  const streamingContentRef = useRef("");
  const rafRef = useRef<number | null>(null);
  const reportedArtifactRepairRef = useRef<Set<string>>(new Set());
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
      setModelProgress(bg.modelProgress);
      setInferenceActivityPhase(bg.inferenceActivityPhase);
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
      setReconnecting(false);
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
      setModelProgress(null);
      setInferenceActivityPhase(null);
      setPostCompactionEstimate(null);
      setStreamingSegmentIndex(null);
      setStreamingUsage(null);
      setStreamingEstimate(null);
    }
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
        if (bg.modelProgress) {
          bg.modelProgress = null;
          if (activeChatIdRef.current === streamChatId) setModelProgress(null);
        }
        if (bg.inferenceActivityPhase !== "decode") {
          bg.inferenceActivityPhase = "decode";
          if (activeChatIdRef.current === streamChatId) setInferenceActivityPhase("decode");
        }
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
        if (bg.modelProgress) {
          bg.modelProgress = null;
          if (activeChatIdRef.current === streamChatId) setModelProgress(null);
        }
        if (bg.inferenceActivityPhase !== "decode") {
          bg.inferenceActivityPhase = "decode";
          if (activeChatIdRef.current === streamChatId) setInferenceActivityPhase("decode");
        }
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
      onDone: ({ content: serverContent, thinking, thinkingDurationMs, usage, artifacts: doneArtifacts, generatedImages: doneImages, visuals: doneVisuals, toolCalls, toolResults, segments, waitingForInput: wfi, thinkingPromoted, recap, toolLoopId, toolLoopFragment, messageSequence, userMessageSequence }) => {
        const bg = bgStreams.get(streamChatId);
        if (!bg || bg.doneCalled) return;
        bg.doneCalled = true;
        bg.streaming = false;
        bg.modelProgress = null;
        bg.inferenceActivityPhase = null;

        // The persisted server row is authoritative. This also corrects any
        // live-only over-append caused by reconnect replay before the user has
        // to refresh the page.
        const finalContent =
          typeof serverContent === "string"
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
            _toolLoopId: toolLoopId || last._toolLoopId,
            _toolLoopFragment: toolLoopFragment || undefined,
            _rowSequence: messageSequence ?? last._rowSequence,
          };
        }
        if (userMessageSequence != null) {
          for (let i = bg.messages.length - 2; i >= 0; i--) {
            if (bg.messages[i]?.role === "user") {
              bg.messages[i] = {
                ...bg.messages[i],
                _rowSequence: userMessageSequence,
              };
              break;
            }
          }
        }

        if (wfi) bg.waitingForInput = true;

        // If the server skipped the repair (e.g. superseded/duplicate), the
        // assistant placeholder will be empty — remove it silently.
        const skippedLast = bg.messages[bg.messages.length - 1];
        if (skippedLast?.role === "assistant" && !finalContent && !thinking && !doneArtifacts && !doneImages && !doneVisuals && !toolCalls) {
          bg.messages.pop();
        }

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
          setModelProgress(null);
          setInferenceActivityPhase(null);
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

        // Also update liveStatus on the matching tool_call segment so
        // SegmentRenderer can pass it to ToolCallDisplay for live display.
        for (const seg of bg.segments) {
          if (seg.type === "tool_call" && seg.toolCall?.name === status.name) {
            seg.liveStatus = status;
          }
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
        console.log(`[chat] iteration ${info.iteration}: stopReason=${info.stopReason} tools=${info.toolCount} est=${info.estimatedTokens ?? "?"} displayEst=${info.displayEstimatedTokens ?? "?"}`);
        // Update live usage from iteration events so token indicator stays current during tool loops
        if (activeChatIdRef.current === streamChatId) {
          if (info.usage) setStreamingUsage(info.usage);
          const displayEstimate = typeof info.displayEstimatedTokens === "number"
            ? info.displayEstimatedTokens
            : info.estimatedTokens;
          if (typeof displayEstimate === "number") setStreamingEstimate(displayEstimate);
        }
      },
      onModelProgress: (progress) => {
        const bg = bgStreams.get(streamChatId);
        if (!bg) return;
        const next = { ...progress, receivedAt: Date.now() };
        bg.modelProgress = progress.phase === "generating" ? null : next;
        bg.inferenceActivityPhase = progress.phase === "generating" ? "decode" : "prefill";
        if (activeChatIdRef.current === streamChatId) {
          setModelProgress(bg.modelProgress);
          setInferenceActivityPhase(bg.inferenceActivityPhase);
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
        const bg = bgStreams.get(streamChatId);
        if (bg) {
          bg.modelProgress = null;
          bg.inferenceActivityPhase = null;
        }
        if (activeChatIdRef.current === streamChatId) {
          setStreamingThinkingActive(false);
          setStreamingSegmentIndex(null);
          setModelProgress(null);
          setInferenceActivityPhase(null);
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

          if (phase === "pre_send" || phase === "end_turn" || (phase === "manual" && streamContinues)) {
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
          // Clear pre-compaction streaming usage so the server's post-compaction
          // estimate can take over immediately. Without this, streamingUsage from
          // the last LLM call (pre-compaction) is still truthy, and the useMemo
          // short-circuits before reaching postCompactionEstimate. The next
          // iteration event or onDone will clear/update naturally.
          setStreamingUsage(null);
          setStreamingEstimate(null);
          if (typeof info.estimatedTokens === "number" && info.estimatedTokens > 0) {
            setPostCompactionEstimate(info.estimatedTokens);
          }
        }
      },
      onMessageComplete: (message, meta) => {
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
        bg.inferenceActivityPhase = meta?.continues ? "prefill" : null;

        if (meta?.continues) {
          const placeholder: ChatMessage = {
            role: "assistant",
            content: "",
            timestamp: Date.now(),
            _toolLoopId: message?._toolLoopId,
          };
          bg.messages = [...bg.messages, placeholder];
        }

        if (activeChatIdRef.current === streamChatId) {
          streamingContentRef.current = "";
          setStreamingThinking("");
          setStreamingThinkingActive(false);
          setStreamingThinkingAccumulatedMs(0);
          streamingThinkingLastStartRef.current = 0;
          setActiveTools([]);
          setArtifacts([]);
          setGeneratedImages([]);
          setInferenceActivityPhase(bg.inferenceActivityPhase);
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
        bg.inferenceActivityPhase = "prefill";

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
          setInferenceActivityPhase("prefill");
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
      onAudioChunk: (chunk) => {
        // Live agent TTS streaming: forward audio data to TTS hook
        const idx = chunk.index !== undefined ? `${chunk.index + 1}/${chunk.totalChunks}` : "?";
        console.log(`[chat] audio_chunk #${idx} for ${streamChatId}`);
        // Dispatch a custom event so the TTS hook can pick it up
        window.dispatchEvent(new CustomEvent("agent-audio-chunk", {
          detail: { chatId: streamChatId, chunk },
        }));
      },
      onAudioDone: () => {
        window.dispatchEvent(new CustomEvent("agent-audio-done", {
          detail: { chatId: streamChatId },
        }));
      },
      onAudioError: (error) => {
        window.dispatchEvent(new CustomEvent("agent-audio-error", {
          detail: { chatId: streamChatId, error },
        }));
      },
      onTitleUpdate: (chatId, title) => {
        setTitleUpdate({ chatId, title });
      },
      onError: (err) => {
        const bg = bgStreams.get(streamChatId);
        const isOfflineError = err.startsWith("__OFFLINE__:");
        const isConnectionError = err.startsWith("Connection error:");
        const isInactivityError = err.startsWith("__SSE_INACTIVITY__:");
        const displayErr = isInactivityError ? err.replace("__SSE_INACTIVITY__:", "") : err;

        // Determine whether the server received the message before the
        // connection dropped. If any streaming data was received, the server
        // already processed the request. An SSE inactivity timeout also means
        // the POST already reached the server because response headers were
        // accepted and the client was reading the stream body.
        const receivedData = bg ? (
          bg.content.length > 0 ||
          bg.thinking.length > 0 ||
          bg.tools.length > 0 ||
          bg.segments.length > 0 ||
          bg.compacting ||
          bg.compaction !== null ||
          bg.modelProgress !== null ||
          bg.inferenceActivityPhase !== null
        ) : false;
        const serverLikelyHasStream = receivedData || isInactivityError;

        // When the connection drops after receiving data, silently reconnect
        // to the server stream so the in-progress response continues. The
        // client's own SSE inactivity timeout is a missing-bytes watchdog, not
        // a model failure; attempt recovery even if navigator.onLine is stale.
        const shouldAttemptReconnect =
          bg &&
          serverLikelyHasStream &&
          (isOfflineError || isConnectionError || isInactivityError) &&
          (navigator.onLine || isInactivityError);

        if (shouldAttemptReconnect) {
          // Don't show error or delete bgStreams. The partial content stays
          // visible. The reconnect attempt below will pick up the server stream.
          console.log(`[chat] stream dropped after receiving data, attempting reconnect for ${streamChatId}`);
          if (activeChatIdRef.current === streamChatId) {
            setReconnecting(true);
          }
          // Initiate silent reconnect — if it fails, fall back to showing
          // the user so they know something went wrong.
          (async () => {
            try {
              const status = await getChatStatus(streamChatId);
              if (bgStreams.get(streamChatId) !== bg) return; // raced with another reconnect/switch
              if (!status.reachable) {
                throw new Error("Chat status unreachable");
              }
              if (!status.active) {
                // Server stream ended naturally before we reattached. Pull the
                // authoritative persisted messages so the UI catches up instead
                // of waiting for a chat switch or full reload.
                const chat = await apiFetchChat(streamChatId);
                if (chat && bgStreams.get(streamChatId) === bg) {
                  setActiveChatData(chat);
                  bg.messages = cloneMessages(chat.messages);
                  bg.messageOffset = chat.messageOffset ?? 0;
                  bg.messageTotal = chat.messageTotal ?? chat.messages.length;
                  if (activeChatIdRef.current === streamChatId) {
                    setMessages([...bg.messages]);
                    setMessageOffset(bg.messageOffset);
                    setMessageTotal(bg.messageTotal);
                  }
                }
                bg.streaming = false;
                bg.modelProgress = null;
                bg.inferenceActivityPhase = null;
                if (activeChatIdRef.current === streamChatId) {
                  setStreaming(false);
                  setReconnecting(false);
                  setModelProgress(null);
                  setInferenceActivityPhase(null);
                }
                bgStreams.delete(streamChatId);
                return;
              }
              // Reconnect to the live server stream
              bg.abortController?.abort();
              const callbacks = makeStreamCallbacks(streamChatId);
              bg.abortController = reconnectChat(streamChatId, callbacks, { replay: false });
              abortRef.current = bg.abortController;
              if (activeChatIdRef.current === streamChatId) {
                setError(null);
                setReconnecting(false);
              }
              console.log(`[chat] silently reconnected to ${streamChatId} (${status.bufferedChunks} buffered chunks)`);
            } catch (_reconnectErr) {
              // Reconnect failed — clear the indicator and let the user know.
              // The message is already persisted on the server.
              if (bgStreams.get(streamChatId) === bg) {
                bg.streaming = false;
                bg.modelProgress = null;
                bg.inferenceActivityPhase = null;
                bgStreams.delete(streamChatId);
              }
              if (activeChatIdRef.current === streamChatId) {
                setReconnecting(false);
                setError(isInactivityError
                  ? "Live response stream stopped sending updates — your message was saved on the server"
                  : "Connection lost — your message was saved on the server");
                setModelProgress(null);
                setInferenceActivityPhase(null);
              }
            }
          })();
          return;
        }

        if (isOfflineError) {
          // Use a context-appropriate error message:
          // - If we received data, the server already has the message — no queueing needed
          // - If no data was received, the message will be queued for retry
          const errorMsg = receivedData
            ? "Network unavailable — response may be incomplete"
            : "Network unavailable — message queued";
          if (bg) {
            bg.streaming = false;
            bg.error = errorMsg;
            bg.modelProgress = null;
            bg.inferenceActivityPhase = null;

            // Only enqueue for retry if the server never received the request.
            // If we received any streaming data (text, thinking, tool calls, etc.),
            // the server already processed the message — retrying would create
            // a duplicate. Only the initial fetch failure (no data received)
            // should be retried.

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
            setModelProgress(null);
            setInferenceActivityPhase(null);
            if (bg) setMessages([...bg.messages]);
            setStreaming(false);
            bgStreams.delete(streamChatId);
          }
        } else {
          // Non-offline error (could be Connection error, auth error, model error, etc.)
          if (bg) {
            bg.streaming = false;
            bg.error = displayErr;
            bg.modelProgress = null;
            bg.inferenceActivityPhase = null;
          }

          // For transient connection errors when we're online but the fetch was
          // killed (e.g. backgrounded tab), show a more helpful message.
          // Don't queue since we can't tell if the server received the request.
          const finalDisplayErr = isConnectionError
            ? "Connection interrupted — tap Retry to resend"
            : isInactivityError
              ? "Live response stream stopped sending updates — refresh the chat to sync server state"
              : displayErr;

          if (activeChatIdRef.current === streamChatId) {
            setError(finalDisplayErr);
            setModelProgress(null);
            setInferenceActivityPhase(null);
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
    setModelProgress(null);
    setInferenceActivityPhase("prefill");
    setPostCompactionEstimate(null);
    doneCalledRef.current = false;
    streamingContentRef.current = "";
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  // Shared reconnect logic — extracted so it can be reused by both the
  // chatId-change effect and the visibility-change effect.
  const tryReconnect = useCallback(async (chatIdToConnect: string) => {
    if (bgStreams.has(chatIdToConnect)) return;

    let cancelled = false;
    const status = await getChatStatus(chatIdToConnect);
    if (cancelled) return;
    if (!status.active) return;
    // Chat may have switched away during the async check.
    if (chatIdToConnect !== activeChatIdRef.current) return;
    if (bgStreams.has(chatIdToConnect)) return;

    console.log(`[chat] reconnecting to in-flight stream for ${chatIdToConnect} (${status.bufferedChunks} buffered chunks)`);
    let serverChat: Chat | null = null;
    try {
      serverChat = await apiFetchChat(chatIdToConnect);
    } catch {
      serverChat = activeChatRef.current?.id === chatIdToConnect ? activeChatRef.current : null;
    }
    if (cancelled) return;
    if (chatIdToConnect !== activeChatIdRef.current) return;
    if (bgStreams.has(chatIdToConnect)) return;

    const bg = createBgStream(serverChat ?? activeChatRef.current);
    bg.messages = withLiveAssistant(serverChat?.messages ?? activeChatRef.current?.messages ?? [], bg);
    bgStreams.set(chatIdToConnect, bg);
    prepareStream();
    setMessages([...bg.messages]);
    setStreaming(true);
    setError(null);
    if (serverChat) setActiveChatData(serverChat);

    const callbacks = makeStreamCallbacks(chatIdToConnect);
    const controller = reconnectChat(chatIdToConnect, callbacks);
    bg.abortController = controller;
    abortRef.current = controller;

    return () => { cancelled = true; };
  }, [prepareStream, makeStreamCallbacks, setActiveChatData]);

  // ---------- Stale-content detection ----------
  // Track which chats have recently been streaming so we can skip the
  // getChatStatus round-trip for non-streaming switches.
  const recentlyStreamingRef = useRef<Set<string>>(new Set());

  // Mark a chat as recently streaming when the user sends a message,
  // and auto-expire the marker after a few minutes.
  const markRecentlyStreaming = useCallback((id: string) => {
    recentlyStreamingRef.current.add(id);
    setTimeout(() => recentlyStreamingRef.current.delete(id), 5 * 60_000);
  }, []);

  // Reconnect to a server-side in-flight stream. Only called when we have
  // reason to believe a stream is active (recently streaming, or visibility
  // change while streaming).
  useEffect(() => {
    if (!chatId) return;
    if (bgStreams.has(chatId)) return;
    // Only attempt reconnect if this chat was recently streaming.
    // This avoids a network round-trip on every chat switch for the
    // common case where no stream is in progress.
    if (!recentlyStreamingRef.current.has(chatId)) return;

    let cancelled = false;
    (async () => {
      const cleanup = await tryReconnect(chatId);
      if (cancelled) return;
      if (cleanup) cleanup();
    })();

    return () => {
      cancelled = true;
    };
  }, [chatId, tryReconnect]);

  // When the tab returns from the background, the browser may have killed the
  // SSE connection during backgrounding (common with fetch-based streams).
  // Detect this and reconnect automatically instead of requiring a page refresh.
  // Only attempts reconnection if the chat was recently streaming.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;

      const activeChatId = activeChatIdRef.current;
      if (!activeChatId) return;

      // Only attempt reconnection if the chat was recently streaming.
      if (!recentlyStreamingRef.current.has(activeChatId)) return;

      (async () => {
        const status = await getChatStatus(activeChatId);
        if (document.visibilityState !== "visible") return;
        if (!status.active) return;
        if (activeChatId !== activeChatIdRef.current) return;
        if (bgStreams.has(activeChatId)) return;

        console.log(`[chat] reconnecting on visibility change for ${activeChatId} (${status.bufferedChunks} buffered chunks)`);
        const cleanup = await tryReconnect(activeChatId);
        if (cleanup) cleanup();
      })();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [tryReconnect]);

  const send = useCallback(
    (text: string, images?: ImageAttachment[]) => {
      if (!chatId) return;
      const targetChatId = chatId;
      markRecentlyStreaming(targetChatId);

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

      // If streaming, enqueue the message for follow-up. Also consult the
      // module-level stream map so stale React state cannot start a duplicate
      // /api/chat POST while this chat already has an active background stream.
      const existingBg = bgStreams.get(targetChatId);
      if (streaming || existingBg?.streaming) {
        const bg = existingBg;
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

  const reportArtifactRuntimeError = useCallback(
    (report: ArtifactRuntimeErrorReport) => {
      const targetChatId = report.chatId || chatId;
      if (!targetChatId || targetChatId !== chatId) return;
      const repairKey = [
        targetChatId,
        report.artifactId,
        report.version,
        report.diagnosticKind ?? "",
        report.message,
        report.shaderLabel ?? "",
        report.shaderLine ?? report.lineno ?? "",
        report.shaderColumn ?? report.colno ?? "",
      ].join(":");
      if (reportedArtifactRepairRef.current.has(repairKey)) return;
      reportedArtifactRepairRef.current.add(repairKey);

      const existingBg = bgStreams.get(targetChatId);
      if (streaming || existingBg?.streaming) {
        queueArtifactErrorRepair(report).catch((err) => {
          console.warn("[artifact-repair] failed to queue repair:", err);
        });
        return;
      }

      const bg = createBgStream(activeChatRef.current, messageOffsetRef.current, messageTotalRef.current);
      bgStreams.set(targetChatId, bg);

      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: "",
        timestamp: Date.now(),
      };

      setMessages((prev) => {
        const next = [...prev, assistantMsg];
        bg.messages = next;
        return next;
      });

      prepareStream();

      const callbacks = makeStreamCallbacks(targetChatId);
      const controller = streamArtifactErrorRepair(report, callbacks);
      bg.abortController = controller;
      abortRef.current = controller;
    },
    [chatId, streaming, prepareStream, makeStreamCallbacks]
  );

  const editMessage = useCallback(
    (index: number, newText: string, images?: ImageAttachment[], messageSequence?: number) => {
      if (!chatId || streaming || !navigator.onLine) return;
      const targetChatId = chatId;
      markRecentlyStreaming(targetChatId);
      const currentOffset = messageOffsetRef.current;
      const sequenceLocalIndex = messageSequence == null
        ? -1
        : messages.findIndex((m) => m._rowSequence === messageSequence);
      const localIndex = sequenceLocalIndex >= 0 ? sequenceLocalIndex : index - messageOffsetRef.current;
      if (localIndex < 0 || localIndex >= messages.length) return;
      const targetAbsoluteIndex = messageSequence ?? index;

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
      bg.messageOffset = currentOffset;
      bg.messageTotal = targetAbsoluteIndex + 2;
      setMessageOffset(currentOffset);
      setMessageTotal(targetAbsoluteIndex + 2);

      prepareStream();

      const callbacks = makeStreamCallbacks(targetChatId);
      const controller = apiEditMessage(targetChatId, index, newText, callbacks, originalImages, messageSequence);
      bg.abortController = controller;
      abortRef.current = controller;
    },
    [chatId, streaming, messages, prepareStream, makeStreamCallbacks]
  );

  const retryMessage = useCallback(
    (index: number, messageSequence?: number) => {
      const sequenceLocalIndex = messageSequence == null
        ? -1
        : messages.findIndex((m) => m._rowSequence === messageSequence);
      const localIndex = sequenceLocalIndex >= 0 ? sequenceLocalIndex : index - messageOffsetRef.current;
      const msg = localIndex >= 0 ? messages[localIndex] : undefined;
      if (msg) {
        editMessage(index, msg.content, msg.images, messageSequence ?? msg._rowSequence);
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
    modelProgress,
    inferenceActivityPhase,
    error,
    warning,
    streamingSegmentIndex,
    hasBackgroundActivity,
    reconnecting,
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
    markRecentlyStreaming,
  };
}
