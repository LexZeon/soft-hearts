// Unbound v1 step 4 「她自己的生活」 (docs/claude/2026-11-17-unbound-step4.md), the pure parts: the arbiter's order and its easing out,
// the gates on what she may read about you (signals, the pose adapter with its confidence bands), the cues and reactions, the
// mood-set pace, the places, the saved place, and the plans that cross IPC. Each gate here has a mutation in scripts/dev/mutations/unbound.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { arbitrate, gazeOwner, interactionOf, quietOf, topWant, type ArbiterInput, type LifeSituation } from '../shared/unbound/life/arbiter';
import { LIFE_KNOB_DEFAULTS, lifeDrives, lifeRates, patchLifeKnobs } from '../shared/unbound/life/mood-read';
import { NO_SIGNALS, foregroundKind, lifeSignals, someoneInFront, soundPlaying, talkingToOthers, userDoing, type LifeSignals } from '../shared/unbound/life/signals';
import { confidenceBand, readPose } from '../shared/unbound/life/pose-read';
import { PresenceTracker, REACTION_TIMING, reactionFor, temperDrives } from '../shared/unbound/life/reactions';
import { PLACE_ZONES, insideZone, placeZone } from '../shared/unbound/life/actions/place';
import { GLANCE } from '../shared/unbound/life/actions/glance';
import { LIFE_ACTIONS, LIFE_ACTION_IDS } from '../shared/unbound/life/registry';
import { parseSavedPlace, placementOfSpot, spotOfPlacement } from '../shared/unbound/life/place-record';
import { parseLifeCommand, parseLifePlan, parseLifeReport, sampleKeys, type LifePlan } from '../shared/unbound/life/types';
import { parseLifePatch } from '../shared/unbound/life/view';
import { NEUTRAL_MOOD, type MoodReading } from '../shared/unbound/director';
import type { LifeContext } from '../shared/unbound/life/action';

const QUIET: LifeSituation = { shown: true, asleep: false, inCall: false, typing: false, waiting: false, clicked: false, replying: false, readingAloud: false,
  signals: { ...NO_SIGNALS, doing: 'paused', idleSeconds: 120 }, mood: { ...NEUTRAL_MOOD } };
const input = (patch: Partial<ArbiterInput> = {}): ArbiterInput => ({ now: 100_000, interaction: null, quiet: null, running: null, wants: [], lastNoticeableEndAt: null,
  interactionEndedAt: null, knobs: LIFE_KNOB_DEFAULTS, ...patch });

test('arbiter: you first; a higher want makes the running lower one ease out and starts only after it is done; one at a time', () => {
  // You interacting: whatever of hers runs eases out (a peek too), nothing starts.
  for (const level of ['idle', 'small', 'place', 'peek'] as const)
    assert.deepEqual(arbitrate(input({ interaction: 'click', running: { id: 'a', level, easing: false }, wants: [{ id: 'glance', level: 'small' }] })), { kind: 'yield', id: 'a', reason: 'user' });
  assert.deepEqual(arbitrate(input({ interaction: 'reading', wants: [{ id: 'glance', level: 'small', prompt: true }] })), { kind: 'wait', why: 'user' });
  // A higher want: the lower one eases out (once); never a start while anything runs.
  assert.deepEqual(arbitrate(input({ running: { id: 'p', level: 'idle', easing: false }, wants: [{ id: 'shift', level: 'small' }] })), { kind: 'yield', id: 'p', reason: 'higher' });
  assert.deepEqual(arbitrate(input({ running: { id: 'p', level: 'idle', easing: true }, wants: [{ id: 'shift', level: 'small' }] })), { kind: 'wait', why: 'busy' });
  assert.deepEqual(arbitrate(input({ running: { id: 's', level: 'small', easing: false }, wants: [{ id: 'pause', level: 'idle' }, { id: 'glance', level: 'small' }] })), { kind: 'wait', why: 'busy' });
  assert.deepEqual(arbitrate(input({ running: { id: 's', level: 'place', easing: false }, wants: [{ id: 'peek', level: 'peek' }] })), { kind: 'yield', id: 's', reason: 'higher' });
  // Free: the highest want starts.
  assert.deepEqual(arbitrate(input({ wants: [{ id: 'pause', level: 'idle' }, { id: 'shift', level: 'small' }, { id: 'place', level: 'place' }] })), { kind: 'start', id: 'place' });
  assert.equal(topWant([{ id: 'shift', level: 'small' }, { id: 'glance', level: 'small', prompt: true }])!.id, 'glance', 'a reaction wins a tie');
});

