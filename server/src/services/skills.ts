import { readFile, readdir, stat, access, writeFile, mkdir, rm } from "fs/promises";
import { resolve, join } from "path";
import { homedir } from "os";
import { fetch } from "undici";
import { appDataPath } from "./paths.js";

const HOME = homedir();
const GLOBAL_SKILLS_DIR = appDataPath("skills");

export interface Skill {
  name: string;
  description: string;
  instructions: string;
  examples?: string[];
  guidelines?: string[];
  folderPath: string;
  source: "global" | "project";
  projectId?: string;
}

interface SkillFrontmatter {
  name: string;
  description: string;
}

/**
 * Parse YAML frontmatter from markdown content.
 * Simple parser for --- delimited YAML block.
 */
function parseFrontmatter(content: string): SkillFrontmatter | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return null;

  const yaml = match[1];
  const markdown = match[3];

  const nameMatch = yaml.match(/name:\s*(.+?)(?:\r?\n|$)/);
  const descMatch = yaml.match(/description:\s*(.+?)(?:\r?\n|$)/);

  if (!nameMatch || !descMatch) return null;

  return {
    name: nameMatch[1].trim(),
    description: descMatch[1].trim(),
  };
}

/**
 * Extract examples and guidelines from markdown content.
 * Looks for ## Examples and ## Guidelines sections.
 */
