# Phase 2: Creative Image System Design

**Status**: Design approved, implementation in progress  
**Date**: March 22, 2026  
**Corpus**: 252 enriched images (177 generated, 75 analyzed)

---

## Overview

Phase 2 transforms the image corpus from a **flat collection** into a **structured creative space** that enables:

1. **Redundancy reduction** - Group similar prompts to avoid repetitive generation
2. **Visual discovery** - Explore the creative landscape via force-directed graph
3. **Creative remixing** - Mix elements across clusters for novel combinations
4. **Agent autonomy** - Guide autonomous generation during downtime

---

## Design Decisions

### Similarity Threshold
- **0.85 cosine similarity** for cluster formation
- Caters to near-duplicate detection (same prompt, slight variations)
- Prevents redundant generations of visually similar images

### Visualization
- **Start simple**: Basic force-directed graph with nodes + links
- **Expand later**: Add hover tooltips, click-to-select, theme filtering
- **Technology**: D3.js v7 via CDN in `create_visual` iframe

### Creative Autonomy
- **Autonomous generation** during downtime (no explicit requests needed)
- Agent proposes directions, generates, analyzes, and remembers
- Novelty scoring ensures exploration over repetition

### Cluster Persistence
- **Batch rebuild** during daily synthesis cycle
- Rebuild triggered by scheduler, not per-image
- Clusters persisted to `~/.quje-agent/clusters/clusters.json`

### Implementation Priority
1. **Clustering Core** (Sprint 1) - Foundation for everything else
2. **Visualization** (Sprint 2) - Makes clusters explorable
3. **Creative Engine** (Sprint 3) - Powers autonomous generation
4. **Integration** (Sprint 4) - Agent tools + synthesis hooks

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                         PHASE 2 SYSTEM                                │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐  │
│  │   Clustering    │    │  Visualization  │    │   Creative      │  │
│  │   Engine        │    │   Engine        │    │   Engine        │  │
│  │                 │    │                 │    │                 │  │
│  │ • Embedding     │    │ • Force-        │    │ • Remix         │  │
│  │   similarity    │    │   directed      │    │   logic         │  │
│  │ • Cluster       │    │   graph         │    │ • Direction     │  │
│  │   formation     │    │ • Cluster       │    │   selection     │  │
│  │ • Centroid      │    │   exploration   │    │ • Novelty       │  │
│  │   computation   │    │ • Gap           │    │   scoring       │  │
│  │                 │    │   detection     │    │                 │  │
│  └────────┬────────┘    └────────┬────────┘    └────────┬────────┘  │
│           │                      │                      │           │
│           └──────────────────────┼──────────────────────┘           │
│                                  │                                   │
│                        ┌─────────▼─────────┐                         │
│                        │   Corpus          │                         │
│                        │   Intelligence    │                         │
│                        │                   │                         │
│                        │ • Cluster         │                         │
│                        │   API             │                         │
│                        │ • Remix           │                         │
│                        │   suggestions     │                         │
│                        │ • Gap             │                         │
│                        │   analysis        │                         │
│                        └───────────────────┘                         │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Data Structures

### PromptCluster

```typescript
interface PromptCluster {
  id: string;                    // UUID
  name: string;                  // Auto-generated from dominant elements
  centroid: number[];            // Average embedding (1024 dims)
  memberIds: string[];           // Image IDs in this cluster
  dominantElements: {            // Most common elements across members
    themes: string[];
    settings: string[];
    characters: string[];
    concepts: string[];
    styles: string[];
  };
  variance: number;              // How much members vary (0-1 scale)
  size: number;                  // Number of members
  createdAt: number;             // Timestamp
  lastUsed: number;              // For novelty scoring (last generation time)
}
```

### ClusterMap

```typescript
interface ClusterMap {
  clusters: PromptCluster[];
  similarityThreshold: number;   // 0.85
  lastRebuilt: number;           // Timestamp of last rebuild
  corpusSize: number;            // Number of images at rebuild time
}
```

### CreativeDirection

```typescript
interface CreativeDirection {
  id: string;
  type: 'remix' | 'explore' | 'deepen' | 'contrast' | 'gap-fill';
  description: string;           // Human-readable explanation
  sourceClusters: string[];      // Cluster IDs used as sources
  elementCombination: {
    takeThemesFrom: string;      // Cluster ID
    takeSettingsFrom: string;    // Cluster ID
    takeCharactersFrom: string;  // Cluster ID
    injectNovelty?: string;      // New concept not in corpus
  };
  noveltyScore: number;          // 0-1, how different from existing
  proposedPrompt: string;        // LLM-generated prompt for generation
  createdAt: number;
}
```

