import { Router } from "express";
import {
  createCustomAutomationTask,
  deleteAutomationTask,
  getAutomationTask,
  listArchivedAutomationTasks,
  listAutomationRuns,
  listAutomationTasks,
  resetBuiltinAutomationPrompts,
  updateAutomationTask,
} from "../services/automation-storage.js";
import { getActiveAutomationTaskId, isAutomationActive } from "../services/automation-lock.js";
import { runAutomationTask } from "../services/automation-runner.js";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const archived = req.query.archived === "true";
    res.json({
      tasks: archived ? listArchivedAutomationTasks() : listAutomationTasks(),
      activeTaskId: getActiveAutomationTaskId(),
      isRunning: isAutomationActive(),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/", async (req, res) => {
  try {
    const task = createCustomAutomationTask(req.body ?? {});
    res.status(201).json(task);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const task = updateAutomationTask(req.params.id, req.body ?? {});
    if (!task) return res.status(404).json({ error: "Automation not found" });
    res.json(task);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const existing = getAutomationTask(req.params.id);
    if (!existing) return res.status(404).json({ error: "Automation not found" });
    if (existing.builtIn) {
      return res.status(400).json({ error: "Built-in automations can be disabled but not deleted" });
    }
    const ok = deleteAutomationTask(req.params.id);
    res.json({ deleted: ok });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/reset-prompts", async (req, res) => {
  try {
    const task = resetBuiltinAutomationPrompts(req.params.id);
    if (!task) return res.status(404).json({ error: "Built-in automation not found" });
    res.json(task);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/:id/run", async (req, res) => {
  try {
    const task = getAutomationTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Automation not found" });
    if (isAutomationActive()) {
      return res.status(409).json({
        error: "Automation already in progress",
        activeTaskId: getActiveAutomationTaskId(),
      });
    }

    runAutomationTask(task, "manual")
      .then((result) => {
        if (!result.success) {
          console.error(`[automation/manual] ${task.id} failed:`, result.error);
        } else {
          console.log(
            `[automation/manual] ${task.id} complete: ${result.summary.length}ch, ${result.toolCalls.length} tools`,
          );
        }
      })
      .catch((e: any) => {
        console.error(`[automation/manual] ${task.id} threw:`, e?.message || e);
      });

    res.status(202).json({ started: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/:id/runs", async (req, res) => {
  try {
    if (!getAutomationTask(req.params.id)) {
      return res.status(404).json({ error: "Automation not found" });
    }
    res.json({ runs: listAutomationRuns(req.params.id, Number(req.query.limit ?? 50)) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
