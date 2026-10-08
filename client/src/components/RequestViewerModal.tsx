import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  clearLlmRequests,
  fetchContextView,
  fetchLlmRequestDetail,
  fetchLlmRequests,
  type ContextView,
  type LlmRequestDetail,
  type LlmRequestSummary,
} from "../api/client";
import { Chevron } from "./ui/Chevron";

/**
 * Per-turn request viewer (docs/design/request-viewer.md).
 *
 * Tab "Requests": the wire-level log of every LLM call this chat made — one
 * row per provider request (a user turn fans out into several as the tool
 * loop iterates). Rows append live via `llm_request_start`/`llm_request_end`
 * SSE events (surfaced as `requestLogVersion` bumps). Expanding a row lazily
 * fetches the full rehydrated wire body + accumulated response.
 *
 * Layout is a tree — request entry → section nodes (message list, tool
 * definitions, response, raw JSON) → individual wire messages → message
 * content. The modal keeps **one scroll container** (the body): every nested
 * layer grows/shrinks the page inline instead of opening its own scrollbox.
 * The wire message list is tail-truncated (each iteration re-sends the whole
 * transcript, so the prefix is long and the recent tail is what gets
 * inspected); earlier messages collapse into a single expandable node, and
 * live in-progress requests keep following the tail as rows append.
 *
 * Tab "Context": the assembled system prompt with per-section token
 * attribution and full tool definitions including parameter schemas —
 * replaces the old "Rendered Agent Context" modal. Same single-scroller rule.
 */

interface Props {
  isOpen: boolean;
  onClose: () => void;
  chatId: string | null;
  /** Bumped by the request-log SSE events — drives live refresh. */
  requestLogVersion?: number;
}

type Tab = "requests" | "context";

// Number of trailing wire messages shown inline before the prefix collapses
// into an "earlier messages" node.
const MESSAGE_TAIL = 8;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTokens(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fmtCacheHit(d: LlmRequestSummary): string {
  if (!d.promptTokens || d.cachedTokens == null) return "—";
  const pct = Math.round((d.cachedTokens / d.promptTokens) * 100);
  return `${pct}%`;
}

const STATUS_STYLES: Record<LlmRequestSummary["status"], string> = {
  in_progress: "bg-sky-500/20 text-sky-300 animate-pulse",
  done: "bg-emerald-500/20 text-emerald-300",
  error: "bg-red-500/20 text-red-300",
  aborted: "bg-amber-500/20 text-amber-300",
};

const ROLE_STYLES: Record<string, string> = {
  system: "bg-purple-500/20 text-purple-300",
  user: "bg-white/10 text-white/70",
  assistant: "bg-violet-500/20 text-violet-300",
  tool: "bg-emerald-500/20 text-emerald-300",
};

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/10 text-white/40 hover:text-white/70 transition-colors"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

/**
 * Collapsible tree node (`<details>` with a rotating chevron). Children mount
 * only while open, so collapsed sections cost nothing and expanded ones grow
 * the page inline — the modal body stays the single scroll container.
 */
function TreeNode({
  label,
  meta,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  tone = "neutral",
  bodyClassName = "px-3 pb-3 pt-1 space-y-1.5",
  children,
}: {
  label: ReactNode;
  meta?: ReactNode;
  defaultOpen?: boolean;
  /** Pass to control the node from a parent (e.g. the message-list node
   * mirrors the earlier-messages toggle so its header can show the truth). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  tone?: "neutral" | "violet";
  bodyClassName?: string;
  children: ReactNode;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = openProp ?? uncontrolledOpen;
  const box =
    tone === "violet"
      ? "rounded-lg bg-violet-500/5 border border-violet-400/10"
      : "rounded-lg bg-black/20 border border-white/5";
  return (
    <details
      open={open}
      onToggle={(e) => {
        // React simulates bubbling even for the non-delegated `toggle` event,
        // so this fires when a nested <details> in the body toggles too.
        // Ignore descendant toggles and read `currentTarget` (this node's own
        // state) — never `target`, or collapsing one message would collapse
        // the whole list node.
        if (e.target !== e.currentTarget) return;
        const next = e.currentTarget.open;
        if (openProp === undefined) setUncontrolledOpen(next);
        onOpenChange?.(next);
      }}
      className={box}
    >
      <summary className="cursor-pointer list-none px-3 py-2 flex items-center gap-2 text-xs select-none">
        <Chevron variant="tree" open={open} className="opacity-40" />
        <span className="min-w-0 truncate">{label}</span>
        {meta ? <span className="ml-auto shrink-0 font-mono text-[10px] opacity-40">{meta}</span> : null}
      </summary>
      {open ? <div className={bodyClassName}>{children}</div> : null}
    </details>
  );
}

/** One-line preview for a collapsed wire message. */
function messagePreview(message: Record<string, unknown>): string {
  const content = message.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((part: any) =>
        typeof part?.text === "string" ? part.text : part?.type === "image_url" ? "[image]" : ""
      )
      .join(" ");
  }
  if (!text && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    const calls = message.tool_calls as Array<{ function?: { name?: string } }>;
    text = calls.map((c) => c.function?.name ?? "?").join(", ");
    text = `tool_calls: ${text}`;
  }
  return text.length > 120 ? `${text.slice(0, 120)}…` : text || "(empty)";
}

function messageBody(message: Record<string, unknown>): string {
  const content = message.content;
  const parts: string[] = [];
  if (typeof content === "string") {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part?.text === "string") parts.push(part.text);
      else parts.push(JSON.stringify(part, null, 2));
    }
  }
  if (Array.isArray(message.tool_calls)) {
    parts.push(JSON.stringify(message.tool_calls, null, 2));
  }
  return parts.join("\n\n") || JSON.stringify(message, null, 2);
}

