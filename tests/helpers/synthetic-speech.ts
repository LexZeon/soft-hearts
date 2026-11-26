/**
 * A crude, deterministic speech-like signal for voice-activity tests (I-099): a glottal pulse train (pitch gliding around
 * 150–220 Hz with a little jitter) through three formant resonators that move between vowel shapes, with syllable-rate
 * loudness (about 4 per second) and short gaps. Not a recording of anyone; good enough for a neural VAD to call it speech.
 */
const VOWELS: [number, number, number][] = [[730, 1090, 2440], [270, 2290, 3010], [300, 870, 2240], [530, 1840, 2480], [570, 840, 2410]];

/** `samples` at 16 kHz. */
export function syntheticSpeech(samples: number, seed = 1, rate = 16_000): Float32Array {
  let x = seed * 9301 + 49297;
  const random = () => { x = (x * 9301 + 49297) % 233280; return x / 233280; };
  const out = new Float32Array(samples);
  // Resonator state per formant.
  const y1 = [0, 0, 0], y2 = [0, 0, 0];
  let phase = 0;
  const syllable = Math.round(rate * 0.24);
  for (let n = 0; n < samples; n++) {
    const s = Math.floor(n / syllable), within = (n % syllable) / syllable;
    const vowel = VOWELS[(s * 3 + seed) % VOWELS.length], next = VOWELS[(s * 3 + seed + 1) % VOWELS.length];
    const pitch = 150 + 50 * Math.sin(2 * Math.PI * (n / rate) * 0.7 + seed) + (random() - 0.5) * 4;
    phase += pitch / rate;
    let source = 0;
    if (phase >= 1) { phase -= 1; source = 1; }
    source += (random() - 0.5) * 0.02; // breath
    let value = 0;
    for (let f = 0; f < 3; f++) {
      const freq = vowel[f] + (next[f] - vowel[f]) * within, bandwidth = 80 + f * 40;
      const r = Math.exp(-Math.PI * bandwidth / rate), theta = 2 * Math.PI * freq / rate;
      const y = (1 - r) * source + 2 * r * Math.cos(theta) * y1[f] - r * r * y2[f];
      y2[f] = y1[f]; y1[f] = y; value += y / (f + 1);
    }
    const envelope = within < 0.8 ? Math.sin(Math.PI * within / 0.8) : 0; // a short gap between syllables
    out[n] = value * envelope;
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let n = 0; n < samples; n++) out[n] = out[n] / peak * 0.3;
  return out;
}
