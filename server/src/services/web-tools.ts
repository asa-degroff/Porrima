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
      await saveManifest(manifest);
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
    "Search the web. Uses the configured default provider unless provider is supplied as an override. Supports Brave Search, Exa, and Tavily.",
  parameters: Type.Object({
    query: Type.String({ description: "Search query" }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results (1-20, default 5)",
        minimum: 1,
        maximum: 20,
      })
    ),
    provider: Type.Optional(Type.String({ description: "Optional provider override: brave, exa, or tavily. Omit to use the configured default. Use the bare value, not a quoted string." })),
    // Exa-specific parameters (only effective when provider is "exa")
    searchType: Type.Optional(Type.String({ description: "Exa search type: auto, neural, keyword, hybrid, fast, deep, deep-lite, deep-reasoning, magic, instant (default: auto)" })),
    contents: Type.Optional(
      Type.Object({
        text: Type.Optional(Type.Any({ description: "true or object with includeHtmlTags/maxCharacters" })),
        highlights: Type.Optional(Type.Any({ description: "object with maxCharacters and optional query" })),
        summary: Type.Optional(Type.Boolean()),
      })
    ),
    startPublishedDate: Type.Optional(
      Type.String({ description: "Exa/Tavily: earliest publication or update date (YYYY-MM-DD)" })
    ),
    endPublishedDate: Type.Optional(
      Type.String({ description: "Exa/Tavily: latest publication or update date (YYYY-MM-DD)" })
    ),
    includeDomains: Type.Optional(
      Type.Array(Type.String(), { description: "Exa/Tavily: domains to include in results" })
    ),
    excludeDomains: Type.Optional(
      Type.Array(Type.String(), { description: "Tavily only: domains to exclude from results" })
    ),
    // Tavily-specific parameters (only effective when provider is "tavily")
    searchDepth: Type.Optional(
      Type.String({ description: "Tavily search depth: basic, advanced, fast, ultra-fast (default: basic). Use the bare value, not a quoted string." })
    ),
    topic: Type.Optional(
      Type.String({ description: "Tavily topic: general, news, or finance (default: general). Use the bare value, not a quoted string." })
    ),
    timeRange: Type.Optional(
      Type.String({ description: "Tavily time range filter: day/week/month/year or d/w/m/y. Use the bare value, not a quoted string." })
    ),
    includeAnswer: Type.Optional(
      Type.Any({ description: "Tavily only: include an LLM-generated answer. Boolean, basic, or advanced. False by default." })
    ),
    includeRawContent: Type.Optional(
      Type.Any({ description: "Tavily only: include cleaned page content. Boolean, markdown, or text. Can increase latency and result size." })
    ),
  }),
};

const WEB_FETCH_TOOL: Tool = {
  name: "web_fetch",
  description:
    "Fetch a web page, save its full content to a cached file, and return a preview (first ~10K chars) with the file path and total size. Uses a headless browser to render JavaScript. By default, extracts the main article content; set raw=true to get the full page.",
  parameters: Type.Object({
    url: Type.String({ description: "URL to fetch (http or https)" }),
    timeout: Type.Optional(
      Type.Number({
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
  }),
};

export const WEB_TOOLS: Tool[] = [WEB_SEARCH_TOOL, WEB_FETCH_TOOL];

// --- Execution ---

export async function executeWebTool(
  toolCall: ToolCall
): Promise<{ content: string; isError: boolean }> {
  switch (toolCall.name) {
    case "web_search":
      return executeWebSearch(toolCall.arguments);
    case "web_fetch":
      return executeWebFetch(toolCall.arguments);
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
  args: Record<string, any>
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
    return executeExaSearch(args);
  }
  if (provider === "tavily") {
    return executeTavilySearch(args);
  }

  return executeBraveSearch(args);
}

async function executeBraveSearch(
  args: Record<string, any>
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
  args: Record<string, any>
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
      type: normalizeString(args.searchType) || "auto",
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
    if (args.contents) {
      const contents: Record<string, any> = {};
      if (args.contents.text !== undefined) contents.text = args.contents.text;
      if (args.contents.highlights !== undefined) contents.highlights = args.contents.highlights;
      if (args.contents.summary !== undefined) contents.summary = args.contents.summary;
      if (Object.keys(contents).length > 0) body.contents = contents;
    }

    const response = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(body),
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
  args: Record<string, any>
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
      search_depth: pickAllowedString(args.searchDepth, TAVILY_SEARCH_DEPTHS, "basic"),
    };

    const topic = pickAllowedString(args.topic, TAVILY_TOPICS);
    if (topic) body.topic = topic;

    const timeRange = pickAllowedString(args.timeRange, TAVILY_TIME_RANGES);
    if (timeRange) body.time_range = timeRange;

    const startDate = normalizeString(args.startDate) || normalizeString(args.startPublishedDate);
    const endDate = normalizeString(args.endDate) || normalizeString(args.endPublishedDate);
    const includeDomains = normalizeStringArray(args.includeDomains);
    const excludeDomains = normalizeStringArray(args.excludeDomains);
    const includeAnswer = pickAllowedBooleanOrString(args.includeAnswer, TAVILY_ANSWER_MODES);
    const includeRawContent = pickAllowedBooleanOrString(args.includeRawContent, TAVILY_RAW_CONTENT_MODES);
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
  args: Record<string, any>
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

  const chromePath = findChromePath();
  if (!chromePath) {
    return {
      content:
        "No Chrome/Chromium installation found. Install Google Chrome or Chromium to use web_fetch.",
      isError: true,
    };
  }

  const timeoutMs = (Math.min(60, Math.max(5, args.timeout || 30))) * 1000;
  const raw = args.raw === true;

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
    });

    const page = await browser.newPage();

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
    if (markdown.length > PREVIEW_LENGTH) {
      const hash = urlToHash(urlStr);
      const filePath = join(WEB_CACHE_DIR, `${hash}.md`);

      // Save full content to cache
      await mkdir(WEB_CACHE_DIR, { recursive: true });
      await writeFile(filePath, markdown, "utf-8");

      // Update manifest
      const manifest = await loadManifest();
      manifest[hash] = { url: urlStr, hash, fetchedAt: Date.now(), charCount: markdown.length };
      await saveManifest(manifest);

      // Run cleanup asynchronously (non-blocking)
      cleanupOldCache().catch(() => {});

      const preview = markdown.slice(0, PREVIEW_LENGTH);
      return {
        content:
          `[web_fetch] Saved to: ${filePath}\n` +
          `  URL: ${urlStr}\n` +
          `  Total: ${markdown.length.toLocaleString()} characters\n\n` +
          preview +
          `\n\n---\n` +
          `Use read_file(path="${filePath}", offset=N) to read more.\n` +
          `The cached file contains all ${markdown.length.toLocaleString()} characters.`,
        isError: false,
      };
    }

    // Small content — return inline, no cache needed
    return { content: markdown, isError: false };
  } catch (e: any) {
    return { content: `Web fetch failed: ${e.message}`, isError: true };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
}
