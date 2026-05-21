import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import type { Artifact, ChatMessage, GeneratedImage, InferenceActivityPhase, MessageUsage, ModelProgress, OllamaModel, SystemPromptPreset } from "../types";
import type { ArtifactRuntimeErrorReport, ToolStatus, StreamWarning, SkillInfo } from "../api/client";
import { fetchRenderedPrompt, fetchSkills } from "../api/client";
import { MessageBubble } from "./MessageBubble";
import { MidTurnCompactionIndicator } from "./CompactionIndicator";
import { MessageInput } from "./MessageInput";
import { ModelSelector } from "./ModelSelector";
import { TokenIndicator } from "./TokenIndicator";
import { SystemPromptEditor } from "./SystemPromptEditor";
import { OfflineIndicator } from "./OfflineIndicator";
import { BlockIndicator } from "./BlockIndicator";
import { SkillSelector } from "./SkillSelector";
import { PinnedPanel } from "./PinnedPanel";
import { usePinnedItem } from "../contexts/PinnedItemContext";
import { PrefillActivityIcon } from "./PrefillActivityIcon";

const hamburgerIconLg = (
  <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="3" y1="6" x2="21" y2="6" />
    <line x1="3" y1="12" x2="21" y2="12" />
    <line x1="3" y1="18" x2="21" y2="18" />
  </svg>
);

const hamburgerIconSm = (
  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="3" y1="6" x2="21" y2="6" />
    <line x1="3" y1="12" x2="21" y2="12" />
    <line x1="3" y1="18" x2="21" y2="18" />
  </svg>
);

// Hoisted static function - avoids recreation on every render
function formatCtxWindow(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + "K";
  return n.toString();
}

