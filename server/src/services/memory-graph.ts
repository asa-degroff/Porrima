import type { MemoryCategory, MemorySourceType } from "../types.js";
import {
  ensureMemoryGraphEdgesForIds,
  getDb,
  getMemoryGraphEdgeRows,
  type MemoryGraphEdgeCacheStatus,
} from "./memory-storage.js";

export type MemoryGraphScope = "all" | "global" | "project";

export interface MemoryGraphOptions {
  category?: MemoryCategory;
  includeSuperseded?: boolean;
  minSimilarity?: number;
  neighbors?: number;
  limit?: number;
  scope?: MemoryGraphScope;
  query?: string;
  queryEmbedding?: number[];
}

export interface MemoryGraphEntry {
  id: string;
  text: string;
  category: MemoryCategory;
  importance: number;
  createdAt: string;
  lastAccessed: string;
  accessCount: number;
  sourceChatId: string;
  projectId?: string;
  sourceType?: MemorySourceType;
  sourceId?: string;
  supersededBy?: string;
  supersedes?: string;
  embedding?: number[];
}

export interface MemoryGraphNode extends Omit<MemoryGraphEntry, "embedding"> {
  hasEmbedding: boolean;
  clusterId: string;
}

export interface MemoryGraphLink {
  source: string;
  target: string;
  similarity: number;
  type: "semantic" | "lineage";
}

export interface MemoryGraphCluster {
  id: string;
  size: number;
  representativeMemoryId: string;
  categoryMix: Array<{ category: MemoryCategory; count: number }>;
}

export interface MemoryGraphData {
  nodes: MemoryGraphNode[];
  links: MemoryGraphLink[];
  clusters: MemoryGraphCluster[];
  stats: {
    total: number;
    shown: number;
    embedded: number;
    links: number;
    semanticLinks: number;
    lineageLinks: number;
    minSimilarity: number;
    neighbors: number;
    limit: number;
    capped: boolean;
    mode: "overview" | "focused";
    edgeSource: "pairwise" | "cache" | "hybrid";
    edgeCacheCoverage: number;
    edgeCacheRefreshed: number;
    query?: string;
  };
}

interface MemoryGraphRow {
  id: string;
  text: string;
  category: string;
  importance: number;
  created_at: string;
  last_accessed: string;
  access_count: number;
  source_chat_id: string;
  project_id: string;
  source_type: string | null;
  source_id: string | null;
  superseded_by: string | null;
  supersedes: string | null;
  embedding: Buffer | null;
}

const DEFAULT_MIN_SIMILARITY = 0.9;
const DEFAULT_NEIGHBORS = 6;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2500;
const MAX_FOCUSED_CANDIDATES = 4000;
const PAIRWISE_EDGE_LIMIT = 500;
const MAX_EDGE_CACHE_REFRESH_PER_REQUEST = 128;
const RRF_K = 60;

const GRAPH_ROW_FIELDS = `
  m.id, m.text, m.category, m.importance, m.created_at, m.last_accessed,
  m.access_count, m.source_chat_id, m.project_id, m.source_type,
  m.source_id, m.superseded_by, m.supersedes, v.embedding
`;

