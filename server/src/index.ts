import express from "express";
import cors from "cors";
import session from "express-session";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { Request, Response, NextFunction } from "express";
import { responseCompression } from "./middleware/compression.js";
import modelsRouter from "./routes/models.js";
import chatsRouter from "./routes/chats.js";
import chatRouter from "./routes/chat.js";
import settingsRouter from "./routes/settings.js";
import appRouter from "./routes/app.js";
import memoryRouter from "./routes/memory.js";
import artifactsRouter from "./routes/artifacts.js";
import visualsRouter from "./routes/visuals.js";
import authRouter, { assertProductionWebAuthnConfig } from "./routes/auth.js";
import personaRouter from "./routes/persona.js";
import extractionPromptRouter from "./routes/extraction-prompt.js";
import userRouter from "./routes/user.js";
import ttsRouter from "./routes/tts.js";
import skillsRouter from "./routes/skills.js";
import userImagesRouter from "./routes/user-images.js";
import toolResultImagesRouter from "./routes/tool-result-images.js";
import localImagesRouter from "./routes/local-images.js";
import projectsRouter from "./routes/projects.js";
import notebooksRouter from "./routes/notebooks.js";
import uiStateRouter from "./routes/ui-state.js";
import embeddingMigrationRouter from "./routes/embedding-migration.js";
import snapshotsRouter from "./routes/snapshots.js";
import modelStatsRouter from "./routes/model-stats.js";
import requestLogRouter from "./routes/request-log.js";
import rerankerStatsRouter from "./routes/reranker-stats.js";
import llamaServersRouter from "./routes/llama-servers.js";
import pushRouter from "./routes/push.js";
import automationsRouter from "./routes/automations.js";
import systemStatsRouter from "./routes/system-stats.js";
import systemRouter from "./routes/system.js";
import { assertNoProductionDevTokenBypass, requireAuth } from "./middleware/auth.js";
import { ensureSetupTokenForFirstRun, getSessionSecret } from "./services/auth-storage.js";
import { getSessionCookieConfig } from "./services/session-cookie-config.js";
import { startScheduler } from "./services/scheduler.js";
import { startSystemStatsPolling } from "./services/system-stats.js";
import { initializePersona } from "./services/persona-store.js";
import { initializeExtractionPrompt } from "./services/extraction-prompt-store.js";
import { createSystemChat } from "./services/system-chat.js";
import { ensureAutomationDefaults, sweepOrphanedAutomationRuns } from "./services/automation-storage.js";
import { migrateAgentNotebookToBlocks, migrateUserNotebookToDb } from "./services/notebook-storage.js";
import { initSshMux, destroyAllMasters } from "./services/workspace.js";
import { logStorageMigrationDiagnostics } from "./services/storage-diagnostics.js";

// Prevent unhandled promise rejections from crashing the process.
// pi-agent-core's agentLoop() runs an unawaited async IIFE — if the loop throws
// (e.g. stream error with malformed message), it becomes an unhandled rejection.
process.on("unhandledRejection", (reason, promise) => {
  console.error("[process] unhandled rejection (caught, not crashing):", reason);
});

// Graceful shutdown: tear down SSH master connections and close the HTTP
// server before exiting.  If the process doesn't exit within 10s, force it
// so systemd doesn't have to wait 90s for the stop-sigterm timeout.
let httpServer: ReturnType<typeof app.listen> | null = null;
const gracefulShutdown = async () => {
  console.log("[shutdown] Received signal, shutting down gracefully...");
  // Close the HTTP server first so new requests are rejected immediately.
  if (httpServer) {
    httpServer.close();
  }
  // Dispose Python kernels BEFORE the SSH masters go away: a remote kernel's
  // graceful teardown is a protocol shutdown request over the ssh channel
  // (EOF flush + child reaping on the host), and the supervisor kill below is
  // only the backstop (docs/design/remote-python-kernel.md §4.5).
  try {
    const { disposeAllKernels } = await import("./services/python-kernel.js");
    await disposeAllKernels();
    console.log("[shutdown] Python kernels disposed");
  } catch {
    // Non-fatal
  }
  await destroyAllMasters();
  // Shut down TTS workers
  try {
    const { destroyAllWorkers } = await import("./services/tts-worker-pool.js");
    destroyAllWorkers();
    console.log("[shutdown] TTS workers destroyed");
  } catch {
    // Non-fatal
  }
  try {
    const { closeAllBrowserSessions } = await import("./services/browser-session.js");
    await closeAllBrowserSessions();
    console.log("[shutdown] Browser sessions closed");
  } catch {
    // Non-fatal
  }
  // Stop supervised child process groups (bash, python kernels). Each kill is
  // individually bounded, so a wedged child cannot hold the shutdown.
  try {
    const { killAllSupervised } = await import("./services/process-supervisor.js");
    await killAllSupervised();
    console.log("[shutdown] Supervised processes stopped");
  } catch {
    // Non-fatal
  }
  process.exit(0);
};
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
// Safety net: force exit after 10s if graceful shutdown hangs.
const forceExitTimer = (signal: string) =>
  setTimeout(() => {
    console.error(`[shutdown] Graceful shutdown timed out after 10s (${signal}), forcing exit`);
    process.exit(1);
  }, 10_000);
process.once("SIGTERM", () => forceExitTimer("SIGTERM"));
process.once("SIGINT", () => forceExitTimer("SIGINT"));

const isProd = process.env.NODE_ENV === "production";
assertNoProductionDevTokenBypass();
assertProductionWebAuthnConfig();
const PORT = parseInt(process.env.PORT || "3001");
const backgroundJobsSetting = process.env.ENABLE_BACKGROUND_JOBS?.toLowerCase();
const backgroundJobsEnabled = backgroundJobsSetting === "true"
  ? true
  : backgroundJobsSetting === "false"
    ? false
    : PORT === 3001;
