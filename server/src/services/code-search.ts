/**
 * Code search — structural code navigation via ast-grep.
 * Design: docs/design/code_search (§3); Phase 0 is the model-level tool, the
 * kernel projection rides this same executor in Phase 1.
 *
 * Execution: in-process `@ast-grep/napi` (version-pinned in server/package.json)
 * — no subprocess, no shell-quoting surface. Local workspaces only (Phase 0);
 * the remote carve-out (adapter-read + in-process parse) is Phase 2.
 *
 * Engine facts this executor is written against (@ast-grep/napi 0.50.0):
 * - `sg.Lang` is a compile-side enum, empty at runtime — language arguments are
 *   plain strings.
 * - The napi bundle supports five languages: typescript, tsx, javascript (jsx
 *   alias), html, css. `findInFiles`/`parseFiles` silently skip files whose
 *   extension infers anything else; the CLI covers more. Coverage is therefore
 *   the executor's job: a scope census (ignore-aware walk) reports every file
 *   the engine cannot visit, so a zero-match result is never silently partial.
 * - `pattern()` never throws: tree-sitter parses tolerantly, so garbage
 *   patterns compile and match nothing. Static validity is undecidable (any
 *   token parses as an identifier in some grammar) — pre-validation is the
 *   regex-shape heuristic and the no-code-content class only; everything else
 *   gets a truthful zero-match.
 * - Match nodes carry no file path; it lives at `node.getRoot().filename()`
 *   (absolute when the scan scope is absolute).
 * - `range()` is 0-based; the model-facing text is 1-based.
 * - Patterns must be complete nodes: `function $NAME($$$ARGS)` (no body)
 *   matches nothing; the partial prefix `function $NAME` matches every
 *   function definition (typed, generic, async).
 * - Multi-element bindings include separator nodes; `join("")` reconstructs
 *   the source span. `getMatch(name)` returns the single-binding node,
 *   `getMultipleMatches(name)` the list.
 * - `findInFiles`/`parseFiles` honor `.gitignore` (the same ignore crate as
 *   the CLI); explicitly requested paths override ignores.
 * - The `findInFiles` callback fires once per file with matches (or error);
 *   `parseFiles` fires once per visited file. Neither reports a files-scanned
 *   figure — the scope census supplies it. And callbacks can still be in the
 *   libuv queue when the promise resolves: the resolved number is how many
 *   files WILL deliver. Reading early is silently partial (observed: full,
 *   short, and zero-match deliveries for one identical query) — the executor
 *   drains to the resolved count before returning.
 * - `context` is not in the Phase 0 schema: the index-not-payload rendering
 *   stands on its own (docs §3.2).
 */
import { createRequire } from "module";
import { access, readdir, readFile, stat } from "fs/promises";
import { isAbsolute, join, relative, resolve } from "path";
import { minimatch } from "minimatch";
import ignore, { type Ignore } from "ignore";
import type { WorkspaceAdapter } from "./workspace.js";

// The napi is a native addon — load lazily, only when the flag is on, so the
// dark path never touches it and hosts without a prebuild (§5 Risk 3) pay
// nothing at import time.
const requireNapi = createRequire(import.meta.url);
let napiModule: any | null = null;
function sg(): any {
  if (!napiModule) napiModule = requireNapi("@ast-grep/napi");
  return napiModule;
}

export function codeSearchEnabled(): boolean {
  return process.env.PORRIMA_CODE_SEARCH === "1";
}

// --- Languages: the napi's actual support set ---

export const NAPI_LANGUAGES = ["typescript", "tsx", "javascript", "html", "css"] as const;

// Extension/alias → canonical napi language, case-insensitive.
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
  skip?: number; // pagination
}

export interface SkippedFile {
  file: string; // workspace-relative
  reason: string;
}

export interface CodeSearchResult {
  matches: CodeSearchMatch[]; // the page returned (after skip + maxMatches)
  totalMatches: number; // all matches found (pre-pagination)
  filesWithMatches: number;
  skipped: SkippedFile[]; // capped list — scan errors + files the engine cannot visit
  skippedTotal: number;
  unscanned: Record<string, number>; // extension → count of files outside the language set
  scannedFiles: number; // files in scope the engine can visit (census; lower bound when partial)
  text: string; // model-level text projection
  truncated: boolean;
}

export class CodeSearchError extends Error {}

// --- Budgets (server-side: the caller cannot be trusted to count) ---

