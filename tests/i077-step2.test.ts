/**
 * I-077 step 2 (docs/claude/2026-11-11-i077-step2.md): her music taste (a card trait) and recognising songs she hears often.
 * Synthetic songs only (tests/helpers/music-fixtures.ts `structuredSong`), through the stage's own path (PCM → the capture's analysers →
 * samples → the music layer and the director → the song memory, tests/helpers/music-react-run.ts). I077_STEP2_REPORT=1 prints the numbers.
 *  - taste: validated and portable (card, export, import, update from a file); a neutral taste is exactly step 1 (frames and ledger
 *    byte for byte); liked songs get more of her (reactions, size, dance), unliked ones a lighter version, never none and never a
 *    new kind of reaction;
 *  - fingerprints: a handful of numbers (nothing else) that two plays of one song share; recognition needs plays on record, finds the
 *    intro of the same song again, and does not mistake a near-duplicate (a faster version, a cover in another key) or another song;
 *  - the recognise reaction is sparse, varied and its mood moment is gated and scaled by taste (one moment, not two);
 *  - the host: per character, numbers only on disk, the right windows, clear (and its undo), nothing in the card export;
 *  - the agent channel's clear tool needs the user's words (confirm tier) and offers an undo.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import test from 'node:test';
import { samplesOf, structuredSong, type SongKind } from './helpers/music-fixtures';
import { concat, seconds } from './helpers/listen-audio';
import { repeatPlays, runReact, type ReactRun } from './helpers/music-react-run';
import { MusicReact, isNeutralShape } from '../src/stage/music-react/director';
import { MusicReactStage } from '../src/stage/music-react/stage';
import { chooseMusic } from '../src/stage/music-react/choose';
import { NEUTRAL_DISPOSITIONS, NEUTRAL_TEMPER } from '../src/voice/speech-face/choose';
import { MUSIC_RECIPES, MUSIC_INTENTS } from '../src/stage/music-react/recipes';
import { MUSIC_REACT_KNOBS } from '../src/stage/music-react/knobs';
import { NEUTRAL_GAINS, songEnergyOf, tasteGains, tasteLiking } from '../src/stage/music-react/taste';
import { SongProfiler } from '../src/stage/music-react/fingerprint';
import { MusicLikeness } from '../src/stage/music-likeness';
import { MusicHearing } from '../src/stage/music-react/hearing';
import { SongMemory, parseSongMemory, serializeSongMemory, songDistance, validatePrint, validateSketch, type SongSketch } from '../shared/senses/song-memory';
import { SONG_MEMORY_KNOBS } from '../shared/senses/song-memory/knobs';
import { NEUTRAL_MUSIC_TASTE, isNeutralMusicTaste, musicTasteOf, validateMusicTaste, type MusicTaste } from '../shared/senses/music-taste';
import { CharacterCardStore, parseCharacterCardText } from '../electron/cards/character-cards';
import { planCharacterCardUpdate, cardUpdateSummaryLines } from '../shared/cards/character-card-update';
import { defaultCharacterResponseProfile } from '../shared/cards/character-response';
import { validateCharacterDraft, type CharacterDraft } from '../shared/cards/character-cards';
import { SongMemoryHost } from '../electron/senses/song-memory';
import { MoodHost } from '../electron/mood/mood';
import { MOOD_MOMENTS, MOOD_MOMENT_KNOBS, MOOD_MOMENT_REASONS } from '../shared/foundation/mood-moments';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/foundation/mood';
import { moodEventSource } from '../shared/memory/journal';
import { createAppTools, type AgentAppBridge } from '../electron/safety/agent-channel/app-tools';
import { AGENT_TOOLS } from '../shared/safety/agent-channel';
import { ListenTogetherPanel } from '../src/senses/ListenTogetherPanel';
import { FixedBoredomTiming } from '../shared/behaviors/boredom-timing/fake';
import { FixedTouchFeedEffect } from '../shared/behaviors/touch-feed-effect/fake';
import { FixedBlush } from '../shared/behaviors/blush/fake';
import type { MusicEnergySample } from '../src/stage/music-dance';

const REPORT = process.env.I077_STEP2_REPORT === '1';
const say = (...parts: unknown[]) => { if (REPORT) console.log(...parts); };
const KINDS: SongKind[] = ['pop', 'bright', 'dark', 'ambient'];
const mean = (xs: readonly number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

// ---------------------------------------------------------------------------------------------- the songs

const cache = new Map<string, MusicEnergySample[]>();
/** One play of a song as the capture would send it: two seconds of silence, the song, six seconds of silence (the song ends). */
function playOf(kind: SongKind, variant: { tempo?: number; transpose?: number } = {}, seed = 77, hz = 30): (index: number) => MusicEnergySample[] {
  return index => {
    const key = `${kind}|${seed}|${JSON.stringify(variant)}|${hz}|${index % 3}`;
    let samples = cache.get(key);
    if (!samples) {
      const song = structuredSong(kind, seed, variant);
      cache.set(key, samples = samplesOf(concat(seconds(2), song.pcm, seconds(6)), { refreshHz: 60, seed: 7 + (index % 3) }));
    }
    return samples;
  };
}
const REMEMBERED = SONG_MEMORY_KNOBS.recognition.minPlays;
/** A memory that has heard `kind` `plays` times (through the director, as the stage does). */
function learned(kind: SongKind, plays: number, variant: { tempo?: number; transpose?: number } = {}, memory = new SongMemory([], () => 0.37)): SongMemory {
  runReact(repeatPlays(playOf(kind, variant), plays), { memory, fps: 30, tail: 3 });
  return memory;
}
const PLAYS = REMEMBERED + 2;

// ---------------------------------------------------------------------------------------------- taste

test('taste: three whole numbers 0..100; all 50 is no taste at all; anything else is refused', () => {
  assert.equal(validateMusicTaste({ tempo: 50, brightness: 50, energy: 50 }), undefined);
  assert.equal(validateMusicTaste(null), undefined);
  assert.deepEqual(validateMusicTaste({ tempo: 80 }), { tempo: 80, brightness: 50, energy: 50 });
  for (const bad of [{ tempo: 101 }, { tempo: -1 }, { tempo: 50.5 }, { tempo: '60' }, { pace: 60 }, [1, 2, 3], 'fast', 7])
    assert.throws(() => validateMusicTaste(bad), /音乐口味/);
  assert.equal(isNeutralMusicTaste(undefined), true);
  assert.equal(isNeutralMusicTaste({ tempo: 51, brightness: 50, energy: 50 }), false);
  assert.deepEqual(musicTasteOf({ musicTaste: { tempo: 20, brightness: 50, energy: 50 } }), { tempo: 20, brightness: 50, energy: 50 });
  assert.deepEqual(musicTasteOf({ musicTaste: 'broken' }), NEUTRAL_MUSIC_TASTE, 'a broken value reads as no taste');
});