---

## Component Specifications

### 1. Clustering Engine (`cluster-engine.ts`)

**Purpose**: Group images by prompt similarity using cosine similarity on embeddings.

**Algorithm**:
1. Compute pairwise cosine similarity matrix (252×252 = 63,504 comparisons)
2. Apply density-based clustering with threshold 0.85
3. Compute cluster centroid as average of member embeddings
4. Extract dominant elements by frequency counting
5. Assign cluster name from top themes

**Key Functions**:
```typescript
async function buildClusters(corpus: ImageCorpusEntry[]): Promise<ClusterMap>
function computeSimilarityMatrix(corpus: ImageCorpusEntry[]): number[][]
function cosineSimilarity(a: number[], b: number[]): number
function densityCluster(matrix: number[][], threshold: number): string[][]
function computeCentroid(members: ImageCorpusEntry[]): number[]
function extractDominantElements(members: ImageCorpusEntry[]): DominantElements
```

**Storage**: Persists to `~/.quje-agent/clusters/clusters.json`

---

### 2. Visualization Engine (`visualization.ts`)

**Purpose**: Generate interactive force-directed graph HTML for cluster exploration.

**Technology**: D3.js v7 via CDN, rendered in `create_visual` iframe.

**Visual Encoding**:
- **Node color**: By dominant theme (sci-fi=blue, cyberpunk=purple, industrial=orange, etc.)
- **Node size**: By cluster membership (larger = more similar images = potential redundancy)
- **Link opacity**: By similarity strength (opaque >0.90, semi-transparent 0.70-0.90)
- **Links**: Connect images with similarity > 0.70

**Interactions** (Phase 2.2):
- Hover: Show thumbnail + key elements
- Click: Select image for remixing
- Drag: Rearrange layout
- Filter: Show only specific themes

**Key Functions**:
```typescript
function generateForceGraphHTML(clusters: PromptCluster[], corpus: ImageCorpusEntry[]): string
function buildLinks(corpus: ImageCorpusEntry[], threshold: number): Link[]
function themeToColor(theme: string): string
```

---

### 3. Creative Engine (`creative-engine.ts`)

**Purpose**: Propose novel creative directions for autonomous generation.

**Direction Types**:

| Type | Purpose | Example |
|------|---------|---------|
| **remix** | Combine elements from distant clusters | "Cyberpunk character + Mediterranean setting + ethereal lighting" |
| **explore** | Generate variations within a cluster | "Same sci-fi theme, different vehicle types" |
| **deepen** | Add detail/complexity to existing | "Add Kintsugi-style repair details to spaceship" |
| **contrast** | Deliberately oppose existing | "Warm organic vs cold mechanical" |
| **gap-fill** | Generate in underrepresented themes | "No fantasy images yet - generate dragon/medieval" |

**Novelty Scoring**:
```typescript
function scoreNovelty(
  proposedEmbedding: number[],
  existingCorpus: ImageCorpusEntry[]
): number {
  const maxSim = Math.max(
    ...existingCorpus.map(e => cosineSimilarity(proposedEmbedding, e.promptEmbedding))
  );
  return 1.0 - maxSim;  // 1.0 = novel, 0.0 = duplicate
}
```

**Key Functions**:
```typescript
async function proposeDirections(
  clusters: PromptCluster[],
  corpus: ImageCorpusEntry[],
  memories: Memory[]
): Promise<CreativeDirection[]>

async function createCrossPollination(clusters, corpus): Promise<CreativeDirection>
async function createDeepVariation(clusters, corpus): Promise<CreativeDirection>
async function createConceptInjection(clusters, corpus, memories): Promise<CreativeDirection>
async function createGapFilling(clusters, corpus): Promise<CreativeDirection>
```

---

### 4. Corpus Intelligence API (`routes/corpus.ts`)

**Endpoints**:

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/corpus/clusters` | Get all clusters |
| GET | `/api/corpus/clusters/:id` | Get single cluster with members |
| GET | `/api/corpus/visualization` | Get force-graph HTML |
| POST | `/api/corpus/rebuild` | Rebuild clusters (admin/synthesis) |
| GET | `/api/corpus/directions` | Get creative direction suggestions |
| POST | `/api/corpus/remix` | Generate remix prompt from elements |
| GET | `/api/corpus/gaps` | Analyze underrepresented themes |

---

### 5. Agent Tools

**New Tools** (registered in `agent-tools.ts`):

```typescript
// Explore clusters
{
  name: 'explore_corpus',
  description: 'Browse image clusters to discover patterns and gaps',
  parameters: { theme?: string, minClusterSize?: number }
}

