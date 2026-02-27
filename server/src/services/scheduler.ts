import { shouldRunSynthesis, runDailySynthesis } from "./synthesis.js";

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

async function checkAndRun() {
  try {
    if (await shouldRunSynthesis()) {
      console.log("[scheduler] Synthesis due, starting...");
      await runDailySynthesis();
    }
  } catch (e) {
    console.error("[scheduler] Check failed:", e);
  }
}

export function startScheduler(): void {
  // Run immediately on startup (catches overdue synthesis)
  checkAndRun();

  // Then check hourly
  setInterval(checkAndRun, CHECK_INTERVAL_MS);
  console.log("[scheduler] Started (checks every hour)");
}
