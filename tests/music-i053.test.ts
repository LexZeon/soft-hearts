/**
 * I-053 (docs/claude/2026-11-08-i053-music.md): she no longer stops in the middle of a song. Synthetic sound only
 * (tests/helpers/listen-audio.ts: program-made songs, speech-like syllables, pads, silence).
 *  1. the experience journal's verdict flips (numbers and a closed reason only);
 *  2. song memory: voice-only stretches, quiet bridges and short silences do not end a song that has been music for a while;
 *  3. beat re-acquisition: the last song's tempo coming back is taken again within about 2 s;
 *  4. A: the energy of the song adds to the wish to move, at most the knob, and mood still matters.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { MUSIC_DETECT_KNOBS } from '../shared/senses/music-detect/knobs';
import { MUSIC_OFF_REASONS } from '../shared/senses/music-detect/verdict';
import { buildJournalEntry, describeJournalEntry, readJournalLine, type JournalEntry } from '../shared/memory/journal';
import { JournalExtras } from '../electron/memory/journal/extras';
import { moodLabelDanceDesire, type DanceDesireInput } from '../shared/senses/music-desire';
import { ENGLISH_UI_COPY } from '../shared/foundation/ui-copy.en';
import { MusicLikeness, type MusicVerdictFlip } from '../src/stage/music-likeness';
import type { MusicEnergySample } from '../src/stage/music-dance';
import { ambientPad, analyserSamples, concat, drumSong, mix, seconds, speechLike, sungVocal } from './helpers/listen-audio';

const OFFSET = 1000;
const of = (pcm: Float32Array) => analyserSamples(pcm, { offset: OFFSET });
interface Run { first: number | null; verdicts: { t: number; music: boolean }[]; flips: (MusicVerdictFlip & { t: number })[]; energy: number }
function listen(samples: readonly MusicEnergySample[]): Run {
  const m = new MusicLikeness(), verdicts: Run['verdicts'] = [], flips: Run['flips'] = [];
  let first: number | null = null, energy = 0;
  for (const sample of samples) {
    m.update(sample);
    const t = sample.time - OFFSET;
    verdicts.push({ t, music: m.music });
    for (const flip of m.takeFlips()) flips.push({ ...flip, t });
    if (m.music && first === null) first = t;
    if (m.music) energy = m.songEnergy;
  }
  return { first, verdicts, flips, energy };
}
/** Seconds the verdict said "not music" between two times. */
function offSeconds(run: Run, from: number, to: number): number {
  let off = 0;
  for (let i = 1; i < run.verdicts.length; i++) { const v = run.verdicts[i]!; if (v.t > from && v.t <= to && !v.music) off += v.t - run.verdicts[i - 1]!.t; }
  return off;
}
const song = (s: number, bpm = 110, seed = 21) => drumSong(s, { bpm, seed });

test('a voice-only stretch (2.5 s, 4 s) inside a song, or a drumless bridge, does not end the music', () => {
  const stretches: [string, Float32Array][] = [
    ['2.5 s of speech', speechLike(2.5, { seed: 5 })], ['4 s of speech', speechLike(4, { seed: 5 })],
    ['2.5 s of a sung line', sungVocal(2.5, { bpm: 110, seed: 6 })], ['4 s of a sung line', sungVocal(4, { bpm: 110, seed: 6 })],
    ['an 8 s bridge of pads', ambientPad(8, { seed: 3 })], ['an 8 s quiet bridge', ambientPad(8, { seed: 3 }).map(x => x * 0.1)],
    ['2 s of silence', seconds(2)],
  ];
  for (const [name, stretch] of stretches) {
    const run = listen(of(concat(song(14), stretch, song(14))));
    assert.ok(run.first !== null && run.first < 6, `${name}: recognized first (${run.first})`);
    assert.equal(offSeconds(run, run.first!, 99), 0, `${name}: music throughout after the first recognition`);
  }
});

