import { Type } from "@sinclair/typebox";
import type { Tool, ToolCall } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { execFile } from "child_process";
import { readFile, writeFile, mkdir, readdir, stat } from "fs/promises";
import { resolve, dirname, join, relative } from "path";
import { homedir } from "os";
import { glob } from "fs/promises";
import { MEMORY_TOOLS, executeMemoryTool } from "./memory-tools.js";
import { WEB_TOOLS, executeWebTool } from "./web-tools.js";
import { IMAGE_TOOLS, executeImageTool } from "./image-tools.js";
import { executePython, createArtifact } from "./sandbox.js";
import { v4 as uuid } from "uuid";
import type { Artifact, GeneratedImage } from "../types.js";

const HOME = homedir();

// --- Filesystem tool definitions ---

const READ_FILE_TOOL: Tool = {
  name: "read_file",
  description: "Read the contents of a file. Returns content with line numbers.",
  parameters: Type.Object({
    path: Type.String({ description: "File path (relative to $HOME or absolute)" }),
    offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-based)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
  }),
};

const WRITE_FILE_TOOL: Tool = {
  name: "write_file",
  description: "Create or overwrite a file with the given content. Creates parent directories if needed.",
  parameters: Type.Object({
    path: Type.String({ description: "File path (relative to $HOME or absolute)" }),
    content: Type.String({ description: "Content to write to the file" }),
  }),
};

const EDIT_FILE_TOOL: Tool = {
  name: "edit_file",
  description: "Edit a file by replacing an exact string match. The old_string must appear exactly once in the file.",
  parameters: Type.Object({
    path: Type.String({ description: "File path (relative to $HOME or absolute)" }),
    old_string: Type.String({ description: "The exact text to find and replace (must be unique in the file)" }),
    new_string: Type.String({ description: "The replacement text" }),
  }),
};

const LIST_FILES_TOOL: Tool = {
  name: "list_files",
  description: "List files in a directory or match a glob pattern.",
  parameters: Type.Object({
    path: Type.Optional(Type.String({ description: "Directory path (defaults to $HOME)" })),
    pattern: Type.Optional(Type.String({ description: "Glob pattern to match (e.g. '**/*.ts')" })),
  }),
};

const BASH_TOOL: Tool = {
  name: "bash",
  description: "Execute a bash command and return stdout and stderr. Use for system commands, installing packages, running scripts, etc.",
  parameters: Type.Object({
    command: Type.String({ description: "The bash command to execute" }),
    timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default 30)" })),
  }),
};

const RUN_PYTHON_TOOL: Tool = {
  name: "run_python",
  description: "Execute Python code and return the output. Runs in a temporary directory with a 30s timeout.",
  parameters: Type.Object({
    code: Type.String({ description: "Python code to execute" }),
  }),
};

