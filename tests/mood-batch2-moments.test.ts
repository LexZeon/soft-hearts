/**
 * Mood batch 2 (docs/claude/2026-11-11-mood-batch2.md): moments that read her mood now come back to it, each a small lift with its
 * own id family, a cooldown and a per-day count (cannot be farmed), read relative to the card's baseline. Synthetic only: an
 * isolated temporary profile, no model call, no real profile.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { MoodHost } from '../electron/mood/mood';
import { MoodMoments, type MoodMomentLift } from '../electron/mood/mood-moments';
import {
  BackWatch, MOOD_MOMENTS, MOOD_MOMENT_KINDS, MOOD_MOMENT_KNOBS, MOOD_MOMENT_REASONS, MOOD_TAILLESS_BY_LABEL, MoodMomentGate, MusicWatch, SleepWatch,
  relativeMomentDelta,
} from '../shared/foundation/mood-moments';
import {
  DEFAULT_MOOD_PARAMETERS, MOOD_LABEL_IDS, applyMoodLift, createMoodState, getMoodSnapshot, moodLevel, type MoodParameters, type MoodValues,
} from '../shared/foundation/mood';
import { moodValueForLevel } from '../shared/foundation/mood-presets';
import { moodEventSource, MOOD_EVENT_SOURCES } from '../shared/memory/journal';
import { ENGLISH_JOURNAL_UI_COPY as JOURNAL_EN } from '../shared/foundation/ui-copy.journal.en';
import { createFatigue, fatigueTerms, DEFAULT_FATIGUE_PARAMETERS } from '../shared/mood/fatigue';
import { planMoodHold } from '../shared/behaviors/upcoming/mood-gate';
import { FixedBoredomTiming } from '../shared/behaviors/boredom-timing/fake';
import { FixedTouchFeedEffect } from '../shared/behaviors/touch-feed-effect/fake';
import { FixedBlush } from '../shared/behaviors/blush/fake';

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const T0 = Date.UTC(2026, 10, 11, 4, 0, 0);
const P = DEFAULT_MOOD_PARAMETERS;
const base = (): MoodValues => ({ D: 50, O: 50, E: 50, N: 50, C: 50 });

// ------------------------------------------------------------------------------------------------ pure parts

test('relative to the card baseline: full at the baseline, less past the soft line, nothing past the hard line; drops mirror it', () => {
  const { soft, hard } = MOOD_MOMENT_KNOBS;
  assert.deepEqual(relativeMomentDelta({ O: 2, D: 2 }, base(), base()), { O: 2, D: 2 });
  const mid = moodValueForLevel((soft + hard) / 2, 50, 1), high = moodValueForLevel(hard + 1, 50, 1);
  assert.deepEqual(relativeMomentDelta({ O: 2, D: 2 }, { ...base(), O: mid, D: high }, base()), { O: 1 }, 'half past the soft line: half; past hard: none');
  const low = moodValueForLevel(100 - hard - 1, 50, 1);
  assert.deepEqual(relativeMomentDelta({ C: -3, E: 3 }, { ...base(), C: low }, base()), { E: 3 }, 'C already far below its baseline does not drop further');
  // A card whose baseline E is 70: E at 70 is "at the baseline" (full); the same 70 on a 50 card is already past the soft line.
  const card70 = { ...base(), E: 70 };
  assert.deepEqual(relativeMomentDelta({ E: 2 }, { ...base(), E: 70 }, card70), { E: 2 });
  assert.ok((relativeMomentDelta({ E: 2 }, { ...base(), E: 70 }, base()).E ?? 0) < 2);
  assert.ok(moodLevel(70, 50) > soft, 'the example sits past the soft line on a 50 card');
});

test('the gate: a cooldown and a per-day count per character and family; dance and song share one; characters do not', () => {
  const gate = new MoodMomentGate(), back = MOOD_MOMENTS.back;
  assert.equal(gate.take('a', back, T0), true);
  assert.equal(gate.take('a', back, T0 + back.cooldownMs - 1), false, 'inside the cooldown');
  assert.equal(gate.take('b', back, T0 + 1), true, 'another character has its own');
  let at = T0;
  for (let i = 1; i < back.perDay; i++) { at += back.cooldownMs; assert.equal(gate.take('a', back, at), true, `return ${i + 1}`); }
  assert.equal(gate.take('a', back, at + back.cooldownMs), false, 'the day\'s count is used up');
  const g2 = new MoodMomentGate();
  assert.equal(g2.take('a', MOOD_MOMENTS.dance, T0), true);
  assert.equal(g2.take('a', MOOD_MOMENTS.song, T0 + 60_000), false, 'a song right after a dance is the same moment');
  assert.equal(g2.take('a', MOOD_MOMENTS.song, T0 + MOOD_MOMENTS.song.cooldownMs), true);
});

test('watchers: a real sleep (micro-wakes inside it) ends once; a dance or a nod-along that ended; the first view of one return', () => {
  const sleep = new SleepWatch();
  assert.equal(sleep.see('a', 'awake', 0, T0), null);
  assert.equal(sleep.see('a', 'asleep', 5 * MINUTE, T0), null, 'first seen asleep 5 minutes in');
  assert.equal(sleep.see('a', 'micro-awake', 0, T0 + 10 * MINUTE), null, 'a micro-wake is still the sleep');
  assert.equal(sleep.see('a', 'asleep', 0, T0 + 11 * MINUTE), null);
  assert.equal(sleep.see('a', 'light-drowsy', 0, T0 + 20 * MINUTE), 25 * MINUTE, 'the sleep counts from its start (age)');
  assert.equal(sleep.see('a', 'awake', 0, T0 + 21 * MINUTE), null, 'once');
  assert.equal(sleep.see('a', 'falling-asleep', 0, T0 + 22 * MINUTE), null, 'falling asleep and back is no sleep');
  assert.equal(sleep.see('a', 'drowsy', 0, T0 + 23 * MINUTE), null);

  const music = new MusicWatch();
  assert.equal(music.see('a', 'dance', T0), null);
  assert.equal(music.see('a', 'none', T0 + MOOD_MOMENT_KNOBS.danceMinMs - 1), null, 'too short a dance');
  assert.equal(music.see('a', 'dance', T0 + 30_000), null);
  assert.deepEqual(music.see('a', 'nod', T0 + 30_000 + MOOD_MOMENT_KNOBS.danceMinMs), { kind: 'dance', ms: MOOD_MOMENT_KNOBS.danceMinMs });
  assert.deepEqual(music.see('a', 'none', T0 + 30_000 + MOOD_MOMENT_KNOBS.danceMinMs + MOOD_MOMENT_KNOBS.songMinMs), { kind: 'song', ms: MOOD_MOMENT_KNOBS.songMinMs });
  assert.equal(music.see('b', 'nod', T0 + 400_000), null);
  assert.equal(music.see('a', 'none', T0 + 900_000), null, 'another character in between: nothing is carried over');

  const back = new BackWatch(), away = MOOD_MOMENT_KNOBS.backAwayMinutes;
  assert.equal(back.see({ presence: 'back', awayMinutes: away - 1 }), null, 'too short an absence');
  assert.equal(back.see({ presence: 'idle' }), null);
  assert.equal(back.see({ presence: 'back', awayMinutes: away + 5 }), away + 5);
  assert.equal(back.see({ presence: 'back', awayMinutes: away + 5 }), null, 'the same return, next second');
  assert.equal(back.see({ presence: 'away' }), null);
  assert.equal(back.see({ presence: 'back', awayMinutes: 30, pretended: true }), null, '"回来了" said by test words is not a return');
});

test('keepReason: an after-effect moves the numbers and keeps the cause (害怕 stays 害怕; the reason line is unchanged)', () => {
  const state = createMoodState(T0, P);
  for (const [c, level] of [['N', 58], ['C', 58], ['E', 44]] as const) state.values[c] = moodValueForLevel(level, 50, 1);
  state.reason = { text: '你说的话吓到她了', at: T0, context: 'fright', eventId: 'scare-1' };
  assert.equal(getMoodSnapshot(state, T0, P).primary, 'afraid');
  const kept = applyMoodLift(state, { id: 'moment-tailless-m1', delta: MOOD_TAILLESS_BY_LABEL.afraid, reason: MOOD_MOMENT_REASONS.tailless, keepReason: true }, T0 + 1_000, P);
  assert.equal(kept.reason?.eventId, 'scare-1'); assert.equal(kept.reason?.context, 'fright');
  assert.ok(kept.values.E > state.values.E - 0.01 && kept.values.C < state.values.C, 'E up a little, C down a little');
  assert.equal(getMoodSnapshot(kept, T0 + 1_000, P).primary, 'afraid', 'still afraid: a tiny stand-in does not end a fright');
  const taken = applyMoodLift(state, { id: 'moment-x', delta: { E: 0.5 }, reason: '别的', context: 'positive' }, T0 + 1_000, P);
  assert.equal(taken.reason?.eventId, 'moment-x', 'without keepReason the lift is the reason, as before');
});

test('tailless: one small lift per label (≤ 1 per channel, none bigger than Opus\'s share of a tail), every label covered', () => {
  for (const label of MOOD_LABEL_IDS) {
    const delta = MOOD_TAILLESS_BY_LABEL[label];
    assert.ok(delta && Object.keys(delta).length > 0, label);
    for (const n of Object.values(delta)) assert.ok(Math.abs(n!) <= 1, `${label}: ${n}`);
  }
  assert.ok(Object.values(MOOD_MOMENTS).every(spec => Object.values(spec.delta).every(n => Math.abs(n!) <= 3)), 'moments stay at a fraction of one tail (±6)');
});

test('journal: every moment reason maps to its own closed source with Chinese and English words', () => {
  for (const kind of MOOD_MOMENT_KINDS) {
    const source = moodEventSource('lift', MOOD_MOMENT_REASONS[kind]);
    assert.equal(source, `moment-${kind}`);
    assert.ok((MOOD_EVENT_SOURCES as readonly string[]).includes(source));
  }
  assert.equal(moodEventSource('lift', 'anything else'), 'lift-other');
  const en = JOURNAL_EN as Record<string, string>;
  for (const words of ['你回到电脑前，她有点开心', '她睡醒了，轻松了些', '跳完一段舞，心情好了些', '听完一首喜欢的歌，心情好了些', '说起你的特别的日子，她很开心',
    '给你留了点东西，心里轻了些', '写完日记，心里轻了些', '害羞了一下，心里暖暖的', '回了你一句，心情跟着动了一点']) assert.ok(en[words], words);
});

test('sleepiness: closeness and now comfort make her a little sleepier; reward and arousal keep her up; the hormone cap holds', () => {
  const clock = { monotonicMs: 0, localMinute: 600 }, s = createFatigue(clock);
  const term = (channels: Partial<MoodValues>) => fatigueTerms(s, { clock, channels: { ...base(), ...channels }, baseline: base(), blockers: { chat: false, tts: false, manualMotion: false }, mode: 'active' }).mood;
  assert.equal(term({}), 0);
  assert.ok(term({ E: 75 }) > 0, `comfort → sleepier (was −0.0075, now ${term({ E: 75 })})`);
  assert.ok(term({ O: 75 }) > 0, 'closeness → sleepier (kept)');
  assert.ok(term({ E: 75 }) < term({ O: 75 }), 'comfort a little less than closeness');
  assert.ok(term({ D: 75 }) < 0 && term({ N: 75 }) < 0, 'reward and arousal keep her up (kept)');
  assert.ok(term({ E: 25 }) < 0, 'discomfort now keeps her up a little');
  assert.equal(term({ D: 0, N: 0, O: 100, E: 100, C: 100 }), DEFAULT_FATIGUE_PARAMETERS.hormoneCap, 'the cap holds');
});

test('P-001 plans: not brought up while C is high or E is low relative to the card baseline', () => {
  assert.equal(planMoodHold(base(), base()), null);
  assert.equal(planMoodHold({ ...base(), C: moodValueForLevel(58, 50, 1) }, base()), 'stress');
  assert.equal(planMoodHold({ ...base(), E: moodValueForLevel(42, 50, 1) }, base()), 'uneasy');
  // A card resting at C 65: C 65 is her normal, not stress.
  assert.equal(planMoodHold({ ...base(), C: 65 }, { ...base(), C: 65 }), null);
  assert.equal(planMoodHold({ ...base(), C: 65 }, base()), 'stress');
});

// ------------------------------------------------------------------------------------------------ the host

async function withHost(run: (c: { host: MoodHost; clock: { now: number }; journal: { source: string; id?: string }[] }) => Promise<void> | void, card: MoodParameters = P) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-mood-batch2-'));
  const clock = { now: T0 };
  const host = new MoodHost(directory, () => {}, () => clock.now, { boredomTiming: new FixedBoredomTiming(), touchFeedEffect: new FixedTouchFeedEffect(), blush: new FixedBlush() });
  const journal: { source: string }[] = [];
  try {
    await host.load();
    host.activate('gene', structuredClone(card));
    host.setJournalObserver(event => { journal.push({ source: moodEventSource(event.type as 'lift', event.reason) }); });
    await run({ host, clock, journal });
  } finally {
    await host.flush().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}
const values = (host: MoodHost) => ({ ...host.get().snapshot.values });
const tick = (host: MoodHost, clock: { now: number }, ms: number) => { for (let t = 0; t < ms; t += 1_000) { clock.now += 1_000; host.tick(true); } };

test('host: a return lifts O and D once; the reason says so; the next return inside the cooldown does nothing', async () => {
  await withHost(({ host, clock, journal }) => {
    const before = values(host);
    assert.equal(host.moments.presence({ presence: 'back', awayMinutes: 25 }), true);
    const after = values(host);
    assert.ok(after.O > before.O + 1.5 && after.D > before.D + 1.5, `O ${before.O}→${after.O}, D ${before.D}→${after.D}`);
    assert.equal(after.E, before.E); assert.equal(after.C, before.C);
    assert.equal(host.get().snapshot.reason, MOOD_MOMENT_REASONS.back);
    assert.deepEqual(journal.map(j => j.source), ['moment-back']);
    host.moments.presence({ presence: 'idle' });
    tick(host, clock, 5 * MINUTE);
    assert.equal(host.moments.presence({ presence: 'back', awayMinutes: 40 }), false, 'a second return 5 minutes later');
    assert.equal(host.moments.arrive('gene', 30 * MINUTE), false, 'the camera seeing the same return is the same family');
    assert.equal(host.moments.arrive('gene', null), false, 'an arrival of unknown absence (a simulation) never counts');
  });
});

test('host: waking from a real sleep lifts E, lowers C and N (her real phase, not the test look); a short nap does not', async () => {
  await withHost(({ host, clock, journal }) => {
    const fatigue = (host as unknown as { fatigue: { realPhase: (id?: string) => { phase: string; phaseAgeMs: number } | undefined } }).fatigue;
    let phase = { phase: 'asleep', phaseAgeMs: 2 * MINUTE };
    fatigue.realPhase = () => ({ ...phase });
    tick(host, clock, 3_000);
    phase = { phase: 'awake', phaseAgeMs: 0 };
    tick(host, clock, 3_000);
    assert.equal(journal.length, 0, 'a nap of a few minutes is not a sleep');
    phase = { phase: 'asleep', phaseAgeMs: 0 };
    tick(host, clock, 3_000);
    tick(host, clock, MOOD_MOMENT_KNOBS.wakeMinSleepMs);
    const before = values(host);
    phase = { phase: 'light-drowsy', phaseAgeMs: 0 };
    tick(host, clock, 1_000);
    const after = values(host);
    assert.deepEqual(journal.map(j => j.source), ['moment-wake']);
    assert.ok(after.E > before.E + 2 && after.C < before.C - 2 && after.N < before.N - 1, JSON.stringify({ before, after }));
    assert.equal(host.get().snapshot.reason, MOOD_MOMENT_REASONS.wake);
    assert.equal(host.get().snapshot.context, 'neutral', 'waking is no positive moment of its own (no face of its own)');
  });
});

test('host: a dance that ended lifts D, E and a short N bump that decays within minutes; the song right after is the same moment', async () => {
  await withHost(({ host, clock, journal }) => {
    const before = values(host);
    host.moments.musicTier({ tier: 'dance', score: 0.8 });
    tick(host, clock, 40_000);
    assert.equal(host.moments.musicTier({ tier: 'nod', score: 0.5 }), true);
    const after = values(host);
    assert.ok(after.D > before.D + 1 && after.E > before.E + 1 && after.N > before.N + 2);
    tick(host, clock, 60_000);
    assert.equal(host.moments.musicTier({ tier: 'none', score: 0.1 }), false, 'the nod-along after it shares the cooldown');
    tick(host, clock, 9 * MINUTE);
    const later = values(host);
    assert.ok(later.N - 50 < (after.N - 50) / 4, `N falls back (half-life 3 min): ${after.N.toFixed(2)} → ${later.N.toFixed(2)}`);
    assert.ok(later.E - 50 > (after.E - 50) * 0.6, 'E lingers longer (half-life 25 min)');
    assert.deepEqual(journal.map(j => j.source), ['moment-dance']);
  });
});

test('host: special day, keepsake and diary; each once per its window; keepsake and diary keep the reason and only ease C', async () => {
  await withHost(({ host, clock, journal }) => {
    host.event({ type: 'chat', id: 'worry', delta: { C: 6, N: 3 }, context: 'concern', reason: '收到用户聊天' });
    const reason = host.get().snapshot.reason, c0 = values(host).C;
    assert.equal(host.moments.note('keepsake', 'gene', 'line-1'), true);
    assert.equal(host.get().snapshot.reason, reason, 'the reason stays');
    assert.ok(values(host).C < c0 - 1.5);
    assert.equal(host.moments.note('keepsake', 'gene', 'line-2'), false, 'inside 2 hours');
    assert.equal(host.moments.note('diary', 'gene', '2026-11-10'), true);
    assert.equal(host.moments.note('diary', 'gene', '2026-11-09'), false, 'a second diary day written at the same start');
    const d0 = values(host);
    assert.equal(host.moments.note('special-day', 'gene', 'birthday'), true);
    assert.ok(values(host).D > d0.D + 2 && values(host).O > d0.O + 2);
    tick(host, clock, 2 * HOUR);
    assert.equal(host.moments.note('special-day', 'gene', 'msg-9'), false, 'the day once (also through her folder)');
    assert.deepEqual(journal.map(j => j.source).filter(s => s.startsWith('moment-')), ['moment-keepsake', 'moment-diary', 'moment-special-day']);
  });
});

test('host: a blush lifts E a little after the warm words (their reason stays); blushes inside 10 minutes do not stack', async () => {
  await withHost(({ host, clock, journal }) => {
    const e0 = values(host).E;
    host.event({ type: 'chat', id: 'warm-1', delta: { O: 5, E: 2 }, context: 'support', reason: '收到用户聊天' });
    assert.ok(host.get().snapshot.blush, 'the warm words raised a blush');
    const shy = journal.filter(j => j.source === 'moment-shy').length;
    assert.equal(shy, 1);
    assert.equal(host.get().snapshot.reason, '收到用户聊天', 'the words stay the reason');
    const e1 = values(host).E;
    assert.ok(e1 > e0 + 2 + 1, `the words' E+2 and the shy E+1.5: ${e0} → ${e1}`);
    tick(host, clock, 2 * MINUTE); // the card's blush cooldown (1 minute) is over; the shy one (10 minutes) is not
    host.event({ type: 'chat', id: 'warm-2', delta: { O: 5, E: 2 }, context: 'support', reason: '收到用户聊天' });
    assert.ok(host.get().snapshot.blush?.id === 'warm-2', 'a second blush');
    assert.equal(journal.filter(j => j.source === 'moment-shy').length, 1, 'no second shy lift');
    // The reaction table's own blush goes through the same family.
    tick(host, clock, 9 * MINUTE);
    assert.equal(host.reactionBlush('gene', 'table-1', 0.6).done, true);
    assert.equal(journal.filter(j => j.source === 'moment-shy').length, 2);
  });
});

test('host: a reply without a usable tail lifts by the label, once per message, and keeps the reason', async () => {
  await withHost(({ host, journal }) => {
    const v0 = values(host);
    assert.equal(host.moments.tailless('gene', 'm-1'), true);
    assert.ok(values(host).O > v0.O + 0.9, 'calm: O +1');
    assert.equal(host.moments.tailless('gene', 'm-1'), false, 'the same message never twice');
    assert.equal(host.get().snapshot.reason === MOOD_MOMENT_REASONS.tailless, false, 'the reason is not replaced');
    assert.deepEqual(journal.map(j => j.source), ['moment-tailless']);
  });
});

test('host: expressions off moves nothing (the gate refuses nothing it should not, the lift is simply not applied)', async () => {
  await withHost(({ host, journal }) => {
    host.setExpressions(false);
    const v0 = values(host);
    assert.equal(host.moments.presence({ presence: 'back', awayMinutes: 30 }), false);
    assert.deepEqual(values(host), v0);
    assert.equal(journal.length, 0);
  });
});

test('MoodMoments with a fake port: ids are their own family and bounded; a throwing port never throws into the caller', () => {
  const lifts: { lift: MoodMomentLift; characterId: string }[] = [];
  const port = { clock: () => T0, current: () => 'gene', state: () => ({ values: base(), baseline: base(), evidence: 1, primary: 'happy' as const }),
    lift: (lift: MoodMomentLift, characterId: string) => { lifts.push({ lift, characterId }); return true; } };
  const moments = new MoodMoments(port);
  moments.tailless('gene', 'x'.repeat(400));
  assert.match(lifts[0].lift.id, /^moment-tailless-x+$/); assert.ok(lifts[0].lift.id.length <= 160);
  assert.deepEqual(lifts[0].lift.delta, MOOD_TAILLESS_BY_LABEL.happy);
  assert.equal(lifts[0].lift.keepReason, true);
  const broken = new MoodMoments({ ...port, state: () => { throw new Error('no'); }, lift: () => { throw new Error('no'); } });
  assert.doesNotThrow(() => { broken.note('back'); broken.musicTier({ tier: 'dance' }); broken.fatigue('gene', 'asleep', 0); broken.presence(null); });
});

// ------------------------------------------------------------------------------------------------ the wiring

test('wiring: her special-day "said" (in a reply or her own line) is the moment; the journal line is unchanged; other events are not', async () => {
  const { createSpecialDay } = await import('../electron/memory/special-day/wiring');
  const journal: string[] = [], moments: [string, string][] = [];
  const host = createSpecialDay({ folder: { enabled: () => false } as never, directory: () => null, characterId: () => 'c1', profile: () => null, persona: () => '',
    mood: () => ({ snapshot: { primary: 'calm' } }), model: () => '', calm: () => true, journal: input => { journal.push(input.event); },
    moment: (characterId, key) => { moments.push([characterId, key]); } });
  const journalPort = (host as unknown as { options: { journal(input: { characterId: string | null; event: string; kind: string; first: string | null }): void } }).options.journal;
  for (const event of ['hinted', 'said', 'expired', 'user-first']) journalPort({ characterId: 'c1', event, kind: 'birthday', first: event === 'said' ? 'her' : null });
  assert.deepEqual(journal, ['hinted', 'said', 'expired', 'user-first']);
  assert.deepEqual(moments, [['c1', 'birthday']]);
});

test('companion: a complete reply without a usable tail gives the tiny fallback once; a reply with its tail does not', async () => {
  const { CompanionService } = await import('../electron/brain/companion');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-mood-batch2-companion-'));
  const service = new CompanionService(directory, () => {});
  try {
    await service.load(); await service.context('gene', { kind: 'claude', baseUrl: 'https://synthetic.example/v1', model: 'fixture' }, 'Gene');
    const o0 = service.mood.get().snapshot.values.O;
    const bare = await service.begin('bare', '原创请求', 'Gene', () => {});
    bare.push('delta', '原创回复，没有尾注。');
    await bare.finish('complete');
    const tailless = service.mood.moments.recent.filter(note => note.kind === 'tailless');
    assert.deepEqual(tailless.map(note => note.applied), [true]);
    assert.ok(service.mood.get().snapshot.values.O > o0 + 0.5, 'calm: a little O');
    const tailed = await service.begin('tailed', '原创请求', 'Gene', () => {});
    const opening = tailed.persona.match(/<sh-state-[a-f0-9]+>/)?.[0];
    assert.ok(opening);
    tailed.push('delta', `原创回复。\n${opening}${JSON.stringify({ context: 'positive', delta: { D: 2 }, reason: '原创', confidence: 0.9, gesture: 'none' })}${opening.replace('<', '</')}`);
    await tailed.finish('complete');
    assert.equal(service.mood.moments.recent.filter(note => note.kind === 'tailless').length, 1, 'the tail moved her mood: no fallback');
    const stopped = await service.begin('stopped', '原创请求', 'Gene', () => {});
    stopped.push('delta', '说到一半');
    await stopped.finish('stopped');
    assert.equal(service.mood.moments.recent.filter(note => note.kind === 'tailless').length, 1, 'a stopped reply is no reply');
  } finally {
    await service.flush().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
