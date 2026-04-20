import { Type } from "@sinclair/typebox";
import type { Tool, ToolCall } from "@mariozechner/pi-ai";
import puppeteer from "puppeteer-core";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { parseHTML } from "linkedom";
import { existsSync } from "fs";
import { getSettings } from "./chat-storage.js";

const MAX_CONTENT_LENGTH = 50_000;

// --- Chrome path discovery ---

function findChromePath(): string | null {
  const candidates = [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

// --- Tool definitions ---

const WEB_SEARCH_TOOL: Tool = {
  name: "web_search",
  description:
    "Search the web. Supports Brave Search and Exa as providers. Brave returns simple snippets; Exa supports rich content extraction (highlights, summaries), date/domain filters, and deep reasoning search.",
  parameters: Type.Object({
    query: Type.String({ description: "Search query" }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results (1-20, default 5)",
        minimum: 1,
        maximum: 20,
      })
    ),
    provider: Type.Optional(Type.String({ description: "Search provider: 'brave' or 'exa' (default: brave)" })),
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
      Type.String({ description: "Exa only: earliest publication date (YYYY-MM-DD)" })
    ),
    endPublishedDate: Type.Optional(
      Type.String({ description: "Exa only: latest publication date (YYYY-MM-DD)" })
    ),
    includeDomains: Type.Optional(
      Type.Array(Type.String(), { description: "Exa only: domains to include in results" })
    ),
  }),
};

const WEB_FETCH_TOOL: Tool = {
  name: "web_fetch",
  description:
    "Fetch a web page and return its content as markdown. Uses a headless browser to render JavaScript. By default, extracts the main article content; set raw=true to get the full page.",
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

async function executeWebSearch(
  args: Record<string, any>
): Promise<{ content: string; isError: boolean }> {
  const provider = args.provider || "brave";

  if (provider === "exa") {
    return executeExaSearch(args);
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
      type: args.searchType || "auto",
    };

    // Exa-specific filters
    if (args.startPublishedDate) body.startPublishedDate = args.startPublishedDate;
    if (args.endPublishedDate) body.endPublishedDate = args.endPublishedDate;
    if (args.includeDomains && args.includeDomains.length > 0) body.includeDomains = args.includeDomains;

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

    // Truncate if needed
    if (markdown.length > MAX_CONTENT_LENGTH) {
      markdown =
        markdown.slice(0, MAX_CONTENT_LENGTH) +
        "\n\n...(content truncated at 50,000 characters)";
    }

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
