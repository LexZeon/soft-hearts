/**
 * I-072 (docs/claude/2026-11-10-i072-music-overhaul.md): the scenes the music overhaul is judged on, all synthetic (program-made
 * PCM; no real song, show or recording). Each goes through the same path as production: PCM → the capture's two analysers (the
 * smoothed levels and the unsmoothed onset counters, tests/helpers/listen-audio.ts `analyserSamples`) → ~30 Hz samples → the fast
 * "is it music" layer (src/stage/music-likeness.ts). `judge` returns the numbers the record and the tests use: how often she
 * stopped, the longest stop, the share judged music.
 */
import { MusicLikeness, type MusicVerdictFlip } from '../../src/stage/music-likeness';
import type { MusicEnergySample } from '../../src/stage/music-dance';
import { RATE, ambientPad, analyserSamples, concat, drumSong, level, mix, rng, seconds, speechLike, type AnalyserOptions } from './listen-audio';

const midi = (note: number) => 440 * Math.pow(2, (note - 69) / 12);

/**
 * A sustained sung line: legato vowels (one to four beats each, a soft consonant at each note), vibrato in pitch (±1.5 % at about
 * 5.5 Hz) and a little in loudness (`tremoloDb`), a breath of ~0.3 s every two bars. What a held lyric line looks like to the
 * analyser: long, steady, shallow ripples; unlike speech, which dips between every syllable.
 * With lyrics: a word on every note instead: shorter notes (half a beat to two beats), each after a short consonant gap (40–80 ms of
 * no voice and a burst), the way a quick lyric line is sung. Still on the beat grid and still held between the gaps.
 */
export function sungLine(s: number, options: { bpm?: number; seed?: number; pitch?: number; tremoloDb?: number; lyrics?: boolean } = {}): Float32Array {
  const bpm = options.bpm ?? 100, beat = 60 / bpm, random = rng(options.seed ?? 31), out = seconds(s), base = options.pitch ?? 64;
  const tremolo = Math.pow(10, (options.tremoloDb ?? 2) / 20) - 1, scale = [0, 2, 4, 5, 7, 9, 12];
  let b = 0, phase = 0;
  while (b * beat < s) {
    const barBeat = b % 8;
    if (barBeat >= 7.5) { b = (Math.floor(b / 8) + 1) * 8; continue; } // a breath (half a beat) before the next two bars
    const lengths = options.lyrics ? [0.5, 0.5, 1, 1, 1.5, 2] : [1, 2, 2, 3, 4];
    const beats = Math.min(lengths[Math.floor(random() * lengths.length)]!, 7.5 - barBeat), gap = options.lyrics ? Math.round((0.04 + random() * 0.04) * RATE) : 0;
    const start = Math.round(b * beat * RATE) + gap, n0 = Math.round(beats * beat * RATE) - gap;
    const f0n = midi(base + scale[Math.floor(random() * scale.length)]!), f1 = 450 + random() * 350, f2 = 1100 + random() * 1000;
    const rate = 5 + random(), depth = 0.012 + random() * 0.006;
    for (let n = 0; n < Math.round(0.025 * RATE) && start + n < out.length; n++) out[start + n]! += (random() * 2 - 1) * (options.lyrics ? 0.04 : 0.015);
    for (let n = 0; n < n0 && start + n < out.length; n++) {
      const t = n / RATE, env = Math.min(1, n / (0.06 * RATE), (n0 - n) / (0.05 * RATE));
      const f0 = f0n * (1 + depth * Math.sin(2 * Math.PI * rate * t));
      phase += 2 * Math.PI * f0 / RATE;
      let v = 0;
      for (let h = 1; h <= 14; h++) { const f = f0 * h; v += Math.sin(phase * h) * (1 / (1 + ((f - f1) / 120) ** 2) + 0.6 / (1 + ((f - f2) / 200) ** 2)) / Math.sqrt(h); }
      out[start + n]! += v * env * 0.05 * (1 + tremolo * Math.sin(2 * Math.PI * rate * t));
    }
    b += beats;
  }
  return level(out, 0.1);
}

export const dBFS = (db: number) => Math.pow(10, db / 20);

export interface Scene {
  name: string;
  pcm: Float32Array;
  /** Seconds where the song (as opposed to dialogue) ends, when the scene has one. */
  songEnds?: number;
  /** Seconds where the drums come back after a break, when the scene has one. */
  drumsBack?: number;
  /** What it should be: a song throughout, dialogue throughout, a song then dialogue, or a song, a silence (an expected stop) and the song again. */
  kind: 'song' | 'dialogue' | 'song-then-dialogue' | 'song-silence-song';
}

