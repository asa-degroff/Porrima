import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatToolCall, ChatToolResult, ImageAttachment } from "../types";
import type { ToolStatus } from "../api/client";
import { DiffView } from "./ui/DiffView";
import { UserImage } from "./UserImage";
import { ToolIcon, type ToolIconName } from "./ToolIcons";
import { Beats } from "./Beats";

const statusColors = {
  running: "border-yellow-400/20 bg-yellow-500/5",
  done: "border-emerald-400/20 bg-emerald-500/5",
  error: "border-red-400/20 bg-red-500/5",
};

const statusIcons = {
  running: <Beats />,
  done: (
    <svg className="shrink-0 text-emerald-400" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
  error: (
    <svg className="shrink-0 text-red-400" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
};

/** Bounded tail (source lines) for the streaming preview. Enough real
 *  scrollback to read context, cheap enough to re-layout on every token
 *  delta — the complete content is reachable after completion via the
 *  call layer. */
const PREVIEW_TAIL_LINES = 150;

interface Props {
  toolCall?: ChatToolCall;
  toolResult?: ChatToolResult;
  liveStatus?: ToolStatus;
  /** This is a live preview: the model is still streaming the call's
   *  arguments. The body shows the growing argument content instead of
   *  waiting for execution. */
  isPreview?: boolean;
  /** Accumulated raw JSON argument string for a preview. */
  previewRaw?: string;
}

export function ToolCallDisplay({ toolCall, toolResult, liveStatus, isPreview, previewRaw }: Props) {
  const [expanded, setExpanded] = useState(false);
  // Second tier: whether the full call arguments are revealed under the
  // one-line call preview row. Independent of `expanded` (the chip itself).
  // Null = no explicit choice yet, so the default is derived from the props:
  // edit_file opens with the call revealed — the diff IS the call, and it
  // was the visible expanded content before this tier existed. (Derived
  // rather than state-initialized so a preview segment that transitions in
  // place to an edit_file still gets the default.)
  const [showCallChoice, setShowCallChoice] = useState<boolean | null>(null);

  const name = toolCall?.name || liveStatus?.name || (isPreview ? "" : "unknown");
  const showCall =
    showCallChoice ??
    (name === "edit_file" && toolCall?.arguments?.old_string != null);
  // toolResult (persisted) takes priority over liveStatus (streaming-only) —
  // once the result is available the tool is definitively done/error.
  const status = toolResult
    ? (toolResult.isError ? "error" : "done")
    : (liveStatus?.status || "running");
  const result = toolResult?.content || liveStatus?.result;

  // Format arguments for display
  const argsDisplay = toolCall?.arguments
    ? formatArgs(name, toolCall.arguments)
    : undefined;

  const preview = isPreview && previewRaw
    ? previewBody(name, previewRaw)
    : null;

  // Call layer (second tier): the authoritative arguments, available once
  // the preview is replaced by the real segment (or from persisted
  // messages). Previews never enter this layer — their growing content is
  // the preview body itself.
  const callArgs =
    !isPreview && toolCall?.arguments && Object.keys(toolCall.arguments).length > 0
      ? toolCall.arguments
      : undefined;
  const callSummary = callArgs ? callRowSummary(name, callArgs) : undefined;
  const callDetail = callArgs ? callDetails(name, callArgs) : undefined;
  const isEditDiff = name === "edit_file" && toolCall?.arguments?.old_string != null;
  const showCallLayer = !!callArgs || isEditDiff;

  const iconInfo = getToolIcon(name);

  return (
    <div className={`my-2 rounded-lg border ${statusColors[status]} overflow-hidden max-w-full`}>
      {/* Header - clickable to expand */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-white/[0.02] transition-colors min-w-0 overflow-hidden"
      >
        {statusIcons[status]}
        <span className="text-white text-xs shrink-0 flex items-center">
          <ToolIcon name={iconInfo} className="opacity-40" />
        </span>
        <span className="text-xs font-medium text-white/70 shrink-0 whitespace-nowrap">
          {isPreview && !name ? "composing tool call" : formatToolName(name)}
        </span>
        {/* The one-line argument preview is a resting-state affordance:
            mid-stream the preview body below IS the argument surface, and
            echoing its first line in the header would double-print. */}
        {argsDisplay && (
          <span className="text-xs text-white/30 truncate min-w-0 flex-1 ml-1">
            {argsDisplay}
          </span>
        )}
        {!isPreview && (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0 text-white/20 transition-transform ml-auto"
            style={{ transform: expanded ? "rotate(180deg)" : "rotate(0deg)" }}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </button>

      {/* Live preview: the model is still composing the call's arguments.
          Shown unconditionally — this is the whole point of the preview. */}
      {isPreview && preview && (
        <div className="border-t border-white/5 px-3 py-2">
          <div className="text-[10px] text-white/30 mb-1.5 font-medium flex items-center gap-1.5">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-400/60 animate-pulse" />
            {preview.label}
          </div>
          <AutoFollowPre text={preview.text} />
        </div>
      )}

      {/* Expandable content — two tiers:
          Tier 1 (the call): a one-line preview row that expands to the full
          arguments — what was actually asked of the tool, for peeking under
          the hood or debugging.
          Tier 2 (the result): what came back — the existing behavior. */}
      {expanded && showCallLayer && (
        <>
          <button
            onClick={() => setShowCallChoice(!showCall)}
            className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left hover:bg-white/[0.02] transition-colors min-w-0"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0 text-white/20 transition-transform"
              style={{ transform: showCall ? "rotate(180deg)" : "rotate(0deg)" }}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
            <span className="text-[10px] text-white/30 font-medium shrink-0">
              call
            </span>
            {callSummary && (
              <span className="text-xs text-white/40 truncate min-w-0 flex-1 font-mono">
                {callSummary}
              </span>
            )}
          </button>
          {showCall && (
            isEditDiff ? (
              <div className="border-t border-white/5 px-3 py-2 max-h-[300px] overflow-auto overflow-x-hidden">
                <DiffView
                  oldString={toolCall!.arguments.old_string}
                  newString={toolCall!.arguments.new_string ?? ""}
                />
              </div>
            ) : callDetail ? (
              <div className="border-t border-white/5 px-3 py-2 max-h-[300px] overflow-auto overflow-x-hidden max-w-full">
                {callDetail.label && (
                  <div className="text-xs text-white/40 mb-1.5 font-medium">{callDetail.label}</div>
                )}
                <pre className="text-xs text-white/60 whitespace-pre-wrap break-all font-mono leading-relaxed max-w-full">
                  {callDetail.text}
                </pre>
              </div>
            ) : null
          )}
        </>
      )}
      {expanded && result && name !== "bash" && !(name === "edit_file" && toolCall?.arguments?.old_string != null) && (
        <div className={`border-t border-white/5 px-3 py-2 max-h-[300px] overflow-auto overflow-x-hidden max-w-full ${isMonospaceOutput(name) ? "font-mono" : ""}`}>
          <pre className="text-xs text-white/50 whitespace-pre-wrap break-all leading-relaxed max-w-full">
            {result}
          </pre>
        </div>
      )}
      {expanded && name === "bash" && result && (
        <div className="border-t border-white/5 px-3 py-2 max-w-full">
          <div className="text-xs text-white/40 mb-1.5 font-medium">Output</div>
          <div className="max-h-[300px] overflow-y-auto overflow-x-hidden custom-scrollbar">
            <pre className="text-xs text-white/50 whitespace-pre-wrap break-all font-mono leading-relaxed max-w-full">
              {result}
            </pre>
          </div>
        </div>
      )}
      {/* Show generated images inline for generate_and_review tool */}
      {name === "generate_and_review" && toolResult?.images?.length && (
        <div className="border-t border-white/5 px-3 py-2">
          <div className="text-xs text-white/40 mb-2 font-medium">Generated Image</div>
          <div className="flex flex-wrap gap-2">
            {toolResult.images.map((img, idx) => (
              <div key={idx} className="relative group">
                <UserImage
                  image={img}
                  maxDimension={300}
                />
              </div>
            ))}
          </div>
        </div>
      )}
      {/* Show other tool images only when expanded */}
      {expanded && name !== "generate_and_review" && toolResult?.images?.length && (
        <div className="border-t border-white/5 px-3 py-2">
          <div className="text-xs text-white/40 mb-2 font-medium">Generated Image{toolResult.images.length > 1 ? "s" : ""}</div>
          <div className="flex flex-wrap gap-2">
            {toolResult.images.map((img, idx) => (
              <div key={idx} className="relative group">
                <UserImage
                  image={img}
                  maxDimension={300}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Growing <pre> with auto-follow for the streaming preview. Pinned to the
 * tail by default so the newest tokens stay visible (the point of the
 * preview); if the user scrolls up to read earlier content the follow
 * pauses and a pill offers to jump back. The rendered tail is bounded
 * (tailLines) so the per-delta re-layout stays cheap on huge writes.
 */
function AutoFollowPre({ text }: { text: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [paused, setPaused] = useState(false);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 16;
    if (atBottom !== atBottomRef.current) {
      atBottomRef.current = atBottom;
      setPaused(!atBottom);
    }
  }, []);

  // Follow the tail as new text arrives — but only while the user is at
  // the bottom; their scroll position is the override.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [text]);

  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setPaused(false);
  }, []);

  return (
    <div className="relative">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="max-h-[240px] overflow-y-auto overflow-x-hidden custom-scrollbar"
      >
        <pre className="text-xs whitespace-pre-wrap break-all leading-relaxed text-white/50 max-w-full font-mono">
          {tailLines(text)}
        </pre>
      </div>
      {paused && (
        <button
          onClick={jumpToLatest}
          className="absolute bottom-1.5 right-1.5 z-10 flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/10 border border-white/20 text-white/70 hover:text-white hover:bg-white/15 hover:border-white/30 transition-all shadow-lg backdrop-blur-sm"
          title="Jump to latest"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14" />
            <path d="m19 12-7 7-7-7" />
          </svg>
          <span className="text-[10px] font-medium">Latest</span>
        </button>
      )}
    </div>
  );
}

function formatToolName(name: string): string {
  return name.replace(/_/g, " ");
}

/** One-line preview for the call layer's expand row: the structured field
 *  (path, command, query…) or, for tools formatArgs doesn't know, the first
 *  string-valued argument (schema order puts the primary field first in
 *  practice). */
function callRowSummary(toolName: string, args: Record<string, any>): string {
  const formatted = formatArgs(toolName, args);
  if (formatted) return formatted;
  for (const value of Object.values(args)) {
    if (typeof value === "string" && value.trim()) {
      return value.replace(/\s+/g, " ").slice(0, 120);
    }
  }
  return "";
}

/** Full detail of a completed call for the call layer. Content-heavy tools
 *  get a dedicated text view; everything else falls back to pretty JSON.
 *  edit_file is handled by the caller — its diff IS the call. */
function callDetails(toolName: string, args: Record<string, any>): { label?: string; text: string } {
  switch (toolName) {
    case "write_file":
      if (args.content != null) return { label: "Content", text: String(args.content) };
      break;
    case "bash":
      if (args.command != null) return { label: "Command", text: String(args.command) };
      break;
    case "run_python":
      if (args.code != null) return { label: "Code", text: String(args.code) };
      break;
    case "save_memory":
      if (args.text != null) return { label: "Memory", text: String(args.text) };
      break;
    case "ask_user":
      if (args.question != null) return { label: "Question", text: String(args.question) };
      break;
    case "create_artifact":
    case "update_artifact":
      if (args.html != null) return { label: "HTML", text: String(args.html) };
      break;
  }
  try {
    return { text: JSON.stringify(args, null, 2) };
  } catch {
    return { text: String(args) };
  }
}

function formatArgs(toolName: string, args: Record<string, any>): string {
  switch (toolName) {
    case "read_file":
    case "write_file":
    case "edit_file":
      return args.path || "";
    case "bash":
      return args.command?.slice(0, 100) || "";
    case "run_python":
      return args.code?.split("\n")[0]?.slice(0, 50) || "";
    case "list_files":
      return args.pattern || args.path || "";
    case "save_memory":
      return args.text?.slice(0, 50) || "";
    case "search_memory":
      return args.query || "";
    case "forget_memory":
      return args.id || args.query || "";
    case "create_artifact":
      return args.title || "";
    case "ask_user":
      return args.question?.slice(0, 50) || "";
    default:
      return "";
  }
}

function getToolIcon(name: string): ToolIconName {
  const svgTools: Record<string, ToolIconName> = {
    read_file: "read_file",
    write_file: "write_file",
    edit_file: "edit_file",
    list_files: "list_files",
    bash: "bash",
    run_python: "run_python",
    create_artifact: "create_artifact",
    save_memory: "save_memory",
    search_memory: "search_memory",
    ask_user: "ask_user",
    web_fetch: "web_fetch",
    web_search: "web_search",
    search_conversation: "search_conversation",
  };

  return svgTools[name] ?? "default";
}

const MONOSPACE_TOOLS = new Set(["bash", "read_file", "run_python", "list_files", "search_memory"]);

function isMonospaceOutput(name: string): boolean {
  return MONOSPACE_TOOLS.has(name);
}

// --- Tool-call argument previews -------------------------------------------
//
// While a tool call is streaming, its arguments arrive as raw JSON fragments.
// These helpers pull a best-effort view out of a JSON string that may end
// mid-token: they are deliberately forgiving (no validation, first match
// wins) because the preview is ephemeral — the authoritative segment
// replaces it the moment execution starts.

/**
 * Extract the value of a string field from a possibly-incomplete JSON
 * string. Tolerates an unterminated value (returns what has arrived so far)
 * and a trailing incomplete escape. Returns null when the key hasn't
 * appeared yet.
 */
function extractPartialStringField(raw: string, field: string): string | null {
  const keyRe = new RegExp(`"${field}"\\s*:\\s*"`);
  const m = keyRe.exec(raw);
  if (!m) return null;
  let i = m.index + m[0].length;
  let out = "";
  while (i < raw.length) {
    const c = raw[i];
    if (c === "\\") {
      const n = raw[i + 1];
      if (n === undefined) return out; // trailing escape, incomplete
      if (n === "u") {
        const hex = raw.slice(i + 2, i + 6);
        if (hex.length === 4 && /^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        return out; // incomplete \uXXXX — stop
      }
      switch (n) {
        case "n": out += "\n"; break;
        case "t": out += "\t"; break;
        case "r": out += "\r"; break;
        case '"': out += '"'; break;
        case "\\": out += "\\"; break;
        case "/": out += "/"; break;
        case "b": out += "\b"; break;
        case "f": out += "\f"; break;
        default: out += n;
      }
      i += 2;
      continue;
    }
    if (c === '"') return out; // value closed
    out += c;
    i += 1;
  }
  return out; // value still open
}

/** Body preview: the argument content that is actually growing. */
function previewBody(
  toolName: string,
  raw: string,
): { label: string; text: string } | null {
  switch (toolName) {
    case "write_file": {
      const content = extractPartialStringField(raw, "content");
      return content ? { label: "writing", text: content } : null;
    }
    case "edit_file": {
      const fresh = extractPartialStringField(raw, "new_string");
      if (fresh) return { label: "new", text: fresh };
      const old = extractPartialStringField(raw, "old_string");
      return old ? { label: "old", text: old } : null;
    }
    case "bash": {
      const cmd = extractPartialStringField(raw, "command");
      return cmd ? { label: "command", text: cmd } : null;
    }
    case "run_python": {
      const code = extractPartialStringField(raw, "code");
      return code ? { label: "code", text: code } : null;
    }
    case "save_memory": {
      const text = extractPartialStringField(raw, "text");
      return text ? { label: "memory", text } : null;
    }
    case "ask_user": {
      const q = extractPartialStringField(raw, "question");
      return q ? { label: "asking", text: q } : null;
    }
    default: {
      // Fallback: the raw JSON tail keeps the generation visible even for
      // tools with no dedicated view.
      const trimmed = raw.trim();
      return trimmed.length > 1 ? { label: "composing", text: trimmed } : null;
    }
  }
}

/** Show the tail of a growing text. Bounded by PREVIEW_TAIL_LINES —
 *  AutoFollowPre keeps the newest lines in view, so the cap only limits how
 *  far back the live scroll reaches. */
function tailLines(text: string, maxLines = PREVIEW_TAIL_LINES): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(lines.length - maxLines).join("\n");
}
