/**
 * code_search — Phase 0 executor tests (docs/design/code-search.md §6).
 *
 * Referee layout: the napi is the real engine (no mocks) — these tests pin the
 * executor's contract: ignore semantics (the resolved 10-13 question, kept as
 * a regression case per §6), the (file, line, col, byte) ordering comparator,
 * globs post-discovery filtering, explicit-path precedence, 1-based
 * normalization, binding flattening, budgets (maxMatches/skip/char cap),
 * qualified zero-match, and the error surface (regex hint, invalid pattern,
 * unknown language, remote workspace, missing path).
 *
 * The napi is a native addon — the executor suite is skipped (not failed) on
 * hosts without a prebuild for this platform (§5 Risk 3).
 */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { mkdir, writeFile, rm } from "fs/promises";
import { promisify } from "util";
import { execFile } from "child_process";
import { join } from "path";
import { createRequire } from "module";
import { runCodeSearch, CodeSearchError, passesGlobs, regexShapeHint, LANGUAGE_ALIASES, codeSearchEnabled } from "./code-search.js";
import { LocalWorkspaceAdapter } from "./workspace.js";
import type { WorkspaceAdapter } from "./workspace.js";

const execFileP = promisify(execFile);
const FIXTURE = "/tmp/quje-code-search-fixture";
let napiAvailable = true;

function localWs(root: string): LocalWorkspaceAdapter {
  return new LocalWorkspaceAdapter(root);
}

async function gitFixtures() {
  await rm(FIXTURE, { recursive: true, force: true });
  const src = join(FIXTURE, "src");
  const ignored = join(FIXTURE, "ignored");
  await mkdir(join(src, "services"), { recursive: true });
  await mkdir(ignored, { recursive: true });

  await writeFile(join(src, "a.ts"), [
    "export function alpha(x) { return x; }",
    "function two(a, b) { return a; }",
    "function beta(x) { return x; }",
    "",
  ].join("\n"));
  await writeFile(join(src, "b.ts"), [
    "function gamma() {\n  return 1;\n}",
    "export async function delta() { return 1; }",
    "function typedFn(x: number): void { }",
    "async function generic<T>(fn: () => Promise<T>): Promise<T> { return fn(); }",
    "",
  ].join("\n"));
  await writeFile(join(src, "services", "svc.py"), [
    "def helper():",
    "    return 1",
    "",
  ].join("\n"));
  // css file: a TS pattern is invalid in css (ERROR node) — drives the
  // per-file parse-error path on auto-detect
  await writeFile(join(src, "styles.css"), ".a { color: red }\n");
  // gitignored file with a matching pattern
  await writeFile(join(ignored, "hidden.ts"), "function hiddenFn() { return 1; }\n");
  await writeFile(join(FIXTURE, ".gitignore"), "ignored/\n");

  await execFileP("git", ["init", "-q"], { cwd: FIXTURE });
  await execFileP("git", ["add", "-A"], { cwd: FIXTURE });
  await execFileP("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture"], { cwd: FIXTURE });
}

beforeAll(async () => {
  // Probe the native addon first: skip (not fail) where no prebuild exists.
  try {
    createRequire(import.meta.url)("@ast-grep/napi");
  } catch {
    napiAvailable = false;
  }
  if (!napiAvailable) return;
  try {
    await gitFixtures();
  } catch (e: any) {
    console.warn("fixture setup failed:", e.message);
    napiAvailable = false;
  }
});

afterAll(async () => {
  await rm(FIXTURE, { recursive: true, force: true }).catch(() => {});
});

const fnPattern = "function $NAME($$$ARGS) { $$$ }";