/** The eight scenes of the task (I-072), and a ninth for the tempo prior (the same song back after a silence). */
export function scenes(): Scene[] {
  const bpm = 100;
  const song = (s: number, seed = 41) => drumSong(s, { bpm, seed });
  return [
    { name: '鼓点歌 + 持续人声（颤音，人声比伴奏响 4 dB）', kind: 'song', pcm: mix(song(40), sungLine(40, { bpm, seed: 42 }), 4) },
    { name: '伴奏很轻的主歌（伴奏比人声低 18 dB）', kind: 'song',
      pcm: mix(sungLine(40, { bpm, seed: 43, lyrics: true }), mix(ambientPad(40, { seed: 44 }), song(40), -4), -18) },
    { name: '歌里 8 秒清唱（一字一音）', kind: 'song', pcm: concat(song(14), sungLine(8, { bpm, seed: 45, lyrics: true }), song(14, 46)) },
    { name: '纯对白', kind: 'dialogue', pcm: speechLike(40, { seed: 47 }) },
    { name: '安静鼓点上的对白（鼓低 12 dB）', kind: 'dialogue', pcm: mix(speechLike(40, { seed: 48 }), song(40, 49), -12) },
    { name: '歌放完接对白', kind: 'song-then-dialogue', songEnds: 15, pcm: concat(song(15, 50), speechLike(30, { seed: 51 })) },
    { name: '间奏（8 秒铺底）后鼓点回来', kind: 'song', drumsBack: 22, pcm: concat(song(14, 52), ambientPad(8, { seed: 53 }), song(14, 54)) },
    { name: '很轻的段落（8 秒铺底，约 -52 dBFS）', kind: 'song', pcm: concat(song(14, 55), level(ambientPad(8, { seed: 56 }), dBFS(-52)), song(14, 57)) },
    { name: '安静 4.5 秒后同一首歌回来', kind: 'song-silence-song', drumsBack: 18.5, pcm: concat(song(14, 58), seconds(4.5), song(14, 59)) },
  ];
}

export interface Judged {
  name: string;
  /** Seconds until first judged music (null: never). */
  first: number | null;
  /** After the first recognition (and before songEnds), how often it flipped to "not music", and the longest such stretch (s). */
  stops: number;
  longestOffS: number;
  /** Share of all samples judged music. */
  share: number;
  /** song-then-dialogue: seconds after songEnds until it is not music (and whether it came back after). */
  endAfterS: number | null;
  cameBack: boolean;
  /** drumsBack: seconds until the beat part was ≥ 0.5 again, counted only if it had fallen under 0.3 in the break (null otherwise). */
  beatBackS: number | null;
  /** song-silence-song: seconds after drumsBack until it was music again. */
  backOnS: number | null;
  flips: (MusicVerdictFlip & { t: number })[];
}

export function samplesOf(pcm: Float32Array, options: AnalyserOptions = {}): MusicEnergySample[] {
  return analyserSamples(pcm, { offset: 1000, ...options });
}

export function judge(scene: Scene, options: AnalyserOptions = {}): Judged {
  const samples = samplesOf(scene.pcm, options), m = new MusicLikeness();
  const flips: Judged['flips'] = [], verdicts: { t: number; music: boolean }[] = [];
  let first: number | null = null, beatBackS: number | null = null, backOnS: number | null = null, fell = false;
  for (const sample of samples) {
    m.update(sample);
    const t = sample.time - 1000;
    verdicts.push({ t, music: m.music });
    for (const flip of m.takeFlips()) flips.push({ ...flip, t });
    if (m.music && first === null) first = t;
    if (scene.drumsBack !== undefined) {
      const beat = m.getState().last.beat;
      if (t > scene.drumsBack - 3 && t <= scene.drumsBack && beat < 0.3) fell = true;
      if (fell && beatBackS === null && t > scene.drumsBack && beat >= 0.5) beatBackS = t - scene.drumsBack;
      if (backOnS === null && t > scene.drumsBack && m.music) backOnS = t - scene.drumsBack;
    }
  }
  // A song with an expected stop (the silence) counts its stops only from the song's return on.
  const until = scene.songEnds ?? Infinity, from = scene.kind === 'song-silence-song' ? scene.drumsBack! + (backOnS ?? 0) : -Infinity;
  let stops = 0, longestOffS = 0, run = 0;
  for (let i = 1; i < verdicts.length; i++) {
    const v = verdicts[i]!, dt = v.t - verdicts[i - 1]!.t;
    if (first === null || v.t <= first || v.t > until || v.t <= from) continue;
    if (!v.music) { if (run === 0) stops++; run += dt; longestOffS = Math.max(longestOffS, run); } else run = 0;
  }
  let endAfterS: number | null = null, cameBack = false;
  if (scene.songEnds !== undefined) {
    const off = verdicts.find(v => v.t > scene.songEnds! && !v.music);
    endAfterS = off ? off.t - scene.songEnds : null;
    cameBack = !!off && verdicts.some(v => v.t > off.t && v.music);
  }
  return { name: scene.name, first, stops, longestOffS, share: verdicts.filter(v => v.music).length / Math.max(1, verdicts.length), endAfterS, cameBack, beatBackS, backOnS: scene.kind === 'song-silence-song' ? backOnS : null, flips };
}