export async function getMemoryGraph(options: MemoryGraphOptions = {}): Promise<MemoryGraphData> {
  const db = getDb();
  const category = options.category;
  const includeSuperseded = options.includeSuperseded ?? false;
  const scope = options.scope ?? "all";
  const limit = clampInt(options.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
  const minSimilarity = clampNumber(options.minSimilarity ?? DEFAULT_MIN_SIMILARITY, 0, 1);
  const neighbors = clampInt(options.neighbors ?? DEFAULT_NEIGHBORS, 1, 20);
  const query = options.query?.trim();
  const queryEmbedding = options.queryEmbedding;
  const focusedMode = Boolean(query && queryEmbedding?.length);

  const { where, params } = buildGraphFilter({ category, includeSuperseded, scope });
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const total = (db
    .prepare(`SELECT COUNT(*) as count FROM memories m ${whereClause}`)
    .get(...params) as { count: number }).count;

  let rows: MemoryGraphRow[];
  let capped: boolean | undefined;
  if (focusedMode) {
    const focused = getFocusedMemoryRows(db, {
      query: query!,
      queryEmbedding: queryEmbedding!,
      where,
      params,
      limit,
    });
    rows = focused.rows;
    capped = focused.capped;
  } else {
    rows = db
      .prepare(
        `SELECT ${GRAPH_ROW_FIELDS}
        FROM memories m
        LEFT JOIN vec_memories v ON m.id = v.id
        ${whereClause}
        ORDER BY m.importance DESC, m.created_at DESC
        LIMIT ?`
      )
      .all(...params, limit) as MemoryGraphRow[];
  }

  const entries = rows.map(rowToGraphEntry);
  const edgePlan = resolveSemanticLinks(entries, minSimilarity, neighbors);
  return buildMemoryGraph(entries, {
    minSimilarity,
    neighbors,
    limit,
    total,
    ...(capped !== undefined ? { capped } : {}),
    mode: focusedMode ? "focused" : "overview",
    semanticLinks: edgePlan.links,
    edgeSource: edgePlan.source,
    edgeCacheCoverage: edgePlan.cacheCoverage,
    edgeCacheRefreshed: edgePlan.cacheRefreshed,
    ...(focusedMode && query ? { query } : {}),
  });
}

export function buildMemoryGraph(
  entries: MemoryGraphEntry[],
  options: {
    minSimilarity?: number;
    neighbors?: number;
    limit?: number;
    total?: number;
    capped?: boolean;
    mode?: "overview" | "focused";
    semanticLinks?: MemoryGraphLink[];
    edgeSource?: "pairwise" | "cache" | "hybrid";
    edgeCacheCoverage?: number;
    edgeCacheRefreshed?: number;
    query?: string;
  } = {}
): MemoryGraphData {
  const minSimilarity = clampNumber(options.minSimilarity ?? DEFAULT_MIN_SIMILARITY, 0, 1);
  const neighbors = clampInt(options.neighbors ?? DEFAULT_NEIGHBORS, 1, 20);
  const limit = clampInt(options.limit ?? entries.length, 1, MAX_LIMIT);
  const total = options.total ?? entries.length;
  const mode = options.mode ?? "overview";

  const nodes: MemoryGraphNode[] = entries.map((entry) => ({
    id: entry.id,
    text: entry.text,
    category: entry.category,
    importance: entry.importance,
    createdAt: entry.createdAt,
    lastAccessed: entry.lastAccessed,
    accessCount: entry.accessCount,
    sourceChatId: entry.sourceChatId,
    ...(entry.projectId ? { projectId: entry.projectId } : {}),
    ...(entry.sourceType ? { sourceType: entry.sourceType } : {}),
    ...(entry.sourceId ? { sourceId: entry.sourceId } : {}),
    ...(entry.supersededBy ? { supersededBy: entry.supersededBy } : {}),
    ...(entry.supersedes ? { supersedes: entry.supersedes } : {}),
    hasEmbedding: Boolean(entry.embedding?.length),
    clusterId: "",
  }));

  const semanticLinks = options.semanticLinks ?? buildSemanticLinks(entries, minSimilarity, neighbors);
  const lineageLinks = buildLineageLinks(entries);
  const links = [...semanticLinks, ...lineageLinks];
  const clusters = assignClusters(nodes, semanticLinks);

  return {
    nodes,
    links,
    clusters,
    stats: {
      total,
      shown: nodes.length,
      embedded: nodes.filter((node) => node.hasEmbedding).length,
      links: links.length,
      semanticLinks: semanticLinks.length,
      lineageLinks: lineageLinks.length,
      minSimilarity,
      neighbors,
      limit,
      capped: options.capped ?? total > nodes.length,
      mode,
      edgeSource: options.edgeSource ?? "pairwise",
      edgeCacheCoverage: options.edgeCacheCoverage ?? 1,
      edgeCacheRefreshed: options.edgeCacheRefreshed ?? 0,
      ...(options.query ? { query: options.query } : {}),
    },
  };
}

function resolveSemanticLinks(
  entries: MemoryGraphEntry[],
  minSimilarity: number,
  neighbors: number
): {
  links: MemoryGraphLink[];
  source: "pairwise" | "cache" | "hybrid";
  cacheCoverage: number;
  cacheRefreshed: number;
} {
  const embeddedIds = entries
    .filter((entry) => entry.embedding?.length)
    .map((entry) => entry.id);

  if (embeddedIds.length <= PAIRWISE_EDGE_LIMIT) {
    return {
      links: buildSemanticLinks(entries, minSimilarity, neighbors),
      source: "pairwise",
      cacheCoverage: 1,
      cacheRefreshed: 0,
    };
  }

  const cacheStatus = ensureMemoryGraphEdgesForIds(embeddedIds, {
    maxRefresh: MAX_EDGE_CACHE_REFRESH_PER_REQUEST,
  });
  const cachedLinks = buildCachedSemanticLinks(embeddedIds, minSimilarity, neighbors);
  const cacheCoverage = computeCacheCoverage(cacheStatus);

  if (cachedLinks.length > 0) {
    return {
      links: cachedLinks,
      source: cacheCoverage >= 0.95 ? "cache" : "hybrid",
      cacheCoverage,
      cacheRefreshed: cacheStatus.refreshed,
    };
  }

  return {
    links: buildSemanticLinks(entries, minSimilarity, neighbors),
    source: "pairwise",
    cacheCoverage,
    cacheRefreshed: cacheStatus.refreshed,
  };
}

function buildCachedSemanticLinks(
  ids: string[],
  minSimilarity: number,
  neighbors: number
): MemoryGraphLink[] {
  const rows = getMemoryGraphEdgeRows(ids, minSimilarity);
  const perSource = new Map<string, number>();
  const edgeMap = new Map<string, MemoryGraphLink>();

  for (const row of rows) {
    const used = perSource.get(row.sourceId) ?? 0;
    if (used >= neighbors) continue;
    perSource.set(row.sourceId, used + 1);

    const [a, b] = row.sourceId < row.targetId
      ? [row.sourceId, row.targetId]
      : [row.targetId, row.sourceId];
    const key = `${a}:${b}`;
    const existing = edgeMap.get(key);
    const similarity = roundSimilarity(row.similarity);
    if (!existing || similarity > existing.similarity) {
      edgeMap.set(key, { source: a, target: b, similarity, type: "semantic" });
    }
  }

  return Array.from(edgeMap.values()).sort((a, b) => b.similarity - a.similarity);
}

function computeCacheCoverage(status: MemoryGraphEdgeCacheStatus): number {
  if (status.requested === 0) return 1;
  return Math.max(0, Math.min(1, status.cachedSources / status.requested));
}

function buildGraphFilter(options: {
  category?: MemoryCategory;
  includeSuperseded: boolean;
  scope: MemoryGraphScope;
}): { where: string[]; params: Array<string | number> } {
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (options.category) {
    where.push("m.category = ?");
    params.push(options.category);
  }
  if (!options.includeSuperseded) {
    where.push("m.superseded_by IS NULL");
  }
  if (options.scope === "global") {
    where.push("m.project_id = ''");
  } else if (options.scope === "project") {
    where.push("m.project_id != ''");
  }

  return { where, params };
}

function getFocusedMemoryRows(
  db: ReturnType<typeof getDb>,
  options: {
    query: string;
    queryEmbedding: number[];
    where: string[];
    params: Array<string | number>;
    limit: number;
  }
): { rows: MemoryGraphRow[]; capped: boolean } {
  const candidateLimit = Math.min(
    MAX_FOCUSED_CANDIDATES,
    Math.max(options.limit * 4, 200)
  );
  const scores = new Map<string, number>();

  const vecRows = db
    .prepare("SELECT id FROM vec_memories WHERE embedding MATCH ? ORDER BY distance LIMIT ?")
    .all(new Float32Array(options.queryEmbedding), candidateLimit) as Array<{ id: string }>;
  addRankedScores(scores, vecRows.map((row) => row.id), 1);
  addRankedScores(scores, ftsSearchIds(db, options.query, candidateLimit), 0.85);
  addRankedScores(scores, metadataSearchIds(db, options.query, candidateLimit), 0.65);

  const ids = Array.from(scores.keys());
  if (ids.length === 0) return { rows: [], capped: false };

  const placeholders = ids.map(() => "?").join(",");
  const filterClause = options.where.length > 0 ? ` AND ${options.where.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT ${GRAPH_ROW_FIELDS}
       FROM memories m
       LEFT JOIN vec_memories v ON m.id = v.id
       WHERE m.id IN (${placeholders})${filterClause}`
    )
    .all(...ids, ...options.params) as MemoryGraphRow[];

  const sorted = rows.sort((a, b) =>
    (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) ||
    b.importance - a.importance ||
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  return {
    rows: sorted.slice(0, options.limit),
    capped: sorted.length > options.limit,
  };
}

function ftsSearchIds(
  db: ReturnType<typeof getDb>,
  query: string,
  limit: number
): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const escaped = trimmed.replace(/"/g, '""');

  try {
    let rows = db
      .prepare("SELECT id FROM fts_memories WHERE text MATCH ? ORDER BY rank LIMIT ?")
      .all(`"${escaped}"`, limit) as Array<{ id: string }>;

    if (rows.length === 0) {
      const terms = trimmed
        .split(/\s+/)
        .filter(Boolean)
        .map((term) => `"${term.replace(/"/g, '""')}"`)
        .join(" OR ");
      if (terms) {
        rows = db
          .prepare("SELECT id FROM fts_memories WHERE text MATCH ? ORDER BY rank LIMIT ?")
          .all(terms, limit) as Array<{ id: string }>;
      }
    }

    return rows.map((row) => row.id);
  } catch (error: any) {
    console.warn("[memory-graph] FTS search failed:", error?.message || error);
    return [];
  }
}

function metadataSearchIds(
  db: ReturnType<typeof getDb>,
  query: string,
  limit: number
): string[] {
  const like = `%${escapeLike(query.trim())}%`;
  if (like === "%%") return [];

  const rows = db
    .prepare(
      `SELECT m.id
       FROM memories m
       WHERE (
         m.category LIKE ? ESCAPE '\\'
         OR m.project_id LIKE ? ESCAPE '\\'
         OR COALESCE(m.source_type, '') LIKE ? ESCAPE '\\'
       )
       ORDER BY m.importance DESC, m.created_at DESC
       LIMIT ?`
    )
    .all(like, like, like, limit) as Array<{ id: string }>;

  return rows.map((row) => row.id);
}

function addRankedScores(
  scores: Map<string, number>,
  ids: string[],
  weight: number
): void {
  ids.forEach((id, index) => {
    scores.set(id, (scores.get(id) ?? 0) + weight / (RRF_K + index + 1));
  });
}

function rowToGraphEntry(row: MemoryGraphRow): MemoryGraphEntry {
  let embedding: number[] | undefined;
  if (row.embedding) {
    embedding = Array.from(
      new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4)
    );
  }

  return {
    id: row.id,
    text: row.text,
    category: row.category as MemoryCategory,
    importance: row.importance,
    createdAt: row.created_at,
    lastAccessed: row.last_accessed,
    accessCount: row.access_count,
    sourceChatId: row.source_chat_id,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.source_type ? { sourceType: row.source_type as MemorySourceType } : {}),
    ...(row.source_id ? { sourceId: row.source_id } : {}),
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
    ...(row.supersedes ? { supersedes: row.supersedes } : {}),
    ...(embedding ? { embedding } : {}),
  };
}

