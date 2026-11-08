/**
 * I-016 A (docs/claude/2026-11-03-listen-kind.md): "is it music", the fast layer (src/stage/music-likeness.ts), on synthetic sound
 * only (tests/helpers/listen-audio.ts: program-made songs, drumless pads, speech-like syllables, laughter, noise; turned into the
 * capture's own samples by the same analyser maths as src/ui/SystemAudio.ts). The SAPI-voice evaluation is
 * scripts/listen-kind/eval.ts; numbers in the record.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LIKENESS_MIN_SOUND_S, LIKENESS_MUSIC_OFF, LIKENESS_MUSIC_ON, MusicLikeness, likenessLine, likenessScore, type LikenessFeatures,
} from '../src/stage/music-likeness';
import type { MusicEnergySample } from '../src/stage/music-dance';
import { ambientPad, analyserSamples, concat, drumSong, laughter, mix, noise, seconds, speechLike, sungVocal } from './helpers/listen-audio';

interface Run { first: number | null; share: number; after: (from: number) => number; verdicts: { t: number; music: boolean; score: number }[] }
/** Feeds the samples; returns when it first said music, and the share of time it said music (overall and after a moment). */
function listen(samples: readonly MusicEnergySample[], m = new MusicLikeness()): Run {
  const verdicts: Run['verdicts'] = [];
  const start = samples[0]?.time ?? 0;
  let first: number | null = null;
  for (const sample of samples) {
    m.update(sample);
    verdicts.push({ t: sample.time - start, music: m.music, score: m.score });
    if (m.music && first === null) first = sample.time - start;
  }
  const after = (from: number) => { const tail = verdicts.filter(v => v.t >= from); return tail.filter(v => v.music).length / Math.max(1, tail.length); };
  return { first, share: after(0), after, verdicts };
}
const of = (pcm: Float32Array, options: Parameters<typeof analyserSamples>[1] = {}) => analyserSamples(pcm, { offset: 1000, ...options });

test('songs with drums are recognized within a few seconds, at any tempo, with or without a sung line', () => {
  const songs: [string, Float32Array][] = [
    ['84 BPM', drumSong(24, { bpm: 84, seed: 1 })], ['112 BPM', drumSong(24, { bpm: 112, seed: 2 })], ['140 BPM, swung', drumSong(24, { bpm: 140, seed: 3, swing: 0.08 })],
    ['100 BPM + a sung line at 0 dB', mix(drumSong(24, { bpm: 100, seed: 4 }), sungVocal(24, { bpm: 100, seed: 5 }), 0)],
    ['90 BPM + a sung line 3 dB above', mix(drumSong(24, { bpm: 90, seed: 6 }), sungVocal(24, { bpm: 90, seed: 7 }), 3)],
  ];
  for (const [name, pcm] of songs) {
    const run = listen(of(pcm));
    assert.ok(run.first !== null && run.first <= 6, `${name}: recognized after ${run.first} s`);
    assert.ok(run.after(8) >= 0.85, `${name}: and stays music (${run.after(8).toFixed(2)} of the time after 8 s)`);
  }
});

test('a song without drums (pads and a soft melody, or a sung ballad) is recognized from its sustained, slowly changing sound', () => {
  for (const [name, pcm] of [['pads, 4 s chords', ambientPad(30, { seed: 1 })], ['pads, 2 s chords', ambientPad(30, { seed: 2, chordS: 2 })],
    ['pads, no melody', ambientPad(30, { seed: 3, melody: false })], ['ballad: pads + a sung line', mix(ambientPad(30, { seed: 4 }), sungVocal(30, { bpm: 72, seed: 5 }), -2)]] as const) {
    const run = listen(of(pcm));
    assert.ok(run.first !== null && run.first <= 12, `${name}: recognized after ${run.first} s`);
    assert.ok(run.after(14) >= 0.7, `${name}: mostly music after 14 s (${run.after(14).toFixed(2)})`);
  }
});

test('speech, laughter, steady noise, clicks and silence are never music', () => {
  const cases: [string, Float32Array][] = [
    ['speech-like syllables', speechLike(40, { seed: 1 })], ['faster, higher speech', speechLike(40, { seed: 2, pitch: 220, rate: 1.3 })],
    ['slow, low speech', speechLike(40, { seed: 3, pitch: 100, rate: 0.8 })], ['two voices taking turns', concat(speechLike(15, { seed: 4 }), speechLike(15, { seed: 5, pitch: 210 }), speechLike(10, { seed: 6 }))],
    ['laughter', laughter(20)], ['steady noise', noise(30, 1, 0.05)], ['quiet noise floor', noise(30, 2, 0.006)], ['silence', seconds(20)],
  ];
  // Clicks: a short tick every second (a clock, typing), loud enough to be sound.
  const clicks = seconds(20); for (let s = 0.5; s < 20; s += 1) for (let n = 0; n < 400; n++) clicks[Math.round(s * 48_000) + n] = Math.sin(n / 3) * Math.exp(-n / 80) * 0.5;
  cases.push(['clicks once a second', clicks]);
  for (const [name, pcm] of cases) assert.equal(listen(of(pcm)).first, null, name);
});

test('dialogue over quiet background music is not music; the same speech over a loud beat (rap-like) is', () => {
  const words = speechLike(40, { seed: 7 });
  assert.equal(listen(of(mix(words, ambientPad(40, { seed: 8 }), -12))).first, null, 'over pads, 12 dB under');
  assert.equal(listen(of(mix(words, ambientPad(40, { seed: 8 }), -6))).first, null, 'over pads, 6 dB under');
  assert.ok(listen(of(mix(words, drumSong(40, { bpm: 100, seed: 9 }), -12))).share < 0.1, 'over drums, 12 dB under');
  assert.ok(listen(of(mix(drumSong(40, { bpm: 100, seed: 9 }), words, -2))).after(10) > 0.6, 'a voice over a beat as loud as it: music');
});

