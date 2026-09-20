import type { ReminderMetadata } from "../types";

function formatStamp(atIso: string): string {
  const date = new Date(atIso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Envelope card for an in-chat reminder trigger row. The row is persisted as
 * a user-role message with the bare reminder prompt as content; the card
 * surfaces the title and fire time from the reminder metadata. Edit/retry are
 * excluded upstream — these rows are not user speech (editing would truncate
 * the thread after the row).
 */
export function ReminderCard({
  reminder,
  content,
}: {
  reminder: ReminderMetadata;
  content: string;
}) {
  return (
    <div
      className="relative depth-raised mx-1 md:mx-2 my-2 rounded-xl border border-amber-400/25 bg-amber-500/10 px-4 py-3"
      data-reminder={reminder.taskId}
    >
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-amber-200/60">
        <span className="font-semibold text-amber-200/80">reminder</span>
        <span>·</span>
        <span className="shrink-0">{formatStamp(reminder.firedAt)}</span>
      </div>
      <div className="mt-2 text-sm font-medium text-white/90">{reminder.title}</div>
      <div className="mt-1 whitespace-pre-wrap break-words text-sm text-white/75">{content}</div>
    </div>
  );
}
