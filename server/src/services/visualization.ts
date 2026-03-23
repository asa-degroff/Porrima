import type { PromptCluster, ClusterMap } from "./cluster-storage.js";
import type { ImageCorpusEntry } from "./image-corpus.js";

// Theme color mapping
const THEME_COLORS: Record<string, string> = {
  "sci-fi": "#3b82f6",      // blue
  "cyberpunk": "#a855f7",   // purple
  "industrial": "#f97316",  // orange
  "noir": "#374151",        // dark grey
  "ethereal": "#06b6d4",    // cyan
  "fantasy": "#22c55e",     // green
  "post-apocalyptic": "#dc2626", // red
  "mystical": "#8b5cf6",    // violet
  "military": "#65a30d",    // lime
  "exploration": "#0891b2", // teal
};

/**
 * Generate force-directed graph HTML for corpus visualization.
 * Uses D3.js v7 via CDN.
 */
export function generateForceGraphHTML(
  clusterMap: ClusterMap,
  corpus: ImageCorpusEntry[]
): string {
  // Build nodes from corpus
  const nodes = corpus.map(entry => {
    const cluster = findClusterForImage(entry.id, clusterMap);
    const primaryTheme = entry.elements?.themes?.[0]?.toLowerCase() || "unknown";
    const clusterSize = cluster?.memberIds.length || 1;
    
    return {
      id: entry.id,
      clusterId: cluster?.id || null,
      clusterName: cluster?.name || "Unclassified",
      theme: primaryTheme,
      color: getThemeColor(primaryTheme),
      size: Math.min(15, 5 + clusterSize * 0.5),  // Scale node size by cluster density
      prompt: (entry.prompt || entry.description || "").substring(0, 100),
      elements: entry.elements || {},
    };
  });
  
  // Build embedding lookup for cosine similarity computation
  const embeddingMap = new Map<string, number[]>();
  for (const entry of corpus) {
    if (entry.promptEmbedding?.length) {
      embeddingMap.set(entry.id, entry.promptEmbedding);
    }
  }

  // Build links between similar images using real cosine similarity
  const links: Array<{ source: string; target: string; similarity: number }> = [];

  for (const cluster of clusterMap.clusters) {
    const members = cluster.memberIds;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const embA = embeddingMap.get(members[i]);
        const embB = embeddingMap.get(members[j]);
        // Embeddings are L2-normalized, so dot product = cosine similarity
        const similarity = embA && embB ? dotProduct(embA, embB) : 0.85;
        links.push({
          source: members[i],
          target: members[j],
          similarity,
        });
      }
    }
  }
  
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Image Corpus Visualization</title>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      overflow: hidden;
    }
    
    #graph-container {
      width: 100vw;
      height: 100vh;
      position: relative;
    }
    
    #graph {
      width: 100%;
      height: 100%;
    }
    
    .node {
      cursor: pointer;
      stroke: #fff;
      stroke-width: 1.5px;
      transition: opacity 0.2s;
    }
    
    .node:hover {
      stroke: #fff;
      stroke-width: 3px;
      filter: brightness(1.2);
    }
    
    .node:hover {
      opacity: 1;
    }
    
    .link {
      stroke: #475569;
      stroke-opacity: 0.4;
      pointer-events: none;
    }
    
    .tooltip {
      position: absolute;
      background: rgba(15, 23, 42, 0.95);
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 12px;
      font-size: 12px;
      max-width: 280px;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.2s;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
      z-index: 1000;
    }
    
    .tooltip.visible {
      opacity: 1;
    }
    
    .tooltip-title {
      font-weight: 600;
      color: #60a5fa;
      margin-bottom: 6px;
      font-size: 13px;
    }
    
    .tooltip-cluster {
      color: #94a3b8;
      font-size: 11px;
      margin-bottom: 8px;
    }
    
    .tooltip-elements {
      color: #cbd5e1;
      line-height: 1.4;
    }
    
    .tooltip-element-label {
      color: #64748b;
      font-size: 10px;
      text-transform: uppercase;
      margin-top: 6px;
    }
    
    .tooltip-element-value {
      color: #e2e8f0;
      font-size: 11px;
    }
    
    #legend {
      position: absolute;
      top: 20px;
      right: 20px;
      background: rgba(15, 23, 42, 0.9);
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 12px;
      max-height: 80vh;
      overflow-y: auto;
      font-size: 11px;
    }
    
    .legend-title {
      font-weight: 600;
      color: #e2e8f0;
      margin-bottom: 8px;
      font-size: 12px;
    }
    
    .legend-item {
      display: flex;
      align-items: center;
      margin-bottom: 4px;
    }
    
    .legend-color {
      width: 12px;
      height: 12px;
      border-radius: 2px;
      margin-right: 8px;
    }
    
    #stats {
      position: absolute;
      bottom: 20px;
      left: 20px;
      background: rgba(15, 23, 42, 0.9);
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 12px;
      font-size: 11px;
      color: #94a3b8;
    }
    
    #stats strong {
      color: #e2e8f0;
    }
  </style>