function buildSemanticLinks(
  entries: MemoryGraphEntry[],
  minSimilarity: number,
  neighbors: number
): MemoryGraphLink[] {
  const candidates = new Map<string, Array<{ id: string; similarity: number }>>();

  for (let i = 0; i < entries.length; i++) {
    const a = entries[i];
    if (!a.embedding?.length) continue;

    for (let j = i + 1; j < entries.length; j++) {
      const b = entries[j];
      if (!b.embedding?.length) continue;

      const similarity = cosineSimilarity(a.embedding, b.embedding);
      if (similarity < minSimilarity) continue;

      pushCandidate(candidates, a.id, b.id, similarity);
      pushCandidate(candidates, b.id, a.id, similarity);
    }
  }

  const edgeMap = new Map<string, MemoryGraphLink>();
  for (const [source, list] of candidates.entries()) {
    const nearest = list.sort((a, b) => b.similarity - a.similarity).slice(0, neighbors);
    for (const candidate of nearest) {
      const [a, b] = source < candidate.id ? [source, candidate.id] : [candidate.id, source];
      const key = `${a}:${b}`;
      const existing = edgeMap.get(key);
      const similarity = roundSimilarity(candidate.similarity);
      if (!existing || similarity > existing.similarity) {
        edgeMap.set(key, { source: a, target: b, similarity, type: "semantic" });
      }
    }
  }

  return Array.from(edgeMap.values()).sort((a, b) => b.similarity - a.similarity);
}