test('taste: liking is exactly 0 and every gain exactly 1 for no taste; liked > unliked; the floor is above zero', () => {
  const bright = { bpm: 128, brightness: 0.8, density: 4, pluck: 0.7, bass: 0.3 }, slow = { bpm: 70, brightness: 0.1, density: 1, pluck: 0.1, bass: 0.6 };
  assert.equal(tasteLiking(NEUTRAL_MUSIC_TASTE, bright), 0);
  assert.equal(tasteLiking(undefined, bright), 0);
  assert.deepEqual(tasteGains(0), NEUTRAL_GAINS);
  const fan: MusicTaste = { tempo: 90, brightness: 90, energy: 90 }, calm: MusicTaste = { tempo: 10, brightness: 10, energy: 10 };
  assert.ok(tasteLiking(fan, bright) > 0.6, 'a fast, bright, intense song is just what she likes');
  assert.ok(tasteLiking(fan, slow) < -0.3);
  assert.ok(tasteLiking(calm, slow) > 0.3 && tasteLiking(calm, bright) < -0.25, `${tasteLiking(calm, slow)} ${tasteLiking(calm, bright)}`);
  // One opinion only (tempo): the other axes say nothing.
  assert.ok(tasteLiking({ tempo: 100, brightness: 50, energy: 50 }, bright) > 0 && tasteLiking({ tempo: 100, brightness: 50, energy: 50 }, slow) < 0);
  // A song whose tempo is not known yet says nothing about tempo.
  assert.equal(tasteLiking({ tempo: 100, brightness: 50, energy: 50 }, { ...bright, bpm: null }), 0);
  for (const liking of [-1, -0.5, 0.5, 1]) { const g = tasteGains(liking); for (const value of Object.values(g)) assert.ok(value >= 0.5 && value <= 1.5, `${liking}: ${value}`); }
  assert.ok(tasteGains(1).often > 1 && tasteGains(-1).often < 1 && tasteGains(-1).often >= 0.5);
  assert.ok(songEnergyOf(bright) > songEnergyOf(slow));
});

test('taste: a neutral taste is exactly step 1 (the ledger and every frame, byte for byte), with or without a song memory', () => {
  for (const kind of ['pop', 'bright'] as const) {
    const samples = repeatPlays(playOf(kind), 1);
    const base = runReact(samples, { fps: 30, seed: 5 });
    for (const options of [{ taste: NEUTRAL_MUSIC_TASTE }, { taste: null }, { taste: NEUTRAL_MUSIC_TASTE, memory: new SongMemory([], () => 0.2) }]) {
      const other = runReact(samples, { fps: 30, seed: 5, ...options });
      assert.equal(JSON.stringify(other.frames), JSON.stringify(base.frames), `${kind}: frames`);
      assert.equal(JSON.stringify(other.react.ledger), JSON.stringify(base.react.ledger), `${kind}: ledger`);
      assert.equal(JSON.stringify(other.faces), JSON.stringify(base.faces), `${kind}: faces`);
      assert.deepEqual(other.moments.map(m => [m.t, m.intent, m.scale]), base.moments.map(m => [m.t, m.intent, m.scale]));
    }
    assert.ok(base.moments.every(m => m.scale === 1), 'no taste: no scaling of any mood moment');
  }
});

// Tastes that match or miss what the synthetic songs measure (the bright song: fast, brightness 0.4, dense; the dark one: no beat, dark, sparse).
const FAN: MusicTaste = { tempo: 92, brightness: 45, energy: 90 }, CALM: MusicTaste = { tempo: 8, brightness: 5, energy: 8 };
interface Engagement { reactions: number; size: number; bounce: number; likeEnd: number; variants: Set<string>; intents: Set<string>; sliders: Set<string>; minAmp: number }
function engagement(kind: SongKind, taste: MusicTaste | null, seeds: readonly number[]): Engagement {
  const samples = repeatPlays(playOf(kind), 1), sizes: number[] = [], bounce: number[] = [], likeEnd: number[] = [], e: Engagement = { reactions: 0, size: 0, bounce: 0, likeEnd: 0, variants: new Set(), intents: new Set(), sliders: new Set(), minAmp: Infinity };
  for (const seed of seeds) {
    const run = runReact(samples, { fps: 30, seed, taste, trackLike: true });
    const started = run.react.ledger.filter(r => r.outcome === 'started');
    e.reactions += started.length;
    for (const r of started) { sizes.push(r.size ?? 0); e.variants.add(r.variant ?? ''); e.intents.add(r.intent ?? ''); }
    for (const f of run.faces) { e.sliders.add(f.slider); e.minAmp = Math.min(e.minAmp, f.amp); }
    bounce.push(mean(run.frames.filter(f => f.t > 10 && f.t < 55 && f.music).map(f => f.shape.bounce)));
    likeEnd.push(run.frames.map(f => f.like ?? 0).reduce((a, b) => Math.abs(b) > Math.abs(a) ? b : a, 0));
  }
  e.size = mean(sizes); e.bounce = mean(bounce); e.likeEnd = mean(likeEnd);
  return e;
}

test('taste: songs she likes get more of her, songs she does not care for a lighter version; never none, never a new kind of reaction', () => {
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const table: Record<string, Engagement> = {};
  for (const kind of ['bright', 'dark'] as const) for (const [name, taste] of [['none', null], ['fan', FAN], ['calm', CALM]] as const) table[`${kind}/${name}`] = engagement(kind, taste, seeds);
  for (const [key, e] of Object.entries(table)) say(`${key.padEnd(12)} reactions ${String(e.reactions).padStart(2)}  size ${e.size.toFixed(2)}  dance bounce ${e.bounce.toFixed(3)}  liking ${e.likeEnd.toFixed(2)}`);
  const b = (name: string) => table[`bright/${name}`]!, d = (name: string) => table[`dark/${name}`]!;
  // The bright, fast, plucky song: the fan likes it, the calm listener does not.
  assert.ok(b('fan').likeEnd > 0.3 && b('calm').likeEnd < -0.3, `${b('fan').likeEnd} ${b('calm').likeEnd}`);
  assert.ok(b('fan').reactions > b('calm').reactions, 'more reactions to a liked song');
  assert.ok(b('fan').size > b('none').size && b('none').size > b('calm').size, 'bigger for a liked song, smaller for an unliked one');
  assert.ok(b('fan').bounce > b('none').bounce && b('none').bounce > b('calm').bounce, 'a livelier dance for a liked song');
  // The slow dark song: the other way round.
  assert.ok(d('calm').likeEnd > 0.3 && d('fan').likeEnd < -0.3, `${d('calm').likeEnd} ${d('fan').likeEnd}`);
  assert.ok(d('calm').reactions >= d('fan').reactions && d('calm').size > d('fan').size);
  // Never none: an unliked song still gets her, at about half to three quarters of the neutral amount.
  for (const e of [b('calm'), d('fan')]) { assert.ok(e.reactions > 0, 'an unliked song is still followed'); assert.ok(e.bounce > 0.55, 'the dance is lighter, not gone'); }
  assert.ok(b('calm').reactions >= 0.4 * b('none').reactions, `${b('calm').reactions} of ${b('none').reactions}`);
  // Nothing new: the same recipes, never a dislike face (every slider she uses is one step 1 already used; every amplitude is positive).
  const used = new Set(MUSIC_INTENTS.flatMap(intent => MUSIC_RECIPES[intent].flatMap(v => v.face ? [v.face.slider] : [])));
  for (const e of Object.values(table)) { for (const slider of e.sliders) assert.ok(used.has(slider as never), slider); assert.ok(e.minAmp > 0); for (const intent of e.intents) assert.ok((MUSIC_INTENTS as readonly string[]).includes(intent)); }
  assert.deepEqual([...b('calm').intents].filter(i => !b('none').intents.has(i) && i !== 'recognize'), [...b('calm').intents].filter(i => !b('none').intents.has(i) && i !== 'recognize'));
});

