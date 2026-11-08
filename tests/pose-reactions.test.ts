/**
 * P1 第二阶段 (docs/claude/2026-11-03-pose-sensing-stage2.md 「验证」): her reactions to the local pose signals, without the stage.
 *  - contagion: chance by personality and sleepiness (Monte Carlo, "偏低，按性格浮动"), cooldowns from the card, delays, never asleep;
 *  - the user's session: arrival only after a seen absence, sitting time, staleness, sensing off forgets at once;
 *  - her own stretch after the user sat long (her own need, from the card's small-motion interval);
 *  - 在场: a little less bored, not an interaction (no interaction clock, no relationship / user-state / her-life change);
 *  - the inner loop's one line only while sensing runs, and the prompt is byte for byte unchanged without it;
 *  - privacy: views, lines, journal lines and the diary line carry fixed words, enums and times only.
 * POSE_REPORT=1 prints the frequency table used in the record.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  POSE_CONSIDER_EVERY_MS, POSE_FOLLOW_CHANCE_MAX, POSE_REACTION_POLICY, POSE_STALE_MS, decidePoseFollow, emptyPoseFollowMemory, poseDiaryLine,
  poseInnerLoopLine, poseOwnStretchDue, poseSessionLive, poseSummary, readPoseReactionView, stepPoseSession,
  type PoseCharacter, type PoseFollowKind, type PoseSession,
} from '../shared/pose-reactions';
import { EMPTY_POSE_SIGNAL, parsePoseSignal, type PoseSignal } from '../shared/pose-signals';
import { PoseReactionHost } from '../electron/pose-reactions/host';
import { CompanionService } from '../electron/companion';
import { applyMoodPresence } from '../shared/mood-presence';
import { DEFAULT_MOOD_PARAMETERS, advanceMood, createMoodState, getMoodSnapshot } from '../shared/mood';
import { buildInnerLoopPrompt } from '../shared/inner-loop';
import { innerLoopPrompt, type InnerLoopContextSources } from '../electron/inner-loop/context';
import { buildJournalEntry, describeJournalEntry } from '../shared/journal';
import { poseInput } from '../electron/journal/sources';
import { seeded } from './helpers/seeded';
import { PoseReactionStage } from '../src/stage/pose-reaction-stage';

const MINUTE = 60_000;
const character = (over: Partial<PoseCharacter> = {}): PoseCharacter => ({ weights: { playful: 1, close: 1, comfortable: 1, cautious: 1 }, mood: 'calm',
  fatigue: { phase: 'awake', F: 0.3 }, motionIntervalMs: 5 * MINUTE, posture: 50, chatBoredomRelief: 20, ...over });
const signal = (over: Partial<PoseSignal> = {}): PoseSignal => ({ ...EMPTY_POSE_SIGNAL, present: true, confidence: 0.9, facing: 'toward', posture: 'sitting',
  energy: 0.2, events: [], ...over });

const PERSONALITIES: Record<string, PoseCharacter> = {
  '一般（默认卡，清醒）': character(),
  '一般，犯困': character({ fatigue: { phase: 'drowsy', F: 0.8 } }),
  '亲近 + 爱玩': character({ weights: { playful: 2, close: 2, comfortable: 1, cautious: 1 } }),
  '谨慎': character({ weights: { playful: 1, close: 1, comfortable: 1, cautious: 2.5 } }),
  '谨慎 + 低落': character({ weights: { playful: 1, close: 1, comfortable: 1, cautious: 2.5 }, mood: 'sad' }),
  '一般，开心': character({ mood: 'happy' }),
};

/** Many independent moments (each one considered, never resting): how often she follows. */
function frequency(c: PoseCharacter, kind: PoseFollowKind, n = 20_000, seed = 7): number {
  const random = seeded(seed);
  let followed = 0;
  for (let i = 0; i < n; i++) if (decidePoseFollow(kind, emptyPoseFollowMemory(), c, 1_000_000, random).decision === 'follow') followed++;
  return followed / n;
}

