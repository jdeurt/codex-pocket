import { type Item, object, string } from "./protocol";

export function itemImageSources(item: Item): string[] {
  if (item.type === "imageGeneration") {
    const saved = string(item.savedPath);
    const result = string(item.result);

    return saved ? [saved] : result ? [result.startsWith("data:") ? result : `data:image/png;base64,${result}`] : [];
  }

  if (item.type === "imageView") {
    return string(item.path) ? [string(item.path)] : [];
  }

  const content =
    item.type === "mcpToolCall"
      ? object(item.result).content
      : item.type === "dynamicToolCall"
        ? item.contentItems
        : item.type === "functionCallOutput"
          ? item.output
          : item.type === "userMessage"
            ? item.content
            : [];
  const sources = Array.isArray(content)
    ? content.flatMap((part) => {
        const value = object(part);
        const type = string(value.type);

        if (type === "localImage") {
          return string(value.path);
        }

        if (type === "image") {
          return value.data && string(value.mimeType).startsWith("image/")
            ? `data:${value.mimeType};base64,${value.data}`
            : string(value.url);
        }

        if (["inputImage", "input_image"].includes(type)) {
          return string(value.imageUrl) || string(value.image_url);
        }

        if (type === "resource") {
          const resource = object(value.resource);

          return string(resource.mimeType).startsWith("image/") && resource.blob
            ? `data:${resource.mimeType};base64,${resource.blob}`
            : [];
        }

        return [];
      })
    : [];

  return [...new Set(sources.filter(Boolean))];
}

export function itemImageUrl(itemId: string, index: number) {
  return `/api/images?item=${encodeURIComponent(itemId)}&index=${index}`;
}

export function imageUrl(source: string) {
  if (!source.trim()) {
    return "";
  }

  if (/^data:image\/(?:png|jpe?g|webp|gif|avif);base64,/i.test(source)) {
    return source;
  }

  if (/^https?:\/\//i.test(source) || source.startsWith("/api/images?") || source.startsWith("/api/uploads?")) {
    return source;
  }

  return /^[a-z][\w+.-]*:/i.test(source) && !source.startsWith("file:") && !source.startsWith("data:image/")
    ? ""
    : `/api/images?path=${encodeURIComponent(source)}`;
}

export const thumbnailUrl = (source: string) =>
  source.startsWith("/api/images?") || source.startsWith("/api/uploads?") ? `${source}&thumbnail=1` : source;
