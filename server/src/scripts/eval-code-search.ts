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
 *   The `eval[` title prefix doubles as the delayed-extraction firewall —
 *   the scheduler's candidate query skips such chats — so transcripts never
 *   feed the memory system even with a stray server alive. Purge the chats
 *   once graded (--purge); the jsonl rows keep the full answers.
 *   It names NO tools on purpose — discovery must come from the tool schema
 *   alone, which is the exact condition the flip creates (the phase-4
 *   guidance line is a nudge, not the mechanism). Naming code_search in the
 *   prompt would inflate adoption above what the flip itself delivers.
 * - Ground truth is recomputed at run time so the battery survives repo
 *   drift. Tasks 1/3/4/5 use rg (an independent oracle; T3 multiline-aware —
 *   line-based rg undercounts wrapped calls); task 2 is engine-derived (rg
 *   cannot express the shape — noted in the report). Oracle strings are
 *   deterministically ordered (rg's walk order is not).
 * - Correctness grading is human by design: the report prints each run's
 *   final answer next to its oracle. The one auto-flag is the false-
 *   conclusion probe (task 4): an absence claim while the oracle shows the
 *   code is there.
 * - Runs that never completed (turn timeout / iteration cap) are CENSORED:
 *   their "answer" is mid-turn narration. Censored rows are marked, excluded
 *   from gate medians, and never carry the fc flag.
 * - Default --reps 1 is a smoke; gate decisions want --reps 3+ (medians
 *   over single samples are noise, and ties pass the gate by design).
 * - Eval chats persist (the transcripts are the grading artifact);
 *   --purge deletes every chat with the eval title prefix.
 */
import { randomUUID } from "crypto";
import { execFileSync } from "child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { codeSearchEnabled, runCodeSearch } from "../services/code-search.js";
import { LocalWorkspaceAdapter } from "../services/workspace.js";
import type { Chat, ChatMessage } from "../types.js";

const TITLE_PREFIX = "eval[code-search] ";
const REPO_ROOT = realpathSync(fileURLToPath(new URL("../../..", import.meta.url)));
const DEFAULT_OUT_DIR = join(homedir(), ".porrima", "evals", "code-search");
const HARNESS_SYSTEM_PROMPT = [
  "You are a code-search agent in a project chat whose workspace is the root of this repository.",
  "Answer EXACTLY what the user asked — counts and file names — in your final message.",
  "Work from the files themselves using your tools.",
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
      // Complete-node form — WITHOUT `{ $$$ }` the pattern matches only
      // body-less declarations (overload signatures), not definitions: the
      // engine's complete-node rule cuts both ways. The plain form covers
      // async definitions too (verified: the async-specific pattern's
      // matches are a subset of this one's).
      const ws = new LocalWorkspaceAdapter(REPO_ROOT);
      const res = await runCodeSearch({ pattern: "function $NAME($ARG) { $$$ }", path: "server/src/services", maxMatches: 200 }, ws);
      const names = res.matches.map((m) => `${m.metaVariables?.NAME}@${m.file}`);
      return `${names.length} definitions: ${JSON.stringify(names)}`;
    },
    truthPresent: (o) => Number(o.match(/^(\d+)/)?.[1] ?? 0) > 0,
  },
  {
    id: 3,
    label: "template-literal console.log (rg oracle, multiline-aware)",
    prompt: "In `server/src` (TypeScript files), how many `console.log` calls pass a template literal (a backtick string) as their first argument? Report the count and the files with per-file counts.",
    oracle: async () => {
      // Multiline-aware (-U --count-matches): line-based rg undercounts calls
      // whose backtick starts after whitespace or on a later line (measured
      // 265 line-based vs 369 multiline — the models were right, the oracle
      // was wrong). Still an independent (non-engine) oracle.
      const c = rgCounts(["-U", "--count-matches", "console\\.log\\(\\s*`", "server/src", "-g", "*.ts"]);
      return `${c.total} template-literal console.log calls: ${JSON.stringify(c.byFile)}`;
    },
    truthPresent: (o) => Number(o.match(/^(\d+)/)?.[1] ?? 0) > 0,
  },
  {
    id: 4,
    label: "false-absence probe — answer lives in unscanned .py (rg oracle)",
    prompt: "Does the directory `server/python` contain any calls to `json.dumps`? If yes, report how many and the files. If genuinely none, answer exactly: none.",
    oracle: async () => {
      const lines = rgLines(["json\\.dumps\\(", "server/python"]);
      const files = [...new Set(lines.map((l) => l.split(":")[0]))].sort();
      return `${lines.length} json.dumps calls in: ${JSON.stringify(files)}`;
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
  // Sorted: rg's parallel walk order is nondeterministic, and an unsorted
  // JSON.stringify makes identical truths compare unequal (false drift
  // warnings across arms).
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** Per-file match counts (`rg --count-matches` output: "file:count" lines). */
function rgCounts(args: string[]): { total: number; byFile: Record<string, number> } {
  let out: string;
  try {
    out = execFileSync("rg", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  } catch (e: any) {
    if (e?.status === 1) return { total: 0, byFile: {} }; // no matches
    throw e;
  }
  const byFile: Record<string, number> = {};
  let total = 0;
  for (const l of out.split("\n")) {
    if (!l.trim()) continue;
    const i = l.lastIndexOf(":");
    const n = Number(l.slice(i + 1));
    if (i > 0 && Number.isFinite(n)) {
      byFile[l.slice(0, i)] = n;
      total += n;
    }
  }
  return { total, byFile: Object.fromEntries(Object.entries(byFile).sort(([a], [b]) => a.localeCompare(b))) };
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

const ABSENCE_RE = /\bnone\b|no matches|no (?:call|file|match|occurrence|definition)s?|not found|doesn'?t exist|zero(?:$|\s|\()|\b0+[*]*\s*(?:calls?|matches?|occurrences?|definitions?|files?|throws?|sites?|instances?)\b|there (?:is|are) no\b/i;
/**
 * An answer "claims absence" only when it does NOT commit to a NON-ZERO
 * count, in either presentation: "6 calls" (count-then-counter) or
 * "expressions: 147" / "Total: 369" (colon form — a live gate run flagged a
 * fully correct answer whose counts were all colon-form while a local
 * "verify there are no edge cases" qualifier tripped ABSENCE_RE). Measured
 * on live runs: correct answers qualify with "there are no other
 * candidates" — a local qualifier beside a stated count, not a conclusion.
 * The guard is deliberately blind to zero counts ("0 calls" is an absence
 * claim, not a commitment — `\b0+` above catches it, and `\b` keeps
 * "10 calls" out of both branches); the colon form requires the separator
 * so prose like "no matches in the 3 files" doesn't smuggle a suppression.
 * Flags are recomputed at report time, so this logic can evolve without
 * invalidating stored rows.
 */
function answerClaimsAbsence(text: string): boolean {
  if (/[*]*[1-9]\d*[*]*\s*(?:calls?|matches?|occurrences?|definitions?|files?|throws?|sites?|instances?)/i.test(text)) return false;
  if (/(?:calls?|matches?|occurrences?|definitions?|files?|throws?|sites?|instances?|expressions?|total)\s*[:=]\s*[*]*[1-9]\d*/i.test(text)) return false;
  return ABSENCE_RE.test(text);
}

/**
 * A run is CENSORED when the turn did not complete (timeout, iteration cap,
 * error): its "final answer" is mid-turn narration and its turn/token counts
 * are truncated at the cap. Censored rows are excluded from gate medians and
 * never carry the false-conclusion flag — the detector judges final answers,
 * not streams (the shakeout's one fc-flag was "Let me verify none exist" in
 * a timed-out narration: a detector hit on text that was never an answer).
 */
function isCensored(r: RunRow): boolean {
  return !r.ok || r.stopReason !== "stop";
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
          // Sized for a local 27B on one GPU with cold prompts (~33k chars):
          // the shakeout's 240 s / 12 iterations censored 4/10 runs mid-
          // narration — an unfinished turn is not a gradeable answer.
          maxIterations: 16,
          timeoutMs: 600_000,
          keepAlive: "5m",
          logPrefix: `eval:${arm}-T${task.id}-r${rep}`,
          saveChat,
        });
        // Metrics from the persisted transcript (single source of truth).
        // Note: in-kernel `tools.code_search` dispatches ride run_python in
        // this tally — kernel-side adoption is invisible to the byTool
        // counts (acceptable while models rarely open a kernel for one
        // search; revisit if that changes).
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
        // Final answer = the LAST assistant message (the turn's closing
        // text), not turn.textSummary — the summary concatenates mid-turn
        // narration, which pollutes both the grading appendix and the
        // absence detector ("Let me verify none exist" is narration, not a
        // conclusion). Censored rows fall back to the summary (there is no
        // closing message; they are excluded from grading anyway).
        let finalAnswer = turn.textSummary ?? "";
        for (let i = chat.messages.length - 1; i >= 0; i--) {
          const m = chat.messages[i];
          if (m.role === "assistant" && typeof m.content === "string" && m.content.trim()) {
            finalAnswer = m.content;
            break;
          }
        }
        const censored = !turn.success || turn.stopReason !== "stop";
        const absenceClaim = !censored && answerClaimsAbsence(finalAnswer);
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
      console.log(`[${arm}] T${task.id} r${rep}: ok=${row.ok} stop=${row.stopReason}${isCensored(row) ? " CENSORED" : ""} turns=${row.iterations} tools=${row.toolCalls} tokens=${row.totalTokens} fcFlag=${row.suspectedFalseConclusion}${row.error ? ` ERR=${row.error.slice(0, 80)}` : ""}`);
    }
  }
  console.log(`done: ${opts.out}`);
  process.exit(0);
}

