import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject } from "react";
import Graph from "graphology";
import "@react-sigma/core/lib/style.css";
import {
  SigmaContainer,
  useLoadGraph,
  useRegisterEvents,
  useSetSettings,
  useSigma,
} from "@react-sigma/core";
import { useWorkerLayoutForceAtlas2 } from "@react-sigma/layout-forceatlas2";
import forceAtlas2 from "graphology-layout-forceatlas2";
import type { NodeHoverDrawingFunction } from "sigma/rendering";
import type { Settings } from "sigma/settings";
import type { EdgeDisplayData, NodeDisplayData } from "sigma/types";
import { fetchMemoryGraph, fetchUserUIState, saveUserUIState, type MemoryGraphSettings } from "../api/client";
import type { MemoryGraphData, MemoryGraphLink, MemoryGraphNode, MemoryGraphScope } from "../types";
import { Dropdown } from "./ui/Dropdown";
import { useDropdown } from "../hooks/useDropdown";
import { readStoredValue, writeStoredValue } from "../lib/storage";

const MEMORY_CATEGORIES = ["preference", "fact", "behavior", "instruction", "context", "decision", "note", "reflection"] as const;
const MEMORY_GRAPH_CATEGORIES = ["all", ...MEMORY_CATEGORIES] as const;
const MEMORY_GRAPH_SCOPES = ["all", "global", "project"] as const;
const MEMORY_GRAPH_NEIGHBOR_OPTIONS = [3, 4, 6, 8, 10, 12] as const;
const MEMORY_GRAPH_LIMIT_OPTIONS = [250, 500, 750, 1000, 1500, 2000, 2500] as const;
const MEMORY_GRAPH_SETTINGS_STORAGE_KEY = "porrima-memory-graph-settings";
const MIN_SIMILARITY = 0.5;
const MAX_SIMILARITY = 0.95;
const DEFAULT_MEMORY_GRAPH_SETTINGS: MemoryGraphSettings = {
  category: "all",
  scope: "all",
  includeSuperseded: false,
  minSimilarity: 0.9,
  neighbors: 6,
  limit: 500,
  searchQuery: "",
};

const CATEGORY_COLORS: Record<string, string> = {
  preference: "#a78bfa",
  fact: "#60a5fa",
  behavior: "#f59e0b",
  instruction: "#34d399",
  context: "#22d3ee",
  decision: "#fb7185",
  note: "#94a3b8",
  reflection: "#818cf8",
};

const SIGMA_SETTINGS: Partial<Settings<MemorySigmaNodeAttributes, MemorySigmaEdgeAttributes>> = {
  autoCenter: true,
  autoRescale: true,
  defaultEdgeColor: "#334155",
  defaultDrawNodeHover: drawMemoryNodeHover,
  defaultNodeColor: "#94a3b8",
  defaultEdgeType: "line",
  defaultNodeType: "circle",
  enableEdgeEvents: false,
  hideEdgesOnMove: true,
  hideLabelsOnMove: true,
  itemSizesReference: "positions",
  labelColor: { color: "#dbeafe" },
  labelDensity: 0.08,
  labelGridCellSize: 96,
  labelRenderedSizeThreshold: 8,
  labelSize: 11,
  maxCameraRatio: 8,
  minEdgeThickness: 0.35,
  minCameraRatio: 0.03,
  renderLabels: true,
  zIndex: true,
};

const SIGMA_CONTAINER_STYLE = {
  "--sigma-background-color": "#18181b",
  backgroundColor: "#18181b",
  height: "100%",
  width: "100%",
} as CSSProperties;

type MemoryNodePosition = { x: number; y: number };

type MemorySigmaNodeAttributes = {
  x: number;
  y: number;
  size: number;
  label: string;
  color: string;
  category: string;
  clusterId: string;
  hasEmbedding: boolean;
  importance: number;
  memoryId: string;
  projectId?: string;
  text: string;
};

type MemorySigmaEdgeAttributes = {
  color: string;
  relationType: MemoryGraphLink["type"];
  size: number;
  similarity: number;
  sourceId: string;
  targetId: string;
  weight: number;
};

type LocalMemoryGraphSettingsLoad = {
  settings: MemoryGraphSettings;
  hasStoredValue: boolean;
};

function loadLocalMemoryGraphSettings(): LocalMemoryGraphSettingsLoad {
  try {
    const stored = readStoredValue(MEMORY_GRAPH_SETTINGS_STORAGE_KEY);
    if (stored) {
      return {
        settings: normalizeMemoryGraphSettings(JSON.parse(stored)),
        hasStoredValue: true,
      };
    }
  } catch (err) {
    console.warn("Failed to load memory graph settings from localStorage:", err);
  }

  return {
    settings: DEFAULT_MEMORY_GRAPH_SETTINGS,
    hasStoredValue: false,
  };
}

