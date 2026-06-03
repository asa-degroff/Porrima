import { readFile, readdir, stat, writeFile, mkdir, rm } from "fs/promises";
import { basename, dirname, join } from "path";
import { homedir } from "os";
import { fetch } from "undici";
import { appDataPath } from "./paths.js";

const GLOBAL_SKILLS_DIR = appDataPath("skills");
const AGENT_GLOBAL_SKILLS_DIR = join(homedir(), ".agents", "skills");
const SPEC_SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESOURCE_DIRS = ["scripts", "references", "assets"] as const;

export interface Skill {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
  instructions: string;
  examples?: string[];
  guidelines?: string[];
  folderPath: string;
  resources?: Partial<Record<(typeof RESOURCE_DIRS)[number], string[]>>;
  source: "global" | "project";
  sourceRoot: "porrima" | "agents" | "project";
  managed: boolean;
  projectId?: string;
}

interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
}

interface ParsedSkillFile {
  frontmatter: SkillFrontmatter;
  body: string;
}

interface GithubUrlInfo {
  kind: "file" | "directory";
  owner: string;
  repo: string;
  ref: string;
  path: string;
  rawUrl?: string;
}

interface SkillFileToInstall {
  relativePath: string;
  content: string;
}

/**
 * Parse the SKILL.md frontmatter fields defined by the Agent Skills spec.
 * This intentionally supports the small scalar/map subset the spec uses.
 */
export function parseSkillFile(content: string): ParsedSkillFile | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return null;

  const yaml = match[1];
  const body = match[2];
  const root: Record<string, unknown> = {};
  let currentMapKey: string | null = null;

  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;

    const nestedMatch = rawLine.match(/^\s{2,}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (nestedMatch && currentMapKey) {
      const map = root[currentMapKey];
      if (map && typeof map === "object" && !Array.isArray(map)) {
        (map as Record<string, string>)[nestedMatch[1]] = parseYamlScalar(nestedMatch[2]);
      }
      continue;
    }

    currentMapKey = null;
    const fieldMatch = rawLine.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!fieldMatch) return null;

    const key = fieldMatch[1];
    const rawValue = fieldMatch[2] ?? "";
    const trimmedValue = rawValue.trim();
    if (trimmedValue === "|" || trimmedValue === ">") {
      const { value, nextIndex } = parseYamlBlockScalar(lines, i + 1, trimmedValue);
      root[key] = value;
      i = nextIndex - 1;
      continue;
    }

    if (!rawValue.trim()) {
      root[key] = {};
      currentMapKey = key;
    } else {
      root[key] = parseYamlScalar(rawValue);
    }
  }

  const name = stringField(root.name);
  const description = stringField(root.description);
  if (!name || !description) return null;

  const frontmatter: SkillFrontmatter = {
    name,
    description,
    license: stringField(root.license),
    compatibility: stringField(root.compatibility),
    allowedTools: stringField(root["allowed-tools"]),
    metadata: stringMapField(root.metadata),
  };

  return {
    frontmatter,
    body,
  };
}

function parseYamlBlockScalar(lines: string[], startIndex: number, style: "|" | ">"): { value: string; nextIndex: number } {
  const blockLines: string[] = [];
  let minIndent: number | null = null;
  let index = startIndex;

  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      blockLines.push("");
      continue;
    }

    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (indent === 0) {
      break;
    }

    minIndent = minIndent === null ? indent : Math.min(minIndent, indent);
    blockLines.push(line);
  }

  const normalized = blockLines.map((line) => line.slice(minIndent ?? 0));
  const value = style === "|"
    ? normalized.join("\n").trim()
    : normalized.join(" ").replace(/\s+/g, " ").trim();

  return { value, nextIndex: index };
}

function parseYamlScalar(value: string): string {
  const withoutComment = stripYamlComment(value).trim();
  if (
    (withoutComment.startsWith('"') && withoutComment.endsWith('"')) ||
    (withoutComment.startsWith("'") && withoutComment.endsWith("'"))
  ) {
    return withoutComment.slice(1, -1);
  }
  return withoutComment;
}