test('song memory ends: after 3 s of silence it is not music; the next song of the same tempo comes back within 2 s', () => {
  const run = listen(of(concat(song(14), seconds(5), song(14))));
  const off = run.flips.find(f => !f.music)!;
  assert.equal(off.reason, 'silence');
  assert.ok(off.t > 14 + 2.5 && off.t < 14 + 4.5, `off ${(off.t - 14).toFixed(1)} s into the silence`);
  const back = run.flips.find(f => f.music && f.t > off.t)!;
  assert.ok(back.t - 19 <= 2.2, `the same tempo is music again ${(back.t - 19).toFixed(1)} s after it returns`);
  // A different tempo is just a new song: recognized as usual, not by the memory.
  const other = listen(of(concat(song(14), seconds(5), song(14, 150, 33))));
  assert.ok(other.flips.some(f => f.music && f.t > 19), 'a new song is recognized');
});

test('dialogue after a song that has been music for a while: still music for a few seconds, then not (about 9 s at most), and it stays so', () => {
  const opening = song(15, 120, 10), dialogue = mix(speechLike(30, { seed: 11 }), ambientPad(30, { seed: 12 }), -15);
  const run = listen(of(concat(opening, dialogue)));
  const off = run.flips.find(f => !f.music)!;
  assert.ok(off.t - 15 <= 9.5, `the dialogue stops counting ${(off.t - 15).toFixed(1)} s after it began`);
  assert.equal(off.reason, 'memory-ended');
  assert.ok(run.verdicts.filter(v => v.t > off.t).every(v => !v.music), 'and stays not music through the dialogue (no re-acquisition of the old tempo)');
  // An opening shorter than the memory (6 s) has no memory: dialogue after it stops counting quickly, as before.
  const brief = listen(of(concat(song(6, 120, 10), dialogue)));
  const briefOff = brief.flips.find(f => !f.music)!;
  assert.ok(briefOff.t - 6 <= 5, `a short opening: not music ${(briefOff.t - 6).toFixed(1)} s after the dialogue began`);
  assert.notEqual(briefOff.reason, 'memory-ended');
});

test('speech, laughter-like noise and silence are still never music, and dialogue over a quiet beat is not music (with the 4 s beat window)', () => {
  const words = speechLike(40, { seed: 7 });
  for (const [name, pcm] of [['speech', words], ['two voices', concat(speechLike(15, { seed: 4 }), speechLike(15, { seed: 5, pitch: 210 }))],
    ['over pads', mix(words, ambientPad(40, { seed: 8 }), -12)]] as const)
    assert.equal(listen(of(pcm)).first, null, name);
});

test('the verdict flips are numbers and a closed reason; the energy of the song follows its beat', () => {
  const run = listen(of(concat(song(14, 140, 3), seconds(5))));
  assert.equal(run.flips.length, 2);
  const on = run.flips[0]!, off = run.flips[1]!;
  assert.equal(on.music, true); assert.equal(on.reason, undefined);
  assert.equal(off.music, false); assert.ok(MUSIC_OFF_REASONS.includes(off.reason!));
  for (const flip of run.flips) for (const key of ['score', 'beat', 'speech'] as const) assert.ok(flip[key] >= 0 && flip[key] <= 1, key);
  assert.ok(on.soundS > 0 && on.soundS <= 8.01);
  // Energy: a strong fast beat is higher than a slow, softer one; nothing while it is not music.
  const fast = listen(of(song(24, 140, 3))).energy, slow = listen(of(song(24, 76, 4))).energy;
  assert.ok(fast > slow + 0.1, `fast ${fast.toFixed(2)} vs slow ${slow.toFixed(2)}`);
  assert.ok(fast <= 1 && slow >= 0);
  const m = new MusicLikeness(); assert.equal(m.songEnergy, 0);
  // Stopping the capture while it is music tells the journal once, with its own reason.
  const stopping = new MusicLikeness();
  for (const sample of of(song(10, 110, 21))) stopping.update(sample);
  stopping.takeFlips(); stopping.reset();
  assert.deepEqual(stopping.takeFlips().map(f => [f.music, f.reason]), [[false, 'capture-stopped']]);
});

