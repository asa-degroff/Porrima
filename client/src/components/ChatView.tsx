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

function formatCtxWindow(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + "K";
  return n.toString();
}

interface Props {
  chatId: string | null;
  chatTitle: string;
  messages: ChatMessage[];
  streaming: boolean;
  streamingThinking: string;
  activeTools: ToolStatus[];
  artifacts: Artifact[];
  generatedImages: GeneratedImage[];
  totalUsage: MessageUsage;
  compaction?: { removedCount: number; remainingCount: number } | null;
  contextWindow: number;
  error: string | null;
  warning: StreamWarning | null;
  models: OllamaModel[];
  selectedModelId: string;
  systemPrompt: string;
  systemPromptPresets?: SystemPromptPreset[];
  ttsAutoReadEnabled?: boolean;
  onTtsAutoReadToggle?: (enabled: boolean) => void;
  onReadAloud?: (text: string) => void;
  playbackState?: import("../hooks/useTTS").PlaybackState;
  ttsBarVisible?: boolean;
  onSend: (text: string, images?: import("../types").ImageAttachment[]) => void;
  onEditMessage: (index: number, newText: string) => void;
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
  activeTools,
  artifacts,
  generatedImages,
  totalUsage,
  compaction,
  contextWindow,
  error,
  warning,
  models,
  selectedModelId,
  systemPrompt,
  systemPromptPresets,
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
  const [editingCtx, setEditingCtx] = useState(false);
  const [ctxInput, setCtxInput] = useState("");
  const [promptModal, setPromptModal] = useState<{ systemPrompt: string; tools: { name: string; description: string }[] } | null>(null);
  const [promptLoading, setPromptLoading] = useState(false);
  const inputRef = useRef<HTMLDivElement | null>(null);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillSelectorOpen, setSkillSelectorOpen] = useState(false);
  const [skillFilter, setSkillFilter] = useState("");
  const [inputRect, setInputRect] = useState<DOMRect | null>(null);
  
  useEffect(() => {
    fetchSkills(projectId).then(setSkills).catch(() => setSkills([]));
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
    isNearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
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
  useEffect(() => {
    if (messages.length > prevMessageCountRef.current) {
      isNearBottomRef.current = true;
    }
    prevMessageCountRef.current = messages.length;
  }, [messages]);

  // Auto-scroll via ResizeObserver on the content div (fires before paint).
  // Also observes the scroll container for when the input textarea resizes.
  // Depends on chatId so the observer re-attaches when switching from no-chat to a chat.
  useEffect(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll) return;
    const observer = new ResizeObserver(() => {
      if (isNearBottomRef.current) {
        scroll.scrollTop = scroll.scrollHeight;
      }
    });
    if (content) observer.observe(content);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, [chatId]);

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
      <div className="px-3 md:px-6 py-3 border-b border-white/10 flex items-center justify-between gap-3 backdrop-blur-sm bg-white/[0.03] relative z-20">
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
            <TokenIndicator usage={totalUsage} contextWindow={contextWindow} compaction={compaction} />
          </span>
          {/* Context window editor — hidden on mobile alongside token indicator */}
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
              <button
                className={`text-xs px-1.5 py-0.5 rounded hover:bg-white/10 transition-colors ${
                  hasContextWindowOverride ? "text-blue-300/70" : "text-white/30"
                }`}
                title={hasContextWindowOverride
                  ? `Custom context window (model default: ${formatCtxWindow(modelContextWindow)})`
                  : "Click to set custom context window"
                }
                onClick={() => {
                  setCtxInput(String(contextWindow));
                  setEditingCtx(true);
                }}
              >
                {formatCtxWindow(contextWindow)}
              </button>
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
      />

      {/* Messages */}
      <div className="flex-1 relative min-h-0">
        <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto px-3 md:px-6 py-3 md:py-4" style={{ paddingBottom: ttsBarVisible ? "180px" : "140px" }}>
          <div ref={contentRef}>
            {messages.length === 0 && (
              <div className="flex items-center justify-center h-full">
                <p className="text-white/25 text-sm">
                  Send a message to start the conversation
                </p>
              </div>
            )}
            {messages.map((msg, i) => {
              const isLast = i === messages.length - 1;
              return (
                <div key={`${msg.timestamp}-${i}`} className={!isLast ? "message-item" : undefined}>
                  <MessageBubble
                    message={msg}
                    isStreaming={streaming}
                    isLast={isLast}
                    streamingThinking={isLast ? streamingThinking : undefined}
                    activeTools={isLast ? activeTools : undefined}
                    artifacts={isLast && streaming ? artifacts : undefined}
                    generatedImages={isLast && streaming ? generatedImages : undefined}
                    editable={msg.role === "user" && !streaming && isOnline}
                    onEditMessage={msg.role === "user" ? onEditMessage : undefined}
                    messageIndex={i}
                    availableSkills={skills.map(s => s.name)}
                    streamingSegmentIndex={streamingSegmentIndex}
                  />
                </div>
              );
            })}
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
        <div className="absolute inset-0 pointer-events-none z-10 shadow-[inset_0_16px_80px_-16px_rgba(0,0,0,0.35),inset_0px_-16px_80px_-16px_rgba(0,0,0,0.35)]" />
      </div>

      {/* Input */}
      <div style={ttsBarVisible ? { paddingBottom: "56px" } : undefined}>
        <MessageInput
          chatId={chatId}
          onSend={onSend}
          disabled={!chatId}
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
            
            // Get the full text to find the last "/"
            const fullText = editor.innerText;
            const lastSlashIndex = fullText.lastIndexOf("/");
            if (lastSlashIndex === -1) {
              setSkillSelectorOpen(false);
              editor.focus();
              return;
            }
            
            // Get text before the slash
            const textBeforeSlash = fullText.slice(0, lastSlashIndex);
            
            // Save scroll position
            const scrollTop = editor.scrollTop;
            
            // Save non-text children (image previews, etc.)
            const preservedNodes: Node[] = [];
            for (let i = 0; i < editor.childNodes.length; i++) {
              const child = editor.childNodes[i];
              if (child.nodeType !== Node.TEXT_NODE) {
                preservedNodes.push(child);
              }
            }
            
            // Create the skill chip
            const chip = document.createElement('span');
            chip.className = 'skill-chip';
            chip.style.cssText = 'display:inline-block;padding:2px 8px;margin:0 4px;background:rgba(59,130,246,0.25);border:1px solid rgba(59,130,246,0.4);border-radius:12px;font-size:12px;color:rgb(147,197,253);font-weight:500;vertical-align:middle;';
            chip.textContent = `/${skillName}`;
            chip.setAttribute('data-skill', skillName);
            chip.setAttribute('contenteditable', 'false');
            
            // Clear and rebuild
            editor.textContent = "";
            
            // Restore preserved nodes first
            for (const node of preservedNodes) {
              editor.appendChild(node);
            }
            
            // Add text before slash
            if (textBeforeSlash) {
              editor.appendChild(document.createTextNode(textBeforeSlash));
            }
            
            // Add the chip
            editor.appendChild(chip);
            
            // Add trailing space
            editor.appendChild(document.createTextNode(" "));
            
            // Position cursor after the chip
            const newRange = document.createRange();
            newRange.setStartAfter(chip.nextSibling!);
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
