/**
 * I-072 (docs/claude/2026-11-10-i072-music-overhaul.md): the overhaul of "is it music". Synthetic sound only (tests/helpers/music-fixtures.ts): PCM → the capture's two
 * analysers (smoothed levels + unsmoothed onset counters) → ~30 Hz samples → src/stage/music-likeness.ts, at 60 and 30 Hz displays.
 *  1. the scenes: singing never turns a remembered song off; dialogue (also over a quiet beat) is never music; a song then dialogue
 *     ends in about 7 s; a soft passage is not silence; the same song after a break or a silence is taken back in 1–2 s;
 *  2. the onset counters: what the unsmoothed analyser adds, how repeats and drops in the sample path are absorbed;
 *  3. the host boundary: a sample with counters passes the IPC check only whole and in range;
 *  4. speech vs singing as numbers.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ONSET_WRAP, OnsetFlux, onsetDelta } from '../shared/senses/music-detect/onset';
import { parseAudioDanceFrame, type AudioDanceFrame } from '../shared/senses/audio-dance';
import { MUSIC_DETECT_KNOBS } from '../shared/senses/music-detect/knobs';
import { AudioDanceFusion } from '../src/senses/audio-dance-fusion';
import { MusicLikeness, heldVoice, likenessScore, syllabicVoice, type LikenessFeatures } from '../src/stage/music-likeness';
import type { MusicEnergySample } from '../src/stage/music-dance';
import { ambientPad, analyserSamples, drumSong, level, mix, rng, speechLike } from './helpers/listen-audio';
import { dBFS, describe, judge, scenes } from './helpers/music-fixtures';

// ---------------------------------------------------------------- 1. the scenes

for (const refreshHz of [60, 30]) {
  test(`the eight scenes (and the song back after a silence) at a ${refreshHz} Hz display`, t => {
    for (const scene of scenes()) {
      const j = judge(scene, { refreshHz });
      t.diagnostic(describe(j));
      if (scene.kind === 'dialogue') { assert.equal(j.first, null, `${scene.name}: never music`); continue; }
      assert.ok(j.first !== null && j.first <= 4, `${scene.name}: recognized after ${j.first} s`);
      assert.equal(j.stops, 0, `${scene.name}: never stops once recognized (longest ${j.longestOffS.toFixed(1)} s)`);
      if (scene.kind === 'song-then-dialogue') {
        assert.ok(j.endAfterS !== null && j.endAfterS >= 4 && j.endAfterS <= 8, `${scene.name}: the dialogue stops counting after ${j.endAfterS} s (about 7)`);
        assert.equal(j.cameBack, false, `${scene.name}: and does not come back`);
      }
      if (scene.kind === 'song-silence-song') assert.ok(j.backOnS !== null && j.backOnS <= 2, `${scene.name}: music again ${j.backOnS} s after it returns`);
    }
  });
}

test('a soft passage counts as sound only for a song already remembered: alone it is still silence', () => {
  const soft = level(ambientPad(20, { seed: 61 }), dBFS(-52));
  const m = new MusicLikeness();
  for (const sample of analyserSamples(soft, { offset: 1000 })) m.update(sample);
  assert.equal(m.music, false);
  assert.equal(m.getState().features?.soundS ?? 0, 0, 'under the usual -48 dBFS line nothing is heard when no song is remembered');
  assert.ok(MUSIC_DETECT_KNOBS.quiet.rememberedRms < 0.004 && MUSIC_DETECT_KNOBS.quiet.rememberedRms >= 0.0005);
});

// ---------------------------------------------------------------- 2. the onset counters

function dbFrame(fill: (bin: number) => number): Float32Array { return Float32Array.from({ length: 1024 }, (_, bin) => fill(bin)); }

test('the unsmoothed flux: a steady tone adds nothing, a hit adds its rise in its band, the counters wrap', () => {
  const flux = new OnsetFlux(), hz = 48_000 / 2048;
  const tone = dbFrame(bin => bin === 20 ? -10 : -90);
  flux.push(tone, hz); flux.push(tone, hz); flux.push(tone, hz);
  assert.deepEqual(flux.counters, { onsetLow: 0, onsetMid: 0, onsetHigh: 0 }, 'a held note is no onset');
  // A kick: the low bins (40–180 Hz ≈ bins 2–7) jump by 30 dB.
  flux.push(dbFrame(bin => bin === 20 ? -10 : bin >= 2 && bin <= 7 ? -20 : -90), hz);
  const after = flux.counters;
  assert.ok(after.onsetLow > 20, `the low band rose ${after.onsetLow.toFixed(1)}`);
  assert.ok(after.onsetMid < 1 && after.onsetHigh === 0, 'the other bands barely');
  // Non-finite bins (Web Audio gives -Infinity for silence) are the floor, never NaN.
  flux.push(dbFrame(() => -Infinity), hz); flux.push(dbFrame(() => Number.NaN), hz);
  for (const value of Object.values(flux.counters)) assert.ok(Number.isFinite(value) && value >= 0 && value < ONSET_WRAP);
  assert.equal(onsetDelta(5, ONSET_WRAP - 3), 8, 'wrap-aware difference');
  assert.ok(Number.isNaN(onsetDelta(undefined, 3)) && Number.isNaN(onsetDelta(3, -1)) && Number.isNaN(onsetDelta(ONSET_WRAP, 0)));
});

/**
 * As the samples travel to the stage: the host drops one still in flight (every `dropEvery`-th), they arrive 2–25 ms late, and the companion
 * window's own display frames (`petHz`, ±2 ms) read the latest one through the real AudioDanceFusion, re-timed to the frame: so some
 * are read twice (same counters) and some never.
 */
