import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);

const USER_DATA_DIR = path.join(process.env.HOME || "~", ".quje-agent");
const USER_FILE = path.join(USER_DATA_DIR, "user.md");

export interface UserStore {
  content: string;
  lastModified: string | null;
}

const DEFAULT_USER = `# About Me

**Name:** 

**Communication style:** 

**Technical background:** 

**Preferences:** 

---

*Feel free to share as much or as little as you want. This information helps me understand you better.*
`;

/**
 * Ensure user data directory exists.
 */
export async function initializeUserFile(): Promise<void> {
  await mkdir(USER_DATA_DIR, { recursive: true });
}

/**
 * Load the user document from disk. Returns null if file doesn't exist (optional feature).
 */
export async function loadUserDocument(): Promise<UserStore | null> {
  try {
    const content = await readFile(USER_FILE, "utf-8");
    const stat = await fs.promises.stat(USER_FILE);
    return {
      content,
      lastModified: stat.mtime.toISOString(),
    };
  } catch (error) {
    // File doesn't exist - this is fine, it's optional
    return null;
  }
}

/**
 * Save updated user document to disk.
 */
export async function saveUserDocument(
  content: string
): Promise<void> {
  await initializeUserFile();
  await writeFile(USER_FILE, content, "utf-8");
  console.log("[user] User document updated");
}

/**
 * Delete the user document (if user wants to remove their info).
 */
export async function deleteUserDocument(): Promise<void> {
  try {
    await fs.promises.unlink(USER_FILE);
    console.log("[user] User document deleted");
  } catch (error) {
    // File doesn't exist - that's fine
  }
}

/**
 * Get the path to the user file (for direct file system access).
 */
export function getUserFilePath(): string {
  return USER_FILE;
}
