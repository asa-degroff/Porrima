import { Router } from "express";
// @ts-ignore — busboy lacks types
import Busboy from "busboy";
import {
  createSshConnection,
  deleteSshConnection,
  getChatTitle,
  getSettings,
  getSshConnection,
  listProjects,
  listSshConnections,
  saveSettings,
  updateSshConnection,
} from "../services/chat-storage.js";
import { getDefaultLlamaScanDir, getLlamaPathInfo, updateLlamaPath, validateLlamaPath, getLlamaServicesStatus, listLlamaBinaries } from "../services/llama-path.js";
import { getSlotAssignments } from "../services/llama-slot-leases.js";
import {
  clearAllLlamaCacheResidency,
  clearLlamaCacheResidencyTarget,
  listLlamaCacheResidency,
  NEW_AGENT_CHAT_BASELINE_CACHE_ID,
} from "../services/llama-cache-residency.js";
import { testSshConnection } from "../services/workspace.js";
import {
  saveHeaderImage,
  getHeaderImageInfo,
  deleteHeaderImage,
  getHeaderImagePath,
} from "../services/header-image-storage.js";
import { invalidateModelCache } from "../services/models.js";
import { getStorageMigrationDiagnostics } from "../services/storage-diagnostics.js";
import { access } from "fs/promises";
import { createReadStream } from "fs";
import type { Settings, SshConnection } from "../types.js";
import { sshConnectionFieldError } from "../utils/ssh-target.js";

const router = Router();

/** Provider keys and the Strata bearer token are write-only: responses redact
 *  them and a save that omits or blanks them leaves the stored value intact. */
const SECRET_SETTING_FIELDS = [
  "braveApiKey",
  "exaApiKey",
  "tavilyApiKey",
  "deepseekApiKey",
  "strataApiKey",
] as const;

function redactSettingsSecrets(settings: Settings): {
  settings: Settings;
  configuredSecrets: string[];
} {
  const redacted: Settings = { ...settings };
  const configuredSecrets: string[] = [];
  for (const field of SECRET_SETTING_FIELDS) {
    if (settings[field]) {
      configuredSecrets.push(field);
      (redacted as unknown as Record<string, unknown>)[field] = "";
    }
  }
  return { settings: redacted, configuredSecrets };
}

/** Drop blank secret fields so the merge in saveSettings keeps the stored key.
 *  `strataApiKey` is sent as `undefined` when the input is empty, which would
 *  otherwise overwrite the existing value during the spread merge. */
function preserveStoredSecrets(incoming: unknown): unknown {
  if (!incoming || typeof incoming !== "object") return incoming;
  const next = { ...(incoming as Record<string, unknown>) };
  for (const field of SECRET_SETTING_FIELDS) {
    if (next[field] === "" || next[field] === undefined || next[field] === null) {
      delete next[field];
    }
  }
  return next;
}

const SERVER_OWNED_ACTIVITY_FIELDS = [
  "sleepModeTriggeredAt",
  "systemPauseStartedAt",
  "systemPauseUntil",
  "systemPauseIndefinite",
  "lastUserActivityAt",
  "lastAgentCompletedAt",
  "llamaServiceConfigs",
] as const satisfies readonly (keyof Settings)[];

function stripServerOwnedActivityFields(settings: Settings): Settings {
  const sanitized = { ...settings };
  for (const field of SERVER_OWNED_ACTIVITY_FIELDS) {
    delete sanitized[field];
  }
  return sanitized;
}

function baselineSensitiveSettingsChanged(before: Settings, after: Settings): boolean {
  return (
    before.defaultModelId !== after.defaultModelId ||
    before.llamacppUrl !== after.llamacppUrl ||
    before.inferenceBackend !== after.inferenceBackend ||
    before.strataUrl !== after.strataUrl ||
    before.preserveThinking !== after.preserveThinking ||
    JSON.stringify(before.modelPreserveThinking ?? {}) !== JSON.stringify(after.modelPreserveThinking ?? {})
  );
}

router.get("/", async (_req, res) => {
  const settings = await getSettings();
  const { settings: visible, configuredSecrets } = redactSettingsSecrets(settings);
  let headerImageId: string | undefined;
  try {
    const headerImageInfo = await getHeaderImageInfo();
    if (headerImageInfo.exists) headerImageId = headerImageInfo.version;
  } catch {
    // Header image metadata is best-effort.
  }
  res.setHeader("Cache-Control", "no-store");
  res.json({ ...visible, headerImageId, configuredSecrets });
});

router.get("/storage-diagnostics", async (_req, res) => {
  res.json(getStorageMigrationDiagnostics());
});

