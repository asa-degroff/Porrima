import { useState, useEffect, useCallback } from "react";
import { fetchUserUIState, saveUserUIState, type UserUIState } from "../api/client";

interface SidebarState {
  projectsExpanded: boolean;
  agentExpanded: boolean;
  quickExpanded: boolean;
  projectStates: Record<string, boolean>;
}

const LOCAL_STORAGE_KEY = "quje-sidebar-state";

const DEFAULT_STATE: SidebarState = {
  projectsExpanded: true,
  agentExpanded: true,
  quickExpanded: true,
  projectStates: {},
};

function loadLocalState(): SidebarState {
  try {
    const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (stored) {
      return { ...DEFAULT_STATE, ...JSON.parse(stored) };
    }
  } catch (e) {
    console.warn("Failed to load sidebar state from localStorage:", e);
  }
  return DEFAULT_STATE;
}

function saveLocalState(state: SidebarState) {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn("Failed to save sidebar state to localStorage:", e);
  }
}

export function useSidebarState() {
  const [state, setState] = useState<SidebarState>(loadLocalState);
  const [synced, setSynced] = useState(false);

  // Load from server on mount, fall back to localStorage
  useEffect(() => {
    fetchUserUIState()
      .then((serverState) => {
        if (serverState.sidebarState) {
          setState(serverState.sidebarState);
        }
        setSynced(true);
      })
      .catch((err) => {
        console.warn("Failed to load sidebar state from server, using localStorage:", err);
        setSynced(true);
      });
  }, []);

  // Save to server with debounce, also save to localStorage as fallback
  useEffect(() => {
    if (!synced) return;
    
    saveLocalState(state);
    
    const timer = setTimeout(() => {
      saveUserUIState({ sidebarState: state }).catch((err) => {
        console.warn("Failed to save sidebar state to server:", err);
      });
    }, 500);

    return () => clearTimeout(timer);
  }, [state, synced]);

  const setProjectsExpanded = useCallback((expanded: boolean) => {
    setState((prev) => ({ ...prev, projectsExpanded: expanded }));
  }, []);

  const setAgentExpanded = useCallback((expanded: boolean) => {
    setState((prev) => ({ ...prev, agentExpanded: expanded }));
  }, []);

  const setQuickExpanded = useCallback((expanded: boolean) => {
    setState((prev) => ({ ...prev, quickExpanded: expanded }));
  }, []);

  const setProjectExpanded = useCallback((projectId: string, expanded: boolean) => {
    setState((prev) => ({
      ...prev,
      projectStates: { ...prev.projectStates, [projectId]: expanded },
    }));
  }, []);

  const getProjectExpanded = useCallback((projectId: string): boolean => {
    return state.projectStates[projectId] ?? true;
  }, [state.projectStates]);

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
