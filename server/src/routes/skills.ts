import { Router } from "express";
import type { Request, Response } from "express";
import { discoverSkills, getSkillByName, installSkillFromUrl, removeGlobalSkill, updateGlobalSkill } from "../services/skills.js";

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

// POST /api/skills/install - install a skill from URL or GitHub
router.post("/install", async (req: Request, res: Response) => {
  try {
    const { url, name } = req.body as { url: string; name?: string };
    if (!url) {
      return res.status(400).json({ error: "URL is required" });
    }
    
    const result = await installSkillFromUrl(url, name);
    res.json(result);
  } catch (err: any) {
    console.error("[skills] Failed to install skill:", err);
    res.status(500).json({ error: err.message || "Failed to install skill" });
  }
});

// DELETE /api/skills/:name - remove a global skill
router.delete("/:name", async (req: Request, res: Response) => {
  try {
    const skillName = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
    const result = await removeGlobalSkill(skillName);
    res.json(result);
  } catch (err: any) {
    console.error("[skills] Failed to remove skill:", err);
    res.status(500).json({ error: err.message || "Failed to remove skill" });
  }
});

// PUT /api/skills/:name - update a global skill
router.put("/:name", async (req: Request, res: Response) => {
  try {
    const skillName = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
    const { content } = req.body as { content: string };
    if (!content) {
      return res.status(400).json({ error: "Content is required" });
    }
    
    const result = await updateGlobalSkill(skillName, content);
    res.json(result);
  } catch (err: any) {
    console.error("[skills] Failed to update skill:", err);
    res.status(500).json({ error: err.message || "Failed to update skill" });
  }
});

export default router;
