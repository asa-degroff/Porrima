import { Router } from "express";
import {
  createSshConnection,
  deleteSshConnection,
  getSettings,
  getSshConnection,
  listSshConnections,
  saveSettings,
  updateSshConnection,
} from "../services/chat-storage.js";
import { getLlamaPathInfo, updateLlamaPath, validateLlamaPath, getLlamaServicesStatus, listLlamaBinaries } from "../services/llama-path.js";
import { getSlotAssignments } from "../services/llama-slot-leases.js";
import { listLlamaCacheResidency } from "../services/llama-cache-residency.js";
import { testSshConnection } from "../services/workspace.js";
import type { SshConnection } from "../types.js";

const router = Router();

router.get("/", async (_req, res) => {
  const settings = await getSettings();
  res.json(settings);
});

router.put("/", async (req, res) => {
  const settings = await saveSettings(req.body);
  res.json(settings);
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
  const now = new Date().toISOString();
  const connection: SshConnection = {
    id: crypto.randomUUID(),
    name: name.trim(),
    host: host.trim(),
    port: Number(port) || 22,
    username: typeof username === "string" && username.trim() ? username.trim() : undefined,
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

// GET /api/settings/llama-binaries — List discovered llama-server binaries
router.get("/llama-binaries", async (_req, res) => {
  try {
    const binaries = await listLlamaBinaries();
    res.json(binaries);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/settings/slot-assignments - Legacy enforced-slot lease view.
router.get("/slot-assignments", async (_req, res) => {
  const assignments = await getSlotAssignments();
  res.json(assignments);
});

// GET /api/settings/cache-residency - Observed llama.cpp prompt-cache residency.
// Enriched with queue position for visual distinction between queued and actively warming.
router.get("/cache-residency", async (_req, res) => {
  try {
    const { getQueuePosition } = await import("../services/cache-warm-queue.js");
    const records = listLlamaCacheResidency();
    const enriched = records.map((r) => ({
      ...r,
      queuePosition: getQueuePosition(r.chatId),
    }));
    res.json(enriched);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