function extractSections(markdown: string): { examples?: string[]; guidelines?: string[] } {
  const result: { examples?: string[]; guidelines?: string[] } = {};

  const examplesMatch = markdown.match(/## Examples\s*\n([\s\S]*?)(?:\n## |\n$|$)/i);
  if (examplesMatch) {
    result.examples = examplesMatch[1]
      .split("\n")
      .filter(line => line.startsWith("-"))
      .map(line => line.slice(1).trim());
  }

  const guidelinesMatch = markdown.match(/## Guidelines?\s*\n([\s\S]*?)(?:\n## |\n$|$)/i);
  if (guidelinesMatch) {
    result.guidelines = guidelinesMatch[1]
      .split("\n")
      .filter(line => line.startsWith("-"))
      .map(line => line.slice(1).trim());
  }

  return result;
}

/**
 * Load a single skill from its folder.
 */
async function loadSkill(folderPath: string, source: "global" | "project" = "global", projectId?: string): Promise<Skill | null> {
  try {
    const skillMdPath = join(folderPath, "SKILL.md");
    const content = await readFile(skillMdPath, "utf-8");

    const frontmatter = parseFrontmatter(content);
    if (!frontmatter) {
      console.warn(`[skills] Invalid frontmatter in ${skillMdPath}`);
      return null;
    }

    const markdownContent = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "");
    const sections = extractSections(markdownContent);

    return {
      name: frontmatter.name,
      description: frontmatter.description,
      instructions: markdownContent,
      examples: sections.examples,
      guidelines: sections.guidelines,
      folderPath,
      source,
      projectId,
    };
  } catch (err: any) {
    console.warn(`[skills] Failed to load skill from ${folderPath}:`, err.message);
    return null;
  }
}

/**
 * Discover all skills from global and project directories.
 */
export async function discoverSkills(projectId?: string): Promise<Skill[]> {
  const skills: Skill[] = [];

  // Load global skills
  try {
    await stat(GLOBAL_SKILLS_DIR);
    const entries = await readdir(GLOBAL_SKILLS_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skill = await loadSkill(join(GLOBAL_SKILLS_DIR, entry.name), "global");
      if (skill) {
        skills.push(skill);
      }
    }
  } catch {
    console.log(`[skills] Global skills directory not found: ${GLOBAL_SKILLS_DIR}`);
  }

  // Load project-specific skills if projectId provided
  if (projectId) {
    try {
      const { getProject } = await import("./chat-storage.js");
      const project = await getProject(projectId);
      if (project) {
        const projectSkillsDir = join(project.path, ".agents", "skills");
        try {
          await stat(projectSkillsDir);
          const entries = await readdir(projectSkillsDir, { withFileTypes: true });

          for (const entry of entries) {
            if (!entry.isDirectory()) continue;

            const skill = await loadSkill(join(projectSkillsDir, entry.name), "project", project.id);
            if (skill) {
              skills.push(skill);
            }
          }
          console.log(`[skills] Loaded project skills from ${projectSkillsDir}`);
        } catch {
          console.log(`[skills] No project skills directory at ${projectSkillsDir}`);
        }
      }
    } catch (err: any) {
      console.warn(`[skills] Failed to load project skills:`, err.message);
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  console.log(`[skills] Discovered ${skills.length} skills total`);
  return skills;
}

/**
 * Get a skill by name.
 */
export async function getSkillByName(name: string, projectId?: string): Promise<Skill | null> {
  const skills = await discoverSkills(projectId);
  return skills.find(s => s.name.toLowerCase() === name.toLowerCase()) || null;
}

/**
 * Strip any existing `[Active Skills]` section from a system prompt.
 *
 * This is used by `buildSkillAugmentedPrompt` to ensure idempotency — calling
 * it on a prompt that already has an `[Active Skills]` section strips the old
 * section and rebuilds it, rather than appending a duplicate. This is essential
 * for LCP/KV-cache byte-identical matching: the output must be identical for
 * the same skill set, regardless of whether the input prompt already contained
 * the section.
 */
export function stripActiveSkillsSection(prompt: string): string {
  const match = /(?:^|\r?\n\r?\n)\[Active Skills\]\r?\n/.exec(prompt);
  const idx = match?.index ?? -1;
  if (idx === -1) return prompt;
  return prompt.slice(0, idx);
}

/**
 * Build the combined system prompt with active skills injected.
 *
 * Idempotent: if the input prompt already contains an `[Active Skills]` section,
 * it is stripped first and rebuilt from the current skill definitions. This
 * prevents duplication when the function is called on an already-augmented
 * prompt (e.g., cached prompt, pending-state resume) and guarantees byte-
 * identical output for the same skill set, which is required for LCP KV-cache
 * prefix matching between turns.
 *
 * At compaction time the system prompt is rebuilt from `chat.systemPrompt` (the
 * base, which never contains skills), so stripping is a no-op and the output
 * is deterministic. Between turns (no compaction), the stable-prefix portion
 * is cached and byte-identical; skills are appended on top, so the full prompt
 * only changes when the active skill set actually changes.
 */
export function buildSkillAugmentedPrompt(
  baseSystemPrompt: string,
  activeSkillNames: string[],
  skillsCache: Map<string, Skill>
): string {
  if (activeSkillNames.length === 0) {
    // Strip any stale skills section so the prompt is clean — the caller
    // expects no skills in the output when the active set is empty.
    return stripActiveSkillsSection(baseSystemPrompt);
  }

  const activeSections: string[] = [];

  for (const skillName of activeSkillNames) {
    const skill = skillsCache.get(skillName);
    if (!skill) continue;

    activeSections.push(`## Skill: ${skill.name}`);
    activeSections.push(skill.instructions);
    activeSections.push("");
  }

  // Strip any existing [Active Skills] section before rebuilding. This
  // prevents duplication and produces byte-identical output for the same
  // skill set regardless of whether the input already contained the section.
  const cleanPrompt = stripActiveSkillsSection(baseSystemPrompt);
  if (activeSections.length === 0) {
    return cleanPrompt;
  }
  return `${cleanPrompt}\n\n[Active Skills]\n${activeSections.join("\n")}`;
}

/**
 * Parse skill activations from a message.
 * Looks for all /skill-name patterns that are preceded by whitespace or start of string.
 * Uses lookahead to avoid consuming whitespace, allowing consecutive skills like "/one /two".
 * Returns an array of skill names found.
 */
export function parseSkillInvocations(message: string): string[] {
  const matches = message.match(/(?:^|(?<=\s))\/([a-zA-Z0-9\-_]+)(?=\s|$)/g);
  if (!matches) return [];

  return matches.map(m => {
    const match = m.match(/\/([a-zA-Z0-9\-_]+)/);
    return match ? match[1] : '';
  }).filter(Boolean);
}

/**
 * Strip skill invocations from a message.
 * Removes all /skill-name patterns (preceded by whitespace or start) and normalizes whitespace.
 * Uses lookahead to avoid consuming whitespace, allowing consecutive skills to be stripped correctly.
 */
export function stripSkillInvocations(message: string): string {
  // Remove skill invocations and normalize whitespace
  return message.replace(/(?:^|(?<=\s))\/[a-zA-Z0-9\-_]+(?=\s|$)/g, '').trim().replace(/\s+/g, ' ');
}

/**
 * Parse a GitHub URL to extract raw file URL.
 * Supports: github.com/user/repo/blob/branch/path, github.com/user/repo/tree/branch/path, raw.githubusercontent.com
 */
function parseGithubUrl(url: string): { rawUrl: string; fileName: string } | null {
  try {
    const parsed = new URL(url);

    // Already a raw URL
    if (parsed.hostname === "raw.githubusercontent.com") {
      const parts = parsed.pathname.split("/");
      return { rawUrl: url, fileName: parts[parts.length - 1] };
    }

    // github.com URLs
    if (parsed.hostname === "github.com") {
      const parts = parsed.pathname.split("/").filter(Boolean);
      // Pattern: /user/repo/blob/branch/path/to/file
      // or: /user/repo/tree/branch/path/to/folder
      if (parts.length >= 4 && (parts[2] === "blob" || parts[2] === "tree")) {
        const [user, repo, , branch, ...pathParts] = parts;
        const filePath = pathParts.join("/");
        const rawUrl = `https://raw.githubusercontent.com/${user}/${repo}/${branch}/${filePath}`;
        return { rawUrl, fileName: pathParts[pathParts.length - 1] || "skill" };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Install a skill from a URL (GitHub or direct URL to SKILL.md)
 */
export async function installSkillFromUrl(url: string, customName?: string): Promise<{ name: string; path: string; message: string }> {
  const githubInfo = parseGithubUrl(url);
  const fetchUrl = githubInfo?.rawUrl || url;
  const fileName = githubInfo?.fileName || customName || "skill";

  console.log(`[skills] Installing from ${fetchUrl}`);

  // Fetch the content
  let content: string;
  try {
    const response = await fetch(fetchUrl, {
      headers: {
        "User-Agent": "porrima/1.0",
        "Accept": "text/markdown,text/plain,*/*",
      },
      // GitHub raw URLs may need redirect following
      redirect: "follow" as const,
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
    }

    content = await response.text();
  } catch (err: any) {
    throw new Error(`Failed to fetch skill from URL: ${err.message}`);
  }

  // Validate it has proper frontmatter
  const frontmatter = parseFrontmatter(content);
  if (!frontmatter) {
    throw new Error("Invalid SKILL.md format: missing or malformed frontmatter. Must have --- delimited YAML with 'name' and 'description' fields.");
  }

  // Use custom name if provided, otherwise extract from frontmatter
  const skillName = customName || frontmatter.name.replace(/[^a-zA-Z0-9\-_]/g, "-").toLowerCase();

  // Ensure directory exists
  const skillDir = join(GLOBAL_SKILLS_DIR, skillName);
  await mkdir(GLOBAL_SKILLS_DIR, { recursive: true });
  await mkdir(skillDir, { recursive: true });

  // Write the skill
  const skillPath = join(skillDir, "SKILL.md");
  await writeFile(skillPath, content, "utf-8");

  console.log(`[skills] Installed skill "${skillName}" to ${skillPath}`);

  return {
    name: skillName,
    path: skillPath,
    message: `Installed skill "${frontmatter.name}" (${skillName}) from ${url}`,
  };
}

/**
 * Remove a global skill by name
 */
export async function removeGlobalSkill(skillName: string): Promise<{ success: boolean; message: string }> {
  const skillDir = join(GLOBAL_SKILLS_DIR, skillName);

  try {
    await stat(skillDir);
  } catch {
    throw new Error(`Skill "${skillName}" not found`);
  }

  await rm(skillDir, { recursive: true, force: true });
  console.log(`[skills] Removed skill "${skillName}" from ${skillDir}`);

  return {
    success: true,
    message: `Removed skill "${skillName}"`,
  };
}

/**
 * Update a global skill's content
 */
export async function updateGlobalSkill(skillName: string, content: string): Promise<{ success: boolean; message: string; name?: string }> {
  // Validate frontmatter
  const frontmatter = parseFrontmatter(content);
  if (!frontmatter) {
    throw new Error("Invalid SKILL.md format: missing or malformed frontmatter");
  }

  const skillDir = join(GLOBAL_SKILLS_DIR, skillName);

  try {
    await stat(skillDir);
  } catch {
    throw new Error(`Skill "${skillName}" not found`);
  }

  const skillPath = join(skillDir, "SKILL.md");
  await writeFile(skillPath, content, "utf-8");

  console.log(`[skills] Updated skill "${skillName}" at ${skillPath}`);

  return {
    success: true,
    message: `Updated skill "${frontmatter.name}"`,
    name: frontmatter.name,
  };
}
