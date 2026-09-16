import { getChat, getProject, listProjects } from "./chat-storage.js";

/**
 * Scope handling for memory blocks.
 *
 * Invariants enforced here (and mirrored by normalization in
 * `memory-storage.createMemoryBlock` / `updateMemoryBlock`):
 *   - `global` blocks always have an empty projectId
 *   - `project` blocks always carry a projectId that refers to a real project
 *   - `archived` blocks keep their projectId so restoring can return them home
 *
 * Callers that know the originating chat (agent tools) pass `chatId`; callers
 * that don't (REST API) leave it out and must supply an explicit project
 * reference when targeting project scope.
 */

export type BlockScope = "global" | "project" | "archived";

export const BLOCK_SCOPES: readonly BlockScope[] = ["global", "project", "archived"];

export function isBlockScope(value: unknown): value is BlockScope {
  return typeof value === "string" && (BLOCK_SCOPES as readonly string[]).includes(value);
}

export interface BlockScopeTarget {
  scope: BlockScope;
  projectId: string;
}

export type BlockScopeResolution =
  | { ok: true; target: BlockScopeTarget }
  | { ok: false; error: string };

export interface BlockScopeInput {
  /** Scope explicitly requested by the caller. */
  requestedScope?: BlockScope;
  /**
   * Explicit project reference — a project ID, name, path, or "current".
   * `null` means the caller explicitly cleared it (empty string in tool args);
   * `undefined` means "not provided".
   */
  requestedProjectId?: string | null;
  /** Existing block (updates/supersession) — provides scope/project inheritance. */
  existing?: { scope: BlockScope; projectId?: string };
  /** Chat used to infer the current project when none is given. */
  chatId?: string;
}

/** Resolve the current chat's project, or "" when the chat has none. */
export async function resolveCurrentChatProjectId(chatId?: string): Promise<string> {
  if (!chatId) return "";
  try {
    const chat = await getChat(chatId);
    return chat?.projectId || "";
  } catch {
    return "";
  }
}

/**
 * Resolve a project reference (ID, exact name, exact path, or "current") to a
 * project ID. Names/paths are matched case-insensitively for names and exactly
 * for paths; ambiguous matches are rejected with the candidate list rather
 * than guessing.
 */
export async function resolveProjectReference(
  ref: string,
  chatId?: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const trimmed = ref.trim();
  if (!trimmed) return { ok: false, error: "Empty project reference." };

  if (trimmed.toLowerCase() === "current") {
    const current = await resolveCurrentChatProjectId(chatId);
    if (current) return { ok: true, id: current };
    return {
      ok: false,
      error: `project_id="current" was requested, but this chat isn't associated with a project.`,
    };
  }

  const byId = await getProject(trimmed);
  if (byId) return { ok: true, id: byId.id };

  const projects = await listProjects();
  const lower = trimmed.toLowerCase();
  const matches = projects.filter(
    (p) => p.name.toLowerCase() === lower || p.path === trimmed,
  );
  if (matches.length === 1) return { ok: true, id: matches[0].id };
  if (matches.length > 1) {
    return {
      ok: false,
      error:
        `Multiple projects match "${trimmed}": ` +
        `${matches.map((m) => `${m.name} (${m.id})`).join(", ")}. Pass the exact project ID.`,
    };
  }

  const known = projects.slice(0, 8).map((p) => `${p.name} (${p.id})`).join(", ");
  return {
    ok: false,
    error:
      `Unknown project "${trimmed}".` +
      (known ? ` Known projects: ${known}.` : " No projects exist yet.") +
      ` Pass a project ID, name, or path.`,
  };
}

/**
 * Resolve the final scope + projectId for a block create/update/supersede.
 *
 * Scope precedence: explicit `requestedScope` → non-empty `project_id` implies
 * `project` → the existing block's scope → `global` (create default).
 *
 * Project precedence for `project` scope: explicit `project_id` → the existing
 * block's project (restores/retargets keep their home) → the current chat's
 * project. When none resolves the call is rejected instead of writing an
 * orphaned project block that no chat will ever load.
 */
export async function resolveBlockScopeTarget(input: BlockScopeInput): Promise<BlockScopeResolution> {
  const explicitProject = typeof input.requestedProjectId === "string"
    ? input.requestedProjectId.trim()
    : undefined;
  const explicitClear = input.requestedProjectId === null || explicitProject === "";
  const existingProjectId = (input.existing?.projectId || "").trim();

  let scope: BlockScope;
  if (input.requestedScope) scope = input.requestedScope;
  else if (explicitProject) scope = "project";
  else if (input.existing) scope = input.existing.scope;
  else scope = "global";

  if (scope === "global") {
    if (explicitProject) {
      return {
        ok: false,
        error:
          `scope="global" blocks apply to every chat and can't carry a project. ` +
          `Use scope="project" to keep the block in "${explicitProject}", or drop project_id.`,
      };
    }
    return { ok: true, target: { scope, projectId: "" } };
  }

  if (scope === "archived") {
    if (explicitProject) {
      const resolved = await resolveProjectReference(explicitProject, input.chatId);
      if (!resolved.ok) return resolved;
      return { ok: true, target: { scope, projectId: resolved.id } };
    }
    // Keep the block's project association so restoring it later can return it
    // to the right project; `project_id=""` explicitly clears it.
    return { ok: true, target: { scope, projectId: explicitClear ? "" : existingProjectId } };
  }

  // scope === "project"
  if (explicitClear) {
    return {
      ok: false,
      error:
        `A project-scoped block needs a project. Use scope="global" to move it out of the project, ` +
        `or omit project_id to use the current chat's project.`,
    };
  }
  if (explicitProject) {
    const resolved = await resolveProjectReference(explicitProject, input.chatId);
    if (!resolved.ok) return resolved;
    return { ok: true, target: { scope, projectId: resolved.id } };
  }
  if (existingProjectId) {
    return { ok: true, target: { scope, projectId: existingProjectId } };
  }

  const current = await resolveCurrentChatProjectId(input.chatId);
  if (current) return { ok: true, target: { scope, projectId: current } };

  return {
    ok: false,
    error:
      `This chat isn't associated with a project, so the block can't be project-scoped. ` +
      `Pass project_id (project ID, name, or path) to target a project, or use scope="global".`,
  };
}