"use client";
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";
import { type ComponentProps, memo } from "react";
import ReactMarkdown, { type ExtraProps, defaultUrlTransform } from "react-markdown";
import { fileViewerUrl, localFileLink } from "@/lib/file-links";
import { hasMarkdownOutput, markdownPlugins } from "@/lib/markdown-content";
import { AttachmentGroup } from "@/components/ui/attachment";
import { ChatImage } from "./chat-image";
import { CopyAction } from "./copy-action";
import Link from "next/link";
import { MarkdownSelection } from "./markdown-selection";
import { Table } from "@/components/ui/table";
import { imageUrl } from "@/lib/images";
import { rehypeReveal } from "@/lib/rehype-reveal";
import { useContentReveal } from "@/hooks/use-content-reveal";

/**
Avoid a second native pre wrapper around the shared code-block renderer.
@param props - Native pre children supplied by react-markdown.
@returns The unchanged children as a fragment.
*/
function MarkdownPre({ children }: ComponentProps<"pre">) {
  return <>{children}</>;
}

/**
Render ordinary inline or block code using the parser's exact text children.
@param props - Native code props and react-markdown AST metadata.
@returns The existing literal inline or block code presentation.
*/
function MarkdownLiteralCode({ children, className, node }: ComponentProps<"code"> & ExtraProps) {
  const text =
    node?.children
      .filter((child) => child.type === "text")
      .map((child) => child.value)
      .join("")
      .replace(/\n$/, "") ?? "";
  const from = node?.properties["data-pocket-reveal-from"];
  const content =
    typeof from === "number" && from < text.length ? (
      <span>
        {text.slice(0, from)}
        <span data-pocket-fresh="">{text.slice(from)}</span>
      </span>
    ) : (
      text
    );

  return className || text.includes("\n") ? (
    <CodeBlock>
      <CodeBlockContent>{content}</CodeBlockContent>
    </CodeBlock>
  ) : (
    <code>{typeof from === "number" ? content : children}</code>
  );
}

/**
Select explicit assistant copy actions using parser-owned metadata rather than display text.
@param props - Native code props and react-markdown AST metadata.
@returns The exact copy action or the ordinary literal-code renderer.
*/
function MarkdownCode({ node, ...props }: ComponentProps<"code"> & ExtraProps) {
  const copyText = node?.properties["data-pocket-copy-text"];

  return typeof copyText === "string" ? (
    <CopyAction key={copyText} text={copyText} />
  ) : (
    <MarkdownLiteralCode node={node} {...props} />
  );
}

/**
Allow block attachment composition only when a parsed paragraph contains images and whitespace.
@param props - Native paragraph children and the actual parser-owned element node.
@returns The existing image group or ordinary Markdown paragraph container.
*/
function MarkdownParagraph({ children, node }: ComponentProps<"p"> & ExtraProps) {
  const isImageGroup = node?.children.every((child) =>
    child.type === "text" ? !child.value.trim() : child.type === "element" && child.tagName === "img"
  );

  return isImageGroup ? (
    <AttachmentGroup layout="wrap" className="chat-images">
      {children}
    </AttachmentGroup>
  ) : (
    <div className="markdown-paragraph">{children}</div>
  );
}

/**
Keep Markdown link validation and guarded local-image routing in their shared URL adapters.
@param url - URL text supplied by react-markdown.
@param key - Native attribute being transformed.
@param imageBase - Optional read-only agent image endpoint for local source routing.
@returns The same safe link or image URL used by the existing renderer.
*/
function markdownUrl(url: string, key: string, imageBase: string | undefined) {
  if (key !== "src") {
    return defaultUrlTransform(url);
  }

  return imageBase && !url.startsWith("data:") && imageUrl(url)
    ? `${imageBase}&source=${encodeURIComponent(url)}`
    : imageUrl(url);
}

export const Markdown = memo(function MarkdownContent({
  children: source,
  allowCopyActions = false,
  imageBase,
  fileBase,
  revealFrom,
  revealId,
}: {
  children: string;
  allowCopyActions?: boolean;
  imageBase?: string;
  fileBase?: string;
  revealFrom?: number;
  revealId?: string;
}) {
  const container = useContentReveal(revealId);

  if (!hasMarkdownOutput(source, allowCopyActions)) {
    return null;
  }

  return (
    <MarkdownSelection containerRef={container}>
      <ReactMarkdown
        remarkPlugins={markdownPlugins(allowCopyActions)}
        rehypePlugins={revealFrom === undefined ? [] : [[rehypeReveal, { source, from: revealFrom }]]}
        urlTransform={(url, key) => {
          const local = localFileLink(url, fileBase);

          if (key === "href" && local) {
            return fileViewerUrl(local);
          }

          return key === "src" && fileBase && local
            ? `/api/files?path=${encodeURIComponent(local)}`
            : markdownUrl(url, key, imageBase);
        }}
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
          p: MarkdownParagraph,
          a: ({ children, href, ...props }) =>
            href?.startsWith("/files?") ? (
              <Link {...props} href={href} scroll={false} prefetch={false}>
                {children}
              </Link>
            ) : (
              <a {...props} href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ),
          pre: MarkdownPre,
          code: MarkdownCode,
        }}
      >
        {source}
      </ReactMarkdown>
    </MarkdownSelection>
  );
});
