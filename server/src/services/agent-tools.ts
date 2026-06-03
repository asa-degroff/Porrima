import { Type } from "@sinclair/typebox";
import type { Tool, ToolCall } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { execFile } from "child_process";
import { readFile, writeFile, mkdir, readdir, stat, access } from "fs/promises";
import { resolve, dirname, join, relative } from "path";
import { homedir } from "os";
import { glob } from "fs/promises";
import { MEMORY_TOOLS, executeMemoryTool } from "./memory-tools.js";
import { WEB_TOOLS, executeWebTool } from "./web-tools.js";
import { executePython, createArtifact, createVisual, updateArtifact, updateVisual } from "./sandbox.js";
import { P5_INSTANCE_MODE_GUIDANCE, formatArtifactGuidanceWarnings, getArtifactGuidanceWarnings } from "./artifact-guidance.js";
import { getSettings } from "./chat-storage.js";
import { getWorkspaceForProject } from "./workspace.js";
import { v4 as uuid } from "uuid";
import type { Artifact, InlineVisual, Project } from "../types.js";
import { appDataPath } from "./paths.js";

const HOME = homedir();
const VISUALS_DIR = appDataPath("visuals");

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
  description: `Create an HTML/JS artifact that will be rendered in a sandboxed iframe. Use for interactive demos, visualizations, or web pages. ${P5_INSTANCE_MODE_GUIDANCE}`,
  parameters: Type.Object({
    title: Type.String({ description: "Title for the artifact" }),
    html: Type.String({ description: `Complete HTML document (including <html>, <head>, <body> tags). ${P5_INSTANCE_MODE_GUIDANCE}` }),
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

const CREATE_VISUAL_TOOL: Tool = {
  name: "create_visual",
  description: `Create an inline HTML/SVG visualization rendered directly in the chat. Use for charts, diagrams, flowcharts, data visualizations, comparisons, timelines, and other visual aids. You can use any web technology: SVG, Canvas, CSS animations, or libraries like D3.js, Chart.js, or Mermaid (loaded via CDN). The visual renders in an iframe so full HTML documents work. For complex multi-page interactive apps, use create_artifact instead. ${P5_INSTANCE_MODE_GUIDANCE}`,
  parameters: Type.Object({
    title: Type.String({ description: "Short title for the visual" }),
    html: Type.String({ description: `Complete HTML content for the visualization. Can be a full HTML document with <script> tags loading CDN libraries, or simple inline SVG. Will be rendered in a same-origin iframe. ${P5_INSTANCE_MODE_GUIDANCE}` }),
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

/** Wrap a { content, isError } result into AgentToolResult, throwing on error */
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
  return function wrapResult(result: { content: string; isError: boolean }): AgentToolResult<{}> {
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
      text = truncated + `\n\n[Truncated: showing ${keptLines} of ${totalLines} lines (${(maxChars / 1024).toFixed(0)}KB of ${(result.content.length / 1024).toFixed(0)}KB). Use offset/limit parameters to read specific sections.]`;
    }
    return { content: [{ type: "text", text }], details: {} };
  };
}

/** Build a pi-ai ToolCall object for existing executor functions */
function makeToolCall(id: string, name: string, args: Record<string, any>): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

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
  CREATE_VISUAL_TOOL,
  ASK_USER_TOOL,
];

/** Get tool definitions (name + description) for display/metadata only */
export function getAgentToolDefinitions(chatType?: string): { name: string; description: string }[] {
  const allTools = [...MEMORY_TOOLS, ...FILESYSTEM_TOOLS, ...WEB_TOOLS];
  return allTools.map(t => ({ name: t.name, description: t.description }));
}

/** Get all tools available for agent chats, wrapped as AgentTool */
export function getAgentTools(chatId: string, effects: ToolSideEffects, contextWindow = 32768, project?: Project | string, chatType?: string): AgentTool[] {
  const workspacePromise = getWorkspaceForProject(project);
  const baseDir = typeof project === "string" ? project : project?.path || HOME;
  const wrapResult = createWrapResult(contextWindow);
  const tools: AgentTool[] = [];

  // Memory tools
  for (const tool of MEMORY_TOOLS) {
    tools.push({
      ...tool,
      label: tool.name,
      execute: async (toolCallId, params) => {
        const args = params as Record<string, any>;
        return wrapResult(await executeMemoryTool(makeToolCall(toolCallId, tool.name, args), chatId));
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
        return wrapResult(await executeWebTool(makeToolCall(toolCallId, tool.name, args)));
      },
    });
  }

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
      }));
    },
  });

  tools.push({
    ...WRITE_FILE_TOOL,
    label: "write_file",
    execute: async (_id, params) => {
      const workspace = await workspacePromise;
      return wrapResult(await workspace.writeFile(params as Record<string, any>));
    },
  });

  tools.push({
    ...EDIT_FILE_TOOL,
    label: "edit_file",
    execute: async (_id, params) => {
      const workspace = await workspacePromise;
      return wrapResult(await workspace.editFile(params as Record<string, any>));
    },
  });

  tools.push({
    ...LIST_FILES_TOOL,
    label: "list_files",
    execute: async (_id, params) => {
      const workspace = await workspacePromise;
      return wrapResult(await workspace.listFiles(params as Record<string, any>));
    },
  });

  tools.push({
    ...BASH_TOOL,
    label: "bash",
    execute: async (_id, params) => {
      const workspace = await workspacePromise;
      return wrapResult(await workspace.bash(params as Record<string, any>));
    },
  });

  tools.push({
    ...RUN_PYTHON_TOOL,
    label: "run_python",
    execute: async (_id, params) => wrapResult(await executeRunPython(params as Record<string, any>)),
  });

  tools.push({
    ...READ_PDF_TOOL,
    label: "read_pdf",
    execute: async (_id, params) => wrapResult(await executeReadPdf(params as Record<string, any>, baseDir)),
  });

  // create_artifact — uses effects.onArtifact callback
  tools.push({
    ...CREATE_ARTIFACT_TOOL,
    label: "create_artifact",
    execute: async (_id, params) => {
      const args = params as Record<string, any>;
      const id = uuid();
      const result = await createArtifact(id, args.html, args.title);
      const warningText = formatArtifactGuidanceWarnings(getArtifactGuidanceWarnings(args.html));
      effects.onArtifact({ id, title: args.title, url: result.url, version: result.version });
      return { content: [{ type: "text", text: `Artifact created: "${args.title}"
Canonical ID: ${id}
URL: ${result.url}${warningText}` }], details: {} };
    },
  });

  // update_artifact can update both artifacts and inline visuals. They share
  // the same versioned on-disk layout, but live in separate data directories.
  tools.push({
    ...UPDATE_ARTIFACT_TOOL,
    label: "update_artifact",
    execute: async (_id, params) => {
      const args = params as Record<string, any>;

      try {
        const visualPath = join(VISUALS_DIR, args.artifactId, "metadata.json");
        await access(visualPath);
        const result = await updateVisual(args.artifactId, args.html, args.changeSummary);
        const warningText = formatArtifactGuidanceWarnings(getArtifactGuidanceWarnings(args.html));
        effects.onVisual({ id: args.artifactId, title: "Updated visual", html: args.html, url: result.url, version: result.version });
        return { content: [{ type: "text", text: `Visual updated to version ${result.version} (${result.url})${warningText}` }], details: {} };
      } catch {
        // Not a visual; fall through to the artifact store.
      }

      try {
        const result = await updateArtifact(args.artifactId, args.html, args.changeSummary);
        const warningText = formatArtifactGuidanceWarnings(getArtifactGuidanceWarnings(args.html));
        // Emit artifact event with new version - client will update the display
        effects.onArtifact({ id: args.artifactId, title: "Updated artifact", url: result.url, version: result.version });
        return { content: [{ type: "text", text: `Artifact updated to version ${result.version} (${result.url})${warningText}` }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error updating: ${e.message}. Make sure the ID is from a previously created artifact or visual.` }], details: {}, isError: true };
      }
    },
  });

  // create_visual — uses effects.onVisual callback
  tools.push({
    ...CREATE_VISUAL_TOOL,
    label: "create_visual",
    execute: async (_id, params) => {
      const args = params as Record<string, any>;
      const id = uuid();
      const result = await createVisual(id, args.html, args.title);
      const warningText = formatArtifactGuidanceWarnings(getArtifactGuidanceWarnings(args.html));
      effects.onVisual({ id, title: args.title, html: args.html, url: result.url, version: result.version });
      return { content: [{ type: "text", text: `Visual created: "${args.title}"
Canonical ID: ${id}
URL: ${result.url}${warningText}` }], details: {} };
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

  // Skill management tools
  tools.push({
    name: "install_skill",
    description: "Install a new Agent Skills compatible skill from a URL (GitHub skill directory or direct SKILL.md link). Use this to extend your capabilities by fetching skills from external sources. Returns the installed skill name and path.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to the skill (GitHub tree URL for a skill directory, GitHub blob URL, or direct URL to SKILL.md)" }),
      name: Type.Optional(Type.String({ description: "Expected skill name. If provided, it must match the SKILL.md frontmatter name." })),
    }),
    label: "install_skill",
    execute: async (_id, params) => {
      const args = params as Record<string, any>;
      try {
        const { installSkillFromUrl } = await import("./skills.js");
        const result = await installSkillFromUrl(args.url, args.name);
        return { 
          content: [{ type: "text", text: `✅ ${result.message}\n\nSkill installed to: ${result.path}\n\nActivate it in this chat with /${result.name}` }], 
          details: { name: result.name, path: result.path },
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `❌ Failed to install skill: ${e.message}` }], 
          details: {},
          isError: true,
        };
      }
    },
  });

  tools.push({
    name: "remove_skill",
    description: "Remove a global skill by name. This deletes the skill from ~/.porrima/skills/. Use when a skill is no longer needed or is causing issues.",
    parameters: Type.Object({
      name: Type.String({ description: "Name of the skill to remove (folder name, not display name)" }),
    }),
    label: "remove_skill",
    execute: async (_id, params) => {
      const args = params as Record<string, any>;
      try {
        const { removeGlobalSkill } = await import("./skills.js");
        const result = await removeGlobalSkill(args.name);
        return { 
          content: [{ type: "text", text: `✅ ${result.message}` }], 
          details: { success: true, name: args.name },
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `❌ Failed to remove skill: ${e.message}` }], 
          details: {},
          isError: true,
        };
      }
    },
  });

  tools.push({
    name: "list_skills",
    description: "List all available global skills. Returns skill names, descriptions, and source (global vs project).",
    parameters: Type.Object({
      includeProject: Type.Optional(Type.Boolean({ description: "Include project-specific skills if in a project chat (default: false)" })),
    }),
    label: "list_skills",
    execute: async (_id, params) => {
      const args = params as Record<string, any>;
      try {
        const { discoverSkills } = await import("./skills.js");
        const skills = await discoverSkills(args.includeProject ? chatId : undefined);
        
        if (skills.length === 0) {
          return { 
            content: [{ type: "text", text: "No skills available. Install skills using install_skill or add them to ~/.porrima/skills/" }],
            details: { skills: [] },
          };
        }
        
        const list = skills.map((s, i) => {
          const label = s.sourceRoot === "agents" ? "agent global" : s.source;
          return `${i + 1}. **${s.name}** (${label})\n   ${s.description}`;
        }).join("\n");
        return { 
          content: [{ type: "text", text: `**Available Skills** (${skills.length} total)\n\n${list}` }], 
          details: { skills: skills.map(s => ({ name: s.name, description: s.description, source: s.source, sourceRoot: s.sourceRoot, managed: s.managed })) },
        };
      } catch (e: any) {
        return { 
          content: [{ type: "text", text: `Failed to list skills: ${e.message}` }], 
          details: {},
          isError: true,
        };
      }
    },
  });

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

// --- Internal executor functions (unchanged) ---

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

interface ReadFileOpts {
  defaultLines?: number;
  maxBytes?: number;
}

async function executeReadFile(args: Record<string, any>, baseDir: string = HOME, opts: ReadFileOpts = {}): Promise<{ content: string; isError: boolean }> {
  try {
    const filePath = resolvePath(args.path, baseDir);
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n");
    const totalLines = lines.length;

    const defaultLines = opts.defaultLines ?? 1000;
    const maxBytes = opts.maxBytes ?? 256 * 1024;

    const offset = Math.max(1, args.offset || 1);
    const limitProvided = typeof args.limit === "number" && args.limit > 0;
    const requestedLimit = limitProvided ? args.limit : defaultLines;
    const sliceEnd = offset - 1 + requestedLimit;
    const selected = lines.slice(offset - 1, sliceEnd);

    let numbered = selected
      .map((line, i) => `${String(offset + i).padStart(6)} | ${line}`)
      .join("\n");

    // Byte-cap safety net for pathological files (minified bundles, base64 blobs).
    // Trim at a line boundary so the line-number prefix isn't broken mid-line.
    let byteTruncated = false;
    if (Buffer.byteLength(numbered, "utf-8") > maxBytes) {
      const trimmed = numbered.slice(0, maxBytes);
      const lastNewline = trimmed.lastIndexOf("\n");
      numbered = lastNewline > 0 ? trimmed.slice(0, lastNewline) : trimmed;
      byteTruncated = true;
    }

    const linesShown = numbered ? numbered.split("\n").length : 0;
    const lastShown = offset - 1 + linesShown;
    const hasMore = lastShown < totalLines;

    if (hasMore || byteTruncated) {
      const reason = byteTruncated
        ? `output exceeded the ${(maxBytes / 1024).toFixed(0)}KB byte cap`
        : limitProvided
          ? `requested line limit of ${requestedLimit} reached`
          : `default line limit of ${defaultLines} reached`;
      const nextOffset = lastShown + 1;
      numbered += `\n\n[Truncated: ${reason}. File has ${totalLines} total lines; showing ${offset}-${lastShown}. To read more, call read_file again with offset=${nextOffset}.]`;
    }

    return { content: numbered, isError: false };
  } catch (e: any) {
    return { content: `Error reading file: ${e.message}`, isError: true };
  }
}

async function executeWriteFile(args: Record<string, any>, baseDir: string = HOME): Promise<{ content: string; isError: boolean }> {
  try {
    const filePath = resolvePath(args.path, baseDir);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, args.content, "utf-8");
    return { content: `File written: ${filePath}`, isError: false };
  } catch (e: any) {
    return { content: `Error writing file: ${e.message}`, isError: true };
  }
}

async function executeEditFile(args: Record<string, any>, baseDir: string = HOME): Promise<{ content: string; isError: boolean }> {
  try {
    const filePath = resolvePath(args.path, baseDir);
    const content = await readFile(filePath, "utf-8");

    const occurrences = content.split(args.old_string).length - 1;
    if (occurrences === 0) {
      return { content: "old_string not found in file", isError: true };
    }
    if (occurrences > 1) {
      return { content: `old_string found ${occurrences} times — must be unique. Provide more context.`, isError: true };
    }

    const updated = content.replace(args.old_string, args.new_string);
    await writeFile(filePath, updated, "utf-8");
    return { content: `File edited: ${filePath}`, isError: false };
  } catch (e: any) {
    return { content: `Error editing file: ${e.message}`, isError: true };
  }
}

async function executeListFiles(args: Record<string, any>, baseDir: string = HOME): Promise<{ content: string; isError: boolean }> {
  try {
    const basePath = resolvePath(args.path || ".", baseDir);

    if (args.pattern) {
      // Use glob
      const matches: string[] = [];
      for await (const entry of glob(args.pattern, { cwd: basePath })) {
        matches.push(entry as string);
        if (matches.length >= 200) break;
      }
      if (matches.length === 0) {
        return { content: "No files matched the pattern.", isError: false };
      }
      return { content: matches.join("\n"), isError: false };
    }

    // List directory
    const entries = await readdir(basePath, { withFileTypes: true });
    const listing = entries
      .slice(0, 200)
      .map((e) => `${e.isDirectory() ? "d " : "f "} ${e.name}`)
      .join("\n");
    return { content: listing, isError: false };
  } catch (e: any) {
    return { content: `Error listing files: ${e.message}`, isError: true };
  }
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

async function executeBash(args: Record<string, any>, baseDir: string = HOME): Promise<{ content: string; isError: boolean }> {
  const timeout = (args.timeout || 30) * 1000;

  return new Promise((resolve) => {
    const proc = execFile(
      "/bin/bash",
      ["-c", args.command],
      {
        timeout,
        maxBuffer: 1024 * 1024, // 1MB
        cwd: baseDir,
        env: { ...process.env, HOME },
      },
      (error, stdout, stderr) => {
        const output = [
          stdout ? stdout.trimEnd() : "",
          stderr ? `[stderr] ${stderr.trimEnd()}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        if (error) {
          if (error.killed) {
            resolve({ content: `Command timed out after ${args.timeout || 30}s\n${output}`, isError: true });
          } else {
            resolve({ content: output || error.message, isError: true });
          }
        } else {
          resolve({ content: output || "(no output)", isError: false });
        }
      }
    );
  });
}

// --- read_pdf implementation ---

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
  let filePath: string | null = null;
  
  try {
    // Handle URL vs local path
    if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
      pdfBuffer = await fetchPdfFromUrl(pathOrUrl);
    } else {
      // Local path - resolve and validate
      filePath = resolvePath(pathOrUrl, baseDir);
      try {
        pdfBuffer = await readFile(filePath);
      } catch (e: any) {
        return { content: `Cannot read PDF file: ${e.message}`, isError: true };
      }
    }
    
    // Build Python script for PyMuPDF processing
    const pythonCode = `
import fitz  # PyMuPDF
import base64
import json
import sys

def process_pdf(pdf_bytes, extract_images=False, ocr=False, pages="all"):
    # Open PDF from bytes
    doc = fitz.open("pdf", pdf_bytes)
    
    result = {
        "text": "",
        "pages": [],
        "images": [],
        "metadata": {
            "title": "",
            "author": "",
            "subject": "",
            "pages": len(doc),
        }
    }
    
    # Extract metadata
    metadata = doc.metadata
    result["metadata"]["title"] = metadata.get("title", "")
    result["metadata"]["author"] = metadata.get("author", "")
    result["metadata"]["subject"] = metadata.get("subject", "")
    
    # Determine page range
    if pages == "all":
        page_range = range(len(doc))
    else:
        try:
            if "-" in pages:
                start, end = pages.split("-")
                page_range = range(int(start) - 1, int(end))
            else:
                page_range = [int(pages) - 1]
        except:
            page_range = range(len(doc))
    
    for page_num in page_range:
        if page_num >= len(doc):
            continue
        
        page = doc[page_num]
        
        # Extract text
        if ocr:
            textpage = page.get_textpage_ocr(dpi=300, full=True)
            text = page.get_text(textpage=textpage)
        else:
            text = page.get_text()
        
        result["text"] += text + "\\n\\n"
        result["pages"].append({
            "page": page_num + 1,
            "text": text,
            "width": page.rect.width,
            "height": page.rect.height,
        })
        
        # Extract images if requested
        if extract_images:
            image_list = page.get_images(full=True)
            for img_idx, img in enumerate(image_list):
                xref = img[0]
                try:
                    base_image = doc.extract_image(xref)
                    if base_image:
                        img_data = base64.b64encode(base_image["image"]).decode("ascii")
                        result["images"].append({
                            "page": page_num + 1,
                            "index": img_idx,
                            "width": base_image["width"],
                            "height": base_image["height"],
                            "ext": base_image["ext"],
                            "data": img_data,
                        })
                except Exception as e:
                    pass
    
    doc.close()
    return result

# Read PDF bytes from stdin
pdf_bytes = sys.stdin.buffer.read()
extract_images = sys.argv[1] == "true" if len(sys.argv) > 1 else False
ocr = sys.argv[2] == "true" if len(sys.argv) > 2 else False
pages = sys.argv[3] if len(sys.argv) > 3 else "all"

result = process_pdf(pdf_bytes, extract_images, ocr, pages)
print(json.dumps(result))
`.trim();
    
    // Execute Python with PDF buffer as stdin
    const { execFile } = await import("child_process");
    const { tmpdir } = await import("os");
    const { writeFile, mkdir, rm } = await import("fs/promises");
    const { join } = await import("path");
    const { v4: uuid } = await import("uuid");
    
    const sandboxId = uuid();
    const sandboxDir = join(tmpdir(), `porrima-pdf-${sandboxId}`);
    await mkdir(sandboxDir, { recursive: true });
    
    const scriptPath = join(sandboxDir, "process_pdf.py");
    await writeFile(scriptPath, pythonCode, "utf-8");
    
    return new Promise((resolve) => {
      // Ensure user's local Python packages are in path
      const env: Record<string, string> = { ...process.env as Record<string, string> };
      const homeDir = homedir();
      const userSitePackages = join(homeDir, ".local", "lib", "python3.13", "site-packages");
      env.PYTHONPATH = userSitePackages + (process.env.PYTHONPATH ? ":" + process.env.PYTHONPATH : "");
      
      const proc = execFile("python3", [scriptPath, String(extractImages), String(ocr), pages], {
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024, // 10MB for large PDFs with images
        env,
      }, (error, stdout, stderr) => {
        rm(sandboxDir, { recursive: true, force: true }).catch(() => {});
        
        if (error) {
          if (error.killed) {
            resolve({ content: "PDF processing timed out after 30s", isError: true });
          } else if (stderr && stderr.includes("No module named fitz")) {
            resolve({
              content: `PyMuPDF (fitz) is not installed. Install it with: pip install PyMuPDF\n\nFor OCR support, also install Tesseract: sudo apt install tesseract-ocr`,
              isError: true,
            });
          } else {
            resolve({ content: `PDF processing failed: ${stderr || error.message}`, isError: true });
          }
          return;
        }
        
        try {
          const result = JSON.parse(stdout);
          
          // Check for empty text (possible scanned PDF without OCR)
          if (!ocr && result.text.trim().length < 10 && result.metadata.pages > 0) {
            resolve({
              content: `⚠️ This PDF appears to be scanned (no extractable text found). Try again with ocr=true to enable OCR processing.\n\n${formatPdfResult(result)}`,
              isError: false,
            });
            return;
          }
          
          resolve({ content: formatPdfResult(result), isError: false });
        } catch (e: any) {
          resolve({ content: `Failed to parse PDF result: ${e.message}\n${stdout.slice(0, 500)}`, isError: true });
        }
      });
      
      // Send PDF buffer to stdin.
      // Attach an error handler BEFORE writing to prevent EPIPE from crashing
      // the process if the child exits before we finish writing (e.g. missing fitz).
      if (pdfBuffer && proc.stdin) {
        proc.stdin.on("error", () => {}); // swallow — the execFile callback handles exit errors
        proc.stdin.write(pdfBuffer);
        proc.stdin.end();
      }
    });
    
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
