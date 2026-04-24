export interface VllmCacheMetric {
  modelName: string;
  engine?: string;
  kvCacheUsagePct?: number;
  prefixCacheQueriesTotal?: number;
  prefixCacheHitsTotal?: number;
  prefixCacheHitRatio?: number;
  externalPrefixCacheQueriesTotal?: number;
  externalPrefixCacheHitsTotal?: number;
  promptTokensCachedTotal?: number;
  localCacheHitTokens?: number;
  externalKvTransferTokens?: number;
  enablePrefixCaching?: boolean;
  gpuMemoryUtilization?: number;
  blockSize?: number;
  numGpuBlocks?: number;
  cacheDtype?: string;
  prefixCachingHashAlgo?: string;
}

export interface VllmCacheMetricsSnapshot {
  status: "ok" | "unavailable";
  url: string;
  timestamp: number;
  models: VllmCacheMetric[];
  error?: string;
}

interface MetricLine {
  name: string;
  labels: Record<string, string>;
  value: number;
}

const METRIC_RE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+(-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/;
const LABEL_RE = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"/g;

function parseLabels(input = ""): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const match of input.matchAll(LABEL_RE)) {
    labels[match[1]] = match[2].replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  return labels;
}

function parsePrometheusText(text: string): MetricLine[] {
  const lines: MetricLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(METRIC_RE);
    if (!match) continue;
    const value = Number(match[3]);
    if (!Number.isFinite(value)) continue;
    lines.push({ name: match[1], labels: parseLabels(match[2]), value });
  }
  return lines;
}

function boolLabel(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  return undefined;
}

function numberLabel(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function keyFor(labels: Record<string, string>): string {
  return `${labels.engine ?? "0"}:${labels.model_name ?? labels.model ?? "unknown"}`;
}

function ensureRecord(records: Map<string, VllmCacheMetric>, labels: Record<string, string>): VllmCacheMetric {
  const key = keyFor(labels);
  let record = records.get(key);
  if (!record) {
    record = {
      modelName: labels.model_name ?? labels.model ?? `engine ${labels.engine ?? "0"}`,
      engine: labels.engine,
    };
    records.set(key, record);
  }
  return record;
}

export function parseVllmCacheMetrics(text: string): VllmCacheMetric[] {
  const records = new Map<string, VllmCacheMetric>();
  const cacheConfigByEngine = new Map<string, Partial<VllmCacheMetric>>();

  for (const metric of parsePrometheusText(text)) {
    const { name, labels, value } = metric;

    if (name === "vllm:cache_config_info") {
      cacheConfigByEngine.set(labels.engine ?? "0", {
        engine: labels.engine,
        enablePrefixCaching: boolLabel(labels.enable_prefix_caching),
        gpuMemoryUtilization: numberLabel(labels.gpu_memory_utilization),
        blockSize: numberLabel(labels.block_size),
        numGpuBlocks: numberLabel(labels.num_gpu_blocks),
        cacheDtype: labels.cache_dtype,
        prefixCachingHashAlgo: labels.prefix_caching_hash_algo,
      });
      continue;
    }

    if (!labels.model_name) continue;
    const record = ensureRecord(records, labels);

    switch (name) {
      case "vllm:kv_cache_usage_perc":
        record.kvCacheUsagePct = value;
        break;
      case "vllm:prefix_cache_queries_total":
        record.prefixCacheQueriesTotal = value;
        break;
      case "vllm:prefix_cache_hits_total":
        record.prefixCacheHitsTotal = value;
        break;
      case "vllm:external_prefix_cache_queries_total":
        record.externalPrefixCacheQueriesTotal = value;
        break;
      case "vllm:external_prefix_cache_hits_total":
        record.externalPrefixCacheHitsTotal = value;
        break;
      case "vllm:prompt_tokens_cached_total":
        record.promptTokensCachedTotal = value;
        break;
      case "vllm:prompt_tokens_by_source_total":
        if (labels.source === "local_cache_hit") record.localCacheHitTokens = value;
        if (labels.source === "external_kv_transfer") record.externalKvTransferTokens = value;
        break;
    }
  }

  for (const record of records.values()) {
    const config = cacheConfigByEngine.get(record.engine ?? "0");
    if (config) Object.assign(record, config);
    if (record.prefixCacheQueriesTotal && record.prefixCacheQueriesTotal > 0 && record.prefixCacheHitsTotal !== undefined) {
      record.prefixCacheHitRatio = record.prefixCacheHitsTotal / record.prefixCacheQueriesTotal;
    }
  }

  return [...records.values()].sort((a, b) => a.modelName.localeCompare(b.modelName));
}

export async function fetchVllmCacheMetrics(baseUrl: string): Promise<VllmCacheMetricsSnapshot> {
  try {
    const response = await fetch(`${baseUrl}/metrics`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      return {
        status: "unavailable",
        url: baseUrl,
        timestamp: Date.now(),
        models: [],
        error: `vLLM returned ${response.status}`,
      };
    }
    const text = await response.text();
    return {
      status: "ok",
      url: baseUrl,
      timestamp: Date.now(),
      models: parseVllmCacheMetrics(text),
    };
  } catch (err) {
    return {
      status: "unavailable",
      url: baseUrl,
      timestamp: Date.now(),
      models: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
