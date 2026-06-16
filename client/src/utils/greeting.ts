const GREETINGS = {
  night: [
    "Deep thinking.",
    "The quiet hours.",
    "Late night thoughts.",
    "The midnight canvas.",
    "The dark and the deep.",
    "While the world sleeps."
  ],
  morning: [
    "Good morning.",
    "Bright and early.",
    "Morning light.",
    "Morning musings.",
    "First light, fresh thought."
  ],
  afternoon: [
    "Good afternoon.",
    "Midday session.",
    "The afternoon stretch.",
    "Deep in the day.",
    "Where focus settles."
  ],
  evening: [
    "Good evening.",
    "Evening settles in.",
    "Golden hours.",
    "The softening hours.",
    "Evening ease."
  ],
};

const SLOT_INDEX: Record<keyof typeof GREETINGS, number> = {
  morning: 0,
  afternoon: 1,
  evening: 2,
  night: 3,
};

function getTimeSlot(hour: number): keyof typeof GREETINGS {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "night";
}

/**
 * xorshift32 — 2³² cycle, no short loops.
 * The seed blends day-of-year with slot identity so
 * each time slot gets its own independent sequence.
 */
function seededIndex(dayOfYear: number, slotIdx: number, length: number): number {
  let x = (dayOfYear * 2654435761 + slotIdx * 2246822519) >>> 0;
  x = ((x ^ (x >>> 13)) * 0x5bd1e995) >>> 0;
  x = ((x ^ (x >>> 15)) * 0x5bd1e995) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x % length;
}

function getDayOfYear(date: Date): number {
  const start = Date.UTC(date.getFullYear(), 0, 0);
  const current = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.floor((current - start) / 86400000);
}

/**
 * Returns a greeting string based on the current local time.
 * Uses a day-of-year + slot seed so it stays stable within
 * a time window but changes across days — no jittering while
 * you watch it, no predictable rotation.
 */
export function getGreeting(date = new Date()): string {
  const slot = getTimeSlot(date.getHours());
  const options = GREETINGS[slot];
  const dayOfYear = getDayOfYear(date);
  return options[seededIndex(dayOfYear, SLOT_INDEX[slot], options.length)];
}