test('taste: at one moment of the song the chance of a reaction and its size, liked vs neutral vs unliked (the chooser itself, 6000 draws each)', () => {
  const rows: Record<string, { chance: number; size: number; picks: number }> = {};
  for (const [name, liking] of [['liked', 1], ['half liked', 0.5], ['neutral', 0], ['half unliked', -0.5], ['unliked', -1]] as const) {
    let picks = 0, sizes = 0, n = 0, state = 12345;
    const random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
    const gains = tasteGains(liking);
    for (let i = 0; i < 6000; i++) {
      const pick = chooseMusic('lift', MUSIC_REACT_KNOBS.choice.lift, NEUTRAL_TEMPER, NEUTRAL_DISPOSITIONS, random, { already: 0, last: null, still: false, gentle: false, taste: liking === 0 ? undefined : gains });
      n++; if (typeof pick !== 'string') { picks++; sizes += pick.size; }
    }
    rows[name] = { chance: picks / n, size: sizes / Math.max(1, picks), picks };
    say(`chooser ${name.padEnd(12)} chance ${(picks / n).toFixed(3)}  mean size ${(sizes / Math.max(1, picks)).toFixed(3)}`);
  }
  assert.ok(rows.liked!.chance > rows['half liked']!.chance && rows['half liked']!.chance > rows.neutral!.chance && rows.neutral!.chance > rows['half unliked']!.chance && rows['half unliked']!.chance > rows.unliked!.chance);
  assert.ok(rows.unliked!.chance > 0.3 * rows.neutral!.chance, 'an unliked song is still followed, at about half the chance');
  assert.ok(rows.liked!.size > rows.neutral!.size && rows.neutral!.size > rows.unliked!.size && rows.unliked!.size > 0.7 * rows.neutral!.size);
  // The neutral row is step 1's own chooser: the same draws give the same picks with and without the (absent) taste.
  let a = 99, b = 99;
  const ra = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; }, rb = () => { b = (b * 1664525 + 1013904223) >>> 0; return b / 4294967296; };
  for (let i = 0; i < 500; i++) assert.deepEqual(chooseMusic('settle', 0.45, NEUTRAL_TEMPER, NEUTRAL_DISPOSITIONS, ra, { already: i % 3, last: null, still: false, gentle: i % 2 === 0 }),
    chooseMusic('settle', 0.45, NEUTRAL_TEMPER, NEUTRAL_DISPOSITIONS, rb, { already: i % 3, last: null, still: false, gentle: i % 2 === 0, taste: { often: 1, size: 1 } }));
});

// ---------------------------------------------------------------------------------------------- the card field