/** Leaf of the request tree: role chip + preview, body expands inline. */
function WireMessageBlock({ message, index }: { message: Record<string, unknown>; index: number }) {
  const role = String(message.role ?? "unknown");
  const style = ROLE_STYLES[role] ?? "bg-white/10 text-white/70";
  const [open, setOpen] = useState(false);
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="rounded-lg bg-black/20 border border-white/5">
      <summary className="cursor-pointer list-none px-3 py-2 flex items-center gap-2 text-xs select-none">
        <Chevron variant="tree" open={open} className="opacity-40" />
        <span className="opacity-30 font-mono w-6 text-right shrink-0">{index}</span>
        <span className={`px-1.5 py-0.5 rounded font-mono text-[10px] shrink-0 ${style}`}>{role}</span>
        <span className="truncate opacity-50 font-mono text-[11px]">{messagePreview(message)}</span>
      </summary>
      {open ? (
        <pre className="px-3 pb-3 pt-1 text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-words text-white/70">
          {messageBody(message)}
        </pre>
      ) : null}
    </details>
  );
}

function roleSummary(messages: Array<Record<string, unknown>>): string {
  const counts = new Map<string, number>();
  for (const m of messages) {
    const role = String(m.role ?? "unknown");
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  return [...counts].map(([role, n]) => `${n} ${role}`).join(" · ");
}

/**
 * Message list layer of the tree: the tail (most recent messages) renders
 * inline, the prefix collapses into one expandable node. Chronological
 * top-to-bottom; expanding the prefix grows the page above the tail.
 */
function WireMessageList({
  messages,
  showEarlier,
  onShowEarlierChange,
}: {
  messages: Array<Record<string, unknown>>;
  showEarlier: boolean;
  onShowEarlierChange: (open: boolean) => void;
}) {
  if (messages.length === 0) {
    return <p className="text-xs italic opacity-40">No messages on this wire body.</p>;
  }
  const earlierCount = Math.max(0, messages.length - MESSAGE_TAIL);
  const earlier = messages.slice(0, earlierCount);
  const tail = earlierCount > 0 ? messages.slice(earlierCount) : messages;
  return (
    <div className="space-y-1">
      {earlierCount > 0 ? (
        <TreeNode
          open={showEarlier}
          onOpenChange={onShowEarlierChange}
          label={
            showEarlier ? (
              <span className="opacity-60">
                showing all messages
                <span className="opacity-60"> · {roleSummary(messages)}</span>
              </span>
            ) : (
              <span className="opacity-60">
                {earlierCount} earlier message{earlierCount === 1 ? "" : "s"}
                <span className="opacity-60"> · {roleSummary(earlier)}</span>
              </span>
            )
          }
          bodyClassName="px-3 pb-3 pt-0.5"
        >
          <div className="space-y-1 ml-1 border-l border-white/5 pl-2">
            {earlier.map((m, i) => (
              <WireMessageBlock key={i} message={m} index={i} />
            ))}
          </div>
        </TreeNode>
      ) : null}
      {tail.map((m, i) => (
        <WireMessageBlock key={earlierCount + i} message={m} index={earlierCount + i} />
      ))}
    </div>
  );
}

function ResponseBlocks({ detail }: { detail: LlmRequestDetail }) {
  const content = detail.response?.content ?? [];
  if (content.length === 0) {
    return (
      <p className="text-xs opacity-40 italic">
        {detail.status === "in_progress"
          ? "Response still streaming…"
          : "No content blocks recorded."}
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {content.map((block: any, i: number) => {
        if (block?.type === "thinking") {
          return (
            <TreeNode
              key={i}
              tone="violet"
              label={`thinking · ${String(block.thinking ?? "").length} chars`}
            >
              <pre className="text-[11px] leading-relaxed whitespace-pre-wrap break-words text-violet-200/70 font-mono">
                {block.thinking}
              </pre>
            </TreeNode>
          );
        }
        if (block?.type === "text") {
          return (
            <pre key={i} className="rounded-lg bg-black/20 border border-white/5 px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap break-words text-white/80 font-mono">
              {block.text}
            </pre>
          );
        }
        if (block?.type === "toolCall") {
          return (
            <div key={i} className="rounded-lg bg-emerald-500/5 border border-emerald-400/10 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-mono text-[10px]">
                  tool_call
                </span>
                <span className="text-xs font-mono text-emerald-200/80">{block.name}</span>
                {block.id ? <span className="ml-auto opacity-30 font-mono text-[10px] truncate">{block.id}</span> : null}
              </div>
              <pre className="mt-1.5 text-[11px] leading-relaxed whitespace-pre-wrap break-words text-white/60 font-mono">
                {JSON.stringify(block.arguments ?? {}, null, 2)}
              </pre>
            </div>
          );
        }
        return (
          <pre key={i} className="rounded-lg bg-black/20 border border-white/5 px-3 py-2 text-[11px] whitespace-pre-wrap break-words text-white/50 font-mono">
            {JSON.stringify(block, null, 2)}
          </pre>
        );
      })}
      {detail.response?.errorMessage ? (
        <p className="text-xs text-red-300/80 font-mono break-words">{detail.response.errorMessage}</p>
      ) : null}
    </div>
  );
}

function RequestDetail({ detail }: { detail: LlmRequestDetail }) {
  const messages = detail.request?.messages ?? [];
  const params = detail.request?.params ?? {};
  const reclaimed = detail.request?.reclaimed ?? 0;
  // Lifted so the section header can mirror the toggle: "showing last 8" vs
  // "showing all N" once the earlier-messages node is expanded.
  const [showEarlier, setShowEarlier] = useState(false);
  const truncated = messages.length > MESSAGE_TAIL;
  const paramChips = Object.entries(params)
    .filter(([k]) => k !== "v")
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  return (
    <div className="space-y-2 px-3 pb-3 pt-2">
      {paramChips.length > 0 ? (
        <p className="text-[10px] font-mono opacity-40 break-words">{paramChips.join("  ")}</p>
      ) : null}

      <TreeNode
        defaultOpen
        label={
          <span>
            Request
            <span className="opacity-50">
              {" "}· {messages.length} message{messages.length === 1 ? "" : "s"}
              {detail.request?.tools?.length ? ` · ${detail.request.tools.length} tools` : ""}
              {reclaimed > 0 ? ` · ${reclaimed} reclaimed by retention` : ""}
            </span>
          </span>
        }
        meta={truncated ? (showEarlier ? `showing all ${messages.length}` : `showing last ${MESSAGE_TAIL}`) : undefined}
        bodyClassName="px-3 pb-3 pt-0.5"
      >
        <WireMessageList
          messages={messages}
          showEarlier={showEarlier}
          onShowEarlierChange={setShowEarlier}
        />
      </TreeNode>

      {detail.request?.tools?.length ? (
        <TreeNode label={`Tool definitions sent · ${detail.request.tools.length}`}>
          <pre className="text-[10px] leading-relaxed whitespace-pre-wrap break-words text-white/50 font-mono">
            {JSON.stringify(detail.request.tools.map((t: any) => t.function?.name ?? t.name), null, 1)}
          </pre>
        </TreeNode>
      ) : null}

      <TreeNode
        defaultOpen
        label="Response"
        meta={detail.response?.stopReason ?? undefined}
      >
        <ResponseBlocks detail={detail} />
      </TreeNode>

      <TreeNode label="Raw wire JSON">
        <div className="flex items-center gap-2">
          <CopyButton text={JSON.stringify({ ...params, messages: detail.request?.messages ?? [], tools: detail.request?.tools ?? undefined }, null, 2)} label="Copy request" />
          <CopyButton text={JSON.stringify(detail.response ?? null, null, 2)} label="Copy response" />
        </div>
        <pre className="text-[10px] leading-relaxed whitespace-pre-wrap break-words text-white/40 font-mono rounded-lg bg-black/30 p-3">
          {JSON.stringify({ request: { ...params, messages: detail.request?.messages ?? [], tools: detail.request?.tools ?? null }, response: detail.response }, null, 2)}
        </pre>
      </TreeNode>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Context tab
// ---------------------------------------------------------------------------

type SectionTokenKey =
  | "basePrompt"
  | "persona"
  | "userDocument"
  | "memoryBlocks"
  | "zeitgeist"
  | "projectContext"
  | "retrievedMemories"
  | "memoryDelta";

const SECTION_LABELS: Array<{ key: SectionTokenKey; label: string }> = [
  { key: "basePrompt", label: "Base prompt" },
  { key: "persona", label: "Persona" },
  { key: "userDocument", label: "User document" },
  { key: "memoryBlocks", label: "Memory blocks" },
  { key: "zeitgeist", label: "Zeitgeist" },
  { key: "projectContext", label: "Project context" },
  { key: "retrievedMemories", label: "Frozen memories" },
  { key: "memoryDelta", label: "Memory delta" },
];

function ContextTab({ context }: { context: ContextView | null }) {
  if (!context) {
    return <p className="text-xs opacity-40 italic py-6 text-center">Context not loaded yet — send a message if this chat is brand new.</p>;
  }
  const sourceLabel =
    context.source === "request-log"
      ? "from the last recorded request"
      : context.source === "cache"
        ? "from the in-memory prompt cache"
        : "base prompt — no turn recorded yet";
  const sections = context.sections;
  return (
    <div className="px-5 py-4 space-y-4">
      <div className="text-xs opacity-40">
        System prompt {sourceLabel} · {context.systemPrompt.length.toLocaleString()} chars
      </div>

      {sections ? (
        <div>
          <h4 className="text-[10px] uppercase tracking-wider opacity-50 mb-2">Section token attribution</h4>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
            {SECTION_LABELS.map(({ key, label }) => (
              <div key={key} className="rounded-lg bg-black/20 border border-white/5 px-2.5 py-1.5">
                <div className="text-[10px] opacity-50 truncate">{label}</div>
                <div className="text-sm font-mono text-white/80">
                  ~{sections[key].toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="text-xs opacity-40 italic">Section breakdown not available yet (populated after the first augmented prompt build).</div>
      )}

      <div>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-[10px] uppercase tracking-wider opacity-50">System prompt</h4>
          <CopyButton text={context.systemPrompt} />
        </div>
        <pre className="text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-words text-white/70 rounded-lg bg-black/25 border border-white/5 p-3">
          {context.systemPrompt}
        </pre>
      </div>

      <div>
        <h4 className="text-[10px] uppercase tracking-wider opacity-50 mb-2">Tools ({context.tools.length})</h4>
        <div className="space-y-1">
          {context.tools.map((t) => (
            <TreeNode
              key={t.name}
              label={
                <span>
                  <span className="font-mono text-emerald-200/80">{t.name}</span>
                  <span className="opacity-50"> · {t.description}</span>
                </span>
              }
            >
              {t.parameters !== undefined ? (
                <pre className="text-[10px] leading-relaxed whitespace-pre-wrap break-words text-white/50 font-mono">
                  {JSON.stringify(t.parameters, null, 2)}
                </pre>
              ) : (
                <p className="text-[10px] italic opacity-40">No parameter schema.</p>
              )}
            </TreeNode>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main modal
// ---------------------------------------------------------------------------

export function RequestViewerModal({ isOpen, onClose, chatId, requestLogVersion = 0 }: Props) {
  const [tab, setTab] = useState<Tab>("requests");
  const [requests, setRequests] = useState<LlmRequestSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, LlmRequestDetail>>({});
  const [detailLoading, setDetailLoading] = useState(false);
  const [context, setContext] = useState<ContextView | null>(null);
  const [contextLoaded, setContextLoaded] = useState(false);
  const openRef = useRef(isOpen);
  openRef.current = isOpen;

  const fetchList = useCallback(
    async (silent = false) => {
      if (!chatId) return;
      if (!silent) setLoading(true);
      try {
        const data = await fetchLlmRequests(chatId);
        if (openRef.current) setRequests(data);
      } catch {
        // Transient failure: keep the last list.
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [chatId]
  );

  const fetchContext = useCallback(async () => {
    if (!chatId) return;
    try {
      const data = await fetchContextView(chatId);
      if (openRef.current) {
        setContext(data);
        setContextLoaded(true);
      }
    } catch {
      if (openRef.current) setContextLoaded(true);
    }
  }, [chatId]);

  const fetchDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const data = await fetchLlmRequestDetail(id);
      if (openRef.current) setDetails((prev) => ({ ...prev, [id]: data }));
    } catch {
      if (openRef.current) setDetailLoading(false);
      return;
    }
    setDetailLoading(false);
  }, []);

  // Fresh modal open (or chat switch): full reload, collapse everything.
  useEffect(() => {
    if (!isOpen || !chatId) return;
    setRequests([]);
    setDetails({});
    setExpandedId(null);
    setContext(null);
    setContextLoaded(false);
    void fetchList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, chatId]);

  // Live updates: each recorded request start/end bumps requestLogVersion.
  // Refetch the list silently, and refresh the expanded entry so an
  // in-progress row completes without a click.
  useEffect(() => {
    if (!isOpen || !chatId) return;
    void fetchList(true);
    if (expandedId) void fetchDetail(expandedId);
    if (tab === "context") void fetchContext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestLogVersion]);

  useEffect(() => {
    if (tab === "context" && isOpen && !contextLoaded) void fetchContext();
  }, [tab, isOpen, contextLoaded, fetchContext]);

  const handleToggle = useCallback(
    (id: string) => {
      if (expandedId === id) {
        setExpandedId(null);
        return;
      }
      setExpandedId(id);
      if (!details[id]) void fetchDetail(id);
    },
    [expandedId, details, fetchDetail]
  );

  const handleClear = useCallback(async () => {
    if (!chatId) return;
    try {
      await clearLlmRequests(chatId);
      setRequests([]);
      setDetails({});
      setExpandedId(null);
    } catch {
      // ignore — list stays stale
    }
  }, [chatId]);

  if (!isOpen) return null;

  const inFlight = requests.filter((r) => r.status === "in_progress").length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center app-modal-backdrop" onClick={onClose}>
      <div
        className="depth-raised relative prompt-viewer-surface theme-primary-bg border theme-primary-border rounded-2xl w-full max-w-[820px] mx-4 max-h-[85vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b theme-primary-border">
          <div className="flex items-center gap-1 bg-white/5 rounded-lg p-0.5">
            <button
              className={`px-3 py-1 rounded-md text-xs transition-colors ${tab === "requests" ? "bg-white/10 text-white/90" : "text-white/40 hover:text-white/70"}`}
              onClick={() => setTab("requests")}
            >
              Requests
            </button>
            <button
              className={`px-3 py-1 rounded-md text-xs transition-colors ${tab === "context" ? "bg-white/10 text-white/90" : "text-white/40 hover:text-white/70"}`}
              onClick={() => setTab("context")}
            >
              Context
            </button>
          </div>
          <div className="ml-auto text-[10px] opacity-40 font-mono">
            {tab === "requests"
              ? `${requests.length} recorded${inFlight > 0 ? ` · ${inFlight} in flight` : ""}`
              : ""}
          </div>
          {tab === "requests" && requests.length > 0 ? (
            <button
              className="text-xs px-2 py-1 rounded hover:bg-white/10 text-white/30 hover:text-white/60 transition-colors"
              onClick={() => void handleClear()}
              title="Clear recorded requests for this chat"
            >
              Clear
            </button>
          ) : null}
          <button className="theme-primary-text hover:opacity-80 text-lg leading-none" onClick={onClose}>
            &times;
          </button>
        </div>

        {/* Body — the modal's single scroll container; tree nodes grow inline */}
        <div className="flex-1 overflow-y-auto">
          {tab === "requests" ? (
            loading && requests.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <div className="w-5 h-5 border-2 theme-primary-border border-t-theme-primary-text rounded-full animate-spin" />
                <span className="ml-3 text-sm theme-primary-text opacity-60">Loading request log…</span>
              </div>
            ) : requests.length === 0 ? (
              <div className="text-center py-12 px-6">
                <p className="text-sm opacity-50">No requests recorded yet.</p>
                <p className="text-xs opacity-30 mt-2 max-w-md mx-auto">
                  Send a message in this chat — each LLM call the agent makes (including every
                  tool-loop iteration) appears here with its full wire request and response.
                </p>
              </div>
            ) : (
              <div className="px-3 py-2 space-y-1.5">
                {requests.map((r) => {
                  const detail = details[r.id];
                  const expanded = expandedId === r.id;
                  return (
                    <div key={r.id} className="rounded-lg border border-white/5 bg-black/15 overflow-hidden">
                      <button
                        className="w-full px-3 py-2 flex items-center gap-2.5 text-xs hover:bg-white/5 transition-colors text-left"
                        onClick={() => handleToggle(r.id)}
                      >
                        <Chevron variant="tree" open={expanded} className="opacity-40" />
                        <span className="opacity-40 font-mono shrink-0">{fmtTime(r.timestamp)}</span>
                        <span className="font-mono opacity-60 shrink-0">#{r.iteration ?? "?"}</span>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono shrink-0 ${STATUS_STYLES[r.status]}`}>
                          {r.status}
                        </span>
                        <span className="truncate opacity-50 font-mono text-[10px]">{r.modelId}</span>
                        <span className="ml-auto flex items-center gap-2.5 opacity-60 font-mono text-[10px] shrink-0">
                          <span title="prompt → completion tokens">
                            {fmtTokens(r.promptTokens)} → {fmtTokens(r.completionTokens)}
                          </span>
                          <span title="cached prompt-token hit ratio">cache {fmtCacheHit(r)}</span>
                          <span title="request duration">{fmtDuration(r.durationMs)}</span>
                          <span title="messages / tools in wire body">
                            {r.messageCount ?? "?"}m/{r.toolCount ?? 0}t
                          </span>
                        </span>
                      </button>
                      {expanded ? (
                        <div className="border-t border-white/5">
                          {detailLoading && !detail ? (
                            <div className="px-3 py-6 text-center text-xs opacity-40">Loading full request…</div>
                          ) : detail ? (
                            <RequestDetail detail={detail} />
                          ) : r.errorMessage ? (
                            <p className="px-3 py-3 text-xs text-red-300/80 font-mono break-words">{r.errorMessage}</p>
                          ) : (
                            <div className="px-3 py-3 text-xs opacity-40">Detail unavailable (row may have been pruned).</div>
                          )}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )
          ) : (
            <ContextTab context={context} />
          )}
        </div>
      </div>
    </div>
  );
}