describe.runIf(napiAvailable)("code_search executor (Phase 0)", () => {
  it("finds function definitions with 1-based positions and workspace-relative files", async () => {
    const res = await runCodeSearch({ pattern: fnPattern, lang: "ts", path: "src" }, localWs(FIXTURE));
    expect(res.totalMatches).toBeGreaterThanOrEqual(4); // alpha, two, beta, gamma, delta
    expect(res.matches.every((m) => m.file.startsWith("src/"))).toBe(true);
    expect(res.matches.every((m) => m.start.line >= 1 && m.start.column >= 1)).toBe(true);
    const alpha = res.matches.find((m) => m.file === "src/a.ts" && m.metaVariables?.NAME === "alpha");
    expect(alpha).toBeDefined();
    expect(alpha!.start.line).toBe(1);
    // the matched node is the function_declaration — `export` lives on the
    // parent export_statement (tree-sitter grammar shape, verified)
    expect(alpha!.text).toBe("function alpha(x) { return x; }");
  });

  it("the partial prefix pattern matches ALL function shapes (typed, generic, async)", async () => {
    const res = await runCodeSearch({ pattern: "function $NAME", lang: "ts", path: "src" }, localWs(FIXTURE));
    const names = new Set(res.matches.map((m) => m.metaVariables?.NAME));
    // plain, multi-line, async, typed, generic — the partial form catches all
    for (const n of ["alpha", "two", "beta", "gamma", "delta", "typedFn", "generic"]) {
      expect(names.has(n)).toBe(true);
    }
    // and the matched text is the FULL node (verified: text includes the body)
    const typed = res.matches.find((m) => m.metaVariables?.NAME === "typedFn");
    expect(typed!.text).toBe("function typedFn(x: number): void { }");
  });

  it("flattens single + multi bindings; multi join('') reconstructs the source span", async () => {
    const res = await runCodeSearch({ pattern: fnPattern, lang: "ts", path: "src" }, localWs(FIXTURE));
    const two = res.matches.find((m) => m.metaVariables?.NAME === "two");
    expect(two).toBeDefined();
    expect(two!.metaVariables!.ARGS).toBe("a,b"); // separators join back
    const delta = res.matches.find((m) => m.metaVariables?.NAME === "delta");
    expect(delta).toBeDefined();
    // zero-arg function: empty $$$ list binds nothing — no ARGS key
    expect(delta!.metaVariables?.ARGS).toBeUndefined();
  });

  it("honors .gitignore on a root scan (regression case — resolved 10-13, §3.1)", async () => {
    const res = await runCodeSearch({ pattern: fnPattern, lang: "ts" }, localWs(FIXTURE));
    expect(res.matches.some((m) => m.file.startsWith("ignored/"))).toBe(false);
  });

  it("explicitly-requested ignored paths override ignores (ignore-crate precedence)", async () => {
    const res = await runCodeSearch({ pattern: fnPattern, lang: "ts", path: "ignored" }, localWs(FIXTURE));
    expect(res.totalMatches).toBe(1);
    expect(res.matches[0].file).toBe("ignored/hidden.ts");
  });

  it("auto-detects language per file (no lang param)", async () => {
    const res = await runCodeSearch({ pattern: fnPattern }, localWs(FIXTURE));
    const files = new Set(res.matches.map((m) => m.file));
    expect([...files].some((f) => f.endsWith(".ts"))).toBe(true);
  });

  it("multi-line nodes render as first line + '… +N lines'", async () => {
    const res = await runCodeSearch({ pattern: fnPattern, lang: "ts", path: "src" }, localWs(FIXTURE));
    const gamma = res.matches.find((m) => m.metaVariables?.NAME === "gamma");
    expect(gamma).toBeDefined();
    expect(gamma!.text.split("\n").length).toBeGreaterThan(1);
    const line = res.text.split("\n").find((l) => l.includes("gamma"));
    expect(line).toMatch(/… \+\d+ lines/);
  });

  it("orders matches by (file, line, column)", async () => {
    const res = await runCodeSearch({ pattern: fnPattern, lang: "ts", path: "src" }, localWs(FIXTURE));
    const keys = res.matches.map((m) => `${m.file}:${m.start.line}:${m.start.column}`);
    expect(keys).toEqual([...keys].sort());
  });

  it("applies globs post-discovery: include and '!' exclusion", async () => {
    const onlyA = await runCodeSearch({ pattern: fnPattern, lang: "ts", path: "src", globs: ["a.ts"] }, localWs(FIXTURE));
    expect(onlyA.matches.length).toBeGreaterThan(0);
    expect(onlyA.matches.every((m) => m.file === "src/a.ts")).toBe(true);
    const excluded = await runCodeSearch({ pattern: fnPattern, lang: "ts", path: "src", globs: ["*.ts", "!b.ts"] }, localWs(FIXTURE));
    expect(excluded.matches.every((m) => m.file !== "src/b.ts")).toBe(true);
    // later-wins
    const reWin = await runCodeSearch({ pattern: fnPattern, lang: "ts", path: "src", globs: ["!*.ts", "b.ts"] }, localWs(FIXTURE));
    expect(reWin.matches.every((m) => m.file === "src/b.ts")).toBe(true);
  });

  it("enforces maxMatches with a truthful summary and supports skip pagination", async () => {
    const all = await runCodeSearch({ pattern: "$NAME", lang: "ts", path: "src" }, localWs(FIXTURE));
    expect(all.totalMatches).toBeGreaterThan(5);
    const page1 = await runCodeSearch({ pattern: "$NAME", lang: "ts", path: "src", maxMatches: 3 }, localWs(FIXTURE));
    expect(page1.matches.length).toBe(3);
    expect(page1.truncated).toBe(true);
    expect(page1.text).toMatch(/\(showing 3 of \d+/);
    const page2 = await runCodeSearch({ pattern: "$NAME", lang: "ts", path: "src", maxMatches: 3, skip: 3 }, localWs(FIXTURE));
    expect(page2.matches.length).toBe(3);
    expect(page2.matches[0]).not.toEqual(page1.matches[0]);
  });

  it("zero match is a clean value with the scope searched", async () => {
    const res = await runCodeSearch({ pattern: "interface $NAME { $$$ }", lang: "ts", path: "src" }, localWs(FIXTURE));
    expect(res.totalMatches).toBe(0);
    expect(res.truncated).toBe(false);
    expect(res.text).toMatch(/^no matches in src/);
  });

  it("zero match is qualified when parse/pattern errors exist (auto-detect over mixed tree)", async () => {
    const res = await runCodeSearch({ pattern: "interface $NAME { $$$ }" }, localWs(FIXTURE));
    expect(res.totalMatches).toBe(0);
    // the .css file: the TS pattern carries an ERROR node in css — skipped
    // with a reason (the .py file is silently skipped by the napi — only
    // its five supported languages are visited)
    expect(res.parseErrorsTotal).toBeGreaterThan(0);
    expect(res.parseErrors.some((p) => p.file === "src/styles.css")).toBe(true);
    expect(res.text).toMatch(/mis-scoped|narrow path/);
  });

  it("reports regex-shaped patterns with the rg hint (no engine round-trip)", async () => {
    for (const p of ["foo.*bar", "\\w+call", "a|b", "get[0-9]"]) {
      expect(regexShapeHint(p)).toMatch(/rg/);
      await expect(runCodeSearch({ pattern: p, lang: "ts" }, localWs(FIXTURE))).rejects.toBeInstanceOf(CodeSearchError);
    }
    expect(regexShapeHint("function $NAME($$$ARGS) { $$$ }")).toBeNull();
  });

  it("garbage patterns match nothing (clean absence); the trivial class is rejected", async () => {
    // CLI referee behavior (probed): `function (unclosed` → warning + 0
    // matches, not an error — the executor agrees (no subprocess to carry
    // the warning, the absence is the answer)
    const garbage = await runCodeSearch({ pattern: "function (unclosed", lang: "ts" }, localWs(FIXTURE));
    expect(garbage.totalMatches).toBe(0);
    expect(garbage.text).toMatch(/^no matches/);
    // the exit-8 class: no code content at all
    for (const p of ["   ", ";;;"]) {
      await expect(
        runCodeSearch({ pattern: p, lang: "ts" }, localWs(FIXTURE)),
      ).rejects.toThrow(/no code content/);
    }
    // "not this language at all": a TS pattern with lang=css
    await expect(
      runCodeSearch({ pattern: "function $NAME", lang: "css" }, localWs(FIXTURE)),
    ).rejects.toThrow(/not valid in css/);
  });

  it("rejects languages outside the napi's five with the support list", async () => {
    await expect(
      runCodeSearch({ pattern: fnPattern, lang: "python" }, localWs(FIXTURE)),
    ).rejects.toThrow(/not supported by the code_search executor/);
    expect(LANGUAGE_ALIASES.ts).toBe("typescript");
    expect(LANGUAGE_ALIASES.jsx).toBe("javascript");
    expect(LANGUAGE_ALIASES.py).toBeUndefined();
  });

  it("errors cleanly on missing paths", async () => {
    await expect(
      runCodeSearch({ pattern: fnPattern, lang: "ts", path: "does-not-exist" }, localWs(FIXTURE)),
    ).rejects.toThrow(/path not found/);
  });

  it("refuses remote workspaces with the Phase 2 pointer", async () => {
    const remote = {
      label: "ssh:host:/srv",
      kind: "ssh" as const,
      readFile: async () => ({ content: "", isError: true }),
      writeFile: async () => ({ content: "", isError: true }),
      editFile: async () => ({ content: "", isError: true }),
      listFiles: async () => ({ content: "", isError: true }),
      bash: async () => ({ content: "", isError: true }),
      runPython: async () => ({ content: "", isError: true }),
      readAgentsMd: async () => null,
      validateRoot: async () => ({ valid: false, exists: false, isDirectory: false, isReadable: false, error: "fixture" }),
      createRootDirectory: async () => ({ success: false, error: "fixture" }),
    } as WorkspaceAdapter;
    await expect(runCodeSearch({ pattern: fnPattern }, remote)).rejects.toThrow(/local workspaces only/);
  });

  it("truncates over-cap output with a marker (env override of the char cap)", async () => {
    const prev = process.env.PORRIMA_CODE_SEARCH_MAX_CHARS;
    process.env.PORRIMA_CODE_SEARCH_MAX_CHARS = "300";
    try {
      const res = await runCodeSearch({ pattern: "$NAME", lang: "ts", path: "src" }, localWs(FIXTURE));
      expect(res.text).toMatch(/\[truncated at \d+ KB/);
    } finally {
      if (prev === undefined) delete process.env.PORRIMA_CODE_SEARCH_MAX_CHARS;
      else process.env.PORRIMA_CODE_SEARCH_MAX_CHARS = prev;
    }
  });
});

describe("gating and definition surface", () => {
  it("flag off: absent from definitions; flag on: present (fresh import sees the flip)", async () => {
    delete process.env.PORRIMA_CODE_SEARCH;
    expect(codeSearchEnabled()).toBe(false);
    const off = await import("./agent-tools.js");
    expect(off.getAgentToolDefinitions().some((t) => t.name === "code_search")).toBe(false);

    process.env.PORRIMA_CODE_SEARCH = "1";
    expect(codeSearchEnabled()).toBe(true);
    // FILESYSTEM_TOOLS is built at module scope (house pattern: the
    // kernel-tools capability line) — a query-param import re-evaluates it.
    const on = await import(new URL("./agent-tools.ts?codesearch=1", import.meta.url).href);
    const def = on.getAgentToolDefinitions().find((t: { name: string }) => t.name === "code_search");
    expect(def).toBeDefined();
    expect(def!.description).toMatch(/complete node/);
    expect(def!.parameters).toBeDefined();
    delete process.env.PORRIMA_CODE_SEARCH;
  });

  it("globs helper: gitignore-style any-depth match, later-wins", () => {
    expect(passesGlobs("src/a.ts", undefined)).toBe(true);
    expect(passesGlobs("src/a.ts", ["*.ts"])).toBe(true);
    expect(passesGlobs("src/a.md", ["*.ts"])).toBe(false);
    expect(passesGlobs("src/a.ts", ["*.ts", "!a.ts"])).toBe(false);
    expect(passesGlobs("src/a.ts", ["!*.ts", "a.ts"])).toBe(true);
  });
});
