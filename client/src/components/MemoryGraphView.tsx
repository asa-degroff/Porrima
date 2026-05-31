import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchMemoryGraph } from "../api/client";
import type { MemoryGraphData, MemoryGraphNode, MemoryGraphScope } from "../types";

const MEMORY_CATEGORIES = ["preference", "fact", "behavior", "instruction", "context", "decision", "note", "reflection"];

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

export default function MemoryGraphView() {
  const [graph, setGraph] = useState<MemoryGraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [d3Ready, setD3Ready] = useState(false);
  const [d3Module, setD3Module] = useState<any | null>(null);
  const [category, setCategory] = useState("all");
  const [scope, setScope] = useState<MemoryGraphScope>("all");
  const [includeSuperseded, setIncludeSuperseded] = useState(false);
  const [minSimilarity, setMinSimilarity] = useState(0.9);
  const [neighbors, setNeighbors] = useState(6);
  const [limit, setLimit] = useState(500);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    import("d3")
      .then((module) => {
        if (!cancelled) {
          setD3Module(module);
          setD3Ready(true);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || "Failed to load graph renderer");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadGraph = useCallback(() => {
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
  }, [category, includeSuperseded, limit, minSimilarity, neighbors, scope, searchQuery]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      cleanup = loadGraph();
    }, 300);

    return () => {
      window.clearTimeout(timer);
      cleanup?.();
    };
  }, [loadGraph]);

  const selectedNode = useMemo(
    () => graph?.nodes.find((node) => node.id === selectedId) || null,
    [graph, selectedId]
  );

  return (
    <div className="p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 flex-wrap">
          {["all", ...MEMORY_CATEGORIES].map((cat) => (
            <button
              key={cat}
              onClick={() => setCategory(cat)}
              className={`px-2 py-0.5 rounded-full text-[10px] font-medium transition-all ${
                category === cat
                  ? "bg-purple-500/30 text-purple-200 border border-purple-400/30"
                  : "bg-white/5 text-white/40 border border-white/10 hover:bg-white/10"
              }`}
            >
              {cat === "all" ? "All" : cat}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <select
            value={scope}
            onChange={(event) => setScope(event.target.value as MemoryGraphScope)}
            className="bg-white/5 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-white/60 outline-none"
          >
            <option value="all">All scopes</option>
            <option value="global">Global</option>
            <option value="project">Project</option>
          </select>
          <label className="flex items-center gap-1.5 text-[10px] text-white/50">
            <input
              type="checkbox"
              checked={includeSuperseded}
              onChange={(event) => setIncludeSuperseded(event.target.checked)}
              className="accent-purple-400"
            />
            Superseded
          </label>
          <button
            onClick={loadGraph}
            disabled={loading}
            className="px-2.5 py-1 rounded-lg bg-white/5 border border-white/10 text-[10px] text-white/60 hover:bg-white/10 hover:text-white/80 transition-all disabled:opacity-50"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[10px] text-white/45">
          Similarity
          <input
            type="range"
            min="0.5"
            max="0.95"
            step="0.01"
            value={minSimilarity}
            onChange={(event) => setMinSimilarity(Number(event.target.value))}
            className="w-28 accent-purple-400"
          />
          <span className="text-white/60 tabular-nums">{minSimilarity.toFixed(2)}</span>
        </label>
        <label className="flex items-center gap-2 text-[10px] text-white/45">
          Neighbors
          <select
            value={neighbors}
            onChange={(event) => setNeighbors(Number(event.target.value))}
            className="bg-white/5 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-white/60 outline-none"
          >
            {[3, 4, 6, 8, 10, 12].map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[10px] text-white/45">
          Limit
          <select
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value))}
            className="bg-white/5 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-white/60 outline-none"
          >
            {[250, 500, 750, 1000].map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        <div className="relative ml-auto min-w-[220px]">
          <input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-purple-400/30 focus:border-purple-400/30"
            placeholder="Search memories..."
          />
        </div>
      </div>

      {graph && (
        <div className="flex flex-wrap items-center gap-4 text-[10px] text-white/35">
          <span><span className="text-white/60">{graph.stats.shown}</span> / {graph.stats.total} memories</span>
          <span><span className="text-white/60">{graph.clusters.length}</span> clusters</span>
          <span><span className="text-white/60">{graph.stats.semanticLinks}</span> semantic links</span>
          <span><span className="text-white/60">{graph.stats.embedded}</span> embedded</span>
          {graph.stats.mode === "focused" && graph.stats.query && (
            <span className="text-purple-200/60">focused: {graph.stats.query}</span>
          )}
          {graph.stats.capped && <span className="text-amber-300/60">capped at {graph.stats.limit}</span>}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_300px] gap-3">
        <div className="relative min-h-[520px] rounded-lg border border-white/10 bg-black/20 overflow-hidden">
          {(loading || !d3Ready) && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-white/35 z-10">
              Loading graph...
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-red-300/70 z-10">
              {error}
            </div>
          )}
          {graph && d3Ready && !error && (
            <MemoryGraphCanvas
              graph={graph}
              selectedId={selectedId}
              searchQuery={searchQuery}
              d3={d3Module}
              onSelect={setSelectedId}
            />
          )}
        </div>
        <MemoryGraphDetails node={selectedNode} graph={graph} />
      </div>
    </div>
  );
}

function MemoryGraphCanvas({
  graph,
  selectedId,
  searchQuery,
  d3,
  onSelect,
}: {
  graph: MemoryGraphData;
  selectedId: string | null;
  searchQuery: string;
  d3: any;
  onSelect: (id: string | null) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const positionsRef = useRef<Map<string, { x: number; y: number; vx?: number; vy?: number }>>(new Map());

  useEffect(() => {
    const svgEl = svgRef.current;
    const wrapEl = wrapRef.current;
    if (!svgEl || !wrapEl || !d3) return;

    let simulation: any = null;

    const render = () => {
      simulation?.stop();
      const width = Math.max(320, wrapEl.clientWidth);
      const height = Math.max(420, wrapEl.clientHeight);
      const currentIds = new Set(graph.nodes.map((node) => node.id));
      for (const id of positionsRef.current.keys()) {
        if (!currentIds.has(id)) positionsRef.current.delete(id);
      }
      const nodes = graph.nodes.map((node) => {
        const position = positionsRef.current.get(node.id);
        return position ? { ...node, ...position } : { ...node };
      });
      const links = graph.links.map((link) => ({ ...link }));
      const clusterSize = new Map(graph.clusters.map((cluster) => [cluster.id, cluster.size]));

      d3.select(svgEl).selectAll("*").remove();
      const svg = d3.select(svgEl).attr("viewBox", `0 0 ${width} ${height}`);
      const initialTransform = d3.zoomTransform(svgEl);
      const g = svg.append("g").attr("transform", initialTransform);

      svg.on("click", () => onSelect(null));
      svg.call(
        d3.zoom()
          .scaleExtent([0.25, 4])
          .on("zoom", (event: any) => g.attr("transform", event.transform))
      );

      const link = g.append("g")
        .selectAll("line")
        .data(links)
        .join("line")
        .attr("stroke", (d: any) => d.type === "lineage" ? "rgba(251, 191, 36, 0.55)" : "rgba(148, 163, 184, 0.22)")
        .attr("stroke-width", (d: any) => d.type === "lineage" ? 1.5 : Math.max(0.5, (d.similarity - 0.5) * 2.5))
        .attr("stroke-dasharray", (d: any) => d.type === "lineage" ? "4 3" : null);

      const node = g.append("g")
        .selectAll("circle")
        .data(nodes)
        .join("circle")
        .attr("class", "memory-node")
        .attr("r", (d: MemoryGraphNode) => nodeRadius(d, clusterSize.get(d.clusterId) || 1))
        .attr("fill", (d: MemoryGraphNode) => CATEGORY_COLORS[d.category] || "#cbd5e1")
        .attr("stroke", (d: MemoryGraphNode) => nodeStroke(d, null, ""))
        .attr("stroke-width", 1)
        .attr("opacity", 0.9)
        .style("cursor", "pointer")
        .on("click", (event: MouseEvent, d: MemoryGraphNode) => {
          event.stopPropagation();
          onSelect(d.id);
        })
        .call(
          d3.drag()
            .on("start", (event: any, d: any) => {
              if (!event.active) simulation.alphaTarget(0.25).restart();
              d.fx = d.x;
              d.fy = d.y;
            })
            .on("drag", (event: any, d: any) => {
              d.fx = event.x;
              d.fy = event.y;
            })
            .on("end", (event: any, d: any) => {
              if (!event.active) simulation.alphaTarget(0);
              d.fx = null;
              d.fy = null;
            })
        );

      node.append("title").text((d: MemoryGraphNode) => d.text);

      simulation = d3.forceSimulation(nodes)
        .force("link", d3.forceLink(links)
          .id((d: MemoryGraphNode) => d.id)
          .distance((d: any) => d.type === "lineage" ? 54 : Math.max(36, 118 - d.similarity * 72))
          .strength((d: any) => d.type === "lineage" ? 0.18 : 0.1))
        .force("charge", d3.forceManyBody().strength(-72))
        .force("center", d3.forceCenter(width / 2, height / 2))
        .force("collide", d3.forceCollide().radius((d: MemoryGraphNode) => nodeRadius(d, clusterSize.get(d.clusterId) || 1) + 4))
        .on("tick", () => {
          link
            .attr("x1", (d: any) => d.source.x)
            .attr("y1", (d: any) => d.source.y)
            .attr("x2", (d: any) => d.target.x)
            .attr("y2", (d: any) => d.target.y);
          node
            .attr("cx", (d: any) => d.x)
            .attr("cy", (d: any) => d.y);
          for (const d of nodes as any[]) {
            if (Number.isFinite(d.x) && Number.isFinite(d.y)) {
              positionsRef.current.set(d.id, { x: d.x, y: d.y, vx: d.vx, vy: d.vy });
            }
          }
        });
    };

    render();

    const observer = new ResizeObserver(() => render());
    observer.observe(wrapEl);

    return () => {
      observer.disconnect();
      simulation?.stop();
    };
  }, [d3, graph, onSelect]);

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl || !d3) return;

    const query = searchQuery.trim().toLowerCase();
    const dimNonMatches = Boolean(query) && graph.stats.mode !== "focused";
    d3.select(svgEl)
      .selectAll(".memory-node")
      .attr("stroke", (d: MemoryGraphNode) => nodeStroke(d, selectedId, query))
      .attr("stroke-width", (d: MemoryGraphNode) => d.id === selectedId || matchesQuery(d, query) ? 2.5 : 1)
      .attr("opacity", (d: MemoryGraphNode) => dimNonMatches && !matchesQuery(d, query) ? 0.35 : 0.9);
  }, [d3, graph, searchQuery, selectedId]);

  return (
    <div ref={wrapRef} className="absolute inset-0">
      <svg ref={svgRef} className="w-full h-full block" />
    </div>
  );
}

function MemoryGraphDetails({
  node,
  graph,
}: {
  node: MemoryGraphNode | null;
  graph: MemoryGraphData | null;
}) {
  if (!node || !graph) {
    return (
      <div className="min-h-[180px] rounded-lg border border-white/10 bg-white/[0.03] p-3 text-xs text-white/30">
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
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 space-y-3 min-h-[300px]">
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

function nodeRadius(node: MemoryGraphNode, clusterSize: number): number {
  return Math.min(13, 3.5 + node.importance * 0.45 + Math.log2(clusterSize + 1) * 0.8);
}

function nodeStroke(node: MemoryGraphNode, selectedId: string | null, query: string): string {
  if (node.id === selectedId) return "#f8fafc";
  if (matchesQuery(node, query)) return "#facc15";
  if (!node.hasEmbedding) return "rgba(248, 113, 113, 0.8)";
  return "rgba(255, 255, 255, 0.42)";
}

function matchesQuery(node: MemoryGraphNode, query: string): boolean {
  if (!query) return false;
  return (
    node.text.toLowerCase().includes(query) ||
    node.category.toLowerCase().includes(query) ||
    node.projectId?.toLowerCase().includes(query) ||
    false
  );
}
