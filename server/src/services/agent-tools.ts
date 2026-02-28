import { Type } from "@sinclair/typebox";
import type { Tool, ToolCall } from "@mariozechner/pi-ai";
import { execFile } from "child_process";
import { readFile, writeFile, mkdir, readdir, stat } from "fs/promises";
import { resolve, dirname, join, relative } from "path";
import { homedir } from "os";
import { glob } from "fs/promises";
import { MEMORY_TOOLS, executeMemoryTool } from "./memory-tools.js";
import { WEB_TOOLS, executeWebTool } from "./web-tools.js";
import { executePython, createArtifact } from "./sandbox.js";
import { v4 as uuid } from "uuid";

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

/** Get all tools available for agent chats */
export function getAgentTools(): Tool[] {
  return [...MEMORY_TOOLS, ...FILESYSTEM_TOOLS, ...WEB_TOOLS];
}

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

export interface ToolExecutionEvent {
  type: "artifact";
  data: { id: string; title: string; url: string };
}

/** Execute a tool call and return the result */
export async function executeTool(
  toolCall: ToolCall,
  chatId: string,
  onEvent?: (event: ToolExecutionEvent) => void
): Promise<{ content: string; isError: boolean }> {
  // Memory tools
  if (["save_memory", "search_memory", "forget_memory"].includes(toolCall.name)) {
    return executeMemoryTool(toolCall, chatId);
  }

  // Web tools
  if (["web_search", "web_fetch"].includes(toolCall.name)) {
    return executeWebTool(toolCall);
  }

  // Filesystem & sandbox tools
  switch (toolCall.name) {
    case "read_file":
      return executeReadFile(toolCall.arguments);
    case "write_file":
      return executeWriteFile(toolCall.arguments);
    case "edit_file":
      return executeEditFile(toolCall.arguments);
    case "list_files":
      return executeListFiles(toolCall.arguments);
    case "bash":
      return executeBash(toolCall.arguments);
    case "run_python":
      return executeRunPython(toolCall.arguments);
    case "create_artifact":
      return executeCreateArtifact(toolCall.arguments, onEvent);
    case "ask_user":
      // Sentinel — the route handler intercepts this before execution
      return { content: "__ASK_USER__", isError: false };
    default:
      return { content: `Unknown tool: ${toolCall.name}`, isError: true };
  }
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

async function executeCreateArtifact(
  args: Record<string, any>,
  onEvent?: (event: ToolExecutionEvent) => void
): Promise<{ content: string; isError: boolean }> {
  try {
    const id = uuid();
    const url = await createArtifact(id, args.html);

    // Notify client about the new artifact
    onEvent?.({
      type: "artifact",
      data: { id, title: args.title, url },
    });

    return { content: `Artifact created: ${args.title} (${url})`, isError: false };
  } catch (e: any) {
    return { content: `Error creating artifact: ${e.message}`, isError: true };
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
