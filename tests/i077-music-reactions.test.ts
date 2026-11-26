/**
 * I-077 step 1 (docs/claude/2026-11-11-i077-music-reactions.md): she reacts to the music, not only the beat.
 * All synthetic (tests/helpers/music-fixtures.ts `structuredSong`: intro → verse → chorus → bridge → chorus → outro; pop, bright and
 * plucky, slow and dark, ambient without drums), through the same path as the stage: PCM → the capture's analysers → ~30 Hz samples →
 * the music layer and the reaction director, on a 60 or 30 fps display clock (tests/helpers/music-react-run.ts).
 *  - hearing: section lifts and falls where the song changes; tone, brightness and the song's color tell the songs apart;
 *  - the beat clock: group starts on the beat, and on the bar once a section has started;
 *  - mechanical feel: reactions per song (≤ 2), the same variant never twice in a row, start times on the phrase, gaps not on one value;
 *  - none when it is not music, asleep, or when she does not choose ("一直跟着跳"); hormones move how often and how big;
 *  - the dance's shape is eased (no step), the song's style shows in it;
 *  - back to mood through the gated moments (enjoy shares the dance / song group: never counted twice);
 *  - the cost per sample.
 * I077_REPORT=1 prints the numbers in the record.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { samplesOf, scenes, structuredSong, type SongKind, type StructuredSong } from './helpers/music-fixtures';
import { concat, seconds } from './helpers/listen-audio';
import { runReact, type ReactRun } from './helpers/music-react-run';
import { MusicLikeness } from '../src/stage/music-likeness';
import { MusicHearing } from '../src/stage/music-react/hearing';
import { MusicReact, NEUTRAL_SHAPE, SHAPE_LIMITS, type MusicReactRecord } from '../src/stage/music-react/director';
import { MUSIC_RECIPES } from '../src/stage/music-react/recipes';
import { MUSIC_REACT_KNOBS } from '../src/stage/music-react/knobs';
import { SPEECH_FACE_KNOBS } from '../src/voice/speech-face/knobs';
import type { MusicEnergySample } from '../src/stage/music-dance';
import { MoodHost } from '../electron/mood/mood';
import { MOOD_MOMENTS, MOOD_MOMENT_REASONS } from '../shared/foundation/mood-moments';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/foundation/mood';
import { moodEventSource } from '../shared/memory/journal';
import { JournalExtras } from '../electron/memory/journal/extras';
import { FixedBoredomTiming } from '../shared/behaviors/boredom-timing/fake';
import { FixedTouchFeedEffect } from '../shared/behaviors/touch-feed-effect/fake';
import { FixedBlush } from '../shared/behaviors/blush/fake';

const REPORT = process.env.I077_REPORT === '1';
const KINDS: SongKind[] = ['pop', 'bright', 'dark', 'ambient'];
const songs = new Map<string, StructuredSong>();
const song = (kind: SongKind, seed = 77) => { const key = `${kind}|${seed}`; let s = songs.get(key); if (!s) songs.set(key, s = structuredSong(kind, seed)); return s; };
const sampleCache = new Map<string, MusicEnergySample[]>();
const samples = (s: StructuredSong, hz: number, seed = 0) => {
  const key = `${s.name}|${s.bars.length}|${s.pcm.length}|${s.pcm[1000]}|${hz}|${seed}`;
  let v = sampleCache.get(key); if (!v) sampleCache.set(key, v = samplesOf(s.pcm, { refreshHz: hz, seed: 7 + seed })); return v;
};
const started = (ledger: readonly MusicReactRecord[]) => ledger.filter(r => r.outcome === 'started');
const mean = (xs: readonly number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

/** The section changes a listener would name, with the direction of each. */
function boundaries(s: StructuredSong): { at: number; kind: 'lift' | 'fall' }[] {
  return s.sections.slice(1).map((section, i) => ({ at: section.from, kind: section.name === 'bridge' || section.name === 'outro' || (section.name === 'verse' && s.sections[i]!.name === 'chorus') ? 'fall' : 'lift' }));
}

