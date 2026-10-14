/**
 * eval-code-search.ts — the §4.1 battery for docs/design/code-search.md.
 *
 * Measures the PORRIMA_CODE_SEARCH default-shift bet: same tasks, same
 * harness prompt, two arms (flag off = bash+rg baseline, flag on =
 * code_search available), metrics read back from the persisted eval chats.
 *
 * Usage (from server/):
 *   PORRIMA_EVAL_CODE_SEARCH=1 npx tsx src/scripts/eval-code-search.ts \
 *       [--tasks 1,4] [--reps 3] [--model <id>] [--out <path>]
 *   # once per arm — the flag is per-process; the run records which arm it is:
 *   PORRIMA_EVAL_CODE_SEARCH=1 npx tsx src/scripts/eval-code-search.ts --out /tmp/opencode/eval-code-search/off.jsonl
 *   PORRIMA_EVAL_CODE_SEARCH=1 PORRIMA_CODE_SEARCH=1 npx tsx src/scripts/eval-code-search.ts --out /tmp/opencode/eval-code-search/on.jsonl
 *   npx tsx src/scripts/eval-code-search.ts --report /tmp/opencode/eval-code-search/off.jsonl /tmp/opencode/eval-code-search/on.jsonl
 *   PORRIMA_EVAL_CODE_SEARCH=1 npx tsx src/scripts/eval-code-search.ts --purge
 *
 * Notes:
 * - Runs REAL agent turns through the shared headless turn runner with the
 *   production tool surface (getAgentTools + withHeadlessAskUser), on a
 *   project chat bound to this repo, and takes a foreground turn-gate lease
 *   per run — quiet the system (pause automations) for determinism; eval
 *   turns queue against live chat traffic otherwise.
 * - The harness system prompt is a fixed minimal coding-agent prompt, NOT
 *   the memory-augmented interactive one: both arms must differ only in the
 *   tool surface, and eval runs must not write memories or touch synthesis.
 * - Ground truth is recomputed at run time so the battery survives repo
 *   drift. Tasks 1/3/4/5 use rg (an independent oracle); task 2 is
 *   engine-derived (rg cannot express the shape — noted in the report).
 * - Correctness grading is human by design: the report prints each run's
 *   final answer next to its oracle. The one auto-flag is the false-
 *   conclusion probe (task 4): an absence claim while the oracle shows the
 *   code is there.
 * - Eval chats persist (the transcripts are the grading artifact);
 *   --purge deletes every chat with the eval title prefix.
 */
import { randomUUID } from "crypto";
import { execFileSync } from "child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { codeSearchEnabled, runCodeSearch } from "../services/code-search.js";
import { LocalWorkspaceAdapter } from "../services/workspace.js";
import type { Chat, ChatMessage } from "../types.js";

const TITLE_PREFIX = "eval[code-search] ";
const REPO_ROOT = realpathSync(new URL("../../..", import.meta.url).pathname);
const DEFAULT_OUT_DIR = join(homedir(), ".porrima", "evals", "code-search");
const HARNESS_SYSTEM_PROMPT = [
  "You are a code-search agent in a project chat whose workspace is the root of this repository.",
  "Answer EXACTLY what the user asked — counts and file names — in your final message.",
  "Work from the files themselves using your tools (bash, read_file, run_python, and code_search if available).",
  "Keep searches scoped to the path the question names. Do not modify any file.",
].join(" ");

interface TaskDef {
  id: number;
  label: string;
  prompt: string;
  /** Ground truth, recomputed per run. */
  oracle: () => Promise<string>;
  /** For the false-conclusion flag: truth considered "answer exists". */
  truthPresent: (oracle: string) => boolean;
}

