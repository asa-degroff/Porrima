/**
 * Time markers for long-running agent loops.
 *
 * Time anchors freeze at row boundaries (user rows carry the turn anchor),
 * so within a long tool loop the prompt's only clock reading — the
 * turn-start anchor — can grow arbitrarily stale. Time markers close that
 * gap without disturbing the KV prefix: each marker is appended to the TAIL
 * of a tool result (new tokens only), and because the marker is applied at
 * the tool's execute boundary — before the result enters the live context
 * or the persisted row — wire and replay stay byte-identical.
 *
 * The gate is elapsed-time based: at most one marker fires per interval
 * (configurable in minutes; 0 or unset disables markers entirely). The
 * first marker of a loop reports its delta from the loop start (the turn's
 * anchor moment); every later marker reports its delta from the previous
 * marker, so the model reconstructs the current clock by summing small
 * deltas against the freshest tokens in the prompt instead of retrieving a
 * stale reading from deep context.
 */

export interface TimeMarkerState {
  /** Minimum elapsed time between markers. */
  readonly intervalMs: number;
  /** Wall-clock time the loop (turn) started — the first marker's reference. */
  readonly loopStartMs: number;
  /** Wall-clock time of the last emitted marker, or null if none yet. */
  lastMarkerMs: number | null;
  /** Markers emitted so far (diagnostics). */
  markerCount: number;
}

/**
 * Create per-loop marker state. Returns null (markers disabled) when the
 * interval is not a positive finite number.
 */
export function createTimeMarkerState(
  intervalMinutes: number | undefined,
  now: number = Date.now(),
): TimeMarkerState | null {
  if (
    typeof intervalMinutes !== "number" ||
    !Number.isFinite(intervalMinutes) ||
    intervalMinutes <= 0
  ) {
    return null;
  }
  return {
    intervalMs: intervalMinutes * 60_000,
    loopStartMs: now,
    lastMarkerMs: null,
    markerCount: 0,
  };
}

function formatUtc(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  );
}

/**
 * "42m" under an hour, "1h 05m" above — finer than the turn anchor's gap
 * clause, because marker deltas ARE the model's intra-loop clock unit.
 */
function formatDelta(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

/**
 * Append a `[time:]` marker to the tool result if the gate has elapsed.
 *
 * The check-and-set is synchronous, so parallel tool batches can never emit
 * more than one marker: a second result completing moments later sees
 * lastMarkerMs already advanced past the gate. Returns the same result
 * object (no copy) when no marker fires.
 *
 * `now` is injectable for deterministic tests.
 */
export function applyTimeMarker<R extends { content: readonly unknown[] }>(
  result: R,
  state: TimeMarkerState | null,
  now: number = Date.now(),
): R {
  if (!state) return result;
  const reference = state.lastMarkerMs ?? state.loopStartMs;
  if (now - reference < state.intervalMs) return result;

  const since = state.lastMarkerMs === null ? "turn start" : "last marker";
  const line = `\n\n[time: ${formatUtc(new Date(now))} — ${formatDelta(now - reference)} since ${since}]`;

  const content = (result.content as readonly any[]).map((part) => ({ ...part }));
  const textIdx = content.findIndex((part) => part.type === "text");
  if (textIdx >= 0) {
    content[textIdx] = { ...content[textIdx], text: `${content[textIdx].text}${line}` };
  } else {
    content.push({ type: "text", text: line.trimStart() });
  }

  state.lastMarkerMs = now;
  state.markerCount += 1;
  return { ...result, content };
}
