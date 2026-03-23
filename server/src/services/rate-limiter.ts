import { getDb } from "./chat-storage.js";

const DAILY_GENERATION_LIMIT = 10;

/**
 * Check if autonomous generation is allowed under rate limits.
 * Returns true if under the daily limit, false if limit reached.
 */
export async function canGenerateAutonomously(): Promise<boolean> {
  try {
    const db = getDb();
    
    // Count generations in last 24 hours
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    
    const result = db.prepare(`
      SELECT COUNT(*) as count
      FROM chat_messages
      WHERE role = 'assistant'
        AND timestamp > ?
        AND content LIKE '%generate_image%'
    `).get(twentyFourHoursAgo) as { count: number };
    
    const count = result.count ?? 0;
    return count < DAILY_GENERATION_LIMIT;
  } catch (e) {
    console.error("[rate-limiter] Generation check failed:", e);
    return true; // Fail open - allow generation if check fails
  }
}

/**
 * Get current generation count for the day.
 */
export async function getDailyGenerationCount(): Promise<number> {
  try {
    const db = getDb();
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    
    const result = db.prepare(`
      SELECT COUNT(*) as count
      FROM chat_messages
      WHERE role = 'assistant'
        AND timestamp > ?
        AND content LIKE '%generate_image%'
    `).get(twentyFourHoursAgo) as { count: number };
    
    return result.count ?? 0;
  } catch (e) {
    console.error("[rate-limiter] Count check failed:", e);
    return 0;
  }
}

/**
 * Log an autonomous generation for rate limiting.
 */
export async function logAutonomousGeneration(chatId: string, prompt: string): Promise<void> {
  try {
    const db = getDb();
    
    // Insert a marker message for tracking
    db.prepare(`
      INSERT INTO chat_messages (chat_id, message_index, role, content, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      chatId,
      -1, // Marker index
      'assistant',
      `[autonomous-generation] ${prompt}`,
      new Date().toISOString()
    );
    
    console.log(`[rate-limiter] Logged autonomous generation for chat ${chatId}`);
  } catch (e) {
    console.error("[rate-limiter] Log failed:", e);
  }
}