function rgLines(args: string[]): string[] {
  try {
    const out = execFileSync("rg", ["--no-heading", "-n", ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return out.split("\n").filter((l) => l.trim().length > 0);
  } catch (e: any) {
    if (e?.status === 1) return []; // rg exit 1 = no matches
    throw e;
  }
}

const TASKS: TaskDef[] = [
  {
    id: 1,
    label: "call sites (rg oracle)",
    prompt: "How many call sites does `withMutationLock` have under `server/src` in TypeScript files? A call site is any line that calls it, excluding the definition itself. Report the count and the files with per-file counts.",
    oracle: async () => {
      const all = rgLines(["withMutationLock\\(", "server/src", "-g", "*.ts"]);
      const calls = all.filter((l) => !/(function|const) withMutationLock/.test(l));
      return `${calls.length} call sites across files: ${JSON.stringify(groupCounts(calls))}`;
    },
    truthPresent: (o) => Number(o.match(/^(\d+)/)?.[1] ?? 0) > 0,
  },
  {
    id: 2,
    label: "one-parameter function defs (engine oracle — rg cannot express this shape)",
    prompt: "In `server/src/services`, which function definitions take EXACTLY one parameter? Report each function's name and file. Cover both plain and async definitions.",
    oracle: async () => {
      const ws = new LocalWorkspaceAdapter(REPO_ROOT);
      const res = await runCodeSearch({ pattern: "function $NAME($ARG)", path: "server/src/services", maxMatches: 200 }, ws);
      const names = res.matches.map((m) => `${m.metaVariables?.NAME}@${m.file}`);
      return `${names.length} definitions: ${JSON.stringify(names)}`;
    },
    truthPresent: (o) => Number(o.match(/^(\d+)/)?.[1] ?? 0) > 0,
  },
  {
    id: 3,
    label: "template-literal console.log (rg oracle)",
    prompt: "In `server/src` (TypeScript files), how many `console.log` calls pass a template literal (a backtick string) as their first argument? Report the count and the files with per-file counts.",
    oracle: async () => {
      const lines = rgLines(["console\\.log\\(`", "server/src", "-g", "*.ts"]);
      return `${lines.length} template-literal console.log calls: ${JSON.stringify(groupCounts(lines))}`;
    },
    truthPresent: (o) => Number(o.match(/^(\d+)/)?.[1] ?? 0) > 0,
  },
  {
    id: 4,
    label: "false-absence probe — answer lives in unscanned .py (rg oracle)",
    prompt: "Does the directory `server/python` contain any calls to `json.dumps`? If yes, report how many and the files. If genuinely none, answer exactly: none.",
    oracle: async () => {
      const lines = rgLines(["json\\.dumps\\(", "server/python"]);
      return `${lines.length} json.dumps calls in: ${JSON.stringify([...new Set(lines.map((l) => l.split(":")[0]))])}`;
    },
    truthPresent: (o) => Number(o.match(/^(\d+)/)?.[1] ?? 0) > 0,
  },
  {
    id: 5,
    label: "iterative refine pair (rg oracle ×2)",
    prompt: "Two counts for `server/src/services` TypeScript files: (a) how many `throw new <Something>(...)` expressions are there in total, and (b) of those, how many construct `CodeSearchError` specifically? Report both numbers.",
    oracle: async () => {
      const a = rgLines(["throw new ", "server/src/services", "-g", "*.ts"]).length;
      const b = rgLines(["throw new CodeSearchError\\(", "server/src/services", "-g", "*.ts"]).length;
      return `total throws: ${a}; CodeSearchError throws: ${b}`;
    },
    truthPresent: (o) => Number(o.match(/^total throws: (\d+)/)?.[1] ?? 0) > 0,
  },
];

function groupCounts(lines: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of lines) {
    const file = l.split(":")[0];
    out[file] = (out[file] ?? 0) + 1;
  }
  return out;
}

// --- run mode -------------------------------------------------------------

interface RunRow {
  ts: string;
  arm: "off" | "on";
  task: number;
  rep: number;
  model: string;
  chatId: string;
  title: string;
  ok: boolean;
  error?: string;
  iterations: number;
  stopReason: string;
  toolCalls: number;
  byTool: Record<string, number>;
  toolErrors: number;
  toolResultChars: number;
  totalTokens: number;
  elapsedMs: number;
  oracle: string;
  finalAnswer: string;
  absenceClaim: boolean;
  suspectedFalseConclusion: boolean;
}

const ABSENCE_RE = /\bnone\b|no matches|no (?:call|file|match|occurrence|definition)s?|not found|doesn'?t exist|zero(?:$|\s|\()|there (?:is|are) no\b/i;
/**
 * An answer "claims absence" only when it does NOT commit to a positive
 * count. Measured on a live run: correct answers qualify with "there are
 * no other candidates" — a local qualifier beside a stated "6 calls", not
 * a conclusion. Flags are recomputed at report time, so this logic can
 * evolve without invalidating stored rows.
 */
function answerClaimsAbsence(text: string): boolean {
  if (/[*]*\d+[*]*\s*(?:calls?|matches?|occurrences?|definitions?|files?|throws?|sites?|instances?)/i.test(text)) return false;
  return ABSENCE_RE.test(text);
}

async function runArm(opts: { tasks: number[]; reps: number; modelOverride?: string; out: string }): Promise<void> {
  const arm = codeSearchEnabled() ? "on" : "off";
  const {
    createChat, getSettings, listProjects, saveChat,
  } = await import("../services/chat-storage.js");
  const { discoverAllModels, createPiModelFromProvider } = await import("../services/models.js");
  const { getAgentTools } = await import("../services/agent-tools.js");
  const { withHeadlessAskUser } = await import("../services/headless-tools.js");
  const { SynthesisEmitter, createEmitterSideEffects } = await import("../services/synthesis-stream.js");
  const { runHeadlessChatTurn } = await import("../services/chat-turn-runner.js");
  const { acquireTurn, releaseTurn } = await import("../services/turn-gate.js");
  const { createTimeMarkerState } = await import("../services/time-marker.js");

  // Model: mirror the automation resolver (settings default → first available).
  const models = await discoverAllModels();
  if (models.length === 0) throw new Error("no models available — is the llama.cpp router up?");
  let modelId = opts.modelOverride;
  if (modelId && !models.find((m) => m.id === modelId)) throw new Error(`model ${modelId} not available`);
  if (!modelId) {
    const settings = await getSettings();
    modelId = (settings.defaultModelId && models.find((m) => m.id === settings.defaultModelId)?.id) ?? models[0].id;
  }
  const piModel = models.find((m) => m.id === modelId)!;
  const contextWindow = piModel.contextWindow || 32768;
  const runtimeModel = await createPiModelFromProvider(piModel);
  runtimeModel.contextWindow = contextWindow;

  // Project: bind to a project rooted at this repo so tools see the same
  // workspace a real project chat would.
  const project = (await listProjects()).find((p) => {
    try { return realpathSync(p.path) === REPO_ROOT; } catch { return false; }
  });
  if (!project) {
    throw new Error(`no project bound to ${REPO_ROOT} — create one in the UI first (the battery runs in project chats)`);
  }

  const { timeMarkerIntervalMinutes } = await getSettings();
  mkdirSync(join(opts.out, ".."), { recursive: true });
  console.log(`battery arm=${arm} model=${modelId} project=${project.name} tasks=${opts.tasks.join(",")} reps=${opts.reps} out=${opts.out}`);

  for (const taskId of opts.tasks) {
    const task = TASKS.find((t) => t.id === taskId)!;
    for (let rep = 1; rep <= opts.reps; rep++) {
      const chatId = randomUUID();
      const title = `${TITLE_PREFIX}${arm} T${task.id} r${rep}`;
      const oracle = await task.oracle();
      const started = Date.now();
      const chat: Chat = {
        id: chatId,
        title,
        type: "agent" as const,
        modelId,
        projectId: project.id,
        messages: [{ role: "user" as const, content: task.prompt, timestamp: Date.now() } as ChatMessage],
        createdAt: new Date().toISOString(),
        lastModified: new Date().toISOString(),
      };
      await createChat(chat);

      const emitter = new SynthesisEmitter(chatId);
      let lease: Awaited<ReturnType<typeof acquireTurn>> | null = null;
      let row: RunRow;
      try {
        const effects = createEmitterSideEffects(emitter, { artifacts: [], visuals: [] });
        const tools = withHeadlessAskUser(
          getAgentTools(chatId, effects, contextWindow, project, "agent", createTimeMarkerState(timeMarkerIntervalMinutes)),
        );
        // The flag is per-process; prove the arm's surface here rather than
        // trusting the env alone.
        const hasCodeSearch = tools.some((t: { name: string }) => t.name === "code_search");
        if (hasCodeSearch !== (arm === "on")) {
          throw new Error(`arm/surface mismatch: flag says ${arm}, tools say ${hasCodeSearch}`);
        }
        lease = await acquireTurn(chatId, { kind: "chat", priority: "foreground" });
        const turn = await runHeadlessChatTurn({
          chat,
          modelId,
          model: runtimeModel,
          systemPrompt: HARNESS_SYSTEM_PROMPT,
          tools,
          emitter,
          contextWindow,
          maxIterations: 12,
          timeoutMs: 240_000,
          keepAlive: "5m",
          logPrefix: `eval:${arm}-T${task.id}-r${rep}`,
          saveChat,
        });
        // Metrics from the persisted transcript (single source of truth).
        let toolCalls = 0;
        let toolErrors = 0;
        let toolResultChars = 0;
        let totalTokens = 0;
        const byTool: Record<string, number> = {};
        for (const m of chat.messages) {
          if (m.role !== "assistant") continue;
          totalTokens += m.usage?.totalTokens ?? 0;
          for (const c of m.toolCalls ?? []) {
            toolCalls++;
            byTool[c.name] = (byTool[c.name] ?? 0) + 1;
          }
          for (const r of m.toolResults ?? []) {
            toolResultChars += r.content?.length ?? 0;
            if (r.isError) toolErrors++;
          }
        }
        const finalAnswer = turn.textSummary ?? "";
        const absenceClaim = answerClaimsAbsence(finalAnswer);
        row = {
          ts: new Date().toISOString(),
          arm,
          task: task.id,
          rep,
          model: modelId,
          chatId,
          title,
          ok: turn.success,
          error: turn.error,
          iterations: turn.iterations,
          stopReason: turn.stopReason,
          toolCalls,
          byTool,
          toolErrors,
          toolResultChars,
          totalTokens,
          elapsedMs: Date.now() - started,
          oracle,
          finalAnswer,
          absenceClaim,
          suspectedFalseConclusion: absenceClaim && task.truthPresent(oracle),
        };
      } catch (e: any) {
        row = {
          ts: new Date().toISOString(), arm, task: task.id, rep, model: modelId, chatId, title,
          ok: false, error: String(e?.message ?? e),
          iterations: 0, stopReason: "error", toolCalls: 0, byTool: {}, toolErrors: 0,
          toolResultChars: 0, totalTokens: 0, elapsedMs: Date.now() - started,
          oracle, finalAnswer: "", absenceClaim: false, suspectedFalseConclusion: false,
        };
      } finally {
        releaseTurn(lease);
        try { emitter.end(); } catch { /* already closed */ }
      }
      appendFileSync(opts.out, JSON.stringify(row) + "\n");
      console.log(`[${arm}] T${task.id} r${rep}: ok=${row.ok} turns=${row.iterations} tools=${row.toolCalls} tokens=${row.totalTokens} fcFlag=${row.suspectedFalseConclusion}${row.error ? ` ERR=${row.error.slice(0, 80)}` : ""}`);
    }
  }
  console.log(`done: ${opts.out}`);
  process.exit(0);
}

// --- report mode ----------------------------------------------------------

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function report(files: string[]): void {
  const rows: RunRow[] = files.flatMap((f) =>
    readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as RunRow),
  );
  // Recompute absence flags with current logic (stored rows are data, not
  // judgments — the detector evolves, the transcripts do not).
  for (const r of rows) {
    const t = TASKS.find((x) => x.id === r.task);
    if (!t) continue;
    r.absenceClaim = answerClaimsAbsence(r.finalAnswer);
    r.suspectedFalseConclusion = r.absenceClaim && t.truthPresent(r.oracle);
  }
  const arms = [...new Set(rows.map((r) => r.arm))];
  console.log(`battery report — ${rows.length} runs, arms: ${arms.join(", ")}\n`);
  const head = ["task", "arm", "n", "turns", "tools", "code_search?", "tool_err", "tokens", "search_out_KB", "fc-flag"];
  const table: string[][] = [];
  const byTaskArm = new Map<string, RunRow[]>();
  for (const r of rows) {
    const key = `${r.task}:${r.arm}`;
    byTaskArm.set(key, [...(byTaskArm.get(key) ?? []), r]);
  }
  const taskIds = [...new Set(rows.map((r) => r.task))].sort((a, b) => a - b);
  for (const t of taskIds) {
    for (const a of arms) {
      const rs = byTaskArm.get(`${t}:${a}`) ?? [];
      if (rs.length === 0) continue;
      const usedCS = rs.filter((r) => (r.byTool.code_search ?? 0) > 0).length;
      table.push([
        `T${t}`, a, String(rs.length),
        String(median(rs.map((r) => r.iterations))),
        String(median(rs.map((r) => r.toolCalls))),
        a === "on" ? `${usedCS}/${rs.length}` : "n/a",
        String(rs.reduce((s, r) => s + r.toolErrors, 0)),
        String(Math.round(median(rs.map((r) => r.totalTokens)))),
        (rs.reduce((s, r) => s + r.toolResultChars, 0) / 1024).toFixed(1),
        String(rs.filter((r) => r.suspectedFalseConclusion).length),
      ]);
    }
  }
  const widths = head.map((h, i) => Math.max(h.length, ...table.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log(line(head));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of table) console.log(line(r));

  // §4.1 gate per task: on-arm wins on turns AND tokens vs off-arm, and the
  // false-conclusion flag does not increase.
  console.log("\ngate (per §4.1: on must win turns+tokens, no new false conclusions):");
  for (const t of taskIds) {
    const off = byTaskArm.get(`${t}:off`) ?? [];
    const on = byTaskArm.get(`${t}:on`) ?? [];
    if (off.length === 0 || on.length === 0) { console.log(`  T${t}: no comparison (${off.length} off / ${on.length} on runs)`); continue; }
    const turns = median(on.map((r) => r.iterations)) <= median(off.map((r) => r.iterations));
    const tokens = median(on.map((r) => r.totalTokens)) <= median(off.map((r) => r.totalTokens));
    const fc = on.filter((r) => r.suspectedFalseConclusion).length <= off.filter((r) => r.suspectedFalseConclusion).length;
    console.log(`  T${t}: ${turns && tokens && fc ? "PASS" : "FAIL"} (turns ${turns ? "ok" : "worse"}, tokens ${tokens ? "ok" : "worse"}, false-conclusions ${fc ? "ok" : "worse"})`);
  }

  // Grading appendix: oracle vs final answer, per run (human judgment).
  console.log("\ngrading appendix (human check — oracle vs answer):");
  for (const r of rows) {
    console.log(`\n  [${r.arm}] T${r.task} r${r.rep} ${r.title}`);
    console.log(`    truth : ${r.oracle.slice(0, 400)}`);
    console.log(`    answer: ${r.finalAnswer.replace(/\n/g, " ").slice(0, 400)}`);
    if (r.absenceClaim) console.log(`    NOTE  : absence claim${r.suspectedFalseConclusion ? " — SUSPECTED FALSE CONCLUSION" : ""}`);
  }
}

// --- purge mode -----------------------------------------------------------

async function purge(): Promise<void> {
  const { listChats, deleteChat } = await import("../services/chat-storage.js");
  const { cancelDeletedChatWork } = await import("../services/chat-deletion.js");
  const chats = (await listChats()).filter((c) => c.title.startsWith(TITLE_PREFIX));
  for (const c of chats) {
    await cancelDeletedChatWork(c.id);
    await deleteChat(c.id);
    console.log(`deleted ${c.title}`);
  }
  console.log(`purged ${chats.length} eval chats`);
  process.exit(0);
}

// --- main -----------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const val = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (flag("report")) {
  const files = argv.slice(argv.indexOf("--report") + 1).filter((a) => !a.startsWith("--"));
  if (files.length === 0) { console.error("--report needs one or two .jsonl files (off on)"); process.exit(1); }
  for (const f of files) if (!existsSync(f)) { console.error(`no such file: ${f}`); process.exit(1); }
  report(files);
} else if (flag("purge")) {
  if (process.env.PORRIMA_EVAL_CODE_SEARCH !== "1") { console.error("PORRIMA_EVAL_CODE_SEARCH=1 required"); process.exit(1); }
  void purge();
} else {
  if (process.env.PORRIMA_EVAL_CODE_SEARCH !== "1") {
    console.error("PORRIMA_EVAL_CODE_SEARCH=1 required — this script runs real agent turns and writes eval chats.");
    console.error("Run once per arm (with/without PORRIMA_CODE_SEARCH=1), then --report both files. See header.");
    process.exit(1);
  }
  const tasks = (val("tasks") ?? "1,2,3,4,5").split(",").map((s) => Number(s.trim())).filter((n) => TASKS.some((t) => t.id === n));
  const reps = Math.max(1, Number(val("reps") ?? "1"));
  const arm = codeSearchEnabled() ? "on" : "off";
  const out = val("out") ?? join(DEFAULT_OUT_DIR, `${arm}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.jsonl`);
  void runArm({ tasks, reps, modelOverride: val("model"), out });
}
