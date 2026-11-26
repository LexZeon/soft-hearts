/**
 * I-077: one song through the same path as the stage (synthetic PCM → the capture's analysers → ~30 Hz samples → the music layer and
 * the reaction director), on a display clock of `fps` frames a second. Returns the director's ledger, per-frame shapes and tints.
 * Step 2 adds the song memory: with `memory`, the run does what the stage does (an intro's fingerprint is looked up and the answer
 * handed back, a finished song is learned), and records the looks, the recognitions and the learned plays.
 */
import { MusicLikeness } from '../../src/stage/music-likeness';
import { MusicReact, type MusicReactContext } from '../../src/stage/music-react/director';
import { NEUTRAL_DISPOSITIONS, NEUTRAL_TEMPER, type DispositionTemper, type HormoneTemper } from '../../src/voice/speech-face/choose';
import type { MusicEnergySample } from '../../src/stage/music-dance';
import type { MusicTaste } from '../../shared/foundation/character-card';
import type { SongMemory, SongSketch } from '../../shared/senses/song-memory';

export interface ReactRunOptions {
  fps?: number; seed?: number; temper?: Partial<HormoneTemper>; dispositions?: Partial<DispositionTemper>; on?: boolean; moving?: boolean; tail?: number;
  /** Step 2: her music taste. */
  taste?: MusicTaste | null;
  /** Step 2: a song memory (the stage's look-up and learning, done synchronously). */
  memory?: SongMemory;
  /** Step 2: the day number the memory learns on. */
  day?: number;
  /** Step 2: also record how much she likes the song at each frame (getState allocates; off by default). */
  trackLike?: boolean;
}
export interface ReactRun {
  react: MusicReact;
  frames: { t: number; like?: number; music: boolean; shape: { sway: number; bounce: number; nod: number; slow: number; headX: number; headZ: number }; tint: { smileEyes: number; lidSoft: number } }[];
  faces: { t: number; id: string; slider: string; amp: number }[];
  moments: { t: number; intent: string; scale: number }[];
  /** Step 2: the intro fingerprints looked up (t, the sketch, the id found or null), and the plays learned. */
  looks: { t: number; sketch: SongSketch; found: string | null }[];
  learned: { t: number; sketch: SongSketch; id: string; plays: number }[];
  /** Microseconds per sample spent in the director's hearing (the new per-sample work). */
  usPerSample: number;
}

export function runReact(samples: readonly MusicEnergySample[], options: ReactRunOptions = {}, react = new MusicReact(undefined, options.seed ?? 0x1077)): ReactRun {
  const fps = options.fps ?? 60, likeness = new MusicLikeness(), base = samples[0]?.time ?? 0;
  const temper: HormoneTemper = { ...NEUTRAL_TEMPER, ...options.temper }, dispositions = { ...NEUTRAL_DISPOSITIONS, ...options.dispositions };
  const end = (samples.at(-1)?.time ?? base) - base + (options.tail ?? 4);
  const run: ReactRun = { react, frames: [], faces: [], moments: [], looks: [], learned: [], usPerSample: 0 };
  let index = 0, hearNs = 0n, heard = 0;
  for (let frame = 1; frame / fps <= end; frame++) {
    const t = frame / fps;
    while (index < samples.length && samples[index]!.time - base <= t) {
      const sample = samples[index++]!;
      likeness.update(sample);
      const t0 = process.hrtime.bigint(); react.hear(sample); hearNs += process.hrtime.bigint() - t0; heard++;
    }
    const state = likeness.music ? likeness.getState() : null;
    const ctx: MusicReactContext = { on: options.on ?? true, music: likeness.music, moving: options.moving ?? true, speaking: false, temper, dispositions,
      period: state?.features?.period ?? 0, beatScore: state?.last.beat ?? 0, ...(options.taste !== undefined ? { taste: options.taste } : {}), memory: !!options.memory };
    const out = react.frame(1 / fps, ctx);
    run.frames.push({ t, ...(options.trackLike ? { like: react.getState().like } : {}), music: likeness.music, shape: { ...out.shape }, tint: { ...out.tint } });
    for (const face of out.face) run.faces.push({ t, id: face.id, slider: face.slider, amp: face.amp });
    out.moments.forEach((intent, i) => run.moments.push({ t, intent, scale: out.scales[i] ?? 1 }));
    const memory = options.memory;
    if (memory && out.ask) {
      const sketch = out.ask, found = memory.match(sketch);
      run.looks.push({ t, sketch, found: found?.id ?? null });
      if (found) react.recognized(out.askToken, found.id);
    }
    if (memory && out.learn) { const learned = memory.learn(out.learn, options.day ?? 20000); run.learned.push({ t, sketch: out.learn, ...learned }); }
  }
  run.usPerSample = heard ? Number(hearNs) / 1000 / heard : 0;
  return run;
}

/**
 * `plays` plays of one song one after the other, as the capture would send them: the song's own samples (they should start and end in
 * silence) repeated with the time moved on and the onset counters continued, each play with its own display jitter if `again` is given.
 */
export function repeatPlays(play: (index: number) => readonly MusicEnergySample[], plays: number): MusicEnergySample[] {
  const out: MusicEnergySample[] = [];
  let timeOffset = 0, counterOffset: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < plays; k++) {
    const part = play(k), first = part[0]!, last = part.at(-1)!;
    const shift = timeOffset - first.time + (k ? 1 / 30 : 0);
    for (const s of part) {
      const copy: MusicEnergySample = { ...s, time: s.time + shift };
      if (s.onsetLow !== undefined) { copy.onsetLow = (s.onsetLow + counterOffset[0]) % 4096; copy.onsetMid = ((s.onsetMid ?? 0) + counterOffset[1]) % 4096; copy.onsetHigh = ((s.onsetHigh ?? 0) + counterOffset[2]) % 4096; }
      out.push(copy);
    }
    timeOffset = last.time + shift;
    if (last.onsetLow !== undefined) counterOffset = [(counterOffset[0] + last.onsetLow) % 4096, (counterOffset[1] + (last.onsetMid ?? 0)) % 4096, (counterOffset[2] + (last.onsetHigh ?? 0)) % 4096];
  }
  return out;
}