/** One line per scene for the record. */
export function describe(j: Judged): string {
  const f = (v: number | null) => v === null ? '—' : v.toFixed(1);
  return `${j.name}: 首次 ${f(j.first)} s · 停 ${j.stops} 次 · 最长断 ${j.longestOffS.toFixed(1)} s · 是音乐 ${(j.share * 100).toFixed(0)}%`
    + (j.endAfterS !== null || j.name.includes('对白') && j.endAfterS === null && j.share > 0 ? ` · 对白后 ${f(j.endAfterS)} s 停${j.cameBack ? '（又回来）' : ''}` : '')
    + (j.beatBackS !== null ? ` · 鼓点回来 ${f(j.beatBackS)} s 拍子分回到 0.5` : '')
    + (j.backOnS !== null ? ` · 歌回来 ${f(j.backOnS)} s 又认出是音乐` : '');
}

// ---------------------------------------------------------------- round 2 (Codex T-234): structure that is music but looks like dialogue

/** Mid-band chord carrier (320/480/640/800 Hz) at rms 0.12; `pump` dips its envelope every beat (side-chain pumping, 0.03 + 0.97 * phase^1.8). */
export function midCarrier(s: number, bpm: number, pump: boolean): Float32Array {
  const out = new Float32Array(Math.round(s * RATE)), beat = 60 / bpm;
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE, phase = (t % beat) / beat, env = pump ? 0.03 + 0.97 * Math.pow(phase, 1.8) : 1;
    out[i] = env * (Math.sin(2 * Math.PI * 320 * t) + 0.7 * Math.sin(2 * Math.PI * 480 * t) + 0.5 * Math.sin(2 * Math.PI * 640 * t) + 0.3 * Math.sin(2 * Math.PI * 800 * t));
  }
  return level(out, 0.12);
}

/** Short (0.14 s) formant-like syllables at rms 0.1, starting every 0.25 s (on an eighth-note grid at 120 BPM) or at irregular intervals. */
export function shortSyllables(s: number, onGrid: boolean): Float32Array {
  const out = new Float32Array(Math.round(s * RATE)), random = rng(81);
  const gaps = onGrid ? [0.25] : [0.19, 0.37, 0.16, 0.42, 0.23, 0.28, 0.51, 0.17];
  let time = 0.25, k = 0;
  while (time + 0.14 < s) {
    const f0 = [140, 156, 130, 175][k % 4]!, at = Math.round(time * RATE), length = Math.round(0.14 * RATE);
    for (let n = 0; n < length && at + n < out.length; n++) {
      const t = n / RATE, env = Math.pow(Math.sin(Math.PI * n / length), 0.65);
      let v = 0;
      for (let h = 1; h <= 14; h++) { const hz = f0 * h; v += Math.sin(2 * Math.PI * hz * t) * (Math.exp(-(((hz - 650) / 420) ** 2)) + 0.5 * Math.exp(-(((hz - 1600) / 600) ** 2))) / h; }
      out[at + n] += env * v + (t < 0.025 ? (random() * 2 - 1) * 0.1 * (1 - t / 0.025) : 0);
    }
    time += gaps[k % gaps.length]!; k++;
  }
  return level(out, 0.1);
}

