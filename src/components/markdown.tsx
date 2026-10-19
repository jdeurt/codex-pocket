"use client";
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Markdown({ children: source }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          pre: ({ children }) => <>{children}</>,
          code: ({ children, className }) => {
            const text = String(children).replace(/\n$/, "");

            return className || text.includes("\n") ? (
              <CodeBlock>
                <CodeBlockContent>{text}</CodeBlockContent>
              </CodeBlock>
            ) : (
              <code>{children}</code>
            );
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
