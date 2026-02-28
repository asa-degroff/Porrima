import { lazy, Suspense } from "react";

const MarkdownRenderer = lazy(() =>
  import("./MarkdownRenderer").then((m) => ({ default: m.MarkdownRenderer }))
);

interface Props {
  content: string;
  isStreaming: boolean;
}

export function StreamingText({ content, isStreaming }: Props) {
  if (!content && isStreaming) {
    return (
      <span className="streaming-cursor text-white/50 text-sm">
        Thinking
      </span>
    );
  }

  return (
    <span className={isStreaming ? "streaming-cursor" : ""}>
      <Suspense fallback={<span className="text-sm whitespace-pre-wrap">{content}</span>}>
        <MarkdownRenderer content={content} />
      </Suspense>
    </span>
  );
}