test('contagion is low and follows her personality and sleepiness (Monte Carlo, 20 000 moments each)', () => {
  const table: Record<string, Record<PoseFollowKind, number>> = {};
  for (const [name, c] of Object.entries(PERSONALITIES)) table[name] = { yawn: frequency(c, 'yawn'), stretch: frequency(c, 'stretch'), wave: frequency(c, 'wave') };
  if (process.env.POSE_REPORT) console.log(Object.entries(table).map(([name, row]) => `${name}: 哈欠 ${row.yawn.toFixed(3)} · 伸懒腰 ${row.stretch.toFixed(3)} · 挥手 ${row.wave.toFixed(3)}`).join('\n'));
  const average = table['一般（默认卡，清醒）'];
  // "大约十次跟两三次": an average card, awake.
  assert.ok(average.yawn > 0.1 && average.yawn < 0.2, `yawn ${average.yawn}`);
  assert.ok(average.stretch > 0.15 && average.stretch < 0.25, `stretch ${average.stretch}`);
  assert.ok(average.wave > 0.17 && average.wave < 0.27, `wave ${average.wave}`);
  // Even the clingiest, most playful card stays under 4 in 10.
  for (const [name, row] of Object.entries(table)) for (const kind of ['yawn', 'stretch', 'wave'] as const)
    if (!name.includes('犯困')) assert.ok(row[kind] < 0.4, `${name} ${kind} ${row[kind]}`);
  // Her own sleepiness makes a yawn catch more; close and playful join in more; cautious (and sad) less.
  assert.ok(table['一般，犯困'].yawn > 1.8 * average.yawn, 'sleepy: yawns catch more');
  for (const kind of ['yawn', 'stretch', 'wave'] as const) {
    assert.ok(table['亲近 + 爱玩'][kind] > average[kind], `close + playful: ${kind}`);
    assert.ok(table['谨慎'][kind] < average[kind], `cautious: ${kind}`);
    assert.ok(table['谨慎 + 低落'][kind] < table['谨慎'][kind], `cautious and sad: ${kind}`);
    for (const row of Object.values(table)) assert.ok(row[kind] <= POSE_FOLLOW_CHANCE_MAX + 0.01, 'never more than the fixed ceiling');
  }
  // Asleep: never; posture 0: no body motion (a yawn only).
  assert.equal(frequency(character({ fatigue: { phase: 'asleep', F: 1 } }), 'yawn', 2000), 0);
  assert.equal(frequency(character({ posture: 0 }), 'wave', 2000), 0);
  assert.equal(frequency(character({ posture: 0 }), 'stretch', 2000), 0);
  assert.ok(frequency(character({ posture: 0 }), 'yawn', 2000) > 0);
});

test('a followed kind rests for a while that follows the card; one moment is considered once; other kinds wait a short gap', () => {
  const c = character(), always = () => 0;
  let result = decidePoseFollow('wave', emptyPoseFollowMemory(), c, 0, always);
  assert.equal(result.decision, 'follow');
  const rest = result.memory.until.wave!;
  assert.ok(rest >= 0.4 * 5 * MINUTE * 0.8 * 0.6 && rest <= 0.4 * 5 * MINUTE * 1.25 * 1.2, `cooldown ${rest}`);
  assert.deepEqual(decidePoseFollow('wave', result.memory, c, rest - 1, always).decision, 'skip');
  assert.equal((decidePoseFollow('wave', result.memory, c, rest - 1, always) as { reason: string }).reason, 'resting');
  // Other kinds wait the gap (her rhythm, default 30 s), then may follow.
  const gap = POSE_REACTION_POLICY.gapMs(c);
  assert.equal((decidePoseFollow('yawn', result.memory, c, gap - 1, always) as { reason: string }).reason, 'busy');
  assert.equal(decidePoseFollow('yawn', result.memory, c, gap + 1, always).decision, 'follow');
  // A slower card rests longer (the card's small-motion interval doubled: the cooldown doubles).
  const slow = decidePoseFollow('wave', emptyPoseFollowMemory(), character({ motionIntervalMs: 10 * MINUTE }), 0, always).memory.until.wave!;
  assert.ok(Math.abs(slow - 2 * rest) < 1, `${slow} vs ${rest}`);
  // A moment she let pass is not rolled again at once (a wave seen twice is one greeting).
  const never = () => 0.999;
  result = decidePoseFollow('stretch', emptyPoseFollowMemory(), c, 0, never);
  assert.equal(result.decision, 'pass');
  assert.equal((decidePoseFollow('stretch', result.memory, c, POSE_CONSIDER_EVERY_MS - 1, always) as { reason: string }).reason, 'considered');
  assert.equal(decidePoseFollow('stretch', result.memory, c, POSE_CONSIDER_EVERY_MS + 1, always).decision, 'follow');
  // A test command forces past chance, rest and gap, never past sleep.
  assert.equal(decidePoseFollow('yawn', result.memory, c, 1, never, POSE_REACTION_POLICY, true).decision, 'follow');
  assert.equal(decidePoseFollow('yawn', emptyPoseFollowMemory(), character({ fatigue: { phase: 'asleep', F: 1 } }), 1, always, POSE_REACTION_POLICY, true).decision, 'skip');
});

