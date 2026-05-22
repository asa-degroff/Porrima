import { useState, useEffect, useCallback } from "react";
import {
  fetchProjects,
  createProject as apiCreateProject,
  updateProject as apiUpdateProject,
  deleteProject as apiDeleteProject,
  OfflineError,
  type Project,
  type ProjectLocationType,
} from "../api/client";

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const list = await fetchProjects();
      setProjects(list);
    } catch (e) {
      if (!(e instanceof OfflineError)) {
        console.error("Failed to fetch projects:", e);
      }
      // silently fail offline
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();

    // Listen for project updates from sidebar
    const handleUpdate = () => refresh();
    window.addEventListener("projects:updated", handleUpdate);
    return () => window.removeEventListener("projects:updated", handleUpdate);
  }, [refresh]);

  const createProject = useCallback(
    async (name: string, path: string, locationType?: ProjectLocationType, sshConnectionId?: string) => {
      const project = await apiCreateProject({ name, path, locationType, sshConnectionId });
      await refresh();
      return project;
    },
    [refresh]
  );

  const updateProject = useCallback(
    async (id: string, updates: { name?: string; path?: string; locationType?: ProjectLocationType; sshConnectionId?: string; color?: string; pinned?: boolean }) => {
      const project = await apiUpdateProject(id, updates);
      await refresh();
      return project;
    },
    [refresh]
  );

  const removeProject = useCallback(
    async (id: string) => {
      await apiDeleteProject(id);
      await refresh();
    },
    [refresh]
  );

  return { projects, loading, createProject, updateProject, removeProject, refresh };
}
