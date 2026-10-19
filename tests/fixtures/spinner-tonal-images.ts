/* eslint-disable @typescript-eslint/no-magic-numbers -- Explicit luminance bands and RGBA offsets define the tonal integration fixtures. */
import path from "node:path";
import sharp from "sharp";

const SIZE = 32;
const CHANNELS = 4;
const OPAQUE = 255;
const HALF_ALPHA = 128;
const EDGE = 8;
const BAND_WIDTH = 4;

export async function createTonalFixtures(directory: string) {
  const images: Record<string, string> = {};

  for (const [name, levels] of Object.entries({
    dark: [4, 16, 28, 40],
    bright: [216, 228, 240, 252],
    subtle: [112, 116, 120, 124],
    hidden: [4, 16, 28, 40],
    weighted: [4, 16, 28, 40],
  })) {
    const data = Buffer.alloc(SIZE * SIZE * CHANNELS);

    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const offset = (y * SIZE + x) * CHANNELS;
        const inside = x >= EDGE && x < SIZE - EDGE && y >= EDGE && y < SIZE - EDGE;
        const luminance = inside ? levels[Math.floor((x - EDGE) / BAND_WIDTH)] : name === "hidden" ? OPAQUE : 0;
        data[offset] = luminance;
        data[offset + 1] = luminance;
        data[offset + 2] = luminance;
        data[offset + 3] = inside ? (name === "weighted" && x < SIZE / 2 ? 8 : y < SIZE / 2 ? OPAQUE : HALF_ALPHA) : 0;
      }
    }

    images[name] = path.join(directory, `tone-${name}.png`);
    await sharp(data, { raw: { width: SIZE, height: SIZE, channels: CHANNELS } })
      .png()
      .toFile(images[name]);
  }

  return images;
}