router.put("/", async (req, res) => {
  const before = await getSettings();
  const settings = await saveSettings(
    stripServerOwnedActivityFields(preserveStoredSecrets(req.body ?? {}) as Settings)
  );
  if (baselineSensitiveSettingsChanged(before, settings)) {
    clearLlamaCacheResidencyTarget(NEW_AGENT_CHAT_BASELINE_CACHE_ID, "new-agent-chat");
  }
  if (
    before.defaultModelId !== settings.defaultModelId ||
    before.llamacppUrl !== settings.llamacppUrl ||
    before.llamacppEnabled !== settings.llamacppEnabled ||
    before.inferenceBackend !== settings.inferenceBackend ||
    before.strataUrl !== settings.strataUrl
  ) {
    invalidateModelCache();
  }
  // A backend flip changes what "warm" means entirely: the residency ledger
  // keys on baseUrl and the previous server's state has no bearing on the new
  // one. Clear it so indicators and cold-gates start honest
  // (docs/design/strata-backend.md §8).
  if (before.inferenceBackend !== settings.inferenceBackend) {
    clearAllLlamaCacheResidency();
    // Slot files are never portable across backends (opaque server format,
    // pool-key mismatch on every restore). Wipe the registry and the tracked
    // files so the disk headroom returns to the new backend's parking
    // (docs/design/strata-backend.md §7).
    void import("../services/kv-snapshot.js")
      .then((m) => m.clearAllKvSnapshots("inference backend switched"))
      .catch(() => {});
  }
  const { settings: visible, configuredSecrets } = redactSettingsSecrets(settings);
  res.setHeader("Cache-Control", "no-store");
  res.json({ ...visible, configuredSecrets });
});

router.get("/ssh-connections", async (_req, res) => {
  const connections = await listSshConnections();
  res.json(connections);
});

router.post("/ssh-connections", async (req, res) => {
  const { name, host, port, username, identityFile, knownHostsMode, enabled, allowBash, allowFileWrite, allowAbsolutePaths } = req.body || {};
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }
  if (!host || typeof host !== "string") {
    return res.status(400).json({ error: "host is required" });
  }
  const hostValue = host.trim();
  const usernameValue = typeof username === "string" && username.trim() ? username.trim() : undefined;
  // Host and username become argv entries to `ssh`; option-shaped values would
  // run a local command (see utils/ssh-target.ts).
  const fieldError = sshConnectionFieldError(hostValue, usernameValue);
  if (fieldError) {
    return res.status(400).json({ error: fieldError });
  }
  const now = new Date().toISOString();
  const connection: SshConnection = {
    id: crypto.randomUUID(),
    name: name.trim(),
    host: hostValue,
    port: Number(port) || 22,
    username: usernameValue,
    identityFile: typeof identityFile === "string" && identityFile.trim() ? identityFile.trim() : undefined,
    knownHostsMode: knownHostsMode === "strict" || knownHostsMode === "off" ? knownHostsMode : "accept-new",
    enabled: enabled !== false,
    allowBash: allowBash !== false,
    allowFileWrite: allowFileWrite !== false,
    allowAbsolutePaths: allowAbsolutePaths === true,
    createdAt: now,
    lastModified: now,
  };
  await createSshConnection(connection);
  res.status(201).json(connection);
});

router.patch("/ssh-connections/:id", async (req, res) => {
  const existing = await getSshConnection(req.params.id);
  if (!existing) return res.status(404).json({ error: "SSH connection not found" });

  if (req.body.host !== undefined || req.body.username !== undefined) {
    const host = req.body.host !== undefined ? String(req.body.host).trim() : existing.host;
    const username = req.body.username !== undefined
      ? String(req.body.username || "").trim() || undefined
      : existing.username;
    const fieldError = sshConnectionFieldError(host, username);
    if (fieldError) {
      return res.status(400).json({ error: fieldError });
    }
  }

  const updates: Partial<SshConnection> = {};
  if (req.body.name !== undefined) updates.name = String(req.body.name).trim();
  if (req.body.host !== undefined) updates.host = String(req.body.host).trim();
  if (req.body.port !== undefined) updates.port = Number(req.body.port) || 22;
  if (req.body.username !== undefined) updates.username = String(req.body.username || "").trim() || undefined;
  if (req.body.identityFile !== undefined) updates.identityFile = String(req.body.identityFile || "").trim() || undefined;
  if (req.body.knownHostsMode !== undefined) {
    updates.knownHostsMode = req.body.knownHostsMode === "strict" || req.body.knownHostsMode === "off" ? req.body.knownHostsMode : "accept-new";
  }
  if (req.body.enabled !== undefined) updates.enabled = req.body.enabled === true;
  if (req.body.allowBash !== undefined) updates.allowBash = req.body.allowBash === true;
  if (req.body.allowFileWrite !== undefined) updates.allowFileWrite = req.body.allowFileWrite === true;
  if (req.body.allowAbsolutePaths !== undefined) updates.allowAbsolutePaths = req.body.allowAbsolutePaths === true;

  if (updates.name === "" || updates.host === "") {
    return res.status(400).json({ error: "name and host cannot be empty" });
  }

  await updateSshConnection(req.params.id, updates);
  const updated = await getSshConnection(req.params.id);
  res.json(updated);
});

