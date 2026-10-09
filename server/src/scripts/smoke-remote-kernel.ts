// Live SSH-host smoke test for the remote Python kernel (P4a).
// Implements the "live-host manual checklist" from
// docs/design/remote-python-kernel.md §5.1 against a REAL connection:
//
//   npx tsx src/scripts/smoke-remote-kernel.ts --connection <id|host> [--root <remoteRoot>]
//
// Exercises: createKernelHost gating, master + $HOME, driver staging with the
// hash marker, supervised ssh spawn, the ready handshake (protocol + driver
// hash), host-side state dir placement, a foreground cell, streaming updates,
// L1 interrupt with namespace survival, snapshot persistence, HARD DROP
// (force-dispose kills only the local ssh client — the remote kernel must
// tear itself down via the getppid watchdog / EOF path), respawn + restore,
// and removeState teardown. The staged driver is left on the host (app-owned
// cache reused by production); everything else is cleaned up.
//
// Destructive only to its own smoke chat state. Read the checks, not just the
// exit code: a watchdog teardown slower than the poll window is a finding.

async function main(): Promise<void> {
  // The host must exist and be reachable before we flip anything on.
  const argIndex = process.argv.indexOf("--connection");
  if (argIndex === -1 || !process.argv[argIndex + 1]) {
    console.error("usage: npx tsx src/scripts/smoke-remote-kernel.ts --connection <sshConnectionId|host> [--root <remoteRoot>]");
    process.exit(2);
  }
  const target = process.argv[argIndex + 1];
  const rootIndex = process.argv.indexOf("--root");
  const remoteRoot = rootIndex !== -1 ? process.argv[rootIndex + 1] : undefined;

  const { Database } = await import("better-sqlite3").then((m) => ({ Database: m.default ?? m }));
  const os = await import("os");
  const path = await import("path");
  const db = new (Database as any)(path.join(os.homedir(), ".porrima", "app.db"), { readonly: true });
  const rows = db.prepare("SELECT * FROM ssh_connections").all();
  const row = rows.find((r: any) => r.id === target || r.host === target);
  if (!row) {
    console.error(`no ssh_connections row matching "${target}"`);
    process.exit(2);
  }
  db.close();

  const connection = {
    ...row,
    enabled: !!row.enabled,
    allowBash: !!row.allowBash,
    allowFileWrite: !!row.allowFileWrite,
    allowAbsolutePaths: !!row.allowAbsolutePaths,
  };
  if (!connection.enabled || !connection.allowBash) {
    console.error(`connection ${row.name} is disabled or allowBash=off; the remote kernel requires both`);
    process.exit(2);
  }

  process.env.PORRIMA_REMOTE_KERNEL = "1";
  const { SshWorkspaceAdapter } = await import("../services/workspace.js");
  const {
    executeInKernel,
    disposeKernel,
    localDriverInfo,
  } = await import("../services/python-kernel.js");

  const chatId = `smoke-${Date.now().toString(36)}`;
  const adapter = new SshWorkspaceAdapter(connection, remoteRoot ?? `/home/${connection.username}`);
  const results: string[] = [];
  const check = (name: string, ok: boolean, detail = "") => {
    results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
    console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `: ${detail}` : ""}`);
    if (!ok) process.exitCode = 1;
  };
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  console.log(`\n=== remote kernel smoke: ${connection.name} (${connection.username}@${connection.host}) root=${adapter.label} chat=${chatId} ===\n`);

  // 1. Host handle exists under the flag.
  const host = await adapter.createKernelHost();
  check("createKernelHost returns a transport host", !!host, host?.kind ?? "null");
  if (!host) {
    console.log(results.join("\n"));
    process.exit(1);
  }

  // 2. Foreground cell end-to-end (staging + master + $HOME + spawn + handshake).
  const t0 = Date.now();
  const first = await executeInKernel({ chatId, cwd: adapter.label, code: `print(6*7)`, timeoutMs: 30_000, host: host! });
  check("first cell runs through the remote kernel", first.mode === "kernel" && !first.isError && first.content.includes("42"),
    `mode=${first.mode} ${t0 ? Date.now() - t0 : 0}ms`);
  if (first.mode !== "kernel") {
    console.log(results.join("\n"));
    process.exit(1);
  }

  // 3. Namespace cell + cwd sanity + streaming seam.
  let partials = 0;
  const ns = await executeInKernel({
    chatId,
    cwd: adapter.label,
    code: [
      `import os`,
      `smoke_answer = 40 + 2`,
      `print("cwd=", os.getcwd())`,
      `print("stage-marker ok")`,
    ].join("\n"),
    timeoutMs: 30_000,
    host: host!,
    onUpdate: () => { partials += 1; },
  });
  check("namespace cell ok", ns.mode === "kernel" && !ns.isError && ns.content.includes("cwd="), ns.mode === "kernel" ? "" : JSON.stringify(ns));
  const cwdLine = ns.mode === "kernel" ? (ns.content.split("\n").find((l) => l.startsWith("cwd=")) ?? "") : "";
  check("cell cwd is the remote workspace root", cwdLine.replace("cwd= ", "").startsWith("/"), cwdLine);
  check("streaming seam delivered updates", partials >= 1, `${partials} onUpdate frames`);

  // 4. Host-side state placement: staged driver + marker hash + kernel.pid +
  //    children.jsonl under the HOST state dir; nothing for this chat in the
  //    local kernel root.
  const staged = await adapter.exec(`printf '%s %s' "$(cat -- "$HOME/.porrima/kernel/porrima_kernel.py.sha256" 2>/dev/null)" "$(test -f "$HOME/.porrima/kernels/${chatId}/kernel.pid" && cat -- "$HOME/.porrima/kernels/${chatId}/kernel.pid")"`);
  const driver = localDriverInfo();
  const [marker, remotePidStr] = (staged.content ?? "").trim().split(/\s+/);
  check("staged driver marker matches local build", marker === driver?.hash, `host=${marker} local=${driver?.hash}`);
  const remotePid = Number(remotePidStr);
  check("kernel.pid written to host state dir", Number.isFinite(remotePid) && remotePid > 0, `pid=${remotePidStr}`);
  const fs = await import("fs");
  check("no local kernel state dir for the smoke chat", !fs.existsSync(path.join(os.homedir(), ".porrima", "kernels", chatId)));

  // 5. L1 interrupt via abort: the sleep cell must die, the namespace must not.
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 3000);
  const interrupted = await executeInKernel({ chatId, cwd: adapter.label, code: `import time; time.sleep(60)`, timeoutMs: 20_000, host: host!, signal: controller.signal });
  check("interrupted cell returns an error", interrupted.mode === "kernel" && interrupted.isError, JSON.stringify(interrupted).slice(0, 160));
  const afterInterrupt = await executeInKernel({ chatId, cwd: adapter.label, code: `print(smoke_answer)`, timeoutMs: 30_000, host: host! });
  check("namespace survived the interrupt", afterInterrupt.mode === "kernel" && afterInterrupt.content.includes("42"));

  // 6. Snapshot reached the host (debounce had settled after cells ran).
  await delay(2500);
  const manifest = await adapter.exec(`cat -- "$HOME/.porrima/kernels/${chatId}/manifest.json" 2>/dev/null || true`);
  let savedNames: string[] = [];
  try { savedNames = JSON.parse(manifest.content).savedNames ?? []; } catch {}
  check("debounced snapshot landed on the host", savedNames.includes("smoke_answer"), `savedNames=${JSON.stringify(savedNames)}`);

  // 7. HARD DROP: force-dispose kills only the LOCAL ssh client. The remote
  //    driver must tear itself down (EOF flush, or the getppid watchdog for a
  //    wedged loop). Poll the host for the pid's death.
  await disposeKernel(chatId, { force: true });
  let goneAfterMs: number | null = null;
  for (let waited = 0; waited <= 30_000; waited += 1000) {
    const alive = await adapter.exec(`ps -p ${remotePid} > /dev/null 2>&1 && echo alive || echo gone`);
    if (alive.content.trim() === "gone") {
      goneAfterMs = waited;
      break;
    }
    await delay(1000);
  }
  check("remote kernel died after the channel drop", goneAfterMs !== null, goneAfterMs === null ? "still alive after 30 s" : `reaped in ~${goneAfterMs} ms`);

  // 8. Respawn + restore from the host snapshot (fresh generation, same dir).
  const respawned = await executeInKernel({ chatId, cwd: adapter.label, code: `print(smoke_answer)`, timeoutMs: 30_000, host: host! });
  check("respawn restores the namespace", respawned.mode === "kernel" && respawned.content.includes("42"), respawned.mode === "kernel" ? respawned.content.split("\n")[0] : JSON.stringify(respawned));
  check("restore notice present", respawned.mode === "kernel" && respawned.content.includes("restored"));

  // 9. removeState teardown.
  await disposeKernel(chatId, { removeState: true });
  const gone = await adapter.exec(`test -d "$HOME/.porrima/kernels/${chatId}" && echo present || echo removed`);
  check("removeState deleted the host state dir", gone.content.trim() === "removed");

  console.log(`\n=== summary ===\n${results.join("\n")}`);
  process.exit(process.exitCode ?? 0);
}

main().catch((error) => {
  console.error("smoke test crashed:", error);
  process.exit(1);
});
