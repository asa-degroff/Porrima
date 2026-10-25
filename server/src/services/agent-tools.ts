import { Type, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { readFile, rm } from "fs/promises";
import { join } from "path";
import { MEMORY_TOOLS, executeMemoryTool } from "./memory-tools.js";
import { buildWebTools, executeWebTool, resolveWebSearchProvider, type WebSearchProvider } from "./web-tools.js";
import { BROWSER_TOOLS, executeBrowserTool } from "./browser-tools.js";
import { createArtifact, createVisual, updateArtifact, updateVisual, existsVisual } from "./sandbox.js";
import { SKILL_TOOLS, executeSkillTool } from "./skills.js";
import { formatArtifactGuidanceWarnings, getArtifactGuidanceWarnings } from "./artifact-guidance.js";
import { renderArtifactPreviewScreenshot, type PreviewObjectKind } from "./artifact-preview.js";
import { getSettings } from "./chat-storage.js";
import { getStoredSystemPauseState } from "./system-pause.js";
import { applyTimeMarker, type TimeMarkerState } from "./time-marker.js";
import { BASH_ENV_HARDENING, getWorkspaceForProject, type WorkspaceAdapter } from "./workspace.js";
import { codeSearchEnabled, runCodeSearch, runCodeSearchOnSnippet, renderSnippetText, CodeSearchError, type CodeSearchParams } from "./code-search.js";
import {
  executeInKernel,
  kernelToolsEnabled,
  killKernelJob,
  tailKernelJob,
  type KernelFallbackReason,
  type KernelToolCallResult,
  type KernelToolDispatcher,
} from "./python-kernel.js";
import {
  isSupervisorConnected,
  listJobsForChat,
  readJobOutputTail,
  refreshSupervisorJob,
  startSupervisorJob,
  stopSupervisorJob,
  waitForSupervisorJob,
} from "./job-runtime.js";
import { getJobView, suppressJobNotices, type JobViewRow } from "./job-view.js";
import { v4 as uuid } from "uuid";
import { getToolResultImageDir, saveToolResultImage } from "./tool-result-image-storage.js";
import type { Artifact, BrowserFrameEvent, InlineVisual, Project } from "../types.js";

const MAX_AUTOMATIC_ARTIFACT_REVIEW_UPDATES = 2;
const mutationQueues = new Map<string, Promise<void>>();

async function withMutationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const queued = previous.catch(() => {}).then(() => gate);
  mutationQueues.set(key, queued);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (mutationQueues.get(key) === queued) mutationQueues.delete(key);
  }
}

// --- Filesystem tool definitions ---

const READ_FILE_TOOL: Tool = {
  name: "read_file",
  description: "Read the contents of a file. Returns content with line numbers. When `limit` is omitted, returns up to the maximum number of lines. For large files, paginate with `offset`/`limit` instead of issuing repeated full reads.",
  parameters: Type.Object({
    path: Type.String({ description: "File path (relative to working directory or absolute)" }),
    offset: Type.Optional(Type.Integer({ description: "Line number to start reading from (1-based)", minimum: 1 })),
    limit: Type.Optional(Type.Integer({ description: "Maximum number of lines to read. Defaults to the configured tool option (1000).", minimum: 1, maximum: 10000 })),
  }),
};

const WRITE_FILE_TOOL: Tool = {
  name: "write_file",
  description: "Create or overwrite a file with the given content. Creates parent directories if needed.",
  parameters: Type.Object({
    path: Type.String({ description: "File path (relative to working directory or absolute)" }),
    content: Type.String({ description: "Content to write to the file" }),
  }),
};

const EDIT_FILE_TOOL: Tool = {
  name: "edit_file",
  description: "Edit a file by replacing an exact string match. The old_string must appear exactly once in the file.",
  parameters: Type.Object({
    path: Type.String({ description: "File path (relative to working directory or absolute)" }),
    old_string: Type.String({ description: "The exact text to find and replace (must be unique in the file)" }),
    new_string: Type.String({ description: "The replacement text" }),
  }),
};

const LIST_FILES_TOOL: Tool = {
  name: "list_files",
  description: "List files in a directory or match a glob pattern.",
  parameters: Type.Object({
    path: Type.Optional(Type.String({ description: "Directory path (defaults to working directory)" })),
    pattern: Type.Optional(Type.String({ description: "Glob pattern to match (e.g. '**/*.ts')" })),
  }),
};

/**
 * Structural code search (docs/design/code-search.md, Phase 0). Dark behind
 * PORRIMA_CODE_SEARCH=1 — the tool definition ships only when the flag is on
 * (zero schema bytes until the flip). Read-only and lock-free: parallel-safe
 * like read_file (never takes workspace:<label>, not in SEQUENTIAL_TOOL_NAMES).
 */
const CODE_SEARCH_TOOL: Tool = {
  name: "code_search",
  description:
    "Structurally search code with AST patterns (ast-grep) — matches syntax, not text: function shapes, call sites, assignments. " +
    "Default for syntax-structural questions; if the answer depends on text content (string literals, character order), not syntax, use rg via bash — and do not write a script to count what a pattern can match: the pattern is the script. " +
    "Covers TypeScript, TSX, JavaScript/JSX, HTML, CSS, and Python; files in other languages are reported as unscanned — use rg via bash for those. " +
    "Patterns are code, not regex: $NAME binds a single node, $$$NAME binds a list of nodes. " +
    "A pattern is a complete node (`function $NAME($$$ARGS) { $$$ }`) or a partial prefix of one — `function $NAME` matches ANY function definition (typed, generic, async). " +
    "For an exact parameter list use the body slot too (`function $NAME($ARG) { $$$ }`) — a bodiless parameterized pattern (`function $NAME($ARG)`) matches only bodiless declarations like TS overload signatures, NOT definitions. " +
    "Typed signatures need their slots in the full form (`function $NAME<$TP>($$$ARGS): $RET { $$$ }`); the partial form avoids that. " +
    "Plain text with no metavariables is a literal exact-node match. " +
    "If you are unsure a pattern will match, test it first against a snippet: pass code= with a small example — cheaper than scanning. " +
    "Examples: `function $NAME` finds function definitions; `await $CALL($$$ARGS)` finds call sites; `return $VALUE` finds returned values; `console.log(`$$$X`)` finds template-literal log calls (add `, $$$REST` for calls with more arguments).",
  parameters: Type.Object({
    pattern: Type.String({ description: "AST pattern (code, not regex — $NAME single node, $$$NAME node list)" }),
    code: Type.Optional(Type.String({ description: "Test the pattern against a constructed snippet instead of scanning files — matches this code only (path/globs ignored). Verify a pattern before scanning: a zero match here means the pattern is wrong, not that the code is absent" })),
    path: Type.Optional(Type.String({ description: "Workspace-relative root to search (default: whole workspace)" })),
    lang: Type.Optional(Type.String({ description: "Language alias: ts, tsx, js, jsx, html, css, py. Default: auto-detect from file extensions — files outside these languages are reported as unscanned" })),
    globs: Type.Optional(Type.Array(Type.String(), { description: "Glob filter, gitignore semantics; '!' prefix excludes; later globs win (e.g. ['*.ts', '!*.test.ts'])" })),
    maxMatches: Type.Optional(Type.Integer({ description: "Max matches to return (default 50, max 1000). For a pure count use maxMatches=1 — the summary line still reports totalMatches across all matches", minimum: 1, maximum: 1000 })),
    skip: Type.Optional(Type.Integer({ description: "Skip the first N matches for pagination (default 0)", minimum: 0 })),
  }),
};

const BASH_TOOL: Tool = {
  name: "bash",
  description:
    "Execute a bash command and return stdout and stderr. Commands run in the working directory (project root for project chats, $HOME for others). Use for system commands, running scripts, etc. For Python, use run_python instead. Set background: true for long-running commands: the job is owned by the durable job supervisor and survives a server restart. Set service: true (implies background) for dev servers and watchers; a service has no completion timeout. Use ready_when to wait for a readiness line before returning. Background/service results carry a job id and output path; inspect them with jobs. Foreground commands hold the turn.",
  parameters: Type.Object({
    command: Type.String({ description: "The bash command to execute" }),
    timeout: Type.Optional(Type.Integer({ description: "Timeout in seconds (default 30 foreground / 3600 background; max 300 foreground, 3600 background)", minimum: 1, maximum: 3600 })),
    background: Type.Optional(Type.Boolean({ description: "Run as a supervisor-owned background job and return immediately with a job id (default false)." })),
    service: Type.Optional(Type.Boolean({ description: "Run as a long-lived service (implies background). Services have no completion timeout and are stopped explicitly." })),
    ready_when: Type.Optional(Type.String({ description: "With background/service: wait until this literal line appears in the job output before returning." })),
    ready_timeout: Type.Optional(Type.Integer({ description: "Readiness wait in seconds (default 30, max 300).", minimum: 1, maximum: 300 })),
  }),
};

const RUN_PYTHON_TOOL: Tool = {
  name: "run_python",
  description:
    "Execute Python code in the active workspace and return stdout/stderr. Runs in a persistent kernel: variables and imports survive across calls, failures, and timeouts, and top-level await is supported. Set background: true for Python work expected to run long (>~60s): the call returns immediately with a job ID and does not hold the turn; end your turn and check progress with jobs on a later turn. Background cells are transient — they die with the kernel; use bash background/service for work that must survive a restart. Uses the project root." +
    // Capability line ships only when the kernel-tools flag is on (and rides
    // the same server restart as the flip — one intentional prefix bust,
    // docs/design/kernel-codemode.md §4.9). Gated identically for model and
    // headless builds so schema bytes stay uniform per server process.
    (kernelToolsEnabled()
      ? " The kernel also exposes awaitable host tools — `await tools.<name>(**kwargs)` runs the real tool (permissions, budgets, and spill included) with results staying in kernel memory, not context; `help(tools)` in a cell lists what is exposed."
      : ""),
  parameters: Type.Object({
    code: Type.String({ description: "Python code to execute" }),
    timeout: Type.Optional(Type.Integer({ description: "Timeout in seconds (default 30 foreground / 3600 background; max 300 foreground, 3600 background)", minimum: 1, maximum: 3600 })),
    background: Type.Optional(Type.Boolean({ description: "Run as a background cell and return immediately with a job ID (default false). Background cells are transient; use bash background/service for durable work. Inspect with jobs." })),
  }),
};

const JOBS_PARAMETERS = Type.Object({
  action: Type.Enum(
    { list: "list", status: "status", tail: "tail", kill: "kill", wait_for: "wait_for" },
    { description: "list all jobs, status one, tail output, kill one, or wait for a readiness pattern" },
  ),
  jobId: Type.Optional(Type.String({ description: "Job ID (required for status/tail/kill/wait_for)" })),
  lines: Type.Optional(Type.Integer({ description: "Tail line count (default 50, max 200)", minimum: 1, maximum: 200 })),
  force: Type.Optional(Type.Boolean({ description: "kill only: force the stop. For a cell this escalates to a kernel kill (L3, loses the namespace)." })),
  kind: Type.Optional(
    Type.Enum(
      { cell: "cell", command: "command", service: "service" },
      { description: "list only: filter by job kind" },
    ),
  ),
  pattern: Type.Optional(Type.String({ description: "wait_for only: literal text to wait for in the output" })),
  timeout: Type.Optional(Type.Integer({ description: "wait_for timeout in seconds (default 30, max 300)", minimum: 1, maximum: 300 })),
});