const sessionSecret = await getSessionSecret();
await ensureSetupTokenForFirstRun();

// Initialize persona system on startup
await initializePersona();
await initializeExtractionPrompt();

// Create system chat for synthesis/reflection
await createSystemChat();
await ensureAutomationDefaults();
// Mark runs orphaned by a killed process as interrupted (and archive any
// still-armed once-task they belong to) before the scheduler starts.
sweepOrphanedAutomationRuns();

// One-shot migration: move agent notebook JSON files into memory_blocks.
// Idempotent — does nothing once the JSON files are in the .backup/ folder.
await migrateAgentNotebookToBlocks().catch((err) => {
  console.error("[notebook] Agent notebook migration failed:", err);
});

// One-shot migration: move user notebook JSON files into SQLite.
// Idempotent — does nothing once the JSON files are in the .backup/ folder.
await migrateUserNotebookToDb().catch((err) => {
  console.error("[notebook] User notebook migration failed:", err);
});

logStorageMigrationDiagnostics();

// Initialize SSH infrastructure: create mux directory, clean stale sockets.
await initSshMux();

const app = express();

// Trust proxy (Cloudflare Tunnel terminates TLS upstream)
if (isProd) {
  app.set("trust proxy", 1);
}

// Session middleware
app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: getSessionCookieConfig(),
  })
);

// CORS
if (isProd) {
  app.use(cors({ origin: false }));
} else {
  app.use(cors({ origin: true, credentials: true }));
}

app.use(express.json({ limit: "50mb" }));

// Compress API responses. Must be mounted before every router so it wraps
// their res.write/res.end, and must keep its content-type filter so the
// SSE routes stay unbuffered (see middleware/compression.ts).
app.use(responseCompression());

// Auth routes (unprotected)
app.use("/api/auth", authRouter);

// Auth middleware (protects all other /api/* routes)
app.use("/api", requireAuth);

// Protected API routes
app.use("/api/models", modelsRouter);
app.use("/api/chats", chatsRouter);
app.use("/api/chat", chatRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/app", appRouter);
app.use("/api/memory", memoryRouter);
app.use("/api/persona", personaRouter);
app.use("/api/extraction-prompt", extractionPromptRouter);
app.use("/api/user", userRouter);
app.use("/api/artifacts", artifactsRouter);
app.use("/api/visuals", visualsRouter);
app.use("/api/tts", ttsRouter);
app.use("/api/skills", skillsRouter);
app.use("/api/user-images", userImagesRouter);
app.use("/api/tool-result-images", toolResultImagesRouter);
app.use("/api/local-images", localImagesRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/notebooks", notebooksRouter);
app.use("/api/ui-state", uiStateRouter);
app.use("/api/embedding", embeddingMigrationRouter);
app.use("/api/snapshots", snapshotsRouter);
app.use("/api/model-stats", modelStatsRouter);
app.use("/api/llm-requests", requestLogRouter);
app.use("/api/reranker-stats", rerankerStatsRouter);
app.use("/api/llama-servers", llamaServersRouter);
app.use("/api/push", pushRouter);
app.use("/api/automations", automationsRouter);
app.use("/api/system-stats", systemStatsRouter);
app.use("/api/system", systemRouter);

// Production static serving
if (isProd) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const clientDist = join(__dirname, "../../client/dist");
  app.use(express.static(clientDist));
  // SPA fallback for non-API routes
  app.get("*path", (_req, res) => {
    res.sendFile(join(clientDist, "index.html"));
  });
}

// Clear stale cache residency records on startup — if the system rebooted,
// llama.cpp's KV cache is gone and any in-memory residency state is invalid.
try {
  const { clearAllLlamaCacheResidency } = await import("./services/llama-cache-residency.js");
  clearAllLlamaCacheResidency();
} catch {
  // Non-fatal — residency tracking will work fine without startup cleanup
}

// Reap process groups journaled by a previous server run (SIGKILL or crash),
// before anything can spawn new supervised processes. An in-memory registry
// cannot survive the crash this journal exists for.
try {
  const { sweepSupervisorJournal } = await import("./services/process-supervisor.js");
  const reaped = await sweepSupervisorJournal();
  if (reaped > 0) {
    console.log(`[supervisor] reaped ${reaped} orphaned process group(s) from a previous run`);
  }
} catch (error) {
  // Non-fatal — the sweep retries on the next start.
  console.warn("[supervisor] startup sweep failed:", error);
}

// Reap child groups journaled by a previous kernel run, then start the idle
// reaper. Kernel processes themselves are covered by the supervisor sweep.
try {
  const { sweepKernelJournals, startKernelReaper } = await import("./services/python-kernel.js");
  const reaped = await sweepKernelJournals();
  if (reaped > 0) {
    console.log(`[kernel] reaped ${reaped} orphaned child group(s) from a previous run`);
  }
  startKernelReaper();
} catch (error) {
  // Non-fatal — kernels fall back to one-shot.
  console.warn("[kernel] startup sweep failed:", error);
}

// TTS worker is lazily initialized on first TTS request via getWorker().
// This avoids blocking startup with model loading when TTS isn't in use.

// Global error handler - must be after all routes
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

httpServer = app.listen(PORT, () => {
  console.log(`Porrima server running on http://localhost:${PORT}`);
  if (backgroundJobsEnabled) {
    startScheduler();
    startSystemStatsPolling();
  } else {
    console.log(
      `[scheduler] Background jobs disabled on port ${PORT} ` +
      `(set ENABLE_BACKGROUND_JOBS=true to override)`,
    );
  }
});
