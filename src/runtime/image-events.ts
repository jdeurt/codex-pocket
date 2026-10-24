import { reportClient } from "./client-logging";

/** Publish a failed image and record diagnostics without copying inline image data.
@param publish - Owning image component's failure setter.
@param source - Original normalized image source.
*/
export function imageFailed(publish: (isFailed: boolean) => void, source: string) {
  publish(true);
  reportClient("image.failed", { source: source.startsWith("data:") ? "inline image" : source }, "error");
}