function saveLocalMemoryGraphSettings(settings: MemoryGraphSettings) {
  try {
    writeStoredValue(MEMORY_GRAPH_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch (err) {
    console.warn("Failed to save memory graph settings to localStorage:", err);
  }
}

function normalizeMemoryGraphSettings(value: unknown): MemoryGraphSettings {
  const settings = isRecord(value) ? value : {};

  return {
    category: isMemoryGraphCategory(settings.category)
      ? settings.category
      : DEFAULT_MEMORY_GRAPH_SETTINGS.category,
    scope: isMemoryGraphScope(settings.scope)
      ? settings.scope
      : DEFAULT_MEMORY_GRAPH_SETTINGS.scope,
    includeSuperseded: typeof settings.includeSuperseded === "boolean"
      ? settings.includeSuperseded
      : DEFAULT_MEMORY_GRAPH_SETTINGS.includeSuperseded,
    minSimilarity: clampPersistedNumber(
      settings.minSimilarity,
      MIN_SIMILARITY,
      MAX_SIMILARITY,
      DEFAULT_MEMORY_GRAPH_SETTINGS.minSimilarity
    ),
    neighbors: nearestPersistedOption(
      settings.neighbors,
      MEMORY_GRAPH_NEIGHBOR_OPTIONS,
      DEFAULT_MEMORY_GRAPH_SETTINGS.neighbors
    ),
    limit: nearestPersistedOption(
      settings.limit,
      MEMORY_GRAPH_LIMIT_OPTIONS,
      DEFAULT_MEMORY_GRAPH_SETTINGS.limit
    ),
    searchQuery: typeof settings.searchQuery === "string"
      ? settings.searchQuery.slice(0, 300)
      : DEFAULT_MEMORY_GRAPH_SETTINGS.searchQuery,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isMemoryGraphCategory(value: unknown): value is MemoryGraphSettings["category"] {
  return typeof value === "string" && MEMORY_GRAPH_CATEGORIES.includes(value as MemoryGraphSettings["category"]);
}

function isMemoryGraphScope(value: unknown): value is MemoryGraphScope {
  return typeof value === "string" && MEMORY_GRAPH_SCOPES.includes(value as MemoryGraphScope);
}

function clampPersistedNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function nearestPersistedOption(
  value: unknown,
  options: readonly number[],
  fallback: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return options.reduce((nearest, option) => (
    Math.abs(option - value) < Math.abs(nearest - value) ? option : nearest
  ), fallback);
}

export default function MemoryGraphView() {
  const [initialGraphSettings] = useState(loadLocalMemoryGraphSettings);
  const [graphSettings, setGraphSettings] = useState<MemoryGraphSettings>(initialGraphSettings.settings);
  const [settingsLoaded, setSettingsLoaded] = useState(initialGraphSettings.hasStoredValue);
  const [uiStateSynced, setUiStateSynced] = useState(false);
  const [graph, setGraph] = useState<MemoryGraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const scopeDd = useDropdown();
  const neighborsDd = useDropdown();
  const limitDd = useDropdown();
  const positionsRef = useRef<Map<string, MemoryNodePosition>>(new Map());
  const settingsTouchedRef = useRef(false);
  const { category, scope, includeSuperseded, minSimilarity, neighbors, limit, searchQuery } = graphSettings;

  const updateGraphSettings = useCallback((patch: Partial<MemoryGraphSettings>) => {
    settingsTouchedRef.current = true;
    setGraphSettings((current) => normalizeMemoryGraphSettings({ ...current, ...patch }));
  }, []);

  useEffect(() => {
    let cancelled = false;

    fetchUserUIState()
      .then((state) => {
        if (cancelled) return;
        if (state.memoryGraphSettings && !settingsTouchedRef.current) {
          setGraphSettings(normalizeMemoryGraphSettings(state.memoryGraphSettings));
        }
        setSettingsLoaded(true);
        setUiStateSynced(true);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("Failed to load memory graph settings from server, using localStorage:", err);
        setSettingsLoaded(true);
        setUiStateSynced(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!uiStateSynced) return;

    saveLocalMemoryGraphSettings(graphSettings);

    const timer = window.setTimeout(() => {
      saveUserUIState({ memoryGraphSettings: graphSettings }).catch((err) => {
        console.warn("Failed to save memory graph settings to server:", err);
      });
    }, 500);

    return () => window.clearTimeout(timer);
  }, [graphSettings, uiStateSynced]);

  const loadGraph = useCallback(() => {
    if (!settingsLoaded) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchMemoryGraph({
      category,
      scope,
      includeSuperseded,
      minSimilarity,
      neighbors,
      limit,
      q: searchQuery,
    })
      .then((data) => {
        if (cancelled) return;
        setGraph(data);
        setSelectedId((id) => (id && data.nodes.some((node) => node.id === id) ? id : null));
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || "Failed to load memory graph");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [category, includeSuperseded, limit, minSimilarity, neighbors, scope, searchQuery, settingsLoaded]);

  useEffect(() => {
    if (!settingsLoaded) return;
    let cleanup: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      cleanup = loadGraph();
    }, 300);

    return () => {
      window.clearTimeout(timer);
      cleanup?.();
    };
  }, [loadGraph, settingsLoaded]);

  const selectedNode = useMemo(
    () => graph?.nodes.find((node) => node.id === selectedId) || null,
    [graph, selectedId]
  );
  const viewportMode = isFullscreen ? "fullscreen" : "modal";
  const rootClassName = isFullscreen
    ? "fixed inset-0 z-[10000] flex flex-col gap-3 overflow-hidden bg-zinc-900 p-4 sm:p-5"
    : "min-h-full space-y-3 p-4";
  const graphGridClassName = isFullscreen
    ? "grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_320px]"
    : "grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_300px] gap-3";
  const graphPanelClassName = isFullscreen
    ? "relative h-full min-h-0 rounded-lg border border-white/10 bg-zinc-900 overflow-hidden"
    : "relative min-h-[520px] rounded-lg border border-white/10 bg-zinc-900 overflow-hidden";

  useEffect(() => {
    if (!isFullscreen) return;
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsFullscreen(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isFullscreen]);

  return (
    <div className={rootClassName}>
      <div className="flex min-w-0 shrink-0 flex-col gap-2 sm:flex-row sm:items-start">
        <div className="-mx-4 min-w-0 overflow-x-auto px-4 pb-1 custom-scrollbar sm:mx-0 sm:flex-1 sm:px-0">
          <div className="flex w-max gap-1 sm:w-auto sm:flex-wrap">
            {MEMORY_GRAPH_CATEGORIES.map((cat) => (
              <button
                key={cat}
                onClick={() => updateGraphSettings({ category: cat })}
                className={`shrink-0 px-2 py-0.5 rounded-full text-[10px] font-medium transition-all ${
                  category === cat
                    ? "bg-purple-500/30 text-purple-200 border border-purple-400/30"
                    : "bg-white/5 text-white/40 border border-white/10 hover:bg-white/10"
                }`}
              >
                {cat === "all" ? "All" : cat}
              </button>
            ))}
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2 sm:ml-auto sm:justify-end">
          <Dropdown
            state={scopeDd}
            triggerClassName="flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-lg px-2 py-0.5 text-[10px] text-white/60 outline-none hover:bg-white/10 transition-all cursor-pointer shrink-0"
            trigger={<span className="truncate flex-1 text-left">{scope === "all" ? "All scopes" : scope === "global" ? "Global" : "Project"}</span>}
          >
            {MEMORY_GRAPH_SCOPES.map((value) => (
              <button key={value} onClick={() => { scopeDd.close(); updateGraphSettings({ scope: value }); }}
                className={`w-full text-left px-3 py-2 text-[10px] transition-all ${value === scope ? "text-white" : "text-white/60 hover:bg-white/10"}`}>
                {value === "all" ? "All scopes" : value === "global" ? "Global" : "Project"}
              </button>
            ))}
          </Dropdown>
          <label className="flex shrink-0 items-center gap-1.5 text-[10px] text-white/50">
            <input
              type="checkbox"
              checked={includeSuperseded}
              onChange={(event) => updateGraphSettings({ includeSuperseded: event.target.checked })}
              className="accent-purple-400"
            />
            Superseded
          </label>
          <button
            onClick={loadGraph}
            disabled={loading}
            className="shrink-0 px-2.5 py-1 rounded-lg bg-white/5 border border-white/10 text-[10px] text-white/60 hover:bg-white/10 hover:text-white/80 transition-all disabled:opacity-50"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setIsFullscreen((value) => !value)}
            aria-label={isFullscreen ? "Exit fullscreen memory graph" : "Open fullscreen memory graph"}
            title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            className="w-7 h-7 flex shrink-0 items-center justify-center rounded-lg bg-white/5 border border-white/10 text-white/60 hover:bg-white/10 hover:text-white/85 transition-all"
          >
            {isFullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 shrink-0">
        <label className="flex items-center gap-2 text-[10px] text-white/45">
          Similarity
          <input
            type="range"
            min="0.5"
            max="0.95"
            step="0.01"
            value={minSimilarity}
            onChange={(event) => updateGraphSettings({ minSimilarity: Number(event.target.value) })}
            className="w-28 accent-purple-400"
          />
          <span className="text-white/60 tabular-nums">{minSimilarity.toFixed(2)}</span>
        </label>
        <label className="flex items-center gap-2 text-[10px] text-white/45">
          Neighbors
          <Dropdown
            state={neighborsDd}
            triggerClassName="flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-lg px-2 py-0.5 text-[10px] text-white/60 outline-none hover:bg-white/10 transition-all cursor-pointer shrink-0"
            trigger={<span className="truncate flex-1 text-left">{neighbors}</span>}
          >
            {MEMORY_GRAPH_NEIGHBOR_OPTIONS.map((value) => (
              <button key={value} onClick={() => { neighborsDd.close(); updateGraphSettings({ neighbors: value }); }}
                className={`w-full text-left px-3 py-2 text-[10px] transition-all ${value === neighbors ? "text-white" : "text-white/60 hover:bg-white/10"}`}>
                {value}
              </button>
            ))}
          </Dropdown>
        </label>
        <label className="flex items-center gap-2 text-[10px] text-white/45">
          Limit
          <Dropdown
            state={limitDd}
            triggerClassName="flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-lg px-2 py-0.5 text-[10px] text-white/60 outline-none hover:bg-white/10 transition-all cursor-pointer shrink-0"
            trigger={<span className="truncate flex-1 text-left">{limit}</span>}
          >
            {MEMORY_GRAPH_LIMIT_OPTIONS.map((value) => (
              <button key={value} onClick={() => { limitDd.close(); updateGraphSettings({ limit: value }); }}
                className={`w-full text-left px-3 py-2 text-[10px] transition-all ${value === limit ? "text-white" : "text-white/60 hover:bg-white/10"}`}>
                {value}
              </button>
            ))}
          </Dropdown>
        </label>
        <div className="relative w-full min-w-0 sm:ml-auto sm:w-auto sm:min-w-[220px]">
          <input
            type="text"
            value={searchQuery}
            onChange={(event) => updateGraphSettings({ searchQuery: event.target.value })}
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-purple-400/30 focus:border-purple-400/30"
            placeholder="Search memories..."
          />
        </div>
      </div>

      {graph && (
        <div className="flex flex-wrap items-center gap-4 text-[10px] text-white/35 shrink-0">
          <span><span className="text-white/60">{graph.stats.shown}</span> / {graph.stats.total} memories</span>
          <span><span className="text-white/60">{graph.clusters.length}</span> clusters</span>
          <span><span className="text-white/60">{graph.stats.semanticLinks}</span> semantic links</span>
          <span><span className="text-white/60">{graph.stats.embedded}</span> embedded</span>
          <span>
            <span className="text-white/60">{graph.stats.edgeSource}</span>
            {graph.stats.edgeSource !== "pairwise" && (
              <> {Math.round(graph.stats.edgeCacheCoverage * 100)}% cached</>
            )}
          </span>
          {graph.stats.edgeCacheRefreshed > 0 && (
            <span className="text-emerald-300/60">refreshed {graph.stats.edgeCacheRefreshed}</span>
          )}
          {graph.stats.mode === "focused" && graph.stats.query && (
            <span className="text-purple-200/60">focused: {graph.stats.query}</span>
          )}
          {graph.stats.capped && <span className="text-amber-300/60">capped at {graph.stats.limit}</span>}
        </div>
      )}

      <div className={graphGridClassName}>
        <div className={graphPanelClassName}>
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-white/35 z-10">
              Loading graph...
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-red-300/70 z-10">
              {error}
            </div>
          )}
          {graph && !error && (
            <MemoryGraphCanvas
              graph={graph}
              viewportMode={viewportMode}
              selectedId={selectedId}
              searchQuery={searchQuery}
              onSelect={setSelectedId}
              positionsRef={positionsRef}
            />
          )}
        </div>
        <MemoryGraphDetails node={selectedNode} graph={graph} fullscreen={isFullscreen} />
      </div>
    </div>
  );
}

function MemoryGraphCanvas({
  graph,
  viewportMode,
  selectedId,
  searchQuery,
  onSelect,
  positionsRef,
}: {
  graph: MemoryGraphData;
  viewportMode: "modal" | "fullscreen";
  selectedId: string | null;
  searchQuery: string;
  onSelect: (id: string | null) => void;
  positionsRef: MutableRefObject<Map<string, MemoryNodePosition>>;
}) {
  const graphology = useMemo(
    () => buildSigmaGraph(graph, positionsRef.current),
    [graph, positionsRef]
  );

  return (
    <SigmaContainer<MemorySigmaNodeAttributes, MemorySigmaEdgeAttributes>
      className="absolute inset-0 memory-graph-sigma"
      settings={SIGMA_SETTINGS}
      style={SIGMA_CONTAINER_STYLE}
    >
      <MemorySigmaController
        graphData={graph}
        graphology={graphology}
        viewportMode={viewportMode}
        selectedId={selectedId}
        searchQuery={searchQuery}
        onSelect={onSelect}
        positionsRef={positionsRef}
      />
    </SigmaContainer>
  );
}

function MemorySigmaController({
  graphData,
  graphology,
  viewportMode,
  selectedId,
  searchQuery,
  onSelect,
  positionsRef,
}: {
  graphData: MemoryGraphData;
  graphology: Graph<MemorySigmaNodeAttributes, MemorySigmaEdgeAttributes>;
  viewportMode: "modal" | "fullscreen";
  selectedId: string | null;
  searchQuery: string;
  onSelect: (id: string | null) => void;
  positionsRef: MutableRefObject<Map<string, MemoryNodePosition>>;
}) {
  const sigma = useSigma<MemorySigmaNodeAttributes, MemorySigmaEdgeAttributes>();
  const loadGraph = useLoadGraph<MemorySigmaNodeAttributes, MemorySigmaEdgeAttributes>();
  const registerEvents = useRegisterEvents<MemorySigmaNodeAttributes, MemorySigmaEdgeAttributes>();
  const setSettings = useSetSettings<MemorySigmaNodeAttributes, MemorySigmaEdgeAttributes>();
  const draggedNodeRef = useRef<string | null>(null);
  const layoutSettings = useMemo(
    () => ({
      getEdgeWeight: "weight" as const,
      settings: {
        barnesHutOptimize: graphData.nodes.length > 600,
        barnesHutTheta: 0.6,
        edgeWeightInfluence: 0.6,
        gravity: graphData.nodes.length > 1200 ? 0.35 : 0.55,
        scalingRatio: graphData.nodes.length > 1200 ? 18 : 12,
        slowDown: graphData.nodes.length > 1200 ? 9 : 6,
        strongGravityMode: false,
      },
    }),
    [graphData.nodes.length]
  );
  const layout = useWorkerLayoutForceAtlas2(layoutSettings);
  const { start: startLayout, stop: stopLayout } = layout;
  const loadKey = `${graphData.stats.mode}:${graphData.stats.query || ""}:${graphData.stats.shown}:${graphData.links.length}:${graphData.stats.minSimilarity}:${graphData.stats.neighbors}`;
  const query = searchQuery.trim().toLowerCase();
  const matchingNodeIds = useMemo(() => {
    if (!query) return new Set<string>();
    return new Set(
      graphData.nodes
        .filter((node) => matchesQuery(node, query))
        .map((node) => node.id)
    );
  }, [graphData.nodes, query]);

  useEffect(() => {
    pruneSavedPositions(positionsRef.current, graphology);
    persistGraphPositions(graphology, positionsRef.current);
    seedLayout(graphology, graphData.nodes.length);
    repairGraphPositions(graphology, positionsRef.current);
    persistGraphPositions(graphology, positionsRef.current);
    loadGraph(graphology, true);
    sigma.refresh();
  }, [graphData.nodes.length, graphology, loadGraph, loadKey, positionsRef, sigma]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      sigma.resize(true);
      sigma.refresh();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [sigma, viewportMode]);

  useEffect(() => {
    registerEvents({
      clickNode: ({ node }) => onSelect(node),
      clickStage: () => onSelect(null),
      downNode: ({ node, preventSigmaDefault }) => {
        draggedNodeRef.current = node;
        preventSigmaDefault();
        setSettings({ enableCameraPanning: false });
      },
      mouseleave: () => {
        if (!draggedNodeRef.current) return;
        draggedNodeRef.current = null;
        setSettings({ enableCameraPanning: true });
      },
      mousemovebody: (event) => {
        const node = draggedNodeRef.current;
        if (!node) return;
        const activeGraph = sigma.getGraph();
        if (!activeGraph.hasNode(node)) return;
        const position = sigma.viewportToGraph(event);
        activeGraph.setNodeAttribute(node, "x", position.x);
        activeGraph.setNodeAttribute(node, "y", position.y);
        positionsRef.current.set(node, position);
        sigma.refresh({ partialGraph: { nodes: [node] }, schedule: true });
      },
      mouseup: () => {
        if (!draggedNodeRef.current) return;
        draggedNodeRef.current = null;
        setSettings({ enableCameraPanning: true });
      },
    });
  }, [onSelect, positionsRef, registerEvents, setSettings, sigma]);

  useEffect(() => {
    const dimNonMatches = Boolean(query) && graphData.stats.mode !== "focused";
    setSettings({
      edgeReducer: (_edge, data): Partial<EdgeDisplayData> => {
        const connectedToSelection = Boolean(
          selectedId && (data.sourceId === selectedId || data.targetId === selectedId)
        );
        const connectedToMatch = Boolean(
          query && (matchingNodeIds.has(data.sourceId) || matchingNodeIds.has(data.targetId))
        );
        return {
          ...data,
          color: connectedToSelection
            ? data.relationType === "lineage" ? "#facc15" : "#a78bfa"
            : data.color,
          hidden: dimNonMatches && !connectedToMatch,
          size: connectedToSelection ? Math.max(1.1, data.size + 0.45) : data.size,
          zIndex: connectedToSelection ? 2 : 0,
        };
      },
      nodeReducer: (_node, data): Partial<NodeDisplayData> => {
        const selected = data.memoryId === selectedId;
        const matched = query ? matchesQuery(data, query) : false;
        const dimmed = dimNonMatches && !matched;
        return {
          ...data,
          color: dimmed ? "#334155" : data.color,
          forceLabel: selected || matched,
          highlighted: selected,
          label: selected || matched || data.importance >= 8 ? data.label : "",
          size: selected ? data.size + 2.2 : matched ? data.size + 1.2 : data.size,
          zIndex: selected ? 4 : matched ? 3 : data.importance,
        };
      },
    });
    sigma.refresh();
  }, [graphData.stats.mode, matchingNodeIds, query, selectedId, setSettings, sigma]);

  useEffect(() => {
    startLayout();
    const positionTimer = window.setInterval(() => {
      persistGraphPositions(sigma.getGraph(), positionsRef.current);
    }, 700);
    const stopTimer = window.setTimeout(() => {
      stopLayout();
      persistGraphPositions(sigma.getGraph(), positionsRef.current);
    }, graphData.nodes.length > 1200 ? 3600 : 2400);

    return () => {
      window.clearInterval(positionTimer);
      window.clearTimeout(stopTimer);
      stopLayout();
      persistGraphPositions(sigma.getGraph(), positionsRef.current);
    };
  }, [graphData.nodes.length, graphology, loadKey, positionsRef, sigma, startLayout, stopLayout]);

  return null;
}

function buildSigmaGraph(
  data: MemoryGraphData,
  savedPositions: Map<string, MemoryNodePosition>
): Graph<MemorySigmaNodeAttributes, MemorySigmaEdgeAttributes> {
  const sigmaGraph = new Graph<MemorySigmaNodeAttributes, MemorySigmaEdgeAttributes>({
    allowSelfLoops: false,
    type: "undirected",
  });
  const clusterSize = new Map(data.clusters.map((cluster) => [cluster.id, cluster.size]));
  const clusterIndex = new Map(data.clusters.map((cluster, index) => [cluster.id, index]));
  const clusterCount = Math.max(1, data.clusters.length);

  for (const node of data.nodes) {
    const savedPosition = savedPositions.get(node.id);
    const position = isFinitePosition(savedPosition)
      ? savedPosition
      : initialNodePosition(node, clusterIndex, clusterCount);
    sigmaGraph.addNode(node.id, {
      x: position.x,
      y: position.y,
      size: nodeRadius(node, clusterSize.get(node.clusterId) || 1),
      label: memoryLabel(node.text),
      color: CATEGORY_COLORS[node.category] || "#cbd5e1",
      category: node.category,
      clusterId: node.clusterId,
      hasEmbedding: node.hasEmbedding,
      importance: node.importance,
      memoryId: node.id,
      ...(node.projectId ? { projectId: node.projectId } : {}),
      text: node.text,
    });
  }

  const edgeMap = new Map<string, {
    source: string;
    target: string;
    attributes: MemorySigmaEdgeAttributes;
  }>();

  for (const link of data.links) {
    if (!sigmaGraph.hasNode(link.source) || !sigmaGraph.hasNode(link.target) || link.source === link.target) {
      continue;
    }
    const [source, target] = sortEdgeNodes(link.source, link.target);
    const key = edgePairKey(source, target);
    const incoming = edgeAttributes(link, source, target);
    const existing = edgeMap.get(key);

    if (existing) {
      existing.attributes = mergeEdgeAttributes(existing.attributes, incoming);
    } else {
      edgeMap.set(key, { source, target, attributes: incoming });
    }
  }

  for (const [key, edge] of edgeMap.entries()) {
    sigmaGraph.addEdgeWithKey(key, edge.source, edge.target, edge.attributes);
  }

  return sigmaGraph;
}

function sortEdgeNodes(source: string, target: string): [string, string] {
  return source < target ? [source, target] : [target, source];
}

function edgePairKey(source: string, target: string): string {
  return `${source}:${target}`;
}

function edgeAttributes(
  link: MemoryGraphLink,
  source: string,
  target: string
): MemorySigmaEdgeAttributes {
  const weight = edgeWeight(link);
  return {
    color: edgeColor(link.type),
    relationType: link.type,
    size: edgeSize(link.type, weight),
    similarity: link.similarity,
    sourceId: source,
    targetId: target,
    weight,
  };
}

function mergeEdgeAttributes(
  current: MemorySigmaEdgeAttributes,
  incoming: MemorySigmaEdgeAttributes
): MemorySigmaEdgeAttributes {
  const relationType = current.relationType === "lineage" || incoming.relationType === "lineage"
    ? "lineage"
    : "semantic";
  const weight = Math.max(current.weight, incoming.weight);

  return {
    ...current,
    color: edgeColor(relationType),
    relationType,
    size: Math.max(current.size, incoming.size, edgeSize(relationType, weight)),
    similarity: Math.max(current.similarity, incoming.similarity),
    weight,
  };
}

function edgeWeight(link: MemoryGraphLink): number {
  return link.type === "lineage"
    ? 0.35
    : Math.max(0.08, Math.min(1, (link.similarity - 0.5) * 2));
}

function edgeColor(type: MemoryGraphLink["type"]): string {
  return type === "lineage" ? "rgba(245, 158, 11, 0.7)" : "rgba(100, 116, 139, 0.14)";
}

function edgeSize(type: MemoryGraphLink["type"], weight: number): number {
  return type === "lineage" ? 0.95 : Math.max(0.15, weight * 0.45);
}

function seedLayout(
  graph: Graph<MemorySigmaNodeAttributes, MemorySigmaEdgeAttributes>,
  nodeCount: number
) {
  if (graph.order < 2) return;
  if (nodeCount > 800) return;
  const iterations = nodeCount > 500 ? 14 : 28;
  forceAtlas2.assign(graph, {
    getEdgeWeight: "weight",
    iterations,
    settings: {
      barnesHutOptimize: nodeCount > 600,
      barnesHutTheta: 0.6,
      edgeWeightInfluence: 0.6,
      gravity: 0.55,
      scalingRatio: 12,
      slowDown: 6,
      strongGravityMode: false,
    },
  });
}

function pruneSavedPositions(
  savedPositions: Map<string, MemoryNodePosition>,
  graph: Graph<MemorySigmaNodeAttributes, MemorySigmaEdgeAttributes>
) {
  for (const id of savedPositions.keys()) {
    if (!graph.hasNode(id)) savedPositions.delete(id);
  }
}

function persistGraphPositions(
  graph: Graph<MemorySigmaNodeAttributes, MemorySigmaEdgeAttributes>,
  savedPositions: Map<string, MemoryNodePosition>
) {
  graph.forEachNode((id, attributes) => {
    if (Number.isFinite(attributes.x) && Number.isFinite(attributes.y)) {
      savedPositions.set(id, { x: attributes.x, y: attributes.y });
    }
  });
}

function repairGraphPositions(
  graph: Graph<MemorySigmaNodeAttributes, MemorySigmaEdgeAttributes>,
  savedPositions: Map<string, MemoryNodePosition>
) {
  graph.forEachNode((id, attributes) => {
    if (Number.isFinite(attributes.x) && Number.isFinite(attributes.y)) return;
    const savedPosition = savedPositions.get(id);
    const position = isFinitePosition(savedPosition)
      ? savedPosition
      : fallbackNodePosition(id);
    graph.mergeNodeAttributes(id, position);
    savedPositions.set(id, position);
  });
}

function isFinitePosition(position: MemoryNodePosition | undefined): position is MemoryNodePosition {
  return Boolean(position && Number.isFinite(position.x) && Number.isFinite(position.y));
}

function initialNodePosition(
  node: MemoryGraphNode,
  clusterIndex: Map<string, number>,
  clusterCount: number
): MemoryNodePosition {
  const index = clusterIndex.get(node.clusterId) ?? 0;
  const clusterAngle = (index / clusterCount) * Math.PI * 2;
  const clusterRadius = 24 + Math.sqrt(index + 1) * 20;
  const jitterAngle = hashUnit(`${node.id}:angle`) * Math.PI * 2;
  const jitterRadius = 8 + hashUnit(`${node.id}:radius`) * 30;
  return {
    x: Math.cos(clusterAngle) * clusterRadius + Math.cos(jitterAngle) * jitterRadius,
    y: Math.sin(clusterAngle) * clusterRadius + Math.sin(jitterAngle) * jitterRadius,
  };
}

function fallbackNodePosition(id: string): MemoryNodePosition {
  const angle = hashUnit(`${id}:fallback-angle`) * Math.PI * 2;
  const radius = 16 + hashUnit(`${id}:fallback-radius`) * 48;
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
  };
}

function hashUnit(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function memoryLabel(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 90 ? `${compact.slice(0, 87)}...` : compact;
}

function MemoryGraphDetails({
  node,
  graph,
  fullscreen = false,
}: {
  node: MemoryGraphNode | null;
  graph: MemoryGraphData | null;
  fullscreen?: boolean;
}) {
  const className = fullscreen
    ? "h-full min-h-0 overflow-y-auto rounded-lg border border-white/10 bg-zinc-900 p-3 text-xs text-white/30"
    : "min-h-[180px] rounded-lg border border-white/10 bg-zinc-900 p-3 text-xs text-white/30";

  if (!node || !graph) {
    return (
      <div className={className}>
        No memory selected
      </div>
    );
  }

  const cluster = graph.clusters.find((item) => item.id === node.clusterId);
  const semanticLinks = graph.links.filter(
    (link) => link.type === "semantic" && (link.source === node.id || link.target === node.id)
  );
  const lineageLinks = graph.links.filter(
    (link) => link.type === "lineage" && (link.source === node.id || link.target === node.id)
  );

  return (
    <div className={`${fullscreen ? "h-full min-h-0 overflow-y-auto" : "min-h-[300px]"} rounded-lg border border-white/10 bg-zinc-900 p-3 space-y-3`}>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="px-1.5 py-0.5 rounded text-[9px] font-medium" style={{
            color: CATEGORY_COLORS[node.category] || "#cbd5e1",
            backgroundColor: "rgba(255,255,255,0.06)",
          }}>
            {node.category}
          </span>
          <span className="text-[10px] text-white/30">importance {node.importance}/10</span>
          {node.supersededBy && <span className="text-[9px] text-amber-300/70">superseded</span>}
        </div>
        <p className="text-xs text-white/75 leading-relaxed whitespace-pre-wrap">{node.text}</p>
      </div>

      <div className="grid grid-cols-2 gap-2 text-[10px] text-white/35">
        <div>
          <div className="text-white/20">Created</div>
          <div className="text-white/55">{new Date(node.createdAt).toLocaleDateString()}</div>
        </div>
        <div>
          <div className="text-white/20">Accesses</div>
          <div className="text-white/55">{node.accessCount}</div>
        </div>
        <div>
          <div className="text-white/20">Cluster</div>
          <div className="text-white/55">{cluster ? `${cluster.size} memories` : node.clusterId}</div>
        </div>
        <div>
          <div className="text-white/20">Links</div>
          <div className="text-white/55">{semanticLinks.length} semantic · {lineageLinks.length} lineage</div>
        </div>
      </div>

      {cluster && (
        <div className="space-y-1">
          <div className="text-[10px] text-white/25">Category mix</div>
          <div className="flex flex-wrap gap-1">
            {cluster.categoryMix.slice(0, 5).map(({ category, count }) => (
              <span key={category} className="px-1.5 py-0.5 rounded bg-white/5 text-[9px] text-white/45">
                {category} {count}
              </span>
            ))}
          </div>
        </div>
      )}

      {node.projectId && (
        <div className="text-[10px] text-white/30 break-all">
          <span className="text-white/20">Project </span>{node.projectId}
        </div>
      )}
    </div>
  );
}

function FullscreenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 3 3 9M15 3l6 6M21 15l-6 6M3 15l6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ExitFullscreenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9 3v6H3M15 3v6h6M21 15h-6v6M3 15h6v6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="m3 9 6-6M21 9l-6-6M15 21l6-6M9 21l-6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function drawMemoryNodeHover(
  context: CanvasRenderingContext2D,
  data: Parameters<NodeHoverDrawingFunction<MemorySigmaNodeAttributes, MemorySigmaEdgeAttributes>>[1],
  settings: Settings<MemorySigmaNodeAttributes, MemorySigmaEdgeAttributes>
) {
  const label = data.label || "";
  const fontSize = settings.labelSize;
  const font = `${settings.labelWeight} ${fontSize}px ${settings.labelFont}`;
  const paddingX = 8;
  const paddingY = 5;
  const gap = 8;
  const radius = Math.max(4, data.size);

  context.save();
  context.beginPath();
  context.arc(data.x, data.y, radius + 2, 0, Math.PI * 2);
  context.fillStyle = "#0f172a";
  context.fill();
  context.lineWidth = 1.5;
  context.strokeStyle = "#e2e8f0";
  context.stroke();

  if (label) {
    context.font = font;
    const textWidth = context.measureText(label).width;
    const boxWidth = textWidth + paddingX * 2;
    const boxHeight = fontSize + paddingY * 2;
    const boxX = data.x + radius + gap;
    const boxY = data.y - boxHeight / 2;

    drawRoundedRect(context, boxX, boxY, boxWidth, boxHeight, 6);
    context.fillStyle = "#18181b";
    context.fill();
    context.lineWidth = 1;
    context.strokeStyle = "rgba(255, 255, 255, 0.18)";
    context.stroke();

    context.fillStyle = "#e5e7eb";
    context.textBaseline = "middle";
    context.fillText(label, boxX + paddingX, data.y);
  }

  context.restore();
}

function drawRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  const clampedRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + clampedRadius, y);
  context.lineTo(x + width - clampedRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + clampedRadius);
  context.lineTo(x + width, y + height - clampedRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - clampedRadius, y + height);
  context.lineTo(x + clampedRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - clampedRadius);
  context.lineTo(x, y + clampedRadius);
  context.quadraticCurveTo(x, y, x + clampedRadius, y);
  context.closePath();
}

function nodeRadius(node: MemoryGraphNode, clusterSize: number): number {
  return Math.min(18, 5.5 + node.importance * 0.55 + Math.log2(clusterSize + 1) * 0.95);
}

function matchesQuery(
  node: { text: string; category: string; projectId?: string },
  query: string
): boolean {
  if (!query) return false;
  return (
    node.text.toLowerCase().includes(query) ||
    node.category.toLowerCase().includes(query) ||
    node.projectId?.toLowerCase().includes(query) ||
    false
  );
}
