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

/**
Selects visible band luminance or the hidden-background fixture value.
@param x - Horizontal pixel coordinate.
@param name - Tonal fixture identity.
@param levels - Ordered shadow-to-highlight luminance bands.
@param isInside - Whether this pixel belongs to the visible center.
@returns Unchanged grayscale byte value for this pixel.
*/
function pixelLuminance(x: number, name: string, levels: number[], isInside: boolean) {
  if (isInside) {
    return levels[Math.floor((x - EDGE) / BAND_WIDTH)];
  }

  return name === "hidden" ? OPAQUE : 0;
}

/**
Selects opacity for visible, hidden-background and low-weight tonal samples.
@param name - Tonal fixture identity.
@param x - Horizontal pixel coordinate.
@param y - Vertical pixel coordinate.
@param isInside - Whether this pixel belongs to the visible center.
@returns Original alpha byte for this sample.
*/
function pixelAlpha(name: string, x: number, y: number, isInside: boolean) {
  if (!isInside) {
    return 0;
  }

  if (name === "weighted" && x < SIZE / 2) {
    return WEIGHTED_ALPHA;
  }

  return y < SIZE / 2 ? OPAQUE : HALF_ALPHA;
}

/**
Writes real PNG fixtures containing known luminance bands and alpha-weighted regions.
@param directory - Private integration directory receiving generated raster inputs.
@returns Paths keyed by tonal fixture identity after all PNG writes complete.
*/
export async function createTonalFixtures(directory: string) {
  const images: Record<string, string> = {};
  const samples = { ...TONAL_BANDS, hidden: TONAL_BANDS.dark, weighted: TONAL_BANDS.dark };

  for (const [name, bands] of Object.entries(samples)) {
    const levels = Object.values(bands);
    const data = Buffer.alloc(SIZE * SIZE * CHANNELS);

    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const offset = (y * SIZE + x) * CHANNELS;
        const isInside = x >= EDGE && x < SIZE - EDGE && y >= EDGE && y < SIZE - EDGE;
        const luminance = pixelLuminance(x, name, levels, isInside);

        data[offset] = luminance;
        data[offset + 1] = luminance;
        data[offset + 2] = luminance;
        data[offset + ALPHA_CHANNEL] = pixelAlpha(name, x, y, isInside);
      }
    }

    images[name] = path.join(directory, `tone-${name}.png`);
    await sharp(data, { raw: { width: SIZE, height: SIZE, channels: CHANNELS } })
      .png()
      .toFile(images[name]);
  }

  return images;
}
