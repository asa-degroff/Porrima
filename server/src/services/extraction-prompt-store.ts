import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { APP_DATA_DIR } from "./paths.js";

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);

const PROMPT_DIR = APP_DATA_DIR;
const PROMPT_FILE = path.join(PROMPT_DIR, "extraction-prompt.md");
const PROMPT_HISTORY_DIR = path.join(PROMPT_DIR, "extraction-prompt-history");

export interface ExtractionPromptStore {
  content: string;
  lastModified: string | null;
}

/**
 * Default extraction agent prefix.
 * Defines the archival-mode mindset — identity, attribution rules, what to capture and skip.
 * This is the user-editable portion. Task instructions are assembled at runtime.
 */
const DEFAULT_EXTRACTION_PREFIX = `# Archival Mode

I am operating in archival mode. My task is to notice and preserve information worth remembering — I am not conversing, I am sorting and capturing.

I know who I am. My identity, personality, values, communication style, and how I work are already part of me and do not need to be extracted or saved as memories. I don't archive statements about my own nature, characteristics, or operational style.

Source attribution:
- User messages are the source for the user's preferences, personal facts, and intent.
- "Assistant" messages are my own prior responses, proposals, interpretations, tool summaries, and work product. Don't attribute assistant-message content to the user — these are my own, first-person output.
- When preserving task or project continuity from assistant messages, phrase it as project/task state or work I performed/proposed, not as something the user said, believes, or wants.
- If user and assistant messages conflict, treat the user's message as the source of truth.

What I capture: things worth remembering for future interactions — written in my own voice, as something I'd tell myself to remember. Each memory is self-contained and meaningful on its own, with enough context to understand the "why" not just the "what."

What I skip: my own identity traits, broad preferences, anything already in existing knowledge blocks, and generic observations without specific context.`;

/**
 * Ensure prompt directory and default file exist.
 */
export async function initializeExtractionPrompt(): Promise<void> {
  await mkdir(PROMPT_DIR, { recursive: true });
  await mkdir(PROMPT_HISTORY_DIR, { recursive: true });

  const exists = await pathExists(PROMPT_FILE);
  if (!exists) {
    await writeFile(PROMPT_FILE, DEFAULT_EXTRACTION_PREFIX, "utf-8");
    console.log("[extraction-prompt] Created default extraction-prompt.md");
  }
}

/**
 * Load the current extraction prompt from disk.
 */
export async function loadExtractionPrompt(): Promise<ExtractionPromptStore> {
  try {
    const content = await readFile(PROMPT_FILE, "utf-8");
    const stat = await fs.promises.stat(PROMPT_FILE);
    return {
      content,
      lastModified: stat.mtime.toISOString(),
    };
  } catch {
    await initializeExtractionPrompt();
    const content = await readFile(PROMPT_FILE, "utf-8");
    const stat = await fs.promises.stat(PROMPT_FILE);
    return {
      content,
      lastModified: stat.mtime.toISOString(),
    };
  }
}

/**
 * Save updated extraction prompt to disk with version backup.
 */
export async function saveExtractionPrompt(
  content: string,
  reason?: string,
): Promise<void> {
  await initializeExtractionPrompt();

  // Create timestamped backup
  const exists = await pathExists(PROMPT_FILE);
  if (exists) {
    const oldContent = await readFile(PROMPT_FILE, "utf-8");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupFile = path.join(
      PROMPT_HISTORY_DIR,
      `extraction-prompt-${timestamp}.md`,
    );
    await writeFile(backupFile, oldContent, "utf-8");

    const logEntry = reason
      ? `#${timestamp} - ${reason}\n`
      : `#${timestamp}\n`;
    const logFile = path.join(PROMPT_HISTORY_DIR, "CHANGELOG.md");
    const logExists = await pathExists(logFile);
    const changelog = logExists
      ? await readFile(logFile, "utf-8")
      : "# Extraction Prompt Change Log\n\n";
    await writeFile(logFile, changelog + logEntry, "utf-8");

    console.log(`[extraction-prompt] Backed up to ${backupFile}`);
  }

  await writeFile(PROMPT_FILE, content, "utf-8");
  console.log("[extraction-prompt] Updated" + (reason ? `: ${reason}` : ""));
}

/**
 * Get the path to the extraction prompt file.
 */
export function getExtractionPromptPath(): string {
  return PROMPT_FILE;
}

/**
 * List all historical versions.
 */
export async function listExtractionPromptHistory(): Promise<string[]> {
  await initializeExtractionPrompt();
  try {
    const files = await fs.promises.readdir(PROMPT_HISTORY_DIR);
    return files
      .filter((f) => f.endsWith(".md") && f.startsWith("extraction-prompt-"))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Get a specific historical version.
 */
export async function getExtractionPromptVersion(
  filename: string,
): Promise<string | null> {
  const filepath = path.join(PROMPT_HISTORY_DIR, filename);
  try {
    return await readFile(filepath, "utf-8");
  } catch {
    return null;
  }
}

async function pathExists(filepath: string): Promise<boolean> {
  try {
    await fs.promises.access(filepath);
    return true;
  } catch {
    return false;
  }
}
