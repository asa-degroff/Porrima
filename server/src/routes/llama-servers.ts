import { Router } from "express";
import { getSettings } from "../services/chat-storage.js";
import {
  getLlamaServerLogs,
  getLlamaServerStatus,
  getLlamaServerStatuses,
  runLlamaServerAction,
  type LlamaServerAction,
} from "../services/llama-supervisor.js";

const router = Router();

router.get("/", async (_req, res) => {
  try {
    const settings = await getSettings();
    const servers = await getLlamaServerStatuses(settings);
    res.json({ servers });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Failed to load llama.cpp server status" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const settings = await getSettings();
    const server = await getLlamaServerStatus(req.params.id, settings);
    res.json({ server });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "Failed to load llama.cpp server status" });
  }
});

router.get("/:id/logs", async (req, res) => {
  const rawLines = typeof req.query.lines === "string" ? Number.parseInt(req.query.lines, 10) : 200;
  try {
    const result = await getLlamaServerLogs(req.params.id, Number.isFinite(rawLines) ? rawLines : 200);
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "Failed to load llama.cpp server logs" });
  }
});

router.post("/:id/:action", async (req, res) => {
  const action = req.params.action as LlamaServerAction;
  if (action !== "start" && action !== "stop" && action !== "restart") {
    res.status(400).json({ error: "action must be start, stop, or restart" });
    return;
  }

  try {
    const settings = await getSettings();
    const server = await runLlamaServerAction(req.params.id, action, settings);
    res.json({ server });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || `Failed to ${action} llama.cpp server` });
  }
});

export default router;