test('her delay is a few tenths of a second to just over one, quicker when close and playful, slower when sleepy or cautious', () => {
  const draw = (c: PoseCharacter, kind: 'yawn' | 'stretch' | 'wave', n = 4000) => { const random = seeded(3), values: number[] = [];
    for (let i = 0; i < n; i++) values.push(POSE_REACTION_POLICY.delayMs(kind, 'follow', c, random)); return values; };
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  for (const c of Object.values(PERSONALITIES)) for (const kind of ['yawn', 'stretch', 'wave'] as const) {
    const values = draw(c, kind);
    assert.ok(Math.min(...values) >= 150 && Math.max(...values) <= 1900, `${kind}: ${Math.min(...values)}–${Math.max(...values)}`);
  }
  const average = draw(character(), 'yawn');
  assert.ok(Math.min(...average) >= 300 && Math.max(...average) <= 1400, 'an average card: 0.3–1.4 s');
  assert.ok(mean(draw(PERSONALITIES['一般，犯困'], 'yawn')) > mean(average) * 1.15, 'sleepy: slower');
  assert.ok(mean(draw(PERSONALITIES['亲近 + 爱玩'], 'wave')) < mean(draw(character(), 'wave')), 'close and playful: quicker');
  assert.ok(mean(draw(PERSONALITIES['谨慎'], 'wave')) > mean(draw(character(), 'wave')), 'cautious: slower');
  assert.equal(POSE_REACTION_POLICY.delayMs('stretch', 'own', character(), () => 0.5), 0, 'her own stretch has no delay');
});

test('the session: an arrival needs a seen absence; sitting survives a short absence and a moment of standing, not a break', () => {
  const after = POSE_REACTION_POLICY.arriveAfterMs(character());
  assert.equal(after, 90_000, 'default card: 0.3 × 5 min');
  let step = stepPoseSession(null, signal(), 0, after);
  assert.equal(step.arrived, false, 'the first signal after the camera turns on is not an arrival');
  assert.equal(step.session.sittingSince, 0);
  step = stepPoseSession(step.session, signal({ present: false }), 10_000, after);
  assert.equal(step.left, true);
  step = stepPoseSession(step.session, signal(), 40_000, after);
  assert.equal(step.arrived, false, 'back after 30 s: not an arrival');
  assert.equal(step.session.sittingSince, 0, 'a short absence keeps the sitting time');
  step = stepPoseSession(step.session, signal({ present: false }), 50_000, after);
  step = stepPoseSession(step.session, signal({ present: false }), 50_000 + after, after);
  assert.equal(step.session.sittingSince, null, 'away long enough: the sitting time ends');
  step = stepPoseSession(step.session, signal(), 60_000 + after, after);
  assert.equal(step.arrived, true, 'back after a real absence: an arrival');
  assert.equal(step.session.sittingSince, 60_000 + after);
  const t = 60_000 + after;
  step = stepPoseSession(step.session, signal({ posture: 'standing' }), t + 20_000, after);
  step = stepPoseSession(step.session, signal({ posture: 'standing' }), t + 50_000, after);
  assert.equal(step.session.sittingSince, t, 'standing up for a moment is still sitting at the desk');
  step = stepPoseSession(step.session, signal({ posture: 'standing' }), t + 85_000, after);
  assert.equal(step.session.sittingSince, null, 'standing a minute is a break');
  // Events are remembered by kind; staleness ends the session.
  step = stepPoseSession(step.session, signal({ events: ['yawn', 'wave'] }), t + 90_000, after);
  assert.deepEqual(step.events, ['yawn', 'wave']);
  assert.equal(poseSessionLive(step.session, t + 90_000 + POSE_STALE_MS), true);
  assert.equal(poseSessionLive(step.session, t + 90_000 + POSE_STALE_MS + 1), false);
});

