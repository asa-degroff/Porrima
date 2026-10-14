/**
 * Code search — structural code navigation via ast-grep.
 *
 * docs/design/code-search.md (Phase 0 — model-level tool; Phase 1 adds the
 * kernel projection over this same executor).
 *
 * Execution: in-process `@ast-grep/napi` (version-pinned in server/package.json)
 * — no subprocess, no shell-quoting surface. Local workspaces only (Phase 0);
 * the remote carve-out (adapter-read + in-process parse) is Phase 2.
 *
 * Runtime-pinned (probed 10-13 against @ast-grep/napi@0.50.0, this machine):
 * - `sg.Lang` is a compile-side enum, empty at runtime — language arguments
 *   are plain strings, case-insensitive.
 * - **The napi supports exactly FIVE languages in 0.50.0**: typescript, tsx,
 *   javascript (jsx alias), html, css. `parse("python", …)` throws
 *   "python is not supported in napi"; `parseFiles` SILENTLY SKIPS files whose
 *   extension infers an unsupported language (no callback, no error). The CLI
 *   supports 28 languages (reference/languages) — the broader table applies to
 *   the CLI fallback path, not this executor.
 * - Match nodes carry no file path — it lives at `node.getRoot().filename()`
 *   (absolute when the scan scope is absolute; relative to CWD otherwise).
 * - `range()` is 0-based; the model-facing text is 1-based (CLI semantics).
 * - `pattern()` NEVER throws on bad syntax — tree-sitter error tolerance
 *   carries garbage patterns through and they match nothing. The CLI's
 *   referee behavior (probed 10-13): `;;;` → exit 8 "Cannot parse query";
 *   `function (unclosed` → WARNING + 0 matches; `function $NAME` (a partial
 *   pattern — it parses with a trailing ERROR node) → ACCEPTED, matches.
 *   The executor mirrors this: it rejects only the empty/trivial class (no
 *   code content), and `foreignTokensIn` catches the "not this language at
 *   all" class (concrete tokens that are keywords of another supported
 *   language) — explicit lang: a hard error; auto-detect: a per-file
 *   parse-error entry, other files still match.
 * - Multi-element bindings include separator nodes; `join("")` reconstructs
 *   the original source span. `getMatch(name)` returns the single-binding
 *   node; `getMultipleMatches(name)` the multi-element list.
 * - `findInFiles`/`parseFiles` honor `.gitignore` (same ignore crate as the
 *   CLI); explicitly-requested paths override ignores.
 * - The callback fires once per file WITH matches (or per error); the promise
 *   resolves to a file count. There is no files-searched figure at this
 *   boundary — the summary counts files-with-matches.
 * - tree-sitter is error-tolerant: broken files still parse (ERROR nodes),
 *   invalid UTF-8 files are skipped silently — the zero-match scope note and
 *   the parse-error note cover both.
 * - ast-grep patterns must be COMPLETE syntax units: `function $NAME($$$ARGS)
 *   { $$$ }` matches; `function $NAME($$$ARGS)` (no body) matches nothing.
 * - `context` is NOT in the Phase 0 schema (open Q1 unsettled — an
 *   unimplemented parameter would be a trap; the index-not-payload rendering
 *   stands on its own).
 */
import { createRequire } from "module";
import { access } from "fs/promises";
import { isAbsolute, relative, resolve } from "path";
import { minimatch } from "minimatch";
import type { WorkspaceAdapter } from "./workspace.js";

// The napi package is a native addon — load it lazily and only when the flag
// is on, so the dark path never touches it (and the musl/arm64 hosts without
// prebuilds (§5 Risk 3) don't pay at import time).
const requireNapi = createRequire(import.meta.url);
let napiModule: any | null = null;
function sg(): any {
  if (!napiModule) napiModule = requireNapi("@ast-grep/napi");
  return napiModule;
}

export function codeSearchEnabled(): boolean {
  return process.env.PORRIMA_CODE_SEARCH === "1";
}

// --- Languages: the napi's actual support set (verified 10-13) ---

export const NAPI_LANGUAGES = ["typescript", "tsx", "javascript", "html", "css"] as const;

