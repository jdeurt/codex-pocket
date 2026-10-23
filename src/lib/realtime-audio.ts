/* eslint-disable jsdoc/require-jsdoc, @typescript-eslint/no-magic-numbers -- PCM16 dimensions follow native realtime v2. */
const TARGET_RATE = 24_000;

export function pcm16(source: Float32Array, sourceRate: number) {
  const count = Math.max(1, Math.floor((source.length * TARGET_RATE) / sourceRate));
  const bytes = new Uint8Array(count * 2);
  const view = new DataView(bytes.buffer);

  for (let i = 0; i < count; i++) {
    const position = (i * sourceRate) / TARGET_RATE;
    const left = Math.min(source.length - 1, Math.floor(position));
    const right = Math.min(source.length - 1, left + 1);
    const sample = Math.max(-1, Math.min(1, source[left] + (source[right] - source[left]) * (position - left)));

    view.setInt16(i * 2, Math.round(sample * (sample < 0 ? 32_768 : 32_767)), true);
  }

  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }

  return { data: btoa(binary), sampleRate: TARGET_RATE, numChannels: 1, samplesPerChannel: count };
}

export function schedulePcm16(
  context: AudioContext,
  output: AnalyserNode,
  sources: Set<AudioBufferSourceNode>,
  outputTime: number,
  data: string
) {
  const binary = atob(data);
  const samples = new Float32Array(binary.length / 2);
  const at = Math.max(context.currentTime + 0.025, outputTime);

  // Refuse an overrun instead of dropping speech or letting queued audio diverge from the transcript.
  if (at + samples.length / TARGET_RATE - context.currentTime > 8) {
    throw new Error("Audio playback fell behind. Realtime stopped; start again to continue.");
  }

  for (let i = 0; i < samples.length; i++) {
    const word = (binary.codePointAt(i * 2) ?? 0) | ((binary.codePointAt(i * 2 + 1) ?? 0) << 8);

    samples[i] = (word & 0x80_00 ? word - 65_536 : word) / 32_768;
  }

  const buffer = context.createBuffer(1, samples.length, TARGET_RATE);

  buffer.copyToChannel(samples, 0);
  const source = context.createBufferSource();

  source.buffer = buffer;
  source.connect(output);
  sources.add(source);
  source.start(at);
  source.addEventListener("ended", () => {
    sources.delete(source);
    source.disconnect();
  });

  return at + buffer.duration;
}