</head>
<body>
  <div id="graph-container">
    <svg id="graph"></svg>
    <div class="tooltip" id="tooltip"></div>
    <div id="legend"></div>
    <div id="stats">
      <div><strong>${nodes.length}</strong> images</div>
      <div><strong>${clusterMap.clusters.length}</strong> clusters</div>
      <div><strong>${links.length}</strong> connections</div>
    </div>
  </div>
  
  <script>
    const nodes = ${JSON.stringify(nodes)};
    const links = ${JSON.stringify(links)};

    let width = window.innerWidth;
    let height = window.innerHeight;

    // Create SVG
    const svg = d3.select("#graph")
      .attr("width", width)
      .attr("height", height);

    // Zoomable container — all graph elements go here
    const g = svg.append("g");

    // Zoom behavior
    const zoom = d3.zoom()
      .scaleExtent([0.1, 8])
      .on("zoom", (event) => {
        g.attr("transform", event.transform);
      });

    svg.call(zoom);

    // Create force simulation
    const simulation = d3.forceSimulation(nodes)
      .force("charge", d3.forceManyBody().strength(-80))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collide", d3.forceCollide().radius(d => d.size + 2))
      .force("link", d3.forceLink(links)
        .id(d => d.id)
        .distance(80)
        .strength(0.1));

    // Draw links
    const link = g.append("g")
      .attr("stroke", "#475569")
      .attr("stroke-opacity", 0.4)
      .selectAll("line")
      .data(links)
      .join("line")
      .attr("class", "link")
      .attr("stroke-width", 1);

    // Draw nodes
    const node = g.append("g")
      .attr("stroke", "#fff")
      .attr("stroke-width", 1.5)
      .selectAll("circle")
      .data(nodes)
      .join("circle")
      .attr("class", "node")
      .attr("r", d => d.size)
      .attr("fill", d => d.color)
      .call(drag(simulation));

    // Add title for simple tooltip
    node.append("title")
      .text(d => d.clusterName);

    // Interaction: hover tooltip
    const tooltip = d3.select("#tooltip");

    node.on("mouseover", (event, d) => {
      tooltip.classed("visible", true);

      let html = '<div class="tooltip-title">Image</div>';
      html += '<div class="tooltip-cluster">' + d.clusterName + '</div>';
      html += '<div class="tooltip-elements">' + d.prompt + '...</div>';

      if (d.elements.themes?.length) {
        html += '<div class="tooltip-element-label">Themes</div>';
        html += '<div class="tooltip-element-value">' + d.elements.themes.slice(0, 3).join(", ") + '</div>';
      }

      if (d.elements.settings?.length) {
        html += '<div class="tooltip-element-label">Settings</div>';
        html += '<div class="tooltip-element-value">' + d.elements.settings.slice(0, 2).join(", ") + '</div>';
      }

      if (d.elements.colors?.length) {
        html += '<div class="tooltip-element-label">Colors</div>';
        html += '<div class="tooltip-element-value">' + d.elements.colors.slice(0, 3).join(", ") + '</div>';
      }

      tooltip.html(html);
      updateTooltipPosition(event);
    })
    .on("mousemove", (event) => {
      updateTooltipPosition(event);
    })
    .on("mouseout", () => {
      tooltip.classed("visible", false);
    });

    function updateTooltipPosition(event) {
      const el = tooltip.node();
      const tooltipRect = el.getBoundingClientRect();

      let x = event.pageX + 10;
      let y = event.pageY + 10;

      if (x + tooltipRect.width > window.innerWidth) {
        x = event.pageX - tooltipRect.width - 10;
      }

      if (y + tooltipRect.height > window.innerHeight) {
        y = event.pageY - tooltipRect.height - 10;
      }

      tooltip.style("left", x + "px")
        .style("top", y + "px");
    }

    // Build legend
    const legend = d3.select("#legend");
    legend.append("div").attr("class", "legend-title").text("Themes");

    const themes = {};
    nodes.forEach(d => {
      const theme = d.theme;
      if (!themes[theme]) {
        themes[theme] = { color: d.color, count: 0 };
      }
      themes[theme].count++;
    });

    Object.entries(themes).sort((a, b) => b[1].count - a[1].count).forEach(([theme, data]) => {
      const item = legend.append("div").attr("class", "legend-item");
      item.append("div")
        .attr("class", "legend-color")
        .style("background-color", data.color);
      item.append("span")
        .text(theme + " (" + data.count + ")");
    });

    // Drag behavior — works correctly with zoom transform
    function drag(simulation) {
      function dragstarted(event, d) {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      }

      function dragged(event, d) {
        d.fx = event.x;
        d.fy = event.y;
      }

      function dragended(event, d) {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      }

      return d3.drag()
        .on("start", dragstarted)
        .on("drag", dragged)
        .on("end", dragended);
    }

    // Update positions on tick
    simulation.on("tick", () => {
      link
        .attr("x1", d => d.source.x)
        .attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x)
        .attr("y2", d => d.target.y);

      node
        .attr("cx", d => d.x)
        .attr("cy", d => d.y);
    });

    // Handle window resize
    window.addEventListener("resize", () => {
      width = window.innerWidth;
      height = window.innerHeight;

      svg.attr("width", width).attr("height", height);
      simulation.force("center", d3.forceCenter(width / 2, height / 2));
      simulation.alpha(0.3).restart();
    });
  </script>
</body>
</html>`;

  return html;
}

/**
 * Get color for a theme.
 */
function getThemeColor(theme: string): string {
  const normalized = theme.toLowerCase().trim();
  
  // Direct match
  if (THEME_COLORS[normalized]) {
    return THEME_COLORS[normalized];
  }
  
  // Partial matches
  for (const [key, color] of Object.entries(THEME_COLORS)) {
    if (normalized.includes(key)) {
      return color;
    }
  }
  
  // Default grey
  return "#9ca3af";
}

/**
 * Dot product of two vectors (cosine similarity for L2-normalized vectors).
 */
function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/**
 * Find cluster for an image ID.
 */
function findClusterForImage(
  imageId: string,
  clusterMap: ClusterMap
): PromptCluster | undefined {
  return clusterMap.clusters.find(c => c.memberIds.includes(imageId));
}
