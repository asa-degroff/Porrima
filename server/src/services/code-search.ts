/**
 * Code search — structural code navigation via ast-grep.
 * Design: docs/design/code-search.md (§3); Phase 0 is the model-level tool,
 * Phase 1 is the kernel projection — the dispatcher row in
 * agent-tools.ts rides this same executor and returns the structured shape
 * (`CodeSearchResult` minus `text`) plus the snippet path below.
 *
 * Execution: in-process `@ast-grep/napi` (version-pinned in server/package.json)
 * — no subprocess, no shell-quoting surface. File scans are local-workspace
 * only; the remote carve-out (adapter-read + in-process parse) is a later
 * phase. The snippet path (runCodeSearchOnSnippet) touches no filesystem and
 * therefore works on remote kernels too.
 *
 * Engine facts this executor is written against (@ast-grep/napi 0.50.0):
 * - Language arguments are plain strings. (`sg.Lang` IS populated at runtime in
 *   0.50.0, but names only the bundled five; the executor never reads it.)
 * - The napi bundle supports five languages: typescript, tsx, javascript (jsx
 *   alias), html, css. `findInFiles`/`parseFiles` silently skip files whose
 *   extension infers anything else; the CLI covers more. Coverage is therefore
 *   the executor's job: a scope census (ignore-aware walk) reports every file
 *   the engine cannot visit, so a zero-match result is never silently partial.
 * - The engine's EXTENSION set is broader than the five language names:
 *   js/mjs/cjs/jsx → JavaScript, ts/mts/cts
 *   → TypeScript, tsx → Tsx, html/htm/xhtml → Html, css/scss → Css.
 *   LANGUAGE_ALIASES must mirror it — a stale table mis-reports SCANNED files
 *   as unscanned, the coverage-honesty inversion the census exists to
 *   prevent. The drift-pin test in
 *   code-search.test.ts queries the live engine and compares.
 * - `pattern()` never throws: tree-sitter parses tolerantly, so garbage
 *   patterns compile and match nothing. Static validity is undecidable (any
 *   token parses as an identifier in some grammar) — pre-validation is the
 *   regex-shape heuristic and the no-code-content class only; everything else
 *   gets a truthful zero-match.
 * - Match nodes carry no file path; it lives at `node.getRoot().filename()`
 *   (absolute when the scan scope is absolute).
 * - `range()` is 0-based; the model-facing text is 1-based.
 * - Patterns must be complete nodes: a bodiless parameterized pattern
 *   (`function $NAME($$$ARGS)`) matches only bodiless DECLARATIONS (e.g. TS
 *   overload signatures), never definitions — exact parameter shapes need
 *   the body slot (`function $NAME($ARG) { $$$ }`). The partial prefix
 *   `function $NAME` matches every function definition (typed, generic,
 *   async).
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
 *   drains to the resolved count before returning. Upstream-known: ast-grep's
 *   "Performance Tip for napi usage" page documents the race and ships the
 *   same counted-callback workaround — re-check it on every version bump.
 * - Comments are SIGNIFICANT children in block pattern matching in this
 *   binding: `if ($C) { return $R; }` structurally refuses blocks whose
 *   first child is a comment (leading-comment-then-return blocks, the T6
 *   forensics shape) — battery v4: 8 misses, all comment-first; three
 *   independent model ASTs agreed on the field-based count. Statement
 *   census counts must enumerate fields (walk + comment filter), not
 *   match block patterns. Re-verify on every version bump (Risk 6).
 * - `context` is not in the Phase 0 schema: the index-not-payload rendering
 *   stands on its own (docs §3.2).
 */
import { createRequire } from "module";
import { access, readdir, readFile, stat } from "fs/promises";
import { homedir } from "os";
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

// Extension/alias → canonical napi language, case-insensitive. The extension
// half MUST mirror the engine's own inference set (module header; verified
// empirically on 0.50.0 and pinned by the drift test in code-search.test.ts):
// js/mjs/cjs/jsx, ts/mts/cts, tsx, html/htm/xhtml, css/scss. The bare language
// names are also accepted as `lang` parameter aliases.
export const LANGUAGE_ALIASES: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  typescript: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  javascript: "javascript",
  html: "html",
  htm: "html",
  xhtml: "html",
  css: "css",
  scss: "css",
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
  /** Advisory regex-shape note, present only on a zero-match (§3.2). The
   *  structured (kernel) projection has no `text`, so the hint rides as a
   *  field — absence advice fires identically on both surfaces. */
  hint?: string;
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

const HOME = homedir();

