import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { z } from "zod";

const partSchema = z.looseObject({ type: z.string(), text: z.string().optional(), path: z.string().optional() });
const inputSchema = z.array(partSchema);

/** Translate canonical original upload inputs into Pi text and correctly typed image bytes.
@param value - Canonical parent turn input, already resolved from managed uploads.
@returns Original user text and image attachments for Pi's native multimodal prompt.
*/
export async function piInput(value: unknown) {
  const input = inputSchema.parse(value);
  const text = input
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n");
  const images = await Promise.all(
    input
      .filter((part) => part.type === "localImage")
      .map(async (part) => {
        const original = await readFile(part.path ?? "");
        const png = await sharp(original).png().toBuffer();

        return { type: "image" as const, mimeType: "image/png", data: png.toString("base64") };
      })
  );

  return { text, images };
}
