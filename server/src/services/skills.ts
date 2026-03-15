import { readFile, readdir, stat } from "fs/promises";
import { resolve, join } from "path";
import { homedir } from "os";

const HOME = homedir();
const SKILLS_DIR = resolve(HOME, ".quje-agent", "skills");

export interface Skill {
  name: string;
  description: string;
  instructions: string;
  examples?: string[];
  guidelines?: string[];
  folderPath: string;
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
async function loadSkill(folderPath: string): Promise<Skill | null> {
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
    };
  } catch (err: any) {
    console.warn(`[skills] Failed to load skill from ${folderPath}:`, err.message);
    return null;
  }
}

/**
 * Discover all skills from the skills directory.
 */
export async function discoverSkills(): Promise<Skill[]> {
  try {
    await stat(SKILLS_DIR); // will throw if doesn't exist
  } catch {
    console.log(`[skills] Skills directory not found: ${SKILLS_DIR}`);
    return [];
  }
  
  const skills: Skill[] = [];
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    
    const skill = await loadSkill(join(SKILLS_DIR, entry.name));
    if (skill) {
      skills.push(skill);
    }
  }
  
  skills.sort((a, b) => a.name.localeCompare(b.name));
  console.log(`[skills] Discovered ${skills.length} skills`);
  return skills;
}

/**
 * Get a skill by name.
 */
export async function getSkillByName(name: string): Promise<Skill | null> {
  const skills = await discoverSkills();
  return skills.find(s => s.name.toLowerCase() === name.toLowerCase()) || null;
}

/**
 * Build the combined system prompt with active skills injected.
 */
export function buildSkillAugmentedPrompt(
  baseSystemPrompt: string,
  activeSkillNames: string[],
  skillsCache: Map<string, Skill>
): string {
  if (activeSkillNames.length === 0) {
    return baseSystemPrompt;
  }
  
  const activeSections: string[] = [];
  
  for (const skillName of activeSkillNames) {
    const skill = skillsCache.get(skillName);
    if (!skill) continue;
    
    activeSections.push(`## Skill: ${skill.name}`);
    activeSections.push(skill.instructions);
    activeSections.push("");
  }
  
  return `${baseSystemPrompt}\n\n[Active Skills]\n${activeSections.join("\n")}`;
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