export function resolveWorkspacePath(root: string, inputPath: string | undefined): string {
  if (!inputPath || inputPath === "." || inputPath === "./") return root;
  // `~` is HOME-relative, exactly like workspace.ts's resolveLocalPath — the
  // two must not diverge, or the same path string means different things to
  // read_file and code_search in project chats (root ≠ HOME).
  if (inputPath.startsWith("~")) return resolve(HOME, inputPath.slice(2));
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
// no leading slash matches at any depth; a pattern matching an ANCESTOR
// DIRECTORY matches everything beneath it ("!dist" excludes dist/foo.ts); "!"
// excludes; the LAST matching glob wins; when any include glob is present, a
// path matching no glob is out.
function globMatches(relPath: string, pattern: string): boolean {
  const p = pattern.replace(/\/+$/, ""); // "dist/" → "dist"
  if (!p) return false;
  const matchOne = (target: string) =>
    minimatch(target, p, { dot: true }) ||
    (!p.includes("/") && minimatch(target, `**/${p}`, { dot: true }));
  if (matchOne(relPath)) return true;
  const parts = relPath.split("/");
  for (let i = 1; i < parts.length; i++) {
    if (matchOne(parts.slice(0, i).join("/"))) return true;
  }
  return false;
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

/**
 * Normalize napi match nodes into CodeSearchMatch (1-based positions,
 * flattened single + multi bindings). Shared by the file scan and the
 * snippet path (Phase 1) so binding extraction lives in exactly one place.
 */
function collectMatches(nodes: any[], fileRel: string, specs: { name: string; multi: boolean }[]): InternalMatch[] {
  const out: InternalMatch[] = [];
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
      out.push({ match, byteStart: r.start.index });
    } catch { /* node without a usable range — skip */ }
  }
  return out;
}

/**
 * Ordering contract: (file, start.line, start.column, byteOffset) —
 * pagination is only coherent under a deterministic order with fresh parses
 * (§3.2). Shared by the file scan and the snippet path.
 */
function compareInternal(a: InternalMatch, b: InternalMatch): number {
  if (a.match.file !== b.match.file) return a.match.file < b.match.file ? -1 : 1;
  if (a.match.start.line !== b.match.start.line) return a.match.start.line - b.match.start.line;
  if (a.match.start.column !== b.match.start.column) return a.match.start.column - b.match.start.column;
  return a.byteStart - b.byteStart;
}

/** Clamp the pagination budgets (server-side — the caller cannot be trusted to count). */
function paginationBudgets(maxMatches?: number, skip?: number): { maxMatches: number; skip: number } {
  return {
    maxMatches: Math.min(Math.max(Math.floor(Number(maxMatches) || DEFAULT_MAX_MATCHES), 1), MAX_MAX_MATCHES),
    skip: Math.max(Math.floor(Number(skip) || 0), 0),
  };
}

interface DiscoverOutcome {
  internal: InternalMatch[];
  errors: SkippedFile[];
}

/**
 * Run the scan. `lang` null = auto-detect per file (parseFiles visits only
 * the supported extensions); otherwise one findInFiles pass with the compiled
 * matcher.
 *
 * Delivery barrier: the napi resolves BEFORE all per-file callbacks have
 * reached JavaScript (they queue on libuv; the resolved number is the count
 * of files that will deliver — matches-files for findInFiles, visited files
 * for parseFiles). Reading only what has landed by resolution silently loses
 * matches — nondeterministically, and worst on the first calls of a process.
 * So we wait until delivered callbacks equal the resolved count (bounded by a
 * grace window + the call deadline), and flag incompleteness as a skipped
 * entry rather than trusting a short result. (Upstream-known limitation:
 * ast-grep's "Performance Tip for napi usage" page documents the race and
 * ships the same counted-callback workaround.)
 *
 * `timeout`/`deadline` are owned by runCodeSearch — one budget for the whole
 * call (census + scan + drain). The Rust side cannot be cancelled mid-flight,
 * so a timeout stops WAITING (honest note, §3.2 budgets).
 */