const DEFAULT_MAX_MATCHES = 50;
const MAX_MAX_MATCHES = 1000;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CHARS = 20_000;
const SKIPPED_LIST_CAP = 10;
const DELIVERY_GRACE_MS = 10_000; // delivery barrier cap after the scan resolves
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
 * The regex-shape guard (§3.2): reject classic regex shapes BEFORE calling the
 * engine, with a hint toward rg. Deliberately narrow and deliberately
 * space-aware: `\S\|\S` rejects `foo|bar` (regex union — the common authoring
 * error) while `a | b` — valid code (bitwise-or, TS union types) — passes. The
 * engine referee is the real validator for everything else (garbage parses
 * tolerantly and matches nothing, a truthful absence); this saves a round-trip
 * and points the model at the right tool.
 */
const REGEX_SHAPE_RE = /\\[wdsb]|\.\\?\*|\S\|\S|\[[^\]]*-[^\]]*\]/;
export function regexShapeHint(pattern: string): string | null {
  return REGEX_SHAPE_RE.test(pattern)
    ? "ast-grep patterns are code, not regex — for text search use `rg` via bash."
    : null;
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

// --- Glob filter (post-discovery; the napi has no filter surface) ---
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

// --- Scope census ---
// The napi silently visits only files whose extension infers one of its five
// languages. A zero-match result is only honest if the executor knows what the
// engine could not see — so the executor walks the scope itself (ignore-aware,
// noise-pruned) and aggregates by extension. The census is metadata, never the
// scan itself; discrepancies fail safe (under-report skips, never over-claim).

const NOISE_DIRS = new Set([
  "node_modules", "dist", "build", "out", "coverage",
  "__pycache__", "venv", ".venv", "target", "vendor",
]);
const CENSUS_FILE_CAP = 20_000;
const UNSUPPORTED_PATH_CAP = 50;

interface Census {
  extCounts: Map<string, number>; // lowercase extension ("(none)" for no extension)
  langCounts: Map<string, number>; // canonical napi language → file count
  supportedCount: number;
  unsupportedPaths: string[]; // capped, workspace-relative
  partial: boolean; // hit the file cap — counts are lower bounds
}

function fileExtension(relPath: string): string {
  const dot = relPath.lastIndexOf(".");
  return dot <= 0 ? "(none)" : relPath.slice(dot + 1).toLowerCase();
}

function isIgnored(abs: string, igs: { base: string; ig: Ignore }[], isDir: boolean): boolean {
  for (const { base, ig } of igs) {
    const rel = relative(base, abs).split("\\").join("/");
    if (!rel) continue;
    if (ig.ignores(isDir ? `${rel}/` : rel)) return true;
  }
  return false;
}

async function scopeCensus(scopeAbs: string, root: string): Promise<Census> {
  const census: Census = {
    extCounts: new Map(), langCounts: new Map(), supportedCount: 0,
    unsupportedPaths: [], partial: false,
  };
  const record = (relPath: string) => {
    const ext = fileExtension(relPath);
    census.extCounts.set(ext, (census.extCounts.get(ext) ?? 0) + 1);
    const lang = LANGUAGE_ALIASES[ext];
    if (lang) {
      census.supportedCount++;
      census.langCounts.set(lang, (census.langCounts.get(lang) ?? 0) + 1);
    } else if (census.unsupportedPaths.length < UNSUPPORTED_PATH_CAP) {
      census.unsupportedPaths.push(relPath);
    }
  };

  const st = await stat(scopeAbs).catch(() => null);
  if (!st) return census;
  if (st.isFile()) {
    record(relativize(root, scopeAbs));
    return census;
  }

  let total = 0;
  const walk = async (dirAbs: string, igs: { base: string; ig: Ignore }[]): Promise<boolean> => {
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return true; // unreadable dir: under-report, never fail the scan
    }
    let active = igs;
    const gi = await readFile(join(dirAbs, ".gitignore"), "utf8").catch(() => null);
    if (gi) active = [...igs, { base: dirAbs, ig: ignore().add(gi) }];
    for (const e of entries) {
      if (e.name === ".gitignore") continue;
      const abs = join(dirAbs, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith(".") || NOISE_DIRS.has(e.name)) continue;
        if (isIgnored(abs, active, true)) continue;
        if (!(await walk(abs, active))) return false;
      } else if (e.isFile()) {
        if (isIgnored(abs, active, false)) continue;
        record(relativize(root, abs));
        if (++total >= CENSUS_FILE_CAP) {
          census.partial = true;
          return false;
        }
      }
    }
    return true;
  };
  await walk(scopeAbs, []);
  return census;
}