test('her own stretch: due once the user sat the card\'s time (6–10 small-motion intervals), then not again until another such time', () => {
  for (const [minutes, random] of [[5, 0], [5, 1], [10, 0.5]] as const) {
    const due = POSE_REACTION_POLICY.ownStretchAfterMs(character({ motionIntervalMs: minutes * MINUTE }), () => random);
    assert.equal(due, Math.round(minutes * MINUTE * (6 + 4 * random)), `${minutes} min card, draw ${random}`);
  }
  const due = 40 * MINUTE;
  assert.equal(poseOwnStretchDue(39 * MINUTE, null, 0, due), false);
  assert.equal(poseOwnStretchDue(40 * MINUTE, null, 0, due), true);
  assert.equal(poseOwnStretchDue(90 * MINUTE, 70 * MINUTE, 100 * MINUTE, due), false, 'stretched 30 min ago');
  assert.equal(poseOwnStretchDue(90 * MINUTE, 50 * MINUTE, 100 * MINUTE, due), true);
  assert.equal(poseOwnStretchDue(null, null, 0, due), false, 'not sitting');
});

/** A host on a fake clock, fed like CompanionService feeds it. */
function rig(over: { random?: () => number; c?: PoseCharacter; expressions?: boolean; canExpress?: boolean } = {}) {
  let now = 1_000_000, ids = 0;
  const changed: string[] = [], presence: [string, number][] = [], journal: string[] = [];
  const host = new PoseReactionHost({ changed: id => changed.push(id), presence: (id, relief) => presence.push([id, relief]),
    journal: (id, event, kind) => journal.push(`${event}:${kind ?? '-'}`), clock: () => now, random: over.random ?? (() => 0), id: () => `id${++ids}` });
  const tick = () => host.tick('gene', { now, expressions: over.expressions ?? true, canExpress: over.canExpress ?? true, character: over.c ?? character() });
  /** Sensing sends a signal at least every 2 s while it runs (the supervisor treats a 10 s gap as a crash): the same signal for `ms`, ticking each time. */
  const feed = (value: PoseSignal, ms: number) => { for (let t = 0; t < ms; t += 2_000) { now += Math.min(2_000, ms - t); host.signal(value); tick(); } };
  return { host, changed, presence, journal, tick, feed, advance: (ms: number) => { now += ms; }, now: () => now };
}

test('the host: a signal event becomes a cue with her delay; the view has attention and boost; sensing off forgets everything at once', () => {
  const r = rig();
  r.tick();
  assert.equal(r.host.view('gene'), null, 'no sensing: no view');
  r.host.signal(signal({ facing: 'side' }));
  assert.deepEqual(r.host.view('gene'), { attention: 0.35, boost: 2.2, cue: null });
  r.host.signal(signal({ events: ['yawn'] }));
  const cue = r.host.view('gene')!.cue!;
  assert.equal(cue.kind, 'yawn'); assert.equal(cue.source, 'follow');
  assert.ok(cue.at - r.now() >= 300 && cue.at - r.now() <= 1400, `delay ${cue.at - r.now()}`);
  assert.deepEqual(r.journal, ['follow:yawn']);
  assert.equal(r.host.view('other'), null, 'another character gets nothing');
  r.host.sensing(false);
  assert.equal(r.host.innerLoopLine(), '');
  // Codex T-112 round 032: off is off. The queued yawn is withdrawn with the attention (this line used to let it play).
  assert.equal(r.host.view('gene'), null, 'the cue that had not started is gone with the attention');
  r.advance(11_000);
  assert.equal(r.host.view('gene'), null);
  // Staleness: no signal for more than 10 s is "not sensing" even without the switch.
  r.host.signal(signal());
  r.advance(POSE_STALE_MS + 1_000); r.tick();
  assert.equal(r.host.view('gene'), null);
  assert.equal(r.host.innerLoopLine(), '');
});

test('the host: she does not follow while the user is with her already, while expressions are paused, or asleep', () => {
  for (const over of [{ canExpress: false }, { expressions: false }, { c: character({ fatigue: { phase: 'asleep', F: 1 } }) }]) {
    const r = rig(over);
    r.tick();
    r.host.signal(signal({ events: ['wave'] }));
    assert.equal(r.host.view('gene')?.cue ?? null, null, JSON.stringify(over));
  }
});

test('the host: an arrival is a light presence for her mood and a glance; leaving is only a journal line', () => {
  const r = rig();
  r.tick();
  r.host.signal(signal());
  r.feed(signal({ present: false }), 2 * MINUTE);
  r.advance(1_000); r.host.signal(signal());
  assert.deepEqual(r.presence.map(([id, relief]) => [id, Math.round(relief)]), [['gene', 8]], 'default card: 0.4 × the chat relief');
  assert.equal(r.host.view('gene')!.cue!.kind, 'glance');
  assert.deepEqual(r.journal, ['leave:-', 'arrive:-']);
});