function throughFusion(samples: readonly MusicEnergySample[], dropEvery: number, petHz: number, seed = 5): MusicEnergySample[] {
  const random = rng(seed), fusion = new AudioDanceFusion(), out: MusicEnergySample[] = [];
  const arriving = samples.filter((_, i) => i % dropEvery !== dropEvery - 1).map(sample => ({ sample, at: sample.time * 1000 + 2 + random() * 23 }));
  let next = 0;
  for (let frame = Math.ceil(arriving[0]!.at * petHz / 1000); ; frame++) {
    const now = frame * 1000 / petHz + (random() * 2 - 1) * 2;
    if (next >= arriving.length) break;
    while (next < arriving.length && arriving[next]!.at <= now) { fusion.push('system-audio', arriving[next]!.sample, now); next++; }
    const read = fusion.read(now);
    if (read) out.push(read.sample);
  }
  return out;
}

test('repeats and drops on the way to the stage neither add nor lose drum hits: a song is still a song, dialogue over a beat still not', () => {
  const song = analyserSamples(drumSong(20, { bpm: 104, seed: 62 }), { offset: 1000 });
  const talk = analyserSamples(mix(speechLike(30, { seed: 63 }), drumSong(30, { bpm: 96, seed: 64 }), -12), { offset: 1000 });
  for (const [drop, petHz] of [[1e9, 60], [5, 60], [5, 30], [3, 144]] as const) {
    const m = new MusicLikeness(); let first: number | null = null;
    for (const sample of throughFusion(song, drop, petHz)) { m.update(sample); if (m.music && first === null) first = sample.time - 1000; }
    // Losing every third sample is far more than the host ever drops (only a sample still in flight): later, but still recognized.
    assert.ok(first !== null && first <= (drop === 3 ? 7 : 4), `drop 1/${drop}, pet at ${petHz} Hz: recognized after ${first} s`);
    const d = new MusicLikeness();
    for (const sample of throughFusion(talk, drop, petHz)) { d.update(sample); assert.equal(d.music, false, `drop 1/${drop}, pet at ${petHz} Hz: dialogue`); }
  }
  // The microphone path (levels only, no counters) still works the old way.
  const mic = new MusicLikeness(); let first: number | null = null;
  for (const sample of analyserSamples(drumSong(20, { bpm: 104, seed: 62 }), { offset: 1000, onsets: false })) { mic.update(sample); if (mic.music && first === null) first = sample.time - 1000; }
  assert.ok(first !== null && first <= 6, `levels only: recognized after ${first} s`);
});