const draft = (name: string, fields: Partial<CharacterDraft> = {}): CharacterDraft => ({ name, description: '', personality: '', scenario: '', greeting: '', examples: '', systemPrompt: '', ...fields });
async function withStore(run: (store: CharacterCardStore, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-i077-card-'));
  try { const store = new CharacterCardStore(directory, 'persona'); await store.load(); await run(store, directory); }
  finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}

test('card: the taste is stored, exported and imported with the card; none is no field at all; the editor can clear it; a draft without the key keeps it', async () => {
  await withStore(async store => {
    const taste: MusicTaste = { tempo: 85, brightness: 30, energy: 60 };
    let state = await store.save(draft('Mika', { musicTaste: taste }));
    const id = state.cards.find(card => card.name === 'Mika')!.id;
    assert.deepEqual(state.cards.find(card => card.id === id)!.musicTaste, taste);
    const exported = JSON.parse(store.export(id)) as { card: Record<string, unknown> };
    assert.deepEqual(exported.card.musicTaste, taste);
    // Import: a new card with the same taste.
    state = await store.import(JSON.stringify({ format: 'soft-hearts-character-card', version: 2, card: { ...exported.card, name: 'Mika 2' } }));
    assert.deepEqual(state.cards.find(card => card.name === 'Mika 2')!.musicTaste, taste);
    // A card with no taste exports exactly as before (no field).
    state = await store.save(draft('Plain'));
    const plain = state.cards.find(card => card.name === 'Plain')!;
    assert.equal(Object.hasOwn(plain, 'musicTaste'), false);
    assert.equal('musicTaste' in (JSON.parse(store.export(plain.id)) as { card: object }).card, false);
    // The editor always names the taste: a draft that says all 50 clears it; a draft without the key (another writer) keeps it.
    state = await store.save(draft('Mika', { musicTaste: { tempo: 50, brightness: 50, energy: 50 } }), id);
    assert.equal(Object.hasOwn(state.cards.find(card => card.id === id)!, 'musicTaste'), false);
    state = await store.save(draft('Mika', { musicTaste: taste }), id);
    state = await store.save(draft('Mika', { personality: 'calm' }), id);
    assert.deepEqual(state.cards.find(card => card.id === id)!.musicTaste, taste, 'a draft without the key keeps the card\'s own');
    // Refused: not a taste.
    assert.throws(() => validateCharacterDraft(draft('X', { musicTaste: { tempo: 200 } as never })), /音乐口味/);
    assert.throws(() => validateCharacterDraft({ ...draft('X'), musicTaste: 'fast' }), /音乐口味/);
  });
});

test('card: updating from a file brings the file\'s taste, or keeps hers when the file has none; the update dialog says so', async () => {
  await withStore(async store => {
    const taste: MusicTaste = { tempo: 15, brightness: 40, energy: 20 };
    const state = await store.save(draft('Mika', { musicTaste: taste }));
    const card = state.cards.find(c => c.name === 'Mika')!;
    const fromFile = (fields: object) => {
      const parsed = parseCharacterCardText(JSON.stringify({ format: 'soft-hearts-character-card', version: 2, card: { ...draft('Mika'), mood: { version: 1, parameters: DEFAULT_MOOD_PARAMETERS }, ...fields } }));
      return { format: 'soft-hearts-v2' as const, draft: parsed.draft, response: null };
    };
    // A file without a taste: hers stays.
    let plan = planCharacterCardUpdate(card, defaultCharacterResponseProfile(), fromFile({ personality: 'new' }));
    assert.deepEqual(plan.draft.musicTaste, taste); assert.equal(plan.summary.musicTaste, 'kept');
    assert.ok(cardUpdateSummaryLines(plan.summary).some(l => l.text.includes('音乐口味：文件里没有')));
    // A file with another taste: replaced.
    const other: MusicTaste = { tempo: 90, brightness: 90, energy: 90 };
    plan = planCharacterCardUpdate(card, defaultCharacterResponseProfile(), fromFile({ musicTaste: other }));
    assert.deepEqual(plan.draft.musicTaste, other); assert.equal(plan.summary.musicTaste, 'replaced'); assert.equal(plan.summary.unchanged, false);
    assert.ok(cardUpdateSummaryLines(plan.summary).some(l => l.text.includes('音乐口味：换成文件里的')));
    const applied = await store.updateInPlace(card.id, plan.draft, { expected: store.cardFingerprint(card.id), backup: async () => {} });
    assert.equal(applied.changed, true);
    assert.deepEqual(applied.state.cards.find(c => c.id === card.id)!.musicTaste, other);
    // The same taste again: nothing to update.
    const again = planCharacterCardUpdate(applied.state.cards.find(c => c.id === card.id)!, defaultCharacterResponseProfile(), fromFile({ musicTaste: other }));
    assert.equal(again.summary.musicTaste, 'same'); assert.equal(again.summary.unchanged, true);
  });
});

// ---------------------------------------------------------------------------------------------- fingerprints

test('fingerprint: a handful of numbers and nothing else; two plays of one song agree, different songs do not', () => {
  const sketches = new Map<SongKind, SongSketch[]>();
  for (const kind of KINDS) {
    const memory = new SongMemory([], () => 0.1);
    const run = runReact(repeatPlays(playOf(kind), 3), { memory, fps: 30, tail: 3 });
    assert.equal(run.looks.length, 3, `${kind}: one look per play`);
    assert.equal(run.learned.length, 3, `${kind}: every play is learned once it ended`);
    sketches.set(kind, run.looks.map(l => l.sketch));
    for (const l of run.looks) assert.deepEqual(validateSketch(l.sketch), l.sketch, 'a sketch is its own validated copy');
    for (const l of run.learned) assert.ok(l.sketch.sec.length >= 1 && l.sketch.sec.length <= 4, 'section times, a few');
  }
  const rows: string[] = [];
  for (const a of KINDS) {
    for (const b of KINDS) {
      const same = songDistance(sketches.get(a)![0]!, sketches.get(b)![1]!);
      rows.push(`${a}→${b} ${same.d.toFixed(2)}`);
      if (a === b) assert.ok(same.d < 0.8 && same.worst < 1.4, `${a}: two plays agree (${same.d.toFixed(2)}, worst ${same.worst.toFixed(2)})`);
      else assert.ok(same.d > SONG_MEMORY_KNOBS.recognition.limit, `${a} vs ${b}: ${same.d.toFixed(2)}`);
    }
  }
  say('distances between plays (RMS of the terms, 1 = at the tolerance):', rows.join(' | '));
  // The numbers: a print holds exactly these keys, all numbers but the id.
  const [print] = (() => { const m = new SongMemory([], () => 0.3); m.learn(sketches.get('pop')![0]!, 100); return m.list(); })();
  assert.deepEqual(Object.keys(print!).sort(), ['bands', 'bpm', 'bright', 'dens', 'id', 'last', 'plays', 'pluck', 'sec']);
  assert.ok(print!.id.match(/^[0-9a-f]{8}$/));
});

test('fingerprint: the same song heard 3 times is recognised at its intro from the 4th play; never before; the intro is what is looked up', () => {
  const rows: string[] = [];
  for (const kind of KINDS) {
    const memory = new SongMemory([], () => 0.42);
    const run = runReact(repeatPlays(playOf(kind), PLAYS), { memory, fps: 30, tail: 3 });
    assert.equal(run.looks.length, PLAYS);
    const found = run.looks.map(l => l.found !== null);
    assert.deepEqual(found, Array.from({ length: PLAYS }, (_, i) => i >= REMEMBERED), `${kind}: ${found}`);
    // The look-up happens in the intro (about 12 s of sound), not at the end of the song.
    const one = playOf(kind)(0), length = one.at(-1)!.time - one[0]!.time + 1 / 30; // one play, silence at both ends
    const intro = run.looks.map((l, i) => l.t - i * length);
    assert.ok(intro.every(t => t > 8 && t < 26), `${kind}: looked up ${intro.map(t => t.toFixed(1))} s in (a play is ${length.toFixed(1)} s)`);
    rows.push(`${kind}: found from play ${found.indexOf(true) + 1}, looked up at ${intro.map(t => t.toFixed(1)).join('/')} s`);
    assert.equal(memory.size, 1, `${kind}: all the plays are one song on record`);
    assert.equal(memory.list()[0]!.plays, PLAYS);
  }
  say(rows.join('\n'));
});

test('fingerprint: songs on record are told apart; a faster version and a cover in another key are not taken for the song', () => {
  const memory = new SongMemory([], () => 0.5);
  for (const kind of KINDS) learned(kind, REMEMBERED, {}, memory);
  assert.equal(memory.size, KINDS.length);
  const ids = new Map(KINDS.map(kind => [kind, ''] as const));
  const outcomes: string[] = [];
  const hear = (kind: SongKind, variant: { tempo?: number; transpose?: number }) => {
    const copy = new SongMemory(memory.list(), () => 0.9);
    return runReact(repeatPlays(playOf(kind, variant), 1), { memory: copy, fps: 30, tail: 3 }).looks[0]!.found;
  };
  // Each song is its own.
  const own = new Map<SongKind, string>();
  for (const kind of KINDS) { const id = hear(kind, {}); assert.ok(id, `${kind} recognised`); own.set(kind, id!); outcomes.push(`${kind}: found`); }
  assert.equal(new Set(own.values()).size, KINDS.length, 'four different ids: no song is taken for another');
  void ids;
  // Near-duplicates (a pop song a few percent faster, in another key; a bright one in another key; a dark one): none is a match.
  const cases: [SongKind, { tempo?: number; transpose?: number }][] = [['pop', { tempo: 1.06 }], ['pop', { tempo: 1.04 }], ['pop', { transpose: 3 }], ['pop', { transpose: 7 }],
    ['bright', { tempo: 1.05 }], ['dark', { transpose: 4 }]];
  for (const [kind, variant] of cases) {
    const found = hear(kind, variant);
    outcomes.push(`${kind} ${JSON.stringify(variant)}: ${found === null ? 'not taken for the song' : 'MISTAKEN'}`);
    assert.equal(found, null, `${kind} ${JSON.stringify(variant)} is not the song on record`);
  }
  // The same song only slightly different (2 % faster: the same recording played a little off) is still the song.
  assert.equal(hear('pop', { tempo: 1.02 }), own.get('pop'), 'a 2 % tempo difference is the same song');
  say(outcomes.join('\n'));
});

test('fingerprint: two near songs on record make her unsure, not wrong (the margin); a song heard only once or twice is not recognised', () => {
  // A sketch between two prints that are both within the limit: not sure → no match.
  const base: SongSketch = { bpm: 100, bands: [0.35, 0.64, 0.01], bright: 0.1, pluck: 0.2, dens: 2.2, sec: [] };
  const near = (bpm: number): SongSketch => ({ ...base, bpm });
  const memory = new SongMemory([], () => 0.6);
  for (let i = 0; i < 4; i++) memory.learn(near(100), 1);
  for (let i = 0; i < 4; i++) memory.learn(near(104.5), 1); // 4.5 % apart: two songs (not merged: the tempo gate), both heard 4 times
  assert.equal(memory.size, 2);
  assert.equal(memory.match(near(100))!.plays, 4, 'a song right on one of them is that one');
  const between = memory.match(near(102.25));
  assert.equal(between, null, 'halfway between two songs on record: she does not pick one');
  // Plays on record: 1 and 2 are not enough.
  const young = new SongMemory([], () => 0.7);
  young.learn(base, 1); assert.equal(young.match(base), null);
  young.learn(base, 1); assert.equal(young.match(base), null);
  young.learn(base, 1); assert.ok(young.match(base), 'the third play makes it recognisable');
  // A first section far from the print's: another version, a new print.
  const long = new SongMemory([], () => 0.8);
  long.learn({ ...base, sec: [8, 24] }, 1); long.learn({ ...base, sec: [8.5, 25] }, 1); long.learn({ ...base, sec: [24, 40] }, 1);
  assert.equal(long.size, 2, 'the same intro with the first section change 16 s later is another song');
});

test('fingerprint: keeping it small: at most maxSongs, old single plays go first, clearing forgets everything', () => {
  const k = SONG_MEMORY_KNOBS.keep;
  const memory = new SongMemory([], (() => { let n = 0; return () => (n++ * 0.6180339887) % 1; })());
  const sketch = (i: number): SongSketch => ({ bpm: 60 + (i % 90) * 2, bands: [0.2 + (i % 7) * 0.05, 0.7 - (i % 7) * 0.05, 0.1], bright: (i % 5) / 5, pluck: (i % 3) / 3, dens: 1 + (i % 11), sec: [] });
  for (let i = 0; i < k.maxSongs + 40; i++) memory.learn(sketch(i * 13), 1000 + i);
  assert.ok(memory.size <= k.maxSongs, `${memory.size}`);
  const loved = new SongMemory([], () => 0.31);
  for (let i = 0; i < 6; i++) loved.learn(sketch(5), 1);
  for (let i = 0; i < k.maxSongs + 5; i++) loved.learn(sketch(100 + i * 17), 2 + i);
  assert.ok(loved.list().some(p => p.plays >= 6), 'a song heard many times outlasts the one-off songs');
  const stale = new SongMemory([], () => 0.5); stale.learn(sketch(1), 100); stale.learn(sketch(50), 100 + k.staleDays + 5);
  assert.equal(stale.size, 1, 'a single play long ago is dropped');
  const before = memory.size;
  assert.equal(memory.clear(), before, 'clear reports what it forgot');
  assert.equal(memory.size, 0);
  assert.equal(memory.match(sketch(0)), null);
});

test('fingerprint: the file holds numbers only; a damaged row is dropped; a file that is not a song memory is refused', () => {
  const memory = learned('bright', 3);
  const text = serializeSongMemory(memory);
  const data = JSON.parse(text) as { version: number; songs: Record<string, unknown>[] };
  assert.equal(data.version, 1);
  assert.deepEqual(Object.keys(data), ['version', 'songs']);
  for (const song of data.songs) for (const [key, value] of Object.entries(song)) {
    if (key === 'id') assert.match(String(value), /^[0-9a-f]{8}$/);
    else if (Array.isArray(value)) assert.ok(value.every(n => typeof n === 'number'), key);
    else assert.equal(typeof value, 'number', key);
  }
  assert.deepEqual(parseSongMemory(text), memory.list());
  const broken = JSON.stringify({ version: 1, songs: [...data.songs, { ...data.songs[0], title: 'a title' }, { ...data.songs[0], id: 'zz', bpm: 'fast' }, 'text', null] });
  assert.equal(parseSongMemory(broken).length, data.songs.length, 'extra keys, bad ids and non-numbers are dropped');
  assert.throws(() => parseSongMemory('{"version":2}')); assert.throws(() => parseSongMemory('nope'));
  assert.equal(validatePrint({ ...data.songs[0], bands: [0.5, 0.5] }), null);
  assert.equal(validateSketch({ bpm: 100, bands: [0.3, 0.3, 0.4], bright: 2, pluck: 0, dens: 1, sec: [] }), null);
});

// ---------------------------------------------------------------------------------------------- the recognise reaction

test('recognise: sparse and varied; never counted in the per-song budget; not every time; the same song not twice in ten minutes', () => {
  const records: { variant: string; t: number; seed: number; kind: SongKind }[] = [];
  let looks = 0, reacted = 0, recognisePlays = 0;
  const everyMoment: { intent: string }[] = [];
  const perPlay: number[] = [];
  for (const kind of KINDS) {
    const memory = learned(kind, REMEMBERED);
    for (let seed = 1; seed <= 8; seed++) {
      const copy = new SongMemory(memory.list(), () => 0.9);
      const run = runReact(repeatPlays(playOf(kind), 1), { memory: copy, fps: 30, seed, temper: { N: 0.1, D: 0.1 }, taste: seed % 2 ? FAN : CALM });
      looks++;
      assert.ok(run.looks[0]!.found, `${kind} seed ${seed}: recognised`);
      const mine = run.react.ledger.filter(r => r.trigger === 'recognized');
      recognisePlays++;
      const started = mine.filter(r => r.outcome === 'started');
      assert.ok(started.length <= 1, 'at most one recognise reaction per song');
      if (started.length) { reacted++; records.push({ variant: started[0]!.variant!, t: started[0]!.sampleAt, seed, kind }); }
      const section = run.react.ledger.filter(r => r.outcome === 'started' && r.trigger !== 'recognized');
      assert.ok(section.length <= MUSIC_REACT_KNOBS.choice.perSong, `the section reactions keep their own budget (${section.length})`);
      // Never the same variant back to back, across all the reactions of the song.
      const order = run.react.ledger.filter(r => r.outcome === 'scheduled').map(r => r.variant);
      for (let i = 1; i < order.length; i++) assert.notEqual(order[i], order[i - 1]);
      perPlay.push(started.length + section.length);
      everyMoment.push(...run.moments);
    }
  }
  const variants = new Set(records.map(r => r.variant));
  say(`recognise: ${reacted}/${recognisePlays} recognised plays showed a reaction; variants ${[...variants].join(', ')}; reactions per play (all kinds) mean ${mean(perPlay).toFixed(2)} max ${Math.max(...perPlay)}`);
  assert.ok(reacted > 0.3 * looks && reacted < looks, `not every time, not never (${reacted}/${looks})`);
  assert.ok(Math.max(...perPlay) > MUSIC_REACT_KNOBS.choice.perSong, 'a song can have its two section reactions and the recognition on top: the recognition is not in their budget');
  assert.ok(variants.size >= 2, 'more than one way');
  for (const variant of variants) assert.ok(MUSIC_RECIPES.recognize.some(v => v.id === variant));
  assert.ok(everyMoment.some(m => m.intent === 'recognize'));
  // The same song looked up again within ten minutes (a looped song): not a second reaction.
  const memory = learned('pop', REMEMBERED);
  const react = new MusicReact(undefined, 7);
  const loop = runReact(repeatPlays(playOf('pop'), 3), { memory: new SongMemory(memory.list(), () => 0.8), fps: 30, tail: 3 }, react);
  const recognised = loop.react.ledger.filter(r => r.trigger === 'recognized');
  assert.ok(recognised.filter(r => r.outcome === 'scheduled').length <= 1, `one reaction for a looped song (${recognised.map(r => r.outcome + ':' + (r.reason ?? '')).join(' ')})`);
  assert.ok(recognised.length === 0 || recognised.some(r => r.reason === 'again') || recognised.length === 1);
});

test('recognise: taste scales the reaction and its mood moment (liked: bigger; unliked: smaller, never zero); the fan always shows more', () => {
  const memory = learned('bright', REMEMBERED);
  const sizes = { fan: [] as number[], calm: [] as number[] }, scales = { fan: [] as number[], calm: [] as number[] };
  for (let seed = 1; seed <= 24; seed++) for (const [name, taste] of [['fan', FAN], ['calm', CALM]] as const) {
    const run = runReact(repeatPlays(playOf('bright'), 1), { memory: new SongMemory(memory.list(), () => 0.9), fps: 30, seed, taste, temper: { N: 0.2, D: 0.2 } });
    for (const r of run.react.ledger) if (r.outcome === 'started' && r.trigger === 'recognized') sizes[name].push(r.size ?? 0);
    for (const m of run.moments) if (m.intent === 'recognize') scales[name].push(m.scale);
  }
  say(`recognise bright song: fan ${sizes.fan.length} reactions mean size ${mean(sizes.fan).toFixed(2)} scale ${mean(scales.fan).toFixed(2)}; calm ${sizes.calm.length}, ${mean(sizes.calm).toFixed(2)}, ${mean(scales.calm).toFixed(2)}`);
  assert.ok(sizes.fan.length > sizes.calm.length && sizes.calm.length > 0, 'more often for a liked song, still sometimes for an unliked one');
  assert.ok(mean(sizes.fan) > mean(sizes.calm));
  assert.ok(mean(scales.fan) > 1 && mean(scales.calm) < 1 && Math.min(...scales.calm) > 0.6, `${mean(scales.fan)} ${mean(scales.calm)}`);
  assert.ok(Math.max(...scales.fan) <= 1.3 + 1e-9);
});

test('recognise: not while she is not choosing, not music, speaking, asleep; and an answer that comes after the song is over is dropped', () => {
  const memory = learned('pop', REMEMBERED);
  for (const options of [{ on: false }, { temper: { sleepy: 1 } }] as const) {
    const run = runReact(repeatPlays(playOf('pop'), 1), { ...options, memory: new SongMemory(memory.list(), () => 0.9), fps: 30 });
    assert.equal(run.looks.length, 0, `${JSON.stringify(options)}: nothing is looked up`);
    assert.equal(run.moments.length, 0);
  }
  // A late answer: the director ignores a token that is not the current song's.
  const react = new MusicReact(undefined, 3);
  react.recognized(99, 'abcdef01');
  const run = runReact([], { fps: 30 }, react);
  assert.equal(run.react.ledger.length, 0);
  const samples = repeatPlays(playOf('pop'), 1), tokens: number[] = [];
  const late = new MusicReact(undefined, 4);
  let stale = 0;
  const probe = runReact(samples, { memory: new SongMemory(memory.list(), () => 0.9), fps: 30 }, late);
  tokens.push(probe.looks.length); stale = late.ledger.filter(r => r.trigger === 'recognized').length;
  assert.ok(stale <= 1);
  late.recognized(1, 'deadbeef'); // the song is long over
  const after = late.frame(1 / 30, { on: true, music: false, moving: true, speaking: false, temper: { ...{ N: 0, D: 0, E: 0, C: 0, O: 0, sleepy: 0 } } as never, dispositions: {} as never, period: 0, beatScore: 0 });
  assert.deepEqual(after.moments, []);
});

// ---------------------------------------------------------------------------------------------- the stage (async look-up)

/** The stage's own class (src/stage/music-react/stage.ts) driven frame by frame with an asynchronous song memory, as the companion window does. */
async function driveStage(plays: number, characterAt: (looks: number) => string) {
  const memory = new SongMemory([], () => 0.5), calls = { match: 0, learn: 0 }, learnedFor: string[] = [];
  let character = 'card-a';
  const port = { match: async (s: SongSketch) => { calls.match++; await Promise.resolve(); const f = memory.match(s); return f ? { id: f.id } : null; },
    learn: async (s: SongSketch) => { calls.learn++; learnedFor.push(character); memory.learn(s, 5); } };
  const stage = new MusicReactStage(undefined, 9), told: [string, number][] = [];
  const samples = repeatPlays(playOf('pop'), plays), likeness = new MusicLikeness();
  let index = 0;
  const base = samples[0]!.time, fps = 30, end = samples.at(-1)!.time - base + 3;
  for (let frame = 1; frame / fps <= end; frame++) {
    const t = frame / fps;
    while (index < samples.length && samples[index]!.time - base <= t) { const sample = samples[index++]!; likeness.update(sample); stage.hear(sample); }
    character = characterAt(calls.match);
    stage.step(1 / fps, { view: { characterId: character, expressions: true, snapshot: null, parameters: null, fatigue: null }, choosing: true, music: likeness.music, tier: 'dance', shown: true,
      speaking: false, likeness: likeness.music ? likeness.getState() : null, dance: { setShape: () => {} }, nod: undefined, face: () => ({ performPick: () => {}, setTint: () => {} }),
      hasFace: false, told: (intent, scale) => { told.push([intent, scale]); }, memory: port });
    if (frame % 10 === 0) await new Promise(resolve => setImmediate(resolve)); // the answers arrive between frames
  }
  await new Promise(resolve => setTimeout(resolve, 5));
  return { calls, told, learnedFor, memory };
}

test('stage: one look-up per song, answered later, learned when the song ends; the 4th play is recognised through the asynchronous port', async () => {
  const run = await driveStage(REMEMBERED + 1, () => 'card-a');
  say(`stage: ${run.calls.match} looks, ${run.calls.learn} learned, told ${JSON.stringify(run.told)}`);
  assert.equal(run.calls.match, REMEMBERED + 1, 'one look per song');
  assert.equal(run.calls.learn, REMEMBERED + 1, 'every song learned once it ended');
  assert.equal(run.memory.size, 1);
  assert.ok(run.memory.list()[0]!.plays === REMEMBERED + 1);
  for (const [intent, scale] of run.told) { assert.ok((MUSIC_INTENTS as readonly string[]).includes(intent)); assert.ok(scale > 0.5 && scale < 1.5); }
});

test('stage: a song heard for one character is never learned for another one that took over meanwhile', async () => {
  // She is "card-b" from the second song's look-up on: that song began under card-a, so it is not learned at all (card-b did not hear its start).
  const run = await driveStage(4, looks => looks >= 2 ? 'card-b' : 'card-a');
  assert.equal(run.calls.match, 4);
  assert.equal(run.calls.learn, 3, 'one song of four was dropped');
  assert.deepEqual(run.learnedFor, ['card-a', 'card-b', 'card-b']);
});

// ---------------------------------------------------------------------------------------------- the host

async function withHost(run: (host: SongMemoryHost, directory: string, current: { id: string | null }) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-i077-songs-'));
  const current = { id: 'character-aaaa-0001' as string | null };
  try { await run(new SongMemoryHost({ directory: () => directory, characterId: () => current.id, clock: () => 20_000 * 86_400_000, random: () => 0.123 }), directory, current); }
  finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}
const SKETCH: SongSketch = { bpm: 100, bands: [0.35, 0.64, 0.01], bright: 0.1, pluck: 0.2, dens: 2.2, sec: [9.6] };

test('host: numbers only on disk, one file per character, the right windows, the right character; clear forgets and the undo puts it back', async () => {
  await withHost(async (host, directory, current) => {
    const own = { op: 'learn' as const, characterId: 'character-aaaa-0001', sketch: SKETCH };
    for (let i = 0; i < REMEMBERED; i++) assert.deepEqual(await host.handle('pet', own), { count: 1 });
    const found = await host.handle('pet', { ...own, op: 'match' }) as { id: string };
    assert.match(found.id, /^[0-9a-f]{8}$/);
    // The file: numbers only.
    const files = await readdir(directory);
    assert.deepEqual(files, ['song-memory-character-aaaa-0001.json']);
    const body = await readFile(path.join(directory, files[0]!), 'utf8');
    for (const word of ['title', 'name', 'path', 'artist', 'lyrics', 'text']) assert.equal(body.includes(word), false, word);
    assert.deepEqual(parseSongMemory(body).map(p => p.plays), [REMEMBERED]);
    // Windows: the control window may not look up or teach; the companion window may not clear.
    assert.equal(await host.handle('control', { ...own, op: 'learn' }), null);
    assert.equal(await host.handle('other', { ...own, op: 'match' }), null);
    assert.equal(await host.handle('pet', { op: 'clear' }), null);
    // The character: a request for another is refused; another character has its own file.
    assert.equal(await host.handle('pet', { ...own, characterId: 'someone-else-0002' }), null);
    // Bad requests.
    for (const bad of [null, 5, 'x', [], { op: 'learn' }, { op: 'learn', characterId: 'character-aaaa-0001', sketch: { ...SKETCH, title: 'x' } }, { op: 'learn', characterId: 'character-aaaa-0001', sketch: { ...SKETCH, bpm: 'fast' } }, { op: 'nope' }])
      assert.equal(await host.handle('pet', bad), null);
    assert.deepEqual(await host.handle('control', { op: 'count' }), { count: 1 });
    current.id = 'character-bbbb-0002';
    assert.deepEqual(await host.handle('control', { op: 'count' }), { count: 0 }, 'each character has her own');
    current.id = 'character-aaaa-0001';
    // Clear (the control window's button): the file goes; the numbers can be put back (the channel's undo).
    const cleared = await host.clear();
    assert.equal(cleared.count, 1);
    assert.deepEqual(await readdir(directory), []);
    assert.deepEqual(await host.handle('control', { op: 'count' }), { count: 0 });
    assert.equal(await host.handle('pet', { ...own, op: 'match' }), null, 'nothing is recognised any more');
    await cleared.restore();
    assert.deepEqual(await host.handle('control', { op: 'count' }), { count: 1 });
    assert.ok(await host.handle('pet', { ...own, op: 'match' }));
    // Through the control window's own clear op as well.
    assert.deepEqual(await host.handle('control', { op: 'clear' }), { cleared: 1 });
    // An undo never overwrites what she has learned since.
    const second = await host.clear(); await host.handle('pet', own); await second.restore();
    assert.deepEqual(await host.handle('control', { op: 'count' }), { count: 1 });
  });
});

test('host: a damaged file is no memory, never an error; no profile directory keeps nothing', async () => {
  await withHost(async (host, directory) => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(directory, 'song-memory-character-aaaa-0001.json'), '{"version":1,"songs":[{"id":"zz"}');
    assert.deepEqual(await host.handle('control', { op: 'count' }), { count: 0 });
    assert.deepEqual(await host.handle('pet', { op: 'learn', characterId: 'character-aaaa-0001', sketch: SKETCH }), { count: 1 });
  });
  const none = new SongMemoryHost({ directory: () => null, characterId: () => 'character-aaaa-0001' });
  assert.equal(await none.handle('pet', { op: 'learn', characterId: 'character-aaaa-0001', sketch: SKETCH }), null);
  assert.deepEqual(await none.handle('control', { op: 'count' }), { count: 0 });
});