// Remix elements
{
  name: 'remix_elements',
  description: 'Generate a novel prompt by combining elements from different clusters',
  parameters: { sourceClusters: string[], directionType: 'remix'|'explore'|'deepen'|'contrast' }
}

// Analyze gaps
{
  name: 'analyze_gaps',
  description: 'Find underrepresented themes or elements in the corpus',
  parameters: {}
}
```

---

### 6. Synthesis Integration

**Daily Synthesis Hooks** (`synthesis.ts`):

1. **Cluster analysis**: Report cluster growth/shrinkage
2. **Gap detection**: Identify themes not yet explored
3. **Direction logging**: Record creative directions taken
4. **Memory creation**: Save cluster insights as `context` memories

**Scheduler Integration** (`scheduler.ts`):
- Trigger cluster rebuild during daily synthesis
- Pass updated clusters to creative engine

---

## Implementation Roadmap

### Sprint 1: Clustering Core
- [x] Design document created
- [ ] `cluster-engine.ts` - similarity matrix + density clustering
- [ ] `cluster-storage.ts` - persist clusters to disk
- [ ] `GET /api/corpus/clusters` - API endpoint
- [ ] Test: verify clusters group similar images correctly

### Sprint 2: Visualization
- [ ] `visualization.ts` - D3 force-graph HTML generator
- [ ] `create_visual` integration - render in chat
- [ ] Basic interactions: hover shows info
- [ ] Test: verify graph shows meaningful clusters

### Sprint 3: Creative Engine
- [ ] `creative-engine.ts` - direction proposal logic
- [ ] `novelty-scoring.ts` - compute novelty scores
- [ ] `GET /api/corpus/directions` - API endpoint
- [ ] Test: verify directions are actually novel

### Sprint 4: Integration
- [ ] Agent tools: `explore_corpus`, `remix_elements`, `analyze_gaps`
- [ ] Synthesis hooks - daily cluster analysis
- [ ] Memory integration - remember creative directions
- [ ] End-to-end test: autonomous generation loop

---

## Success Metrics

### Clustering Quality
- **Silhouette score** > 0.5 (cohesive clusters)
- **Redundancy reduction**: Similar prompts grouped together
- **Cluster interpretability**: Names reflect dominant themes

### Visualization Utility
- **Cluster visibility**: Distinct groups visible in graph
- **Exploration time**: < 30 seconds to find related images
- **User engagement**: Clicks/hover interactions

### Creative Quality
- **Novelty score**: Average > 0.6 for generated directions
- **Diversity**: New images don't cluster with existing (similarity < 0.85)
- **User approval**: Agent directions lead to satisfying results

### Autonomy Effectiveness
- **Generation rate**: 5-10 images per day during downtime
- **Redundancy rate**: < 10% of generations are near-duplicates
- **Memory growth**: Corpus insights saved as memories

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Clustering too slow (O(n²)) | High | 252 images = 63K comparisons = ~2 seconds; acceptable |
| Force graph too complex | Medium | Start simple, add features incrementally |
| Novelty scoring inaccurate | High | Test against known duplicates, adjust threshold |
| Agent generates too much | Medium | Rate limit: 10 images/day, user override available |
| Clusters unstable | Low | Batch rebuild (daily), not per-image |

---

## File Structure

```
server/src/
├── services/
│   ├── cluster-engine.ts          # Clustering algorithm
│   ├── cluster-storage.ts         # Cluster persistence
│   ├── visualization.ts           # Force-graph HTML generation
│   ├── creative-engine.ts         # Direction proposal logic
│   └── novelty-scoring.ts         # Novelty computation
├── routes/
│   └── corpus.ts                  # Corpus Intelligence API
└── tools/
    └── corpus-tools.ts            # Agent tools for exploration/remixing

client/src/
└── components/
    └── CorpusExplorer.tsx         # Cluster browsing UI (future)

~/.quje-agent/
└── clusters/
    └── clusters.json              # Persisted cluster data
```

---

## Notes

- **Embedding model**: qwen3-embedding:0.6b (1024 dims) - same as memory system
- **Extraction model**: qwen3.5:9b - for element extraction and prompt generation
- **Similarity**: Cosine similarity on normalized embeddings (dot product = cosine)
- **Threshold**: 0.85 for cluster membership, 0.70 for graph links

---

**Next Steps**: Begin Sprint 1 implementation (clustering core).
