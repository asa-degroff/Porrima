import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

// KaTeX CSS — provides rendering styles for inline and block math
import "katex/dist/katex.min.css";

const remarkPlugins = [remarkGfm, remarkMath];
// rehype-katex tuple with options — cast to avoid type mismatch with unified Pluggable
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rehypePlugins: any[] = [[rehypeKatex, { throwOnError: false }]];

interface Props {
  content: string;
}

export function MarkdownRenderer({ content }: Props) {
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
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
