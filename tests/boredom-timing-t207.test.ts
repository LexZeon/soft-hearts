/**
 * #8 你不理她时多久来找你：Codex T-207 的四个反例（3A～3D），照它的最小复现写成测试，加上几组同类的扫描。
 * 两组走同一个真 MoodHost、claimMoodCue、InnerLoop 和 ProactiveSpeechGate，时钟是合成的（1 秒一拍），假模型只回 none：
 * 对照组用 FixedBoredomTiming（卡上的值原样用 = 原来的做法），实验组用 BoredomTimingDirector。
 * 承诺：动一下和开口永远不早于卡上原来的时刻（看的是主机真的发出的时刻，不只是门槛）；同一段闲置里问模型的次数不多于原来。
 * 只用隔离的临时目录；不读任何配置、角色卡或桥里的文件。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MoodHost } from '../electron/mood';
import { ProactiveSpeechGate } from '../electron/proactive-speech-gate';
import { InnerLoop } from '../electron/inner-loop/inner-loop';
import { claimMoodCue, withoutClaimedCue } from '../electron/inner-loop/claim';
import { DEFAULT_MOOD_PARAMETERS, type MoodParameters } from '../shared/mood';
import { BoredomTimingDirector } from '../shared/behaviors/boredom-timing/choose';
import { FixedBoredomTiming } from '../shared/behaviors/boredom-timing/fake';
import type { BoredomTimingHost } from '../shared/behaviors/boredom-timing/interface';
import { seeded } from './helpers/seeded';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const start = new Date(2026, 10, 4, 15).getTime();
type Moment = { at: number; kind: 'look' | 'motion' | 'speech' };
type Point = { at: number; action: 'chat' } | { at: number; action: 'presence'; relief: number } | { at: number; action: 'card'; parameters: MoodParameters };

/** One idle stretch on the real host, one tick a second; `at` in seconds from the start. */
async function simulate(parameters: MoodParameters, timing: BoredomTimingHost, end: number, points: readonly Point[] = []) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-t207-boredom-'));
  const clock = { now: start };
  const events: Moment[] = [], calls: Moment[] = [], seen = new Set<string>();
  const host = new MoodHost(directory, view => {
    const cue = view.snapshot.cue;
    if (cue && (cue.kind === 'look' || cue.kind === 'motion' || cue.kind === 'speech') && !seen.has(cue.id)) {
      seen.add(cue.id);
      events.push({ at: (cue.at - start) / SECOND, kind: cue.kind });
    }
    if (claimMoodCue(cue, { inner: c => loop.offerOpportunity(c) }, c => loop.claims(c.id) ? 'inner' : null)) withoutClaimedCue(view, host);
  }, () => clock.now, { boredomTiming: timing,
    fatigueClock: { monotonicMs: () => clock.now - start, wallMs: () => clock.now, localMinute: wall => 900 + (wall - start) / MINUTE } });
  const gate = new ProactiveSpeechGate(() => clock.now);
  const scope = 't207-boredom';
  gate.setScope(scope);
  const loop = new InnerLoop({
    gate, clock: () => clock.now, enabled: () => true, canStart: () => !gate.busy, current: () => true,
    scope: () => ({ characterId: 'synthetic', gateScope: scope }), parameters: () => host.get().parameters,
    quiet: () => ({ quiet: false, asleep: false, drowsy: false, night: false }),
    prompt: claim => claim.kind,
    decide: async prompt => { calls.push({ at: (clock.now - start) / SECOND, kind: prompt as Moment['kind'] }); return { text: '{"action":"none"}' }; },
    realize: () => {}, releaseSpeech: cue => host.releaseSpeech(cue, 'synthetic'),
    offer: () => {}, present: async () => true, presentationCurrent: () => true, archive: async () => {}, record: () => {},
  });
  try {
    await host.load();
    host.activate('synthetic', structuredClone(parameters));
    host.event({ type: 'chat', id: 'start' });
    for (let t = SECOND; t <= end; t += SECOND) {
      clock.now = start + t;
      for (const point of points) {
        if (point.at !== t) continue;
        if (point.action === 'chat') host.event({ type: 'chat', id: 'chat-' + t });
        else if (point.action === 'card') host.applyTemplate('synthetic', point.parameters);
        else assert.equal(host.presence({ id: 'presence-' + t, relief: point.relief }), true);
      }
      loop.sweep();
      host.tick(!gate.busy);
      while (loop.busy) await new Promise<void>(resolve => setImmediate(resolve));
    }
    return { events, calls, why: timing.recent('synthetic') };
  } finally {
    loop.dispose();
    gate.dispose();
    await host.flush();
    await rm(directory, { recursive: true, force: true });
  }
}
const first = (events: readonly Moment[], kind: Moment['kind'], from = 0) => events.find(e => e.kind === kind && e.at >= from)?.at;
/** Codex's draw: every random number 0.05 (the eager tempo, the earliest end of each range). */
const early = () => new BoredomTimingDirector({ random: () => 0.05 });