test('the four constants the user fixed are as they were', async () => {
  const text = await import('node:fs').then(fs => fs.readFileSync(new URL('../src/stage/music-likeness.ts', import.meta.url), 'utf8'));
  for (const [name, value] of [['LIKENESS_MUSIC_ON', '0.47'], ['LIKENESS_MUSIC_OFF', '0.35'], ['LIKENESS_OFF_HOLD_S', '1'], ['LIKENESS_FADE_HOLD_S', '3']])
    assert.match(text, new RegExp(`export const ${name} = ${value.replace('.', '\\.')};`), name);
});

// ---------------------------------------------------------------- 4A: the dance wish

const mood = (label: string, songEnergy?: number): DanceDesireInput => ({ playfulWeight: 1, cautiousWeight: 1, playfulIntensity: 50, mood: label, fatigue: { phase: 'awake', F: 0.3 }, activity: 'company', heardSeconds: 30, request: 0, ...(songEnergy === undefined ? {} : { songEnergy }) });

test('an energetic song adds up to the knob to her wish to move; a calm her still only nods to a slow one; asleep stays 0', () => {
  const cap = MUSIC_DETECT_KNOBS.songEnergyMaxBonus;
  assert.equal(cap, 0.1);
  const none = moodLabelDanceDesire(mood('calm')).score, slow = moodLabelDanceDesire(mood('calm', 0)).score, lively = moodLabelDanceDesire(mood('calm', 1)).score;
  assert.equal(none, slow, 'no energy given: no effect');
  assert.ok(Math.abs(lively - slow - cap) < 1e-9, 'at most the cap');
  assert.equal(moodLabelDanceDesire(mood('calm', 5)).score, lively, 'beyond 1 is capped');
  assert.equal(moodLabelDanceDesire(mood('calm', -2)).score, slow, 'never takes away');
  assert.ok(moodLabelDanceDesire(mood('calm', 0.5)).score > slow && moodLabelDanceDesire(mood('calm', 0.5)).score < lively);
  assert.equal(moodLabelDanceDesire(mood('calm', 1)).tier, 'nod', 'calm + a lively song: still a nod');
  assert.equal(moodLabelDanceDesire(mood('close', 0)).tier, 'nod');
  const content = { ...mood('content', 1), playfulWeight: 1.2 };
  assert.equal(moodLabelDanceDesire({ ...content, songEnergy: 0 }).tier, 'nod');
  assert.equal(moodLabelDanceDesire(content).tier, 'dance', 'content + a lively song: dances; the same mood with a slow one nods');
  assert.equal(moodLabelDanceDesire({ ...mood('sad', 1) }).tier, 'none', 'mood still matters');
  const asleep = moodLabelDanceDesire({ ...mood('happy', 1), fatigue: { phase: 'asleep', sleeping: true } });
  assert.equal(asleep.score, 0); assert.equal(asleep.asleep, true);
  assert.ok(moodLabelDanceDesire({ ...mood('calm', 1), request: 1 }).score > lively, 'a request still adds');
  assert.ok(moodLabelDanceDesire({ ...mood('calm', 1), fatigue: { phase: 'drowsy', F: 0.8 } }).score < lively, 'drowsiness still costs');
});

// ---------------------------------------------------------------- 1. the journal line

const chinese = (source: string, ...values: readonly unknown[]) => source.replace(/\{(\d+)\}/g, (_m, i) => String(values[Number(i)]));
const english = (source: string, ...values: readonly unknown[]) => (ENGLISH_UI_COPY[source] ?? source).replace(/\{(\d+)\}/g, (_m, i) => String(values[Number(i)]));

