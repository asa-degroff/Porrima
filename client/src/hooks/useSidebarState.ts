import { useState, useEffect } from "react";

interface SidebarState {
  projectsExpanded: boolean;
  agentExpanded: boolean;
  quickExpanded: boolean;
  projectStates: Record<string, boolean>;
}

const STORAGE_KEY = "quje-sidebar-state";

const DEFAULT_STATE: SidebarState = {
  projectsExpanded: true,
  agentExpanded: true,
  quickExpanded: true,
  projectStates: {},
};

function loadState(): SidebarState {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return { ...DEFAULT_STATE, ...JSON.parse(stored) };
    }
  } catch (e) {
    console.warn("Failed to load sidebar state:", e);
  }
  return DEFAULT_STATE;
}

function saveState(state: SidebarState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn("Failed to save sidebar state:", e);
  }
}

export function useSidebarState() {
  const [state, setState] = useState<SidebarState>(loadState);

  useEffect(() => {
    saveState(state);
  }, [state]);

  const setProjectsExpanded = (expanded: boolean) => {
    setState((prev) => ({ ...prev, projectsExpanded: expanded }));
  };

  const setAgentExpanded = (expanded: boolean) => {
    setState((prev) => ({ ...prev, agentExpanded: expanded }));
  };

  const setQuickExpanded = (expanded: boolean) => {
    setState((prev) => ({ ...prev, quickExpanded: expanded }));
  };

  const setProjectExpanded = (projectId: string, expanded: boolean) => {
    setState((prev) => ({
      ...prev,
      projectStates: { ...prev.projectStates, [projectId]: expanded },
    }));
  };

  const getProjectExpanded = (projectId: string): boolean => {
    return state.projectStates[projectId] ?? true;
  };

  return {
    projectsExpanded: state.projectsExpanded,
    agentExpanded: state.agentExpanded,
    quickExpanded: state.quickExpanded,
    setProjectsExpanded,
    setAgentExpanded,
    setQuickExpanded,
    setProjectExpanded,
    getProjectExpanded,
  };
}
