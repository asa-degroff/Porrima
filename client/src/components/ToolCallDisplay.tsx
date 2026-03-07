import { useState } from "react";
import type { ChatToolCall, ChatToolResult } from "../types";
import type { ToolStatus } from "../api/client";
import { DiffView } from "./DiffView";

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
}

export function ToolCallDisplay({ toolCall, toolResult, liveStatus }: Props) {
  const [expanded, setExpanded] = useState(false);

  const name = toolCall?.name || liveStatus?.name || "unknown";
  const status = liveStatus?.status || (toolResult ? (toolResult.isError ? "error" : "done") : "running");
  const result = liveStatus?.result || toolResult?.content;

  // Format arguments for display
  const argsDisplay = toolCall?.arguments
    ? formatArgs(name, toolCall.arguments)
    : undefined;

  const toolIcon = getToolIcon(name);

  return (
    <div className={`my-2 rounded-lg border ${statusColors[status]} overflow-hidden`}>
      {/* Header - clickable to expand */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-white/[0.02] transition-colors"
      >
        {statusIcons[status]}
        <span className="text-white/40 text-xs">{toolIcon}</span>
        <span className="text-xs font-medium text-white/70 truncate">
          {formatToolName(name)}
        </span>
        {argsDisplay && (
          <span className="text-xs text-white/30 truncate ml-1">
            {argsDisplay}
          </span>
        )}
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
          className={`ml-auto shrink-0 text-white/20 transition-transform ${expanded ? "rotate-180" : ""}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* Expandable output */}
      {expanded && name === "edit_file" && toolCall?.arguments?.old_string != null && (
        <div className="border-t border-white/5 px-3 py-2 max-h-[300px] overflow-auto">
          <DiffView
            oldString={toolCall.arguments.old_string}
            newString={toolCall.arguments.new_string ?? ""}
          />
        </div>
      )}
      {expanded && result && !(name === "edit_file" && toolCall?.arguments?.old_string != null) && (
        <div className={`border-t border-white/5 px-3 py-2 max-h-[300px] overflow-auto ${isMonospaceOutput(name) ? "font-mono" : ""}`}>
          <pre className="text-xs text-white/50 whitespace-pre-wrap break-all leading-relaxed">
            {result}
          </pre>
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
      return args.command?.slice(0, 60) || "";
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

function getToolIcon(name: string): string {
  switch (name) {
    case "read_file": return "\u{1F4C4}";
    case "write_file": return "\u{1F4DD}";
    case "edit_file": return "\u{270F}\u{FE0F}";
    case "list_files": return "\u{1F4C1}";
    case "bash": return "$";
    case "run_python": return "\u{1F40D}";
    case "create_artifact": return "\u{1F3A8}";
    case "save_memory": return "\u{1F4BE}";
    case "search_memory": return "\u{1F50D}";
    case "forget_memory": return "\u{1F5D1}\u{FE0F}";
    case "ask_user": return "?";
    default: return "\u{1F527}";
  }
}

const MONOSPACE_TOOLS = new Set(["bash", "read_file", "run_python", "list_files", "search_memory"]);

function isMonospaceOutput(name: string): boolean {
  return MONOSPACE_TOOLS.has(name);
}
