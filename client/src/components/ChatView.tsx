import { useEffect, useRef, useState, useCallback } from "react";
import type { Artifact, ChatMessage, GeneratedImage, MessageUsage, OllamaModel, SystemPromptPreset } from "../types";
import type { ToolStatus, StreamWarning, SkillInfo } from "../api/client";
import { fetchRenderedPrompt, fetchSkills } from "../api/client";
import { MessageBubble } from "./MessageBubble";
import { MessageInput } from "./MessageInput";
import { ModelSelector } from "./ModelSelector";
import { TokenIndicator } from "./TokenIndicator";
import { SystemPromptEditor } from "./SystemPromptEditor";
import { OfflineIndicator } from "./OfflineIndicator";
import { BlockIndicator } from "./BlockIndicator";
import { SkillSelector } from "./SkillSelector";

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

// Stable empty array reference for skills - avoids new [] on every render
const emptySkills: string[] = [];

interface Props {
  chatId: string | null;
  chatTitle: string;
  messages: ChatMessage[];
  streaming: boolean;
  streamingThinking: string;
  streamingThinkingActive: boolean;
  streamingThinkingAccumulatedMs: number;
  streamingThinkingLastStartRef: React.RefObject<number>;
  activeTools: ToolStatus[];
  artifacts: Artifact[];
  generatedImages: GeneratedImage[];
  totalUsage: MessageUsage;
  compacting?: boolean;
  compaction?: { removedCount: number; remainingCount: number } | null;
  hasCompactionSummary?: boolean;
  contextWindow: number;
  error: string | null;
  warning: StreamWarning | null;
  models: OllamaModel[];
  selectedModelId: string;
  systemPrompt: string;
  systemPromptPresets?: SystemPromptPreset[];
  chatType?: string;
  ttsAutoReadEnabled?: boolean;
  onTtsAutoReadToggle?: (enabled: boolean) => void;
  onReadAloud?: (text: string) => void;
  playbackState?: import("../hooks/useTTS").PlaybackState;
  ttsBarVisible?: boolean;
  onSend: (text: string, images?: import("../types").ImageAttachment[]) => void;
  onEditMessage: (index: number, newText: string, images?: import("../types").ImageAttachment[]) => void;
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
  activeSkills?: string[];
  projectId?: string;
  streamingSegmentIndex: number | null;
}