const CREATE_ARTIFACT_TOOL: Tool = {
  name: "create_artifact",
  description: "Create an HTML/JS artifact that will be rendered in a sandboxed iframe. Use for interactive demos, visualizations, or web pages.",
  parameters: Type.Object({
    title: Type.String({ description: "Title for the artifact" }),
    html: Type.String({ description: "Complete HTML document (including <html>, <head>, <body> tags)" }),
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
  onGeneratedImage: (image: GeneratedImage) => void;
  pendingAskUser: { question: string; toolCallId: string } | null;
  abortController: AbortController;
}

// --- Adapter helpers ---

/** Wrap a { content, isError } result into AgentToolResult, throwing on error */
function wrapResult(result: { content: string; isError: boolean }): AgentToolResult<{}> {
  if (result.isError) throw new Error(result.content);
  return { content: [{ type: "text", text: result.content }], details: {} };
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
  CREATE_ARTIFACT_TOOL,
  ASK_USER_TOOL,
];

/** Get tool definitions (name + description) for display/metadata only */
export function getAgentToolDefinitions(): { name: string; description: string }[] {
  const allTools = [...MEMORY_TOOLS, ...FILESYSTEM_TOOLS, ...WEB_TOOLS, ...IMAGE_TOOLS];
  return allTools.map(t => ({ name: t.name, description: t.description }));
}

/** Get all tools available for agent chats, wrapped as AgentTool */
export function getAgentTools(chatId: string, effects: ToolSideEffects): AgentTool[] {
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

  // Image tools
  for (const tool of IMAGE_TOOLS) {
    tools.push({
      ...tool,
      label: tool.name,
      execute: async (toolCallId, params) => {
        const args = params as Record<string, any>;
        return wrapResult(await executeImageTool(
          makeToolCall(toolCallId, tool.name, args),
          chatId,
          (event) => { if (event.type === "generated_image") effects.onGeneratedImage(event.data); }
        ));
      },
    });
  }

  // Filesystem tools
  tools.push({
    ...READ_FILE_TOOL,
    label: "read_file",
    execute: async (_id, params) => wrapResult(await executeReadFile(params as Record<string, any>)),
  });

  tools.push({
    ...WRITE_FILE_TOOL,
    label: "write_file",
    execute: async (_id, params) => wrapResult(await executeWriteFile(params as Record<string, any>)),
  });

  tools.push({
    ...EDIT_FILE_TOOL,
    label: "edit_file",
    execute: async (_id, params) => wrapResult(await executeEditFile(params as Record<string, any>)),
  });

  tools.push({
    ...LIST_FILES_TOOL,
    label: "list_files",
    execute: async (_id, params) => wrapResult(await executeListFiles(params as Record<string, any>)),
  });

  tools.push({
    ...BASH_TOOL,
    label: "bash",
    execute: async (_id, params) => wrapResult(await executeBash(params as Record<string, any>)),
  });

  tools.push({
    ...RUN_PYTHON_TOOL,
    label: "run_python",
    execute: async (_id, params) => wrapResult(await executeRunPython(params as Record<string, any>)),
  });

  // create_artifact — uses effects.onArtifact callback
  tools.push({
    ...CREATE_ARTIFACT_TOOL,
    label: "create_artifact",
    execute: async (_id, params) => {
      const args = params as Record<string, any>;
      const id = uuid();
      const url = await createArtifact(id, args.html);
      effects.onArtifact({ id, title: args.title, url });
      return { content: [{ type: "text", text: `Artifact created: ${args.title} (${url})` }], details: {} };
    },
  });

  // ask_user — aborts the agent loop so the server can pause and wait for user input
  tools.push({
    ...ASK_USER_TOOL,
    label: "ask_user",
    execute: async (toolCallId, params) => {
      const args = params as Record<string, any>;
      const question = args.question || "What would you like me to do?";
      effects.pendingAskUser = { question, toolCallId };
      effects.abortController.abort();
      return { content: [{ type: "text", text: "Waiting for user response..." }], details: {} };
    },
  });

  return tools;
}

// --- Internal executor functions (unchanged) ---

/** Resolve a path relative to $HOME */
function resolvePath(inputPath: string): string {
  if (inputPath.startsWith("~")) {
    return resolve(HOME, inputPath.slice(2));
  }
  if (inputPath.startsWith("/")) {
    return inputPath;
  }
  return resolve(HOME, inputPath);
}

async function executeReadFile(args: Record<string, any>): Promise<{ content: string; isError: boolean }> {
  try {
    const filePath = resolvePath(args.path);
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n");

    const offset = Math.max(1, args.offset || 1);
    const limit = args.limit || lines.length;
    const selected = lines.slice(offset - 1, offset - 1 + limit);

    const numbered = selected
      .map((line, i) => `${String(offset + i).padStart(6)} | ${line}`)
      .join("\n");

    return { content: numbered, isError: false };
  } catch (e: any) {
    return { content: `Error reading file: ${e.message}`, isError: true };
  }
}

async function executeWriteFile(args: Record<string, any>): Promise<{ content: string; isError: boolean }> {
  try {
    const filePath = resolvePath(args.path);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, args.content, "utf-8");
    return { content: `File written: ${filePath}`, isError: false };
  } catch (e: any) {
    return { content: `Error writing file: ${e.message}`, isError: true };
  }
}

async function executeEditFile(args: Record<string, any>): Promise<{ content: string; isError: boolean }> {
  try {
    const filePath = resolvePath(args.path);
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

async function executeListFiles(args: Record<string, any>): Promise<{ content: string; isError: boolean }> {
  try {
    const basePath = resolvePath(args.path || "~");

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

async function executeBash(args: Record<string, any>): Promise<{ content: string; isError: boolean }> {
  const timeout = (args.timeout || 30) * 1000;

  return new Promise((resolve) => {
    const proc = execFile(
      "/bin/bash",
      ["-c", args.command],
      {
        timeout,
        maxBuffer: 1024 * 1024, // 1MB
        cwd: HOME,
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
