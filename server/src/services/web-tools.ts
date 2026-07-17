import { Type, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import puppeteer from "puppeteer-core";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { parseHTML } from "linkedom";
import { createHash } from "crypto";
import { writeFile, mkdir, readFile, rm } from "fs/promises";
import { join } from "path";
import { getSettings } from "./chat-storage.js";
import { appDataPath } from "./paths.js";
import { findChromePath } from "./chrome.js";

const MAX_CONTENT_LENGTH = 250_000;
const WEB_SEARCH_PROVIDERS = ["brave", "exa", "tavily"] as const;

// --- Web fetch cache ---

const WEB_CACHE_DIR = appDataPath("cache", "web-pages");
const MANIFEST_PATH = join(WEB_CACHE_DIR, "manifest.json");
const PREVIEW_LENGTH = 10_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

type CacheEntry = { url: string; hash: string; fetchedAt: number; charCount: number };
type CacheManifest = Record<string, CacheEntry>;

function urlToHash(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

async function loadManifest(): Promise<CacheManifest> {
  try {
    const raw = await readFile(MANIFEST_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveManifest(manifest: CacheManifest): Promise<void> {
  await mkdir(WEB_CACHE_DIR, { recursive: true });
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf-8");
}

let manifestWriteChain: Promise<void> = Promise.resolve();
function updateManifest(mutator: (manifest: CacheManifest) => void): Promise<void> {
  manifestWriteChain = manifestWriteChain.then(async () => {
    const manifest = await loadManifest();
    mutator(manifest);
    await saveManifest(manifest);
  });
  return manifestWriteChain;
}

async function cleanupOldCache(): Promise<void> {
  try {
    const manifest = await loadManifest();
    const now = Date.now();
    const stale = Object.entries(manifest).filter(([, entry]) => now - entry.fetchedAt > CACHE_TTL_MS);

    for (const [hash] of stale) {
      const filePath = join(WEB_CACHE_DIR, `${hash}.md`);
      try { await rm(filePath, { force: true }); } catch { /* already gone */ }
      delete manifest[hash];
    }

    if (stale.length > 0) {
      await updateManifest((current) => {
        for (const [hash] of stale) delete current[hash];
      });
    }
  } catch (e) {
    // Non-fatal — cleanup failures don't affect the fetch
    console.warn("[web_fetch] Cache cleanup failed:", e);
  }
}

type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

const TAVILY_SEARCH_DEPTHS = ["basic", "advanced", "fast", "ultra-fast"] as const;
const TAVILY_TOPICS = ["general", "news", "finance"] as const;
const TAVILY_TIME_RANGES = ["day", "week", "month", "year", "d", "w", "m", "y"] as const;
const TAVILY_ANSWER_MODES = ["basic", "advanced"] as const;
const TAVILY_RAW_CONTENT_MODES = ["markdown", "text"] as const;

function isWebSearchProvider(value: unknown): value is WebSearchProvider {
  return typeof value === "string" && WEB_SEARCH_PROVIDERS.includes(value as WebSearchProvider);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  let normalized = value.trim();
  for (let i = 0; i < 2; i++) {
    const startsAndEndsWithQuotes =
      (normalized.startsWith("\"") && normalized.endsWith("\"")) ||
      (normalized.startsWith("'") && normalized.endsWith("'"));

    if (!startsAndEndsWithQuotes || normalized.length < 2) break;

    try {
      const parsed = JSON.parse(normalized);
      if (typeof parsed !== "string") break;
      normalized = parsed.trim();
    } catch {
      normalized = normalized.slice(1, -1).trim();
    }
  }

  return normalized;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .map(normalizeString)
    .filter((item): item is string => !!item);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeBooleanOrString(value: unknown): boolean | string | undefined {
  if (typeof value === "boolean") return value;
  const normalized = normalizeString(value);
  if (normalized === undefined) return undefined;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return normalized;
}

function pickAllowedString<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback?: T
): T | undefined {
  const normalized = normalizeString(value);
  if (normalized && (allowed as readonly string[]).includes(normalized)) return normalized as T;
  return fallback;
}

function pickAllowedBooleanOrString<T extends string>(
  value: unknown,
  allowed: readonly T[]
): boolean | T | undefined {
  const normalized = normalizeBooleanOrString(value);
  if (typeof normalized === "boolean") return normalized;
  if (normalized && (allowed as readonly string[]).includes(normalized)) return normalized as T;
  return undefined;
}

// --- Tool definitions ---

const WEB_SEARCH_TOOL: Tool = {
  name: "web_search",
  description:
    "Search the web. Uses the configured default provider unless `provider` is supplied as an override. Supports Brave Search, Exa, and Tavily. Provider-specific knobs (e.g. Exa searchType/contents, Tavily searchDepth/topic/timeRange/includeAnswer/includeRawContent) go in the `providerOptions` object — the server validates them per provider.",
  parameters: Type.Object({
    query: Type.String({ description: "Search query" }),
    count: Type.Optional(
      Type.Integer({
        description: "Number of results (1-20, default 5)",
        minimum: 1,
        maximum: 20,
      })
    ),
    provider: Type.Optional(Type.Enum(WEB_SEARCH_PROVIDERS, { description: "Optional provider override; omit to use the configured default" })),
    startPublishedDate: Type.Optional(
      Type.String({ description: "Exa/Tavily: earliest publication or update date", format: "date" })
    ),
    endPublishedDate: Type.Optional(
      Type.String({ description: "Exa/Tavily: latest publication or update date", format: "date" })
    ),
    includeDomains: Type.Optional(
      Type.Array(Type.String(), { description: "Exa/Tavily: domains to include in results" })
    ),
    excludeDomains: Type.Optional(
      Type.Array(Type.String(), { description: "Tavily only: domains to exclude from results" })
    ),
    providerOptions: Type.Optional(
      Type.Object({
        searchType: Type.Optional(Type.Enum(["auto", "neural", "keyword", "hybrid", "fast", "deep", "deep-lite", "deep-reasoning", "magic", "instant"] as const)),
        searchDepth: Type.Optional(Type.Enum(TAVILY_SEARCH_DEPTHS)),
        topic: Type.Optional(Type.Enum(TAVILY_TOPICS)),
        timeRange: Type.Optional(Type.Enum(TAVILY_TIME_RANGES)),
        includeAnswer: Type.Optional(Type.Union([Type.Boolean(), ...TAVILY_ANSWER_MODES.map((value) => Type.Literal(value))])),
        includeRawContent: Type.Optional(Type.Union([Type.Boolean(), ...TAVILY_RAW_CONTENT_MODES.map((value) => Type.Literal(value))])),
        contents: Type.Optional(Type.Object({
          text: Type.Optional(Type.Union([Type.Boolean(), Type.Object({
            maxCharacters: Type.Optional(Type.Integer({ minimum: 1 })),
            includeHtmlTags: Type.Optional(Type.Boolean()),
          }, { additionalProperties: false })])),
          highlights: Type.Optional(Type.Union([Type.Boolean(), Type.Object({
            query: Type.Optional(Type.String()),
            numSentences: Type.Optional(Type.Integer({ minimum: 1 })),
            highlightsPerUrl: Type.Optional(Type.Integer({ minimum: 1 })),
          }, { additionalProperties: false })])),
          summary: Type.Optional(Type.Union([Type.Boolean(), Type.Object({
            query: Type.Optional(Type.String()),
          }, { additionalProperties: false })])),
        }, { additionalProperties: false })),
      }, { additionalProperties: false, description: "Provider-specific Exa or Tavily options" })
    ),
  }),
};

const WEB_FETCH_TOOL: Tool = {
  name: "web_fetch",
  description:
    "Fetch a JavaScript-rendered web page and return readable markdown. Large pages are cached internally; paginate them by calling web_fetch again with the same URL and a larger offset.",
  parameters: Type.Object({
    url: Type.String({ description: "URL to fetch (http or https)" }),
    timeout: Type.Optional(
      Type.Integer({
        description: "Navigation timeout in seconds (5-60, default 30)",
        minimum: 5,
        maximum: 60,
      })
    ),
    raw: Type.Optional(
      Type.Boolean({
        description:
          "If true, return the full page HTML as markdown instead of extracting the main content (default false)",
      })
    ),
    offset: Type.Optional(Type.Integer({ description: "Character offset into cached page content (default 0)", minimum: 0 })),
    limit: Type.Optional(Type.Integer({ description: "Characters to return (default 10000, max 50000)", minimum: 1000, maximum: 50000 })),
  }),
};

export const WEB_TOOLS: Tool[] = [WEB_SEARCH_TOOL, WEB_FETCH_TOOL];

// --- Execution ---

/**
 * Resolve a provider-specific option from either the top-level args (legacy
 * callers) or the nested `providerOptions` object (preferred). Top-level wins
 * for backwards compatibility with persisted tool calls.
 */
function pickOption<T>(args: Record<string, any>, key: string): T | undefined {
  if (args[key] !== undefined) return args[key] as T;
  const opts = args.providerOptions;
  if (opts && typeof opts === "object" && opts[key] !== undefined) return opts[key] as T;
  return undefined;
}

export async function executeWebTool(
  toolCall: ToolCall,
  signal?: AbortSignal,
): Promise<{ content: string; isError: boolean }> {
  switch (toolCall.name) {
    case "web_search":
      return executeWebSearch(toolCall.arguments, signal);
    case "web_fetch":
      return executeWebFetch(toolCall.arguments, signal);
    default:
      return { content: `Unknown web tool: ${toolCall.name}`, isError: true };
  }
}

// --- web_search ---

async function getBraveApiKey(): Promise<string> {
  if (process.env.BRAVE_API_KEY) return process.env.BRAVE_API_KEY;
  const settings = await getSettings();
  return settings.braveApiKey || "";
}

async function getExaApiKey(): Promise<string> {
  if (process.env.EXA_API_KEY) return process.env.EXA_API_KEY;
  const settings = await getSettings();
  return settings.exaApiKey || "";
}

async function getTavilyApiKey(): Promise<string> {
  if (process.env.TAVILY_API_KEY) return process.env.TAVILY_API_KEY;
  const settings = await getSettings();
  return settings.tavilyApiKey || "";
}

async function getDefaultWebSearchProvider(): Promise<WebSearchProvider> {
  const settings = await getSettings();
  const provider = normalizeString(settings.defaultWebSearchProvider);
  if (!isWebSearchProvider(provider)) return "brave";
  // Respect enabled flags — if the configured default is disabled, fall back
  const enabled: WebSearchProvider[] = [
    ...(settings.braveSearchEnabled ? ["brave" as const] : []),
    ...(settings.exaSearchEnabled ? ["exa" as const] : []),
    ...(settings.tavilySearchEnabled ? ["tavily" as const] : []),
  ];
  if (enabled.includes(provider)) return provider;
  // Default provider is disabled — use first enabled, or brave
  return enabled.length > 0 ? enabled[0] : "brave";
}

async function executeWebSearch(
  args: Record<string, any>,
  signal?: AbortSignal,
): Promise<{ content: string; isError: boolean }> {
  const requestedProvider = normalizeString(args.provider);
  if (requestedProvider !== undefined && !isWebSearchProvider(requestedProvider)) {
    return {
      content: `Unsupported web search provider: ${requestedProvider}. Use one of: ${WEB_SEARCH_PROVIDERS.join(", ")}.`,
      isError: true,
    };
  }

  const provider = requestedProvider || await getDefaultWebSearchProvider();

  if (provider === "exa") {
    return executeExaSearch(args, signal);
  }
  if (provider === "tavily") {
    return executeTavilySearch(args, signal);
  }

  return executeBraveSearch(args, signal);
}

async function executeBraveSearch(
  args: Record<string, any>,
  signal?: AbortSignal,
): Promise<{ content: string; isError: boolean }> {
  const apiKey = await getBraveApiKey();
  if (!apiKey) {
    return {
      content:
        "Brave Search is unavailable: no API key configured. Add one in Settings or set the BRAVE_API_KEY environment variable.",
      isError: true,
    };
  }

  const query = args.query;
  if (!query) {
    return { content: "Missing required parameter: query", isError: true };
  }

  const count = Math.min(20, Math.max(1, args.count || 5));

  try {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(count));

    const response = await fetch(url.toString(), {
      signal,
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
    });

    if (!response.ok) {
      return {
        content: `Brave Search API error: ${response.status} ${response.statusText}`,
        isError: true,
      };
    }

    const data = await response.json();
    const results = data.web?.results || [];

    if (results.length === 0) {
      return { content: "No search results found.", isError: false };
    }

    const formatted = results
      .map(
        (r: any, i: number) =>
          `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description || "(no snippet)"}`
      )
      .join("\n\n");

    return { content: formatted, isError: false };
  } catch (e: any) {
    return { content: `Brave Search failed: ${e.message}`, isError: true };
  }
}

async function executeExaSearch(
  args: Record<string, any>,
  signal?: AbortSignal,
): Promise<{ content: string; isError: boolean }> {
  const apiKey = await getExaApiKey();
  if (!apiKey) {
    return {
      content:
        "Exa Search is unavailable: no API key configured. Add one in Settings or set the EXA_API_KEY environment variable.",
      isError: true,
    };
  }

  const query = args.query;
  if (!query) {
    return { content: "Missing required parameter: query", isError: true };
  }

  const numResults = Math.min(50, Math.max(1, args.count || 5));

  try {
    const body: Record<string, any> = {
      query,
      numResults,
      type: normalizeString(pickOption<string>(args, "searchType")) || "auto",
    };

    // Exa-specific filters
    const startPublishedDate = normalizeString(args.startPublishedDate);
    const endPublishedDate = normalizeString(args.endPublishedDate);
    const includeDomains = normalizeStringArray(args.includeDomains);
    if (startPublishedDate) body.startPublishedDate = startPublishedDate;
    if (endPublishedDate) body.endPublishedDate = endPublishedDate;
    if (includeDomains) body.includeDomains = includeDomains;

    // Exa content options — don't enable by default to avoid token bloat
    // Only include if explicitly set
    const contentsOpt = pickOption<any>(args, "contents");
    if (contentsOpt) {
      const contents: Record<string, any> = {};
      if (contentsOpt.text !== undefined) contents.text = contentsOpt.text;
      if (contentsOpt.highlights !== undefined) contents.highlights = contentsOpt.highlights;
      if (contentsOpt.summary !== undefined) contents.summary = contentsOpt.summary;
      if (Object.keys(contents).length > 0) body.contents = contents;
    }

    const response = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        content: `Exa Search API error: ${response.status} ${response.statusText} — ${errorText.slice(0, 500)}`,
        isError: true,
      };
    }

    const data = await response.json();
    const results = data.results || [];

    if (results.length === 0) {
      return { content: "No search results found.", isError: false };
    }

    const formatted = results
      .map((r: any, i: number) => {
        const parts: string[] = [];
        parts.push(`${i + 1}. **${r.title || "(no title)"}**`);
        parts.push(`   ${r.url}`);

        // Highlights are the best Exa-specific feature for quick scanning
        if (r.highlights && r.highlights.length > 0) {
          for (const h of r.highlights) {
            parts.push(`   > ${h}`);
          }
        } else if (r.summary) {
          parts.push(`   ${r.summary}`);
        } else if (r.text) {
          // Fall back to first 200 chars of extracted text
          parts.push(`   ${(r.text as string).slice(0, 200)}...`);
        }

        // Optional metadata
        const meta: string[] = [];
        if (r.publishedDate) meta.push(r.publishedDate.slice(0, 10));
        if (r.author) meta.push(r.author.split(",")[0].trim());
        if (meta.length > 0) {
          parts.push(`   — ${meta.join(", ")}`);
        }

        return parts.join("\n");
      })
      .join("\n\n");

    return { content: formatted, isError: false };
  } catch (e: any) {
    return { content: `Exa Search failed: ${e.message}`, isError: true };
  }
}

async function executeTavilySearch(
  args: Record<string, any>,
  signal?: AbortSignal,
): Promise<{ content: string; isError: boolean }> {
  const apiKey = await getTavilyApiKey();
  if (!apiKey) {
    return {
      content:
        "Tavily Search is unavailable: no API key configured. Add one in Settings or set the TAVILY_API_KEY environment variable.",
      isError: true,
    };
  }

  const query = args.query;
  if (!query) {
    return { content: "Missing required parameter: query", isError: true };
  }

  const maxResults = Math.min(20, Math.max(1, args.count || 5));

  try {
    const body: Record<string, any> = {
      query,
      max_results: maxResults,
      search_depth: pickAllowedString(pickOption<string>(args, "searchDepth"), TAVILY_SEARCH_DEPTHS, "basic"),
    };

    const topic = pickAllowedString(pickOption<string>(args, "topic"), TAVILY_TOPICS);
    if (topic) body.topic = topic;

    const timeRange = pickAllowedString(pickOption<string>(args, "timeRange"), TAVILY_TIME_RANGES);
    if (timeRange) body.time_range = timeRange;

    const startDate = normalizeString(args.startDate) || normalizeString(args.startPublishedDate);
    const endDate = normalizeString(args.endDate) || normalizeString(args.endPublishedDate);
    const includeDomains = normalizeStringArray(args.includeDomains);
    const excludeDomains = normalizeStringArray(args.excludeDomains);
    const includeAnswer = pickAllowedBooleanOrString(pickOption<boolean | string>(args, "includeAnswer"), TAVILY_ANSWER_MODES);
    const includeRawContent = pickAllowedBooleanOrString(pickOption<boolean | string>(args, "includeRawContent"), TAVILY_RAW_CONTENT_MODES);
    if (startDate) body.start_date = startDate;
    if (endDate) body.end_date = endDate;
    if (includeDomains) body.include_domains = includeDomains;
    if (excludeDomains) body.exclude_domains = excludeDomains;
    if (includeAnswer !== undefined) body.include_answer = includeAnswer;
    if (includeRawContent !== undefined) body.include_raw_content = includeRawContent;

    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        content: `Tavily Search API error: ${response.status} ${response.statusText} — ${errorText.slice(0, 500)}`,
        isError: true,
      };
    }

    const data = await response.json();
    const results = data.results || [];
    const sections: string[] = [];

    if (data.answer) {
      sections.push(`Answer: ${data.answer}`);
    }

    if (results.length > 0) {
      sections.push(results
        .map((r: any, i: number) => {
          const parts: string[] = [];
          parts.push(`${i + 1}. **${r.title || "(no title)"}**`);
          parts.push(`   ${r.url}`);

          const content = r.content || r.raw_content;
          if (content) {
            parts.push(`   ${String(content).slice(0, 1000)}`);
          }

          const meta: string[] = [];
          if (typeof r.score === "number") meta.push(`score ${r.score.toFixed(3)}`);
          if (r.published_date) meta.push(String(r.published_date).slice(0, 10));
          if (meta.length > 0) parts.push(`   — ${meta.join(", ")}`);

          return parts.join("\n");
        })
        .join("\n\n"));
    }

    if (sections.length === 0) {
      return { content: "No search results found.", isError: false };
    }

    return { content: sections.join("\n\n"), isError: false };
  } catch (e: any) {
    return { content: `Tavily Search failed: ${e.message}`, isError: true };
  }
}