async function discover(
  lang: string | null,
  compiled: object | null,
  rawPattern: string,
  scopeAbs: string,
  root: string,
  timeout: Promise<never>,
  deadline: number,
): Promise<DiscoverOutcome> {
  const s = sg();
  const errors: SkippedFile[] = [];
  const internal: InternalMatch[] = [];
  const specs = bindingSpecs(rawPattern);
  let deliveredCallbacks = 0;
  // Per-language compiled-pattern cache for the auto-detect path:
  // findAll(string) recompiles the pattern for every file, and the kernel
  // rule loop (Phase 1) leans on auto-detect hardest. Unmapped extensions
  // fall back to the string form (which infers the file's own language), so
  // correctness survives engine extension drift even if the cache misses.
  const compiledByLang = new Map<string, any>();

  const collectFrom = (fileRel: string, nodes: any[]) => {
    internal.push(...collectMatches(nodes, fileRel, specs));
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
          const langName = LANGUAGE_ALIASES[fileExtension(fileRel)];
          let cfg = langName ? compiledByLang.get(langName) : undefined;
          if (langName && cfg === undefined) {
            cfg = s.pattern(langName, rawPattern);
            compiledByLang.set(langName, cfg);
          }
          matches = cfg ? fileRoot.root().findAll(cfg) : fileRoot.root().findAll(rawPattern);
        } catch (e: any) {
          errors.push({ file: fileRel, reason: `pattern rejected for this file: ${String(e.message).slice(0, 200)}` });
          return;
        }
        collectFrom(fileRel, matches);
      },
    );
  };

  const fileCount = await Promise.race([run(), timeout]);
  // Delivery barrier: `fileCount` is how many files will deliver a callback;
  // they can still be in the libuv queue when the promise resolves. Wait for
  // them (bounded by the grace window and the call deadline) — a short read
  // without this is silently partial.
  if (fileCount > 0) {
    const drainStart = Date.now();
    while (
      deliveredCallbacks < fileCount &&
      Date.now() - drainStart < DELIVERY_GRACE_MS &&
      Date.now() < deadline
    ) {
      await Promise.race([new Promise((r) => setTimeout(r, 2)), timeout]);
    }
    if (deliveredCallbacks < fileCount) {
      errors.push({ file: "(scope)", reason: `scan delivery incomplete (${deliveredCallbacks}/${fileCount} files) — results may be partial` });
    }
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
  // Phase 0: local workspaces only (remote carve-out is a later phase).
  const root = workspace.localRoot;
  if (workspace.kind !== "local" || !root) {
    throw new CodeSearchError("code_search is available on local workspaces only (remote support lands in a later phase).");
  }
  if (signal?.aborted) throw new CodeSearchError("code_search aborted.");
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

  // Advisory, not a rejection (§3.2): the detector has real false-positive
  // classes in code patterns (tight TS unions `string|number`, index
  // arithmetic `$ARR[$I-1]`), and a hard reject converts a possibly-valid
  // pattern into a guaranteed no-result. The search runs; the hint is
  // appended only on a zero-match — the engine stays the referee, and the
  // nudge fires exactly where the over-conclusion risk lives (absence).
  const regexHint = regexShapeHint(pattern);

  const s = sg();
  let compiled: object | null = null;
  if (lang) {
    try {
      compiled = s.pattern(lang, pattern);
    } catch (e: any) {
      throw new CodeSearchError(`invalid pattern: ${String(e.message).slice(0, 300)}`);
    }
  }

  // One deadline for the whole call: the census walk and the scan (neither
  // cancellable mid-flight) both race it. The timeout stops WAITING —
  // scoping is the remedy, the timeout the backstop (§3.2 budgets).
  const timeoutMs = timeoutFromEnv();
  const deadline = Date.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejAbort: (e: Error) => void = () => {};
  const onAbort = () => rejAbort(new CodeSearchError("code_search aborted."));
  const timeout = new Promise<never>((_, rej) => {
    rejAbort = rej;
    timer = setTimeout(() => rej(new CodeSearchError(`code_search timed out after ${Math.round(timeoutMs / 1000)}s — narrow \`path\` to scope the scan.`)), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

  // Census before scan: what the engine can and cannot see in this scope.
  let census: Census;
  let discovered: DiscoverOutcome;
  try {
    census = await Promise.race([scopeCensus(scopeAbs, root), timeout]);
    discovered = await discover(lang, compiled, pattern, scopeAbs, root, timeout, deadline);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

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
  filtered.sort(compareInternal);

  // Budgets (server-side).
  const { maxMatches, skip } = paginationBudgets(params.maxMatches, params.skip);
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
    regexHint,
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
    ...(totalMatches === 0 && regexHint ? { hint: regexHint } : {}),
  };
}

// --- Snippet testing (Phase 1, §3.3): pattern vs a constructed string ---
// The `test_match_code_rule` MCP case, in-kernel: no filesystem, no census,
// no workspace — parse one string, run the pattern, return the same
// normalized match shape. Kernel-only surface (the model-level tool keeps
// its Phase 0 schema); rides the parse/pattern napi path. Synchronous by
// construction (parse + findAll are sync napi calls on a bounded string —
// no timeout race needed; the cell's own budget bounds it).

export interface CodeSearchSnippetParams {
  pattern: string;
  code: string;
  lang?: string; // alias table applies; default: ts (the house language)
  maxMatches?: number;
  skip?: number;
}

export interface CodeSearchSnippetResult {
  matches: CodeSearchMatch[]; // file is "(snippet)"
  totalMatches: number;
  lang: string; // the resolved language the snippet was parsed as
  truncated: boolean;
  /** Advisory regex-shape note, present only on a zero-match (§3.2's rule
   *  rides both paths — the engine referees; the hint fires at absence). */
  hint?: string;
}

export function runCodeSearchOnSnippet(
  params: CodeSearchSnippetParams,
  signal?: AbortSignal,
): CodeSearchSnippetResult {
  if (signal?.aborted) throw new CodeSearchError("code_search aborted.");
  const pattern = params.pattern;
  if (!/[A-Za-z0-9_$]/.test(pattern.trim())) {
    throw new CodeSearchError("pattern is empty or contains no code content.");
  }
  if (typeof params.code !== "string") {
    throw new CodeSearchError("code must be a string.");
  }
  const langKey = (params.lang ?? "ts").toLowerCase();
  const lang = LANGUAGE_ALIASES[langKey];
  if (!lang) {
    throw new CodeSearchError(
      `language "${params.lang}" is not supported by code_search (supported: ${NAPI_LANGUAGES.join(", ")}).`,
    );
  }

  const s = sg();
  const root = s.parse(lang, params.code);
  let nodes: any[];
  try {
    nodes = root.root().findAll(s.pattern(lang, pattern));
  } catch (e: any) {
    throw new CodeSearchError(`invalid pattern: ${String(e.message).slice(0, 300)}`);
  }

  const internal = collectMatches(nodes, "(snippet)", bindingSpecs(pattern));
  internal.sort(compareInternal);
  const { maxMatches, skip } = paginationBudgets(params.maxMatches, params.skip);
  const totalMatches = internal.length;
  const page = internal.slice(skip, skip + maxMatches);

  const result: CodeSearchSnippetResult = {
    matches: page.map((im) => im.match),
    totalMatches,
    lang,
    truncated: totalMatches > skip + page.length,
  };
  // Coverage honesty, snippet-sized: there is no census here, so the only
  // silent-failure class is a mis-language pattern — the advisory hint names
  // the other one (regex shapes) at the exact point absence could mislead.
  if (totalMatches === 0) {
    const regexHint = regexShapeHint(pattern);
    if (regexHint) result.hint = regexHint;
  }
  return result;
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
  regexHint: string | null; // advisory on zero-match (§3.2), never a rejection
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
    if (a.regexHint) {
      // Advisory: fires only at absence — a regex-shaped pattern that matched
      // real code (`a|b`, `$ARR[$I-1]`) proves itself valid and gets no note.
      lines.push(`note: the pattern looks regex-shaped — ${a.regexHint}`);
    }
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
    lines.push(renderMatchLine(m));
  }
  lines.push(...coverageNotes);
  return joinWithCap(lines);
}

function renderMatchLine(m: CodeSearchMatch): string {
  const binds = m.metaVariables ? Object.entries(m.metaVariables) : [];
  const bindStr = binds.length
    ? " " + binds.map(([k, v]) => `[${k}=${capText(v, BINDING_RENDER_CAP)}]`).join(" ")
    : "";
  const [first, ...rest] = m.text.split("\n");
  const multi = rest.length > 0 ? ` … +${rest.length} lines` : "";
  return `${m.file}:${m.start.line}${bindStr}: ${capLine(first, LINE_RENDER_CAP)}${multi}`;
}

/** Model-level text projection for snippet mode (S1, §4.2): a pattern test,
 *  not a corpus query — there is no census, scope, or unscanned to report.
 *  The one honesty axis is the zero: a snippet zero is a pattern problem,
 *  not an absence, and must say so or the model over-concludes. */
export function renderSnippetText(
  params: CodeSearchSnippetParams,
  result: CodeSearchSnippetResult,
): string {
  if (result.totalMatches === 0) {
    const lines: string[] = [`no matches in the snippet (parsed as ${result.lang})`];
    lines.push("a zero here is a pattern problem, not an absence — the pattern did not match the constructed code. Revise the pattern and re-test before scanning.");
    if (result.hint) {
      lines.push(`note: the pattern looks regex-shaped — ${result.hint}`);
    }
    return joinWithCap(lines);
  }
  let summary = `${result.totalMatches} matches in the snippet`;
  if (result.truncated || (params.skip ?? 0) > 0) {
    summary += ` (showing ${result.matches.length} of ${result.totalMatches}${(params.skip ?? 0) > 0 ? `, after skipping ${params.skip}` : ""})`;
  }
  const lines: string[] = [summary];
  for (const m of result.matches) {
    lines.push(renderMatchLine(m));
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
