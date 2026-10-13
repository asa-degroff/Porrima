/**
 * Live smoke test for in-kernel tool composition (docs/design/kernel-codemode.md
 * Phase A). Drives the PRODUCTION wiring — getAgentTools' run_python execute,
 * the injected dispatcher, the real kernel manager — against a scratch
 * workspace so nothing touches the user's projects. Memory reads hit the live
 * retrieval stack (embeddings 32103 + reranker 32102); web_fetch hits the
 * network. Checklist style mirrors smoke-remote-kernel.ts.
 *
 *   PORRIMA_KERNEL_TOOLS=1 npx tsx src/scripts/smoke-kernel-tools.ts [--root <dir>]
 *
 * Refuses to run without the flag (that's the dark-launch contract). Exits
 * non-zero on any failed check. Cleans up its own kernel state + spill dir.
 */

import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

async function main(): Promise<void> {
  if (process.env.PORRIMA_KERNEL_TOOLS !== "1") {
    console.error("PORRIMA_KERNEL_TOOLS=1 is required — refusing to run (the feature is dark without it).");
    process.exit(2);
  }
  const rootArgIndex = process.argv.indexOf("--root");
  const scratch = rootArgIndex !== -1 ? process.argv[rootArgIndex + 1] : undefined;
  const root = scratch ?? (await mkdtemp(join(tmpdir(), "porrima-ktools-smoke-")));
  const chatId = `smoke-kernel-tools-${Date.now().toString(36)}`;

  const { appDataPath } = await import("../services/paths.js");
  const { getAgentTools, getAgentToolDefinitions } = await import("../services/agent-tools.js");
  const { disposeKernel } = await import("../services/python-kernel.js");

  const effects = { onArtifact: () => {}, onVisual: () => {}, onAskUser: () => {} };
  const tools = getAgentTools(chatId, effects, 32768, root, "agent");
  const runPython = tools.find((t) => t.name === "run_python");
  if (!runPython) throw new Error("run_python missing from the tool surface");

  let pass = 0;
  let fail = 0;
  const cell = async (code: string, timeoutSec = 120): Promise<string> => {
    const res = await runPython.execute("smoke", { code, timeout: timeoutSec }, new AbortController().signal);
    const text = (res.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");
    if (res.isError) throw new Error(`cell failed: ${text.slice(0, 300)}`);
    return text;
  };
  const expect = async (name: string, code: string, needle: string): Promise<void> => {
    try {
      const out = await cell(code);
      if (out.includes(needle)) {
        console.log(`  PASS  ${name}`);
        pass++;
      } else {
        console.log(`  FAIL  ${name}: output missing "${needle}"\n        got: ${out.slice(0, 300)}`);
        fail++;
      }
    } catch (e: any) {
      console.log(`  FAIL  ${name}: ${e?.message ?? e}`);
      fail++;
    }
  };

  await writeFile(join(root, "smoke-input.txt"), "hello from smoke\n");
  console.log(`[smoke-kernel-tools] chat=${chatId} root=${root}`);
  const t0 = Date.now();

  await expect(
    "tools namespace exposes the full tier-1 surface",
    'names = sorted(n for n in dir(tools) if not n.startswith("_") and n != "list")\nprint(",".join(names))',
    "bash,list_files,list_memory_blocks,read_archived_context,read_file,read_memory_block,read_pdf,search_conversation,search_memory,web_fetch,web_search",
  );
  await expect("read_file round-trip", 'print(await tools.read_file(path="smoke-input.txt"))', "hello from smoke");
  await expect("bash round-trip", 'print(await tools.bash(command="echo hi-$((6*7))"))', "hi-42");
  await expect(
    "bash non-zero raises KernelToolError in-cell",
    'try:\n    await tools.bash(command="exit 3")\n    print("NO-RAISE")\nexcept Exception as e:\n    print(type(e).__name__)',
    "KernelToolError",
  );
  await expect(
    "pipeline density: bash -> read -> compute, one model round-trip",
    'await tools.bash(command="seq 50 | awk \'$1 % 2 == 0\' > pipe.txt")\n' +
      'txt = await tools.read_file(path="pipe.txt")\n' +
      'nums = [int(v) for l in txt.splitlines() for v in [l.split(" | ")[-1].strip()] if v.isdigit()]\n' +
      'print("sum", sum(nums), "count", len(nums))',
    "sum 650 count 25",
  );
  await expect(
    "oversize bash output lands in the spill store, kernel reads it full-size",
    'import re\n' +
      'r = await tools.bash(command="python3 -c \'print(\\"X\\"*1_300_000)\'")\n' +
      'print("windowed", len(r))\n' +
      'm = re.search(r"saved to: (\\S+)", r)\n' +
      'if not m:\n' +
      '    print("NO-FOOTER-TAIL:", r[-200:])\n' +
      '    raise AssertionError("bash spill footer missing")\n' +
      'd = open(m.group(1)).read()\n' +
      'print("bytes", len(d))',
    "bytes 1300001",
  );
  await expect("list_files routes to the adapter", 'print(await tools.list_files(path="."))', "smoke-input.txt");
  await expect("web_fetch hits the live network", 'print((await tools.web_fetch(url="https://example.com"))[:80])', "Example Domain");
  await expect("search_memory hits the live retrieval stack", 'print(len(await tools.search_memory(query="smoke probe")) > 0)', "True");
  await expect("help(tools) states the data/instruction rule", "print(tools.__doc__)", "not instructions");

  // State + spilled refs across a kernel restart: bind a value, let the
  // debounced snapshot land, L3 the kernel, respawn, verify restore.
  await expect("bind state for the restore check", "z = 900\nprint(z)", "900");
  await new Promise((r) => setTimeout(r, 2200)); // debounce window (1.5 s) + margin
  await disposeKernel(chatId, { force: true });
  await expect(
    "namespace restores after force-kill (z survives)",
    'r = await tools.read_file(path="smoke-input.txt")\nprint(z + 1, "hello" in r)',
    "901 True",
  );

  // Gated capability line must be in the runtime definition when the flag is on.
  const defs = getAgentToolDefinitions("agent");
  const desc = defs.find((d) => d.name === "run_python")?.description ?? "";
  if (desc.includes("await tools.") && desc.includes("help(tools)")) {
    console.log("  PASS  run_python description advertises tools.* (gated)");
    pass++;
  } else {
    console.log("  FAIL  run_python description missing the capability line");
    fail++;
  }

  console.log(`[smoke-kernel-tools] ${pass} passed, ${fail} failed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  await disposeKernel(chatId, { removeState: true }).catch(() => {});
  await rm(join(appDataPath("tool-output"), chatId), { recursive: true, force: true }).catch(() => {});
  if (!scratch) await rm(root, { recursive: true, force: true }).catch(() => {});
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[smoke-kernel-tools] fatal:", e);
  process.exit(1);
});