/** The round-2 cases: Codex's two misses, their controls, and the dialogue controls (all 16 s at 120 BPM over `drumSong` seed 11 at -12 dB unless noted). */
export function round2Cases(): { name: string; music: boolean; pcm: Float32Array }[] {
  const s = 16, drums = drumSong(s, { bpm: 120, seed: 11, chords: true });
  return [
    { name: 'EDM 平直中频（对照）', music: true, pcm: mix(midCarrier(s, 120, false), drums, -12) },
    { name: 'EDM 抽吸（每拍中频压下去再回来）', music: true, pcm: mix(midCarrier(s, 120, true), drums, -12) },
    { name: '说唱：0.14 秒的字严格起在 0.25 秒格上', music: true, pcm: mix(shortSyllables(s, true), drums, -12) },
    { name: '不规则的短字（对照）', music: false, pcm: mix(shortSyllables(s, false), drums, -12) },
    { name: '纯对白（对照）', music: false, pcm: speechLike(s, { seed: 5, pitch: 140, rate: 1 }) },
    { name: '对白 + 鼓 -24 dB（对照）', music: false, pcm: mix(speechLike(s, { seed: 5, pitch: 140, rate: 1 }), drums, -24) },
    { name: '对白 + 鼓 -12 dB（对照）', music: false, pcm: mix(speechLike(s, { seed: 5, pitch: 140, rate: 1 }), drums, -12) },
  ];
}

/** Share of the samples from `fromS` on that were judged music, and the last look's numbers. */
export function tailShare(pcm: Float32Array, options: AnalyserOptions = {}, fromS = 8): { share: number; beat: number; speech: number; score: number } {
  const m = new MusicLikeness();
  let n = 0, on = 0;
  for (const sample of samplesOf(pcm, options)) { m.update(sample); if (sample.time - 1000 >= fromS) { n++; if (m.music) on++; } }
  const state = m.getState();
  return { share: on / Math.max(1, n), beat: state.last.beat, speech: state.last.speech, score: state.score };
}

// ---------------------------------------------------------------- I-077: songs with sections (intro → verse → chorus → bridge → chorus → outro)

/** One section of a structured song: where it is (s) and what it is. */
export interface SongSection { name: 'intro' | 'verse' | 'chorus' | 'bridge' | 'outro'; from: number; to: number }
export interface StructuredSong { name: string; pcm: Float32Array; bpm: number; sections: SongSection[]; /** Bar starts (s), the true downbeats. */ bars: number[] }
export type SongKind = 'pop' | 'bright' | 'dark' | 'ambient';

function tone(out: Float32Array, at: number, seconds: number, hz: number, amp: number, attack: number, decay: number, partials: number, release = 0.05): void {
  const start = Math.round(at * RATE), n = Math.round(seconds * RATE), a = Math.max(1, attack * RATE), r = Math.max(1, release * RATE);
  for (let i = 0; i < n && start + i < out.length; i++) {
    if (start + i < 0) continue;
    const t = i / RATE, env = Math.min(1, i / a, (n - i) / r) * (decay > 0 ? Math.exp(-t / decay) : 1);
    let v = 0;
    for (let p = 1; p <= partials; p++) v += Math.sin(2 * Math.PI * hz * p * t) / (p * p);
    out[start + i]! += v * amp * env;
  }
}
function hit(out: Float32Array, at: number, kind: 'kick' | 'snare' | 'hat' | 'open' | 'crash', gain: number, random: () => number): void {
  const start = Math.round(at * RATE);
  const length = kind === 'kick' ? 0.18 : kind === 'snare' ? 0.16 : kind === 'hat' ? 0.05 : kind === 'open' ? 0.22 : 1.4;
  let prev = 0;
  for (let i = 0; i < length * RATE && start + i < out.length; i++) {
    const t = i / RATE;
    if (kind === 'kick') { const f = 50 + 90 * Math.exp(-t * 30); out[start + i]! += Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 18) * 0.55 * gain; continue; }
    const w = random() * 2 - 1, hp = w - prev; prev = w;
    if (kind === 'snare') out[start + i]! += (w * 0.6 + Math.sin(2 * Math.PI * 190 * t) * 0.4) * Math.exp(-t * 25) * 0.35 * gain;
    else out[start + i]! += hp * Math.exp(-t * (kind === 'hat' ? 80 : kind === 'open' ? 14 : 2.5)) * (kind === 'crash' ? 0.12 : 0.08) * gain;
  }
}