test('the host: her own stretch comes when the user sat long, only while she may show it, then the next one is a new cycle', () => {
  const r = rig({ random: () => 0 }); // 6 × 5 min = 30 min
  r.tick(); r.host.signal(signal());
  r.feed(signal(), 30 * MINUTE - 2_000);
  assert.equal(r.host.view('gene')!.cue, null, 'not yet');
  r.feed(signal(), 2_000);
  const cue = r.host.view('gene')!.cue!;
  assert.deepEqual([cue.kind, cue.source, cue.at === r.now()], ['stretch', 'own', true]);
  assert.deepEqual(r.journal, ['own:-']);
  r.feed(signal(), 30 * MINUTE - 2_000);
  assert.equal(r.journal.length, 1, 'not again before another cycle');
  r.feed(signal(), 2_000);
  assert.equal(r.journal.length, 2);
  // While the user is busy with her it waits (it is hers, not a reminder: no hurry).
  const busy = rig({ random: () => 0, canExpress: false });
  busy.tick(); busy.host.signal(signal());
  busy.feed(signal(), 40 * MINUTE);
  assert.deepEqual(busy.journal, []);
});

test('在场 is not an interaction: boredom drops a little; the interaction clock, reason, trend and freshness stay; boredom then rises as usual', () => {
  const p = structuredClone(DEFAULT_MOOD_PARAMETERS);
  let state = advanceMood(createMoodState(0, p), 30 * MINUTE, { online: true }, p);
  assert.ok(state.boredom > 40, `bored: ${state.boredom}`);
  const after = applyMoodPresence(state, { id: 'p1', relief: 8 }, 30 * MINUTE, p);
  assert.equal(after.boredom, state.boredom - 8);
  assert.equal(after.lastInteractionAt, state.lastInteractionAt);
  assert.deepEqual(after.trend, state.trend); assert.deepEqual(after.freshness, state.freshness); assert.equal(after.reason, state.reason);
  assert.deepEqual(after.values, state.values); assert.equal(after.onlineIdleMs, state.onlineIdleMs);
  assert.equal(applyMoodPresence(after, { id: 'p1', relief: 8 }, 30 * MINUTE, p).boredom, after.boredom, 'the same presence twice is one');
  const later = advanceMood(after, 31 * MINUTE, { online: true }, p);
  assert.equal(Math.round((later.boredom - after.boredom) * 100) / 100, p.boredom.perMinute, 'boredom keeps rising the usual way');
  state = after;
  assert.equal(getMoodSnapshot(state, 30 * MINUTE, p).lastInteractionAt, null);
});

