import { Router } from "express";
import {
  createBackup,
  deleteBackup,
  listBackups,
  migrate,
  restoreBackup,
} from "../services/embedding-migration.js";

const router = Router();

router.get("/backups", async (_req, res) => {
  try {
    const backups = await listBackups();
    res.json({ backups });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

router.post("/backup", async (req, res) => {
  try {
    const label = typeof req.body?.label === "string" ? req.body.label : undefined;
    const manifest = await createBackup(label);
    res.json({ manifest });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

router.delete("/backup/:id", async (req, res) => {
  try {
    await deleteBackup(req.params.id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || String(e) });
  }
});

router.post("/restore/:id", async (req, res) => {
  try {
    await restoreBackup(req.params.id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

router.post("/migrate", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const result = await migrate((p) => send("progress", p));
    send("complete", result);
  } catch (e: any) {
    send("error", { message: e?.message || String(e) });
  } finally {
    res.end();
  }
});

export default router;