test('T-207 3A: a look that moves earlier cannot open an earlier motion or a model call (the card\'s own look prompt held its motion back)', async () => {
  const card = structuredClone(DEFAULT_MOOD_PARAMETERS);
  card.boredom = { graceMs: 0, perMinute: 6, lookAt: 9, motionAt: 10, speechAt: 30 };
  card.interaction.attentionMs = 20 * SECOND;
  const baseline = await simulate(card, new FixedBoredomTiming(), 150 * SECOND);
  const actual = await simulate(card, early(), 150 * SECOND);
  assert.equal(first(baseline.events, 'motion'), 111, 'the card: look at 91 s holds the motion (due at 101 s) until its 20 s prompt ends');
  assert.ok(first(actual.events, 'look')! < first(baseline.events, 'look')!, 'her look still comes earlier');
  assert.ok(first(actual.events, 'motion')! >= 111, JSON.stringify({ baseline: baseline.events, actual: actual.events }));
  for (const until of [105, 111, 150])
    assert.ok(actual.calls.filter(call => call.at <= until).length <= baseline.calls.filter(call => call.at <= until).length, `${until}: ${JSON.stringify(actual.calls)}`);
});

test('T-207 3B: boredom left over after a chat cannot bring the next motion or speech earlier (her boredom is never ahead of the card\'s)', async () => {
  const card = structuredClone(DEFAULT_MOOD_PARAMETERS);
  card.boredom.graceMs = 0;
  const at = 25 * MINUTE / SECOND;
  const baseline = await simulate(card, new FixedBoredomTiming(), 52 * MINUTE, [{ at: at * SECOND, action: 'chat' }]);
  const actual = await simulate(card, early(), 52 * MINUTE, [{ at: at * SECOND, action: 'chat' }]);
  for (const kind of ['motion', 'speech'] as const) {
    const was = first(baseline.events, kind, at)!, now = first(actual.events, kind, at);
    assert.ok(now === undefined || now >= was, `${kind}: ${now} < ${was}`);
  }
});

test('T-207 3C: a 在场 relief in the same idle stretch cannot widen motion → speech enough to ask the model one more time', async () => {
  const card = structuredClone(DEFAULT_MOOD_PARAMETERS);
  card.boredom.graceMs = 0;
  card.boredom.speechAt = 74.5;
  const points: Point[] = [{ at: 15 * MINUTE, action: 'presence', relief: 8 }];
  const baseline = await simulate(card, new FixedBoredomTiming(), 44 * MINUTE, points);
  const actual = await simulate(card, early(), 44 * MINUTE, points);
  assert.ok(actual.calls.length <= baseline.calls.length, JSON.stringify({ fixed: baseline.calls, varied: actual.calls }));
});

test('T-207 3D: editing the card mid-idle (both grace periods already over) cannot speed up the motion or speech', async () => {
  const card = structuredClone(DEFAULT_MOOD_PARAMETERS);
  card.boredom = { graceMs: 60 * MINUTE, perMinute: 2, lookAt: 2, motionAt: 10, speechAt: 15 };
  const changed = structuredClone(card);
  changed.boredom.graceMs = 5 * MINUTE;
  const points: Point[] = [{ at: 15 * MINUTE, action: 'card', parameters: changed }];
  const rolls = [0.05, 0.99, 0.99, 0.05, 0.05];
  let i = 0;
  const baseline = await simulate(card, new FixedBoredomTiming(), 23 * MINUTE, points);
  const actual = await simulate(card, new BoredomTimingDirector({ random: () => rolls[i++ % rolls.length] }), 23 * MINUTE, points);
  for (const kind of ['motion', 'speech'] as const) {
    const now = first(actual.events, kind);
    assert.ok(now === undefined || now >= first(baseline.events, kind)!, `${kind}: ${now} < ${first(baseline.events, kind)}`);
  }
});

test('same class, swept: a chat, a 在场 relief or a card edit at many moments, many draws: never an earlier first motion or speech, never more model calls', async () => {
  const card = structuredClone(DEFAULT_MOOD_PARAMETERS);
  card.boredom.graceMs = 0;
  card.boredom.speechAt = 74.5;
  const fast = structuredClone(card);
  fast.boredom.perMinute = 3;
  const cases: { name: string; points: Point[]; end: number }[] = [];
  for (const minute of [6, 12, 18, 24]) cases.push({ name: `chat at ${minute}`, points: [{ at: minute * MINUTE, action: 'chat' }], end: (minute + 46) * MINUTE });
  // Reliefs before her first motion (the class of 3C).
  for (const minute of [5, 10, 15, 20, 25]) cases.push({ name: `presence at ${minute}`, points: [{ at: minute * MINUTE, action: 'presence', relief: 8 }], end: 50 * MINUTE });
  for (const minute of [5, 15]) cases.push({ name: `card faster at ${minute}`, points: [{ at: minute * MINUTE, action: 'card', parameters: fast }], end: 45 * MINUTE });
  const failures: string[] = [];
  for (const c of cases) {
    const baseline = await simulate(card, new FixedBoredomTiming(), c.end, c.points);
    for (const seed of [0, 1, 2, 3]) {
      const actual = await simulate(card, seed === 0 ? early() : new BoredomTimingDirector({ random: seeded(seed) }), c.end, c.points);
      const from = c.points[0].action === 'chat' ? c.points[0].at / SECOND : 0;
      for (const kind of ['motion', 'speech'] as const) {
        const was = first(baseline.events, kind, from), now = first(actual.events, kind, from);
        if (now !== undefined && (was === undefined || now < was)) failures.push(`${c.name} seed ${seed}: ${kind} ${now} < ${was}`);
      }
      if (actual.calls.length > baseline.calls.length) failures.push(`${c.name} seed ${seed}: ${actual.calls.length} calls > ${baseline.calls.length}`);
    }
  }
  assert.deepEqual(failures, []);
});