/** Aggregate unscanned extensions, e.g. ".py×12, .go×3 (+2 more kinds)". */
function extSummary(census: Census): { summary: string; total: number } {
  let total = 0;
  const entries: [string, number][] = [];
  for (const [ext, n] of census.extCounts) {
    if (LANGUAGE_ALIASES[ext]) continue; // scanned language — not a skip
    entries.push([ext, n]);
    total += n;
  }
  entries.sort((a, b) => b[1] - a[1]);
  const shown = entries.slice(0, 4).map(([ext, n]) => `.${ext}\u00d7${n}`).join(", ");
  const rest = entries.length - Math.min(entries.length, 4);
  return { summary: shown + (rest > 0 ? ` (+${rest} more kinds)` : ""), total };
}

// --- Discovery ---

interface InternalMatch {
  match: CodeSearchMatch;
  byteStart: number;
}

interface DiscoverOutcome {
  internal: InternalMatch[];
  errors: SkippedFile[];
}

/**
 * Run the scan. `lang` null = auto-detect per file (parseFiles visits only
 * the five supported extensions); otherwise one findInFiles pass with the
 * compiled matcher.
 *
 * Delivery barrier: the napi resolves BEFORE all per-file callbacks have
 * reached JavaScript (they queue on libuv; the resolved number is the count
 * of files that will deliver — matches-files for findInFiles, visited files
 * for parseFiles). Reading only what has landed by resolution silently loses
 * matches — nondeterministically, and worst on the first calls of a process.
 * So we wait until delivered callbacks equal the resolved count (bounded by a
 * grace window + the overall timeout), and flag incompleteness as a skipped
 * entry rather than trusting a short result.
 *
 * The 120 s backstop races the whole scan — the Rust side cannot be cancelled
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
  const errors: SkippedFile[] = [];
  const internal: InternalMatch[] = [];
  const specs = bindingSpecs(rawPattern);
  let deliveredCallbacks = 0;

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
              // which one is right, but the binding surface varies across
              // grammars).
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

  const onDelivery = () => { deliveredCallbacks++; };

  const run = (): Promise<number> => {
    if (lang) {
      return s.findInFiles(
        lang,
        { paths: [scopeAbs], matcher: compiled },
        (err: Error | null, nodes: any[]) => {
          onDelivery();
          if (err) { errors.push({ file: "(scope)", reason: String(err.message).slice(0, 200) }); return; }
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
        onDelivery();
        if (err) { errors.push({ file: "(scope)", reason: String(err.message).slice(0, 200) }); return; }
        let fileRel: string;
        try {
          fileRel = relativize(root, toAbs(String(fileRoot.filename()), scopeAbs));
        } catch { fileRel = "(unknown)"; }
        let matches: any[];
        try {
          matches = fileRoot.root().findAll(rawPattern);
        } catch (e: any) {
          errors.push({ file: fileRel, reason: `pattern rejected for this file: ${String(e.message).slice(0, 200)}` });
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
    const fileCount = await Promise.race([run(), timeout]);
    // Delivery barrier: `fileCount` is how many files will deliver a
    // callback; they can still be in the libuv queue when the promise
    // resolves. Wait for them (bounded) — a short read without this is
    // silently partial.
    if (fileCount > 0) {
      const drainStart = Date.now();
      while (deliveredCallbacks < fileCount && Date.now() - drainStart < DELIVERY_GRACE_MS) {
        await Promise.race([new Promise((r) => setTimeout(r, 2)), timeout]);
      }
      if (deliveredCallbacks < fileCount) {
        errors.push({ file: "(scope)", reason: `scan delivery incomplete (${deliveredCallbacks}/${fileCount} files) — results may be partial` });
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  return { internal, errors };
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
  // The no-code-content class: empty strings, bare punctuation. Everything
  // else, the ast-grep matcher is the referee (garbage parses tolerantly and
  // matches nothing — a truthful clean absence).
  if (!/[A-Za-z0-9_$]/.test(pattern.trim())) {
    throw new CodeSearchError("pattern is empty or contains no code content.");
  }

  // Language resolution.
  let lang: string | null = null;
  if (params.lang) {
    const resolved = LANGUAGE_ALIASES[params.lang.toLowerCase()];
    if (!resolved) {
      throw new CodeSearchError(
        `language "${params.lang}" is not supported by code_search (supported: ${NAPI_LANGUAGES.join(", ")}).`,
      );
    }
    lang = resolved;
  }

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
  }

  // Census before scan: what the engine can and cannot see in this scope.
  const census = await scopeCensus(scopeAbs, root);
  const discovered = await discover(lang, compiled, pattern, scopeAbs, root, signal);

  const unscanned = extSummary(census);
  const scannedFiles = lang
    ? (census.langCounts.get(lang) ?? 0)
    : census.supportedCount;

  // Skipped = scan errors + (auto-detect) files outside the language set.
  const skippedFull: SkippedFile[] = [...discovered.errors];
  if (!lang && !census.partial) {
    for (const f of census.unsupportedPaths) {
      skippedFull.push({ file: f, reason: `language not supported (use rg via bash for ${fileExtension(f)} files)` });
    }
  }
  const skippedTotal =
    discovered.errors.length + (lang || census.partial ? 0 : unscanned.total);

  // Glob filter (post-discovery — the napi's filter surface is ignores +
  // languageGlobs, nothing else).
  const filtered = discovered.internal.filter((im) => passesGlobs(im.match.file, params.globs));

  // Ordering contract: (file, line, column, byte) — pagination is only
  // coherent under a deterministic order with fresh parses.
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
    errors: discovered.errors,
    lang,
    scannedFiles,
    unscanned: unscanned.summary,
    unscannedTotal: unscanned.total,
    censusPartial: census.partial,
  });

  return {
    matches: page.map((im) => im.match),
    totalMatches,
    filesWithMatches,
    skipped: skippedFull.slice(0, SKIPPED_LIST_CAP),
    skippedTotal,
    unscanned: Object.fromEntries([...census.extCounts].filter(([ext]) => !LANGUAGE_ALIASES[ext])),
    scannedFiles,
    text,
    truncated,
  };
}

// --- Text projection (model-level; §3.2 rendering rules) ---

interface RenderArgs {
  page: CodeSearchMatch[];
  totalMatches: number;
  filesWithMatches: number;
  skip: number;
  truncated: boolean;
  scopeRel: string;
  errors: SkippedFile[];
  lang: string | null;
  scannedFiles: number;
  unscanned: string; // aggregated extension summary
  unscannedTotal: number;
  censusPartial: boolean;
}

function renderText(a: RenderArgs): string {
  const scopeLabel = a.scopeRel === "." ? "the workspace" : a.scopeRel;
  const coverageNotes: string[] = [];
  if (a.errors.length > 0) {
    coverageNotes.push(`${a.errors.length} file(s) skipped by the scanner: ${a.errors.slice(0, 3).map((e) => `${e.file} (${capText(e.reason, 60)})`).join("; ")}${a.errors.length > 3 ? " …" : ""}`);
  }
  if (!a.lang && !a.censusPartial && a.unscannedTotal > 0) {
    coverageNotes.push(`${a.unscannedTotal} file(s) in scope are not scanned (${a.unscanned}) — code_search covers ${NAPI_LANGUAGES.join("/")}; for other languages use rg via bash.`);
  }

  if (a.totalMatches === 0) {
    const lines: string[] = [`no matches in ${scopeLabel}`];
    if (a.lang && !a.censusPartial && a.scannedFiles === 0) {
      // A scoped absence with nothing in scope is a scope error, not a result.
      lines.push(`no ${a.lang} files in ${scopeLabel}${a.unscannedTotal > 0 ? ` — found: ${a.unscanned}` : ""}.`);
    } else if (coverageNotes.length > 0) {
      // Qualified absence: a partially-covered corpus is exactly where the
      // model over-concludes.
      lines.push(...coverageNotes);
      lines.push("coverage above is partial — narrow `path` before concluding absence.");
    }
    return joinWithCap(lines);
  }

  let summary = `${a.totalMatches} matches in ${a.filesWithMatches} files`;
  if (a.truncated || a.skip > 0) {
    summary += ` (showing ${a.page.length} of ${a.totalMatches}${a.skip > 0 ? `, after skipping ${a.skip}` : ""})`;
  }
  const lines: string[] = [summary];
  for (const m of a.page) {
    const binds = m.metaVariables ? Object.entries(m.metaVariables) : [];
    const bindStr = binds.length
      ? " " + binds.map(([k, v]) => `[${k}=${capText(v, BINDING_RENDER_CAP)}]`).join(" ")
      : "";
    const [first, ...rest] = m.text.split("\n");
    const multi = rest.length > 0 ? ` … +${rest.length} lines` : "";
    lines.push(`${m.file}:${m.start.line}${bindStr}: ${capLine(first, LINE_RENDER_CAP)}${multi}`);
  }
  lines.push(...coverageNotes);
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