test('arbiter: quiet when there is no chance, a gap between two things you notice, a wait after you; a reaction skips the gaps only', () => {
  const want = [{ id: 'shift', level: 'small' as const }];
  assert.deepEqual(arbitrate(input({ quiet: 'asleep', wants: want })), { kind: 'wait', why: 'quiet' });
  assert.deepEqual(arbitrate(input({ quiet: 'asleep', wants: [{ id: 'glance', level: 'small', prompt: true }] })), { kind: 'wait', why: 'quiet' }, 'asleep: not even a reaction');
  assert.deepEqual(arbitrate(input({ wants: want, lastNoticeableEndAt: 100_000 - 10_000 })), { kind: 'wait', why: 'gap' });
  assert.deepEqual(arbitrate(input({ wants: want, lastNoticeableEndAt: 100_000 - 50_000 })), { kind: 'start', id: 'shift' });
  assert.deepEqual(arbitrate(input({ wants: [{ id: 'pause', level: 'idle' }], lastNoticeableEndAt: 100_000 - 1_000 })), { kind: 'start', id: 'pause' }, 'an idle pause is texture: no gap');
  assert.deepEqual(arbitrate(input({ wants: want, interactionEndedAt: 100_000 - 5_000 })), { kind: 'wait', why: 'after-user' });
  assert.deepEqual(arbitrate(input({ wants: [{ id: 'glance', level: 'small', prompt: true }], lastNoticeableEndAt: 99_000, interactionEndedAt: 99_000 })), { kind: 'start', id: 'glance' });
  assert.deepEqual(arbitrate(input({ wants: want, lastNoticeableEndAt: 100_000 - 10_000, speed: 20 })), { kind: 'start', id: 'shift' }, 'fast-forward shortens the gap');
});

test('what counts as you interacting (each one alone), and what is no chance', () => {
  const none = { inCall: false, typing: false, waiting: false, clicked: false, replying: false, readingAloud: false };
  assert.equal(interactionOf(none), null);
  for (const [key, word] of [['inCall', 'call'], ['typing', 'typing'], ['waiting', 'waiting'], ['clicked', 'click'], ['replying', 'reply'], ['readingAloud', 'reading']] as const)
    assert.equal(interactionOf({ ...none, [key]: true }), word, key);
  assert.equal(quietOf(QUIET), null);
  assert.equal(quietOf({ ...QUIET, shown: false }), 'not-shown');
  assert.equal(quietOf({ ...QUIET, asleep: true }), 'asleep');
  assert.equal(quietOf({ ...QUIET, signals: { ...QUIET.signals, fullscreen: true } }), 'fullscreen');
  assert.equal(quietOf({ ...QUIET, signals: { ...QUIET.signals, doing: 'away' } }), 'away', 'away and the camera cannot tell');
  assert.equal(quietOf({ ...QUIET, signals: { ...QUIET.signals, doing: 'away', someoneInFront: false } }), null, 'the camera saw you leave: she wanders');
  assert.equal(quietOf({ ...QUIET, mood: null }), 'no-mood');
  assert.equal(gazeOwner({ peekActive: true, interaction: 'click', facing: true, running: null }), 'peek');
  assert.equal(gazeOwner({ peekActive: false, interaction: 'click', facing: true, running: null }), 'user');
  assert.equal(gazeOwner({ peekActive: false, interaction: null, facing: true, running: { id: 'g', level: 'small', easing: false } }), 'facing');
  assert.equal(gazeOwner({ peekActive: false, interaction: null, facing: false, running: { id: 'g', level: 'small', easing: false } }), 'action');
  assert.equal(gazeOwner({ peekActive: false, interaction: null, facing: false, running: null }), 'free');
});