// Alias → canonical napi language, case-insensitive lookup. The CLI's 28-
// language table (ast-grep.github.io/reference/languages) does NOT apply here
// — see the header pin.
export const LANGUAGE_ALIASES: Record<string, string> = {
  ts: "typescript",
  typescript: "typescript",
  tsx: "tsx",
  js: "javascript",
  javascript: "javascript",
  jsx: "javascript",
  html: "html",
  css: "css",
};

// --- Types ---

export interface CodeSearchMatch {
  file: string; // workspace-relative
  start: { line: number; column: number }; // 1-based
  end: { line: number; column: number }; // 1-based
  text: string; // the matched node's source text
  metaVariables?: Record<string, string>; // single + multi, flattened
}

export interface CodeSearchParams {
  pattern: string;
  path?: string; // workspace-relative root; default = workspace root
  globs?: string[]; // gitignore-glob semantics; "!" prefix excludes; later wins
  lang?: string; // napi language alias; default = auto-detect per file
  maxMatches?: number;
  skip?: number; // pagination (open question 8)
}

export interface CodeSearchResult {
  matches: CodeSearchMatch[]; // the page returned (after skip + maxMatches)
  totalMatches: number; // all matches found (pre-pagination)
  filesWithMatches: number;
  text: string; // model-level text projection
  parseErrors: { file: string; message: string }[]; // capped list
  parseErrorsTotal: number;
  truncated: boolean;
}

export class CodeSearchError extends Error {}

// --- Budgets (server-side — §4.9: the caller cannot be trusted to count) ---

const DEFAULT_MAX_MATCHES = 50;
const MAX_MAX_MATCHES = 1000;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CHARS = 20_000;
const PARSE_ERROR_LIST_CAP = 10;
const BINDING_RENDER_CAP = 60;
const LINE_RENDER_CAP = 200;

function maxCharsFromEnv(): number {
  const v = Number(process.env.PORRIMA_CODE_SEARCH_MAX_CHARS);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_MAX_CHARS;
}
function timeoutFromEnv(): number {
  const v = Number(process.env.PORRIMA_CODE_SEARCH_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_TIMEOUT_MS;
}

// --- Pattern pre-validation ---

/**
 * The cheap half of the guard (§3.2): reject classic regex shapes BEFORE
 * calling the engine, with a hint toward rg. Deliberately narrow — anchors
 * are excluded ($NAME is a metavariable, a stray ^ is caught downstream) —
 * the ERROR-node walk is the real validator; this heuristic just saves a
 * round-trip and points the model at the right tool.
 */
const REGEX_SHAPE_RE = /\\[wdsb]|\.\\?\*|\||\[[^\]]*-[^\]]*\]/;
export function regexShapeHint(pattern: string): string | null {
  return REGEX_SHAPE_RE.test(pattern)
    ? "ast-grep patterns are code, not regex — for text search use `rg` via bash."
    : null;
}

// Leaf kinds the grammar had no specific keyword slot for — a concrete token
// parsed in one of these is a plain name, not a keyword of THAT language.
const IDENTIFIERISH_KINDS = new Set([
  "identifier",
  "type_identifier",
  "property_identifier",
  "tag_name",
]);

/**
 * The real validator the napi lacks, calibrated against the CLI's referee
 * behavior AND the probe trees (10-13). ERROR-node presence is NOT the
 * signal — `function $NAME` parses in TS as one ERROR wrapper and is the
 * flagship matching pattern; `function (unclosed` is 100% ERROR and must
 * stay a clean 0-match; `interface $NAME { $$ }` parses in TS with zero
 * ERRORs. The signal is KEYWORD FOREIGNNESS: a concrete (non-metavariable)
 * token that is a named keyword of another napi-supported language but
 * gets demoted to a generic identifier in `lang` — the pattern was written
 * for a different language. Pinned cases:
 *   `function $NAME` in css        → identifier "function" (TS keyword) → foreign
 *   `interface $NAME { $$ }` css  → tag_name "interface" (TS keyword)  → foreign
 *   `function $NAME` in ts         → "function" is an anonymous TS keyword → not foreign
 *   `function (unclosed` in ts     → "unclosed" is a name in no language → not foreign
 * Returns the offending tokens (empty = valid in `lang`).
 */