function stripYamlComment(value: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if ((char === '"' || char === "'") && value[i - 1] !== "\\") {
      quote = quote === char ? null : quote || char;
    }
    if (char === "#" && !quote && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i);
    }
  }
  return value;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringMapField(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const map: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const value = stringField(rawValue);
    if (value) map[key] = value;
  }
  return Object.keys(map).length ? map : undefined;
}

function validateSkillName(name: string): string | null {
  if (!SPEC_SKILL_NAME_RE.test(name)) {
    return "name must contain only lowercase letters, digits, and single hyphens";
  }
  return null;
}

function validateSkillFile(content: string, folderName?: string): ParsedSkillFile | null {
  const parsed = parseSkillFile(content);
  if (!parsed) return null;

  const nameError = validateSkillName(parsed.frontmatter.name);
  if (nameError) {
    console.warn(`[skills] Invalid skill name "${parsed.frontmatter.name}": ${nameError}`);
    return null;
  }

  if (folderName && parsed.frontmatter.name !== folderName) {
    console.warn(`[skills] Invalid skill "${parsed.frontmatter.name}": name must match parent directory "${folderName}"`);
    return null;
  }

  return parsed;
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
async function loadSkill(
  folderPath: string,
  source: "global" | "project" = "global",
  sourceRoot: Skill["sourceRoot"] = "porrima",
  managed = sourceRoot === "porrima",
  projectId?: string,
): Promise<Skill | null> {
  try {
    const skillMdPath = join(folderPath, "SKILL.md");
    const content = await readFile(skillMdPath, "utf-8");

    const parsed = validateSkillFile(content, basename(folderPath));
    if (!parsed) {
      console.warn(`[skills] Invalid frontmatter in ${skillMdPath}`);
      return null;
    }

    const sections = extractSections(parsed.body);
    const resources = await discoverSkillResources(folderPath);

    return {
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      license: parsed.frontmatter.license,
      compatibility: parsed.frontmatter.compatibility,
      metadata: parsed.frontmatter.metadata,
      allowedTools: parsed.frontmatter.allowedTools,
      instructions: parsed.body,
      examples: sections.examples,
      guidelines: sections.guidelines,
      folderPath,
      resources,
      source,
      sourceRoot,
      managed,
      projectId,
    };
  } catch (err: any) {
    console.warn(`[skills] Failed to load skill from ${folderPath}:`, err.message);
    return null;
  }
}

async function loadSkillsFromDirectory(
  rootDir: string,
  source: "global" | "project",
  sourceRoot: Skill["sourceRoot"],
  managed: boolean,
  projectId?: string,
): Promise<Skill[]> {
  const skills: Skill[] = [];

  try {
    await stat(rootDir);
    const entries = await readdir(rootDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skill = await loadSkill(join(rootDir, entry.name), source, sourceRoot, managed, projectId);
      if (skill) {
        skills.push(skill);
      }
    }
  } catch {
    console.log(`[skills] Skills directory not found: ${rootDir}`);
  }

  return skills;
}

function addDiscoveredSkill(skillsByName: Map<string, Skill>, skill: Skill, overwrite: boolean): void {
  const key = skill.name.toLowerCase();
  if (overwrite || !skillsByName.has(key)) {
    skillsByName.set(key, skill);
  }
}

async function discoverSkillResources(folderPath: string): Promise<Skill["resources"] | undefined> {
  const resources: Skill["resources"] = {};

  for (const dirName of RESOURCE_DIRS) {
    const dirPath = join(folderPath, dirName);
    try {
      const files = (await collectResourceFiles(dirPath, dirName)).sort((a, b) => a.localeCompare(b));
      if (files.length) {
        resources[dirName] = files;
      }
    } catch {
      // Resource directories are optional.
    }
  }

  return Object.keys(resources).length ? resources : undefined;
}

async function collectResourceFiles(dirPath: string, relativeDir: string): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const relativePath = `${relativeDir}/${entry.name}`;
    if (entry.isFile()) {
      files.push(relativePath);
    } else if (entry.isDirectory()) {
      files.push(...await collectResourceFiles(join(dirPath, entry.name), relativePath));
    }
  }

  return files;
}

/**
 * Discover all skills from global and project directories.
 */