test('signals: only the listed readings pass; the program in front only as a closed kind, never a name or a title', () => {
  for (const title of ['Code.exe', 'chrome.exe', '工作周报.docx - Word', 'YouTube - 某个视频', 'video ', 'VIDEO', '', null, 42, { activity: 'video' }])
    assert.equal(foregroundKind(title, 10), null, String(title));
  assert.equal(foregroundKind('video', 10), 'video');
  assert.equal(foregroundKind('game', 500), 'game');
  assert.equal(foregroundKind('code', 10), 'typing');
  assert.equal(foregroundKind('code', 120), 'idle');
  assert.equal(foregroundKind('web', null), null);
  assert.equal(userDoing('busy', null), 'busy');
  assert.equal(userDoing('pause', null), 'paused');
  assert.equal(userDoing('away', 3), 'away', 'locked or asleep');
  assert.equal(userDoing('busy', 1_000), 'away');
  assert.equal(userDoing('busy', 70), 'paused');
  assert.equal(someoneInFront(false, { present: true }), null, 'only while she is out');
  assert.equal(someoneInFront(true, { present: true }), true);
  assert.equal(someoneInFront(true, null), null);
  const raw = { idleSeconds: 5, state: 'busy', out: true, pose: { present: true, facing: 'toward', face: { x: 0.5, y: 0.4 }, points: [[0.1, 0.2]] }, activity: 'Code.exe',
    talkedAt: 1_000, sound: 'music', now: 5_000, title: '秘密.txt', windowTitle: 'x', words: '你好' } as Record<string, unknown>;
  const s = lifeSignals(raw);
  assert.deepEqual(Object.keys(s).sort(), ['doing', 'foreground', 'fullscreen', 'idleSeconds', 'pose', 'someoneInFront', 'soundPlaying', 'talkingToOthers']);
  const text = JSON.stringify(s);
  for (const leak of ['Code.exe', '秘密', '你好', 'points', '"face"', '0.4']) assert.ok(!text.includes(leak), leak);
  assert.equal(s.foreground, null, 'a program name is not a kind');
  assert.equal(s.talkingToOthers, true);
  assert.equal(s.soundPlaying, true);
  const inside = lifeSignals({ ...raw, out: false });
  assert.deepEqual([inside.pose, inside.someoneInFront, inside.foreground, inside.talkingToOthers, inside.soundPlaying], [null, null, null, false, false], 'nothing of the senses while she is in');
  assert.equal(lifeSignals({ out: false, activity: 'video', idleSeconds: 5 }).foreground, null, 'not even a real kind word while she is in');
  assert.equal(talkingToOthers(1_000, 1_000 + 19_000), true);
  assert.equal(talkingToOthers(1_000, 1_000 + 21_000), false);
  assert.equal(talkingToOthers('1000', 1_500), false);
  for (const kind of ['music', 'show', 'talk']) assert.equal(soundPlaying(kind), true);
  for (const kind of ['quiet', 'unsure', 'Spotify.exe', undefined]) assert.equal(soundPlaying(kind), false);
});

test('the pose adapter: only present / facing / posture / wave / stretch, each banded; a missing confidence is unsure', () => {
  assert.equal(confidenceBand(undefined), 'unsure');
  assert.equal(confidenceBand(Number.NaN), 'unsure');
  assert.equal(confidenceBand(0.9), 'sure');
  assert.equal(confidenceBand(0.5), 'maybe');
  assert.equal(confidenceBand(0.2), 'unsure');
  const today = readPose({ present: true, confidence: 0.9, facing: 'toward', posture: 'leaning-back', events: ['wave'] })!;
  assert.deepEqual(today, { present: true, facing: { value: 'toward', band: 'unsure' }, posture: { value: 'leaning-back', band: 'unsure' }, wave: 'unsure', stretch: null },
    'a signal without confidence fields: everything is unsure');
  const later = readPose({ present: true, facing: 'toward', facingConfidence: 0.8, posture: 'slumped', postureConfidence: 0.5, events: ['wave', 'stretch'], eventConfidence: { wave: 0.95, stretch: 0.45 },
    face: { x: 1, y: 1 }, points: [] })!;
  assert.deepEqual(later, { present: true, facing: { value: 'toward', band: 'sure' }, posture: { value: 'slumped', band: 'maybe' }, wave: 'sure', stretch: 'maybe' });
  assert.equal(readPose({ present: false, facing: 'toward', facingConfidence: 1 })!.facing, null, 'nobody: no facing');
  assert.equal(readPose(null), null);
  assert.equal(readPose({ facing: 'toward' }), null);
});

