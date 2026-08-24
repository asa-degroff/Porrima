/**
 * Agent clock formatting.
 *
 * Every clock the model reads — the turn anchor (memory-context), the
 * intra-loop time markers (time-marker), and the synthesis/wake stamps
 * (system-chat) — renders in the user's local zone: the same frame the OS
 * clock, tool output, and the user's own speech all speak in. An explicit
 * UTC offset is appended so the instant stays unambiguous: bare local wall
 * time is ambiguous across DST transitions (the fall-back hour happens
 * twice), and UTC is just the offset-zero case.
 *
 * Zone resolution: an explicit IANA zone when given (tests, future
 * per-user setting), else the system zone (Intl's default). Presentation
 * only — stored timestamps remain canonical UTC (toISOString) throughout.
 *
 * Output shape: `YYYY-MM-DD HH:MM [<abbr>] (UTC±HH:MM)` — the abbreviation
 * is omitted when ICU would render it as a GMT-offset form, since that
 * duplicates the explicit offset.
 * e.g. `2026-08-23 23:58 MDT (UTC-06:00)`, `2026-08-24 11:52 (UTC+05:45)`
 */

interface ZoneFormats {
  wall: Intl.DateTimeFormat;
  offset: Intl.DateTimeFormat;
}

const fmtCache = new Map<string, ZoneFormats>();
const invalidZones = new Set<string>();
let systemZone: string | null = null;

/** The system IANA zone (Intl's default), resolved once. */
export function resolveSystemTimeZone(): string {
  if (systemZone === null) {
    try {
      systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      systemZone = "UTC";
    }
  }
  return systemZone;
}

function zoneValid(zone: string): boolean {
  if (invalidZones.has(zone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    invalidZones.add(zone);
    return false;
  }
}

function zoneFormats(zone: string): ZoneFormats {
  let z = fmtCache.get(zone);
  if (!z) {
    z = {
      wall: new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hourCycle: "h23",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      }),
      offset: new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        timeZoneName: "longOffset",
      }),
    };
    fmtCache.set(zone, z);
  }
  return z;
}

/**
 * Map Intl's long-offset part to the agent's offset label:
 * "GMT" → "UTC+00:00", "GMT-06:00" → "UTC-06:00", "GMT+05:30" → "UTC+05:30".
 */
function offsetLabel(part: string): string {
  const suffix = part.startsWith("GMT") ? part.slice(3) : "";
  return "UTC" + (suffix || "+00:00");
}

/**
 * Render an instant as the agent's clock: `2026-08-23 23:58 MDT (UTC-06:00)`.
 *
 * `timeZone` (IANA name) defaults to the system zone; an invalid or empty
 * zone falls back to the system zone rather than throwing.
 */
export function formatAgentClock(now: Date, timeZone?: string): string {
  const zone = timeZone && zoneValid(timeZone) ? timeZone : resolveSystemTimeZone();
  const { wall, offset } = zoneFormats(zone);
  const parts = wall.formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const offsetPart =
    offset.formatToParts(now).find((p) => p.type === "timeZoneName")?.value ??
    "GMT";
  const abbr = get("timeZoneName");
  // A GMT-form "abbreviation" (e.g. "GMT+5:45" for Kathmandu) duplicates the
  // explicit offset, so it is dropped — the parenthesized offset is the
  // single source of truth. Named abbreviations (MDT, IST, UTC) stay.
  const name =
    abbr && !/^GMT([+-]\d{1,2}:?\d{2})?$/i.test(abbr) ? ` ${abbr}` : "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get(
    "minute",
  )}${name} (${offsetLabel(offsetPart)})`;
}
