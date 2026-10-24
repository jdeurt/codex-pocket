const BAR_WIDTH = 4.5;
const GAP = 4;
const MIN_HALF = 1.5;
const HALF = 2;
const ENVELOPE_POWER = 2.45;
const HEIGHT_RATIO = 0.42;
const LOW_FREQUENCY = 80;
const FREQUENCY_RATIO = 100;
const BYTE_MAX = 255;
const LEVEL_POWER = 1.5;
const ATTACK = 0.45;
const RELEASE = 0.13;

export interface SpectrumLevel {
  input: number;
  output: number;
}
export interface SpectrumSample {
  bytes: Uint8Array;
  binWidth: number;
}
export interface SpectrumBounds {
  width: number;
  height: number;
  inset: number;
  radius: number;
}
export interface SpectrumBar {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Allocate an independent silent frequency level.
@returns Silent input and output.
*/
function silentLevel(): SpectrumLevel {
  return { input: 0, output: 0 };
}

/** Count whole bars that fit at the fixed width and spacing.
@param width - Available canvas width in CSS pixels.
@returns Nonnegative number of complete bars.
*/
export function spectrumCount(width: number) {
  return Math.max(0, Math.floor((width + GAP) / (BAR_WIDTH + GAP)));
}

/** Allocate initial immutable spectrum values.
@param width - Available canvas width in CSS pixels.
@returns Silent levels in frequency order.
*/
export function silentSpectrum(width: number) {
  return Array.from({ length: spectrumCount(width) }, silentLevel);
}

/** Read one logarithmic frequency band's peak from a detached sample.
@param sample - Bytes and frequency represented by each bin.
@param index - Logarithmic band index.
@param count - Number of visible frequency bands.
@returns Normalized perceptual intensity.
*/
function intensity(sample: SpectrumSample, index: number, count: number) {
  const low = LOW_FREQUENCY * FREQUENCY_RATIO ** (index / count);
  const high = LOW_FREQUENCY * FREQUENCY_RATIO ** ((index + 1) / count);
  const from = Math.min(sample.bytes.length - 1, Math.floor(low / sample.binWidth));
  const to = Math.min(sample.bytes.length, Math.max(from + 1, Math.ceil(high / sample.binWidth)));

  let peak = 0;

  for (let bin = from; bin < to; bin++) {
    peak = Math.max(peak, sample.bytes[bin]);
  }

  return (peak / BYTE_MAX) ** LEVEL_POWER;
}

/** Smooth a target with separate attack and release response.
@param previous - Previous level.
@param target - New sampled level.
@returns Next smoothed level.
*/
function smoothed(previous: number, target: number) {
  return previous + (target - previous) * (target > previous ? ATTACK : RELEASE);
}

/** Project one band from explicit samples.
@param input - Microphone sample.
@param output - Agent sample.
@param count - Number of visible frequency bands.
@param level - Previous band level.
@param index - Frequency band.
@returns New smoothed levels.
*/
function sampledLevel(
  input: SpectrumSample,
  output: SpectrumSample,
  count: number,
  level: SpectrumLevel,
  index: number
) {
  return {
    input: smoothed(level.input, intensity(input, index, count)),
    output: smoothed(level.output, intensity(output, index, count)),
  };
}

/** Advance spectrum values without mutating prior levels or input samples.
@param previous - Previous frequency levels.
@param input - Microphone sample.
@param output - Agent sample.
@param width - Available canvas width in CSS pixels.
@returns New frequency levels.
*/
export function sampledSpectrum(
  previous: readonly SpectrumLevel[],
  input: SpectrumSample,
  output: SpectrumSample,
  width: number
) {
  const levels = previous.length === spectrumCount(width) ? previous : silentSpectrum(width);

  return Array.from(levels, sampledLevel.bind(undefined, input, output, levels.length));
}

/** Compute one bar within the composer's capsule envelope.
@param bounds - Explicit measured geometry.
@param index - Visual bar index.
@param level - Smoothed level.
@returns Rectangle for native canvas rendering.
*/
function spectrumBar(bounds: SpectrumBounds, index: number, level: number): SpectrumBar {
  const width = BAR_WIDTH;
  const x = index * (width + GAP);
  const distance = Math.min(bounds.inset + x, bounds.inset + bounds.width - x - width);
  const capsule = distance >= bounds.radius ? 1 : Math.sqrt(1 - (1 - Math.max(0, distance) / bounds.radius) ** HALF);
  const half = (MIN_HALF + level * bounds.height * HEIGHT_RATIO) * capsule ** ENVELOPE_POWER;

  return { x, y: bounds.height / HALF - half, width, height: half * HALF };
}

/** Project one input/output pair with reversed agent ordering.
@param bounds - Explicit measured geometry.
@param count - Number of visible bars.
@param level - Smoothed levels.
@param index - Frequency band.
@returns Paired native rectangles.
*/
function pairedBars(bounds: SpectrumBounds, count: number, level: SpectrumLevel, index: number) {
  return {
    input: spectrumBar(bounds, index, level.input),
    output: spectrumBar(bounds, count - 1 - index, level.output),
  };
}

/** Project input and reversed agent levels onto measured canvas geometry.
@param levels - Current smoothed samples.
@param bounds - Explicit measured geometry.
@returns Paired rectangles in compositing order.
*/
export function spectrumBars(levels: readonly SpectrumLevel[], bounds: SpectrumBounds) {
  return Array.from(levels, pairedBars.bind(undefined, bounds, levels.length));
}