export async function discoverSkills(projectId?: string): Promise<Skill[]> {
  const skillsByName = new Map<string, Skill>();

  // Porrima-managed globals take precedence over shared agent globals.
  for (const skill of await loadSkillsFromDirectory(GLOBAL_SKILLS_DIR, "global", "porrima", true)) {
    addDiscoveredSkill(skillsByName, skill, false);
  }

  // Shared Agent Skills installed outside Porrima are available but read-only.
  for (const skill of await loadSkillsFromDirectory(AGENT_GLOBAL_SKILLS_DIR, "global", "agents", false)) {
    addDiscoveredSkill(skillsByName, skill, false);
  }

  // Project-specific skills override global skills with the same name.
  if (projectId) {
    try {
      const { getProject } = await import("./chat-storage.js");
      const project = await getProject(projectId);
      if (project) {
        const projectSkillsDir = join(project.path, ".agents", "skills");
        const projectSkills = await loadSkillsFromDirectory(projectSkillsDir, "project", "project", false, project.id);
        for (const skill of projectSkills) {
          addDiscoveredSkill(skillsByName, skill, true);
        }
        if (projectSkills.length > 0) {
          console.log(`[skills] Loaded project skills from ${projectSkillsDir}`);
        }
      }
    } catch (err: any) {
      console.warn(`[skills] Failed to load project skills:`, err.message);
    }
  }

  const skills = Array.from(skillsByName.values()).sort((a, b) => a.name.localeCompare(b.name));
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
    activeSections.push(`Skill root: ${skill.folderPath}`);
    if (skill.compatibility) {
      activeSections.push(`Compatibility: ${skill.compatibility}`);
    }
    if (skill.allowedTools) {
      activeSections.push(`Allowed tools requested by skill: ${skill.allowedTools}`);
    }
    if (skill.resources && Object.keys(skill.resources).length) {
      const resourceList = Object.values(skill.resources).flat().join(", ");
      activeSections.push(`Optional skill resources: ${resourceList}`);
      activeSections.push("Load or run these resources from the skill root only when the task requires them.");
    }
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
  const matches = message.match(/(?:^|(?<=\s))\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g);
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
  return message.replace(/(?:^|(?<=\s))\/[a-z0-9]+(?:-[a-z0-9]+)*(?=\s|$)/g, '').trim().replace(/\s+/g, ' ');
}

/**
 * Parse a GitHub URL to extract either a raw SKILL.md file or a skill directory.
 * Supports github.com blob/tree URLs and raw.githubusercontent.com SKILL.md URLs.
 */