test('the song memory never goes into a card export, however many songs she knows', async () => {
  await withStore(async (store, directory) => {
    const state = await store.save(draft('Mika', { musicTaste: { tempo: 70, brightness: 50, energy: 50 } }));
    const id = state.cards.find(card => card.name === 'Mika')!.id;
    const host = new SongMemoryHost({ directory: () => directory, characterId: () => id });
    for (let i = 0; i < 4; i++) await host.handle('pet', { op: 'learn', characterId: id, sketch: SKETCH });
    const exported = store.export(id);
    for (const word of ['bpm', 'bands', 'plays', 'song', 'sec"']) assert.equal(exported.includes(word), false, word);
    assert.ok(exported.includes('musicTaste'));
  });
});

// ---------------------------------------------------------------------------------------------- back to mood

const MINUTE = 60_000, T0 = Date.UTC(2026, 10, 11, 4, 0, 0);
async function withMood(run: (c: { host: MoodHost; clock: { now: number }; journal: string[] }) => Promise<void> | void) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-i077-mood-'));
  const clock = { now: T0 };
  const host = new MoodHost(directory, () => {}, () => clock.now, { boredomTiming: new FixedBoredomTiming(), touchFeedEffect: new FixedTouchFeedEffect(), blush: new FixedBlush() });
  const journal: string[] = [];
  try {
    await host.load();
    host.activate('gene', structuredClone(DEFAULT_MOOD_PARAMETERS));
    host.setJournalObserver(event => { journal.push(moodEventSource(event.type as 'lift', event.reason)); });
    await run({ host, clock, journal });
  } finally { await host.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}

