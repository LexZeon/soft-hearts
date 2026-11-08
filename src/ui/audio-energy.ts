import type { AudioDanceSample } from '../../shared/audio-dance';

const unit = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
/** Consumes only the current analyser frame; retains no audio samples. */
export function audioEnergy(samples: Float32Array, spectrum: Float32Array, rate: number, time: number): AudioDanceSample {
  let power = 0;
  for (const value of samples) if (Number.isFinite(value)) power += value * value;
  const band = (from: number, to: number) => {
    const step = rate / samples.length;
    if (!Number.isFinite(step) || step <= 0) return 0;
    let sum = 0;
    for (let bin = Math.max(1, Math.ceil(from / step)); bin < spectrum.length && bin * step < to; bin++) {
      const amplitude = Number.isFinite(spectrum[bin]) ? Math.pow(10, spectrum[bin] / 20) : 0;
      sum += amplitude * amplitude;
    }
    return unit(Math.sqrt(sum));
  };
  return { time, rms: samples.length ? unit(Math.sqrt(power / samples.length)) : 0,
    low: band(40, 180), mid: band(180, 2000), high: band(2000, 8000) };
}
