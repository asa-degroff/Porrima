import { useState } from "react";
import type { ChatToolCall, ChatToolResult, ImageAttachment } from "../types";
import type { ToolStatus } from "../api/client";
import { DiffView } from "./ui/DiffView";
import { UserImage } from "./UserImage";
import { ToolIcon, type ToolIconName } from "./ToolIcons";

const statusColors = {
  running: "border-yellow-400/20 bg-yellow-500/5",
  done: "border-emerald-400/20 bg-emerald-500/5",
  error: "border-red-400/20 bg-red-500/5",
};

const statusIcons = {
  running: (
    <svg className="animate-spin shrink-0" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  ),
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

  const name = toolCall?.name || liveStatus?.name || (isPreview ? "" : "unknown");
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

  // While previewing, the parsed arguments are still empty — pull what's
  // visible out of the raw JSON stream instead.
  const previewArgsDisplay = isPreview && previewRaw
    ? formatPreviewArgs(name, previewRaw)
    : undefined;
  const preview = isPreview && previewRaw
    ? previewBody(name, previewRaw)
    : null;

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
        {(argsDisplay || previewArgsDisplay) && (
          <span className="text-xs text-white/30 truncate min-w-0 flex-1 ml-1">
            {argsDisplay || previewArgsDisplay}
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
        <div className="border-t border-white/5 px-3 py-2 max-h-[240px] overflow-hidden">
          <div className="text-[10px] text-white/30 mb-1.5 font-medium uppercase tracking-wider flex items-center gap-1.5">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-400/60 animate-pulse" />
            {preview.label}
          </div>
          <pre className="text-xs whitespace-pre-wrap break-all leading-relaxed text-white/50 max-w-full font-mono">
            {tailLines(preview.text)}
          </pre>
        </div>
      )}

      {/* Expandable content */}
      {expanded && name === "edit_file" && toolCall?.arguments?.old_string != null && (
        <div className="border-t border-white/5 px-3 py-2 max-h-[300px] overflow-auto overflow-x-hidden">
          <DiffView
            oldString={toolCall.arguments.old_string}
            newString={toolCall.arguments.new_string ?? ""}
          />
        </div>
      )}
      {expanded && name === "bash" && toolCall?.arguments?.command && (
        <div className="border-t border-white/5 px-3 py-2 overflow-x-hidden max-w-full">
          <div className="text-xs text-white/40 mb-1.5 font-medium">Command</div>
          <pre className="text-xs text-white/60 whitespace-pre-wrap break-all font-mono leading-relaxed overflow-x-auto max-w-full">
            {toolCall.arguments.command}
          </pre>
        </div>
      )}
      {expanded && result && !(name === "edit_file" && toolCall?.arguments?.old_string != null) && !(name === "bash") && (
        <div className={`border-t border-white/5 px-3 py-2 max-h-[300px] overflow-auto overflow-x-hidden max-w-full ${isMonospaceOutput(name) ? "font-mono" : ""}`}>
          <pre className="text-xs text-white/50 whitespace-pre-wrap break-all leading-relaxed max-w-full">
            {result}
          </pre>
        </div>
      )}
      {expanded && name === "bash" && result && (
        <div className="border-t border-white/5 px-3 py-2 overflow-x-hidden max-w-full">
          <div className="text-xs text-white/40 mb-1.5 font-medium">Output</div>
          <pre className="text-xs text-white/50 whitespace-pre-wrap break-all font-mono leading-relaxed overflow-x-auto max-w-full">
            {result}
          </pre>
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

function formatToolName(name: string): string {
  return name.replace(/_/g, " ");
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

/** One-line header preview, mirroring formatArgs but on the raw stream. */
function formatPreviewArgs(toolName: string, raw: string): string {
  switch (toolName) {
    case "read_file":
    case "write_file":
    case "edit_file":
      return extractPartialStringField(raw, "path") ?? "";
    case "bash": {
      const cmd = extractPartialStringField(raw, "command");
      return cmd ? cmd.split("\n")[0].slice(0, 100) : "";
    }
    case "run_python": {
      const code = extractPartialStringField(raw, "code");
      return code ? code.split("\n")[0]?.slice(0, 50) : "";
    }
    case "save_memory":
      return extractPartialStringField(raw, "text")?.slice(0, 50) ?? "";
    case "search_memory":
    case "search_conversation":
    case "web_search":
      return extractPartialStringField(raw, "query") ?? "";
    case "web_fetch":
      return extractPartialStringField(raw, "url") ?? "";
    case "create_artifact":
      return extractPartialStringField(raw, "title") ?? "";
    case "ask_user":
      return extractPartialStringField(raw, "question")?.slice(0, 50) ?? "";
    default:
      return "";
  }
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

/** Show the tail of a growing text so the newest lines stay visible without
 *  scroll manipulation. */
function tailLines(text: string, maxLines = 24): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(lines.length - maxLines).join("\n");
}
