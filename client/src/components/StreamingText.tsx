import { lazy, Suspense } from "react";

const MarkdownRenderer = lazy(() =>
  import("./ui/MarkdownRenderer").then((m) => ({ default: m.MarkdownRenderer }))
);

interface Props {
  content: string;
  isStreaming: boolean;
}

export function StreamingText({ content, isStreaming }: Props) {
  if (!content && isStreaming) {
    return (
      <span className="text-white/50 text-sm">
        Thinking
      </span>
    );
  }

  return (
    <Suspense fallback={<span className="text-sm whitespace-pre-wrap">{content}</span>}>
      <MarkdownRenderer content={content} isStreaming={isStreaming} />
    </Suspense>
  );
}
