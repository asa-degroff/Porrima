import { readFile, access } from "fs/promises";
import { join } from "path";

/**
 * Read AGENTS.md from a project directory.
 * This is a filesystem utility - project CRUD is now in chat-storage.ts (SQLite).
 */
export async function readAgentsMd(projectPath: string): Promise<string | null> {
  const agentsMdPath = join(projectPath, "AGENTS.md");
  const agentsMdPathLower = join(projectPath, "agents.md");
  
  try {
    await access(agentsMdPath);
    return await readFile(agentsMdPath, "utf-8");
  } catch {
    // Try lowercase variant
    try {
      await access(agentsMdPathLower);
      return await readFile(agentsMdPathLower, "utf-8");
    } catch {
      return null;
    }
  }
}