export function foreignTokensIn(lang: string, pattern: string): string[] {
  const s = sg();
  let root: any;
  try {
    root = s.parse(lang, pattern).root();
  } catch {
    return [];
  }
  const found: string[] = [];
  const seen = new Set<string>();
  const stack: any[] = [root];
  while (stack.length > 0) {
    const n = stack.pop();
    let children: any[] = [];
    try {
      children = n.children() ?? [];
    } catch {
      continue;
    }
    if (children.length > 0) {
      for (const c of children) stack.push(c);
      continue;
    }
    // Leaf: does this concrete name belong to another supported language?
    if (!IDENTIFIERISH_KINDS.has(String(n.kind()))) continue;
    let text = "";
    try {
      text = String(n.text()).trim();
    } catch {
      continue;
    }
    if (!text || text.startsWith("$") || seen.has(text)) continue;
    for (const other of NAPI_LANGUAGES) {
      if (other === lang) continue;
      let kind = 0;
      try {
        kind = s.kind(other, text as never);
      } catch {
        kind = 0; // not a named token in that language
      }
      if (kind !== 0) {
        seen.add(text);
        found.push(text);
        break;
      }
    }
  }
  return found;
}

// Binding names in a pattern: $NAME (single, 1 dollar) and $$$NAME (list, 3+).
// Two dollars ($$NAME) is the identifier trap — it never names a binding.
function bindingSpecs(pattern: string): { name: string; multi: boolean }[] {
  const seen = new Map<string, boolean>();
  for (const m of pattern.matchAll(/(\$+)([A-Za-z_]\w*)/g)) {
    const multi = m[1].length >= 3;
    const existing = seen.get(m[2]);
    if (existing === undefined || multi) seen.set(m[2], multi);
  }
  return [...seen.entries()].map(([name, multi]) => ({ name, multi }));
}

// --- Path resolution (same semantics as resolveLocalPath in workspace.ts) ---

function resolveWorkspacePath(root: string, inputPath: string | undefined): string {
  if (!inputPath || inputPath === "." || inputPath === "./") return root;
  if (inputPath.startsWith("~")) return resolve(root, inputPath.slice(2));
  if (isAbsolute(inputPath)) return inputPath;
  return resolve(root, inputPath);
}