function formatProgressNumber(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function ModelProgressIndicator({ progress }: { progress: ModelProgress }) {
  const percent = typeof progress.progress === "number"
    ? Math.round(progress.progress * 100)
    : undefined;
  const tokenText = progress.processedTokens !== undefined && progress.promptTokens !== undefined
    ? `${formatProgressNumber(progress.processedTokens)} / ${formatProgressNumber(progress.promptTokens)}`
    : progress.promptTokens !== undefined
      ? `~${formatProgressNumber(progress.promptTokens)} tokens`
      : null;
  const label = progress.phase === "loading" ? "Loading model" : "Prefilling context";
  const eta = progress.estimatedRemainingMs !== undefined ? `~${formatDuration(progress.estimatedRemainingMs)} left` : null;
  const title = [
    label,
    tokenText,
    eta,
    progress.slotId !== undefined ? `slot ${progress.slotId}` : null,
  ].filter(Boolean).join(" - ");

  return (
    <div
      className="hidden md:flex items-center gap-2 px-2 py-1 text-[10px]"
      title={title}
      style={{ color: "rgba(var(--theme-accent), 0.75)" }}
    >
      <PrefillActivityIcon />
      <span className="whitespace-nowrap animate-pulse">
        {label}
        {percent !== undefined ? ` ${percent}%` : ""}
      </span>
      {tokenText && (
        <span className="whitespace-nowrap" style={{ color: "rgba(var(--theme-accent), 0.35)" }}>
          {tokenText}
        </span>
      )}
      {eta && (
        <span className="hidden lg:inline whitespace-nowrap" style={{ color: "rgba(var(--theme-accent), 0.35)" }}>
          {eta}
        </span>
      )}
      {percent !== undefined && (
        <div
          className="hidden lg:block w-14 h-1 rounded-full overflow-hidden"
          style={{ backgroundColor: "rgba(var(--theme-accent), 0.1)" }}
        >
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${percent}%`, backgroundColor: "rgba(var(--theme-accent), 0.55)" }}
          />
        </div>
      )}
    </div>
  );
}

// Stable empty array reference for skills - avoids new [] on every render
const emptySkills: string[] = [];

interface DisplayMessage {
  message: ChatMessage;
  localStartIdx: number;
  localEndIdx: number;
  streamingSegmentOffset: number;
}

function mergeToolLoopMessages(group: ChatMessage[]): ChatMessage {
  const last = group[group.length - 1];
  const content = group
    .map((m) => m.content)
    .filter((text) => text && text.trim())
    .join("\n\n");
  const thinking = group
    .map((m) => m.thinking)
    .filter((text): text is string => !!text && text.trim().length > 0)
    .join("\n\n");
  const thinkingDurationMs = group.reduce((sum, m) => sum + (m.thinkingDurationMs || 0), 0);
  const toolCalls = group.flatMap((m) => m.toolCalls || []);
  const toolResults = group.flatMap((m) => m.toolResults || []);
  const artifacts = group.flatMap((m) => m.artifacts || []);
  const generatedImages = group.flatMap((m) => m.generatedImages || []);
  const visuals = group.flatMap((m) => m.visuals || []);
  const segments = group.flatMap((m) => m.segments || []);

  return {
    ...last,
    content,
    thinking: thinking || undefined,
    thinkingDurationMs: thinkingDurationMs > 0 ? thinkingDurationMs : undefined,
    usage: last.usage,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    toolResults: toolResults.length ? toolResults : undefined,
    artifacts: artifacts.length ? artifacts : undefined,
    generatedImages: generatedImages.length ? generatedImages : undefined,
    visuals: visuals.length ? visuals : undefined,
    segments: segments.length ? segments : undefined,
    _toolLoopId: last._toolLoopId,
    _toolLoopFragment: undefined,
  };
}

function buildDisplayMessages(messages: ChatMessage[]): DisplayMessage[] {
  const display: DisplayMessage[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === "system" || (msg._isSystemMessage && msg._isMidTurnCompaction)) {
      i++;
      continue;
    }

    if (msg.role === "assistant" && msg._isSynthesisMessage) {
      const groupStart = i;
      const group: ChatMessage[] = [msg];
      let groupEnd = i;
      i++;
      while (i < messages.length) {
        if (messages[i]._isSystemMessage && messages[i]._isMidTurnCompaction) break;
        if (messages[i].role === "system") {
          i++;
          continue;
        }
        if (messages[i].role !== "assistant" || !messages[i]._isSynthesisMessage) break;
        group.push(messages[i]);
        groupEnd = i;
        i++;
      }

      const streamingSegmentOffset = group
        .slice(0, -1)
        .reduce((sum, m) => sum + (m.segments?.length || 0), 0);

      display.push({
        message: group.length === 1 ? msg : mergeToolLoopMessages(group),
        localStartIdx: groupStart,
        localEndIdx: groupEnd,
        streamingSegmentOffset,
      });
      continue;
    }

    if (msg.role === "assistant" && msg._toolLoopId) {
      const groupStart = i;
      const group: ChatMessage[] = [msg];
      let groupEnd = i;
      i++;
      while (
        i < messages.length
      ) {
        if (messages[i]._isSystemMessage && messages[i]._isMidTurnCompaction) {
          break;
        }
        if (messages[i].role === "system") {
          i++;
          continue;
        }
        if (messages[i].role !== "assistant" || messages[i]._toolLoopId !== msg._toolLoopId) break;
        group.push(messages[i]);
        groupEnd = i;
        i++;
      }

      const streamingSegmentOffset = group
        .slice(0, -1)
        .reduce((sum, m) => sum + (m.segments?.length || 0), 0);

      display.push({
        message: group.length === 1 ? msg : mergeToolLoopMessages(group),
        localStartIdx: groupStart,
        localEndIdx: groupEnd,
        streamingSegmentOffset,
      });
      continue;
    }

    display.push({
      message: msg,
      localStartIdx: i,
      localEndIdx: i,
      streamingSegmentOffset: 0,
    });
    i++;
  }

  return display;
}

interface Props {
  chatId: string | null;
  chatTitle: string;
  messages: ChatMessage[];
  messageOffset?: number;
  messageTotal?: number;
  hasMoreMessages?: boolean;
  olderMessagesLoading?: boolean;
  streaming: boolean;
  streamingThinking: string;
  streamingThinkingActive: boolean;
  streamingThinkingAccumulatedMs: number;
  streamingThinkingLastStartRef: React.RefObject<number>;
  activeTools: ToolStatus[];
  artifacts: Artifact[];
  generatedImages: GeneratedImage[];
  totalUsage: MessageUsage;
  isUsageEstimated?: boolean;
  compacting?: boolean;
  compaction?: { removedCount: number; remainingCount: number } | null;
  modelProgress?: ModelProgress | null;
  inferenceActivityPhase?: InferenceActivityPhase | null;
  hasCompactionSummary?: boolean;
  contextWindow: number;
  error: string | null;
  warning: StreamWarning | null;
  models: OllamaModel[];
  selectedModelId: string;
  systemPrompt: string;
  systemPromptPresets?: SystemPromptPreset[];
  chatType?: string;
  isSynthesizing?: boolean;
  ttsEnabled?: boolean;
  ttsAutoReadEnabled?: boolean;
  onTtsAutoReadToggle?: (enabled: boolean) => void;
  onReadAloud?: (text: string) => void;
  playbackState?: import("../hooks/useTTS").PlaybackState;
  ttsBarVisible?: boolean;
  onSend: (text: string, images?: import("../types").ImageAttachment[]) => void;
  onEditMessage: (index: number, newText: string, images?: import("../types").ImageAttachment[], messageSequence?: number) => void;
  onRetryMessage?: (index: number, messageSequence?: number) => void;
  onLoadOlderMessages?: () => Promise<boolean>;
  onAbort: () => void;
  onModelChange: (modelId: string) => void;
  onSystemPromptChange: (value: string) => void;
  onContextWindowChange: (value: number | null) => void;
  modelContextWindow: number;
  hasContextWindowOverride: boolean;
  waitingForInput: boolean;
  onOpenSidebar: () => void;
  isOnline?: boolean;
  queueProcessing?: boolean;
  reconnecting?: boolean;
  activeSkills?: string[];
  projectId?: string;
  streamingSegmentIndex: number | null;
  onArtifactRuntimeError?: (report: ArtifactRuntimeErrorReport) => void;
  headerImageEnabled?: boolean;
}

export function ChatView({
  chatId,
  chatTitle,
  messages,
  messageOffset = 0,
  messageTotal,
  hasMoreMessages = false,
  olderMessagesLoading = false,
  streaming,
  streamingThinking,
  streamingThinkingActive,
  streamingThinkingAccumulatedMs,
  streamingThinkingLastStartRef,
  activeTools,
  artifacts,
  generatedImages,
  totalUsage,
  isUsageEstimated,
  compacting,
  compaction,
  modelProgress,
  inferenceActivityPhase,
  hasCompactionSummary,
  contextWindow,
  error,
  warning,
  models,
  selectedModelId,
  systemPrompt,
  systemPromptPresets,
  chatType,
  isSynthesizing = false,
  ttsEnabled = false,
  ttsAutoReadEnabled = false,
  playbackState,
  ttsBarVisible,
  onTtsAutoReadToggle,
  onReadAloud,
  onSend,
  onEditMessage,
  onRetryMessage,
  onLoadOlderMessages,
  onAbort,
  onModelChange,
  onSystemPromptChange,
  onContextWindowChange,
  modelContextWindow,
  hasContextWindowOverride,
  waitingForInput,
  onOpenSidebar,
  isOnline = true,
  queueProcessing = false,
  reconnecting = false,
  activeSkills,
  projectId,
  streamingSegmentIndex,
  onArtifactRuntimeError,
  headerImageEnabled = false,
}: Props) {
  const { unpin, pinnedItem } = usePinnedItem();
  useEffect(() => {
    unpin();
  }, [chatId, unpin]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const prevChatIdRef = useRef<string | null>(null);
  const prevMessageCountRef = useRef(0);
  const manualScrollOverrideRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const [editingCtx, setEditingCtx] = useState(false);
  const [ctxInput, setCtxInput] = useState("");
  const [promptModal, setPromptModal] = useState<{ systemPrompt: string; tools: { name: string; description: string }[] } | null>(null);
  const [promptLoading, setPromptLoading] = useState(false);
  const inputRef = useRef<HTMLDivElement | null>(null);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillSelectorOpen, setSkillSelectorOpen] = useState(false);
  const [skillFilter, setSkillFilter] = useState("");
  const [inputRect, setInputRect] = useState<DOMRect | null>(null);
  const [scrollPaused, setScrollPaused] = useState(false);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const displayMessages = useMemo(() => buildDisplayMessages(messages), [messages]);
  const availableSkillNames = useMemo(
    () => skills.length > 0 ? skills.map((skill) => skill.name) : emptySkills,
    [skills]
  );

  // Auto-dismiss network-related errors after a delay, since the
  // OfflineIndicator in the header already communicates connection state.
  // Switching chats resets the dismissed-error tracking.
  useEffect(() => {
    setDismissedError(null);
  }, [chatId]);
  useEffect(() => {
    if (!error) {
      setDismissedError(null);
      return;
    }
    // Auto-dismiss transient network errors after 8 seconds
    const isNetworkError = error.includes("Network unavailable") || error.includes("Connection error");
    if (isNetworkError) {
      const timer = setTimeout(() => setDismissedError(error), 8000);
      return () => clearTimeout(timer);
    } else {
      // For persistent errors, don't auto-dismiss, but still allow manual dismissal
      setDismissedError(null);
    }
  }, [error]);

  const displayError = dismissedError === error ? null : error;
  
  // Cache skills by projectId to avoid refetching on every render
  const skillsCache = useRef<Map<string, SkillInfo[]>>(new Map());
  
  useEffect(() => {
    // Use empty string as cache key for non-project chats (no projectId)
    const cacheKey = projectId || "";
    
    // Check cache first
    const cached = skillsCache.current.get(cacheKey);
    if (cached) {
      setSkills(cached);
      return;
    }
    
    // Fetch skills (global skills are always available, project skills added if projectId exists)
    fetchSkills(projectId).then((fetched) => {
      skillsCache.current.set(cacheKey, fetched);
      setSkills(fetched);
    }).catch(() => {
      setSkills([]);
    });
  }, [projectId]);
  
  const handleSlashTyping = useCallback((filterText: string = "", cursorRect?: DOMRect) => {
    if (!inputRef.current) return;
    // Use cursor position if available, otherwise fall back to input rect
    const rect = cursorRect || inputRef.current.getBoundingClientRect();
    setInputRect(rect);
    setSkillFilter(filterText);
    setSkillSelectorOpen(true);
  }, []);
  
  const closeSkillSelector = useCallback(() => {
    setSkillSelectorOpen(false);
  }, []);

  const openPromptViewer = useCallback(async () => {
    if (!chatId) return;
    setPromptLoading(true);
    setPromptModal(null);
    try {
      const data = await fetchRenderedPrompt(chatId);
      setPromptModal(data);
    } catch {
      setPromptModal({ systemPrompt: "(Failed to load)", tools: [] });
    } finally {
      setPromptLoading(false);
    }
  }, [chatId]);

  // Track whether user is scrolled near the bottom
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    if (
      el.scrollTop < 80 &&
      hasMoreMessages &&
      onLoadOlderMessages &&
      !loadingOlderRef.current &&
      !olderMessagesLoading
    ) {
      loadingOlderRef.current = true;
      const previousScrollHeight = el.scrollHeight;
      const previousScrollTop = el.scrollTop;
      onLoadOlderMessages()
        .then((loaded) => {
          if (!loaded || !scrollRef.current) return;
          const nextEl = scrollRef.current;
          requestAnimationFrame(() => {
            nextEl.scrollTop = nextEl.scrollHeight - previousScrollHeight + previousScrollTop;
          });
        })
        .catch(() => {})
        .finally(() => {
          loadingOlderRef.current = false;
        });
    }

    const threshold = 80;
    const wasNearBottom = isNearBottomRef.current;
    isNearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    
    // If we're streaming and user scrolls away from bottom, enable manual override
    if (streaming && wasNearBottom && !isNearBottomRef.current) {
      manualScrollOverrideRef.current = true;
      setScrollPaused(true);
    }
    
    // If user scrolls back to bottom, disable override
    if (isNearBottomRef.current && manualScrollOverrideRef.current) {
      manualScrollOverrideRef.current = false;
      setScrollPaused(false);
    }
  }, [streaming, hasMoreMessages, olderMessagesLoading, onLoadOlderMessages]);

  useEffect(() => {
    return () => {
      loadingOlderRef.current = false;
    };
  }, []);

  // Scroll to bottom when switching chats
  useEffect(() => {
    if (chatId !== prevChatIdRef.current) {
      prevChatIdRef.current = chatId;
      isNearBottomRef.current = true;
      if (scrollRef.current) {
        const el = scrollRef.current;
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight;
        });
      }
    }
  }, [chatId, messages]);

  // Force near-bottom when new messages are added (user sent or assistant placeholder)
  // BUT only if user hasn't manually scrolled away during streaming
  useEffect(() => {
    if (messages.length > prevMessageCountRef.current) {
      // Only force near-bottom if not in manual override mode
      if (!manualScrollOverrideRef.current) {
        isNearBottomRef.current = true;
      }
    }
    prevMessageCountRef.current = messages.length;
  }, [messages]);
  
  // Reset scroll pause state when streaming stops
  useEffect(() => {
    if (!streaming && scrollPaused) {
      setScrollPaused(false);
      manualScrollOverrideRef.current = false;
    }
  }, [streaming, scrollPaused]);

  // Auto-scroll via ResizeObserver on the content div (fires before paint).
  // Also observes the scroll container for when the input textarea resizes.
  // Depends on chatId so the observer re-attaches when switching from no-chat to a chat.
  useEffect(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll) return;
    const observer = new ResizeObserver(() => {
      // Only auto-scroll if near bottom AND user hasn't manually scrolled away
      if (isNearBottomRef.current && !manualScrollOverrideRef.current) {
        scroll.scrollTop = scroll.scrollHeight;
      }
    });
    if (content) observer.observe(content);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, [chatId]);
  
  // Scroll to bottom handler (for the "scroll to bottom" button)
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      manualScrollOverrideRef.current = false;
      isNearBottomRef.current = true;
      setScrollPaused(false);
    }
  }, []);

  if (!chatId) {
    return (
      <div className="flex-1 flex flex-col">
        <div className="px-3 py-3 md:hidden">
          <button
            onClick={onOpenSidebar}
            className="text-white/50 hover:text-white/80 transition-colors p-1.5 rounded-lg hover:bg-white/5"
          >
            {hamburgerIconLg}
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="text-6xl mb-4 opacity-20">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="64"
                height="64"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="mx-auto text-white/20"
              >
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <p className="text-white/30 text-lg">
              Select a chat or start a new one
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Chat Header — fixed min-height so it doesn't shift between chat types or when the prefill indicator appears */}
      <div className="px-3 md:px-6 min-h-[3rem] border-b border-white/10 flex items-center justify-between gap-3 backdrop-blur-xs bg-white/[0.03] relative z-20">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={onOpenSidebar}
            className="md:hidden text-white/50 hover:text-white/80 transition-colors p-1 rounded-lg hover:bg-white/5 shrink-0"
          >
            {hamburgerIconSm}
          </button>
          <h2 className="text-sm font-medium text-white/80 truncate">
            {chatTitle}
          </h2>
          {activeSkills?.length ? (
            <div className="hidden md:flex items-center gap-1">
              {activeSkills.map(skill => (
                <span key={skill} className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(var(--theme-accent-muted))', border: '1px solid rgba(var(--theme-accent-border))', color: 'rgba(var(--theme-accent-text))' }}>
                  {skill}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <OfflineIndicator isOnline={isOnline} queueProcessing={queueProcessing} />
          <span className="hidden md:contents">
            <BlockIndicator projectId={projectId} />
          </span>
          {/* Context window editor — integrated into TokenIndicator */}
          {editingCtx ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                const val = parseInt(ctxInput, 10);
                if (val && val > 0) onContextWindowChange(val);
                setEditingCtx(false);
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <input
                type="number"
                className="w-20 px-1.5 py-0.5 text-xs bg-white/10 border border-white/20 rounded text-white/80 outline-none focus:border-white/40"
                value={ctxInput}
                onChange={(e) => setCtxInput(e.target.value)}
                autoFocus
                onBlur={() => setEditingCtx(false)}
                min={1}
              />
              {hasContextWindowOverride && (
                <button
                  type="button"
                  className="text-xs text-white/30 hover:text-white/60 px-1"
                  title="Reset to model default"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onContextWindowChange(null);
                    setEditingCtx(false);
                  }}
                >
                  &#x21ba;
                </button>
              )}
            </form>
          ) : (
            streaming && modelProgress && modelProgress.showIndicator ? (
              <ModelProgressIndicator progress={modelProgress} />
            ) : (
              <TokenIndicator
                usage={totalUsage}
                isEstimated={isUsageEstimated}
                contextWindow={contextWindow}
                compacting={compacting}
                compaction={compaction}
                hasCompactionSummary={hasCompactionSummary}
                onClick={messages.length === 0 ? () => {
                  setCtxInput(String(contextWindow));
                  setEditingCtx(true);
                } : undefined}
              />
            )
          )}
          <button
            className="hidden md:inline-block text-xs px-1.5 py-0.5 rounded hover:bg-white/10 transition-colors text-white/30 hover:text-white/50"
            title="View rendered system prompt and tools"
            onClick={openPromptViewer}
          >
            Prompt
          </button>
          {/* Model switcher — only for quick chats. Agent/project/system chats use the configured default model to preserve KV cache warmth. */}
          {chatType === "quick" ? (
            <ModelSelector
              models={models}
              selectedId={selectedModelId}
              onChange={onModelChange}
              disabled={streaming}
            />
          ) : headerImageEnabled ? (
            <div
              className="hidden md:flex relative isolate w-[38px] h-[38px] shrink-0 rounded-lg overflow-hidden before:absolute before:inset-0 before:z-20 before:rounded-lg before:border before:border-black/[0.1] before:pointer-events-none after:absolute after:inset-px after:z-10 after:rounded-[calc(var(--radius-lg)-1px)] after:shadow-[inset_0_1px_5px_rgba(0,0,0,1.0)] after:pointer-events-none"
              title="Header image"
            >
              <img
                src="/api/settings/header-image/thumb"
                alt=""
                className="absolute inset-px z-0 w-[calc(100%-2px)] h-[calc(100%-2px)] rounded-[calc(var(--radius-lg)-1px)] object-cover"
              />
            </div>
          ) : (
            <span className="hidden md:inline-flex items-center h-7 text-[11px] text-white/25 select-none" title="Uses your default model">
              {models.find((m) => m.id === selectedModelId)?.name || selectedModelId}
            </span>
          )}
        </div>
      </div>

      {/* System Prompt — hidden after first message (preset changes would invalidate the entire KV cache) */}
      <SystemPromptEditor
        value={systemPrompt}
        onChange={onSystemPromptChange}
        disabled={streaming}
        presets={systemPromptPresets}
        isAgent={chatType === "agent"}
        hidden={messages.length > 0}
      />

      <div className="flex-1 flex flex-row min-h-0 min-w-0 relative">

      {/* Messages */}
      <div className="flex-1 relative min-h-0 min-w-0">
        <div ref={scrollRef} onScroll={handleScroll} className="chat-scroll-container h-full overflow-y-auto overflow-x-hidden px-2.5 md:px-5 py-3 md:py-4" style={{ paddingBottom: ttsBarVisible ? "180px" : "140px", scrollbarGutter: "stable" }}>
          <div ref={contentRef}>
            {messages.length === 0 && (
              <div className="flex items-center justify-center h-full">
                <p className="text-white/25 text-sm">
                  Send a message to start the conversation
                </p>
              </div>
            )}
            {(hasMoreMessages || olderMessagesLoading) && (
              <div className="text-center py-2">
                <span className="text-xs text-white/30">
                  {olderMessagesLoading
                    ? "Loading earlier messages..."
                    : `${messageOffset} earlier message${messageOffset === 1 ? "" : "s"} available${messageTotal ? ` (${messages.length}/${messageTotal} loaded)` : ""}`}
                </span>
              </div>
            )}
            {(() => {
              const lastDisplayEndIdx = displayMessages.at(-1)?.localEndIdx ?? -1;
              return displayMessages.map(({ message: msg, localStartIdx, localEndIdx, streamingSegmentOffset }, displayIndex) => {
                const i = messageOffset + localStartIdx;
                const isLast = localEndIdx === lastDisplayEndIdx;
                const isOutOfContext = !!msg._outOfContext;
                const isSystemMessage = !!msg._isSystemMessage;
                const isMidTurnCompaction = !!msg._isMidTurnCompaction;
                const stableKey = localStartIdx === localEndIdx
                  ? `msg-${i}-${msg.timestamp}-${msg.role}`
                  : `msg-${i}-${messageOffset + localEndIdx}-${msg._toolLoopId || msg.timestamp}`;

                // Show "In context" divider at the transition from out-of-context to in-context
                const prevMsg = displayIndex > 0 ? displayMessages[displayIndex - 1].message : null;
                const showContextResume = !isOutOfContext && !msg._isCompactionSummary
                  && prevMsg && (prevMsg._outOfContext || prevMsg._isCompactionSummary);
                const adjustedStreamingSegmentIndex =
                  isLast && streamingSegmentIndex !== null
                    ? streamingSegmentIndex + streamingSegmentOffset
                    : streamingSegmentIndex;
                // In a tool loop, msg.thinking is merged from prior fragments while
                // streamingThinking is the live current fragment. Between fragments
                // (after onMessageComplete resets bg.thinking, before the next fragment
                // begins), streamingThinking is empty — fall back to msg.thinking so the
                // block stays visible instead of blinking out.
                const bubbleStreamingThinking = isLast
                  ? (msg.thinking && streamingThinking
                      ? `${msg.thinking}\n\n${streamingThinking}`
                      : streamingThinking || msg.thinking || undefined)
                  : undefined;
                const bubbleStreamingThinkingAccumulatedMs =
                  isLast ? (msg.thinkingDurationMs || 0) + streamingThinkingAccumulatedMs : 0;

                return (
                  <div key={stableKey} className={!isLast ? "message-item" : undefined}>
                    {showContextResume && (
                      <div className="flex items-center gap-3 my-3 px-2">
                        <div className="flex-1 border-t border-green-400/20" />
                        <span className="text-[10px] text-green-400/50 uppercase tracking-wider font-medium whitespace-nowrap">In context</span>
                        <div className="flex-1 border-t border-green-400/20" />
                      </div>
                    )}
                    <div className={isOutOfContext ? "opacity-40" : undefined}>
                      {isMidTurnCompaction ? (
                        <MidTurnCompactionIndicator
                          midTurn={{
                            removedCount: msg._compactionRemovedCount,
                            cycle: msg._compactionCycle,
                            timestamp: msg.timestamp,
                          }}
                        />
                      ) : isSystemMessage ? (
                        <div className="mx-2 my-1 rounded-lg bg-amber-500/5 border border-amber-400/10 px-3 py-2 text-[10px] text-amber-200/40 font-medium uppercase tracking-wider">
                          System Message
                        </div>
                      ) : undefined}
                      {!isMidTurnCompaction && (
                      <MessageBubble
                        message={msg}
                        isStreaming={streaming}
                        isLast={isLast}
                        streamingThinking={bubbleStreamingThinking}
                        streamingThinkingActive={isLast ? streamingThinkingActive : false}
                        streamingThinkingAccumulatedMs={bubbleStreamingThinkingAccumulatedMs}
                        streamingThinkingLastStartRef={streamingThinkingLastStartRef}
                        activeTools={isLast ? activeTools : undefined}
                        artifacts={isLast && streaming ? artifacts : undefined}
                        generatedImages={isLast && streaming ? generatedImages : undefined}
                        editable={msg.role === "user" && !streaming && isOnline && !isOutOfContext}
                        onEditMessage={msg.role === "user" ? onEditMessage : undefined}
                        onRetryMessage={msg.role === "user" ? onRetryMessage : undefined}
                        messageIndex={i}
                        messageSequence={msg._rowSequence}
                        availableSkills={availableSkillNames}
                        streamingSegmentIndex={adjustedStreamingSegmentIndex}
                        showStreamingIndicator={streaming && isLast && msg.role === "assistant"}
                        inferenceActivityPhase={isLast ? inferenceActivityPhase : null}
                        onReadAloud={ttsEnabled ? onReadAloud : undefined}
                        isPlayingTts={ttsEnabled ? (playbackState?.isPlaying || false) : false}
                        chatId={chatId || undefined}
                        onArtifactRuntimeError={onArtifactRuntimeError}
                      />
                      )}
                    </div>
                  </div>
                );
              });
            })()}
            {warning && (
              <div className="mb-4 px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-400/20 text-amber-300 text-sm">
                {warning.message}
              </div>
            )}
            {reconnecting && (
              <div className="mb-4 px-3 py-2 rounded-lg bg-blue-500/8 border border-blue-400/15 text-blue-300/80 text-xs flex items-center gap-2">
                <div className="w-3 h-3 border-2 border-blue-400/30 border-t-blue-400 rounded-full animate-spin" />
                <span>Reconnecting…</span>
              </div>
            )}
            {displayError && (
              <div className="mb-4 px-3 py-2 rounded-lg bg-red-500/8 border border-red-400/15 text-red-300/80 text-xs flex items-center justify-between gap-3">
                <span>{displayError}</span>
                <button
                  onClick={() => setDismissedError(error!)}
                  className="text-red-300/40 hover:text-red-300/70 shrink-0"
                  aria-label="Dismiss error"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        </div>
        {/* Scroll to bottom button - appears when user scrolls away during streaming */}
        {scrollPaused && (
          <button
            onClick={scrollToBottom}
            className="absolute bottom-4 right-4 md:right-6 z-20 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/10 border border-white/20 text-white/70 hover:text-white hover:bg-white/15 hover:border-white/30 transition-all shadow-lg backdrop-blur-sm"
            title="Scroll to bottom"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14" />
              <path d="m19 12-7 7-7-7" />
            </svg>
            <span className="text-xs font-medium">New</span>
          </button>
        )}
      </div>

        {/* Vertical divider between messages and pinned panel (desktop only, only when pinned) */}
        {pinnedItem && <div className="hidden lg:block w-px bg-white/10" />}

        <PinnedPanel chatId={chatId || undefined} onArtifactRuntimeError={onArtifactRuntimeError} />

        {/* Vignette overlay — spans both messages and pinned panel */}
        <div className="absolute inset-0 pointer-events-none z-10 shadow-[inset_0_16px_80px_-16px_rgba(0,0,0,0.35),inset_0px_-16px_80px_-16px_rgba(0,0,0,0.35)]" />
      </div>

      {/* Input */}
      <div style={ttsBarVisible ? { paddingBottom: "56px" } : undefined}>
        <MessageInput
          chatId={chatId}
          onSend={onSend}
          disabled={!chatId || !!compacting || (chatType === "system" && isSynthesizing)}
          onAbort={onAbort}
          streaming={streaming}
          waitingForInput={waitingForInput}
          isOnline={isOnline}
          onSlashTyping={handleSlashTyping}
          onSlashDeleted={closeSkillSelector}
          inputRef={inputRef}
          availableSkills={availableSkillNames}
        />
      </div>

      {/* Skill Selector Popup */}
      {skillSelectorOpen && (
        <SkillSelector
          skills={skills}
          filterText={skillFilter}
          onSelect={(skillName: string) => {
            const editor = inputRef.current;
            if (!editor) return;
            
            const sel = window.getSelection();
            if (!sel || sel.rangeCount === 0) return;
            
            const range = sel.getRangeAt(0);
            
            // Find the text node containing the cursor and the slash being typed
            let textNode: Text | null = null;
            let container: Node = range.startContainer;
            
            // Walk up to find a text node or the editor itself
            while (container && container !== editor) {
              if (container.nodeType === Node.TEXT_NODE) {
                textNode = container as Text;
                break;
              }
              container = container.parentNode!;
            }
            
            // If no text node found, create one at cursor position
            if (!textNode) {
              textNode = document.createTextNode("");
              range.insertNode(textNode);
            }
            
            // Get the text content up to cursor position
            const textBeforeCursor = textNode.textContent!.slice(0, range.startOffset);
            const lastSlashInNode = textBeforeCursor.lastIndexOf("/");
            
            // Find the start position of the slash within this text node
            const slashStartIndex = lastSlashInNode >= 0 ? lastSlashInNode : 0;
            
            // Extract text before the slash (keep it)
            const textBeforeSlash = textNode.textContent!.slice(0, slashStartIndex);
            
            // Create the skill chip
            const chip = document.createElement('span');
            chip.className = 'skill-chip';
            chip.style.cssText = 'display:inline-block;padding:2px 8px;margin:0 4px;background:rgba(var(--theme-accent-muted));border:1px solid rgba(var(--theme-accent-border));border-radius:12px;font-size:12px;color:rgba(var(--theme-accent-text));font-weight:500;vertical-align:middle;';
            chip.textContent = `/${skillName}`;
            chip.setAttribute('data-skill', skillName);
            chip.setAttribute('contenteditable', 'false');
            
            // Save scroll position
            const scrollTop = editor.scrollTop;
            
            // Replace the /skill-name portion in the text node with the chip
            // Split the text node: keep text before slash, insert chip, add trailing space
            textNode.textContent = textBeforeSlash;
            
            // Insert chip after the text node
            textNode.parentNode?.insertBefore(chip, textNode.nextSibling);
            
            // Add trailing space after chip
            const spaceNode = document.createTextNode(" ");
            textNode.parentNode?.insertBefore(spaceNode, chip.nextSibling);
            
            // Position cursor after the space
            const newRange = document.createRange();
            newRange.setStartAfter(spaceNode);
            newRange.collapse(true);
            sel.removeAllRanges();
            sel.addRange(newRange);
            
            // Restore scroll
            editor.scrollTop = scrollTop;
            
            // Trigger input event
            const event = new Event("input", { bubbles: true });
            editor.dispatchEvent(event);
            
            setSkillSelectorOpen(false);
            editor.focus();
          }}
          onClose={closeSkillSelector}
          inputRect={inputRect}
        />
      )}

      {/* Rendered Prompt Viewer Modal */}
      {(promptModal || promptLoading) && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => { setPromptModal(null); setPromptLoading(false); }}
        >
          <div
            className="theme-primary-bg border theme-primary-border rounded-2xl w-full max-w-[640px] mx-4 max-h-[80vh] flex flex-col shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3 border-b theme-primary-border">
              <h3 className="text-sm font-medium theme-primary-text">Rendered Agent Context</h3>
              <button
                className="theme-primary-text hover:opacity-80 text-lg leading-none"
                onClick={() => { setPromptModal(null); setPromptLoading(false); }}
              >
                &times;
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              {promptLoading ? (
                <div className="flex items-center justify-center py-12">
                  <div className="w-5 h-5 border-2 theme-primary-border border-t-theme-primary-text rounded-full animate-spin" />
                  <span className="ml-3 text-sm theme-primary-text opacity-60">Loading prompt…</span>
                </div>
              ) : promptModal && (
                <>
                  <div>
                    <h4 className="text-xs font-medium theme-accent-text opacity-70 uppercase tracking-wider mb-2">System Prompt</h4>
                    <pre className="text-xs theme-primary-text opacity-90 font-mono whitespace-pre-wrap theme-accent-bg rounded-lg p-3 theme-accent-border max-h-[40vh] overflow-y-auto">
                      {promptModal.systemPrompt}
                    </pre>
                  </div>
                  {promptModal.tools.length > 0 && (
                    <div>
                      <h4 className="text-xs font-medium theme-accent-text opacity-70 uppercase tracking-wider mb-2">
                        Tools ({promptModal.tools.length})
                      </h4>
                      <div className="space-y-1.5">
                        {promptModal.tools.map((t) => (
                          <div key={t.name} className="text-xs theme-accent-bg rounded-lg px-3 py-2 theme-accent-border">
                            <span className="theme-secondary-text font-mono">{t.name}</span>
                            <span className="theme-primary-text opacity-60 ml-2">{t.description}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
