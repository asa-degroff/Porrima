/* Live smoke: PORRIMA_CODE_SEARCH=1 npx tsx src/scripts/smoke-code-search.ts */
import { codeSearchEnabled, runCodeSearch } from "../services/code-search.js";
import { LocalWorkspaceAdapter } from "../services/workspace.js";

if (!codeSearchEnabled()) {
  console.error("PORRIMA_CODE_SEARCH=1 is required — refusing to run (the feature is dark without it).");
  process.exit(1);
}

// Repo root = one level up from server/ (the smoke runs from server/).
const ws = new LocalWorkspaceAdapter(process.cwd().replace(/\/server$/, ""));
console.log("workspace:", ws.label);

const r1 = await runCodeSearch({ pattern: "function $NAME", lang: "ts", path: "server/src/services", maxMatches: 5 }, ws);
console.log("\n--- function defs (5) ---\n" + r1.text);

const r1b = await runCodeSearch({ pattern: "return $VALUE", lang: "ts", path: "server/src/services/turn-gate.ts", maxMatches: 3 }, ws);
console.log("\n--- return VALUE in turn-gate (3) ---\n" + r1b.text);

const r2 = await runCodeSearch({ pattern: "await tools.$FN($$$ARGS)" }, ws);
console.log("\n--- await tools.* (auto-detect) ---\n" + r2.text);

const r3 = await runCodeSearch({ pattern: "function (broken", lang: "ts" }, ws);
console.log("\n--- garbage pattern (tolerant parse → clean absence) ---\n" + r3.text);

const r4 = await runCodeSearch({ pattern: "def $F($$$ARGS)" }, ws);
console.log("\n--- python pattern (census reports unscanned languages) ---\n" + r4.text);

for (const [label, p, expect] of [
  ["trivial", ";;;", /no code content/],
  ["regex shape", "get[0-9]+", /rg/],
] as const) {
  try {
    await runCodeSearch({ pattern: p, lang: "ts" }, ws);
    console.log(`\nERROR: ${label} pattern did not throw`);
  } catch (e: any) {
    if (!expect.test(e.message)) console.log(`\nERROR: ${label} message unexpected:`, e.message);
    else console.log(`\n--- ${label} pattern (expected error) ---\n${e.message}`);
  }
}
console.log("\nsmoke OK");