/** Hearing alone (the music layer's period fed as the stage does). */
function hear(list: readonly MusicEnergySample[]) {
  const likeness = new MusicLikeness(), hearing = new MusicHearing(), base = list[0]!.time;
  const events: { kind: 'lift' | 'fall'; at: number; detectedAt: number; groupStart: number | null; lock: number }[] = [];
  for (const sample of list) {
    likeness.update(sample); const state = likeness.getState();
    hearing.setPeriod(state.music && state.last.beat >= 0.4 ? state.features?.period ?? 0 : 0); hearing.update(sample);
    for (const e of hearing.takeEvents()) {
      const g = hearing.clock.nextGroupStart(sample.time + 0.12);
      events.push({ kind: e.kind, at: e.at - base, detectedAt: e.detectedAt - base, groupStart: g === null ? null : g - base, lock: hearing.clock.confidence(sample.time) });
    }
  }
  return { events, state: hearing.state };
}

test('hearing: lifts and falls where the songs change section; few elsewhere (60 and 30 Hz)', () => {
  let found = 0, total = 0, onEdge = 0, events = 0;
  const lines: string[] = [];
  for (const kind of KINDS) for (const hz of [60, 30]) {
    const s = song(kind), { events: list } = hear(samples(s, hz)), edges = boundaries(s);
    const hit = edges.filter(b => list.some(e => e.kind === b.kind && Math.abs(e.at - b.at) <= 1)).length;
    const near = list.filter(e => edges.some(b => b.kind === e.kind && Math.abs(e.at - b.at) <= 1)).length;
    found += hit; total += edges.length; onEdge += near; events += list.length;
    lines.push(`${kind} ${hz} Hz: ${hit}/${edges.length} section changes heard; ${near}/${list.length} events at a change (${list.map(e => `${e.kind}@${e.at.toFixed(1)}`).join(' ')})`);
  }
  if (REPORT) console.log(lines.join('\n') + `\nall: ${found}/${total} heard, ${onEdge}/${events} events at a change`);
  assert.ok(found / total >= 0.75, `section changes heard ${found}/${total}`);
  assert.ok(onEdge / events >= 0.65, `events at a real change ${onEdge}/${events}`);
});

test('hearing: tone, brightness and the song\'s color tell a bright plucky song from a slow dark one', () => {
  const at = (kind: SongKind) => hear(samples(song(kind), 60)).state;
  const bright = at('bright'), dark = at('dark'), ambient = at('ambient'), pop = at('pop');
  if (REPORT) for (const [name, s] of Object.entries({ bright, pop, dark, ambient }))
    console.log(`${name}: pluck ${s.pluck.toFixed(2)} brightness ${s.brightness.toFixed(2)} bass ${s.bass.toFixed(2)} color ${s.color.toFixed(2)} density ${s.density.toFixed(1)}/s bpm ${s.bpm?.toFixed(0) ?? '—'}`);
  assert.ok(bright.pluck >= 0.6 && dark.pluck <= 0.3 && ambient.pluck <= 0.3, `pluck ${bright.pluck} / ${dark.pluck} / ${ambient.pluck}`);
  assert.ok(bright.brightness >= 0.6 && dark.brightness <= 0.1, `brightness ${bright.brightness} / ${dark.brightness}`);
  assert.ok(bright.color >= MUSIC_REACT_KNOBS.choice.bright && dark.color <= MUSIC_REACT_KNOBS.choice.dark && ambient.color <= MUSIC_REACT_KNOBS.choice.dark, `color ${bright.color} / ${dark.color} / ${ambient.color}`);
  assert.ok(pop.color > dark.color && pop.color < bright.color, `pop in between (${pop.color})`);
});

test('beat clock: a group of four starts on the beat; right after a section change, on the bar', () => {
  let n = 0, beat = 0, bar = 0;
  for (const kind of ['pop', 'bright'] as SongKind[]) for (const hz of [60, 30]) {
    const s = song(kind), period = 60 / s.bpm;
    for (const e of hear(samples(s, hz)).events) {
      if (e.lock < 0.6 || e.groupStart === null) continue;
      n++;
      const offBeat = e.groupStart - Math.round(e.groupStart / period) * period, offBar = e.groupStart - Math.round(e.groupStart / (4 * period)) * 4 * period;
      if (Math.abs(offBeat) <= 0.08) beat++;
      if (Math.abs(offBar) <= 0.08) bar++;
    }
  }
  if (REPORT) console.log(`group starts after a section change (beat locked): on a true beat ${beat}/${n}, on a true bar ${bar}/${n}`);
  assert.ok(n >= 8, `locked events ${n}`);
  assert.equal(beat, n, 'every group start sits on a beat');
  assert.ok(bar / n >= 0.75, `on the bar ${bar}/${n}`);
});

