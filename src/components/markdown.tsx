"use client";
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";
import { type ComponentProps, memo } from "react";
import ReactMarkdown, { type ExtraProps, defaultUrlTransform } from "react-markdown";
import { hasMarkdownOutput, markdownPlugins } from "@/lib/markdown-content";
import { AttachmentGroup } from "@/components/ui/attachment";
import { ChatImage } from "./chat-image";
import { CopyAction } from "./copy-action";
import { Table } from "@/components/ui/table";
import { imageUrl } from "@/lib/images";

function MarkdownPre({ children }: ComponentProps<"pre">) {
  return <>{children}</>;
}

function MarkdownCode({ children, className, node }: ComponentProps<"code"> & ExtraProps) {
  const copyText = node?.properties["data-pocket-copy-text"];

  // This property is set only by the opt-in assistant marker plugin.
  if (typeof copyText === "string") {
    return <CopyAction key={copyText} text={copyText} />;
  }

  const text =
    node?.children
      .filter((child) => child.type === "text")
      .map((child) => child.value)
      .join("")
      .replace(/\n$/, "") ?? "";

  return className || text.includes("\n") ? (
    <CodeBlock>
      <CodeBlockContent>{text}</CodeBlockContent>
    </CodeBlock>
  ) : (
    <code>{children}</code>
  );
}

export const Markdown = memo(function MarkdownContent({
  children: source,
  allowCopyActions = false,
  imageBase,
}: {
  children: string;
  allowCopyActions?: boolean;
  imageBase?: string;
}) {
  if (!hasMarkdownOutput(source, allowCopyActions)) {
    return null;
  }

  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={markdownPlugins(allowCopyActions)}
        urlTransform={(url, key) =>
          key === "src"
            ? imageBase && imageUrl(url) && !url.startsWith("data:")
              ? `${imageBase}&source=${encodeURIComponent(url)}`
              : imageUrl(url)
            : defaultUrlTransform(url)
        }
        components={{
          table: ({ children }) => (
            <Table
              variant="markdown"
              containerProps={{ role: "region", "aria-label": "Scrollable table", tabIndex: 0 }}
            >
              {children}
            </Table>
          ),
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
          pre: MarkdownPre,
          code: MarkdownCode,
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});