const pose = (patch: Record<string, unknown>): LifeSignals => lifeSignals({ out: true, idleSeconds: 30, state: 'busy', pose: { present: true, ...patch }, now: 0 });
test('cues: leaving, coming back after a while, facing her (sure or maybe only), waves and stretches spaced, leaning back; nothing for unsure', () => {
  const tracker = new PresenceTracker(), cues: string[] = [];
  const at = (t: number, s: LifeSignals) => { for (const cue of tracker.update(s, t)) cues.push(`${cue.kind}:${cue.band}${cue.awayMs ? `:${Math.round(cue.awayMs / 1000)}` : ''}`); };
  at(0, pose({ facing: 'toward' })); at(5_000, pose({ facing: 'toward' })); // unsure facing: nothing
  at(6_000, pose({ facing: 'toward', facingConfidence: 0.9 })); at(9_500, pose({ facing: 'toward', facingConfidence: 0.9 })); at(15_000, pose({ facing: 'toward', facingConfidence: 0.9 }));
  at(16_000, pose({ events: ['wave'], eventConfidence: { wave: 0.9 } })); at(17_000, pose({ events: ['wave'], eventConfidence: { wave: 0.9 } }));
  at(18_000, pose({ events: ['stretch'] }));
  at(20_000, pose({ posture: 'leaning-back', postureConfidence: 0.9 })); at(31_000, pose({ posture: 'leaning-back', postureConfidence: 0.9 }));
  at(40_000, pose({ present: false })); at(71_000, pose({ present: false }));
  assert.equal(tracker.away, true);
  at(150_000, pose({}));
  assert.deepEqual(cues, ['facing:sure', 'wave:sure', 'leaned-back:sure', 'left:sure', 'came-back:sure:110']);
  assert.deepEqual(reactionFor({ kind: 'came-back', band: 'sure', at: 0 }), ['place', 'glance']);
  assert.deepEqual(reactionFor({ kind: 'facing', band: 'maybe', at: 0 }), ['glance']);
  assert.deepEqual(reactionFor({ kind: 'facing', band: 'sure', at: 0 }), [], 'sure: she looks back with her gaze, no action');
  const short = new PresenceTracker();
  short.update(pose({}), 0); short.update(pose({ present: false }), 1_000);
  assert.deepEqual(short.update(pose({}), 1_000 + REACTION_TIMING.leftAfterMs - 1), [], 'a moment away is not leaving');
});

test('her pace from her mood: O up → more peeks and moves; A up → fewer moves, more idle pauses; N up → smaller; leaning back or talking → quieter', () => {
  const at = (m: Partial<MoodReading>) => lifeRates(lifeDrives({ ...NEUTRAL_MOOD, ...m }));
  const neutral = at({}), lively = at({ O: 100, D: 100 }), sleepy = at({ A: 0.8 });
  assert.equal(neutral.peekPerHour, 2, 'at her baseline: two an hour, as before step 4');
  assert.equal(lively.peekPerHour, 4);
  assert.ok(lively.placeMinutes < neutral.placeMinutes && lively.smallMinutes < neutral.smallMinutes);
  assert.ok(sleepy.peekPerHour <= neutral.peekPerHour && sleepy.placeMinutes > neutral.placeMinutes && sleepy.pausesPerMinute > neutral.pausesPerMinute);
  for (const r of [neutral, lively, sleepy, at({ O: 0, A: 1, N: 100 }), at({ O: 100, D: 100 })]) {
    assert.ok(r.peekPerHour >= 1 && r.peekPerHour <= 4 && r.placeMinutes >= 10 && r.placeMinutes <= 30 && r.smallMinutes >= 2 && r.smallMinutes <= 6, JSON.stringify(r));
    assert.ok(r.pausesPerMinute >= 3 && r.pausesPerMinute <= 8, 'inside the people\'s 2.6–10.7 a minute');
  }
  assert.ok(lifeDrives({ ...NEUTRAL_MOOD, N: 90 }).amplitude < 1);
  const d = lifeDrives(NEUTRAL_MOOD);
  assert.ok(temperDrives(d, { ...NO_SIGNALS, talkingToOthers: true }).energy < d.energy);
  assert.ok(temperDrives(d, { ...NO_SIGNALS, pose: { present: true, facing: null, posture: { value: 'leaning-back', band: 'sure' }, wave: null, stretch: null } }).energy < d.energy);
  assert.equal(temperDrives(d, { ...NO_SIGNALS, pose: { present: true, facing: null, posture: { value: 'leaning-back', band: 'maybe' }, wave: null, stretch: null } }), d, 'a maybe does not change her');
  const k = patchLifeKnobs(LIFE_KNOB_DEFAULTS, { peekPerHourMin: 5, peekPerHourMax: 2, gapSeconds: 99999, junk: 1 });
  assert.deepEqual([k.peekPerHourMin, k.peekPerHourMax, k.gapSeconds], [2, 5, LIFE_KNOB_DEFAULTS.gapSeconds]);
});