router.delete("/ssh-connections/:id", async (req, res) => {
  const projects = (await listProjects()).filter((project) => project.sshConnectionId === req.params.id);
  if (projects.length > 0) {
    const projectNames = projects.map((project) => `"${project.name}"`).join(", ");
    return res.status(409).json({
      error: `This host is used by ${projects.length === 1 ? "project" : "projects"} ${projectNames}. Reassign or delete ${projects.length === 1 ? "the project" : "those projects"} before removing the host.`,
      projects: projects.map(({ id, name }) => ({ id, name })),
    });
  }
  const deleted = await deleteSshConnection(req.params.id);
  if (!deleted) return res.status(404).json({ error: "SSH connection not found" });
  res.status(204).end();
});

router.post("/ssh-connections/:id/test", async (req, res) => {
  const connection = await getSshConnection(req.params.id);
  if (!connection) return res.status(404).json({ error: "SSH connection not found" });
  const result = await testSshConnection(connection);
  res.status(result.ok ? 200 : 400).json(result);
});

// GET /api/settings/llama-path — Current symlink info and service status
router.get("/llama-path", async (_req, res) => {
  try {
    const [pathInfo, serviceStatus] = await Promise.all([
      getLlamaPathInfo(),
      getLlamaServicesStatus(),
    ]);
    res.json({ ...pathInfo, services: serviceStatus });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/settings/llama-path — Update symlink and restart services
router.put("/llama-path", async (req, res) => {
  const { path: newPath } = req.body;
  if (!newPath || typeof newPath !== "string") {
    res.status(400).json({ error: "path is required" });
    return;
  }

  try {
    const result = await updateLlamaPath(newPath.trim());
    invalidateModelCache();
    if (result.rolledBack) {
      res.status(503).json({ ...result, error: "Services failed to start with new path. Rolled back to previous version." });
    } else {
      res.json(result);
    }
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/settings/llama-path/validate — Validate a candidate path without applying
router.post("/llama-path/validate", async (req, res) => {
  const { path: candidatePath } = req.body;
  if (!candidatePath || typeof candidatePath !== "string") {
    res.status(400).json({ error: "path is required" });
    return;
  }

  try {
    const result = await validateLlamaPath(candidatePath.trim());
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/settings/llama-binaries — List discovered llama-server binaries.
// POST (not GET) because the scan executes each candidate binary with
// `--version`: a same-site GET navigation would carry the session cookie and
// turn this into CSRF. JSON-only bodies are also unreachable from HTML forms.
router.post("/llama-binaries", async (req, res) => {
  try {
    const queryDir = typeof req.body?.dir === "string" ? req.body.dir : "";
    const settings = await getSettings();
    const scanDir = queryDir.trim() || settings.llamaBinaryScanDir || getDefaultLlamaScanDir();
    const binaries = await listLlamaBinaries(scanDir);
    res.json(binaries);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/settings/slot-assignments - Legacy enforced-slot lease view.
router.get("/slot-assignments", async (_req, res) => {
  const assignments = await getSlotAssignments();
  res.json(assignments);
});

// GET /api/settings/cache-residency - Observed llama.cpp prompt-cache residency.
// Enriched with queue position for visual distinction between queued and
// actively warming, and with the chat's current title so UIs can render a
// human-friendly label instead of a raw chat ID. Titles are resolved at read
// time (not stored on the record) so renames and LLM title generation are
// always reflected.
router.get("/cache-residency", async (_req, res) => {
  try {
    const { getQueuePosition } = await import("../services/cache-warm-queue.js");
    const { getLatestDoneUsageByChat } = await import("../services/request-log.js");
    const records = listLlamaCacheResidency();
    const wireChatIds = records
      .filter((r) => r.targetKind !== "new-agent-chat")
      .map((r) => r.chatId);
    const wireUsage = getLatestDoneUsageByChat(wireChatIds);
    const enriched = records.map((r) => ({
      ...r,
      queuePosition: getQueuePosition(r.chatId, r.targetKind),
      chatTitle: r.targetKind === "chat" ? getChatTitle(r.chatId) ?? undefined : undefined,
      wirePromptTokens: wireUsage.get(r.chatId)?.promptTokens ?? null,
      wireCachedTokens: wireUsage.get(r.chatId)?.cachedTokens ?? null,
      wireAt: wireUsage.get(r.chatId)?.timestamp,
    }));
    res.json(enriched);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/settings/kv-snapshots - Disk-tier KV snapshot parking status
// (docs/design/kv-snapshot-parking.md §10 Phase 4). Registry rows come back
// with chat titles resolved at read time, mirroring /cache-residency.
router.get("/kv-snapshots", async (_req, res) => {
  try {
    const { getKvSnapshotSummary } = await import("../services/kv-snapshot.js");
    const summary = await getKvSnapshotSummary();
    const snapshots = summary.snapshots.map((s) => ({
      ...s,
      chatTitle: getChatTitle(s.chatId) ?? undefined,
    }));
    res.json({ ...summary, snapshots });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// --- Header Image ---

// POST /api/settings/header-image — Upload/replace the header image (multipart/form-data)
router.post("/header-image", (req, res) => {
  const bb = Busboy({
    headers: req.headers,
    // Header art is a small icon; cap the upload before it reaches sharp.
    limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  });
  let fileReceived = false;
  let responded = false;
  let tooLarge = false;
  bb.on("file", (_fieldname: string, file: NodeJS.ReadableStream, fileInfo: { filename: string; mimeType: string }) => {
    if (fileReceived) {
      file.resume();
      return;
    }
    fileReceived = true;
    const chunks: Buffer[] = [];
    file.on("limit", () => {
      tooLarge = true;
      if (!responded) {
        responded = true;
        res.status(413).json({ error: "Header image exceeds 20 MB" });
      }
    });
    file.on("data", (chunk: Buffer) => chunks.push(chunk));
    file.on("end", async () => {
      if (tooLarge) return;
      const buffer = Buffer.concat(chunks);
      try {
        console.log(`[header-image] saving ${buffer.length} bytes, mime=${fileInfo.mimeType}`);
        const savedInfo = await saveHeaderImage(buffer, fileInfo.mimeType);
        console.log(`[header-image] saved OK: ${savedInfo.url}`);
        if (!responded) { responded = true; res.json(savedInfo); }
      } catch (e: any) {
        console.error(`[header-image] save failed:`, e.message);
        if (!responded) {
          responded = true;
          const status = /^Unsupported image format/.test(e?.message || "") ? 400 : 500;
          res.status(status).json({ error: e.message });
        }
      }
    });
  });
  bb.on("error", (err: Error) => {
    console.error(`[header-image] busboy error:`, err);
    if (!responded) { responded = true; res.status(500).json({ error: "Failed to parse upload" }); }
  });
  bb.on("finish", () => {
    // Only send 400 if no file event was ever emitted.
    // The file handler is async so it may still be processing when
    // finish fires — we must not preempt it with an error response.
    if (!fileReceived && !responded) {
      responded = true;
      res.status(400).json({ error: "No image file received" });
    }
  });
  // @ts-ignore — busboy is a writable stream
  req.pipe(bb);
});

// GET /api/settings/header-image — Check existence and get info
router.get("/header-image", async (_req, res) => {
  try {
    const info = await getHeaderImageInfo();
    res.json(info);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/settings/header-image — Remove the header image
router.delete("/header-image", async (_req, res) => {
  try {
    await deleteHeaderImage();
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/settings/header-image/thumb — Serve the thumbnail
router.get("/header-image/thumb", async (_req, res) => {
  const thumbPath = getHeaderImagePath("thumb.webp");
  try {
    await access(thumbPath);
    res.setHeader("Content-Type", "image/webp");
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.setHeader("Vary", "Accept-Encoding");
    createReadStream(thumbPath).pipe(res);
  } catch {
    res.status(404).json({ error: "Header image not found" });
  }
});

// GET /api/settings/header-image/image.:ext — Serve the original
router.get("/header-image/image.:ext", async (req, res) => {
  const ext = req.params.ext;
  const validExts = ["jpg", "jpeg", "png", "webp", "gif"];
  if (!validExts.includes(ext)) {
    return res.status(400).json({ error: "Invalid extension" });
  }
  const imagePath = getHeaderImagePath(`image.${ext}`);
  try {
    await access(imagePath);
    const contentType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.setHeader("Vary", "Accept-Encoding");
    createReadStream(imagePath).pipe(res);
  } catch {
    res.status(404).json({ error: "Header image not found" });
  }
});

export default router;
