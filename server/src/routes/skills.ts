import { Router } from "express";
import type { Request, Response } from "express";
import { discoverSkills, getSkillByName } from "../services/skills.js";

const router = Router();

// GET /api/skills - list all available skills
router.get("/", async (req: Request, res: Response) => {
  try {
    const projectId = req.query.projectId as string | undefined;
    const skills = await discoverSkills(projectId);
    res.json(skills.map(s => ({
      name: s.name,
      description: s.description,
      source: s.source,
      projectId: s.projectId,
    })));
  } catch (err: any) {
    console.error("[skills] Failed to discover skills:", err);
    res.status(500).json({ error: "Failed to load skills" });
  }
});

// GET /api/skills/:name - get full skill content
router.get("/:name", async (req: Request, res: Response) => {
  try {
    const skillName = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
    const projectId = req.query.projectId as string | undefined;
    const skill = await getSkillByName(skillName, projectId);
    if (!skill) {
      return res.status(404).json({ error: "Skill not found" });
    }
    res.json(skill);
  } catch (err: any) {
    console.error("[skills] Failed to get skill:", err);
    res.status(500).json({ error: "Failed to load skill" });
  }
});

export default router;