// --- report mode ----------------------------------------------------------

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function report(files: string[]): void {
  const rows: RunRow[] = files.flatMap((f) =>
    readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as RunRow),
  );
  // Recompute absence flags with current logic (stored rows are data, not
  // judgments — the detector evolves, the transcripts do not). Censored rows
  // never flag: their "answer" is mid-turn narration, not a conclusion.
  for (const r of rows) {
    const t = TASKS.find((x) => x.id === r.task);
    if (!t) continue;
    r.absenceClaim = !isCensored(r) && answerClaimsAbsence(r.finalAnswer);
    r.suspectedFalseConclusion = r.absenceClaim && t.truthPresent(r.oracle);
  }
  const arms = [...new Set(rows.map((r) => r.arm))];
  const censoredTotal = rows.filter(isCensored).length;
  console.log(`battery report — ${rows.length} runs, arms: ${arms.join(", ")}${censoredTotal > 0 ? `, ${censoredTotal} censored (timeout/iteration-cap — excluded from medians and fc flags)` : ""}\n`);
  const head = ["task", "arm", "n", "done", "turns", "tools", "code_search?", "tool_err", "tokens", "tool_out_KB", "fc-flag"];
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
      const done = rs.filter((r) => !isCensored(r));
      const usedCS = rs.filter((r) => (r.byTool.code_search ?? 0) > 0).length;
      const med = (xs: number[]) => (xs.length === 0 ? "-" : String(median(xs)));
      table.push([
        `T${t}`, a, String(rs.length), `${done.length}/${rs.length}`,
        med(done.map((r) => r.iterations)),
        med(done.map((r) => r.toolCalls)),
        a === "on" ? `${usedCS}/${rs.length}` : "n/a",
        String(rs.reduce((s, r) => s + r.toolErrors, 0)),
        med(done.map((r) => r.totalTokens).map(Math.round)),
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

  // Oracle drift across runs: rows store the oracle as recomputed at their
  // run time — if the repo moved between the two arms, the comparison is
  // against different truths. Arms are meant to run back-to-back.
  const driftWarnings: string[] = [];
  for (const t of taskIds) {
    const variants = new Set(rows.filter((r) => r.task === t).map((r) => r.oracle));
    if (variants.size > 1) {
      driftWarnings.push(`  T${t}: ${variants.size} distinct oracle values across runs — the repo drifted between arms; rerun them back-to-back`);
    }
  }
  if (driftWarnings.length > 0) console.log(`\nwarnings:\n${driftWarnings.join("\n")}`);

  // §4.1 gate per task: on must NOT LOSE on turns/tokens (ties pass — at
  // battery scale parity with the baseline is the bar; wins are the bonus)
  // and must not add false conclusions. Medians run over completed rows
  // only — a censored turn's counts are truncated at the cap, not earned.
  console.log("\ngate (per §4.1: on must not lose turns/tokens, no new false conclusions; censored rows excluded):");
  for (const t of taskIds) {
    const off = byTaskArm.get(`${t}:off`) ?? [];
    const on = byTaskArm.get(`${t}:on`) ?? [];
    const offDone = off.filter((r) => !isCensored(r));
    const onDone = on.filter((r) => !isCensored(r));
    if (offDone.length === 0 || onDone.length === 0) {
      console.log(`  T${t}: no comparison (${offDone.length}/${off.length} off done, ${onDone.length}/${on.length} on done)`);
      continue;
    }
    const turns = median(onDone.map((r) => r.iterations)) <= median(offDone.map((r) => r.iterations));
    const tokens = median(onDone.map((r) => r.totalTokens)) <= median(offDone.map((r) => r.totalTokens));
    const fc = on.filter((r) => r.suspectedFalseConclusion).length <= off.filter((r) => r.suspectedFalseConclusion).length;
    console.log(`  T${t}: ${turns && tokens && fc ? "PASS" : "FAIL"} (turns ${turns ? "ok" : "worse"}, tokens ${tokens ? "ok" : "worse"}, false-conclusions ${fc ? "ok" : "worse"}; done off=${offDone.length}/${off.length} on=${onDone.length}/${on.length})`);
  }

  // Grading appendix: oracle vs final answer, per run (human judgment).
  console.log("\ngrading appendix (human check — oracle vs answer):");
  for (const r of rows) {
    console.log(`\n  [${r.arm}] T${r.task} r${r.rep} ${r.title}${isCensored(r) ? ` (CENSORED stop=${r.stopReason} — "answer" is mid-turn narration, not gradeable)` : ""}`);
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
