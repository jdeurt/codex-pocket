import { pocketUrl } from "@/lib/pockets";
import { t as attempt } from "try";

/**
Resolve an already classified local source relative to the currently viewed file.
@param href - Local source with remote schemes excluded.
@param base - Current absolute file, when viewing Markdown.
@returns Local path with source line annotations removed.
*/
function resolvedFileLink(href: string, base?: string) {
  const source = href.replace(/(?::\d+(?::\d+)?)?(?:#L?\d+)?$/, "");
  const encoded =
    base || href.startsWith("file:") ? new URL(source, base ? `file://${base}` : undefined).pathname : source;

  return decodeURIComponent(encoded);
}

/**
Resolve local Markdown links while leaving web URLs and fragments to the browser.
@param href - Original parser-owned link or image source.
@param base - Optional absolute file whose directory owns relative references.
@returns Absolute or cwd-relative local path, or undefined for a non-file URL.
*/
export function localFileLink(href: string, base?: string) {
  if (!href || href.startsWith("#") || href.startsWith("//") || href.startsWith("/api/")) {
    return;
  }

  if (/^[a-z][\w+.-]*:/i.test(href) && !href.startsWith("file:")) {
    return;
  }

  const outcome = attempt(() => {
    return resolvedFileLink(href, base);
  });

  if (outcome.ok) {
    return outcome.value;
  }

  return;
}

/**
Build a same-origin viewer route for a filesystem link.
@param filename - Local path to resolve on the configured computer.
@returns Escaped viewer route without browser navigation to a local filesystem URL.
*/
export const fileViewerUrl = (filename: string) => pocketUrl(`/files?path=${encodeURIComponent(filename)}`);