export function ChatView({
  chatId,
  chatTitle,
  messages,
  streaming,
  streamingThinking,
  streamingThinkingActive,
  streamingThinkingAccumulatedMs,
  streamingThinkingLastStartRef,
  activeTools,
  artifacts,
  generatedImages,
  totalUsage,
  compacting,
  compaction,
  hasCompactionSummary,
  contextWindow,
  error,
  warning,
  models,
  selectedModelId,
  systemPrompt,
  systemPromptPresets,
  chatType,
  ttsAutoReadEnabled = false,
  playbackState,
  ttsBarVisible,
  onTtsAutoReadToggle,
  onReadAloud,
  onSend,
  onEditMessage,
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
  activeSkills,
  projectId,
  streamingSegmentIndex,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const prevChatIdRef = useRef<string | null>(null);
  const prevMessageCountRef = useRef(0);
  const manualScrollOverrideRef = useRef(false);
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
  }, [streaming]);

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
      {/* Chat Header */}
      <div className="px-3 md:px-6 py-3 border-b border-white/10 flex items-center justify-between gap-3 backdrop-blur-xs bg-white/[0.03] relative z-20">
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
                <span key={skill} className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 border border-blue-400/30 text-blue-300">
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
          <span className="hidden md:contents">
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
              <TokenIndicator
                usage={totalUsage}
                contextWindow={contextWindow}
                compacting={compacting}
                compaction={compaction}
                hasCompactionSummary={hasCompactionSummary}
                onClick={messages.length === 0 ? () => {
                  setCtxInput(String(contextWindow));
                  setEditingCtx(true);
                } : undefined}
              />
            )}
          </span>
          <button
            className="hidden md:inline-block text-xs px-1.5 py-0.5 rounded hover:bg-white/10 transition-colors text-white/30 hover:text-white/50"
            title="View rendered system prompt and tools"
            onClick={openPromptViewer}
          >
            Prompt
          </button>
          {onTtsAutoReadToggle && (
            <button
              onClick={() => onTtsAutoReadToggle(!ttsAutoReadEnabled)}
              className={`p-1.5 rounded-lg transition-colors relative ${
                ttsAutoReadEnabled
                  ? "bg-blue-500/20 border border-blue-400/30 text-blue-300"
                  : "text-white/30 hover:text-white/50 hover:bg-white/5"
              }`}
              title={ttsAutoReadEnabled ? "Auto-read enabled" : "Enable auto-read"}
              disabled={playbackState?.isLoading}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                {ttsAutoReadEnabled && !playbackState?.isLoading && (
                  <circle cx="19" cy="5" r="2" fill="currentColor" />
                )}
              </svg>
              {playbackState?.isLoading && (
                <span className="absolute -top-1 -right-1 w-4 h-4">
                  <svg className="animate-spin text-blue-300" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                </span>
              )}
            </button>
          )}
          <ModelSelector
            models={models}
            selectedId={selectedModelId}
            onChange={onModelChange}
            disabled={streaming}
          />
        </div>
      </div>

      {/* System Prompt */}
      <SystemPromptEditor
        value={systemPrompt}
        onChange={onSystemPromptChange}
        disabled={streaming}
        presets={systemPromptPresets}
        isAgent={chatType === "agent" || chatType === "bluesky"}
      />

      {/* Messages */}
      <div className="flex-1 relative min-h-0">
        <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto overflow-x-hidden px-3 md:px-6 py-3 md:py-4" style={{ paddingBottom: ttsBarVisible ? "180px" : "140px", contentVisibility: "auto" }}>
          <div ref={contentRef}>
            {messages.length === 0 && (
              <div className="flex items-center justify-center h-full">
                <p className="text-white/25 text-sm">
                  Send a message to start the conversation
                </p>
              </div>
            )}
            {messages.length > 200 && (
              <div className="text-center py-2">
                <span className="text-xs text-white/30">{messages.length - 200} earlier messages not shown</span>
              </div>
            )}
            {(() => {
              // Find the last compaction summary to determine context boundary
              let lastCompactionIndex = -1;
              for (let j = messages.length - 1; j >= 0; j--) {
                if (messages[j]._isCompactionSummary) { lastCompactionIndex = j; break; }
              }

              // Performance limit: only render the last 200 messages for long chats
              const MAX_RENDERED = 200;
              const startIndex = messages.length > MAX_RENDERED ? messages.length - MAX_RENDERED : 0;

              return messages.slice(startIndex).map((msg, sliceIdx) => {
                const i = startIndex + sliceIdx;
                const isLast = i === messages.length - 1;
                const isOutOfContext = lastCompactionIndex >= 0 && i < lastCompactionIndex;
                const stableKey = `msg-${i}-${msg.timestamp}-${msg.role}`;

                // Render "in context" divider after the compaction indicator
                const showContextResume = lastCompactionIndex >= 0
                  && i === lastCompactionIndex + 1
                  && !messages[lastCompactionIndex + 1]?._isCompactionSummary;

                return (
                  <div key={stableKey} className={!isLast ? "message-item" : undefined}>
                    {showContextResume && (
                      <div className="flex items-center gap-3 my-3 px-2">
                        <div className="flex-1 border-t border-green-400/20" />
                        <span className="text-[10px] text-green-400/50 uppercase tracking-wider font-medium whitespace-nowrap">In context</span>
                        <div className="flex-1 border-t border-green-400/20" />
                      </div>
                    )}
                    <div className={isOutOfContext ? "opacity-45" : undefined}>
                      <MessageBubble
                        message={msg}
                        isStreaming={streaming}
                        isLast={isLast}
                        streamingThinking={isLast ? streamingThinking : undefined}
                        streamingThinkingActive={isLast ? streamingThinkingActive : false}
                        streamingThinkingAccumulatedMs={isLast ? streamingThinkingAccumulatedMs : 0}
                        streamingThinkingLastStartRef={streamingThinkingLastStartRef}
                        activeTools={isLast ? activeTools : undefined}
                        artifacts={isLast && streaming ? artifacts : undefined}
                        generatedImages={isLast && streaming ? generatedImages : undefined}
                        editable={msg.role === "user" && !streaming && isOnline}
                        onEditMessage={msg.role === "user" ? onEditMessage : undefined}
                        messageIndex={i}
                        availableSkills={skills.length > 0 ? skills.map(s => s.name) : emptySkills}
                        streamingSegmentIndex={streamingSegmentIndex}
                        showStreamingIndicator={streaming && isLast && msg.role === "assistant"}
                      />
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
            {error && (
              <div className="mb-4 px-4 py-3 rounded-xl bg-red-500/10 border border-red-400/20 text-red-300 text-sm">
                {error}
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
            <span className="text-xs font-medium">New output</span>
          </button>
        )}
        <div className="absolute inset-0 pointer-events-none z-10 shadow-[inset_0_16px_80px_-16px_rgba(0,0,0,0.35),inset_0px_-16px_80px_-16px_rgba(0,0,0,0.35)]" />
      </div>

      {/* Input */}
      <div style={ttsBarVisible ? { paddingBottom: "56px" } : undefined}>
        <MessageInput
          chatId={chatId}
          onSend={onSend}
          disabled={!chatId || !!compacting}
          onAbort={onAbort}
          streaming={streaming}
          waitingForInput={waitingForInput}
          isOnline={isOnline}
          onSlashTyping={handleSlashTyping}
          onSlashDeleted={closeSkillSelector}
          inputRef={inputRef}
          availableSkills={skills.map(s => s.name)}
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
            chip.style.cssText = 'display:inline-block;padding:2px 8px;margin:0 4px;background:rgba(59,130,246,0.25);border:1px solid rgba(59,130,246,0.4);border-radius:12px;font-size:12px;color:rgb(147,197,253);font-weight:500;vertical-align:middle;';
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
