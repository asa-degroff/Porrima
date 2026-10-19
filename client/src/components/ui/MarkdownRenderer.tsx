import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { useMemo } from "react";
import { MarkdownImage } from "./MarkdownImage";
import { escapeNonMathDollars } from "../../lib/math-delimiters";
import { rehypeMathGate } from "../../lib/rehype-math-gate";

// KaTeX CSS — provides rendering styles for inline and block math
import "katex/dist/katex.min.css";

const remarkPlugins = [remarkGfm, remarkMath];

interface Props {
  content: string;
  isStreaming?: boolean;
}

export function MarkdownRenderer({ content, isStreaming }: Props) {
  // Append cursor char to content so it renders inline inside the last text element
  const cursorContent = isStreaming ? content + "\u258b" : content;
  // View-only math preparation: escape dollar runs that are not valid math
  // delimiters (remark-math's tokenizer is too permissive on its own), and let
  // the gate plugin turn any surviving unparseable math into literal text.
  const prepared = useMemo(() => escapeNonMathDollars(cursorContent), [cursorContent]);
  // rehype plugins — cast to avoid type mismatch with unified Pluggable
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rehypePlugins: any[] = useMemo(
    () => [rehypeMathGate(prepared), [rehypeKatex, { throwOnError: false }]],
    [prepared]
  );
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={{
          table: ({ children, ...props }) => (
            <div className="table-wrapper">
              <table {...props}>{children}</table>
            </div>
          ),
          a: ({ href, children, ...props }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="markdown-link"
              {...props}
            >
              {children}
            </a>
          ),
          img: ({ src, alt, title }) => (
            <MarkdownImage
              src={typeof src === "string" ? src : undefined}
              alt={alt}
              title={title}
            />
          ),
        }}
      >
        {prepared}
      </ReactMarkdown>
    </div>
  );
}
