import { type Item, object, string } from "./protocol";

/**
Select native content according to the normalized item's protocol envelope.
@param item - Transcript item whose native fields remain unchecked.
@returns Its content field, or an empty list for non-content item kinds.
*/
function imageContent(item: Item): unknown {
  switch (item.type) {
    case "mcpToolCall": {
      return object(item.result).content;
    }

    case "dynamicToolCall": {
      return item.contentItems;
    }

    case "functionCallOutput": {
      return item.output;
    }

    default: {
      return ["userMessage", "agentMessage", "imageOutput"].includes(item.type) ? item.content : [];
    }
  }
}

/**
Normalize the supported native image-part shapes at the shared transcript boundary.
@param part - Unchecked MCP or native input content part.
@returns Its image path, URL or inline data, otherwise an empty string.
*/
function contentImageSource(part: unknown): string {
  const value = object(part);
  const type = string(value.type);

  switch (type) {
    case "localImage": {
      return string(value.path);
    }

    case "image": {
      return typeof value.data === "string" && typeof value.mimeType === "string" && value.mimeType.startsWith("image/")
        ? `data:${value.mimeType};base64,${value.data}`
        : string(value.url);
    }

    case "inputImage":
    case "input_image": {
      return string(value.imageUrl) || string(value.image_url);
    }

    case "resource": {
      const resource = object(value.resource);

      return typeof resource.mimeType === "string" &&
        resource.mimeType.startsWith("image/") &&
        typeof resource.blob === "string"
        ? `data:${resource.mimeType};base64,${resource.blob}`
        : "";
    }

    default: {
      return "";
    }
  }
}

/**
Prefer a saved generated image path, falling back to the native inline PNG result.
@param saved - Native saved path, or an empty string.
@param result - Native data URL or unprefixed base64 PNG bytes.
@returns The single available source, or an empty list.
*/
function generatedImageSources(saved: string, result: string) {
  if (saved) {
    return [saved];
  }

  if (!result) {
    return [];
  }

  return [result.startsWith("data:") ? result : `data:image/png;base64,${result}`];
}

/**
Collect native image sources once for both message rendering and guarded image reads.
@param item - Normalized transcript item with preserved native content fields.
@returns Unique nonempty sources in protocol order.
*/
export function itemImageSources(item: Item): string[] {
  switch (item.type) {
    case "imageGeneration": {
      return generatedImageSources(string(item.savedPath), string(item.result));
    }

    case "imageView": {
      const path = string(item.path);

      return path ? [path] : [];
    }

    default: {
      const content = imageContent(item);
      const sources = Array.isArray(content) ? Array.from(content, contentImageSource).filter(Boolean) : [];

      return [...new Set(sources)];
    }
  }
}

/**
Build an image route tied to a transcript item rather than exposing a local file path.
@param itemId - Owning transcript item identifier.
@param index - Zero-based position in the item's normalized image sources.
@returns The encoded same-origin image URL.
*/
export function itemImageUrl(itemId: string, index: number) {
  return `/api/images?item=${encodeURIComponent(itemId)}&index=${String(index)}`;
}

/** Identify local endpoints with guarded image and thumbnail representations.
@param source - Candidate display URL.
@returns Whether Pocket owns the image representation.
*/
function isLocalImageUrl(source: string) {
  return source.startsWith("/api/images?") || source.startsWith("/api/uploads?") || source.startsWith("/api/agents?");
}

/**
Allow supported image URLs and route local paths through Pocket's guarded image endpoint.
@param source - Native image path or candidate URL.
@returns A safe display URL, or an empty string for blank or unsupported protocols.
*/
export function imageUrl(source: string) {
  if (!source.trim()) {
    return "";
  }

  if (
    /^data:image\/(?:png|jpe?g|webp|gif|avif);base64,/i.test(source) ||
    /^https?:\/\//i.test(source) ||
    isLocalImageUrl(source)
  ) {
    return source;
  }

  return /^[a-z][\w+.-]*:/i.test(source) && !source.startsWith("file:") && !source.startsWith("data:image/")
    ? ""
    : `/api/images?path=${encodeURIComponent(source)}`;
}

/**
Select a thumbnail only for Pocket endpoints that implement that representation.
@param source - Already normalized display URL.
@returns The thumbnail URL for local endpoints, otherwise the original URL.
*/
export const thumbnailUrl = (source: string) => (isLocalImageUrl(source) ? `${source}&thumbnail=1` : source);