function relativize(root: string, abs: string): string {
  if (abs === root) return ".";
  const rel = relative(root, abs);
  return rel.startsWith("..") ? abs : rel.replace(/^\.\//, "");
}

// --- Glob filter (post-discovery; napi has no filter surface — §3.1) ---
// gitignore-glob semantics, matching the CLI --globs contract: a pattern with
// no leading slash matches at any depth; "!" excludes; the LAST matching glob
// wins; when any include glob is present, a path matching no glob is out.
function globMatches(relPath: string, pattern: string): boolean {
  return (
    minimatch(relPath, pattern, { dot: true }) ||
    (!pattern.includes("/") && minimatch(relPath, `**/${pattern}`, { dot: true }))
  );
}
export function passesGlobs(relPath: string, globs?: string[]): boolean {
  if (!globs || globs.length === 0) return true;
  const hasInclude = globs.some((g) => !g.startsWith("!"));
  let keep = !hasInclude;
  for (const g of globs) {
    const neg = g.startsWith("!");
    const pattern = neg ? g.slice(1) : g;
    if (globMatches(relPath, pattern)) keep = !neg;
  }
  return keep;
}

// --- Discovery ---

interface InternalMatch {
  match: CodeSearchMatch;
  byteStart: number;
}

interface DiscoverOutcome {
  internal: InternalMatch[];
  parseErrors: { file: string; message: string }[];
}

/**
 * Run the scan. `lang` null = auto-detect per file (parseFiles — only the
 * five supported extensions are visited; everything else is skipped silently);
 * otherwise a single findInFiles pass with the compiled matcher.
 *
 * The 120 s backstop races the promise — the Rust scan cannot be cancelled
 * mid-flight, so a timeout stops WAITING (honest note, §3.2 budgets).
 */
async function discover(
  lang: string | null,
  compiled: object | null,
  rawPattern: string,
  scopeAbs: string,
  root: string,
  signal?: AbortSignal,
): Promise<DiscoverOutcome> {
  const s = sg();
  const parseErrors: { file: string; message: string }[] = [];
  const internal: InternalMatch[] = [];
  const specs = bindingSpecs(rawPattern);
  // Per-language pattern-validity cache (auto path: one walk per language).
  const validityCache = new Map<string, boolean>();

  const collectFrom = (fileRel: string, nodes: any[]) => {
    for (const node of nodes) {
      try {
        const r = node.range();
        const match: CodeSearchMatch = {
          file: fileRel,
          start: { line: r.start.line + 1, column: r.start.column + 1 },
          end: { line: r.end.line + 1, column: r.end.column + 1 },
          text: node.text(),
        };
        if (specs.length > 0) {
          const mv: Record<string, string> = {};
          for (const { name, multi } of specs) {
            let value: string | null = null;
            try {
              if (multi) {
                const list = node.getMultipleMatches(name);
                if (Array.isArray(list) && list.length > 0) value = list.map((x: any) => x.text()).join("");
              } else {
                const single = node.getMatch(name);
                if (single && typeof single.text === "function") value = single.text();
              }
            } catch { /* binding unreadable — drop it */ }
            if (value == null) {
              // Fallback to the other accessor (defensive — the spec says
              // which one is right, but the binding surface is probed, not
              // specified).
              try {
                if (multi) {
                  const single = node.getMatch(name);
                  if (single && typeof single.text === "function") value = single.text();
                } else {
                  const list = node.getMultipleMatches(name);
                  if (Array.isArray(list) && list.length > 0) value = list.map((x: any) => x.text()).join("");
                }
              } catch { /* drop */ }
            }
            if (value != null) mv[name] = value;
          }
          if (Object.keys(mv).length > 0) match.metaVariables = mv;
        }
        internal.push({ match, byteStart: node.range().start.index });
      } catch { /* node without a usable range — skip */ }
    }
  };

  const run = (): Promise<number> => {
    if (lang) {
      return s.findInFiles(
        lang,
        { paths: [scopeAbs], matcher: compiled },
        (err: Error | null, nodes: any[]) => {
          if (err) { parseErrors.push({ file: "(scope)", message: String(err.message).slice(0, 200) }); return; }
          let fileRel: string;
          try { fileRel = relativize(root, toAbs(String(nodes[0].getRoot().filename()), scopeAbs)); }
          catch { fileRel = "(unknown)"; }
          collectFrom(fileRel, nodes);
        },
      );
    }
    return s.parseFiles(
      [scopeAbs],
      (err: Error | null, fileRoot: any) => {
        if (err) { parseErrors.push({ file: "(scope)", message: String(err.message).slice(0, 200) }); return; }
        let fileRel: string;
        let fileLang: string | null = null;
        try {
          fileRel = relativize(root, toAbs(String(fileRoot.filename()), scopeAbs));
          fileLang = langFromExtension(fileRel);
        } catch { fileRel = "(unknown)"; }
        // Per-file pattern validation (the napi's pattern() never throws —
        // see the header pin): if the pattern is invalid in THIS file's
        // language, record it and move on; it may still be valid elsewhere.
        if (fileLang) {
          let invalid = validityCache.get(fileLang);
          if (invalid === undefined) {
            invalid = foreignTokensIn(fileLang, rawPattern).length > 0;
            validityCache.set(fileLang, invalid);
          }
          if (invalid) {
            parseErrors.push({ file: fileRel, message: `pattern not valid in ${fileLang} — skipped` });
            return;
          }
        }
        let matches: any[];
        try {
          matches = fileRoot.root().findAll(rawPattern);
        } catch (e: any) {
          parseErrors.push({ file: fileRel, message: `pattern did not match in this file's language: ${String(e.message).slice(0, 200)}` });
          return;
        }
        collectFrom(fileRel, matches);
      },
    );
  };

  if (signal?.aborted) throw new CodeSearchError("code_search aborted.");
  const timeoutMs = timeoutFromEnv();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejAbort: (e: Error) => void = () => {};
  const onAbort = () => rejAbort(new CodeSearchError("code_search aborted."));
  const timeout = new Promise<never>((_, rej) => {
    rejAbort = rej;
    timer = setTimeout(() => rej(new CodeSearchError(`code_search timed out after ${Math.round(timeoutMs / 1000)}s — narrow \`path\` to scope the scan.`)), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([run(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  return { internal, parseErrors };
}

// Language from a file extension (the napi's five, per its reference table).
function langFromExtension(relPath: string): string | null {
  const dot = relPath.lastIndexOf(".");
  if (dot < 0) return null;
  return LANGUAGE_ALIASES[relPath.slice(dot + 1).toLowerCase()] ?? null;
}

// The callback yields paths relative to the scan scope (or absolute); make
// them absolute against the scope before relativizing against the root.
function toAbs(cbPath: string, scopeAbs: string): string {
  return isAbsolute(cbPath) ? cbPath : resolve(scopeAbs, cbPath.replace(/^\.\//, ""));
}

// --- Executor ---

export async function runCodeSearch(
  params: CodeSearchParams,
  workspace: WorkspaceAdapter,
  signal?: AbortSignal,
): Promise<CodeSearchResult> {
  // Phase 0: local workspaces only (remote carve-out is Phase 2).
  const root = workspace.localRoot;
  if (workspace.kind !== "local" || !root) {
    throw new CodeSearchError("code_search is available on local workspaces only (remote support lands in a later phase).");
  }
  const scopeAbs = resolveWorkspacePath(root, params.path);
  const scopeRel = relativize(root, scopeAbs);

  try {
    await access(scopeAbs);
  } catch {
    throw new CodeSearchError(`path not found: ${params.path ?? "(workspace root)"}`);
  }

  const pattern = params.pattern;
  // The CLI exit-8 class ("Cannot parse query as a valid pattern"): no code
  // content at all — empty strings, bare punctuation. Everything else, the
  // ast-grep matcher is the referee (garbage parses tolerantly and matches
  // nothing — a truthful clean absence).
  if (!/[A-Za-z0-9_$]/.test(pattern.trim())) {
    throw new CodeSearchError("pattern is empty or contains no code content.");
  }

  // Language resolution.
  let lang: string | null = null;
  if (params.lang) {
    const resolved = LANGUAGE_ALIASES[params.lang.toLowerCase()];
    if (!resolved) {
      throw new CodeSearchError(
        `language "${params.lang}" is not supported by the code_search executor (napi 0.50.0 supports: ${NAPI_LANGUAGES.join(", ")}).`,
      );
    }
    lang = resolved;
  }

  // Pattern validation: cheap regex guard, then the real ERROR-node walk.
  const hint = regexShapeHint(pattern);
  if (hint) throw new CodeSearchError(hint);
  const s = sg();
  let compiled: object | null = null;
  if (lang) {
    try {
      compiled = s.pattern(lang, pattern);
    } catch (e: any) {
      throw new CodeSearchError(`invalid pattern: ${String(e.message).slice(0, 300)}`);
    }
    const foreign = foreignTokensIn(lang, pattern);
    if (foreign.length > 0) {
      const tokens = foreign.map((t) => `"${t}"`).join(", ");
      throw new CodeSearchError(
        `pattern is not valid in ${lang} — ${tokens} ${foreign.length === 1 ? "is" : "are"} keyword${foreign.length === 1 ? "" : "s"} of another supported language, not ${lang} syntax. Rewrite the pattern in ${lang} or pass a different lang.`,
      );
    }
  }

  const discovered = await discover(lang, compiled, pattern, scopeAbs, root, signal);

  // Glob filter (post-discovery — napi's filter surface is ignores +
  // languageGlobs, nothing else, §3.1).
  const filtered = discovered.internal.filter((im) => passesGlobs(im.match.file, params.globs));

  // Ordering contract (review pass): (file, line, column, byte) — pagination
  // is only coherent under a deterministic order with fresh parses.
  filtered.sort((a, b) => {
    if (a.match.file !== b.match.file) return a.match.file < b.match.file ? -1 : 1;
    if (a.match.start.line !== b.match.start.line) return a.match.start.line - b.match.start.line;
    if (a.match.start.column !== b.match.start.column) return a.match.start.column - b.match.start.column;
    return a.byteStart - b.byteStart;
  });

  // Budgets (server-side).
  const maxMatches = Math.min(Math.max(Math.floor(Number(params.maxMatches) || DEFAULT_MAX_MATCHES), 1), MAX_MAX_MATCHES);
  const skip = Math.max(Math.floor(Number(params.skip) || 0), 0);
  const totalMatches = filtered.length;
  const page = filtered.slice(skip, skip + maxMatches);
  const filesWithMatches = new Set(filtered.map((im) => im.match.file)).size;
  const truncated = totalMatches > skip + page.length;

  const text = renderText({
    page: page.map((im) => im.match),
    totalMatches,
    filesWithMatches,
    skip,
    truncated,
    scopeRel,
    parseErrors: discovered.parseErrors,
  });

  return {
    matches: page.map((im) => im.match),
    totalMatches,
    filesWithMatches,
    text,
    parseErrors: discovered.parseErrors.slice(0, PARSE_ERROR_LIST_CAP),
    parseErrorsTotal: discovered.parseErrors.length,
    truncated,
  };
}

// --- Text projection (model-level; §3.2 review-pass rendering rules) ---

interface RenderArgs {
  page: CodeSearchMatch[];
  totalMatches: number;
  filesWithMatches: number;
  skip: number;
  truncated: boolean;
  scopeRel: string;
  parseErrors: { file: string; message: string }[];
}

function renderText(a: RenderArgs): string {
  const lines: string[] = [];
  if (a.totalMatches === 0) {
    lines.push(`no matches in ${a.scopeRel === "." ? "the workspace" : a.scopeRel}`);
    if (a.parseErrors.length > 0) {
      // Qualified absence (oh-my-pi pattern): a partially-covered corpus is
      // exactly where the model over-concludes.
      lines.push(`${a.parseErrors.length} file(s) skipped (parse/pattern errors) — the query may be mis-scoped; narrow path before concluding absence.`);
    }
    return joinWithCap(lines);
  }
  let summary = `${a.totalMatches} matches in ${a.filesWithMatches} files`;
  if (a.truncated || a.skip > 0) {
    summary += ` (showing ${a.page.length} of ${a.totalMatches}${a.skip > 0 ? `, after skipping ${a.skip}` : ""})`;
  }
  lines.push(summary);
  for (const m of a.page) {
    const binds = m.metaVariables ? Object.entries(m.metaVariables) : [];
    const bindStr = binds.length
      ? " " + binds.map(([k, v]) => `[${k}=${capText(v, BINDING_RENDER_CAP)}]`).join(" ")
      : "";
    const [first, ...rest] = m.text.split("\n");
    const multi = rest.length > 0 ? ` … +${rest.length} lines` : "";
    lines.push(`${m.file}:${m.start.line}${bindStr}: ${capLine(first, LINE_RENDER_CAP)}${multi}`);
  }
  if (a.parseErrors.length > 0) {
    const shown = a.parseErrors.slice(0, 3).map((p) => `${p.file}: ${capText(p.message, 80)}`).join("; ");
    lines.push(`${a.parseErrors.length} file(s) skipped (parse/pattern errors)${a.parseErrors.length > 3 ? " (e.g.)" : ""} — ${shown}`);
  }
  return joinWithCap(lines);
}

function capText(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? oneLine.slice(0, n - 1) + "…" : oneLine;
}
function capLine(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function joinWithCap(lines: string[]): string {
  let text = lines.join("\n");
  const cap = maxCharsFromEnv();
  if (text.length > cap) {
    const cut = text.slice(0, cap);
    const lastNl = cut.lastIndexOf("\n");
    text = (lastNl > 0 ? cut.slice(0, lastNl) : cut) + `\n[truncated at ${(cap / 1024).toFixed(0)} KB — narrow path/ or raise maxMatches]`;
  }
  return text;
}
