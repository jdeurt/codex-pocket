import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { z } from "zod";

const partSchema = z.looseObject({ type: z.string(), text: z.string().optional(), path: z.string().optional() });
const inputSchema = z.array(partSchema);

/** Read and normalize one original managed image for the native model.
@param filename - Original managed upload path.
@returns Pi image content with its actual encoded media type.
*/
async function readImage(filename: string) {
  const original = await readFile(filename);
  const png = await sharp(original).png().toBuffer();

  return { type: "image" as const, mimeType: "image/png", data: png.toString("base64") };
}

/** Translate canonical original upload inputs into Pi text and correctly typed image bytes.
@param value - Canonical parent turn input, already resolved from managed uploads.
@returns Original user text and image attachments for Pi's native multimodal prompt.
*/
export async function piInput(value: unknown) {
  const input = inputSchema.parse(value);
  const texts: string[] = [];
  const images: Promise<Awaited<ReturnType<typeof readImage>>>[] = [];

  for (const part of input) {
    if (part.text) {
      texts.push(part.text);
    }

    if (part.type === "localImage") {
      images.push(readImage(part.path ?? ""));
    }
  }

  return { text: texts.join("\n"), images: await Promise.all(images) };
}