function parseGithubUrl(url: string): GithubUrlInfo | null {
  try {
    const parsed = new URL(url);

    if (parsed.hostname === "raw.githubusercontent.com") {
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (parts.length < 4) return null;
      const [owner, repo, ref, ...pathParts] = parts;
      return { kind: "file", owner, repo, ref, path: pathParts.join("/"), rawUrl: url };
    }

    if (parsed.hostname === "github.com") {
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (parts.length >= 4 && (parts[2] === "blob" || parts[2] === "tree")) {
        const [owner, repo, kind, ref, ...pathParts] = parts;
        const filePath = pathParts.join("/");
        return {
          kind: kind === "tree" ? "directory" : "file",
          owner,
          repo,
          ref,
          path: filePath,
          rawUrl: kind === "blob" ? `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}` : undefined,
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Install a skill from a URL (GitHub skill directory or direct SKILL.md)
 */
export async function installSkillFromUrl(url: string, customName?: string): Promise<{ name: string; path: string; message: string }> {
  const githubInfo = parseGithubUrl(url);
  console.log(`[skills] Installing from ${url}`);

  const files = githubInfo?.kind === "directory"
    ? await fetchGithubSkillDirectory(githubInfo)
    : [{ relativePath: "SKILL.md", content: await fetchSkillMarkdown(githubInfo?.rawUrl || url) }];

  const skillMd = files.find((file) => file.relativePath === "SKILL.md");
  if (!skillMd) {
    throw new Error("Invalid skill directory: missing SKILL.md at the skill root");
  }

  const parsed = validateSkillFile(skillMd.content);
  if (!parsed) {
    throw new Error("Invalid SKILL.md format: frontmatter must follow the Agent Skills spec with valid 'name' and 'description' fields.");
  }

  if (customName && customName !== parsed.frontmatter.name) {
    throw new Error(`Custom name "${customName}" is not compatible with the Agent Skills spec. The directory name must match frontmatter name "${parsed.frontmatter.name}".`);
  }

  const skillName = parsed.frontmatter.name;

  const skillDir = join(GLOBAL_SKILLS_DIR, skillName);
  await mkdir(GLOBAL_SKILLS_DIR, { recursive: true });
  await mkdir(skillDir, { recursive: true });

  for (const file of files) {
    if (!isSafeSkillRelativePath(file.relativePath)) {
      throw new Error(`Refusing to install unsafe skill file path: ${file.relativePath}`);
    }
    const targetPath = join(skillDir, file.relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, file.content, "utf-8");
  }

  const skillPath = join(skillDir, "SKILL.md");
  console.log(`[skills] Installed skill "${skillName}" to ${skillPath}`);

  return {
    name: skillName,
    path: skillPath,
    message: `Installed skill "${skillName}" from ${url}`,
  };
}

async function fetchSkillMarkdown(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "porrima/1.0",
        "Accept": "text/markdown,text/plain,*/*",
      },
      redirect: "follow" as const,
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
    }

    return response.text();
  } catch (err: any) {
    throw new Error(`Failed to fetch skill from URL: ${err.message}`);
  }
}

async function fetchGithubSkillDirectory(info: GithubUrlInfo): Promise<SkillFileToInstall[]> {
  const apiUrl = `https://api.github.com/repos/${info.owner}/${info.repo}/contents/${encodeURIComponentPath(info.path)}?ref=${encodeURIComponent(info.ref)}`;
  const files = await fetchGithubContents(apiUrl, "");
  return files.filter((file) => {
    const firstSegment = file.relativePath.split("/")[0];
    return file.relativePath === "SKILL.md" || RESOURCE_DIRS.includes(firstSegment as (typeof RESOURCE_DIRS)[number]);
  });
}

async function fetchGithubContents(apiUrl: string, basePath: string): Promise<SkillFileToInstall[]> {
  const response = await fetch(apiUrl, {
    headers: {
      "User-Agent": "porrima/1.0",
      "Accept": "application/vnd.github+json",
    },
    redirect: "follow" as const,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch GitHub skill directory: ${response.status} ${response.statusText}`);
  }

  const entries = await response.json() as Array<{
    name: string;
    type: "file" | "dir";
    download_url?: string | null;
    url: string;
  }>;

  const files: SkillFileToInstall[] = [];
  for (const entry of entries) {
    const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;
    if (entry.type === "dir") {
      if (!RESOURCE_DIRS.includes(entry.name as (typeof RESOURCE_DIRS)[number]) && !basePath) {
        continue;
      }
      files.push(...await fetchGithubContents(entry.url, relativePath));
    } else if (entry.type === "file" && entry.download_url) {
      files.push({ relativePath, content: await fetchSkillMarkdown(entry.download_url) });
    }
  }

  return files;
}

function encodeURIComponentPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function isSafeSkillRelativePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
    return false;
  }
  return path === "SKILL.md" || RESOURCE_DIRS.includes(path.split("/")[0] as (typeof RESOURCE_DIRS)[number]);
}

/**
 * Remove a global skill by name
 */
export async function removeGlobalSkill(skillName: string): Promise<{ success: boolean; message: string }> {
  const nameError = validateSkillName(skillName);
  if (nameError) {
    throw new Error(`Invalid skill name: ${nameError}`);
  }

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
  const nameError = validateSkillName(skillName);
  if (nameError) {
    throw new Error(`Invalid skill name: ${nameError}`);
  }

  const parsed = validateSkillFile(content, skillName);
  if (!parsed) {
    throw new Error("Invalid SKILL.md format: frontmatter must follow the Agent Skills spec and name must match the skill directory");
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
    message: `Updated skill "${parsed.frontmatter.name}"`,
    name: parsed.frontmatter.name,
  };
}