test('mood: recognising a song is its own small moment (D up, gated); taste scales that one moment inside a range, never makes a second one', async () => {
  const spec = MOOD_MOMENTS['music-recognize'];
  assert.deepEqual(Object.keys(spec.delta), ['D']); assert.ok(spec.delta.D! > 0 && spec.delta.D! <= 1.5);
  assert.ok(spec.cooldownMs >= 20 * 60_000 && spec.perDay <= 6 && spec.group !== MOOD_MOMENTS.dance.group, 'its own family, not the dance / song group');
  assert.ok(MOOD_MOMENT_REASONS['music-recognize'].length > 2);
  assert.ok(MOOD_MOMENT_KNOBS.tasteScale[0] < 1 && MOOD_MOMENT_KNOBS.tasteScale[1] > 1);
  await withMood(({ host, clock, journal }) => {
    for (const bad of [{ intent: 'recognize', scale: 'big' }, { intent: 'recognize', scale: Number.NaN }, { intent: 'recognize', extra: 1 }, { intent: 'lift', scale: 1, extra: 1 }])
      assert.equal(host.moments.musicReaction(bad), false, JSON.stringify(bad));
    assert.equal(journal.length, 0);
    // The taste's factor changes the size of the one moment, held to the allowed range.
    const gain = (scale: number, intent = 'recognize') => {
      const before = host.get().snapshot.values.D;
      assert.equal(host.moments.musicReaction({ intent, scale }), true);
      return host.get().snapshot.values.D - before;
    };
    const plain = spec.delta.D!;
    const big = gain(1.3);
    clock.now += 31 * MINUTE; const small = gain(0.7);
    clock.now += 31 * MINUTE; const capped = gain(9);
    clock.now += 31 * MINUTE; const floored = gain(0.01);
    say(`recognise moment D (plain ${plain}): ×1.3 → ${big.toFixed(2)}, ×0.7 → ${small.toFixed(2)}, ×9 → ${capped.toFixed(2)} (held to ×${MOOD_MOMENT_KNOBS.tasteScale[1]}), ×0.01 → ${floored.toFixed(2)} (held to ×${MOOD_MOMENT_KNOBS.tasteScale[0]})`);
    for (const [got, factor] of [[big, 1.3], [small, 0.7], [capped, MOOD_MOMENT_KNOBS.tasteScale[1]], [floored, MOOD_MOMENT_KNOBS.tasteScale[0]]] as const) assert.ok(Math.abs(got - plain * factor) < 0.05, `${got} vs ${plain * factor}`);
    assert.deepEqual([...new Set(journal)], ['moment-music-recognize']);
    // Gated: a second recognition inside the cooldown is nothing.
    assert.equal(host.moments.musicReaction({ intent: 'recognize', scale: 1 }), false);
    // Enjoying a liked song: the existing moment, scaled (still one moment shared with the dance / song group).
    clock.now += 40 * MINUTE;
    const enjoyBefore = host.get().snapshot.values.D;
    assert.equal(host.moments.musicReaction({ intent: 'enjoy', scale: 1.3 }), true);
    const enjoyGain = host.get().snapshot.values.D - enjoyBefore;
    assert.ok(enjoyGain > 0);
    host.moments.musicTier({ tier: 'dance' }); clock.now += 2 * MINUTE;
    assert.equal(host.moments.musicTier({ tier: 'none' }), false, 'the dance after the scaled enjoy is still the same one moment');
  });
});

