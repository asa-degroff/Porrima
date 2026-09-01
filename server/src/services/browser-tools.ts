import { Type, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import {
  getBrowserSession,
  navigateTo,
  snapshotPage,
  clickRef,
  typeIntoRef,
  hoverRef,
  screenshotPage,
  drainDialogNotes,
  formatElementLine,
  DEFAULT_VIEWPORT,
} from "./browser-session.js";

const BROWSER_NAVIGATE_TOOL: Tool = {
  name: "browser_navigate",
  description:
    "Open a URL in this chat's browser session (launched on first use) and return the page title plus a compact element snapshot with [eN] refs.",
  parameters: Type.Object({
    url: Type.String({ description: "URL to open (http or https)" }),
    timeout: Type.Optional(Type.Integer({ description: "Navigation timeout in seconds (5-60, default 30)", minimum: 5, maximum: 60 })),
  }),
};

const BROWSER_SNAPSHOT_TOOL: Tool = {
  name: "browser_snapshot",
  description:
    "List the interactive elements on the current page with [eN] refs used by browser_click/browser_type. Re-run after the page changes — refs from older snapshots are invalid.",
  parameters: Type.Object({
    query: Type.Optional(Type.String({ description: "Only include elements whose name, role, or URL contains this text" })),
    limit: Type.Optional(Type.Integer({ description: "Max elements to return (default 120, max 300)", minimum: 10, maximum: 300 })),
  }),
};

const BROWSER_CLICK_TOOL: Tool = {
  name: "browser_click",
  description:
    "Click an element by its [eN] ref from the most recent browser_snapshot/browser_navigate result.",
  parameters: Type.Object({
    ref: Type.Integer({ description: "Element ref number (the N in [eN])" }),
  }),
};

const BROWSER_HOVER_TOOL: Tool = {
  name: "browser_hover",
  description:
    "Move the pointer over an element by its [eN] ref and leave it there — no click. Use for hover-driven UI (menus, popups, tooltips). The pointer stays until the next click/type/hover, and the hover may reveal elements — call browser_snapshot afterwards to get refs for what it revealed.",
  parameters: Type.Object({
    ref: Type.Integer({ description: "Element ref number (the N in [eN])" }),
  }),
};

const BROWSER_TYPE_TOOL: Tool = {
  name: "browser_type",
  description:
    "Set the text of an input or textarea by its [eN] ref (replaces any existing value), then optionally press Enter.",
  parameters: Type.Object({
    ref: Type.Integer({ description: "Element ref number (the N in [eN])" }),
    text: Type.String({ description: "Text to enter" }),
    submit: Type.Optional(Type.Boolean({ description: "Press Enter after typing (default false)" })),
  }),
};

const BROWSER_SCREENSHOT_TOOL: Tool = {
  name: "browser_screenshot",
  description:
    "Capture the current page as an image for visual verification. Prefer browser_snapshot for reading or interacting — it is cheaper and more precise.",
  parameters: Type.Object({
    fullPage: Type.Optional(Type.Boolean({ description: "Capture the entire scrollable page instead of the viewport (default false)" })),
  }),
};

export const BROWSER_TOOLS: Tool[] = [
  BROWSER_NAVIGATE_TOOL,
  BROWSER_SNAPSHOT_TOOL,
  BROWSER_CLICK_TOOL,
  BROWSER_HOVER_TOOL,
  BROWSER_TYPE_TOOL,
  BROWSER_SCREENSHOT_TOOL,
];

type ToolOutcome = { content: string | any[]; isError: boolean };

export async function executeBrowserTool(
  toolCall: ToolCall,
  chatId: string,
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  if (signal?.aborted) return { content: "Browser tool call was cancelled.", isError: true };
  try {
    switch (toolCall.name) {
      case "browser_navigate":
        return await executeNavigate(toolCall.arguments, chatId);
      case "browser_snapshot":
        return await executeSnapshot(toolCall.arguments, chatId);
      case "browser_click":
        return await executeClick(toolCall.arguments, chatId);
      case "browser_hover":
        return await executeHover(toolCall.arguments, chatId);
      case "browser_type":
        return await executeType(toolCall.arguments, chatId);
      case "browser_screenshot":
        return await executeScreenshot(toolCall.arguments, chatId);
      default:
        return { content: `Unknown browser tool: ${toolCall.name}`, isError: true };
    }
  } catch (e: any) {
    return { content: `Browser tool failed: ${e.message}`, isError: true };
  }
}

async function executeNavigate(args: Record<string, any>, chatId: string): Promise<ToolOutcome> {
  const url = String(args.url ?? "");
  if (!/^https?:\/\//i.test(url)) {
    return { content: "browser_navigate requires an http:// or https:// URL.", isError: true };
  }
  const session = await getBrowserSession(chatId);
  const timeoutMs = (args.timeout ?? 30) * 1000;
  const { finalUrl } = await navigateTo(session, url, timeoutMs);
  const snapshot = await snapshotPage(session, undefined, 60);
  return {
    content: `Opened ${finalUrl}\n\n${snapshot.text}${drainDialogNotes(session)}`,
    isError: false,
  };
}

async function executeSnapshot(args: Record<string, any>, chatId: string): Promise<ToolOutcome> {
  const session = await getBrowserSession(chatId);
  const snapshot = await snapshotPage(session, args.query, args.limit);
  return { content: `${snapshot.text}${drainDialogNotes(session)}`, isError: false };
}

async function executeClick(args: Record<string, any>, chatId: string): Promise<ToolOutcome> {
  const ref = Number(args.ref);
  if (!Number.isInteger(ref) || ref < 1) {
    return { content: "browser_click requires a positive integer ref from browser_snapshot.", isError: true };
  }
  const session = await getBrowserSession(chatId);
  const result = await clickRef(session, ref);
  const lines = [`Clicked ${result.clicked}`];
  if (result.urlAfter !== result.urlBefore) {
    lines.push(`Navigated to ${result.urlAfter} — "${result.title}"`);
  } else {
    lines.push(`Still on ${result.urlAfter}`);
  }
  if (result.switchedPage) {
    lines.push("A new tab opened; it is now the active page.");
  }
  lines.push("The element refs are now stale — call browser_snapshot before further interaction.");
  return { content: `${lines.join("\n")}${drainDialogNotes(session)}`, isError: false };
}

async function executeHover(args: Record<string, any>, chatId: string): Promise<ToolOutcome> {
  const ref = Number(args.ref);
  if (!Number.isInteger(ref) || ref < 1) {
    return { content: "browser_hover requires a positive integer ref from browser_snapshot.", isError: true };
  }
  const session = await getBrowserSession(chatId);
  const { descriptor } = await hoverRef(session, ref);
  const lines = [
    `Pointer is over ${formatElementLine(descriptor)} and stays there until the next click/type/hover.`,
    "Refs are stale — if the hover revealed elements, call browser_snapshot to get refs for them.",
  ];
  return { content: `${lines.join("\n")}${drainDialogNotes(session)}`, isError: false };
}

async function executeType(args: Record<string, any>, chatId: string): Promise<ToolOutcome> {
  const ref = Number(args.ref);
  if (!Number.isInteger(ref) || ref < 1) {
    return { content: "browser_type requires a positive integer ref from browser_snapshot.", isError: true };
  }
  const session = await getBrowserSession(chatId);
  const text = String(args.text ?? "");
  const result = await typeIntoRef(session, ref, text, args.submit === true);
  const lines = [`Typed "${text.length > 60 ? text.slice(0, 60) + "…" : text}" into ${result.typed}`];
  if (result.submitted) {
    lines.push(`Pressed Enter. Now on ${session.page.url()} — refs are stale; call browser_snapshot before further interaction.`);
  }
  return { content: `${lines.join("\n")}${drainDialogNotes(session)}`, isError: false };
}

async function executeScreenshot(args: Record<string, any>, chatId: string): Promise<ToolOutcome> {
  const session = await getBrowserSession(chatId);
  const shot = await screenshotPage(session, args.fullPage === true);
  const label = `Screenshot of ${shot.url} — "${shot.title}" (${shot.width}x${shot.height}, ${args.fullPage ? "full page" : `viewport ${DEFAULT_VIEWPORT.width}x${DEFAULT_VIEWPORT.height}`})`;
  const content: any[] = [
    { type: "text", text: `${label}${drainDialogNotes(session)}` },
    { type: "image", data: shot.data, mimeType: shot.mimeType, name: "browser-screenshot" },
  ];
  return { content, isError: false };
}
