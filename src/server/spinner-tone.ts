import type { SpinnerTone } from "../lib/spinner";

// Pocket's dark palette: --background #212121, --muted-foreground #b4b4b4.
const BACKGROUND_BYTE = 33;
const FOREGROUND_BYTE = 180;
const CHANNEL_MAX = 255;
const BACKGROUND = BACKGROUND_BYTE / CHANNEL_MAX;
const FOREGROUND = FOREGROUND_BYTE / CHANNEL_MAX;
const RGBA_CHANNELS = 4;
const RED_LUMA = 0.2126;
const GREEN_LUMA = 0.7152;
const BLUE_LUMA = 0.0722;
const MEDIAN_PERCENTILE = 0.5;
const LOWER_PERCENTILE = 0.02;
const UPPER_PERCENTILE = 0.98;
const TARGET_SHADOW = 0.25;
const ENVELOPE_MARGIN = 0.1;
const MIN_CONTRAST = 0.5;
const MAX_CONTRAST = 2;
const PRECISION = 1_000_000;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const rounded = (value: number) => Math.round(value * PRECISION) / PRECISION;

function percentile(histogram: Float64Array, weight: number, fraction: number) {
  let sum = 0;

  for (const [value, element] of histogram.entries()) {
    sum += element;

    if (sum >= weight * fraction) {
      return value / CHANNEL_MAX;
    }
  }

  return 1;
}

export function spinnerTone(rgba: Buffer): SpinnerTone {
  const histogram = new Float64Array(CHANNEL_MAX + 1);
  let weight = 0;
  let minimum = 1;
  let maximum = 0;

  // Pool every decoded frame. Transparent RGB has no vote; partial alpha contributes proportionally.
  for (let pixel = 0; pixel < rgba.length; pixel += RGBA_CHANNELS) {
    const alpha = rgba[pixel + RGBA_CHANNELS - 1] / CHANNEL_MAX;

    if (alpha === 0) {
      continue;
    }

    const value = Math.round(RED_LUMA * rgba[pixel] + GREEN_LUMA * rgba[pixel + 1] + BLUE_LUMA * rgba[pixel + 2]);
    histogram[value] += alpha;
    weight += alpha;
    minimum = Math.min(minimum, value / CHANNEL_MAX);
    maximum = Math.max(maximum, value / CHANNEL_MAX);
  }

  if (weight === 0) {
    throw new Error("A spinner needs visible pixels.");
  }

  const paletteSpan = FOREGROUND - BACKGROUND;
  const targetLow = BACKGROUND + TARGET_SHADOW * paletteSpan;
  const targetSpan = FOREGROUND - targetLow;
  const targetCenter = (targetLow + FOREGROUND) / 2;
  const low = percentile(histogram, weight, LOWER_PERCENTILE);
  const high = percentile(histogram, weight, UPPER_PERCENTILE);
  const median = percentile(histogram, weight, MEDIAN_PERCENTILE);
  const envelopeLow = BACKGROUND + ENVELOPE_MARGIN * paletteSpan;
  const envelopeHigh = FOREGROUND + ENVELOPE_MARGIN * paletteSpan;
  const contrast = Math.min(
    clamp(targetSpan / Math.max(high - low, 1 / CHANNEL_MAX), MIN_CONTRAST, MAX_CONTRAST),
    (envelopeHigh - envelopeLow) / Math.max(maximum - minimum, 1 / CHANNEL_MAX)
  );
  // Preserve all visible extrema, including faint edges. No intermediate clipping or per-frame tuning.
  const brightness = clamp(
    targetCenter - contrast * median,
    envelopeLow - contrast * minimum,
    envelopeHigh - contrast * maximum
  );

  return { version: 1, contrast: rounded(contrast), brightness: rounded(brightness) };
}
