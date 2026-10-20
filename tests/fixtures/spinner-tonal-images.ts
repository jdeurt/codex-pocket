import path from "node:path";
import sharp from "sharp";

export const TONAL_BANDS = {
  dark: { shadow: 4, low: 16, high: 28, highlight: 40 },
  bright: { shadow: 216, low: 228, high: 240, highlight: 252 },
  subtle: { shadow: 112, low: 116, high: 120, highlight: 124 },
};
const ALPHA_CHANNEL = 3;
const WEIGHTED_ALPHA = 8;

const SIZE = 32;
const CHANNELS = 4;
const OPAQUE = 255;
const HALF_ALPHA = 128;
const EDGE = 8;
const BAND_WIDTH = 4;

export async function createTonalFixtures(directory: string) {
  const images: Record<string, string> = {};

  for (const [name, bands] of Object.entries({
    ...TONAL_BANDS,
    hidden: TONAL_BANDS.dark,
    weighted: TONAL_BANDS.dark,
  })) {
    const levels = Object.values(bands);
    const data = Buffer.alloc(SIZE * SIZE * CHANNELS);

    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const offset = (y * SIZE + x) * CHANNELS;
        const inside = x >= EDGE && x < SIZE - EDGE && y >= EDGE && y < SIZE - EDGE;
        const luminance = inside ? levels[Math.floor((x - EDGE) / BAND_WIDTH)] : name === "hidden" ? OPAQUE : 0;

        data[offset] = luminance;
        data[offset + 1] = luminance;
        data[offset + 2] = luminance;
        data[offset + ALPHA_CHANNEL] = inside
          ? name === "weighted" && x < SIZE / 2
            ? WEIGHTED_ALPHA
            : y < SIZE / 2
              ? OPAQUE
              : HALF_ALPHA
          : 0;
      }
    }

    images[name] = path.join(directory, `tone-${name}.png`);
    await sharp(data, { raw: { width: SIZE, height: SIZE, channels: CHANNELS } })
      .png()
      .toFile(images[name]);
  }

  return images;
}
