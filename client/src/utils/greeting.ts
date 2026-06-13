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

function getTimeSlot(hour: number): keyof typeof GREETINGS {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "night";
}

/**
 * Returns a greeting string based on the current local time.
 * Uses a day-of-year seed so it stays stable within a day
 * but changes across days — no jittering while you watch it.
 */
export function getGreeting(date = new Date()): string {
  const slot = getTimeSlot(date.getHours());
  const options = GREETINGS[slot];
  const start = new Date(date.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((date.getTime() - start.getTime()) / 86400000);
  return options[dayOfYear % options.length];
}
