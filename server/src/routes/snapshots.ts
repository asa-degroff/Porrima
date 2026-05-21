import { Router } from "express";
import {
  createAgentSnapshot,
  deleteAgentSnapshot,
  listAgentSnapshots,
  restoreAgentSnapshot,
} from "../services/agent-snapshots.js";

const router = Router();

router.get("/", async (_req, res) => {
  try {
    const snapshots = await listAgentSnapshots();
    res.json({ snapshots });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

router.post("/", async (req, res) => {
  try {
    const label = typeof req.body?.label === "string" ? req.body.label.trim() : "";
    const includeCorpus = req.body?.includeCorpus === true;
    const manifest = await createAgentSnapshot({
      label: label || undefined,
      includeCorpus,
    });
    res.json({ manifest });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    await deleteAgentSnapshot(req.params.id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || String(e) });
  }
});

router.post("/:id/restore", async (req, res) => {
  try {
    const result = await restoreAgentSnapshot(req.params.id);
    res.json({ ok: true, ...result });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

export default router;
