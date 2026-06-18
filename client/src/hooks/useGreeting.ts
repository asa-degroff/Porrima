import { useEffect, useState } from "react";
import { getGreeting } from "../utils/greeting";

/**
 * Returns the current greeting string and re-evaluates it when the
 * time-of-day slot rolls over (morning → afternoon → evening → night),
 * so an open chat updates automatically without a page refresh.
 *
 * Slot boundaries (local hour): 5, 12, 17, 22.
 */
export function useGreeting(): string {
  const [greeting, setGreeting] = useState(() => getGreeting());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const scheduleNext = () => {
      const now = new Date();
      const hour = now.getHours();
      // Next boundary hour in local time.
      let nextHour: number;
      if (hour < 5) nextHour = 5;
      else if (hour < 12) nextHour = 12;
      else if (hour < 17) nextHour = 17;
      else if (hour < 22) nextHour = 22;
      else nextHour = 5;

      const next = new Date(now);
      next.setHours(nextHour, 0, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      const delay = next.getTime() - now.getTime();
      timer = setTimeout(() => {
        setGreeting(getGreeting());
        scheduleNext();
      }, delay);
    };

    scheduleNext();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, []);

  return greeting;
}