test('the music-verdict line carries only numbers and closed reasons, reads back, and has English for each phrase', () => {
  const lines = [
    { type: 'music-verdict', characterId: 'gene', music: true, score: 0.62, beat: 0.8, speech: 0.1, soundS: 7.5 },
    ...MUSIC_OFF_REASONS.map(reason => ({ type: 'music-verdict', characterId: 'gene', music: false, score: 0.2, beat: 0.1, speech: 0.7, soundS: 6, why: reason })),
  ] as const;
  for (const input of lines) {
    const entry = buildJournalEntry(input as never, 1_000) as JournalEntry;
    assert.ok(entry, JSON.stringify(input));
    assert.deepEqual(readJournalLine(JSON.stringify(entry)), entry);
    const zh = describeJournalEntry(entry, chinese), en = describeJournalEntry(entry, english);
    assert.match(zh, /像音乐/);
    assert.doesNotMatch(en.replace(/^\d\d:\d\d /, ''), /[\u4e00-\u9fff]/, en);
  }
  const bad: unknown[] = [
    { type: 'music-verdict', characterId: 'gene', music: false, score: 0.2, beat: 0.1, speech: 0.7, soundS: 6 },
    { type: 'music-verdict', characterId: 'gene', music: false, score: 0.2, beat: 0.1, speech: 0.7, soundS: 6, why: 'Song Title - Artist' },
    { type: 'music-verdict', characterId: 'gene', music: 'yes', score: 0.2, beat: 0.1, speech: 0.7, soundS: 6 },
    { type: 'music-verdict', characterId: 'gene', music: true, score: 'high', beat: 0.1, speech: 0.7, soundS: 6 },
    { type: 'music-verdict', characterId: 'gene', music: true, score: 0.2, beat: 0.1, speech: 0.7, soundS: 6000 },
    { type: 'music-verdict', characterId: null, music: true, score: 0.2, beat: 0.1, speech: 0.7, soundS: 6 },
    { type: 'music-verdict', characterId: 'gene', music: true, score: Number.NaN, beat: 0.1, speech: 0.7, soundS: 6 },
  ];
  for (const input of bad) assert.equal(buildJournalEntry(input as never, 1), null, JSON.stringify(input));
  const sneaky = buildJournalEntry({ type: 'music-verdict', characterId: 'gene', music: true, score: 0.5, beat: 0.5, speech: 0, soundS: 3, title: 'SECRET-TITLE', lyrics: 'la la' } as never, 1)!;
  assert.doesNotMatch(JSON.stringify(sneaky), /SECRET-TITLE|la la/);
});

test('through the host: only the pet window may tell a verdict flip; malformed payloads are dropped; the switch decides', () => {
  const recorded: unknown[] = [];
  let on = true;
  const sink = { record: (input: never) => { if (!on) return null; const entry = buildJournalEntry(input, 1); if (entry) recorded.push(entry); return entry; }, accepting: () => on };
  const extras = new JournalExtras({ sink: sink as never, characterId: () => 'gene', engine: () => 'local', uptimeMs: () => 1, blushStage: () => {} });
  const flip = { music: false, score: 0.2, beat: 0.1, speech: 0.5, soundS: 6, reason: 'silence' };
  assert.equal(extras.fact('music-verdict', flip, false), false, 'not from another window');
  assert.equal(extras.fact('music-verdict', flip, true), true);
  assert.equal(extras.fact('music-verdict', { ...flip, reason: 'a song title' }, true), false);
  assert.equal(extras.fact('music-verdict', { ...flip, reason: undefined }, true), false);
  assert.equal(extras.fact('music-verdict', null, true), false);
  assert.equal(extras.fact('music-verdict', [flip], true), false);
  assert.equal(extras.fact('music-verdict', { music: true, score: 0.7, beat: 0.9, speech: 0, soundS: 4, reason: 'silence', extra: 'x' }, true), true);
  assert.equal((recorded.at(-1) as { why?: string }).why, undefined, 'a line for "music" has no reason');
  on = false;
  assert.equal(extras.fact('music-verdict', flip, true), false, 'off: nothing');
  assert.equal(recorded.length, 2);
});
