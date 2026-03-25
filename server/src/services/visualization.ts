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

    // Build thumbnail URL based on entry type
    let thumbUrl: string;
    if (entry.type === "analyzed" && entry.visionId) {
      thumbUrl = `/api/vision/images/${entry.visionId}/thumb`;
    } else {
      thumbUrl = `/api/images/${entry.imagePath || entry.id}/thumb`;
    }

    return {
      id: entry.id,
      clusterId: cluster?.id || null,
      clusterName: cluster?.name || "Unclassified",
      theme: primaryTheme,
      color: getThemeColor(primaryTheme),
      size: Math.min(15, 5 + clusterSize * 0.5),  // Scale node size by cluster density
      prompt: (entry.prompt || entry.description || "").substring(0, 100),
      description: entry.description || entry.prompt || "",
      thumbUrl,
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
<html lang="en" data-theme="default">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Image Corpus Visualization</title>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <style>
    :root {
      /* Default theme (purple/amber) - overridden by data-theme attributes */
      --theme-primary: 162, 74, 255;
      --theme-primary-muted: 162, 74, 255, 0.2;
      --theme-primary-border: 162, 74, 255, 0.3;
      --theme-primary-text: 216, 180, 254;
      --theme-accent: 251, 191, 36;
      --theme-accent-muted: 251, 191, 36, 0.15;
      --theme-accent-border: 251, 191, 36, 0.2;
      --theme-accent-text: 251, 191, 36, 0.8;
      --theme-secondary: 59, 132, 250;
      --theme-secondary-muted: 59, 132, 250, 0.2;
      --theme-secondary-border: 59, 132, 250, 0.25;
      --theme-secondary-text: 147, 197, 253;
      --theme-grid: 139, 92, 246;
      --theme-grid-opacity: 0.12;
      --theme-bg-gradient: linear-gradient(135deg, #0f172a 0%, #181845 25%, #1c1a49 38%, #1e1b4b 50%, #1c1a49 62%, #181845 75%, #0f172a 100%);
      --theme-glow: rgba(162, 74, 255, 0.15);
    }
    
    [data-theme="ocean"] {
      --theme-primary: 56, 189, 248;
      --theme-primary-muted: 56, 189, 248, 0.2;
      --theme-primary-border: 56, 189, 248, 0.3;
      --theme-primary-text: 125, 211, 252;
      --theme-accent: 45, 212, 191;
      --theme-accent-muted: 45, 212, 191, 0.15;
      --theme-accent-border: 45, 212, 191, 0.2;
      --theme-accent-text: 45, 212, 191, 0.8;
      --theme-secondary: 129, 140, 248;
      --theme-secondary-muted: 129, 140, 248, 0.2;
      --theme-secondary-border: 129, 140, 248, 0.25;
      --theme-secondary-text: 167, 139, 250;
      --theme-grid: 56, 189, 248;
      --theme-grid-opacity: 0.12;
      --theme-bg-gradient: linear-gradient(135deg, #0c1929 0%, #172d4e 25%, #1b3458 38%, #1e3a5f 50%, #1b3458 62%, #172d4e 75%, #0c1929 100%);
      --theme-glow: rgba(56, 189, 248, 0.15);
    }
    
    [data-theme="forest"] {
      --theme-primary: 134, 239, 172;
      --theme-primary-muted: 134, 239, 172, 0.2;
      --theme-primary-border: 134, 239, 172, 0.3;
      --theme-primary-text: 134, 239, 172, 0.9;
      --theme-accent: 254, 202, 87;
      --theme-accent-muted: 254, 202, 87, 0.15;
      --theme-accent-border: 254, 202, 87, 0.2;
      --theme-accent-text: 254, 202, 87, 0.8;
      --theme-secondary: 167, 139, 250;
      --theme-secondary-muted: 167, 139, 250, 0.2;
      --theme-secondary-border: 167, 139, 250, 0.25;
      --theme-secondary-text: 192, 132, 252;
      --theme-grid: 134, 239, 172;
      --theme-grid-opacity: 0.12;
      --theme-bg-gradient: linear-gradient(135deg, #0a1a0f 0%, #132d20 25%, #173427 38%, #1a3a2a 50%, #173427 62%, #132d20 75%, #0a1a0f 100%);
      --theme-glow: rgba(134, 239, 172, 0.15);
    }
    
    [data-theme="crimson"] {
      --theme-primary: 244, 63, 94;
      --theme-primary-muted: 244, 63, 94, 0.2;
      --theme-primary-border: 244, 63, 94, 0.3;
      --theme-primary-text: 253, 121, 168;
      --theme-accent: 251, 191, 36;
      --theme-accent-muted: 251, 191, 36, 0.15;
      --theme-accent-border: 251, 191, 36, 0.2;
      --theme-accent-text: 251, 191, 36, 0.8;
      --theme-secondary: 253, 121, 168;
      --theme-secondary-muted: 253, 121, 168, 0.2;
      --theme-secondary-border: 253, 121, 168, 0.25;
      --theme-secondary-text: 253, 121, 168, 0.9;
      --theme-grid: 244, 63, 94;
      --theme-grid-opacity: 0.12;
      --theme-bg-gradient: linear-gradient(135deg, #1a0a0f 0%, #2e1220 25%, #351727 38%, #3a1a2a 50%, #351727 62%, #2e1220 75%, #1a0a0f 100%);
      --theme-glow: rgba(244, 63, 94, 0.15);
    }
    
    [data-theme="mono"] {
      --theme-primary: 148, 163, 184;
      --theme-primary-muted: 148, 163, 184, 0.2;
      --theme-primary-border: 148, 163, 184, 0.3;
      --theme-primary-text: 148, 163, 184, 0.9;
      --theme-accent: 203, 213, 225;
      --theme-accent-muted: 203, 213, 225, 0.15;
      --theme-accent-border: 203, 213, 225, 0.2;
      --theme-accent-text: 203, 213, 225, 0.8;
      --theme-secondary: 100, 116, 139;
      --theme-secondary-muted: 100, 116, 139, 0.2;
      --theme-secondary-border: 100, 116, 139, 0.25;
      --theme-secondary-text: 148, 163, 184, 0.8;
      --theme-grid: 148, 163, 184;
      --theme-grid-opacity: 0.1;
      --theme-bg-gradient: linear-gradient(135deg, #0a0a0a 0%, #151515 25%, #181818 38%, #1a1a1a 50%, #181818 62%, #151515 75%, #0a0a0a 100%);
      --theme-glow: rgba(148, 163, 184, 0.1);
    }
    
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--theme-bg-gradient);
      color: rgba(226, 232, 240, 0.9);
      overflow: hidden;
      transition: background 0.3s ease;
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
      border: 1px solid rgba(var(--theme-primary-border, 51, 65, 85));
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
      color: rgba(var(--theme-primary-text, 96, 165, 250));
      margin-bottom: 6px;
      font-size: 13px;
    }
    
    .tooltip-cluster {
      color: rgba(148, 163, 184, 0.9);
      font-size: 11px;
      margin-bottom: 8px;
    }
    
    .tooltip-elements {
      color: rgba(203, 213, 225, 0.9);
      line-height: 1.4;
    }
    
    .tooltip-element-label {
      color: rgba(100, 116, 139, 0.9);
      font-size: 10px;
      text-transform: uppercase;
      margin-top: 6px;
    }
    
    .tooltip-element-value {
      color: rgba(226, 232, 240, 0.9);
      font-size: 11px;
    }

    /* Thin styled scrollbar — shared by legend and detail panel */
    .styled-scroll::-webkit-scrollbar {
      width: 5px;
    }
    .styled-scroll::-webkit-scrollbar-track {
      background: transparent;
    }
    .styled-scroll::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.1);
      border-radius: 3px;
    }
    .styled-scroll::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.2);
    }
    .styled-scroll {
      scrollbar-width: thin;
      scrollbar-color: rgba(255, 255, 255, 0.1) transparent;
    }

    .tooltip-thumb {
      width: 100%;
      max-height: 160px;
      object-fit: contain;
      border-radius: 4px;
      margin-bottom: 8px;
      background: rgba(0, 0, 0, 0.3);
    }

    #detail-panel {
      position: absolute;
      top: 20px;
      right: 20px;
      width: 320px;
      max-height: calc(100vh - 40px);
      background: rgba(15, 23, 42, 0.95);
      border: 1px solid rgba(var(--theme-primary-border, 51, 65, 85));
      border-radius: 10px;
      overflow: hidden;
      display: none;
      flex-direction: column;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
      z-index: 1100;
    }

    #detail-panel.visible {
      display: flex;
    }

    /* When detail panel is visible, shift the legend to the left */
    #detail-panel.visible ~ #legend {
      right: 360px;
    }

    #detail-panel .detail-close {
      position: absolute;
      top: 8px;
      right: 8px;
      width: 24px;
      height: 24px;
      border: none;
      background: rgba(0,0,0,0.4);
      color: rgba(226, 232, 240, 0.7);
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      line-height: 24px;
      text-align: center;
      z-index: 2;
    }

    #detail-panel .detail-close:hover {
      background: rgba(0,0,0,0.6);
      color: rgba(226, 232, 240, 0.95);
    }

    #detail-panel .detail-thumb {
      width: 100%;
      max-height: 240px;
      object-fit: contain;
      background: rgba(0, 0, 0, 0.3);
      flex-shrink: 0;
    }

    #detail-panel .detail-body {
      padding: 12px;
      overflow-y: auto;
      flex: 1;
    }

    #detail-panel .detail-cluster {
      font-size: 11px;
      color: rgba(148, 163, 184, 0.9);
      margin-bottom: 4px;
    }

    #detail-panel .detail-theme {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: rgba(var(--theme-primary-text, 96, 165, 250));
      margin-bottom: 8px;
    }

    #detail-panel .detail-description {
      font-size: 12px;
      color: rgba(226, 232, 240, 0.85);
      line-height: 1.5;
      white-space: pre-wrap;
    }

    #legend {
      position: absolute;
      top: 20px;
      right: 20px;
      background: rgba(15, 23, 42, 0.9);
      border: 1px solid rgba(var(--theme-primary-border, 33, 65, 85));
      border-radius: 8px;
      padding: 12px;
      max-height: 80vh;
      overflow-y: auto;
      font-size: 11px;
      transition: right 0.2s ease;
    }
    
    .legend-title {
      font-weight: 600;
      color: rgba(226, 232, 240, 0.9);
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
      border: 1px solid rgba(var(--theme-primary-border, 51, 65, 85));
      border-radius: 8px;
      padding: 12px;
      font-size: 11px;
      color: rgba(148, 163, 184, 0.9);
    }
    
    #stats strong {
      color: rgba(226, 232, 240, 0.9);
    }
  </style>