test('在场 through the real services: an arrival lowers boredom; relationship days, her read of the user and her own life do not see it', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-pose-presence-'));
  try {
    const service = new CompanionService(directory, () => {});
    service.mood.activate('gene');
    const profile = (service.mood as unknown as { profiles: Map<string, { state: { boredom: number } }> }).profiles.get('gene')!;
    profile.state.boredom = 60;
    service.herLifeTick(true);
    const relationship = JSON.stringify(service.relationship.view('gene')), herLife = service.herLife.view('gene')?.activity;
    const userState = JSON.stringify(service.userState.view('gene'));
    const before = service.mood.get().snapshot;
    const start = Date.now();
    service.pose.signal(signal(), start);
    for (let t = 2_000; t <= 5 * MINUTE; t += 2_000) service.pose.signal(signal({ present: false }), start + t);
    service.pose.signal(signal(), start + 5 * MINUTE + 1_000);
    const after = service.mood.get().snapshot;
    assert.ok(after.boredom < before.boredom - 7, `${before.boredom} → ${after.boredom}`);
    assert.equal(after.lastInteractionAt, before.lastInteractionAt, 'not an interaction');
    assert.equal(after.reason, before.reason, 'no reason line');
    assert.equal(JSON.stringify(service.relationship.view('gene')), relationship, '熟悉度 untouched');
    assert.equal(JSON.stringify(service.userState.view('gene')), userState, '读懂你的情绪 untouched');
    assert.equal(service.herLife.view('gene')?.activity, herLife, 'her own life untouched');
    await service.flush().catch(() => {});
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the inner loop line: only while sensing runs; abstract words; the prompt without it is byte for byte the same', () => {
  const r = rig();
  r.tick();
  assert.equal(r.host.innerLoopLine(), '');
  r.host.signal(signal());
  r.feed(signal(), 50 * MINUTE - 2_000);
  r.advance(2_000); r.host.signal(signal({ events: ['stretch'] }));
  const line = r.host.innerLoopLine();
  assert.equal(line, '你看不到摄像头画面，只知道应用在本机识别到的这些：用户在电脑前，正对着屏幕，坐了约 50 分钟，刚才伸了个懒腰。这不是你亲眼看到的，不要说成是你看见的。');
  assert.equal(poseInnerLoopLine({ present: false, facing: 'unknown', posture: 'unknown', sittingMinutes: null, awayMinutes: 12, recent: [] }),
    '你看不到摄像头画面，只知道应用在本机识别到的这些：用户现在不在电脑前（离开约 12 分钟）。这不是你亲眼看到的，不要说成是你看见的。');
  assert.match(poseInnerLoopLine({ present: true, facing: 'side', posture: 'slumped', sittingMinutes: 1, awayMinutes: null, recent: ['wave'] }), /侧着身，趴在桌上，刚坐下没多久，刚才冲你挥了挥手/u);
  // Through the inner loop's own context reader: the line sits in 【此刻】; without it nothing at all changes.
  const sources = (pose?: () => string): InnerLoopContextSources => ({ now: () => 0, localMinute: () => 15 * 60, persona: () => '角色', language: () => '', mood: () => '心情',
    parameters: () => structuredClone(DEFAULT_MOOD_PARAMETERS), lastInteractionAt: () => null, profileEnabled: () => false, profilePoints: () => '',
    audioReading: () => false, ambientText: () => '', ...(pose ? { pose } : {}) });
  const claim = { id: 'c', kind: 'motion' as const, at: 0, characterId: 'gene' };
  const quiet = { quiet: false, asleep: false, drowsy: false, night: false };
  const without = innerLoopPrompt(sources(), claim as never, false, quiet);
  assert.equal(innerLoopPrompt(sources(() => ''), claim as never, false, quiet), without, 'sensing off: the very same prompt');
  const withLine = innerLoopPrompt(sources(() => line), claim as never, false, quiet);
  assert.ok(withLine.includes(line));
  assert.equal(withLine.replace(`\n${line}`, ''), without, 'the only difference is the one line');
  assert.ok(withLine.indexOf(line) < withLine.indexOf('【怎么选】'), 'in 【此刻】');
  assert.equal(buildInnerLoopPrompt({ persona: 'p', mood: 'm', weights: DEFAULT_MOOD_PARAMETERS.weights, intensity: DEFAULT_MOOD_PARAMETERS.intensity, localMinute: 0,
    minutesSinceInteraction: null, cue: 'speech', allowSpeech: true, quiet, pose: '<script>' }).includes('<script>'), false, 'the line is quoted like any app block');
});

test('privacy: views, lines, journal lines and the diary line hold fixed words, enums and times only; extra signal fields are refused upstream', () => {
  const r = rig();
  r.tick();
  r.host.signal(signal());
  r.advance(1_000); r.host.signal(signal({ events: ['wave'] }));
  const view = r.host.view('gene')!;
  assert.deepEqual(Object.keys(view).sort(), ['attention', 'boost', 'cue']);
  assert.deepEqual(Object.keys(view.cue!).sort(), ['at', 'id', 'kind', 'source', 'strength']);
  assert.deepEqual(readPoseReactionView(JSON.parse(JSON.stringify(view))), view);
  assert.equal(readPoseReactionView({ ...view, keypoints: [[1, 2]] })?.cue?.kind, 'wave', 'the stage reads only its own fields');
  assert.equal(readPoseReactionView({ ...view, cue: { ...view.cue!, id: '../x' } }), null);
  assert.equal(parsePoseSignal({ ...signal(), keypoints: [[0.1, 0.2]] }), null, 'a signal with coordinates never reaches the host');
  const words = [r.host.innerLoopLine(), r.host.diaryLine('gene', 0, Infinity)].join('\n');
  assert.equal(/[A-Za-z]|\d+\.\d|[[\]{}]/u.test(words), false, words);
  for (const event of ['arrive', 'leave', 'follow', 'pass', 'own'] as const) {
    const kind = event === 'follow' || event === 'pass' ? 'stretch' : null;
    const entry = buildJournalEntry(poseInput('gene', event, kind), 0)!;
    assert.ok(entry, event);
    assert.deepEqual(Object.keys(entry).sort(), ['at', 'characterId', 'event', 'kind', 'reason', 'time', 'type', 'v']);
    assert.match(describeJournalEntry(entry, (s: string) => s), /^\d\d:\d\d [^\d]+$/u);
  }
  const smuggled = buildJournalEntry({ type: 'pose', characterId: 'gene', event: 'follow', kind: 'yawn', x: 0.4, frame: 'data' }, 0)!;
  assert.equal(smuggled.reason, '你打了个哈欠，她也跟着打了一个');
  assert.deepEqual(Object.keys(smuggled).sort(), ['at', 'characterId', 'event', 'kind', 'reason', 'time', 'type', 'v'], 'a coordinate or a frame never reaches a line');
  assert.equal(buildJournalEntry({ type: 'pose', characterId: 'gene', event: 'follow', kind: 'jump' }, 0), null);
  assert.equal(buildJournalEntry({ type: 'pose', characterId: 'gene', event: 'arrive', kind: 'wave' }, 0), null);
});