const JOBS_TOOL: Tool = {
  name: "jobs",
  description:
    "Inspect and control background jobs for this chat: kernel cells and supervisor-owned commands/services. list shows all jobs, status one job, tail its recent output, kill stops one, wait_for waits for a readiness line in a supervisor job's output. Jobs run without holding the turn. Check on a later turn — do not poll in a loop. A lost job's outcome is unknown: check side effects before re-running.",
  parameters: JOBS_PARAMETERS,
};

const PYTHON_JOBS_TOOL: Tool = {
  name: "python_jobs",
  description:
    "Deprecated alias for jobs (same actions). Prefer jobs. Inspect and control background run_python cells and supervisor-owned commands/services for this chat.",
  parameters: JOBS_PARAMETERS,
};

const KERNEL_FALLBACK_NOTICES: Record<KernelFallbackReason, string> = {
  capacity: "[kernel: at capacity; ran stateless this call]",
  "spawn-failed": "[kernel: unavailable; ran stateless this call]",
  wedge: "[kernel: previous cell is wedged; ran stateless this call]",
  broken: "[kernel: disabled after a protocol failure; ran stateless this call]",
  transport: "[kernel: remote session unavailable; ran per-call this call]",
};

function formatDurationMs(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

function jobDuration(job: JobViewRow): string {
  if (job.duration_ms != null) return formatDurationMs(job.duration_ms);
  if (job.state === "running" && job.started_at) {
    const elapsed = Date.now() - Date.parse(job.started_at);
    if (Number.isFinite(elapsed)) return formatDurationMs(elapsed);
  }
  return "-";
}

function formatJobSummary(job: JobViewRow): string {
  const outcome = [
    job.exit_code != null ? `exit=${job.exit_code}` : "",
    job.signal ? `signal=${job.signal}` : "",
    job.stop_reason ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const command = job.command
    ? job.command.replace(/\s+/g, " ").slice(0, 160)
    : "(cell)";
  return `${job.job_id}  ${job.state}  ${job.kind}  ${jobDuration(job)}${outcome ? `  ${outcome}` : ""}  ${command}`;
}

function formatJobDetail(job: JobViewRow): string {
  const lines = [
    formatJobSummary(job),
    `source: ${job.source}`,
    `cwd: ${job.cwd ?? "-"}`,
  ];
  if (job.pid != null) lines.push(`pid: ${job.pid}`);
  if (job.started_at) lines.push(`started: ${job.started_at}`);
  if (job.ended_at) lines.push(`ended: ${job.ended_at}`);
  if (job.output_paths[0]) lines.push(`output: ${job.output_paths[0]}`);
  if (job.state === "lost") {
    lines.push("outcome unknown; check side effects before re-running.");
  }
  if (job.stop_reason === "log-cap") {
    lines.push("output capped; older output was discarded.");
  }
  return lines.join("\n");
}

function isTerminalJobState(state: string): boolean {
  return state === "finished" || state === "stopped" || state === "lost" || state === "failed";
}

// In-turn polling guard: a second tail of the same still-running job within
// the window returns a notice instead of output. Heuristic — tool calls carry
// no turn identity — but a genuine next-turn check is normally minutes later.
const TAIL_REPEAT_WINDOW_MS = 30_000;
const recentTails = new Map<string, { jobId: string; at: number }>();

function wasTailedRecently(chatId: string, jobId: string): boolean {
  const entry = recentTails.get(chatId);
  return entry?.jobId === jobId && Date.now() - entry.at < TAIL_REPEAT_WINDOW_MS;
}

function markTailed(chatId: string, jobId: string): void {
  recentTails.set(chatId, { jobId, at: Date.now() });
}

const READ_PDF_TOOL: Tool = {
  name: "read_pdf",
  description: "Read a PDF and extract text, metadata, and figures. Uses layout-aware parsing to detect headings, tables, and picture regions. Supports workspace paths and URLs. When extractImages=true, detected figures (charts, diagrams, illustrations) are rendered and included inline as visual content. Hybrid OCR runs automatically on scanned pages. Use pages to limit scope — large PDFs can be read in narrower page ranges.",
  parameters: Type.Object({
    path: Type.String({ description: "PDF path (local file path or URL starting with http/https)" }),
    extractImages: Type.Optional(Type.Boolean({ description: "Render detected figure regions and include them inline as images (default false). Captures charts, diagrams, and illustrations — not decorative icons or logos." })),
    ocr: Type.Optional(Type.Boolean({ description: "Force full-page OCR on every page (default false). Hybrid OCR runs automatically regardless; this forces it even on pages with clean digital text." })),
    pages: Type.Optional(Type.String({ description: "Page range to process, e.g. '1-5' or 'all' (default 'all')" })),
  }),
};

const CREATE_ARTIFACT_TOOL: Tool = {
  name: "create_artifact",
  description: "Create an HTML/JS artifact in a sandboxed iframe. Use panel (default) for complex apps and inline for compact charts, diagrams, or visual aids.",
  parameters: Type.Object({
    title: Type.String({ description: "Title for the artifact" }),
    html: Type.String({ description: "Complete HTML document, including html, head, and body tags" }),
    display: Type.Optional(Type.Enum({ panel: "panel", inline: "inline" }, { description: "Render in the side panel (default) or inline in chat" })),
  }),
};

const UPDATE_ARTIFACT_TOOL: Tool = {
  name: "update_artifact",
  description: "Update an existing artifact or inline visual with a complete replacement HTML document.",
  parameters: Type.Object({
    artifactId: Type.String({ description: "The canonical ID of the artifact to update (from a previous create_artifact call)" }),
    html: Type.String({ description: "Complete HTML document with the updated content" }),
    changeSummary: Type.Optional(Type.String({ description: "Brief description of what changed (e.g., 'Made background blue, added reset button')" })),
  }),
};

const ASK_USER_TOOL: Tool = {
  name: "ask_user",
  description:
    "Ask the user a question and wait for their response. Use when you need clarification, a decision, or confirmation before proceeding. " +
    "Provide `options` whenever the answers are enumerable (e.g. yes/no, pick-one-of-N) — the UI renders them as selectable choices. " +
    "Keep each option short (a few words of exact answer text), put the recommended choice first, and do NOT add an 'Other'/free-input catch-all: the user can always type a custom answer. " +
    "The user's reply arrives as this tool's result — either one of your option strings or free-form text they typed.",
  parameters: Type.Object({
    question: Type.String({ description: "The question to ask the user" }),
    options: Type.Optional(
      Type.Array(Type.String({ description: "Exact answer text sent back when this option is chosen" }), {
        description: "Optional preset answer choices. Selection never blocks free-form input — a typed custom answer is always possible.",
        minItems: 2,
        maxItems: 6,
      }),
    ),
  }),
};

// --- Side-effects interface for tool execution ---

export interface ToolSideEffects {
  onArtifact: (artifact: Artifact) => void;
  onVisual: (visual: InlineVisual) => void;
  onAskUser: (question: string, toolCallId: string, options?: string[]) => void;
  /**
   * Live-only browser action frame (Phase 2 viewer). Optional: only the SSE
   * transports wire it. Frames never touch tool-result content — they ride
   * this side channel exclusively (the KV-cache shape invariant holds).
   */
  onBrowserFrame?: (frame: BrowserFrameEvent) => void;
}

// --- Adapter helpers ---

/**
 * Compute the max tool result size in characters, scaled to the context window.
 * Uses 15% of context (at ~4 chars/token), with a floor of 8k chars.
 */
function getMaxToolResultChars(contextWindow: number): number {
  return Math.max(8_000, Math.floor(contextWindow * 4 * 0.15));
}

function getReadFileMaxBytes(settingsMaxBytes: number | undefined, contextWindow: number): number {
  const configuredMaxBytes = settingsMaxBytes ?? 256 * 1024;
  // Leave room for the truncation marker so read_file, not the generic wrapper,
  // owns pagination guidance and can report the exact next offset.
  const wrapperBudgetBytes = Math.max(1024, getMaxToolResultChars(contextWindow) - 1024);
  return Math.min(configuredMaxBytes, wrapperBudgetBytes);
}

function createWrapResult(contextWindow: number) {
  const maxChars = getMaxToolResultChars(contextWindow);
  return function wrapResult(result: { content: string | any[]; isError: boolean }, toolName?: string): AgentToolResult<{}> {
    if (result.isError) {
      // Truncate error content too — a 1MB error message would blow up the context
      let errText = typeof result.content === "string" ? result.content : result.content[0]?.text || "";
      if (errText.length > maxChars) {
        errText = errText.slice(0, maxChars) + `\n\n[Error output truncated: ${(errText.length / 1024).toFixed(0)}KB → ${(maxChars / 1024).toFixed(0)}KB]`;
      }
      throw new Error(errText);
    }

    // Handle multi-part content (e.g. text + images from read_pdf)
    if (Array.isArray(result.content)) {
      const content = result.content;
      // Truncate the text part if needed
      const textPart = content.find((c: any) => c.type === "text");
      if (textPart && textPart.text.length > maxChars) {
        const truncated = textPart.text.slice(0, maxChars);
        const totalLines = textPart.text.split("\n").length;
        const keptLines = truncated.split("\n").length;
        const onlyToolsWithOffset = toolName === "read_file";
        const footer = onlyToolsWithOffset
          ? `[Truncated: showing ${keptLines} of ${totalLines} lines (${(maxChars / 1024).toFixed(0)}KB of ${(textPart.text.length / 1024).toFixed(0)}KB). Use offset/limit parameters to read specific sections.]`
          : `[Truncated: showing ${keptLines} of ${totalLines} lines (${(maxChars / 1024).toFixed(0)}KB of ${(textPart.text.length / 1024).toFixed(0)}KB). If the tool result includes a saved file path, use read_file with offset/limit to read more.]`;
        textPart.text = truncated + `\n\n${footer}`;
      }
      return { content, details: {} };
    }

    // String content — legacy path
    let text = result.content;
    if (text.length > maxChars) {
      const truncated = text.slice(0, maxChars);
      const totalLines = text.split("\n").length;
      const keptLines = truncated.split("\n").length;
      // Only read_file supports offset/limit pagination. For other tools, point
      // at any embedded file path (e.g. bash/web_fetch spill files) or just
      // report the truncation without misleading pagination guidance.
      const onlyToolsWithOffset = toolName === "read_file";
      const footer = onlyToolsWithOffset
        ? `[Truncated: showing ${keptLines} of ${totalLines} lines (${(maxChars / 1024).toFixed(0)}KB of ${(result.content.length / 1024).toFixed(0)}KB). Use offset/limit parameters to read specific sections.]`
        : `[Truncated: showing ${keptLines} of ${totalLines} lines (${(maxChars / 1024).toFixed(0)}KB of ${(result.content.length / 1024).toFixed(0)}KB). If the tool result includes a saved file path, use read_file with offset/limit to read more.]`;
      text = truncated + `\n\n${footer}`;
    }
    return { content: [{ type: "text", text }], details: {} };
  };
}

interface ArtifactReviewTarget {
  id: string;
  title: string;
  url: string;
  version: number;
  objectKind: PreviewObjectKind;
  automaticUpdateCount: number;
}

function artifactReviewInstruction(target: ArtifactReviewTarget, width: number, height: number): string {
  const objectLabel = target.objectKind === "visual" ? "visual" : "artifact";
  const remainingUpdates = MAX_AUTOMATIC_ARTIFACT_REVIEW_UPDATES - target.automaticUpdateCount;
  const budgetInstruction = remainingUpdates > 0
    ? `If the screenshot shows a visible issue, call update_artifact with the complete corrected HTML for canonical ID ${target.id}.`
    : `This ${objectLabel} has reached the automatic screenshot-review update limit for this turn. Do not call update_artifact again unless the user explicitly asks for another revision; briefly describe any remaining concern instead.`;

  return [
    `Rendered preview screenshot attached (${width}x${height}) for ${objectLabel} "${target.title}" version ${target.version}.`,
    `Canonical ID: ${target.id}`,
    `URL: ${target.url}`,
    "Review the screenshot against the user's request and the visible result, not just the HTML source.",
    budgetInstruction,
    "If it looks correct, there's no need to revise it further; just briefly confirm the result.",
  ].join("\n");
}

function screenshotUnavailableInstruction(target: ArtifactReviewTarget, error: unknown): string {
  const objectLabel = target.objectKind === "visual" ? "visual" : "artifact";
  const message = error instanceof Error ? error.message : String(error);
  return [
    `Rendered preview screenshot unavailable for ${objectLabel} "${target.title}" version ${target.version}: ${message}`,
    "Continue from the tool result and source.",
  ].join("\n");
}

async function withArtifactPreviewReview(
  resultText: string,
  target: ArtifactReviewTarget,
): Promise<AgentToolResult<{}>> {
  const content: any[] = [{ type: "text", text: resultText }];
  try {
    const screenshot = await renderArtifactPreviewScreenshot({
      id: target.id,
      version: target.version,
      objectKind: target.objectKind,
    });
    content[0].text += `\n\n${artifactReviewInstruction(target, screenshot.width, screenshot.height)}`;
    content.push({
      type: "image",
      data: screenshot.data,
      mimeType: screenshot.mimeType,
    });
  } catch (error) {
    console.warn(
      `[artifact-preview] screenshot unavailable for ${target.objectKind} ${target.id} v${target.version}:`,
      error instanceof Error ? error.message : error,
    );
    content[0].text += `\n\n${screenshotUnavailableInstruction(target, error)}`;
  }
  return { content, details: {} };
}

/** Build a pi-ai ToolCall object for existing executor functions */
function makeToolCall(id: string, name: string, args: Record<string, any>): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

// --- Automation tool definitions ---

const SCHEDULE_REMINDER_TOOL: Tool = {
  name: "schedule_reminder",
  description:
    "Schedule a one-time reminder for yourself. Fires as a full agent turn in the target chat — " +
    "by default the current chat — at the specified time, respecting inactivity gates. The reminder " +
    "lands as a visible reminder card in that thread and runs with the thread's full context and " +
    "full tool access — including this one, so you can schedule the next follow-up from within a " +
    "fired reminder run. Pass targetChat to fire elsewhere (agent or system chats; the system chat " +
    "remains the home for housekeeping watches that belong to no single thread).",
  parameters: Type.Object({
    message: Type.String({ description: "The prompt content to deliver to your future self — what you want to be reminded to do or think about" }),
    title: Type.String({ description: "Short label for the reminder (e.g. 'Check PR #22616 status')" }),
    scheduledAt: Type.String({ description: "ISO 8601 timestamp for when to fire (must be at least 2 minutes in the future)", format: "date-time" }),
    activationPolicy: Type.Optional(Type.Enum(["idle", "absent", "manual_only"] as const, { description: "When to fire: 'idle' (default, fires when system is idle), 'absent' (waits for user absence threshold), 'manual_only' (never auto-fires)" })),
    targetChat: Type.Optional(Type.String({ description: "Where the reminder fires: a chat id or unique title fragment (agent or system chats). Defaults to the current chat." })),
  }),
};

const LIST_AUTOMATIONS_TOOL: Tool = {
  name: "list_automations",
  description: "List all automation tasks. Shows schedules, prompt steps, next run times, and status. Use to see what's scheduled and when. Built-in automations (synthesis, wake) and agent-created reminders are included. Archived (completed) reminders are excluded by default — use filter='history' to see them.",
  parameters: Type.Object({
    filter: Type.Optional(Type.Enum(["all", "enabled", "agent-created", "built-in", "history"] as const, { description: "Filter: 'all' (default, excludes archived), 'enabled', 'agent-created', 'built-in', 'history' (archived/completed tasks)" })),
    includeRuns: Type.Optional(Type.Boolean({ description: "Include last run status per task (default false)" })),
  }),
};

const UPDATE_AUTOMATION_TOOL: Tool = {
  name: "update_automation",
  description: "Modify an automation task. You can edit your own reminders freely and reschedule them with runAt or everyMinutes. For built-in automations (synthesis, wake), you can edit prompt steps but not schedule or structural fields. User-created automations are read-only.",
  parameters: Type.Object({
    automationId: Type.String({ description: "Task ID to modify" }),
    title: Type.Optional(Type.String({ description: "Updated title (agent reminders only)" })),
    promptSteps: Type.Optional(Type.Array(Type.Object({
      id: Type.String({ description: "Step ID" }),
      title: Type.String({ description: "Step title" }),
      prompt: Type.String({ description: "Step prompt content" }),
    }), { description: "Updated prompt steps" })),
    enabled: Type.Optional(Type.Boolean({ description: "Toggle on/off (agent reminders only)" })),
    runAt: Type.Optional(Type.String({ description: "Reschedule an agent task as a one-time run at this ISO 8601 time (at least 2 minutes ahead)", format: "date-time" })),
    everyMinutes: Type.Optional(Type.Number({ description: "Reschedule an agent task as a recurring interval, in minutes", minimum: 1, maximum: 527040 })),
  }),
};

const SCHEDULE_CHAT_MESSAGE_TOOL: Tool = {
  name: "schedule_chat_message",
  description:
    "Post a message into another chat as a visible, attributed note from you. " +
    "Omit `when` to deliver immediately; pass an ISO 8601 timestamp at least 2 minutes " +
    "ahead to schedule delivery. Set `wake: true` to have the target thread " +
    "run a continue turn after the post lands (it wakes with that chat's context; it " +
    "fires on the next scheduler tick plus the idle grace, not immediately).",
  parameters: Type.Object({
    targetChat: Type.String({ description: "Target chat id or a unique title fragment (agent/system chats only)" }),
    message: Type.String({ description: "The message body to deliver to the target thread" }),
    subject: Type.Optional(Type.String({ description: "Short subject line shown after the provenance envelope" })),
    when: Type.Optional(Type.String({ description: "ISO 8601 delivery time at least 2 minutes in the future. Omit to deliver immediately (or to wake as soon as the scheduler allows).", format: "date-time" })),
    wake: Type.Optional(Type.Boolean({ description: "Wake the target thread: its agent runs a continue turn after the post lands." })),
  }),
};

const LIST_CHATS_TOOL: Tool = {
  name: "list_chats",
  description: "List chats with ids, titles, types, last-modified times, and previews. Use to discover a target for schedule_chat_message.",
  parameters: Type.Object({
    limit: Type.Optional(Type.Number({ description: "Max chats to return (default 50, max 200)", minimum: 1, maximum: 200 })),
  }),
};

const FILESYSTEM_TOOLS: Tool[] = [
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  EDIT_FILE_TOOL,
  LIST_FILES_TOOL,
  // Dark behind PORRIMA_CODE_SEARCH=1 (docs/design/code-search.md §3.2): the
  // definition ships only when the flag is on, uniform per server process —
  // the kernel-tools capability-line pattern.
  ...(codeSearchEnabled() ? [CODE_SEARCH_TOOL] : []),
  BASH_TOOL,
  RUN_PYTHON_TOOL,
  JOBS_TOOL,
  PYTHON_JOBS_TOOL,
  READ_PDF_TOOL,
  CREATE_ARTIFACT_TOOL,
  UPDATE_ARTIFACT_TOOL,
  ASK_USER_TOOL,
];

const AUTOMATION_TOOLS: Tool[] = [
  SCHEDULE_REMINDER_TOOL,
  LIST_AUTOMATIONS_TOOL,
  UPDATE_AUTOMATION_TOOL,
  SCHEDULE_CHAT_MESSAGE_TOOL,
  LIST_CHATS_TOOL,
];
// System chats (synthesis, wake, automation runs) keep the automation
// management tools — scheduling and reminder chaining are deliberate and are
// bounded by the pending-reminder cap, the 2-minute minimum lead time, and
// per-run iteration/time budgets. What stays out are the tools that require a
// live user: ask_user and the per-chat skill tools (system chats don't
// activate skills). jobs is deliberately IN: the persistent kernel
// runs in system chats too, and background jobs must be observable there —
// list/tail is the only completion surface between scheduled runs, and kill
// (force: true) is the only model-reachable L3/wedge escape
// (docs/design/session-python-kernel.md §4.5, §4.7). This gate is keyed to
// chatType only, so HTTP and headless builds of the same chat type produce
// identical schemas — tool definitions render into the system prompt, and any
// per-path difference busts the KV prefix. Agent-chat automation runs keep
// ask_user in the schema and swap its executor instead (headless-tools.ts);
// never re-filter ask_user out of a headless tool array.
const SYSTEM_CHAT_EXCLUDED_TOOLS = new Set([
  "ask_user",
  ...SKILL_TOOLS.map((tool) => tool.name),
]);
const SEQUENTIAL_TOOL_NAMES = new Set([
  "save_memory", "create_memory_block", "update_memory_block", "create_notebook_entry",
  "write_file", "edit_file", "bash", "run_python", "jobs", "python_jobs", "web_fetch",
  "browser_navigate", "browser_snapshot", "browser_click", "browser_hover", "browser_type", "browser_screenshot",
  "create_artifact", "update_artifact", "ask_user",
  "schedule_reminder", "schedule_chat_message", "update_automation", "install_skill", "remove_skill",
]);

function toolIsAvailable(name: string, chatType?: string): boolean {
  return chatType !== "system" || !SYSTEM_CHAT_EXCLUDED_TOOLS.has(name);
}

/** Get tool definitions for display/metadata only. `parameters` is the
 *  TypeBox JSON schema — the request viewer's Context tab shows the same
 *  surface the model sees (wire tools come from convertTools over these).
 *  The web_search schema is provider-specific; the selected provider is read
 *  from settings here, the same source getAgentTools uses. */
export async function getAgentToolDefinitions(chatType?: string): Promise<{ name: string; description: string; parameters?: unknown }[]> {
  const settings = await getSettings().catch(() => undefined);
  const webSearchProvider = resolveWebSearchProvider(settings);
  const allTools = [...MEMORY_TOOLS, ...buildWebTools(webSearchProvider), ...BROWSER_TOOLS, ...AUTOMATION_TOOLS, ...FILESYSTEM_TOOLS, ...SKILL_TOOLS];
  return allTools
    .filter((tool) => toolIsAvailable(tool.name, chatType))
    .map((t) => ({ name: t.name, description: t.description, parameters: (t as { parameters?: unknown }).parameters }));
}

/**
 * Kernel tool surface for in-kernel composition (docs/design/kernel-codemode.md
 * §4.9): the same adapter call and settings-driven limits as the model-level
 * tool, minus the turn-bound machinery — no `wrapResult` context-budget
 * truncation (kernel results never enter model context), no side-effect
 * callbacks, an AbortSignal owned by the kernel manager. Construction lives
 * here (the registry side of the seam); the kernel manager never imports this
 * module, the dispatcher rides in as a per-execute injection.
 *
 * Phase A surface: the full Tier 1 (§4.3) — workhorse reads + `bash` (the
 * §4.9 lock-rule case). Tier 2 waits on the provenance seam (Phase B). The
 * per-kernel dispatch FIFO already serializes whatever else is added.
 */
const KERNEL_MEMORY_READ_TOOLS = new Set([
  "search_memory",
  "search_conversation",
  "read_archived_context",
  "list_memory_blocks",
  "read_memory_block",
]);

/**
 * read_pdf can return multipart content (text + base64 image parts when
 * extractImages=true). Base64 must not ride a strict-JSON frame (the driver's
 * repr/payload caps exist for exactly that reason — §4.9): figures land in the
 * shared tool-result-images store and the value lists their on-disk paths.
 * A local kernel opens/emit()s them directly; on remote the store paths are
 * server-local (§4.9's remote carve-out covers the data-plane caveat).
 */
export async function shapeReadPdfKernelResult(result: {
  content: string | any[];
  isError: boolean;
}): Promise<KernelToolCallResult> {
  if (typeof result.content === "string") {
    return result.isError ? { ok: false, error: result.content || "read failed" } : { ok: true, value: result.content };
  }
  const texts: string[] = [];
  const figures: string[] = [];
  for (const part of result.content) {
    if (part?.type === "text" && typeof part.text === "string") {
      texts.push(part.text);
    } else if (part?.type === "image" && typeof part.data === "string") {
      try {
        const id = uuid();
        const mimeType = typeof part.mimeType === "string" ? part.mimeType : "image/png";
        const record = await saveToolResultImage(id, Buffer.from(part.data, "base64"), mimeType, "kernel-figure");
        figures.push(join(getToolResultImageDir(id), record.url.slice(record.url.lastIndexOf("/") + 1)));
      } catch {
        texts.push("[figure dropped: image store write failed]");
      }
    }
  }
  const body = texts.join("\n");
  const value = figures.length
    ? `${body}\n\n[figures saved — open() or emit() these paths]\n${figures.map((f) => `- ${f}`).join("\n")}`
    : body;
  return result.isError ? { ok: false, error: value || "read failed" } : { ok: true, value };
}

function createKernelToolDispatcher(workspace: WorkspaceAdapter, chatId: string): KernelToolDispatcher {
  return {
    tools: [
      "read_file",
      "bash",
      "list_files",
      "web_search",
      "web_fetch",
      "read_pdf",
      // Phase 1 (docs/design/code-search.md §3.3): the kernel row rides the
      // same executor; the exposure gate is the same flag as the model-level
      // tool, evaluated per dispatcher construction (per cell) so a flip
      // needs no restart beyond the one the kernel-tools line already rides.
      ...(codeSearchEnabled() ? ["code_search"] : []),
      ...KERNEL_MEMORY_READ_TOOLS,
    ],
    call: async (tool, args, signal) => {
      if (tool === "read_file") {
        const settings = await getSettings().catch(() => undefined);
        // The configured cap, NOT getReadFileMaxBytes: that clamp exists to fit
        // one result inside the model's context budget (wrapResult's contract),
        // and kernel results never enter context (§4.1 "Results are raw, not
        // context-budgeted"). The dispatcher's own frame cap bounds the wire.
        const result = await workspace.readFile(
          args as Record<string, any>,
          {
            defaultLines: settings?.readFileDefaultLines,
            maxBytes: settings?.readFileMaxBytes ?? 256 * 1024,
          },
          signal,
        );
        return result.isError
          ? { ok: false, error: result.content || "read failed" }
          : { ok: true, value: result.content };
      }
      if (tool === "bash") {
        // No withMutationLock here, by design (kernel-codemode.md §4.9): a
        // foreground run_python already holds `workspace:<label>` for its whole
        // call, so a kernel-origin bash re-entering that queue would deadlock
        // behind its own holder; background jobs are the accepted workspace
        // peers (session-python-kernel.md §4.7). The manager's per-kernel FIFO
        // provides this chat's serialization instead. chatId opts into the
        // shared spill store: oversize output keeps a reachable full copy
        // (local kernels can open the path; the footer rides in the value).
        const result = await workspace.bash(args as Record<string, any>, signal, { chatId });
        return result.isError
          ? { ok: false, error: result.content || "command failed" }
          : { ok: true, value: result.content };
      }
      if (tool === "list_files") {
        const result = await workspace.listFiles(args as Record<string, any>, signal);
        return result.isError
          ? { ok: false, error: result.content || "list failed" }
          : { ok: true, value: result.content };
      }
      if (tool === "code_search") {
        // Phase 1 (§3.3): structured JSON projection — result bytes are free
        // in kernel variables, so the cell gets the normalized shape
        // (CodeSearchResult minus `text`; the manager stringifies it for the
        // wire and the driver decodes it back via value_json). `code=` runs
        // the snippet-testing path — no filesystem, no workspace, so it
        // works on remote kernels too (the file scan stays local-only until
        // the remote carve-out phase).
        const a = args as Record<string, any>;
        try {
          if (typeof a.code === "string") {
            const result = runCodeSearchOnSnippet(
              { pattern: String(a.pattern ?? ""), code: a.code, lang: a.lang, maxMatches: a.maxMatches, skip: a.skip },
              signal,
            );
            return { ok: true, value: result as unknown as Record<string, unknown> };
          }
          const result = await runCodeSearch(a as CodeSearchParams, workspace, signal);
          const { text: _modelProjection, ...structured } = result;
          return { ok: true, value: structured as unknown as Record<string, unknown> };
        } catch (e: any) {
          return {
            ok: false,
            error: e instanceof CodeSearchError ? e.message : `code_search failed: ${e?.message ?? String(e)}`,
          };
        }
      }
      // Web + memory reads are pure projections back onto the executors the
      // model-level tools already use — same auth, same retrieval scoping,
      // same providers. No truncation: memory results ride as full strings.
      if (tool === "web_search" || tool === "web_fetch") {
        const result = await executeWebTool(makeToolCall("kernel-tool", tool, args as Record<string, any>), signal);
        return result.isError ? { ok: false, error: result.content || "web call failed" } : { ok: true, value: result.content };
      }
      if (KERNEL_MEMORY_READ_TOOLS.has(tool)) {
        const result = await executeMemoryTool(makeToolCall("kernel-tool", tool, args as Record<string, any>), chatId);
        return result.isError ? { ok: false, error: result.content || "memory call failed" } : { ok: true, value: result.content };
      }
      if (tool === "read_pdf") {
        const result = await executeReadPdf(args as Record<string, any>, workspace, signal);
        return await shapeReadPdfKernelResult(result);
      }
      return { ok: false, error: `tool "${tool}" is not dispatchable` };
    },
  };
}

/** Get all tools available for agent chats, wrapped as AgentTool */
/**
 * Wrap every tool's execute so time markers can be appended to results.
 *
 * The marker lands on the result BEFORE it enters the live context or the
 * persisted row (both read the execute return value), so wire and replay
 * stay byte-identical — the KV prefix is never disturbed. With no state the
 * tool array passes through untouched.
 */
export function wrapToolsWithTimeMarker(tools: AgentTool[], timeMarker: TimeMarkerState | null): AgentTool[] {
  if (!timeMarker) return tools;
  return tools.map((tool) => {
    const original = tool.execute;
    return {
      ...tool,
      execute: async (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any) =>
        applyTimeMarker(await original(toolCallId, params, signal, onUpdate), timeMarker),
    };
  });
}

/**
 * Normalize tool-result content to the strict pi-ai wire shape: an array of
 * {type:"text",text} / {type:"image",data,mimeType} items, nothing else.
 *
 * Tool results enter BOTH the live wire context (pi-agent-core passes the
 * execute return straight into the ToolResultMessage content) and the
 * persisted rows (replayed by chatMessagesToPiMessages, which rebuilds
 * strict {type:"text"}/{type:"image"} items). Any extra field an executor
 * attaches — e.g. `name` on a browser_screenshot image — rides the wire but
 * vanishes on replay, so the replayed history can never reproduce the token
 * sequence the model saw and the KV-cache prefix digest diverges at that
 * message (full re-prefill on the next send). Normalizing here — the single
 * choke point every tool's execute flows through — keeps wire and replay
 * byte-identical.
 *
 * String content (a pre-wrapResult executor return) is converted to a single
 * text item, because the array IS the canonical wire shape: the provider
 * serializer and the replay reconstruction both require it, and a bare string
 * would serialize differently from the replay (digest divergence) or not at
 * all. Idempotent: already-strict items map to themselves.
 */
export function normalizeToolResultContent(content: any[]): any[];
export function normalizeToolResultContent(content: string): { type: "text"; text: string }[];
export function normalizeToolResultContent(content: any): any {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return content;
  return content.map((item: any) => {
    if (!item || typeof item !== "object") return item;
    if (item.type === "text") return { type: "text", text: item.text };
    if (item.type === "image") return { type: "image", data: item.data, mimeType: item.mimeType };
    return item;
  });
}

/**
 * Wrap every tool's execute so returned content is normalized before it
 * enters the wire context, the tool_execution_end event, or the persisted
 * row — all three read the execute return value, so one normalization here
 * keeps them consistent.
 */
function wrapToolsWithNormalizedContent(tools: AgentTool[]): AgentTool[] {
  return tools.map((tool) => {
    const original = tool.execute;
    return {
      ...tool,
      execute: async (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any) => {
        const result = await original(toolCallId, params, signal, onUpdate);
        return { ...result, content: normalizeToolResultContent((result as any).content) };
      },
    };
  });
}

export async function getAgentTools(chatId: string, effects: ToolSideEffects, contextWindow = 32768, project?: Project | string, chatType?: string, timeMarker?: TimeMarkerState | null): Promise<AgentTool[]> {
  const workspacePromise = getWorkspaceForProject(project);
  const wrapResult = createWrapResult(contextWindow);
  const tools: AgentTool[] = [];
  // The web_search schema is provider-specific: the selected provider's
  // parameters render into the prefix. Every construction path (HTTP,
  // headless, warm, estimates) goes through this function and reads the same
  // settings snapshot, which keeps the surface byte-identical across
  // transports. A settings change is a deliberate one-time prefix break — the
  // kv-prefix diagnostics log names both tool sets when the digest changes.
  const settings = await getSettings().catch(() => undefined);
  const webSearchProvider = resolveWebSearchProvider(settings);
  const artifactReviewUpdateCounts = new Map<string, number>();

  const automaticUpdateCountForCreate = (id: string) => artifactReviewUpdateCounts.get(id) ?? 0;
  const automaticUpdateCountForUpdate = (id: string) => {
    const next = (artifactReviewUpdateCounts.get(id) ?? 0) + 1;
    artifactReviewUpdateCounts.set(id, next);
    return next;
  };

  // Memory tools
  for (const tool of MEMORY_TOOLS) {
    tools.push({
      ...tool,
      label: tool.name,
      execute: async (toolCallId, params) => {
        const args = params as Record<string, any>;
        return wrapResult(
          await executeMemoryTool(makeToolCall(toolCallId, tool.name, args), chatId, {
            maxResultChars: getMaxToolResultChars(contextWindow),
          }),
          tool.name,
        );
      },
    });
  }

  // Web tools
  for (const tool of buildWebTools(webSearchProvider)) {
    tools.push({
      ...tool,
      label: tool.name,
      execute: async (toolCallId, params, signal) => {
        const args = params as Record<string, any>;
        return wrapResult(await executeWebTool(makeToolCall(toolCallId, tool.name, args), signal), tool.name);
      },
    });
  }

  // Browser tools
  for (const tool of BROWSER_TOOLS) {
    tools.push({
      ...tool,
      label: tool.name,
      execute: async (toolCallId, params, signal) => {
        const args = params as Record<string, any>;
        return wrapResult(await executeBrowserTool(makeToolCall(toolCallId, tool.name, args), chatId, signal, effects), tool.name);
      },
    });
  }

  // Automation tools
  tools.push({
    ...SCHEDULE_REMINDER_TOOL,
    label: "schedule_reminder",
    execute: async (_id, params) => {
      const { createReminderTask } = await import("./automation-storage.js");
      const { getChat } = await import("./chat-storage.js");
      const { resolveCrossChatTarget } = await import("./cross-chat.js");
      const args = params as Record<string, any>;

      // Default destination is the calling chat (the closure's chatId) — the
      // reminder fires where the context lives. If the calling chat can't be
      // loaded, fall back to the legacy system chat.
      let destinationChatId: string;
      let destinationLabel: string;
      const explicit = typeof args.targetChat === "string" ? args.targetChat.trim() : "";
      if (explicit) {
        const resolved = await resolveCrossChatTarget(explicit);
        if (!resolved.ok) {
          return wrapResult({ content: resolved.error, isError: true }, "schedule_reminder");
        }
        destinationChatId = resolved.target.id;
        destinationLabel = `${resolved.target.title} (${resolved.target.id})`;
      } else {
        const calling = await getChat(chatId);
        if (calling) {
          destinationChatId = calling.id;
          destinationLabel = `${calling.title} (${calling.id})`;
        } else {
          destinationChatId = "system";
          destinationLabel = "system (the current chat is not a reminder target)";
        }
      }

      const task = await createReminderTask({
        message: args.message,
        title: args.title,
        scheduledAt: args.scheduledAt,
        activationPolicy: args.activationPolicy,
        chatId: destinationChatId,
      });
      return wrapResult({
        content: `Reminder scheduled.\n\n- **ID**: ${task.id}\n- **Title**: ${task.title}\n- **Scheduled**: ${task.nextRunAt}\n- **Policy**: ${task.activationPolicy}\n- **Fires in**: ${destinationLabel}`,
        isError: false,
      }, "schedule_reminder");
    },
  });

  tools.push({
    ...LIST_AUTOMATIONS_TOOL,
    label: "list_automations",
    execute: async (_id, params) => {
      const { listAutomationTasks, listEnabledAutomationTasks, listArchivedAutomationTasks } = await import("./automation-storage.js");
      const args = params as Record<string, any>;
      const filter = args.filter || "all";

      let tasks: ReturnType<typeof listAutomationTasks>;
      if (filter === "history") {
        tasks = listArchivedAutomationTasks();
      } else if (filter === "enabled") {
        tasks = listEnabledAutomationTasks();
      } else {
        tasks = listAutomationTasks();
      }

      if (filter === "agent-created") {
        tasks = tasks.filter(t => t.createdBy === "agent");
      } else if (filter === "built-in") {
        tasks = tasks.filter(t => t.builtIn);
      }

      const includeRuns = args.includeRuns === true;
      const lines = tasks.map(t => {
        const schedule = t.schedule.type === "once"
          ? `once @ ${t.schedule.runAt}`
          : t.schedule.type === "daily"
            ? `daily @ ${t.schedule.timeOfDay}`
            : `every ${t.schedule.everyMinutes}m`;
        let line = `- **${t.title}** (${t.id})\n  Schedule: ${schedule} | Policy: ${t.activationPolicy} | ${t.enabled ? 'Enabled' : 'Disabled'}\n  Next: ${t.nextRunAt || 'N/A'} | Steps: ${t.promptSteps.length}`;
        if (includeRuns && t.lastRunAt) {
          line += `\n  Last: ${t.lastRunAt} (${t.lastStatus || 'unknown'})`;
        }
        if (t.archived) {
          line += "\n  _Archived (completed)_";
        } else if (t.createdBy === "agent") {
          line += " [your reminder]";
        }
        return line;
      });

      return wrapResult({
        content: `${filter === "history" ? "Archived automations" : "Automations"} (${tasks.length} total):\n\n${lines.join("\n\n")}`,
        isError: false,
      }, "list_automations");
    },
  });

  tools.push({
    ...UPDATE_AUTOMATION_TOOL,
    label: "update_automation",
    execute: async (_id, params) => {
      const { getAutomationTask, updateAutomationTask } = await import("./automation-storage.js");
      const args = params as Record<string, any>;
      const existing = getAutomationTask(args.automationId);
      if (!existing) {
        return wrapResult({ content: `Automation "${args.automationId}" not found.`, isError: true }, "update_automation");
      }

      // Permission checks
      const isAgentTask = existing.createdBy === "agent";
      const isBuiltIn = existing.builtIn;

      if (!isAgentTask && !isBuiltIn) {
        return wrapResult({
          content: `Cannot modify "${existing.title}" — this automation was created by the user and is read-only for the agent. You can suggest changes in your response.`,
          isError: true,
        }, "update_automation");
      }

      const patch: Record<string, any> = { id: args.automationId };

      if (args.promptSteps !== undefined) {
        patch.promptSteps = args.promptSteps;
      }

      if (isAgentTask) {
        if (args.title !== undefined) patch.title = args.title;
        if (args.enabled !== undefined) patch.enabled = args.enabled;
        if (args.runAt !== undefined) {
          const runMs = new Date(String(args.runAt)).getTime();
          if (!Number.isFinite(runMs) || runMs <= Date.now() + 2 * 60 * 1000) {
            return wrapResult({
              content: "runAt must be a valid ISO timestamp at least 2 minutes in the future.",
              isError: true,
            }, "update_automation");
          }
          patch.schedule = { type: "once", runAt: new Date(runMs).toISOString() };
          if (args.enabled === undefined) patch.enabled = true;
        }
        if (args.everyMinutes !== undefined) {
          const minutes = Math.floor(Number(args.everyMinutes));
          if (!Number.isFinite(minutes) || minutes < 1) {
            return wrapResult({
              content: "everyMinutes must be a positive number of minutes.",
              isError: true,
            }, "update_automation");
          }
          patch.schedule = { type: "interval", everyMinutes: minutes };
          if (args.enabled === undefined) patch.enabled = true;
        }
      } else if (isBuiltIn) {
        // Built-in: only promptSteps allowed
        if (
          args.title !== undefined ||
          args.enabled !== undefined ||
          args.runAt !== undefined ||
          args.everyMinutes !== undefined
        ) {
          return wrapResult({
            content: `Cannot modify structural fields (title, enabled, schedule) on built-in automation "${existing.title}". Only prompt steps can be edited.`,
            isError: true,
          }, "update_automation");
        }
      }

      const updated = updateAutomationTask(args.automationId, patch);
      if (!updated) {
        return wrapResult({ content: `Failed to update automation "${args.automationId}".`, isError: true }, "update_automation");
      }

      return wrapResult({
        content: `Updated "${updated.title}" (${updated.id}).`,
        isError: false,
      }, "update_automation");
    },
  });

  tools.push({
    ...SCHEDULE_CHAT_MESSAGE_TOOL,
    label: "schedule_chat_message",
    execute: async (_id, params) => {
      const { resolveCrossChatTarget, deliverCrossChatPost, crossChatOriginTitle } = await import("./cross-chat.js");
      const { createCrossChatTask } = await import("./automation-storage.js");
      const args = params as Record<string, any>;

      const body = typeof args.message === "string" ? args.message.trim() : "";
      if (!body) {
        return wrapResult({ content: "message is required.", isError: true }, "schedule_chat_message");
      }
      const wake = args.wake === true;

      const resolved = await resolveCrossChatTarget(String(args.targetChat ?? ""));
      if (!resolved.ok) {
        return wrapResult({ content: resolved.error, isError: true }, "schedule_chat_message");
      }

      const fromChatTitle = crossChatOriginTitle(chatId);
      const subject = typeof args.subject === "string" ? args.subject.trim() : "";
      const whenRaw = typeof args.when === "string" ? args.when.trim() : "";

      if (!wake && !whenRaw) {
        try {
          const result = await deliverCrossChatPost({
            targetChatId: resolved.target.id,
            fromChatId: chatId,
            fromChatTitle,
            subject,
            body,
          });
          return wrapResult({
            content: `Delivered to **${result.chatTitle}** (${result.chatId}).`,
            isError: false,
          }, "schedule_chat_message");
        } catch (e: any) {
          return wrapResult(
            { content: `Delivery failed: ${e?.message || e}`, isError: true },
            "schedule_chat_message",
          );
        }
      }

      let runAtIso: string;
      if (!whenRaw) {
        runAtIso = new Date().toISOString();
      } else {
        const whenMs = new Date(whenRaw).getTime();
        if (!Number.isFinite(whenMs) || whenMs <= Date.now() + 2 * 60 * 1000) {
          return wrapResult({
            content: "`when` must be a valid ISO timestamp at least 2 minutes in the future.",
            isError: true,
          }, "schedule_chat_message");
        }
        runAtIso = new Date(whenMs).toISOString();
      }

      try {
        const task = await createCrossChatTask({
          targetChatId: resolved.target.id,
          targetChatTitle: resolved.target.title,
          fromChatId: chatId,
          fromChatTitle,
          subject,
          body,
          runAt: runAtIso,
          wake,
        });
        const headline = wake
          ? whenRaw
            ? `Scheduled wake for ${task.nextRunAt}.`
            : `Scheduled wake for the next scheduler tick (~${task.nextRunAt}); there is no immediate kick.`
          : `Scheduled delivery for ${task.nextRunAt}.`;
        return wrapResult({
          content:
            `${headline}\n\n` +
            `- **ID**: ${task.id}\n` +
            `- **To**: ${resolved.target.title} (${resolved.target.id})\n` +
            `- **Subject**: ${subject || "(none)"}` +
            (wake ? "\n- The target thread's agent will run a continue turn after the post lands." : ""),
          isError: false,
        }, "schedule_chat_message");
      } catch (e: any) {
        return wrapResult(
          { content: `Scheduling failed: ${e?.message || e}`, isError: true },
          "schedule_chat_message",
        );
      }
    },
  });

  tools.push({
    ...LIST_CHATS_TOOL,
    label: "list_chats",
    execute: async (_id, params) => {
      const { listChats } = await import("./chat-storage.js");
      const args = params as Record<string, any>;
      const limit = Math.min(Math.max(Math.floor(Number(args.limit)) || 50, 1), 200);
      const chats = (await listChats()).slice(0, limit);
      if (chats.length === 0) {
        return wrapResult({ content: "No chats.", isError: false }, "list_chats");
      }
      const lines = chats.map((chat) => {
        const preview = (chat.preview || "").replace(/\s+/g, " ").trim().slice(0, 90);
        return `- **${chat.title}** (${chat.id}) [${chat.type}] · ${chat.lastModified}${preview ? `\n  ${preview}` : ""}`;
      });
      return wrapResult({
        content: `Chats (${chats.length}):\n\n${lines.join("\n\n")}`,
        isError: false,
      }, "list_chats");
    },
  });

  // Filesystem tools
  tools.push({
    ...READ_FILE_TOOL,
    label: "read_file",
    execute: async (_id, params, signal) => {
      const settings = await getSettings().catch(() => undefined);
      const workspace = await workspacePromise;
      return wrapResult(await workspace.readFile(params as Record<string, any>, {
        defaultLines: settings?.readFileDefaultLines,
        maxBytes: getReadFileMaxBytes(settings?.readFileMaxBytes, contextWindow),
      }, signal), "read_file");
    },
  });

  tools.push({
    ...WRITE_FILE_TOOL,
    label: "write_file",
    execute: async (_id, params, signal) => {
      const workspace = await workspacePromise;
      return withMutationLock(`workspace:${workspace.label}`, async () =>
        wrapResult(await workspace.writeFile(params as Record<string, any>, signal), "write_file"));
    },
  });

  tools.push({
    ...EDIT_FILE_TOOL,
    label: "edit_file",
    execute: async (_id, params, signal) => {
      const workspace = await workspacePromise;
      return withMutationLock(`workspace:${workspace.label}`, async () =>
        wrapResult(await workspace.editFile(params as Record<string, any>, signal), "edit_file"));
    },
  });

  tools.push({
    ...LIST_FILES_TOOL,
    label: "list_files",
    execute: async (_id, params, signal) => {
      const workspace = await workspacePromise;
      return wrapResult(await workspace.listFiles(params as Record<string, any>, signal), "list_files");
    },
  });

  // code_search (Phase 0, docs/design/code-search.md): read-only and
  // lock-free — no withMutationLock, parallel-safe like read_file. The
  // executor owns budgets (maxMatches / skip / char cap / timeout); errors
  // arrive as CodeSearchError with model-readable messages.
  if (codeSearchEnabled()) {
    tools.push({
      ...CODE_SEARCH_TOOL,
      label: "code_search",
      execute: async (_id, params, signal) => {
        try {
          // S1 (§4.2): snippet mode at the model level — the same route as the
          // kernel dispatcher (identical semantics; text projection instead of
          // the structured value). No filesystem, no workspace: a pattern test
          // must not depend on the scan surface resolving.
          const p = params as Record<string, any>;
          if (typeof p.code === "string") {
            const snippetParams = {
              pattern: String(p.pattern ?? ""),
              code: p.code,
              lang: p.lang,
              maxMatches: p.maxMatches,
              skip: p.skip,
            };
            const result = runCodeSearchOnSnippet(snippetParams, signal);
            return wrapResult({ content: renderSnippetText(snippetParams, result), isError: false }, "code_search");
          }
          const workspace = await workspacePromise;
          const result = await runCodeSearch(p as CodeSearchParams, workspace, signal);
          return wrapResult({ content: result.text, isError: false }, "code_search");
        } catch (e: any) {
          return wrapResult(
            { content: e instanceof CodeSearchError ? e.message : `code_search failed: ${e.message}`, isError: true },
            "code_search",
          );
        }
      },
    });
  }

  tools.push({
    ...BASH_TOOL,
    label: "bash",
    execute: async (_id, params, signal, onUpdate) => {
      const workspace = await workspacePromise;
      const args = params as Record<string, any>;
      const wantsBackground = args.background === true || args.service === true;
      if (wantsBackground) {
        if (workspace.kind !== "local" || !workspace.localRoot) {
          return wrapResult(
            {
              content:
                "[background commands are local-only for now; run this foreground on the SSH workspace]",
              isError: true,
            },
            "bash",
          );
        }
        const service = args.service === true;
        const timeoutSec = Number(args.timeout ?? 3600);
        if (!service && (!Number.isFinite(timeoutSec) || timeoutSec < 1 || timeoutSec > 3600)) {
          return wrapResult(
            { content: "background timeout must be between 1 and 3600 seconds", isError: true },
            "bash",
          );
        }
        const readyWhen =
          typeof args.ready_when === "string" && args.ready_when.trim()
            ? args.ready_when.trim()
            : null;
        const readyTimeoutSec = Math.min(
          300,
          Math.max(1, Number(args.ready_timeout ?? 30) || 30),
        );
        const pause = await getStoredSystemPauseState().catch(() => null);
        if (pause?.active) {
          return wrapResult(
            { content: "[system paused: background jobs cannot start]", isError: true },
            "bash",
          );
        }
        try {
          const job = await startSupervisorJob({
            chat_id: chatId,
            kind: service ? "service" : "command",
            command: String(args.command ?? ""),
            cwd: workspace.localRoot,
            // Same hardening the foreground shell gets: a background command
            // has no stdin either, and an editor, credential prompt, or pager
            // would otherwise hang toward the timeout in a process that
            // outlives the server.
            env: { ...process.env, ...BASH_ENV_HARDENING },
            timeout_ms: service ? undefined : Math.round(timeoutSec * 1000),
            workspace: workspace.label,
          });
          let readiness: string | null = null;
          if (readyWhen) {
            try {
              const result = await waitForSupervisorJob(
                job.job_id,
                readyWhen,
                readyTimeoutSec * 1000,
              );
              if (result.matched) {
                readiness = `Readiness: matched "${readyWhen}"${result.line ? `: ${result.line}` : ""}.`;
              } else if (result.finished) {
                readiness = `Readiness: the job exited before "${readyWhen}" appeared.`;
              } else {
                readiness = `Readiness: "${readyWhen}" did not appear within ${readyTimeoutSec}s; the job is still running.`;
              }
            } catch (error) {
              readiness = `Readiness check failed: ${
                error instanceof Error ? error.message : String(error)
              }.`;
            }
          }
          const output = job.output_paths[0] ? `\nOutput: ${job.output_paths[0]}` : "";
          const label = service ? "service" : "background command";
          return wrapResult(
            {
              content:
                `Started ${label} ${job.job_id} (${job.state}).${output}` +
                `${readiness ? `\n${readiness}` : ""}\n` +
                "It runs without holding the turn. Check with jobs status/tail on a later turn; do not poll.",
              isError: false,
            },
            "bash",
          );
        } catch (error) {
          return wrapResult(
            {
              content: `Could not start background job: ${
                error instanceof Error ? error.message : String(error)
              }`,
              isError: true,
            },
            "bash",
          );
        }
      }
      const timeoutSec = Number(args.timeout ?? 30);
      if (typeof args.ready_when === "string" && args.ready_when.trim()) {
        return wrapResult(
          { content: "ready_when requires background: true or service: true", isError: true },
          "bash",
        );
      }
      if (Number.isFinite(timeoutSec) && timeoutSec > 300) {
        return wrapResult(
          {
            content:
              "Foreground bash timeout is capped at 300s; use background: true for longer work.",
            isError: true,
          },
          "bash",
        );
      }
      return withMutationLock(`workspace:${workspace.label}`, async () =>
        wrapResult(
          await workspace.bash(args, signal, {
            chatId,
            resultBudgetChars: getMaxToolResultChars(contextWindow),
            onUpdate: onUpdate
              ? (view) => onUpdate({ content: [{ type: "text", text: view.text }], details: {} })
              : undefined,
          }),
          "bash",
        ));
    },
  });

  tools.push({
    ...RUN_PYTHON_TOOL,
    label: "run_python",
    execute: async (_id, params, signal, onUpdate) => {
      const workspace = await workspacePromise;
      const args = params as Record<string, any>;
      return withMutationLock(`workspace:${workspace.label}`, async () => {
        // Every local chat gets the kernel, system chats included. The
        // manager keys on chatId alone, and the system-chat cadence (runs
        // spaced past the idle TTL) rides snapshot/restore exactly like an
        // idle agent chat (docs/design/session-python-kernel.md §8.1).
        // P4: an SSH workspace MAY carry a host-side kernel — the adapter
        // supplies it when the feature flag is on and preconditions hold;
        // null keeps the per-call path (docs/design/remote-python-kernel.md §4.1).
        const background = args.background === true;
        const kernelHost =
          workspace.kind === "local" ? undefined : await workspace.createKernelHost?.();
        const useKernel = workspace.kind === "local" || kernelHost != null;
        if (useKernel) {
          const maxSec = background ? 3600 : 300;
          // Background defaults to its own ceiling: the path exists for work
          // longer than the foreground default, and a lazy background: true
          // should not silently die at 30 s. Foreground keeps 30 s as the
          // fast-fail signal (it holds the global turn-gate lease). Over a
          // remote host the job runs in the host kernel; its full output is
          // delivered into the remote workspace at completion (§4.6).
          const timeoutSec = Math.min(maxSec, Math.max(1, args.timeout || (background ? 3600 : 30)));
          const outcome = await executeInKernel({
            chatId,
            cwd: workspace.label,
            code: String(args.code ?? ""),
            timeoutMs: timeoutSec * 1000,
            signal,
            background,
            host: kernelHost ?? undefined,
            // Kernel tools ride the same per-execute seam; the manager gates
            // on its env flag and registers this for the cell/job lifetime.
            toolDispatcher: kernelToolsEnabled() ? createKernelToolDispatcher(workspace, chatId) : undefined,
            // The cell's inline windows are sized from the same budget this
            // tool's own wrapper head-keeps at, so the composition arrives whole
            // and the spill pointers are never the part that gets cut.
            resultBudgetChars: getMaxToolResultChars(contextWindow),
            onUpdate: onUpdate
              ? (text) => onUpdate({ content: [{ type: "text", text }], details: {} })
              : undefined,
          });
          if (outcome.mode === "kernel") {
            const content = outcome.images?.length
              ? [
                  { type: "text" as const, text: outcome.content },
                  ...outcome.images.map((image) => ({
                    type: "image" as const,
                    data: image.data,
                    mimeType: image.mimeType,
                  })),
                ]
              : outcome.content;
            return wrapResult({ content, isError: outcome.isError }, "run_python");
          }
          const oneShot = await workspace.runPython(args, signal, {
            chatId,
            resultBudgetChars: getMaxToolResultChars(contextWindow),
          });
          const notice = background
            ? `${KERNEL_FALLBACK_NOTICES[outcome.reason]} (background unavailable; ran synchronously)`
            : KERNEL_FALLBACK_NOTICES[outcome.reason];
          return wrapResult(
            {
              content: `${notice}\n${oneShot.content}`,
              isError: oneShot.isError,
            },
            "run_python",
          );
        }
        const oneShot = await workspace.runPython(args, signal, {
          chatId,
          resultBudgetChars: getMaxToolResultChars(contextWindow),
        });
        // Reached only by remote workspaces without a kernel host now — local
        // chats fell through the kernel path (or its one-shot fallback with
        // its own notice).
        const prefixes: string[] = [];
        if (background) prefixes.push("[background unavailable in stateless mode; ran synchronously]");
        if (prefixes.length > 0) {
          return wrapResult(
            {
              content: `${prefixes.join(" ")}\n${oneShot.content}`,
              isError: oneShot.isError,
            },
            "run_python",
          );
        }
        return wrapResult(oneShot, "run_python");
      });
    },
  });

  const executeJobs = async (label: string, args: Record<string, any>) => {
    const result = (content: string, isError = false) => wrapResult({ content, isError }, label);
    const action = String(args.action || "list");
    if (action === "list") {
      const jobs = await listJobsForChat(chatId);
      const kind = typeof args.kind === "string" ? args.kind : null;
      const filtered = kind ? jobs.filter((job) => job.kind === kind) : jobs;
      if (filtered.length === 0) return result("No background jobs for this chat.");
      suppressJobNotices(
        filtered.filter((job) => isTerminalJobState(job.state)).map((job) => job.job_id),
      );
      const note =
        !isSupervisorConnected() &&
        filtered.some((job) => job.source === "supervisor" && job.state === "running")
          ? "\n[supervisor unavailable; showing last known state]"
          : "";
      return result(filtered.map(formatJobSummary).join("\n") + note);
    }

    const jobId = typeof args.jobId === "string" ? args.jobId.trim() : "";
    if (!jobId) return result(`${label} ${action} requires jobId`, true);

    if (action === "status") {
      await refreshSupervisorJob(jobId);
      const job = getJobView(jobId);
      if (!job || job.chat_id !== chatId) return result(`Unknown job: ${jobId}`, true);
      if (isTerminalJobState(job.state)) suppressJobNotices([jobId]);
      return result(formatJobDetail(job));
    }

    if (action === "tail") {
      const requested =
        typeof args.lines === "number"
          ? Math.min(200, Math.max(1, Math.floor(args.lines)))
          : 50;
      const job = getJobView(jobId);
      if (!job || job.chat_id !== chatId) return result(`Unknown job: ${jobId}`, true);
      if (isTerminalJobState(job.state)) suppressJobNotices([jobId]);
      if (job.state === "running" && wasTailedRecently(chatId, jobId)) {
        return result(
          `[${jobId} is still running; output already tailed recently. End your turn and check again later — do not poll.]`,
        );
      }
      let text = "";
      let outputMissing = false;
      if (job.source === "kernel") {
        const live = tailKernelJob(chatId, jobId, requested);
        if (live.found) text = live.text ?? "";
      }
      if (!text && job.output_paths[0]) {
        try {
          text = await readJobOutputTail(job.output_paths[0], requested);
        } catch (error) {
          text = "";
          if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
            outputMissing = true;
          }
        }
      }
      if (job.source === "supervisor" && job.output_paths[1]) {
        try {
          const stderr = await readJobOutputTail(job.output_paths[1], requested);
          if (stderr.trim()) text = `${text}${text ? "\n" : ""}${stderr}`;
        } catch (error) {
          // No stderr file yet.
          if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
            outputMissing = true;
          }
        }
      }
      if (!text) {
        text =
          job.state === "running"
            ? "(no output yet)"
            : job.state === "lost"
              ? "(no retained output; outcome unknown)"
              : outputMissing && (job.state === "finished" || job.state === "stopped")
                ? "(output expired by retention)"
                : "(no output)";
      }
      if (job.stop_reason === "log-cap" && job.state !== "lost") {
        text = `${text}${text ? "\n" : ""}[output capped; older output discarded]`;
      }
      if (job.state === "running") markTailed(chatId, jobId);
      return result(`[${job.state}] ${jobId}\n${text.trimEnd()}`);
    }

    if (action === "kill") {
      const job = getJobView(jobId);
      if (!job || job.chat_id !== chatId) return result(`Unknown job: ${jobId}`, true);
      if (["finished", "stopped", "lost", "failed"].includes(job.state)) {
        suppressJobNotices([jobId]);
        return result(`Job ${jobId} is already ${job.state}.`);
      }
      const force = args.force === true;
      if (job.source === "supervisor") {
        try {
          const stopped = await stopSupervisorJob(jobId, force);
          suppressJobNotices([jobId]);
          if (stopped.state === "lost") {
            return result(
              `Stop requested for ${jobId}, but the process group did not confirm death; outcome unknown.`,
              true,
            );
          }
          return result(
            `Stopped ${jobId} (${stopped.stop_reason ?? stopped.state}).`,
          );
        } catch (error) {
          return result(
            `Could not stop ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
            true,
          );
        }
      }
      const killed = killKernelJob(chatId, jobId, force);
      if (!killed.ok) {
        const hint =
          killed.reason === "kernel wedged"
            ? " Use force: true to kill the kernel (loses the namespace)."
            : "";
        return result(`Could not kill ${jobId}: ${killed.reason}.${hint}`, true);
      }
      suppressJobNotices([jobId]);
      return result(
        force
          ? `Killed the kernel for this chat; ${jobId} and the namespace are gone.`
          : `Kill requested for ${jobId}; it ends at the next suspension point.`,
      );
    }

    if (action === "wait_for") {
      if (jobId) await refreshSupervisorJob(jobId);
      const job = getJobView(jobId);
      if (!job || job.chat_id !== chatId) return result(`Unknown job: ${jobId}`, true);
      if (job.source !== "supervisor") {
        return result(
          "wait_for applies to supervisor commands/services; use status/tail for a kernel cell.",
          true,
        );
      }
      const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
      if (!pattern) return result("wait_for requires pattern", true);
      const timeoutSec = Math.min(300, Math.max(1, Number(args.timeout ?? 30) || 30));
      try {
        const waited = await waitForSupervisorJob(jobId, pattern, timeoutSec * 1000);
        if (waited.matched) {
          return result(
            `Matched "${pattern}"${waited.line ? `: ${waited.line}` : ""}.`,
          );
        }
        if (waited.finished) {
          return result(`Job ${jobId} finished before "${pattern}" appeared.`);
        }
        return result(
          `"${pattern}" did not appear within ${timeoutSec}s; the job is still running.`,
        );
      } catch (error) {
        return result(
          `wait_for failed: ${error instanceof Error ? error.message : String(error)}`,
          true,
        );
      }
    }

    return result(`Unknown ${label} action: ${action}`, true);
  };

  tools.push({
    ...JOBS_TOOL,
    label: "jobs",
    execute: async (_id, params) => executeJobs("jobs", params as Record<string, any>),
  });

  tools.push({
    ...PYTHON_JOBS_TOOL,
    label: "python_jobs",
    execute: async (_id, params) => executeJobs("python_jobs", params as Record<string, any>),
  });

  tools.push({
    ...READ_PDF_TOOL,
    label: "read_pdf",
    execute: async (_id, params, signal) => {
      const workspace = await workspacePromise;
      return wrapResult(await executeReadPdf(params as Record<string, any>, workspace, signal), "read_pdf");
    },
  });

  // create_artifact — uses effects.onArtifact callback
  tools.push({
    ...CREATE_ARTIFACT_TOOL,
    label: "create_artifact",
    execute: async (_id, params) => {
      const args = params as Record<string, any>;
      const id = uuid();
      const display = args.display === "inline" ? "inline" : "panel";
      const warningText = formatArtifactGuidanceWarnings(getArtifactGuidanceWarnings(args.html));

      if (display === "inline") {
        const result = await createVisual(id, args.html, args.title);
        const visual = { id, title: args.title, html: args.html, url: result.url, version: result.version };
        effects.onVisual(visual);
        return withArtifactPreviewReview(`Visual created: "${args.title}"
Canonical ID: ${id}
URL: ${result.url}${warningText}`, {
          id: visual.id,
          title: visual.title,
          url: visual.url,
          version: visual.version,
          objectKind: "visual",
          automaticUpdateCount: automaticUpdateCountForCreate(id),
        });
      }

      const result = await createArtifact(id, args.html, args.title);
      const artifact = { id, title: args.title, url: result.url, version: result.version };
      effects.onArtifact(artifact);
      return withArtifactPreviewReview(`Artifact created: "${args.title}"
Canonical ID: ${id}
URL: ${result.url}${warningText}`, {
        ...artifact,
        objectKind: "artifact",
        automaticUpdateCount: automaticUpdateCountForCreate(id),
      });
    },
  });

  // update_artifact can update both artifacts and inline visuals. They share
  // the same versioned on-disk layout, but live in separate data directories.
  tools.push({
    ...UPDATE_ARTIFACT_TOOL,
    label: "update_artifact",
    execute: async (_id, params) => {
      const args = params as Record<string, any>;
      return withMutationLock(`artifact:${args.artifactId}`, async () => {
        const isVis = await existsVisual(args.artifactId);
        if (isVis) {
          const result = await updateVisual(args.artifactId, args.html, args.changeSummary);
          const warningText = formatArtifactGuidanceWarnings(getArtifactGuidanceWarnings(args.html));
          const visual = { id: args.artifactId, title: "Updated visual", html: args.html, url: result.url, version: result.version };
          effects.onVisual(visual);
          return withArtifactPreviewReview(`Visual updated to version ${result.version} (${result.url})${warningText}`, {
            id: visual.id,
            title: visual.title,
            url: visual.url,
            version: visual.version,
            objectKind: "visual",
            automaticUpdateCount: automaticUpdateCountForUpdate(visual.id),
          });
        }

        try {
          const result = await updateArtifact(args.artifactId, args.html, args.changeSummary);
          const warningText = formatArtifactGuidanceWarnings(getArtifactGuidanceWarnings(args.html));
          const artifact = { id: args.artifactId, title: "Updated artifact", url: result.url, version: result.version };
          effects.onArtifact(artifact);
          return withArtifactPreviewReview(`Artifact updated to version ${result.version} (${result.url})${warningText}`, {
            ...artifact,
            objectKind: "artifact",
            automaticUpdateCount: automaticUpdateCountForUpdate(artifact.id),
          });
        } catch (e: any) {
          throw new Error(`Error updating: ${e.message}. Make sure the ID is from a previously created artifact or visual.`);
        }
      });
    },
  });

  // ask_user — notifies the route via callback; the route owns the abort logic
  tools.push({
    ...ASK_USER_TOOL,
    label: "ask_user",
    execute: async (toolCallId, params) => {
      const args = params as Record<string, any>;
      const question = args.question || "What would you like me to do?";
      // Normalize preset answers: strings only, trimmed, deduped, bounded.
      // Empty/absent keeps the plain free-form ask.
      let options: string[] | undefined;
      if (Array.isArray(args.options)) {
        const cleaned = [...new Set(
          args.options
            .filter((o: unknown): o is string => typeof o === "string")
            .map((o: string) => o.trim())
            .filter((o: string) => o.length > 0)
        )].slice(0, 6);
        if (cleaned.length >= 2) options = cleaned;
      }
      effects.onAskUser(question, toolCallId, options);
      return { content: [{ type: "text", text: "Waiting for user response..." }], details: {} };
    },
  });

  // Skill tools
  for (const tool of SKILL_TOOLS) {
    tools.push({
      ...tool,
      label: tool.name,
      execute: async (toolCallId, params) => {
        const args = params as Record<string, any>;
        return wrapResult(await executeSkillTool(makeToolCall(toolCallId, tool.name, args)), tool.name);
      },
    });
  }

  const available = tools
    .filter((tool) => toolIsAvailable(tool.name, chatType))
    .map((tool) => SEQUENTIAL_TOOL_NAMES.has(tool.name) ? { ...tool, executionMode: "sequential" as const } : tool);
  return wrapToolsWithTimeMarker(wrapToolsWithNormalizedContent(available), timeMarker ?? null);
}

// --- read_pdf implementation ---

import { fileURLToPath } from "url";
const PDF_EXTRACT_SCRIPT = join(fileURLToPath(new URL(".", import.meta.url)), "pdf-extract.py");

/**
 * Fetch a PDF from a URL and return the buffer.
 */
const MAX_PDF_BYTES = 50 * 1024 * 1024;

async function fetchPdfFromUrl(url: string, signal?: AbortSignal, timeoutMs: number = 30000): Promise<Buffer> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; porrima/1.0)",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > MAX_PDF_BYTES) {
      throw new Error(`PDF exceeds the ${MAX_PDF_BYTES / 1024 / 1024}MB size limit`);
    }

    if (!response.body) throw new Error("PDF response had no body");
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_PDF_BYTES) {
        await reader.cancel();
        throw new Error(`PDF exceeds the ${MAX_PDF_BYTES / 1024 / 1024}MB size limit`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, totalBytes);
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Execute the read_pdf tool using PyMuPDF via Python sandbox.
 * The extraction script lives in pdf-extract.py alongside this module.
 */
async function executeReadPdf(
  args: Record<string, any>,
  workspace: WorkspaceAdapter,
  signal?: AbortSignal,
): Promise<{ content: string | any[]; isError: boolean }> {
  const pathOrUrl = args.path;
  if (!pathOrUrl) {
    return { content: "Missing required parameter: path", isError: true };
  }

  const extractImages = args.extractImages === true;
  const ocr = args.ocr === true;
  const pages = args.pages || "all";
  if (pages !== "all" && !/^\d+(?:-\d+)?$/.test(pages)) {
    return { content: "Invalid pages value. Use 'all', a page number, or a range such as '1-5'.", isError: true };
  }

  let pdfBuffer: Buffer | null = null;

  try {
    // Handle URL vs local path
    if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
      pdfBuffer = await fetchPdfFromUrl(pathOrUrl, signal);
    } else {
      const pythonCode = await readFile(PDF_EXTRACT_SCRIPT, "utf-8");
      const result = await workspace.runPython({
        code: pythonCode,
        argv: [pathOrUrl, String(extractImages), String(ocr), pages],
        timeout: 30,
      }, signal, { trusted: true, maxBuffer: 10 * 1024 * 1024 });
      return await parsePdfExecutionResult(result, ocr, result.content, "", extractImages);
    }

    // Write the PDF buffer to a temp file the script can read by path.
    const { tmpdir: tmp } = await import("os");
    const { writeFile: writeFileTmp, mkdir: mkdirTmp, rm: rmTmp } = await import("fs/promises");
    const pdfSandboxDir = join(tmp(), `porrima-pdf-${uuid()}`);
    await mkdirTmp(pdfSandboxDir, { recursive: true });
    const pdfFilePath = join(pdfSandboxDir, "input.pdf");
    await writeFileTmp(pdfFilePath, pdfBuffer);

    // Load the extraction script from the bundled Python file.
    const pythonCode = await readFile(PDF_EXTRACT_SCRIPT, "utf-8");

    try {
      // Same one-shot path as the local branch: supervised group, and the
      // internal maxBuffer keeps the JSON payload complete for parsing.
      const result = await workspace.runPython({
        code: pythonCode,
        argv: [pdfFilePath, String(extractImages), String(ocr), pages],
        timeout: 30,
      }, signal, { trusted: true, maxBuffer: 10 * 1024 * 1024 });

      return await parsePdfExecutionResult(
        result,
        ocr,
        result.content,
        result.isError ? result.content : "",
        extractImages,
      );
    } finally {
      rmTmp(pdfSandboxDir, { recursive: true, force: true }).catch(() => {});
    }

  } catch (e: any) {
    return { content: `PDF processing failed: ${e.message}`, isError: true };
  }
}

/**
 * MIME type from image file extension.
 */
function mimeTypeFromExt(ext: string): string {
  switch (ext?.toLowerCase()) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "bmp": return "image/bmp";
    case "tiff":
    case "tif": return "image/tiff";
    case "webp": return "image/webp";
    default: return "image/png";
  }
}

async function parsePdfExecutionResult(
  result: { content: string; isError: boolean },
  ocr: boolean,
  stdout = result.content,
  stderr = result.isError ? result.content : "",
  extractImages = false,
): Promise<{ content: string | any[]; isError: boolean }> {
  if (result.isError) {
    if (stderr.includes("No module named") && (stderr.includes("fitz") || stderr.includes("pymupdf4llm"))) {
      return { content: "PyMuPDF or pymupdf4llm is not installed in the active workspace environment.", isError: true };
    }
    if (/timed out|aborted/i.test(stderr)) {
      return { content: stderr, isError: true };
    }
    return { content: `PDF processing failed: ${stderr || stdout}`, isError: true };
  }
  try {
    const parsed = JSON.parse(stdout);
    const parsedImageDir = typeof parsed.image_dir === "string" ? parsed.image_dir : undefined;
    const formatted = formatPdfResult(parsed, extractImages);
    const textContent = !ocr && parsed.text.trim().length < 10 && parsed.metadata.pages > 0
      ? `⚠️ This PDF appears to be scanned. Try again with ocr=true.\n\n${formatted}`
      : formatted;

    // Build multi-part content when images are available
    if (extractImages && parsedImageDir && parsed.images?.length > 0) {
      const content: any[] = [{ type: "text", text: textContent }];
      const maxImages = 5;
      const images = parsed.images.slice(0, maxImages);

      for (const img of images) {
        if (img.path) {
          try {
            const imgBuffer = readFile(img.path);
            content.push({
              type: "image",
              data: (await imgBuffer).toString("base64"),
              mimeType: mimeTypeFromExt(img.ext),
              name: `pdf-page${img.page}-img${img.index}`,
            });
          } catch {
            // Skip unreadable images silently
          }
        }
      }

      if (parsed.images.length > maxImages) {
        content[0].text += `\n\n[Note: ${parsed.images.length - maxImages} additional image(s) omitted from this call. Use a narrower page range to access them.]`;
      }

      // Clean up image directory — safe to do here since we've already read all image data
      rm(parsedImageDir, { recursive: true, force: true }).catch(() => {});

      return { content, isError: false };
    }

    // No images requested (or none found): the extractor may still have created
    // a scratch image directory.
    if (parsedImageDir) {
      rm(parsedImageDir, { recursive: true, force: true }).catch(() => {});
    }

    return { content: textContent, isError: false };
  } catch (e: any) {
    return { content: `Failed to parse PDF result: ${e.message}\n${stdout.slice(0, 500)}`, isError: true };
  }
}

/**
 * Format the PDF extraction result as markdown.
 */
function formatPdfResult(result: { text: string; pages: any[]; images: any[]; metadata: any; image_dir?: string }, extractImages: boolean): string {
  const parts: string[] = [];
  
  // Metadata section
  parts.push("## PDF Metadata");
  parts.push(`- **Pages**: ${result.metadata.pages}`);
  if (result.metadata.title) parts.push(`- **Title**: ${result.metadata.title}`);
  if (result.metadata.author) parts.push(`- **Author**: ${result.metadata.author}`);
  if (result.metadata.subject) parts.push(`- **Subject**: ${result.metadata.subject}`);
  parts.push("");
  
  // Images summary
  if (result.images.length > 0) {
    parts.push("## Figures");
    if (extractImages) {
      parts.push(`Found ${result.images.length} figure region(s) — included inline.`);
    } else {
      parts.push(`Found ${result.images.length} figure region(s):`);
      result.images.forEach((img) => {
        parts.push(`- Page ${img.page}: ${img.width}x${img.height} ${img.ext.toUpperCase()} (${(img.byteLength / 1024).toFixed(1)} KB)`);
      });
      parts.push("");
      parts.push("💡 Use extractImages=true to include figures inline.");
    }
    parts.push("");
  }
  
  // Text content — clean up pymupdf4llm artifacts when images are inline
  let text = result.text || "(no text extracted)";
  if (extractImages) {
    // Remove dead markdown image refs to temp paths
    text = text.replace(/!\[.*?\]\(\/tmp\/porrima-pdf-[^)]*\)/g, "");
    // Remove picture text blocks (OCR'd text from figure regions — usually garbled)
    text = text.replace(/<!-- Start of picture text -->.*?<!-- End of picture text -->/gs, "");
    // Clean up resulting blank lines
    text = text.replace(/\n{3,}/g, "\n\n");
  }
  
  parts.push("## Text Content");
  parts.push(text);
  
  return parts.join("\n");
}
