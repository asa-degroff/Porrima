import { Type, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { readFile, writeFile, mkdir } from "fs/promises";
import { resolve, join } from "path";
import { homedir } from "os";
import { MEMORY_TOOLS, executeMemoryTool } from "./memory-tools.js";
import { WEB_TOOLS, executeWebTool } from "./web-tools.js";
import { executePython, createArtifact, createVisual, updateArtifact, updateVisual, existsVisual } from "./sandbox.js";
import { SKILL_TOOLS, executeSkillTool } from "./skills.js";
import { P5_INSTANCE_MODE_GUIDANCE, formatArtifactGuidanceWarnings, getArtifactGuidanceWarnings } from "./artifact-guidance.js";
import { renderArtifactPreviewScreenshot, type PreviewObjectKind } from "./artifact-preview.js";
import { getSettings } from "./chat-storage.js";
import { getWorkspaceForProject } from "./workspace.js";
import { v4 as uuid } from "uuid";
import type { Artifact, InlineVisual, Project } from "../types.js";
import { appDataPath } from "./paths.js";

const HOME = homedir();
const VISUALS_DIR = appDataPath("visuals");
const MAX_AUTOMATIC_ARTIFACT_REVIEW_UPDATES = 2;

// --- Filesystem tool definitions ---

const READ_FILE_TOOL: Tool = {
  name: "read_file",
  description: "Read the contents of a file. Returns content with line numbers. When `limit` is omitted, returns up to the maximum number of lines. For large files, paginate with `offset`/`limit` instead of issuing repeated full reads.",
  parameters: Type.Object({
    path: Type.String({ description: "File path (relative to working directory or absolute)" }),
    offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-based)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read. Defaults to the configured tool option (1000)." })),
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

const BASH_TOOL: Tool = {
  name: "bash",
  description: "Execute a bash command and return stdout and stderr. Commands run in the working directory (project root for project chats, $HOME for others). Use for system commands, installing packages, running scripts, etc.",
  parameters: Type.Object({
    command: Type.String({ description: "The bash command to execute" }),
    timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default 30)" })),
  }),
};

const RUN_PYTHON_TOOL: Tool = {
  name: "run_python",
  description: "Execute Python code and return the output. Runs in a clean workspace directory with full system access (filesystem, network, environment) and a 30s timeout. Use for data processing, computation, and any Python task.",
  parameters: Type.Object({
    code: Type.String({ description: "Python code to execute" }),
  }),
};

const READ_PDF_TOOL: Tool = {
  name: "read_pdf",
  description: "Read a PDF file and extract text, images, and metadata. Supports local files and URLs. Can use OCR for scanned PDFs.",
  parameters: Type.Object({
    path: Type.String({ description: "PDF path (local file path or URL starting with http/https)" }),
    extractImages: Type.Optional(Type.Boolean({ description: "Extract embedded images from PDF (default false)" })),
    ocr: Type.Optional(Type.Boolean({ description: "Use OCR for scanned PDFs (default false). Requires Tesseract installed." })),
    pages: Type.Optional(Type.String({ description: "Page range to process, e.g. '1-5' or 'all' (default 'all')" })),
  }),
};

const CREATE_ARTIFACT_TOOL: Tool = {
  name: "create_artifact",
  description: `Create an HTML/JS artifact rendered in a sandboxed iframe. Use for interactive demos, visualizations, diagrams, or web pages. Choose display mode: "panel" (default) opens the artifact in a dedicated side panel for complex multi-page interactive apps; "inline" renders it directly in the chat flow for charts, diagrams, flowcharts, and other compact visual aids. Both modes support SVG, Canvas, CSS animations, and CDN libraries (D3.js, Chart.js, Mermaid). ${P5_INSTANCE_MODE_GUIDANCE}`,
  parameters: Type.Object({
    title: Type.String({ description: "Title for the artifact" }),
    html: Type.String({ description: `Complete HTML document (including <html>, <head>, <body> tags). ${P5_INSTANCE_MODE_GUIDANCE}` }),
    display: Type.Optional(Type.String({ description: "Where to render: 'panel' (default, dedicated side panel for complex interactive apps) or 'inline' (rendered in the chat flow for charts, diagrams, and compact visuals)" })),
  }),
};

const UPDATE_ARTIFACT_TOOL: Tool = {
  name: "update_artifact",
  description: `Update an existing artifact or visual with new HTML content. Use when the user asks to modify or improve a previously created artifact. The artifact ID should reference a previously created artifact. ${P5_INSTANCE_MODE_GUIDANCE}`,
  parameters: Type.Object({
    artifactId: Type.String({ description: "The canonical ID of the artifact to update (from a previous create_artifact call)" }),
    html: Type.String({ description: `Complete HTML document with the updated content. ${P5_INSTANCE_MODE_GUIDANCE}` }),
    changeSummary: Type.Optional(Type.String({ description: "Brief description of what changed (e.g., 'Made background blue, added reset button')" })),
  }),
};

const ASK_USER_TOOL: Tool = {
  name: "ask_user",
  description: "Ask the user a question and wait for their response. Use when you need clarification, a decision, or confirmation before proceeding.",
  parameters: Type.Object({
    question: Type.String({ description: "The question to ask the user" }),
  }),
};

// --- Side-effects interface for tool execution ---

export interface ToolSideEffects {
  onArtifact: (artifact: Artifact) => void;
  onVisual: (visual: InlineVisual) => void;
  onAskUser: (question: string, toolCallId: string) => void;
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
  return function wrapResult(result: { content: string; isError: boolean }, toolName?: string): AgentToolResult<{}> {
    if (result.isError) {
      // Truncate error content too — a 1MB error message would blow up the context
      let errText = result.content;
      if (errText.length > maxChars) {
        errText = errText.slice(0, maxChars) + `\n\n[Error output truncated: ${(errText.length / 1024).toFixed(0)}KB → ${(maxChars / 1024).toFixed(0)}KB]`;
      }
      throw new Error(errText);
    }
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
  description: "Schedule a one-time reminder for yourself. Creates a message in the system chat that fires at the specified time, respecting inactivity gates. Use this to follow up on open threads, check on tasks, or revisit ideas later. Reminders run as full automation turns with tool access.",
  parameters: Type.Object({
    message: Type.String({ description: "The prompt content to deliver to your future self — what you want to be reminded to do or think about" }),
    title: Type.String({ description: "Short label for the reminder (e.g. 'Check PR #22616 status')" }),
    scheduledAt: Type.String({ description: "ISO 8601 timestamp for when to fire (must be at least 2 minutes in the future)" }),
    activationPolicy: Type.Optional(Type.Enum(["idle", "absent", "manual_only"] as const, { description: "When to fire: 'idle' (default, fires when system is idle), 'absent' (waits for user absence threshold), 'manual_only' (never auto-fires)" })),
    maxIterations: Type.Optional(Type.Number({ description: "Max tool-loop iterations (default 5)" })),
    timeoutMs: Type.Optional(Type.Number({ description: "Max execution time in ms (default 300000 = 5 min)" })),
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
  description: "Modify an automation task. You can edit your own reminders freely. For built-in automations (synthesis, wake), you can edit prompt steps but not schedule or structural fields. User-created automations are read-only.",
  parameters: Type.Object({
    automationId: Type.String({ description: "Task ID to modify" }),
    title: Type.Optional(Type.String({ description: "Updated title (agent reminders only)" })),
    promptSteps: Type.Optional(Type.Array(Type.Object({
      id: Type.String({ description: "Step ID" }),
      title: Type.String({ description: "Step title" }),
      prompt: Type.String({ description: "Step prompt content" }),
    }), { description: "Updated prompt steps" })),
    enabled: Type.Optional(Type.Boolean({ description: "Toggle on/off (agent reminders only)" })),
  }),
};

const FILESYSTEM_TOOLS: Tool[] = [
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  EDIT_FILE_TOOL,
  LIST_FILES_TOOL,
  BASH_TOOL,
  RUN_PYTHON_TOOL,
  READ_PDF_TOOL,
  CREATE_ARTIFACT_TOOL,
  UPDATE_ARTIFACT_TOOL,
  ASK_USER_TOOL,
];

/** Get tool definitions (name + description) for display/metadata only */
export function getAgentToolDefinitions(chatType?: string): { name: string; description: string }[] {
  const allTools = [...MEMORY_TOOLS, ...FILESYSTEM_TOOLS, ...WEB_TOOLS, ...SKILL_TOOLS];
  return allTools.map(t => ({ name: t.name, description: t.description }));
}

/** Get all tools available for agent chats, wrapped as AgentTool */
export function getAgentTools(chatId: string, effects: ToolSideEffects, contextWindow = 32768, project?: Project | string, chatType?: string): AgentTool[] {
  const workspacePromise = getWorkspaceForProject(project);
  const baseDir = typeof project === "string" ? project : project?.path || HOME;
  const wrapResult = createWrapResult(contextWindow);
  const tools: AgentTool[] = [];
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
        return wrapResult(await executeMemoryTool(makeToolCall(toolCallId, tool.name, args), chatId), tool.name);
      },
    });
  }

  // Web tools
  for (const tool of WEB_TOOLS) {
    tools.push({
      ...tool,
      label: tool.name,
      execute: async (toolCallId, params) => {
        const args = params as Record<string, any>;
        return wrapResult(await executeWebTool(makeToolCall(toolCallId, tool.name, args)), tool.name);
      },
    });
  }

  // Automation tools
  tools.push({
    ...SCHEDULE_REMINDER_TOOL,
    label: "schedule_reminder",
    execute: async (_id, params) => {
      const { createReminderTask } = await import("./automation-storage.js");
      const args = params as Record<string, any>;
      const task = createReminderTask({
        message: args.message,
        title: args.title,
        scheduledAt: args.scheduledAt,
        activationPolicy: args.activationPolicy,
        maxIterations: args.maxIterations,
        timeoutMs: args.timeoutMs,
      });
      return wrapResult({
        content: `Reminder scheduled.\n\n- **ID**: ${task.id}\n- **Title**: ${task.title}\n- **Scheduled**: ${task.nextRunAt}\n- **Policy**: ${task.activationPolicy}\n- **Chat**: system`,
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
      } else if (isBuiltIn) {
        // Built-in: only promptSteps allowed
        if (args.title !== undefined || args.enabled !== undefined) {
          return wrapResult({
            content: `Cannot modify structural fields (title, enabled) on built-in automation "${existing.title}". Only prompt steps can be edited.`,
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

  // Filesystem tools
  tools.push({
    ...READ_FILE_TOOL,
    label: "read_file",
    execute: async (_id, params) => {
      const settings = await getSettings().catch(() => undefined);
      const workspace = await workspacePromise;
      return wrapResult(await workspace.readFile(params as Record<string, any>, {
        defaultLines: settings?.readFileDefaultLines,
        maxBytes: getReadFileMaxBytes(settings?.readFileMaxBytes, contextWindow),
      }), "read_file");
    },
  });

  tools.push({
    ...WRITE_FILE_TOOL,
    label: "write_file",
    execute: async (_id, params) => {
      const workspace = await workspacePromise;
      return wrapResult(await workspace.writeFile(params as Record<string, any>), "write_file");
    },
  });

  tools.push({
    ...EDIT_FILE_TOOL,
    label: "edit_file",
    execute: async (_id, params) => {
      const workspace = await workspacePromise;
      return wrapResult(await workspace.editFile(params as Record<string, any>), "edit_file");
    },
  });

  tools.push({
    ...LIST_FILES_TOOL,
    label: "list_files",
    execute: async (_id, params) => {
      const workspace = await workspacePromise;
      return wrapResult(await workspace.listFiles(params as Record<string, any>), "list_files");
    },
  });

  tools.push({
    ...BASH_TOOL,
    label: "bash",
    execute: async (_id, params) => {
      const workspace = await workspacePromise;
      return wrapResult(await workspace.bash(params as Record<string, any>), "bash");
    },
  });

  tools.push({
    ...RUN_PYTHON_TOOL,
    label: "run_python",
    execute: async (_id, params) => wrapResult(await executeRunPython(params as Record<string, any>), "run_python"),
  });

  tools.push({
    ...READ_PDF_TOOL,
    label: "read_pdf",
    execute: async (_id, params) => wrapResult(await executeReadPdf(params as Record<string, any>, baseDir), "read_pdf"),
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
        return { content: [{ type: "text", text: `Error updating: ${e.message}. Make sure the ID is from a previously created artifact or visual.` }], details: {}, isError: true };
      }
    },
  });

  // ask_user — notifies the route via callback; the route owns the abort logic
  tools.push({
    ...ASK_USER_TOOL,
    label: "ask_user",
    execute: async (toolCallId, params) => {
      const args = params as Record<string, any>;
      const question = args.question || "What would you like me to do?";
      effects.onAskUser(question, toolCallId);
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
        const projectIdForLookup = typeof project === "string" ? project : undefined;
        return wrapResult(await executeSkillTool(makeToolCall(toolCallId, tool.name, args), projectIdForLookup), tool.name);
      },
    });
  }

  return tools;
}

/** Execute a single tool call using the AgentTool registry */
export async function executeTool(
  toolCall: { id: string; name: string; arguments: Record<string, unknown> },
  chatId: string,
  effects: ToolSideEffects,
): Promise<{ toolCallId: string; toolName: string; content: string; isError: boolean }> {
  const tools = getAgentTools(chatId, effects);
  const tool = tools.find(t => t.name === toolCall.name);
  if (!tool) {
    return { toolCallId: toolCall.id, toolName: toolCall.name, content: `Unknown tool: ${toolCall.name}`, isError: true };
  }
  try {
    const result = await tool.execute(toolCall.id, toolCall.arguments);
    const text = result.content?.map((c: any) => c.text || "").join("") || "";
    return { toolCallId: toolCall.id, toolName: toolCall.name, content: text, isError: false };
  } catch (e) {
    return { toolCallId: toolCall.id, toolName: toolCall.name, content: e instanceof Error ? e.message : String(e), isError: true };
  }
}

// --- Internal executor functions ---

/** Resolve a path relative to the base directory (project path or $HOME) */
function resolvePath(inputPath: string, baseDir: string = HOME): string {
  if (inputPath.startsWith("~")) {
    return resolve(HOME, inputPath.slice(2));
  }
  if (inputPath.startsWith("/")) {
    return inputPath;
  }
  return resolve(baseDir, inputPath);
}

async function executeRunPython(args: Record<string, any>): Promise<{ content: string; isError: boolean }> {
  try {
    const result = await executePython(args.code);
    const parts: string[] = [];
    if (result.stdout) parts.push(result.stdout.trimEnd());
    if (result.stderr) parts.push(`[stderr] ${result.stderr.trimEnd()}`);
    const output = parts.join("\n") || "(no output)";

    return { content: output, isError: result.exitCode !== 0 };
  } catch (e: any) {
    return { content: `Error running Python: ${e.message}`, isError: true };
  }
}

// --- read_pdf implementation ---

import { fileURLToPath } from "url";
const PDF_EXTRACT_SCRIPT = join(fileURLToPath(new URL(".", import.meta.url)), "pdf-extract.py");

/**
 * Fetch a PDF from a URL and return the buffer.
 */
async function fetchPdfFromUrl(url: string, timeoutMs: number = 30000): Promise<Buffer> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

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

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Execute the read_pdf tool using PyMuPDF via Python sandbox.
 * The extraction script lives in pdf-extract.py alongside this module.
 */
async function executeReadPdf(args: Record<string, any>, baseDir: string = HOME): Promise<{ content: string; isError: boolean }> {
  const pathOrUrl = args.path;
  if (!pathOrUrl) {
    return { content: "Missing required parameter: path", isError: true };
  }

  const extractImages = args.extractImages === true;
  const ocr = args.ocr === true;
  const pages = args.pages || "all";

  let pdfBuffer: Buffer | null = null;

  try {
    // Handle URL vs local path
    if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
      pdfBuffer = await fetchPdfFromUrl(pathOrUrl);
    } else {
      const resolvedPath = resolvePath(pathOrUrl, baseDir);
      try {
        pdfBuffer = await readFile(resolvedPath);
      } catch (e: any) {
        return { content: `Cannot read PDF file: ${e.message}`, isError: true };
      }
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
      const result = await executePython(
        pythonCode,
        30,
        undefined,
        {
          args: [pdfFilePath, String(extractImages), String(ocr), pages],
          maxBuffer: 10 * 1024 * 1024,
        },
      );

      if (result.exitCode !== 0) {
        if (result.stderr.includes("No module named fitz")) {
          return {
            content: `PyMuPDF (fitz) is not installed. Install it with: pip install PyMuPDF\n\nFor OCR support, also install Tesseract: sudo apt install tesseract-ocr`,
            isError: true,
          };
        }
        if (result.stderr.includes("timed out")) {
          return { content: "PDF processing timed out after 30s", isError: true };
        }
        return { content: `PDF processing failed: ${result.stderr || result.stdout}`, isError: true };
      }

      try {
        const parsed = JSON.parse(result.stdout);

        if (!ocr && parsed.text.trim().length < 10 && parsed.metadata.pages > 0) {
          return {
            content: `⚠️ This PDF appears to be scanned (no extractable text found). Try again with ocr=true to enable OCR processing.\n\n${formatPdfResult(parsed)}`,
            isError: false,
          };
        }

        return { content: formatPdfResult(parsed), isError: false };
      } catch (e: any) {
        return { content: `Failed to parse PDF result: ${e.message}\n${result.stdout.slice(0, 500)}`, isError: true };
      }
    } finally {
      rmTmp(pdfSandboxDir, { recursive: true, force: true }).catch(() => {});
    }

  } catch (e: any) {
    return { content: `PDF processing failed: ${e.message}`, isError: true };
  }
}

/**
 * Format the PDF extraction result as markdown.
 */
function formatPdfResult(result: { text: string; pages: any[]; images: any[]; metadata: any }): string {
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
    parts.push("## Extracted Images");
    parts.push(`Found ${result.images.length} image(s):`);
    result.images.forEach((img, i) => {
      parts.push(`- Page ${img.page}: ${img.width}x${img.height} ${img.ext.toUpperCase()} (${(img.data.length / 1024).toFixed(1)} KB)`);
    });
    parts.push("");
  }
  
  // Text content
  parts.push("## Text Content");
  parts.push(result.text || "(no text extracted)");
  
  return parts.join("\n");
}