test('the diary line counts her own moments by day; the her-life material carries it', async () => {
  assert.equal(poseDiaryLine([], 0, 1), '');
  const day = [{ at: 10, kind: 'yawn', source: 'follow' }, { at: 20, kind: 'yawn', source: 'follow' }, { at: 30, kind: 'stretch', source: 'own' },
    { at: 40, kind: 'wave', source: 'follow' }, { at: 99, kind: 'stretch', source: 'follow' }] as const;
  assert.equal(poseDiaryLine(day, 0, 50), '这天用户在电脑前时你做过的小事（应用记下的，只是素材，可写可不写）：跟着用户打了 2 个哈欠；冲用户挥了 1 次手；陪用户坐久了，自己伸了 1 次懒腰。');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-pose-diary-'));
  try {
    const service = new CompanionService(directory, () => {}, { pose: { random: () => 0 } });
    service.mood.activate('gene');
    service.herLifeTick(true);
    assert.equal(service.poseSimulate('yawn'), 'ok');
    assert.match(service.herLife.diaryLine('gene', 0, Date.now() + 1_000, () => 600), /跟着用户打了 1 个哈欠/u);
    service.mood.setExpressions(false);
    assert.equal(service.poseSimulate('wave'), 'expressions-off');
    await service.flush().catch(() => {});
  } finally { await rm(directory, { recursive: true, force: true }); }
  const fresh = await mkdtemp(path.join(os.tmpdir(), 'soft-pose-diary-'));
  try {
    const none = new CompanionService(fresh, () => {});
    assert.equal(none.poseSimulate('yawn'), 'no-character');
    await none.flush().catch(() => {});
  } finally { await rm(fresh, { recursive: true, force: true }); }
});

test('a test simulation is a pretend session (ten minutes), a real signal replaces it; "坐了很久" gives her own stretch at once', () => {
  const r = rig();
  r.tick();
  assert.equal(r.host.simulate('sat'), 'ok');
  assert.deepEqual([r.host.view('gene')!.cue!.kind, r.host.view('gene')!.cue!.source], ['stretch', 'own']);
  assert.match(r.host.innerLoopLine(), /坐了约 50 分钟/u);
  r.advance(9 * MINUTE); r.tick();
  assert.notEqual(r.host.innerLoopLine(), '');
  r.advance(2 * MINUTE); r.tick();
  assert.equal(r.host.innerLoopLine(), '', 'the pretend session ended');
  r.host.simulate('arrive');
  assert.equal(r.presence.length, 1);
  r.host.signal(signal({ facing: 'away' }));
  assert.equal(r.host.view('gene')!.attention, 0, 'a real signal replaced the pretend session');
  r.host.sensing(false);
  assert.equal(r.host.innerLoopLine(), '');
});

test('summary words come only from the session (no frame, no position): every key is an enum, a whole minute or a list of kinds', () => {
  const session: PoseSession = stepPoseSession(null, signal(), 0, 90_000).session;
  const summary = poseSummary(session, 5 * MINUTE + 1)!;
  assert.equal(summary, null, 'stale after 10 s without a signal');
  const live = poseSummary(session, 5_000)!;
  assert.deepEqual(Object.keys(live).sort(), ['awayMinutes', 'facing', 'posture', 'present', 'recent', 'sittingMinutes']);
});

// ---------------------------------------------------------------- Codex T-112 round 032 (fixed 55d5bd4)

