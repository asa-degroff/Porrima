import { Router } from "express";
import type { Request, Response } from "express";
import {
  listLlmRequests,
  getLlmRequestDetail,
  clearLlmRequests,
} from "../services/request-log.js";

const router = Router();

/**
 * GET /api/llm-requests?chatId=&limit=
 * Per-chat LLM request log (summaries only, newest first). Scoping is
 * enforced: chatId is required — the request viewer is per-chat by design
 * (docs/design/request-viewer.md).
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const chatId = typeof req.query.chatId === "string" ? req.query.chatId : "";
    if (!chatId) {
      return res.status(400).json({ error: "chatId query parameter is required" });
    }
    const limitParam = Number(req.query.limit);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.floor(limitParam) : undefined;
    res.json({ requests: listLlmRequests(chatId, limit) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * GET /api/llm-requests/:id
 * Full rehydrated request/response for one recorded LLM call. Blob dedup is
 * transparent here — the viewer sees the complete wire body.
 */
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const detail = getLlmRequestDetail(req.params.id as string);
    if (!detail) return res.status(404).json({ error: "Request not found" });
    res.json(detail);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * DELETE /api/llm-requests?chatId=
 * Clear the recorded request log for a chat (and vacuum unreferenced blobs).
 */
router.delete("/", async (req: Request, res: Response) => {
  try {
    const chatId = typeof req.query.chatId === "string" ? req.query.chatId : "";
    if (!chatId) {
      return res.status(400).json({ error: "chatId query parameter is required" });
    }
    const removed = clearLlmRequests(chatId);
    res.json({ removed });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