test('frames sitting right on the edges of the 30 Hz bins (a 30 Hz display in phase with them) no longer smear the beat', () => {
  const pcm = drumSong(16, { bpm: 100, seed: 41 });
  for (const offset of [1000, 1000 + 1 / 60, 1000.004]) {
    const m = new MusicLikeness(); let first: number | null = null;
    for (const sample of analyserSamples(pcm, { offset, refreshHz: 30, jitterMs: 2 })) { m.update(sample); if (m.music && first === null) first = sample.time - offset; }
    assert.ok(first !== null && first <= 3, `phase ${(offset - 1000).toFixed(3)}: recognized after ${first} s`);
  }
});

// ---------------------------------------------------------------- 3. the host boundary

test('the IPC check: levels alone or levels with all three counters in range pass; anything else is dropped', () => {
  const levels = { time: 1, rms: 0.2, low: 0.1, mid: 0.05, high: 0.01 };
  const frame = (sample: unknown): unknown => ({ id: 'capture', source: 'system-audio', revision: 1, sample });
  assert.deepEqual(parseAudioDanceFrame(frame(levels))?.sample, levels);
  const counted = { ...levels, onsetLow: 12.5, onsetMid: 0, onsetHigh: ONSET_WRAP - 0.5 };
  assert.deepEqual(parseAudioDanceFrame(frame(counted))?.sample, counted);
  for (const [why, sample] of [
    ['only two counters', { ...levels, onsetLow: 1, onsetMid: 2 }], ['a counter at the wrap', { ...counted, onsetMid: ONSET_WRAP }],
    ['a negative counter', { ...counted, onsetLow: -1 }], ['NaN', { ...counted, onsetHigh: Number.NaN }], ['Infinity', { ...counted, onsetHigh: Infinity }],
    ['a string', { ...counted, onsetLow: '3' }], ['an unknown key instead of a counter', { ...levels, onsetLow: 1, onsetMid: 2, pcm: 3 }],
    ['a ninth key', { ...counted, extra: 1 }], ['a getter', Object.defineProperty({ ...levels, onsetMid: 1, onsetHigh: 1 }, 'onsetLow', { enumerable: true, get() { throw Error('must not run'); } })],
  ] as const) assert.equal(parseAudioDanceFrame(frame(sample)), null, why);
  // The companion window's fusion hands the counters on with the levels (re-timed, as before).
  const fusion = new AudioDanceFusion();
  fusion.push('system-audio', counted, 0);
  const out = fusion.read(100)!;
  assert.deepEqual({ ...out.sample, time: 1 }, counted);
  assert.equal(out.sample.time, 0.1);
  const typed: AudioDanceFrame = { id: 'x', source: 'microphone', revision: 0, sample: levels };
  assert.ok(parseAudioDanceFrame(typed), 'the microphone keeps sending levels only');
});

// ---------------------------------------------------------------- 4. speech vs singing as numbers

test('a held voice (sung) cancels the dips and flutter as speech; a voice rising and falling syllable by syllable off the beat is speech', () => {
  const base: LikenessFeatures = { soundS: 8, beatPeak: 0.8, period: 0.6, periodStable: 1, gridLock: 0.9, ioiCv: 0.1, slowPeak: 0.2, dipShare: 0.3, flutter: 3, swing: 6, tilt: -10, onsetRate: 2, recentDips: 1, tempoMatch: 0 };
  assert.ok(likenessScore(base).speech > 0.9, 'without the new numbers: as before, dips and flutter are speech');
  const sung = likenessScore({ ...base, steadyShare: 0.7, midLock: 0.85 });
  assert.equal(heldVoice({ steadyShare: 0.7 }), 1);
  assert.ok(sung.speech < 0.05 && sung.score > 0.9, `held notes over a beat: speech ${sung.speech.toFixed(2)}, score ${sung.score.toFixed(2)}`);
  const spoken = likenessScore({ ...base, dipShare: 0, flutter: 1.5, recentDips: 0, steadyShare: 0.2, midLock: 0.55 });
  assert.ok(syllabicVoice({ steadyShare: 0.2, midLock: 0.55 }) > 0.9);
  assert.ok(spoken.speech > 0.9 && spoken.score < 0.1, 'words over a quiet beat that fills the dips: still speech');
  assert.equal(syllabicVoice({ steadyShare: 0.2, midLock: 0.95 }), 0, 'syllables right on the beat (rap, a sung lyric) are not dialogue by this');
  assert.equal(syllabicVoice({}), 0); assert.equal(heldVoice({}), 0);
});
