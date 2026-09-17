import type { CrossChatPostMetadata } from "../types";

function formatStamp(atIso: string): string {
  const date = new Date(atIso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Envelope card for a cross-chat post. The row is persisted as a user-role
 * message with content `[<agent name> from <title> — <stamp>] <subject>\n\n<body>`;
 * the card surfaces the attribution and shows the body without the envelope
 * header. The sender name comes from the post metadata (the user-configured
 * agent name at delivery time). Edit/retry are excluded upstream — these rows
 * are not user speech.
 */
export function CrossChatPostCard({
  post,
  content,
}: {
  post: CrossChatPostMetadata;
  content: string;
}) {
  const headerEnd = content.indexOf("\n\n");
  const body = (headerEnd >= 0 ? content.slice(headerEnd + 2) : content).trim();
  const senderName = post.agentName?.trim() || "Porrima";

  return (
    <div
      className="relative depth-raised mx-1 md:mx-2 my-2 rounded-xl border border-purple-400/25 bg-purple-500/10 px-4 py-3"
      data-cross-chat-post={post.originTaskId ?? post.fromChatId}
    >
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-purple-200/60">
        <span className="font-semibold text-purple-200/80">{senderName}</span>
        <span>·</span>
        <a
          href={`/?chat=${encodeURIComponent(post.fromChatId)}`}
          className="truncate hover:text-purple-100 hover:underline"
          title={`Open ${post.fromChatTitle}`}
        >
          from {post.fromChatTitle}
        </a>
        <span>·</span>
        <span className="shrink-0">{formatStamp(post.at)}</span>
      </div>
      {post.subject ? (
        <div className="mt-2 text-sm font-medium text-white/90">{post.subject}</div>
      ) : null}
      <div className="mt-1 whitespace-pre-wrap break-words text-sm text-white/75">{body}</div>
    </div>
  );
}