// F02: sensing off at 100 ms, the prompt line went empty at once, yet the stretch queued before it started at its time on the
// stage. Off is off: every reaction queued and not yet started is withdrawn when sensing turns off.
test('round 032: turning sensing off withdraws every queued reaction that has not started; the stage never plays it', () => {
  for (const kind of ['stretch', 'yawn', 'wave'] as const) {
    const r = rig();
    r.tick();
    r.host.signal(signal({ events: [kind] }));
    const cue = r.host.view('gene')!.cue!;
    assert.equal(cue.kind, kind);
    const stage = new PoseReactionStage(), owner = {};
    const frame = () => stage.frame(1 / 60, { owner, view: r.host.view('gene'), nowMs: r.now(),
      gates: { expressive: true, engaged: false, bodyOwned: false, asleep: false, posture: 50 }, game: false }, null);
    frame();
    r.advance(100); r.host.sensing(false); frame();
    assert.equal(r.host.innerLoopLine(), '');
    assert.equal(r.host.view('gene'), null, `${kind}: nothing left in her view`);
    r.advance(cue.at - r.now()); frame();
    r.advance(500); frame();
    assert.equal(stage.getState().played, 0, `${kind}: never started after sensing went off`);
    assert.equal(stage.getState().playing, null);
  }
  // The arrival glance and her own stretch go too (all of them come from sensing).
  const own = rig();
  own.tick();
  own.feed(signal(), 2_000);
  own.host.simulate('sat');
  assert.equal(own.host.view('gene')!.cue!.source, 'own');
  own.host.signal(signal()); // a real signal ends the simulation; the queued stretch is still there
  assert.ok(own.host.view('gene')!.cue);
  own.host.sensing(false);
  assert.equal(own.host.view('gene'), null);
});

// F01: away threshold 90 s; the last absent sample at 89 s and the return at 90 s (or 90.001 s): an arrival, but the old sitting
// time went on (a 30-minute sitting became "about 32 minutes" and her own stretch came a second later). A return that crosses the
// threshold without a sample past it is treated as not knowing: the sitting time starts again, the same as an arrival.
test('round 032: back after the away threshold with no absent sample past it, the sitting time starts again (the same rule as the arrival)', () => {
  const after = POSE_REACTION_POLICY.arriveAfterMs(character());
  for (const gap of [after - 1, after, after + 1, after + 1_000]) {
    let session = stepPoseSession(null, signal(), 0, after).session;
    const awayAt = 1_000;
    for (let elapsed = 0; elapsed <= after - 1_000 && elapsed < gap; elapsed += 1_000) session = stepPoseSession(session, signal({ present: false }), awayAt + elapsed, after).session;
    const now = awayAt + gap, back = stepPoseSession(session, signal(), now, after);
    if (gap < after) {
      assert.equal(back.arrived, false, `${gap}: a short absence`);
      assert.equal(back.session.sittingSince, 0, `${gap}: the sitting time goes on`);
    } else {
      assert.equal(back.arrived, true, `${gap}: an arrival`);
      assert.equal(back.session.sittingSince, now, `${gap}: the sitting time starts again`);
      assert.equal(poseSummary(back.session, now)!.sittingMinutes, 0);
    }
  }
  // A gap with no signal at all for that long: unknown, so the sitting time starts again (no arrival: no absence was seen).
  const seated = stepPoseSession(null, signal(), 0, after).session;
  const resumed = stepPoseSession(seated, signal(), after + 5_000, after);
  assert.equal(resumed.arrived, false);
  assert.equal(resumed.session.sittingSince, after + 5_000);
});

test('round 032: through the host, a long sitting then a return at the threshold does not bring her own stretch a second later', () => {
  const r = rig();
  r.tick();
  r.feed(signal(), 29 * MINUTE); // her own stretch is due at 30 minutes here (random 0: six 5-minute intervals)
  assert.equal(r.host.view('gene')!.cue, null, 'not yet');
  const after = POSE_REACTION_POLICY.arriveAfterMs(character());
  // Absent samples every second from leaving (0 s) up to 89 s, then back at 90.001 s.
  for (let elapsed = 0; elapsed < after; elapsed += 1_000) { r.advance(1_000); r.host.signal(signal({ present: false })); r.tick(); }
  r.advance(1_001); r.host.signal(signal());
  assert.equal(r.host.view('gene')!.cue!.source, 'arrive', 'an arrival: the glance');
  assert.doesNotMatch(r.host.innerLoopLine(), /坐了约 3\d 分钟/u, 'not the old sitting time');
  r.advance(1_000); r.tick();
  assert.equal(r.host.view('gene')!.cue!.source, 'arrive', 'no own stretch right after coming back');
});
