import { readFile, access, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { existsSync } from "fs";
import { createProject, getProject } from "./chat-storage.js";

const DIRECTIONS_PROJECT_NAME = "Creative Engine";
const DIRECTIONS_PROJECT_ID = "creative-engine-directions";

const AGENTS_MD_CONTENT = `# Creative Engine Directions

This project stores the autonomous creative direction history for the quje-agent image corpus system.

## Purpose

Each creative cycle (run during daily synthesis) generates a set of creative directions — prompts for novel image generation based on clustering analysis of the existing image corpus. These directions are stored as memory blocks for long-term archival and synthesis.

## Structure

- **Memory blocks**: One block per creative cycle, containing all directions from that cycle
- **Cache**: \`cache.json\` holds the last 24h of directions for immediate workflow use
- **Project scope**: All blocks are project-scoped to this directory

## Creative Direction Types

- \`remix\` — Combine elements from distant clusters
- \`explore\` — Extend a single cluster's theme
- \`deepen\` — Add complexity within an existing direction
- \`contrast\` — Generate opposing aesthetic to existing work
- \`gap-fill\` — Address underrepresented themes in the corpus
`;

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

/**
 * Ensure the Creative Engine directions project exists.
 * Creates it automatically on first run if missing.
 */
export async function ensureDirectionsProject(): Promise<string> {
  const existing = await getProject(DIRECTIONS_PROJECT_ID);
  if (existing) {
    return existing.id;
  }

  const directionsPath = join(homedir(), ".quje-agent", "directions");
  
  // Ensure directory exists
  if (!existsSync(directionsPath)) {
    await mkdir(directionsPath, { recursive: true });
  }

  // Create AGENTS.md if missing
  const agentsMdPath = join(directionsPath, "AGENTS.md");
  if (!existsSync(agentsMdPath)) {
    await writeFile(agentsMdPath, AGENTS_MD_CONTENT, "utf-8");
  }

  // Create project in database
  const project = {
    id: DIRECTIONS_PROJECT_ID,
    name: DIRECTIONS_PROJECT_NAME,
    path: directionsPath,
    color: "violet" as const,
    pinned: false,
    createdAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
  };

  await createProject(project);
  console.log("[project-storage] Auto-created Creative Engine directions project");
  
  return project.id;
}

/**
 * Get the Creative Engine directions project ID.
 */
export function getDirectionsProjectId(): string {
  return DIRECTIONS_PROJECT_ID;
}
