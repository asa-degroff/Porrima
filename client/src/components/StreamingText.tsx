import { MarkdownRenderer } from "./MarkdownRenderer";

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
      <MarkdownRenderer content={content} />
    </span>
  );
}
