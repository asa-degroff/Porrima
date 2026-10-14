/* Live smoke: PORRIMA_CODE_SEARCH=1 npx tsx src/scripts/smoke-code-search.ts */
import { codeSearchEnabled, runCodeSearch } from "../services/code-search.js";
import { LocalWorkspaceAdapter } from "../services/workspace.js";

if (process.env.PORRIMA_CODE_SEARCH !== "1") {
  console.error("PORRIMA_CODE_SEARCH=1 is required — refusing to run (the feature is dark without it).");
  process.exit(1);
}

// Repo root = one level up from server/ (the smoke runs from server/).
const ws = new LocalWorkspaceAdapter(process.cwd().replace(/\/server$/, ""));
console.log("workspace:", ws.label);

const p1 = { pattern: "function $NAME", lang: "ts", path: "server/src/services", maxMatches: 5 };
const r1 = await runCodeSearch(p1, ws);
console.log("\n--- async function defs (5) ---\n" + r1.text);

const p1b = { pattern: "return $VALUE", lang: "ts", path: "server/src/services/turn-gate.ts", maxMatches: 3 };
const r1b = await runCodeSearch(p1b, ws);
console.log("\n--- return VALUE in turn-gate (3) ---\n" + r1b.text);

const p2 = { pattern: "await tools.$FN($$$ARGS)" };
const r2 = await runCodeSearch(p2, ws);
console.log("\n--- await tools.* (auto-detect) ---\n" + r2.text);

const p3 = { pattern: "function (broken" , lang: "ts"};
const r3 = await runCodeSearch(p3, ws);
console.log("\n--- garbage pattern (CLI: warning + no matches; executor: clean absence) ---\n" + r3.text);

const p3b = { pattern: ";;;" , lang: "ts"};
try {
  await runCodeSearch(p3b, ws);
  console.log("\nERROR: trivial pattern did not throw");
} catch (e: any) {
  console.log("\n--- trivial pattern (expected error) ---\n" + e.message);
}

const p4 = { pattern: "get[0-9]+" , lang: "ts"};
try {
  await runCodeSearch(p4, ws);
  console.log("\nERROR: regex pattern did not throw");
} catch (e: any) {
  console.log("\n--- regex pattern (expected error) ---\n" + e.message);
}
console.log("\nsmoke OK");