/** A listening session: these songs one after another (4 s of silence between), through one director. */
function session(kinds: readonly SongKind[], options: Parameters<typeof runReact>[1] & { hz?: number; fixtureSeed?: number } = {}) {
  const list: MusicEnergySample[] = [], spans: { kind: SongKind; from: number; to: number; song: StructuredSong }[] = [];
  let offset = 0;
  kinds.forEach((kind, i) => {
    const s = song(kind, (options.fixtureSeed ?? 77) + i), part = samples(s, options.hz ?? 60), base = part[0]!.time;
    for (const sample of part) list.push({ ...sample, time: 1000 + offset + (sample.time - base) });
    const length = part.at(-1)!.time - base;
    spans.push({ kind, from: offset, to: offset + length, song: s });
    for (let t = 1 / 30; t < 4; t += 1 / 30) list.push({ time: 1000 + offset + length + t, rms: 0, low: 0, mid: 0, high: 0 });
    offset += length + 4;
  });
  const run = runReact(list, { fps: options.hz ?? 60, ...options });
  return { run, spans };
}

test('mechanical feel: sparse (≤ 2 a song, some none), varied (never the same variant twice running), on the phrase, gaps not on one value', () => {
  const perSong: number[] = [], gaps: number[] = [], variants: Record<string, number> = {}, intents: Record<string, number> = {};
  let repeats = 0, aligned = 0, onBeat = 0, onBar = 0, gentle = 0, startedAll = 0, songCount = 0;
  const order: SongKind[] = ['pop', 'bright', 'dark', 'ambient', 'pop', 'bright'];
  for (const hz of [60, 30]) for (const seed of [1, 2, 3, 4]) for (const temper of [{}, { D: 0.3, N: 0.3 }]) {
    const { run, spans } = session(order, { hz, seed, temper, fixtureSeed: 70 + seed });
    const list = started(run.react.ledger);
    startedAll += list.length;
    for (const span of spans) { songCount++; perSong.push(list.filter(r => r.startAt! - 1000 >= span.from && r.startAt! - 1000 <= span.to + 3).length); }
    for (let i = 1; i < list.length; i++) { if (list[i]!.variant === list[i - 1]!.variant) repeats++; gaps.push(list[i]!.startAt! - list[i - 1]!.startAt!); }
    for (const r of list) {
      variants[r.variant!] = (variants[r.variant!] ?? 0) + 1; intents[r.intent!] = (intents[r.intent!] ?? 0) + 1;
      if (!r.aligned) { gentle++; continue; }
      aligned++;
      const t = r.startAt! - 1000, span = spans.find(s => t >= s.from - 0.5 && t <= s.to + 3)!, local = t - span.from, period = 60 / span.song.bpm;
      if (Math.abs(local - Math.round(local / period) * period) <= 0.08) onBeat++;
      if (Math.abs(local - Math.round(local / (4 * period)) * 4 * period) <= 0.08) onBar++;
    }
  }
  const histogram = [0, 1, 2, 3].map(k => perSong.filter(n => n === k).length);
  const buckets = new Map<number, number>(); for (const g of gaps) buckets.set(Math.round(g), (buckets.get(Math.round(g)) ?? 0) + 1);
  const topBucket = Math.max(...buckets.values()) / gaps.length;
  const cv = Math.sqrt(mean(gaps.map(g => (g - mean(gaps)) ** 2))) / mean(gaps);
  if (REPORT) {
    console.log(`songs ${songCount}: reactions per song 0/1/2/3+ = ${histogram.join('/')} (mean ${mean(perSong).toFixed(2)}); started ${startedAll}`);
    console.log(`same variant back to back: ${repeats}; aligned ${aligned} (on a true beat ${onBeat}, on a true bar ${onBar}), gentle at the change ${gentle}`);
    console.log(`gaps between reactions: n ${gaps.length}, mean ${mean(gaps).toFixed(1)} s, min ${Math.min(...gaps).toFixed(1)}, max ${Math.max(...gaps).toFixed(1)}, CV ${cv.toFixed(2)}, most common 1-s bucket ${(topBucket * 100).toFixed(0)}%`);
    console.log(`intents ${JSON.stringify(intents)}; variants ${JSON.stringify(variants)}`);
  }
  assert.ok(perSong.every(n => n <= MUSIC_REACT_KNOBS.choice.perSong), `at most ${MUSIC_REACT_KNOBS.choice.perSong} a song (${histogram})`);
  assert.ok(histogram[0]! > 0 && histogram[1]! > 0, `some songs pass without one, some have one (${histogram})`);
  assert.equal(repeats, 0, 'never the same variant twice in a row');
  assert.ok(aligned >= 10 && onBeat / aligned >= 0.95, `aligned starts on the beat ${onBeat}/${aligned}`);
  assert.ok(onBar / aligned >= 0.75, `aligned starts on the bar ${onBar}/${aligned}`);
  assert.ok(cv >= 0.3 && topBucket <= 0.35, `gaps spread (CV ${cv.toFixed(2)}, top bucket ${topBucket.toFixed(2)})`);
  assert.ok(Object.keys(variants).length >= 8, `variety: ${Object.keys(variants).length} variants used`);
  assert.ok(Object.keys(intents).length === 4, `all four intents occur: ${JSON.stringify(intents)}`);
});

