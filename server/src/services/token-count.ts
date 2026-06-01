import { createHash } from "crypto";

export type TokenEstimateKind = "default" | "structured" | "tool_result";

export interface ExactTokenCountResult {
  tokens: number;
  elapsedMs: number;
  cached: boolean;
}

const DEFAULT_TOKENIZE_TIMEOUT_MS = 500;
const TOKEN_COUNT_CACHE_LIMIT = 512;
const tokenCountCache = new Map<string, number>();

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function cacheKey(baseUrl: string, modelId: string, text: string): string {
  const digest = createHash("sha256").update(text).digest("hex");
  return `${normalizeBaseUrl(baseUrl)}\0${modelId}\0${digest}`;
}

function setCachedTokenCount(key: string, tokens: number): void {
  if (tokenCountCache.size >= TOKEN_COUNT_CACHE_LIMIT) {
    const oldest = tokenCountCache.keys().next().value;
    if (oldest) tokenCountCache.delete(oldest);
  }
  tokenCountCache.set(key, tokens);
}

export interface TextDensityStats {
  chars: number;
  whitespaceRatio: number;
  digitSymbolRatio: number;
}

export interface TextTokenEstimateDescription extends TextDensityStats {
  kind: TokenEstimateKind;
  dense: boolean;
  heuristicBranch: string;
  charsPerToken: number;
  estimatedTokens: number;
}

export function analyzeTextDensity(text: string): TextDensityStats {
  const sampleLimit = 24_000;
  const sample = text.length <= sampleLimit
    ? text
    : `${text.slice(0, sampleLimit / 2)}${text.slice(-sampleLimit / 2)}`;

  let whitespace = 0;
  let digits = 0;
  let symbols = 0;

  for (let i = 0; i < sample.length; i++) {
    const ch = sample[i];
    if (/\s/.test(ch)) {
      whitespace++;
    } else if (/[0-9]/.test(ch)) {
      digits++;
    } else if (!/[A-Za-z]/.test(ch)) {
      symbols++;
    }
  }

  const chars = sample.length || 1;
  const nonWhitespace = Math.max(1, chars - whitespace);
  return {
    chars,
    whitespaceRatio: whitespace / chars,
    digitSymbolRatio: (digits + symbols) / nonWhitespace,
  };
}

export function isDenseTokenText(text: string): boolean {
  if (!text) return false;
  const stats = analyzeTextDensity(text);
  return (
    stats.digitSymbolRatio >= 0.48 ||
    (stats.whitespaceRatio < 0.16 && stats.digitSymbolRatio >= 0.36) ||
    /<svg\b|<path\b|<polygon\b|points="|d="|rgba\(|^\s*\d+\s+\|/im.test(text)
  );
}

function tokenHeuristicFor(text: string, kind: TokenEstimateKind): {
  charsPerToken: number;
  branch: string;
  dense: boolean;
  stats: TextDensityStats;
} {
  if (!text) {
    return {
      charsPerToken: 4,
      branch: `${kind}:empty`,
      dense: false,
      stats: { chars: 0, whitespaceRatio: 0, digitSymbolRatio: 0 },
    };
  }
  const stats = analyzeTextDensity(text);
  const dense = isDenseTokenText(text);

  if (kind === "tool_result") {
    if (dense) return { charsPerToken: 1.5, branch: "tool_result:dense", dense, stats };
    if (stats.digitSymbolRatio >= 0.32 && stats.whitespaceRatio < 0.30) {
      return { charsPerToken: 2.0, branch: "tool_result:symbolic", dense, stats };
    }
    return { charsPerToken: 3.0, branch: "tool_result:default", dense, stats };
  }

  if (kind === "structured") {
    if (dense) return { charsPerToken: 1.75, branch: "structured:dense", dense, stats };
    return { charsPerToken: 2.5, branch: "structured:default", dense, stats };
  }

  if (dense && text.length > 2_000) return { charsPerToken: 2.0, branch: "default:dense-long", dense, stats };
  if (stats.digitSymbolRatio >= 0.36 && stats.whitespaceRatio < 0.24) {
    return { charsPerToken: 2.5, branch: "default:symbolic", dense, stats };
  }
  return { charsPerToken: 4.0, branch: "default:prose", dense, stats };
}

function charsPerTokenFor(text: string, kind: TokenEstimateKind): number {
  if (!text) return 4;
  return tokenHeuristicFor(text, kind).charsPerToken;
}

/**
 * Fast local estimate. Normal prose stays near chars/4, while dense structured
 * text such as SVG, JSON, HTML, logs, and line-numbered source gets a much
 * more conservative ratio that better matches tokenizer behavior.
 */
export function estimateTextTokens(text: string | undefined | null, kind: TokenEstimateKind = "default"): number {
  if (!text) return 0;
  const charsPerToken = charsPerTokenFor(text, kind);
  return Math.max(1, Math.ceil(text.length / charsPerToken));
}

export function describeTextTokenEstimate(
  text: string | undefined | null,
  kind: TokenEstimateKind = "default",
): TextTokenEstimateDescription {
  if (!text) {
    return {
      kind,
      chars: 0,
      whitespaceRatio: 0,
      digitSymbolRatio: 0,
      dense: false,
      heuristicBranch: `${kind}:empty`,
      charsPerToken: 4,
      estimatedTokens: 0,
    };
  }
  const heuristic = tokenHeuristicFor(text, kind);
  return {
    kind,
    chars: text.length,
    whitespaceRatio: heuristic.stats.whitespaceRatio,
    digitSymbolRatio: heuristic.stats.digitSymbolRatio,
    dense: heuristic.dense,
    heuristicBranch: heuristic.branch,
    charsPerToken: heuristic.charsPerToken,
    estimatedTokens: Math.max(1, Math.ceil(text.length / heuristic.charsPerToken)),
  };
}

export function shouldExactCountText(
  text: string | undefined | null,
  kind: TokenEstimateKind = "default",
  minChars = 16_000,
): boolean {
  if (!text) return false;
  return text.length >= minChars || (text.length >= 4_000 && (kind !== "default" || isDenseTokenText(text)));
}

export async function countLlamaTextTokens(
  baseUrl: string,
  modelId: string,
  text: string,
  options: { timeoutMs?: number } = {},
): Promise<ExactTokenCountResult> {
  if (!text) return { tokens: 0, elapsedMs: 0, cached: true };

  const key = cacheKey(baseUrl, modelId, text);
  const cached = tokenCountCache.get(key);
  if (cached !== undefined) return { tokens: cached, elapsedMs: 0, cached: true };

  const started = Date.now();
  const res = await fetch(`${normalizeBaseUrl(baseUrl)}/tokenize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelId, content: text, add_special: false }),
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TOKENIZE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`/tokenize returned ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json().catch(() => null) as { tokens?: unknown; n_tokens?: unknown } | null;
  const tokens = Array.isArray(json?.tokens)
    ? json.tokens.length
    : (typeof json?.n_tokens === "number" ? json.n_tokens : undefined);
  if (typeof tokens !== "number" || !Number.isFinite(tokens)) {
    throw new Error("/tokenize returned no token count");
  }

  const count = Math.max(0, Math.floor(tokens));
  setCachedTokenCount(key, count);
  return { tokens: count, elapsedMs: Date.now() - started, cached: false };
}
