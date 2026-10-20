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

  const value = href.startsWith("file:")
    ? decodeURIComponent(new URL(href).pathname)
    : href.replace(/(?::\d+(?::\d+)?)?(?:#L?\d+)?$/, "");

  return base ? decodeURIComponent(new URL(value, `file://${base}`).pathname) : value;
}

/**
Build a same-origin viewer route for a filesystem link.
@param filename - Local path to resolve on the configured computer.
@returns Escaped viewer route without browser navigation to a local filesystem URL.
*/
export const fileViewerUrl = (filename: string) => `/files?path=${encodeURIComponent(filename)}`;