test('not music (dialogue, dialogue over a quiet beat): no reaction, the shape exactly neutral, no tint', () => {
  // I-072's two dialogue scenes (pure dialogue; dialogue over a beat 12 dB down), which the music layer keeps out of music.
  for (const scene of scenes().filter(x => x.kind === 'dialogue')) for (const hz of [60, 30]) {
    const pcm = scene.pcm;
    const run = runReact(samplesOf(pcm, { refreshHz: hz }), { fps: hz, temper: { D: 0.5, N: 0.5 } });
    assert.equal(run.frames.filter(f => f.music).length, 0, 'the music layer says not music');
    assert.equal(started(run.react.ledger).length + run.moments.length + run.faces.length, 0);
    assert.ok(run.frames.every(f => JSON.stringify(f.shape) === JSON.stringify(NEUTRAL_SHAPE) && f.tint.smileEyes === 0 && f.tint.lidSoft === 0));
  }
});

test('she does not choose ("一直跟着跳", paused) or is asleep: nothing at all, every frame', () => {
  for (const options of [{ on: false }, { temper: { sleepy: 1 } }]) {
    const { run } = session(['pop', 'bright'], options);
    assert.equal(started(run.react.ledger).length + run.moments.length + run.faces.length, 0, JSON.stringify(options));
    assert.ok(run.frames.every(f => JSON.stringify(f.shape) === JSON.stringify(NEUTRAL_SHAPE) && f.tint.smileEyes === 0 && f.tint.lidSoft === 0), JSON.stringify(options));
  }
});

test('hormones relative to her baseline: N with D up → more and bigger; drowsy (A) or stressed (C) → fewer and smaller', () => {
  const measure = (temper: Record<string, number>) => {
    let count = 0; const sizes: number[] = [];
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const { run } = session(['pop', 'bright', 'dark'], { seed, temper, fixtureSeed: 90 });
      const list = started(run.react.ledger); count += list.length; sizes.push(...list.map(r => r.size!));
    }
    return { count, size: mean(sizes) };
  };
  const calm = measure({}), lively = measure({ D: 0.5, N: 0.5 }), drowsy = measure({ sleepy: 0.7 }), stressed = measure({ C: 0.6, N: 0.4 });
  if (REPORT) console.log(`reactions (18 songs) and mean size: baseline ${calm.count} / ${calm.size.toFixed(2)}; N+D up ${lively.count} / ${lively.size.toFixed(2)}; drowsy ${drowsy.count} / ${drowsy.size.toFixed(2)}; stressed (C, N with C) ${stressed.count} / ${stressed.size.toFixed(2)}`);
  assert.ok(lively.count >= calm.count && lively.size > calm.size * 1.1, JSON.stringify({ calm, lively }));
  assert.ok(drowsy.count < calm.count && drowsy.size < calm.size * 0.85, JSON.stringify({ calm, drowsy }));
  assert.ok(stressed.count <= calm.count && stressed.size < calm.size * 0.9, JSON.stringify({ calm, stressed }));
});