// --- web_fetch ---

async function executeWebFetch(
  args: Record<string, any>,
  signal?: AbortSignal,
): Promise<{ content: string; isError: boolean }> {
  const urlStr = args.url;
  if (!urlStr) {
    return { content: "Missing required parameter: url", isError: true };
  }

  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlStr);
  } catch {
    return { content: `Invalid URL: ${urlStr}`, isError: true };
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return {
      content: `Unsupported protocol: ${parsedUrl.protocol} — only http and https are supported`,
      isError: true,
    };
  }

  const timeoutMs = (Math.min(60, Math.max(5, args.timeout || 30))) * 1000;
  const raw = args.raw === true;
  const offset = Math.max(0, args.offset || 0);
  const limit = Math.min(50_000, Math.max(1_000, args.limit || PREVIEW_LENGTH));
  const hash = urlToHash(`${urlStr}\0raw=${raw}`);
  const cachedPath = join(WEB_CACHE_DIR, `${hash}.md`);

  try {
    const manifest = await loadManifest();
    const entry = manifest[hash];
    if (entry && Date.now() - entry.fetchedAt <= CACHE_TTL_MS) {
      const markdown = await readFile(cachedPath, "utf-8");
      return { content: formatWebFetchSlice(markdown, urlStr, offset, limit, true), isError: false };
    }
  } catch {
    // Missing or corrupt cache entries are treated as a normal cache miss.
  }

  const chromePath = findChromePath();
  if (!chromePath) {
    return {
      content: "No Chrome/Chromium installation found. Install Google Chrome or Chromium to use web_fetch.",
      isError: true,
    };
  }

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  let onAbort: (() => void) | undefined;
  try {
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
    });

    const page = await browser.newPage();
    onAbort = () => { void browser?.close(); };
    signal?.addEventListener("abort", onAbort, { once: true });

    // Block image/media requests to avoid base64-encoded content bloating the output
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (type === "image" || type === "media" || type === "font") {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    );

    await page.goto(urlStr, {
      waitUntil: "networkidle2",
      timeout: timeoutMs,
    });

    const html = await page.content();
    signal?.removeEventListener("abort", onAbort);
    onAbort = undefined;
    await browser.close();
    browser = null;

    // Parse with linkedom
    const { document } = parseHTML(html);

    let contentHtml: string;
    let title = "";

    if (!raw) {
      // Try Readability extraction
      const reader = new Readability(document as any);
      const article = reader.parse();

      if (article && article.content) {
        title = article.title || "";
        contentHtml = article.content;
      } else {
        // Readability failed, fall back to body
        contentHtml = document.body?.innerHTML || html;
      }
    } else {
      contentHtml = document.body?.innerHTML || html;
    }

    // Strip img tags to avoid base64 data URIs bloating output
    contentHtml = contentHtml.replace(/<img[^>]*>/gi, "");

    // Convert to markdown
    const turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    });
    let markdown = turndown.turndown(contentHtml);

    // Prepend title if we have one
    if (title) {
      markdown = `# ${title}\n\n${markdown}`;
    }

    // Truncate at hard cap (safety limit)
    if (markdown.length > MAX_CONTENT_LENGTH) {
      markdown = markdown.slice(0, MAX_CONTENT_LENGTH);
    }

    // Cache + progressive disclosure for large pages
    if (markdown.length > PREVIEW_LENGTH || offset > 0) {
      // Save full content to cache
      await mkdir(WEB_CACHE_DIR, { recursive: true });
      await writeFile(cachedPath, markdown, "utf-8");

      // Update manifest
      await updateManifest((manifest) => {
        manifest[hash] = { url: urlStr, hash, fetchedAt: Date.now(), charCount: markdown.length };
      });

      // Run cleanup asynchronously (non-blocking)
      cleanupOldCache().catch(() => {});

      return { content: formatWebFetchSlice(markdown, urlStr, offset, limit, false), isError: false };
    }

    // Small content — return inline, no cache needed
    return { content: markdown, isError: false };
  } catch (e: any) {
    return { content: `Web fetch failed: ${e.message}`, isError: true };
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
}

function formatWebFetchSlice(markdown: string, url: string, offset: number, limit: number, cached: boolean): string {
  const start = Math.min(offset, markdown.length);
  const end = Math.min(markdown.length, start + limit);
  const header = `[web_fetch${cached ? " cached" : ""}] ${url}\nCharacters ${start}-${end} of ${markdown.length}`;
  const next = end < markdown.length
    ? `\n\n---\nCall web_fetch again with the same URL and offset=${end} to continue.`
    : "";
  return `${header}\n\n${markdown.slice(start, end)}${next}`;
}
