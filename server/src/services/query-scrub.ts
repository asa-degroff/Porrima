/**
 * Operational-noise scrub for retrieval queries.
 *
 * Strips file paths, API routes, tool-call names, code blocks, and other
 * operational residue from conversation text, leaving topic words. Paths
 * and routes are reduced to their topic-bearing tail, not deleted
 * wholesale.
 *
 * Leaf module: shared by the passive-recall query builders and the
 * memory-context rerank query without creating an import cycle.
 */
const OPERATIONAL_FILE_EXTENSIONS =
  "ts|tsx|js|jsx|mjs|cjs|md|json|service|db|sqlite|py|rs|go|css|html|yml|yaml|toml|sql|sh";

const TOOL_OR_COMMAND_NAMES = new RegExp(
  "\\b(?:" + [
    "ask_user",
    "apply_patch",
    "exec_command",
    "read_file",
    "write_file",
    "edit_file",
    "list_files",
    "bash",
    "web_search",
    "web_fetch",
    "search_memory",
    "save_memory",
    "read_memory_block",
    "create_memory_block",
    "create_artifact",
  ].join("|") + ")\\b",
  "gi",
);

function anchorToTopicWords(anchor: string): string {
  const cleaned = anchor
    .replace(/^[`"'\s]+|[`"',\s]+$/g, "")
    .replace(/[{}[\]()]/g, " ")
    .trim();
  if (!cleaned) return "";

  const segments = cleaned.split(/[\\/]+/).filter(Boolean);
  let value = segments.length > 0 ? segments[segments.length - 1] : cleaned;
  if (/^\/?(?:api|v\d)\//i.test(cleaned) && segments.length > 0) {
    value = segments.slice(-2).join(" ");
  }

  return value
    .replace(new RegExp(`\\.(${OPERATIONAL_FILE_EXTENSIONS})\\b`, "gi"), " ")
    .replace(/[-_.:]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b(?:api|dist|src|server|client|routes|services|components|hooks|lib|utils|v\d)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function replaceOperationalAnchor(anchor: string): string {
  const topicWords = anchorToTopicWords(anchor);
  return topicWords.length >= 3 ? ` ${topicWords} ` : " ";
}

export function scrubOperationalNoise(text: string | undefined): string {
  if (!text) return "";
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, " ")
    .replace(/`([^`\n]{2,160})`/g, (_match, inner: string) => {
      return /[\\/]|\.|_|-|^\/(?:api|v\d)\//i.test(inner)
        ? replaceOperationalAnchor(inner)
        : ` ${inner} `;
    })
    .replace(new RegExp(`\\b[\\w./-]+\\.(${OPERATIONAL_FILE_EXTENSIONS})\\b`, "gi"), replaceOperationalAnchor)
    .replace(/\/(?:api|v\d)\/[\w./:-]+/gi, replaceOperationalAnchor)
    .replace(/(?:^|\s)(?:\.{0,2}\/|~\/|\/)[\w./-]+/g, replaceOperationalAnchor)
    .replace(/\b(?:path|command|cmd|file|filename)=\S+/gi, " ")
    .replace(/"(?:path|command|cmd|file|filename)"\s*:\s*"[^"]*"/gi, " ")
    .replace(TOOL_OR_COMMAND_NAMES, " ")
    .replace(/[{}[\]"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

