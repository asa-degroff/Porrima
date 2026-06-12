import { Router } from "express";
import { checkForAppUpdate, getAppBuildInfo } from "../services/app-version.js";

const router = Router();

router.get("/version", (_req, res) => {
  res.json(getAppBuildInfo());
});

router.get("/update-check", async (req, res) => {
  const force = req.query.force === "1" || req.query.force === "true";
  res.json(await checkForAppUpdate({ force }));
});

export default router;
