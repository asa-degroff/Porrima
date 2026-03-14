import { readFile, writeFile, readdir, unlink, mkdir, access } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { Project } from "../types.js";

const BASE_DIR = join(homedir(), ".quje-agent");
const PROJECTS_DIR = join(BASE_DIR, "projects");

async function ensureDir() {
  await mkdir(PROJECTS_DIR, { recursive: true });
}

function projectPath(id: string): string {
  return join(PROJECTS_DIR, `${id}.json`);
}

export async function listProjects(): Promise<Project[]> {
  await ensureDir();
  const files = await readdir(PROJECTS_DIR);
  const projects: Project[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const data = await readFile(join(PROJECTS_DIR, file), "utf-8");
      const project: Project = JSON.parse(data);
      projects.push(project);
    } catch {
      // skip corrupt files
    }
  }

  return projects.sort(
    (a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime()
  );
}

export async function getProject(id: string): Promise<Project | null> {
  try {
    const data = await readFile(projectPath(id), "utf-8");
    return JSON.parse(data) as Project;
  } catch {
    return null;
  }
}

export async function createProject(name: string, path: string): Promise<Project> {
  await ensureDir();
  const project: Project = {
    id: crypto.randomUUID(),
    name,
    path,
    createdAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
  };
  await writeFile(projectPath(project.id), JSON.stringify(project, null, 2));
  return project;
}

export async function updateProject(id: string, updates: Partial<Project>): Promise<Project | null> {
  const project = await getProject(id);
  if (!project) return null;

  Object.assign(project, updates);
  project.lastModified = new Date().toISOString();
  await writeFile(projectPath(project.id), JSON.stringify(project, null, 2));
  return project;
}

export async function deleteProject(id: string): Promise<boolean> {
  try {
    await unlink(projectPath(id));
    return true;
  } catch {
    return false;
  }
}

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