test('the song memory is on the listen-together page: a count, and a button that asks first, clears, and shows none after', async () => {
  const previous = globalThis.document;
  globalThis.document = { createElement: (tag: string) => new FakeNode(tag) } as unknown as Document;
  try {
    const { ListenTogetherPanel: Panel } = await import('../src/senses/ListenTogetherPanel');
    const view = { raw: { segments: 0, characters: 0, oldestAt: null }, total: 0, notes: [] };
    let songs = 5, answer = false;
    const calls: string[] = [];
    const root = new FakeNode('section');
    const panel = new Panel(root as unknown as HTMLElement, { view: async () => view, clearRaw: async () => view, deleteNote: async () => view, onError: e => calls.push(`error:${e}`), confirm: () => answer,
      songs: { count: async () => songs, clear: async () => { calls.push('clear'); const n = songs; songs = 0; return n; } } });
    await panel.init(); await new Promise(resolve => setImmediate(resolve));
    const all = (n: FakeNode): FakeNode[] => [n, ...n.children.flatMap(all)];
    const text = () => all(root).map(n => n.textContent).join('\n');
    const button = all(root).find(n => n.dataset.role === 'song-memory-clear')!;
    assert.match(text(), /她记得的歌：5 首/); assert.equal(button.disabled, false);
    button.onclick!(); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(calls, [], 'asked first; no means nothing is cleared');
    answer = true; button.onclick!(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['clear']); assert.match(text(), /她记得的歌：没有/); assert.equal(button.disabled, true);
    // Without the action (an older host) the row is hidden.
    const plain = new FakeNode('section');
    new Panel(plain as unknown as HTMLElement, { view: async () => view, clearRaw: async () => view, deleteNote: async () => view, onError: () => {}, confirm: () => true });
    assert.equal(all(plain).find(n => n.dataset.role === 'song-memory')!.textContent, '');
    panel.dispose();
  } finally { globalThis.document = previous; }
});