/**
 * A synthetic song with sections (no real recording). Bars of four beats; the sections differ the way songs do: the intro is soft
 * (pads, a light hi-hat), the verse adds kick, snare and bass, the chorus is louder, denser and brighter (kick on every beat, open
 * hats, a crash and fuller chords), the bridge drops the drums, the outro fades. `kind`:
 *  - pop: 100 BPM, mixed tone;
 *  - bright: 128 BPM, plucked arpeggios (fast decay), sixteenth hats, no pads: plucky and bright;
 *  - dark: 72 BPM, low sustained pads and a soft kick on the bar only: slow, dark, sustained;
 *  - ambient: pads only, no drums (no beat to lock on): sections change by swells.
 */
export function structuredSong(kind: SongKind = 'pop', seed = 77, variant: { tempo?: number; transpose?: number } = {}): StructuredSong {
  // I-077 step 2: `tempo` (a factor) and `transpose` (semitones) make a near-duplicate of the same song: a sped-up version, a cover in another key.
  const bpm = (kind === 'bright' ? 128 : kind === 'dark' ? 72 : kind === 'ambient' ? 80 : 100) * (variant.tempo ?? 1), shift = variant.transpose ?? 0, beat = 60 / bpm, bar = 4 * beat, random = rng(seed);
  const plan: [SongSection['name'], number][] = kind === 'dark' || kind === 'ambient'
    ? [['intro', 2], ['verse', 6], ['chorus', 6], ['bridge', 4], ['chorus', 4], ['outro', 2]]
    : [['intro', 4], ['verse', 8], ['chorus', 8], ['bridge', 4], ['chorus', 8], ['outro', 4]];
  const sections: SongSection[] = [], bars: number[] = [];
  let at = 0;
  for (const [name, count] of plan) { sections.push({ name, from: at, to: at + count * bar }); for (let b = 0; b < count; b++) bars.push(at + b * bar); at += count * bar; }
  const out = seconds(at + 0.5);
  const progression = (kind === 'dark' ? [[45, 52, 57], [41, 48, 53], [43, 50, 55], [40, 47, 52]] : [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]).map(chord => chord.map(note => note + shift));
  const scale = [0, 3, 5, 7, 10, 12, 15];
  bars.forEach((start, index) => {
    const section = sections.find(s => start >= s.from - 1e-9 && start < s.to - 1e-9)!, name = section.name, chord = progression[index % 4]!;
    const fade = name === 'outro' ? 1 - (start - section.from) / (section.to - section.from) * 0.7 : 1;
    const loud = (name === 'chorus' ? 1.8 : name === 'verse' ? 1 : name === 'bridge' ? 0.55 : 0.5) * fade;
    const drums = kind !== 'ambient' && (name === 'verse' || name === 'chorus' || (kind !== 'dark' && name === 'intro'));
    // Pads (not in the bright song), fuller in the chorus.
    if (kind !== 'bright') for (const note of name === 'chorus' ? [...chord, chord[0]! + 12, chord[1]! + 12] : chord)
      tone(out, start, bar + 0.4, midi(note), (kind === 'dark' || kind === 'ambient' ? 0.06 : 0.035) * loud, 0.35, 0, kind === 'dark' ? 2 : 4, 0.4);
    for (let b = 0; b < 4; b++) {
      const t = start + b * beat;
      if (drums && kind === 'dark') { if (b === 0) hit(out, t, 'kick', 0.7 * loud, random); }
      else if (drums && name === 'intro') { hit(out, t, 'hat', 0.6, random); }
      else if (drums) {
        if (name === 'chorus' || b % 2 === 0) hit(out, t, 'kick', loud, random);
        if (b % 2 === 1) hit(out, t, 'snare', loud, random);
        const per = kind === 'bright' ? 4 : 2;
        for (let k = 0; k < per; k++) hit(out, t + k * beat / per, name === 'chorus' && k === per / 2 ? 'open' : 'hat', name === 'chorus' ? 1.5 : 0.8, random);
        if (name === 'chorus' && b === 0) hit(out, t, 'crash', 1, random);
      }
      // Bass on the beat (verse and chorus), plucked arpeggio in the bright song.
      if (kind !== 'ambient' && (name === 'verse' || name === 'chorus')) tone(out, t, beat * 0.9, midi(chord[0]! - 24), 0.2 * loud, 0.01, kind === 'dark' ? 0 : 0.4, 3);
      if (kind === 'bright' && name !== 'outro') for (let k = 0; k < 2; k++)
        tone(out, t + k * beat / 2, beat / 2, midi(chord[0]! + 12 + scale[Math.floor(random() * scale.length)]!), 0.06 * Math.max(0.7, loud), 0.003, 0.07, 8);
    }
  });
  return { name: kind, pcm: level(out, 0.12), bpm, sections, bars };
}