test('style: a bright plucky song bounces lighter and more, a slow dark one sways slowly; every change of the shape is eased', () => {
  const style = (kind: SongKind, fps: number) => {
    // The style alone: a director whose every roll says "let it pass" (no reaction ever starts).
    const run = runReact(samples(song(kind), fps), { fps, on: true, temper: { sleepy: 0 } }, new MusicReact(() => 0.999));
    assert.equal(started(run.react.ledger).length, 0);
    const quiet = run.frames.filter(f => f.music && f.t > 20);
    let step = 0, kink = 0;
    for (let i = 2; i < run.frames.length; i++) for (const key of ['sway', 'bounce', 'nod', 'slow', 'headX', 'headZ'] as const) {
      const a = run.frames[i - 2]!.shape[key], b = run.frames[i - 1]!.shape[key], c = run.frames[i]!.shape[key];
      step = Math.max(step, Math.abs(c - b)); kink = Math.max(kink, Math.abs(c - 2 * b + a));
    }
    return { bounce: mean(quiet.map(f => f.shape.bounce)), slow: mean(quiet.map(f => f.shape.slow)), step, kink };
  };
  for (const fps of [60, 30]) {
    const bright = style('bright', fps), dark = style('dark', fps);
    if (REPORT) console.log(`${fps} fps: bright bounce ×${bright.bounce.toFixed(2)} slow sway ${bright.slow.toFixed(2)}; dark bounce ×${dark.bounce.toFixed(2)} slow sway ${dark.slow.toFixed(2)}; largest per-frame change ${Math.max(bright.step, dark.step).toFixed(4)}, largest change of speed ${Math.max(bright.kink, dark.kink).toFixed(5)}`);
    assert.ok(bright.bounce > 1.1 && bright.slow < 0.1, JSON.stringify(bright));
    assert.ok(dark.bounce < 0.9 && dark.slow > 0.4, JSON.stringify(dark));
    // Eased: per frame at most a few hundredths of the multiplier, and its speed changes by far less (no corner).
    const k = 60 / fps;
    assert.ok(Math.max(bright.step, dark.step) <= 0.02 * k && Math.max(bright.kink, dark.kink) <= 0.002 * k * k, JSON.stringify({ bright, dark }));
  }
});

test('recipes: every envelope starts and ends at rest; face parts stay under the caps; heads under the shape limits', () => {
  const caps = { ...SPEECH_FACE_KNOBS.hard.caps, ...SPEECH_FACE_KNOBS.hard.musicCaps } as Record<string, number>;
  for (const [intent, list] of Object.entries(MUSIC_RECIPES)) {
    assert.ok(list.length >= 2, `${intent} has 2–3 variants`);
    for (const v of list) for (const keys of [v.face?.keys, v.head?.keys, v.dance?.keys].filter(Boolean)) {
      assert.equal(keys![0]![1], 0, v.id); assert.equal(keys!.at(-1)![1], 0, v.id);
      if (v.face) assert.ok(v.face.amp[1] <= caps[v.face.slider]! + 1e-9, `${v.id} under its cap (the layer clamps a bigger pick to it)`);
      if (v.head) assert.ok(Math.abs(v.head.x) <= SHAPE_LIMITS.headX && Math.abs(v.head.z) <= SHAPE_LIMITS.headZ, v.id);
      assert.ok(!/mouth|jaw/i.test(String(v.face?.slider ?? '')), v.id);
    }
  }
});

// ------------------------------------------------------------------------------------------------ back to mood

const MINUTE = 60_000, T0 = Date.UTC(2026, 10, 11, 4, 0, 0);
async function withHost(run: (c: { host: MoodHost; clock: { now: number }; journal: string[] }) => Promise<void> | void) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-i077-'));
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
const values = (host: MoodHost) => ({ ...host.get().snapshot.values });