function buildLineageLinks(entries: MemoryGraphEntry[]): MemoryGraphLink[] {
  const ids = new Set(entries.map((entry) => entry.id));
  const links = new Map<string, MemoryGraphLink>();

  for (const entry of entries) {
    if (entry.supersedes && ids.has(entry.supersedes)) {
      const key = `${entry.supersedes}:${entry.id}`;
      links.set(key, {
        source: entry.supersedes,
        target: entry.id,
        similarity: 1,
        type: "lineage",
      });
    }

    if (entry.supersededBy && ids.has(entry.supersededBy)) {
      const key = `${entry.id}:${entry.supersededBy}`;
      links.set(key, {
        source: entry.id,
        target: entry.supersededBy,
        similarity: 1,
        type: "lineage",
      });
    }
  }

  return Array.from(links.values());
}

function assignClusters(nodes: MemoryGraphNode[], semanticLinks: MemoryGraphLink[]): MemoryGraphCluster[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, Set<string>>();
  for (const node of nodes) adjacency.set(node.id, new Set());

  for (const link of semanticLinks) {
    adjacency.get(link.source)?.add(link.target);
    adjacency.get(link.target)?.add(link.source);
  }

  const visited = new Set<string>();
  const components: string[][] = [];

  for (const node of nodes) {
    if (visited.has(node.id)) continue;
    const stack = [node.id];
    const ids: string[] = [];
    visited.add(node.id);

    while (stack.length > 0) {
      const id = stack.pop()!;
      ids.push(id);
      for (const next of adjacency.get(id) || []) {
        if (!visited.has(next)) {
          visited.add(next);
          stack.push(next);
        }
      }
    }

    components.push(ids);
  }

  components.sort((a, b) => b.length - a.length);

  return components.map((ids, index) => {
    const id = `cluster-${index + 1}`;
    const componentNodes = ids.map((nodeId) => nodeById.get(nodeId)!).filter(Boolean);
    for (const node of componentNodes) node.clusterId = id;

    const categoryCounts = new Map<MemoryCategory, number>();
    for (const node of componentNodes) {
      categoryCounts.set(node.category, (categoryCounts.get(node.category) || 0) + 1);
    }

    const representative = componentNodes
      .slice()
      .sort((a, b) =>
        b.importance - a.importance ||
        b.accessCount - a.accessCount ||
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )[0];

    return {
      id,
      size: componentNodes.length,
      representativeMemoryId: representative?.id || ids[0],
      categoryMix: Array.from(categoryCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([category, count]) => ({ category, count })),
    };
  });
}

function pushCandidate(
  candidates: Map<string, Array<{ id: string; similarity: number }>>,
  source: string,
  id: string,
  similarity: number
): void {
  const list = candidates.get(source);
  if (list) {
    list.push({ id, similarity });
  } else {
    candidates.set(source, [{ id, similarity }]);
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function roundSimilarity(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
