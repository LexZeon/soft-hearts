/**
 * I-078 第 2 步 (docs/claude/2026-11-11-i078-sleep-step2-3.md): what happens while she sleeps, and how waking comes back to her mood.
 *
 * - Pure: "醒醒" in the user's words (and what is not a request); the fatigue model keeps her half awake while you talk with her
 *   (each message wakes her a little more, gradually, until the wake gate), touches alone never hold it, and the hold is bounded.
 * - The real MoodHost (isolated temporary directory, fatigue-state.json seeded asleep, a fixed fatigue clock): "醒醒" wakes her at
 *   once and only while she sleeps; woken before she had slept enough is the woken lift (C a little up, E a little down, relative
 *   to the card's baseline, its own id and cooldown), never the natural wake's; a gentle pat she sleeps through lifts E once per
 *   contact (deduped with the fatigue pulse by the accepted contact identity), a cheek pinch does not; the reply's state line says
 *   she was just woken. Synthetic only: no model call, no real profile.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { explicitWakeRequest } from '../shared/mood/sleep-wake-words';
import { acceptWakeEvent, advanceFatigue, createFatigue, DEFAULT_FATIGUE_PARAMETERS as P, type FatiguePhase, type FatigueState } from '../shared/mood/fatigue';
import { MoodHost } from '../electron/mood/mood';
import { MOOD_MOMENTS, MOOD_MOMENT_KNOBS, MOOD_MOMENT_REASONS } from '../shared/foundation/mood-moments';
import { DEFAULT_MOOD_PARAMETERS, moodLevel, type MoodValues } from '../shared/foundation/mood';
import { moodEventSource } from '../shared/memory/journal';
import { FixedBoredomTiming } from '../shared/behaviors/boredom-timing/fake';
import { FixedTouchFeedEffect } from '../shared/behaviors/touch-feed-effect/fake';
import { FixedBlush } from '../shared/behaviors/blush/fake';

const MINUTE = 60_000;

// ------------------------------------------------------------------ "醒醒" (pure)

test('I-078 wake words: a clear call wakes her; reports about oneself, negations and idioms do not', () => {
  for (const yes of ['醒醒', '醒醒！', 'Gene，醒醒啦', '快醒醒', '喂，醒一醒', '别睡了，起来陪我', '该起床了', '起床啦～', '快起来', '不要再睡了',
    'wake up', 'Hey, wake up!', 'hey gene wake up', 'Wakey wakey', 'rise and shine', 'come on, get up', 'time to wake up sleepyhead'])
    assert.equal(explicitWakeRequest(yes), true, yes);
  for (const no of ['我刚起床', '我起床啦', '你几点起床？', '明天早点起床', '别叫醒她', '喝杯咖啡醒醒神', '我醒醒脑子', '晚安', '你睡得好香',
    '我已经醒了', '看起来不错', '想起来一件事', 'I woke up at 7', 'I wake up early', 'I get up at six', "don't wake up", 'you should wake up later', 'good night', '', 42])
    assert.equal(explicitWakeRequest(no), false, String(no));
});

// ------------------------------------------------------------------ half awake while you talk (pure fatigue)

const blockers = (chat = false, tts = false) => ({ chat, tts, manualMotion: false });
const neutral = { D: 50, O: 50, E: 50, N: 50, C: 50 };
function asleep(): FatigueState { return createFatigue({ monotonicMs: 1_000_000, localMinute: 180 }, { A: 0.9, F: 0.86, phase: 'asleep' }); }
function step(s: FatigueState, ms: number, b = blockers()): FatigueState {
  return advanceFatigue(s, { clock: { monotonicMs: s.monotonicMs + ms, localMinute: 180 }, channels: neutral, baseline: neutral, blockers: b, mode: 'active' });
}
const message = (s: FatigueState, id: string) => acceptWakeEvent(s, { id, kind: 'direct-chat', acceptedAtMonotonicMs: s.monotonicMs });
const touch = (s: FatigueState, id: string) => acceptWakeEvent(s, { id, kind: 'physical', acceptedAtMonotonicMs: s.monotonicMs });

test('I-078 chat while asleep: half awake while you talk, each message a little more, awake by the third; never a jump in F', () => {
  let s = message(asleep(), 'm1');
  assert.equal(s.phase, 'micro-awake');
  const phases: FatiguePhase[] = [], W: number[] = [s.W];
  // A reply on its way (10 s) and spoken (10 s), the user typing the next one (5 s), then a 10 s pause: she stays half awake;
  // W holds while you talk and fades only in the pause.
  for (let i = 0; i < 35; i++) { s = step(s, 1_000, blockers(i < 10 || (i >= 20 && i < 25), i >= 10 && i < 20)); phases.push(s.phase); if (i === 24) W.push(s.W); }
  assert.ok(phases.every(p => p === 'micro-awake'), 'no drifting back mid-talk or in a short pause');
  s = message(s, 'm2'); W.push(s.W);
  assert.equal(s.phase, 'micro-awake', 'two messages: still half awake');
  for (let i = 0; i < 30; i++) s = step(s, 1_000, blockers(true));
  const F = s.F; s = message(s, 'm3');
  assert.equal(s.phase, 'awake', 'the third message wakes her (gradually, not at once)');
  assert.ok(Math.abs(s.F - F) < 1e-9, 'waking never clears her fatigue');
  assert.ok(W[1] === W[0] && W[2] > W[1], `W held while talking, then rose: ${W.map(w => w.toFixed(3))}`);
});

test('I-078 chat while asleep without more talk, and touches: she drifts back to sleep as before; the hold is bounded', () => {
  // Before this step a message 12 s later was back asleep even mid-reply; without talk it still is.
  let s = message(asleep(), 'm1');
  for (let i = 0; i < 14; i++) s = step(s, 1_000);
  assert.equal(s.phase, 'asleep', 'no talk: back asleep after the micro-wake');
  let t = touch(asleep(), 't1');
  const w0 = t.W;
  for (let i = 0; i < 14; i++) t = step(t, 1_000);
  assert.equal(t.phase, 'asleep', 'a touch never holds her half awake');
  assert.ok(t.W < w0, 'and its wakefulness fades');
  // A blocker stuck on (a reply that never ends): at most conversationHoldMaxMs, then she drifts back.
  let h = message(asleep(), 'm1');
  for (let ms = 0; ms < P.conversationHoldMaxMs + 15_000; ms += 1_000) h = step(h, 1_000, blockers(true));
  assert.equal(h.phase, 'asleep', 'bounded hold');
});

test('I-078 dedupe: the same accepted message or contact counts once', () => {
  const once = message(asleep(), 'same');
  assert.equal(message(once, 'same'), once, 'an id already accepted changes nothing');
  const t = touch(asleep(), 'contact:1');
  assert.equal(touch(t, 'contact:1'), t);
});

// ------------------------------------------------------------------ the host

const T0 = Date.UTC(2026, 10, 11, 18, 0, 0); // 03:00 local in most test zones does not matter: localMinute is fixed below
type Ctx = { host: MoodHost; clock: { now: number }; journal: string[] };
async function withSleepingHost(run: (c: Ctx) => Promise<void> | void, seed: { A: number; F: number; phase: FatiguePhase } = { A: 0.9, F: 0.86, phase: 'asleep' }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-i078-step2-'));
  await writeFile(path.join(directory, 'fatigue-state.json'), JSON.stringify({ version: 1, profiles: [{ characterId: 'gene', ...seed, W: 0, wallMs: T0 }] }));
  const clock = { now: T0 };
  const fatigueClock = { monotonicMs: () => clock.now - T0 + 1_000_000, wallMs: () => clock.now, localMinute: () => 180 };
  const host = new MoodHost(directory, () => {}, () => clock.now,
    { fatigueClock, boredomTiming: new FixedBoredomTiming(), touchFeedEffect: new FixedTouchFeedEffect(), blush: new FixedBlush() });
  const journal: string[] = [];
  try {
    await host.load();
    host.activate('gene', structuredClone(DEFAULT_MOOD_PARAMETERS));
    host.setExpressions(true);
    host.setJournalObserver(event => { journal.push(moodEventSource(event.type as 'lift', event.reason)); });
    await run({ host, clock, journal });
  } finally {
    await host.flush().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}
const values = (host: MoodHost): MoodValues => ({ ...host.get().snapshot.values });
const tick = (c: Ctx, ms: number) => { for (let t = 0; t < ms; t += 1_000) { c.clock.now += 1_000; c.host.tick(true); } };
const input = (host: MoodHost, value: Record<string, unknown>) => host.interaction({ token: host.get().token, ...value });
function pat(c: Ctx, id: string, seconds = 3): void {
  input(c.host, { type: 'phase', sessionId: id, phase: 'rua' });
  for (let i = 0; i < seconds * 2; i++) { c.clock.now += 500; input(c.host, { type: 'rua', sessionId: id, id: `${id}-${i}`, activeMs: 500 }); }
  input(c.host, { type: 'phase', sessionId: id, phase: 'idle' });
}
const moments = (c: Ctx) => c.journal.filter(j => j.startsWith('moment-'));

test('I-078 host: "醒醒" wakes her at once; woken before she slept enough: C a little up, E a little down, never the wake lift', async () => {
  await withSleepingHost(c => {
    tick(c, 5 * MINUTE);
    assert.equal(c.host.get().fatigue?.phase, 'asleep');
    const before = values(c.host);
    assert.equal(c.host.wakeByWords('gene', 'msg-1'), true);
    assert.equal(c.host.get().fatigue?.phase, 'awake', 'awake at once');
    assert.equal(c.host.wakeByWords('gene', 'msg-1'), false, 'one message wakes once (and she is awake now)');
    tick(c, 2_000);
    const after = values(c.host);
    assert.deepEqual(moments(c), ['moment-woken']);
    assert.ok(after.C > before.C + 1 && after.E < before.E - 1, JSON.stringify({ before, after }));
    assert.equal(after.D, before.D); assert.equal(after.O, before.O);
    assert.equal(c.host.get().snapshot.reason, MOOD_MOMENT_REASONS.woken);
    // The reply written right after says she was just woken and is groggy (and never claims the sleepiness is gone).
    assert.match(c.host.chatContext(), /刚被你叫醒，没睡够、还有点迷糊/);
    assert.ok((c.host.get().fatigue?.F ?? 0) > 0.6, 'fatigue not cleared');
  });
});

test('I-078 host: the woken lift is relative to the card baseline and has its own cooldown', async () => {
  await withSleepingHost(c => {
    tick(c, 3 * MINUTE);
    c.host.wakeByWords('gene', 'w1'); tick(c, 2_000);
    assert.deepEqual(moments(c), ['moment-woken']);
    // Asleep again (the seeded A is still high) and woken again inside the cooldown: no second lift.
    const fatigue = (c.host as unknown as { fatigue: { live: Map<string, { state: FatigueState }> } }).fatigue;
    const live = fatigue.live.get('gene')!;
    live.state = { ...live.state, phase: 'asleep', phaseAgeMs: 0, wakeHoldMs: 0 } as FatigueState;
    tick(c, 3 * MINUTE);
    assert.equal(c.host.wakeByWords('gene', 'w2'), true);
    tick(c, 2_000);
    assert.deepEqual(moments(c), ['moment-woken'], `inside ${MOOD_MOMENTS.woken.cooldownMs / MINUTE} min: once`);
  });
  // Already far past the soft line in the lift's direction: C at a high level gets nothing more.
  await withSleepingHost(c => {
    const p = (c.host as unknown as { profiles: Map<string, { state: { values: MoodValues } }> }).profiles.get('gene')!;
    p.state.values.C = 92;
    tick(c, 3 * MINUTE);
    c.host.wakeByWords('gene', 'w1'); tick(c, 2_000);
    const after = values(c.host);
    assert.ok(moodLevel(after.C, DEFAULT_MOOD_PARAMETERS.baseline.C) > MOOD_MOMENT_KNOBS.hard - 1, 'C stays where it was (no more burden piled on)');
    assert.ok(after.C <= 92 + 1e-6, `C ${after.C}`);
  });
});

test('I-078 host: woken once rested is the ordinary wake lift; "醒醒" while she is awake or drowsy does nothing', async () => {
  await withSleepingHost(c => {
    tick(c, 12 * MINUTE);
    assert.equal(c.host.wakeByWords('gene', 'w1'), true);
    tick(c, 2_000);
    assert.deepEqual(moments(c), ['moment-wake'], 'rested (A low): the natural wake lift');
  }, { A: 0.2, F: 0.7, phase: 'asleep' });
  await withSleepingHost(c => {
    tick(c, 2_000);
    assert.equal(c.host.wakeByWords('gene', 'w1'), false);
    assert.equal(c.host.get().fatigue?.phase, 'drowsy');
    assert.deepEqual(moments(c), []);
  }, { A: 0.68, F: 0.62, phase: 'drowsy' });
});

test('I-078 host: a gentle pat she sleeps through lifts E once per contact; a cheek pinch does not; a message wakes her a little', async () => {
  await withSleepingHost(c => {
    tick(c, 3 * MINUTE);
    const before = values(c.host);
    pat(c, 'pat-1');
    const phase = c.host.get().fatigue?.phase;
    assert.ok(phase === 'micro-awake' || phase === 'asleep', `still asleep (${phase})`);
    assert.equal(moments(c).filter(m => m === 'moment-sleep-soothed').length, 1, 'once for the contact (its phase start and its reward share one identity)');
    assert.ok(values(c.host).E > before.E, 'E up');
    tick(c, 20_000);
    pat(c, 'pat-2');
    assert.equal(moments(c).filter(m => m === 'moment-sleep-soothed').length, 1, 'cooldown');
    // A pinch: not a gentle pat.
    tick(c, MOOD_MOMENTS['sleep-soothed'].cooldownMs);
    input(c.host, { type: 'phase', sessionId: 'pinch-1', phase: 'cheek' });
    input(c.host, { type: 'phase', sessionId: 'pinch-1', phase: 'idle' });
    assert.equal(moments(c).filter(m => m === 'moment-sleep-soothed').length, 1, 'a pinch is no soothing');
    assert.ok((c.host.get().fatigue?.F ?? 0) > 0.6, 'touches never clear fatigue');
  });
});

// ------------------------------------------------------------------ through the companion (the user's own words)

test('I-078 companion: "醒醒" in the user\'s message wakes her before the reply is written; any other message wakes her a little', async () => {
  const { CompanionService } = await import('../electron/brain/companion');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-i078-companion-'));
  await writeFile(path.join(directory, 'fatigue-state.json'), JSON.stringify({ version: 1,
    profiles: [{ characterId: 'gene', A: 0.9, F: 0.86, W: 0, phase: 'asleep', wallMs: Date.now() }] }));
  const service = new CompanionService(directory, () => {});
  const say = async (id: string, user: string) => {
    const turn = await service.begin(id, user, '角色名称：Gene', () => {});
    const start = turn.persona.match(/<sh-state-[a-f0-9]+>/)![0];
    turn.push('delta', `嗯…\n${start}{"context":"neutral","delta":{},"confidence":0.8}${start.replace('<', '</')}`);
    await turn.finish('complete');
    return turn;
  };
  try {
    await service.load(); await service.context('gene', { kind: 'claude', baseUrl: 'https://i078.invalid/v1', model: 'fixture' }, '角色名称：Gene');
    service.mood.setExpressions(true);
    assert.equal(service.mood.get().fatigue?.phase, 'asleep');
    const soft = await say('i078-1', '你睡得好香');
    assert.match(soft.persona, /睡眠中仍可温和回应/, 'asleep when the reply is written');
    assert.equal(service.mood.get().fatigue?.phase, 'micro-awake', 'a plain message wakes her a little');
    const woke = await say('i078-2', '醒醒啦');
    assert.equal(service.mood.get().fatigue?.phase, 'awake', 'her own words "醒醒" wake her');
    assert.match(woke.persona, /刚被你叫醒，没睡够、还有点迷糊/, 'and this very reply is written just woken');
  } finally {
    await service.flush().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