test('back to mood: lift → a short N bump; settle → E; moved → O up, E down; gated; only { intent } with a known intent', async () => {
  await withHost(({ host, clock, journal }) => {
    // Malformed facts first, while every gate is open: none of them moves her.
    for (const bad of [null, 'lift', { intent: 'dance' }, { intent: 'lift', extra: 1 }, ['lift'], { intent: 5 }]) assert.equal(host.moments.musicReaction(bad), false, JSON.stringify(bad));
    assert.equal(journal.length, 0);
    let before = values(host);
    assert.equal(host.moments.musicReaction({ intent: 'lift' }), true);
    let after = values(host);
    assert.ok(after.N > before.N + 1 && after.D === before.D && after.E === before.E, `lift: N ${before.N}→${after.N}`);
    assert.equal(host.moments.musicReaction({ intent: 'lift' }), false, 'a second lift inside the cooldown');
    before = values(host);
    assert.equal(host.moments.musicReaction({ intent: 'settle' }), true);
    after = values(host);
    assert.ok(after.E > before.E + 1 && after.N === before.N, `settle: E ${before.E}→${after.E}`);
    before = values(host);
    assert.equal(host.moments.musicReaction({ intent: 'moved' }), true);
    after = values(host);
    assert.ok(after.O > before.O + 0.5 && after.E < before.E - 0.5, `moved: O ${before.O}→${after.O}, E ${before.E}→${after.E}`);
    assert.equal(host.get().snapshot.reason, MOOD_MOMENT_REASONS['music-moved']);
    assert.deepEqual(journal, ['moment-music-lift', 'moment-music-settle', 'moment-music-moved']);
    clock.now += 9 * MINUTE;
    assert.equal(host.moments.musicReaction({ intent: 'lift' }), true, 'after the cooldown');
  });
});

test('back to mood: enjoying a song and then dancing to it is one moment, never two (the dance / song group)', async () => {
  await withHost(({ host, clock, journal }) => {
    assert.equal(MOOD_MOMENTS['music-enjoy'].group, MOOD_MOMENTS.dance.group);
    const before = values(host);
    assert.equal(host.moments.musicReaction({ intent: 'enjoy' }), true);
    const after = values(host);
    assert.ok(after.D > before.D + 1 && after.E > before.E + 1, `enjoy: D ${before.D}→${after.D}, E ${before.E}→${after.E}`);
    host.moments.musicTier({ tier: 'dance' });
    clock.now += 2 * MINUTE;
    assert.equal(host.moments.musicTier({ tier: 'none' }), false, 'the dance that followed is the same moment');
    assert.deepEqual(journal, ['moment-music-enjoy']);
  });
});

test('the pet window\'s fact reaches the moments (only from the pet window)', () => {
  const seen: unknown[] = [];
  const extras = new JournalExtras({ sink: { record: () => null } as never, characterId: () => 'gene', engine: () => 'local', uptimeMs: () => 1, blushStage: () => {},
    musicReaction: value => { seen.push(value); return true; } });
  assert.equal(extras.fact('music-reaction', { intent: 'lift' }, true), true);
  assert.equal(extras.fact('music-reaction', { intent: 'lift' }, false), false);
  assert.deepEqual(seen, [{ intent: 'lift' }]);
});

test('every reaction that starts is told once (the stage sends it to the host); the cost per sample is small', () => {
  const { run } = session(['pop', 'bright', 'dark', 'ambient'], { seed: 5, temper: { D: 0.4, N: 0.4 } });
  const list = started(run.react.ledger);
  assert.deepEqual(run.moments.map(m => m.intent), list.map(r => r.intent));
  assert.ok(list.length >= 2);
  // Cost: the hearing on every sample (the director's frame is per display frame and cheaper still).
  const pcm = concat(song('pop').pcm, seconds(1)), list2 = samplesOf(pcm, { refreshHz: 60 });
  const react = new MusicReact(undefined, 1);
  for (let i = 0; i < 3; i++) for (const s of list2) react.hear({ ...s, time: s.time + i * 200 }); // warm-up and repeat
  const t0 = process.hrtime.bigint();
  for (let i = 3; i < 13; i++) for (const s of list2) react.hear({ ...s, time: s.time + i * 200 });
  const us = Number(process.hrtime.bigint() - t0) / 1000 / (10 * list2.length);
  const frameT0 = process.hrtime.bigint(); let frames = 0;
  const ctx = { on: true, music: true, moving: true, speaking: false, temper: { D: 0, O: 0, E: 0, N: 0, C: 0, sleepy: 0 }, dispositions: { lively: 50, restrained: 50, volatile: 50, shy: 50, clingy: 50 }, period: 0.6, beatScore: 1 };
  for (let i = 0; i < 20_000; i++) { react.frame(1 / 60, ctx); frames++; }
  const frameUs = Number(process.hrtime.bigint() - frameT0) / 1000 / frames;
  if (REPORT) console.log(`cost: hearing ${us.toFixed(2)} µs per sample (${(us * 30 / 1000).toFixed(3)} ms per second of sound); director ${frameUs.toFixed(2)} µs per frame`);
  assert.ok(us < 25 && frameUs < 25, `${us} µs / sample, ${frameUs} µs / frame`);
});

export type { ReactRun };