test('a show: the opening song is music, the dialogue after it stops being music within a few seconds and stays so', () => {
  const opening = drumSong(15, { bpm: 120, seed: 10 }), dialogue = mix(speechLike(30, { seed: 11 }), ambientPad(30, { seed: 12 }), -15);
  const run = listen(of(concat(opening, dialogue)));
  assert.ok(run.first !== null && run.first < 6, `the opening song: music after ${run.first} s`);
  const off = run.verdicts.find(v => v.t > 15 && !v.music)?.t ?? Infinity;
  assert.ok(off - 15 <= 4, `the dialogue: not music ${(off - 15).toFixed(1)} s after it began`);
  assert.ok(run.verdicts.filter(v => v.t > 20).every(v => !v.music), 'and stays not music through the dialogue');
});

test('the verdict has hysteresis: a short break inside a song does not end it; a new song after silence is recognized again', () => {
  const song = drumSong(12, { bpm: 110, seed: 13 });
  const run = listen(of(concat(song, seconds(0.8), song)));
  assert.ok(run.first !== null && run.first < 6);
  assert.ok(run.verdicts.filter(v => v.t > 8 && v.t < 18).every(v => v.music), 'a 0.8 s break keeps the song');
  const two = listen(of(concat(song, seconds(6), drumSong(12, { bpm: 92, seed: 14 }))));
  assert.ok(two.verdicts.some(v => v.t > 13 && v.t < 17 && !v.music), 'six seconds of silence ends it');
  assert.ok(two.verdicts.filter(v => v.t > 25).every(v => v.music), 'the next song is music again');
  assert.ok(LIKENESS_MUSIC_OFF < LIKENESS_MUSIC_ON);
});

test('robust to how the capture delivers samples: 144 Hz or 30 Hz displays, jitter, dropped frames', () => {
  const pcm = drumSong(20, { bpm: 104, seed: 15 }), words = speechLike(20, { seed: 16 });
  for (const options of [{ refreshHz: 144, jitterMs: 3 }, { refreshHz: 30, jitterMs: 4 }, { refreshHz: 50, jitterMs: 8 }]) {
    const run = listen(of(pcm, options));
    assert.ok(run.first !== null && run.first <= 7, `${JSON.stringify(options)}: ${run.first}`);
    assert.equal(listen(of(words, options)).first, null, `${JSON.stringify(options)}: speech`);
  }
  // Every third sample lost.
  const lossy = of(pcm).filter((_, i) => i % 3 !== 2);
  assert.ok(listen(lossy).first !== null);
});

test('time going back, a long gap or a bad sample start over (not music), and reset() clears it', () => {
  const m = new MusicLikeness(), samples = of(drumSong(10, { bpm: 120, seed: 17 }));
  for (const sample of samples) m.update(sample);
  assert.equal(m.music, true);
  m.update({ ...samples[0]!, time: samples[0]!.time - 5 });
  assert.equal(m.music, false, 'the clock went back');
  for (const sample of samples) m.update(sample);
  assert.equal(m.music, true);
  m.update({ ...samples.at(-1)!, time: samples.at(-1)!.time + 10 });
  assert.equal(m.music, false, 'a gap of seconds');
  for (const sample of samples) m.update({ ...sample, time: sample.time + 20 });
  m.update({ ...samples[0]!, time: Number.NaN });
  assert.equal(m.music, false, 'a sample without a time');
  for (const sample of samples) m.update({ ...sample, time: sample.time + 40 });
  m.reset();
  assert.deepEqual([m.music, m.score, m.getState().features], [false, 0, null]);
  // Garbage values never throw or make music.
  for (let i = 0; i < 300; i++) m.update({ time: 100 + i / 30, rms: Number.NaN, low: Infinity, mid: -1, high: 2 });
  assert.equal(m.music, false);
});

test('the score: nothing decided below the minimum of sound; each part is 0..1; the developer line names them', () => {
  const quiet: LikenessFeatures = { soundS: LIKENESS_MIN_SOUND_S - 0.1, beatPeak: 1, period: 0.5, periodStable: 1, gridLock: 1, ioiCv: 0, slowPeak: 1, dipShare: 0, flutter: 1, swing: 6, tilt: -20, onsetRate: 2, recentDips: 0 };
  assert.deepEqual(likenessScore(quiet), { score: 0, beat: 0, sustain: 0, speech: 0 });
  const beat = likenessScore({ ...quiet, soundS: 8 });
  assert.ok(beat.score > 0.9 && beat.beat > 0.9);
  const spoken = likenessScore({ ...quiet, soundS: 8, dipShare: 0.4, flutter: 5 });
  assert.equal(spoken.score, 0, 'deep dips and flutter: speech wins over any beat');
  for (const value of Object.values(likenessScore({ ...quiet, soundS: 8, beatPeak: 0.4, gridLock: 0.7, periodStable: 0.5, dipShare: 0.1, flutter: 2.5 }))) assert.ok(value >= 0 && value <= 1);
  const m = new MusicLikeness();
  assert.equal(likenessLine(m.getState()), '像音乐 0.00（声音不够，先不判断）→ 不是音乐');
  for (const sample of of(drumSong(8, { bpm: 120, seed: 18 }))) m.update(sample);
  assert.match(likenessLine(m.getState()), /^像音乐 0\.\d\d（节拍 \d\.\d\d（周期 \d\.\d\d s，稳 \d\.\d\d，对齐 \d\.\d\d） · 持续 \d\.\d\d · 像说话 \d\.\d\d）→ 认出是音乐$/);
  assert.equal(likenessLine(undefined), '像音乐：还没收到声音');
});