function context(patch: Partial<LifeContext> & { signals?: Partial<LifeSignals>; mood?: Partial<MoodReading> } = {}): LifeContext {
  const situation = { ...QUIET, signals: { ...QUIET.signals, ...patch.signals }, mood: { ...NEUTRAL_MOOD, ...patch.mood } };
  const drives = lifeDrives(situation.mood);
  let r = 0.3;
  return { now: 0, situation, drives, rates: lifeRates(drives), here: { across: 0.78, size: 4.275 / (8 + 0.55) }, toWorld: spot => ({ xM: (spot.across - 0.5) * 3, depthM: 4.275 / spot.size - 0.55 }),
    random: () => (r = (r * 9301 + 49297) % 233280 / 233280), trial: false, cue: null, youLeft: false, ...patch } as LifeContext;
}
test('places: busy → further and aside, paused → closer, sleepy → a corner, you left → anywhere, you came back → closer; already there: no walk', () => {
  assert.equal(placeZone(context({ signals: { doing: 'busy' } })), 'busy');
  assert.equal(placeZone(context({ signals: { doing: 'paused', foreground: 'video' } })), 'busy');
  assert.equal(placeZone(context({ signals: { doing: 'paused' } })), 'paused');
  assert.equal(placeZone(context({ mood: { A: 0.8 } })), 'sleepy');
  assert.equal(placeZone(context({ youLeft: true })), 'wander');
  assert.equal(placeZone(context({ youLeft: true, cue: { kind: 'came-back', band: 'sure', at: 0 } })), 'paused');
  const place = LIFE_ACTIONS.find(a => a.id === 'place')!;
  for (let i = 0; i < 20; i++) {
    const busy = place.plan(context({ signals: { doing: 'busy' } }))!, paused = place.plan(context())!;
    const size = (walk: { depthM: number }) => 4.275 / (walk.depthM + 0.55); // the reference laptop (8 m = 0.5), as context()'s toWorld
    assert.ok(size(busy.plan.walk!) <= PLACE_ZONES.busy.size[1] + 1e-9 && busy.plan.walk!.depthM > paused.plan.walk!.depthM);
    assert.equal(busy.answerable, false);
    assert.equal(paused.answerable, true, 'coming closer while you paused can be answered');
  }
  assert.equal(place.notNow(context({ here: { across: 0.68, size: 4.275 / (7.3 + 0.55) } })), '已经站在合适的地方');
  assert.equal(insideZone({ across: 0.5, size: 4.275 / (8 + 0.55) }, 'paused'), false);
  const tense = place.plan(context({ mood: { N: 95 }, signals: { doing: 'busy' } }))!.plan.walk!, calm = place.plan(context({ signals: { doing: 'busy' } }))!.plan.walk!;
  assert.ok(tense.depthM > calm.depthM + 0.5, 'tense → further');
});

test('a glance: not over a video, a game, someone you talk to, sound, nobody there or while you work; yes to a wave or your coming back', () => {
  assert.equal(GLANCE.notNow(context()), null);
  for (const [signals, word] of [[{ foreground: 'video' }, '你在看视频'], [{ talkingToOthers: true }, '你在和别人说话'], [{ soundPlaying: true }, '电脑在放声音'],
    [{ doing: 'busy' }, '你在忙'], [{ someoneInFront: false }, '前面没人']] as const)
    assert.equal(GLANCE.notNow(context({ signals: signals as Partial<LifeSignals> })), word);
  const wave = { kind: 'wave' as const, band: 'sure' as const, at: 0 };
  assert.equal(GLANCE.notNow(context({ signals: { doing: 'busy', soundPlaying: true }, cue: wave })), null);
  assert.equal(GLANCE.notNow(context({ signals: { someoneInFront: false }, cue: wave })), '前面没人');
  const plain = GLANCE.plan(context())!.plan, waved = GLANCE.plan(context({ cue: wave }))!.plan;
  assert.ok(waved.keys.at(-1)!.t > plain.keys.at(-1)!.t, 'a sure wave: held longer');
});