</head>
<body>
  <div id="graph-container">
    <svg id="graph"></svg>
    <div class="tooltip" id="tooltip"></div>
    <div id="detail-panel">
      <button class="detail-close" id="detail-close">&times;</button>
      <img id="detail-thumb" class="detail-thumb" src="" alt="" />
      <div class="detail-body styled-scroll">
        <div class="detail-cluster" id="detail-cluster"></div>
        <div class="detail-theme" id="detail-theme"></div>
        <div class="detail-description" id="detail-description"></div>
      </div>
    </div>
    <div id="legend" class="styled-scroll"></div>
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

    // Get theme colors from CSS variables
    const rootStyles = getComputedStyle(document.documentElement);
    const themePrimary = rootStyles.getPropertyValue('--theme-primary').trim() || '162, 74, 255';
    const themeSecondary = rootStyles.getPropertyValue('--theme-secondary').trim() || '59, 132, 250';
    const themeAccent = rootStyles.getPropertyValue('--theme-accent').trim() || '251, 191, 36';
    const themeGrid = rootStyles.getPropertyValue('--theme-grid').trim() || '139, 92, 246';
    const themeGridOpacity = parseFloat(rootStyles.getPropertyValue('--theme-grid-opacity').trim()) || 0.12;
    
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

    // Draw links with theme color
    const link = g.append("g")
      .attr("stroke", \`rgba(\${themeGrid}, \${themeGridOpacity})\`)
      .attr("stroke-opacity", 0.6)
      .selectAll("line")
      .data(links)
      .join("line")
      .attr("class", "link")
      .attr("stroke-width", 1);

    // Draw nodes
    const node = g.append("g")
      .attr("stroke", \`rgba(\${themePrimary}, 0.5)\`)
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

    // Detail panel references
    const detailPanel = document.getElementById("detail-panel");
    const detailClose = document.getElementById("detail-close");
    const detailThumb = document.getElementById("detail-thumb");
    const detailCluster = document.getElementById("detail-cluster");
    const detailTheme = document.getElementById("detail-theme");
    const detailDesc = document.getElementById("detail-description");

    detailClose.addEventListener("click", () => {
      detailPanel.classList.remove("visible");
    });

    node.on("mouseover", (event, d) => {
      tooltip.classed("visible", true);

      let html = '<img class="tooltip-thumb" src="' + d.thumbUrl + '" alt="" onerror="this.style.display=\\'none\\'" />';
      html += '<div class="tooltip-title">' + d.clusterName + '</div>';
      html += '<div class="tooltip-elements">' + d.prompt + (d.prompt.length >= 100 ? '...' : '') + '</div>';

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
    })
    .on("click", (event, d) => {
      // Prevent drag from triggering click
      if (event.defaultPrevented) return;

      detailThumb.src = d.thumbUrl;
      detailThumb.style.display = "";
      detailThumb.onerror = function() { this.style.display = "none"; };
      detailCluster.textContent = d.clusterName;
      detailTheme.textContent = d.theme;
      detailDesc.textContent = d.description || d.prompt || "(no description)";
      detailPanel.classList.add("visible");

      // Notify parent window
      window.parent.postMessage({
        type: "corpus-node-click",
        payload: { clusterId: d.clusterId, imageId: d.id },
      }, "*");
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
    legend.append("div")
      .attr("class", "legend-title")
      .style("color", \`rgba(\${themePrimary}, 0.9)\`)
      .text("Themes");

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
        .style("color", \`rgba(\${themePrimary}, 0.8)\`)
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
    
    // Listen for theme changes from parent window
    window.addEventListener("message", (event) => {
      if (event.data?.type === "theme-change") {
        const newTheme = event.data.theme || "default";
        document.documentElement.setAttribute("data-theme", newTheme);
        
        // Re-read theme colors from CSS variables
        const rootStyles = getComputedStyle(document.documentElement);
        const newThemeGrid = rootStyles.getPropertyValue("--theme-grid").trim() || "139, 92, 246";
        const newThemeGridOpacity = parseFloat(rootStyles.getPropertyValue("--theme-grid-opacity").trim()) || 0.12;
        const newThemePrimary = rootStyles.getPropertyValue("--theme-primary").trim() || "162, 74, 255";
        
        // Update link colors
        link.attr("stroke", \`rgba(\${newThemeGrid}, \${newThemeGridOpacity})\`);
        
        // Update node stroke
        node.attr("stroke", \`rgba(\${newThemePrimary}, 0.5)\`);
        
        // Update legend title color
        legend.select(".legend-title")
          .style("color", \`rgba(\${newThemePrimary}, 0.9)\`);
        
        // Update legend item colors
        legend.selectAll(".legend-item span")
          .style("color", \`rgba(\${newThemePrimary}, 0.8)\`);
        
        // Update tooltip border
        tooltip.style("border-color", \`rgba(\${newThemePrimary}, 0.3)\`);
        
        // Update tooltip title color
        tooltip.select(".tooltip-title")
          .style("color", \`rgba(\${newThemePrimary}, 0.9)\`);
      }
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