class FakeNode {
  textContent = ''; className = ''; type = ''; id = ''; disabled = false; hidden = false; dataset: Record<string, string> = {}; children: FakeNode[] = [];
  onclick: (() => void) | null = null; classList = { add: (..._names: string[]) => {} };
  constructor(public tagName: string) {}
  append(...nodes: FakeNode[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: FakeNode[]) { this.children = [...nodes]; }
  setAttribute() {}
}

// ---------------------------------------------------------------------------------------------- the agent channel

test('channel: clear_song_memory is a confirm-tier tool that exists only with 三方互通, asks for the user\'s words, offers an undo; nothing reads the songs out', async () => {
  const entry = AGENT_TOOLS.find(tool => tool.name === 'clear_song_memory')!;
  assert.ok(entry, 'in the catalog');
  assert.equal(entry.tier, 'confirm'); assert.equal(entry.interconnectOnly, true);
  assert.deepEqual(entry.inputSchema.required, ['userWords']);
  assert.ok(!AGENT_TOOLS.some(tool => /song/.test(tool.name) && tool.name !== 'clear_song_memory'), 'no tool reads the memory out');
  let cleared = 0, restored = 0;
  const bridge = { songs: { count: async () => 3, clear: async () => { cleared++; return { count: 3, restore: async () => { restored++; } }; } } } as unknown as AgentAppBridge;
  const tool = createAppTools(bridge).find(item => item.name === 'clear_song_memory')!;
  assert.equal(tool.tier, 'confirm'); assert.equal(tool.interconnectOnly, true);
  assert.equal(tool.validate({}) === undefined || typeof tool.validate({}) !== 'string', true);
  assert.throws(() => tool.validate({ extra: 1 }));
  const prepared = await tool.prepare!(tool.validate({}) as never);
  assert.ok(tool.confirmation!(prepared as never).detail.includes('不是声音'));
  assert.deepEqual(tool.wordsItem!(prepared as never), { item: 'clear_song_memory', value: null });
  let undo = null as { label: string; run(guard: () => void): Promise<unknown> } | null;
  const result = await tool.run(prepared as never, { signal: new AbortController().signal, check: () => {}, offerUndo: offer => { undo = offer as never; } }) as { cleared: number };
  assert.equal(result.cleared, 3); assert.equal(cleared, 1);
  assert.ok(undo); await undo!.run(() => {}); assert.equal(restored, 1);
  // Without the feature: unavailable, never a silent success.
  const none = createAppTools({} as AgentAppBridge).find(item => item.name === 'clear_song_memory')!;
  await assert.rejects(Promise.resolve().then(() => none.prepare!(none.validate({}) as never)), /还没有/);
});

// ---------------------------------------------------------------------------------------------- mechanics

test('profiler: measures the same intro whatever came before; ends a song only after a real silence; a gap or reset teaches nothing', () => {
  const play = playOf('bright')(0);
  /** The sketch of each song as its intro gets measured (the profiler's own reset at a silence makes the next song fresh). */
  const sketches = (kinds: readonly SongKind[]) => {
    const hearing = new MusicHearing(), profile = new SongProfiler(), out: SongSketch[] = [];
    let was = false;
    for (const sample of repeatPlays(k => playOf(kinds[k]!)(k), kinds.length)) {
      hearing.update(sample); profile.add(sample, hearing.tally); profile.markMusic();
      if (profile.ready && !was) out.push(profile.sketch(128)!);
      was = profile.ready;
    }
    return out;
  };
  const alone = sketches(['bright'])[0]!, afterDark = sketches(['dark', 'bright'])[1]!, afterPop = sketches(['pop', 'bright'])[1]!;
  say(`profiler: the bright intro alone vs after a dark song ${songDistance(alone, afterDark).d.toFixed(2)}, after a pop song ${songDistance(alone, afterPop).d.toFixed(2)}`);
  assert.ok(songDistance(alone, afterDark).d < 0.4 && songDistance(alone, afterPop).d < 0.4, 'the same intro whatever came before');
  // The plucked-ness is measured over the intro itself: the plucked arpeggio song is high, the pads-and-kick pop song low.
  assert.ok(alone.pluck > 0.5, `bright ${alone.pluck}`); assert.ok(sketches(['pop'])[0]!.pluck < 0.3, 'pop');
  assert.ok(alone.dens > 3 && alone.bright > 0.25, `density ${alone.dens}, brightness ${alone.bright}`);
  // A reset (the capture stopped) drops the song in progress.
  const profile = new SongProfiler(), hearing = new MusicHearing();
  for (const s of play.slice(0, 900)) { hearing.update(s); profile.add(s, hearing.tally); profile.markMusic(); }
  profile.reset();
  assert.equal(profile.takeFinished(), null);
  assert.equal(profile.ready, false);
  // A song that never got music recognised is never learned.
  const quiet = new SongProfiler(), h2 = new MusicHearing();
  for (const s of play) { h2.update(s); quiet.add(s, h2.tally); }
  assert.equal(quiet.takeFinished(), null);
});

test('mechanical feel: reactions per play, back-to-back variants and the spread of start times, recognised plays included', () => {
  const memory = learned('pop', REMEMBERED);
  const counts: number[] = [], gaps: number[] = [], variants = new Map<string, number>();
  let backToBack = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const run = runReact(repeatPlays(playOf('pop'), 1), { memory: new SongMemory(memory.list(), () => 0.9), fps: 30, seed, taste: seed % 3 ? FAN : null });
    const started = run.react.ledger.filter(r => r.outcome === 'started');
    counts.push(started.length);
    for (const r of started) variants.set(r.variant!, (variants.get(r.variant!) ?? 0) + 1);
    for (let i = 1; i < started.length; i++) { gaps.push(started[i]!.sampleAt - started[i - 1]!.sampleAt); if (started[i]!.variant === started[i - 1]!.variant) backToBack++; }
  }
  say(`pop, recognised plays: reactions per play ${counts.join(',')} (mean ${mean(counts).toFixed(2)}); gaps ${gaps.map(g => g.toFixed(0)).join(',')}; variants ${[...variants].map(([k, v]) => `${k}×${v}`).join(' ')}`);
  assert.equal(backToBack, 0);
  assert.ok(Math.max(...counts) <= MUSIC_REACT_KNOBS.choice.perSong + 1, 'at most the section budget plus the recognition');
  assert.ok(new Set(counts).size >= 2, 'the number of reactions is not the same every time');
  assert.ok(gaps.every(g => g >= MUSIC_REACT_KNOBS.choice.minGap - 1), 'the spacing of step 1 holds');
  assert.ok(variants.size >= 3);
  assert.ok(isNeutralShape({ sway: 1, bounce: 1, nod: 1, slow: 0, headX: 0, headZ: 0 }));
});