test('the saved place: only two numbers in range; a spot round-trips through her floor on any screen', () => {
  assert.deepEqual(parseSavedPlace({ version: 1, across: 0.7, depthM: 9 }), { version: 1, across: 0.7, depthM: 9 });
  for (const bad of [null, [], { version: 2, across: 0.7, depthM: 9 }, { version: 1, across: 1.2, depthM: 9 }, { version: 1, across: 0.7, depthM: 40 }, { version: 1, across: '0.7', depthM: 9 },
    { version: 1, across: Number.NaN, depthM: 9 }, { version: 1, across: 0.7 }]) assert.equal(parseSavedPlace(bad), null, JSON.stringify(bad));
  assert.deepEqual(Object.keys(parseSavedPlace({ version: 1, across: 0.7, depthM: 9, title: 'x', foreground: 'video' })!), ['version', 'across', 'depthM'], 'nothing else is kept');
  const view = { screen: { widthM: 0.34, heightM: 0.21, source: 'measured' as const, detail: '' }, viewerDistanceM: 0.55 };
  const spot = spotOfPlacement(view, placementOfSpot(view, { across: 0.66, depthM: 9.5 }))!;
  assert.ok(Math.abs(spot.across - 0.66) < 1e-9 && spot.depthM === 9.5);
});

test('plans and reports that cross IPC: known actions, ranges, ascending keys; S5 between keys never jumps', () => {
  const plan: LifePlan = { action: 'shift', level: 'small', keys: [{ t: 0, hip: 0 }, { t: 1.6, hip: 0.9 }, { t: 9, hip: 0.9 }, { t: 10.8, hip: 0 }], walk: null, amplitude: 1, easeS: 1.4, waitQuickS: 0 };
  assert.deepEqual(parseLifePlan(plan, LIFE_ACTION_IDS), plan);
  for (const bad of [{ ...plan, action: 'hop' }, { ...plan, level: 'peek' }, { ...plan, keys: [{ t: 2 }, { t: 1 }] }, { ...plan, keys: [{ t: 0, hip: 3 }] }, { ...plan, keys: [{ t: 0, arms: 1 }] },
    { ...plan, walk: { xM: 0, depthM: 100, speedMps: 0.5 } }, { ...plan, easeS: 0 }, { ...plan, keys: [] }])
    assert.equal(parseLifePlan(bad, LIFE_ACTION_IDS), null, JSON.stringify(bad));
  assert.equal(parseLifeCommand({ type: 'start', id: 'x y', plan }, LIFE_ACTION_IDS), null);
  assert.deepEqual(parseLifeCommand({ type: 'attend', on: true, why: 'facing' }, LIFE_ACTION_IDS), { type: 'attend', on: true, why: 'facing' });
  assert.deepEqual(parseLifeReport({ id: 'life-1', phase: 'done', at: { xM: 1, depthM: 9 } }), { id: 'life-1', phase: 'done', at: { xM: 1, depthM: 9 } });
  assert.equal(parseLifeReport({ id: 'life-1', phase: 'done', title: 'x' }), null);
  let last = sampleKeys(plan.keys, 'hip', 0), lastStep = 0;
  for (let t = 1 / 60; t < 11; t += 1 / 60) {
    const v = sampleKeys(plan.keys, 'hip', t), step = v - last;
    assert.ok(Math.abs(step) < 0.02 && Math.abs(step - lastStep) < 0.002, `t ${t.toFixed(2)}: step ${step}`);
    last = v; lastStep = step;
  }
  assert.equal(sampleKeys(plan.keys, 'rate', 3), 1, 'an absent channel is at rest');
});

test('every registered action has its own file and words; the panel may only try a registered one, and knobs only in range', () => {
  assert.deepEqual([...LIFE_ACTION_IDS].sort(), ['glance', 'pause', 'place', 'shift']);
  assert.equal(new Set(LIFE_ACTION_IDS).size, LIFE_ACTION_IDS.length);
  for (const spec of LIFE_ACTIONS) assert.ok(spec.words && spec.level !== ('peek' as string) && spec.level !== ('user' as string));
  assert.deepEqual(parseLifePatch({ lifeTry: 'glance', lifeFast: true, lifeKnobs: { gapSeconds: 30 } }, LIFE_ACTION_IDS), { lifeTry: 'glance', lifeFast: true, lifeKnobs: { gapSeconds: 30 } });
  assert.throws(() => parseLifePatch({ lifeTry: 'peek' }, LIFE_ACTION_IDS));
  assert.throws(() => parseLifePatch({ lifeKnobs: { gapSeconds: 1 } }, LIFE_ACTION_IDS));
  assert.throws(() => parseLifePatch({ lifeKnobs: { userFrequency: 3 } }, LIFE_ACTION_IDS));
});
