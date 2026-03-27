import { Router } from "express";
import { getUserUIState, saveUserUIState, type UserUIState } from "../services/chat-storage.js";

const router = Router();

router.get("/", async (_req, res) => {
  const state = await getUserUIState();
  res.json(state);
});

router.put("/", async (req, res) => {
  const state = req.body as Partial<UserUIState>;
  await saveUserUIState(state);
  const updated = await getUserUIState();
  res.json(updated);
});

export default router;
