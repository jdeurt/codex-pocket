"use client";
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import { AttachmentGroup } from "@/components/ui/attachment";
import { ChatImage } from "./chat-image";
import { imageUrl } from "@/lib/images";
import { memo } from "react";
import remarkGfm from "remark-gfm";

export const Markdown = memo(function MarkdownContent({ children: source }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url, key) => (key === "src" ? imageUrl(url) : defaultUrlTransform(url))}
        components={{
          img: ({ src, alt = "Image from Pocket" }) => (
            <ChatImage key={typeof src === "string" ? src : ""} source={typeof src === "string" ? src : ""} alt={alt} />
          ),
          // Markdown permits images inside paragraphs; use a block container for attachment/dialog composition.
          p: ({ children, node }) =>
            node?.children.every((child) =>
              child.type === "text" ? !child.value.trim() : child.type === "element" && child.tagName === "img"
            ) ? (
              <AttachmentGroup layout="wrap" className="chat-images">
                {children}
              </AttachmentGroup>
            ) : (
              <div className="markdown-paragraph">{children}</div>
            ),
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
});
