/**
 * D2 / I-008: the existing interfaces the test entries call, each tested on the real class (not a fake): her own life
 * (HerLifeHost.startNow), the inner loop (forced attention in the mood model, MoodHost.forceAttention, InnerLoop.resetPacing),
 * her own mood (MoodHost.setTestMood / setTestFatigue, U-012), the game (RpsHost.testInvite/testStart), the diary
 * (DiaryWriter.writeNow), the music director (MusicChoice.rejudgeNow) and the companion's start-now for her life.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HerLifeHost, type HerLifeTickInput } from '../electron/her-life/host';
import { HER_LIFE_ACTIVITIES, herLifeIdleAfterMs } from '../shared/her-life';
import { MoodHost } from '../electron/mood';
import { CompanionService } from '../electron/companion';
import { InnerLoop, type InnerLoopDependencies } from '../electron/inner-loop/inner-loop';
import { ProactiveSpeechGate } from '../electron/proactive-speech-gate';
import { RpsHost } from '../electron/rps/host';
import { RpsStore } from '../electron/rps/store';
import { DiaryWriter, type DiaryProfiles } from '../electron/diary/diary-writer';
import { localDateKey, localDayRange, recentDiaryDates } from '../electron/diary/diary-dates';
import { userProfileScopeId, type UserProfileScope } from '../electron/user-profile';
import { MusicChoice, type MusicChoiceContext } from '../src/stage/music-choice';
import { moodLabelDanceDesire } from '../shared/music-desire';
import { DEFAULT_MOOD_PARAMETERS, advanceMood, applyMoodEvent, createMoodState, getMoodSnapshot, type MoodLabel, type MoodParameters } from '../shared/mood';
import { MOOD_LABELS } from '../shared/mood-runtime';
import { FATIGUE_TEST_F } from '../shared/mood-presets';
import { seeded } from './helpers/seeded';

const MINUTE = 60_000;
const card = (): MoodParameters => structuredClone(DEFAULT_MOOD_PARAMETERS);
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

// ------------------------------------------------------------------------------------------------ L2 她自己的生活

function lifeHost(options: { developer?: boolean; random?: () => number } = {}) {
  const clock = { now: 1_000 * MINUTE }, appended: string[] = [], changed: string[] = [];
  const host = new HerLifeHost({ file: () => null, diagnosticsFile: () => '/dev/her-life.jsonl', developerMode: () => options.developer === true,
    changed: id => changed.push(id), clock: () => clock.now, random: options.random ?? (() => 0.5), append: async (_file, line) => { appended.push(line); } });
  const input = { parameters: card(), mood: 'calm', localMinute: 14 * 60 };
  const tick = (over: Partial<HerLifeTickInput> = {}) => host.tick('gene', { now: clock.now, expressions: true, canExpress: true, phase: 'idle',
    lastInteractionAt: clock.now, fatigue: 'awake', parameters: card(), mood: 'calm', localMinute: 14 * 60, ...over });
  return { host, clock, appended, changed, input, tick };
}

test('L2: startNow starts the named state at once, as a rule-started state with the card\'s own duration, and tells the stage', () => {
  // I-006 step 3: 跟着看 needs the user to be watching something on the shared screen; a test command cannot start it by itself ("假装我在看视频" does).
  assert.equal(lifeHost().host.startNow('gene', 'watching', lifeHost().input), null);
  for (const activity of HER_LIFE_ACTIVITIES.filter(id => id !== 'watching')) {
    const h = lifeHost();
    assert.equal(h.host.startNow('gene', activity, h.input), activity);
    const view = h.host.view('gene')!;
    assert.equal(view.activity, activity);
    assert.equal(view.since, h.clock.now);
    if (activity === 'company' || activity === 'drowsy') assert.equal(view.until, Number.MAX_SAFE_INTEGER, activity);
    else assert.ok(view.until > view.since && view.until < Number.MAX_SAFE_INTEGER, activity);
    assert.deepEqual(h.changed, ['gene']);
  }
  assert.equal(lifeHost().host.startNow('gene', 'reading' as never, lifeHost().input), null, 'only her real states');
  assert.equal(lifeHost().host.startNow('../x', 'daydream', lifeHost().input), null);
});

test('L2: with no state named she picks one by her own rules (never drowsy, never the one she is in)', () => {
  for (let i = 0; i < 40; i++) {
    const h = lifeHost({ random: seeded(i + 1) });
    const first = h.host.startNow('gene', null, { ...h.input, mood: 'happy' })!;
    assert.ok(HER_LIFE_ACTIVITIES.includes(first)); assert.notEqual(first, 'drowsy');
    // Pretrial issue 10 (D2): "去忙自己的事" is her own thing, never "继续陪着你" (the help list says 发呆、哼歌、想事情之一).
    assert.notEqual(first, 'company', `seed ${i + 1}: picked "陪着你"`);
    const second = h.host.startNow('gene', null, h.input)!;
    assert.notEqual(second, 'drowsy'); assert.notEqual(second, 'company', `seed ${i + 1}: picked "陪着你" the second time`);
    assert.notEqual(second, first, 'another one than the one she is in');
  }
  // Whatever her card and mood weigh "陪着你" (a very close card, longing), the shortcut still picks one of her own things.
  for (let i = 0; i < 40; i++) {
    const h = lifeHost({ random: seeded(100 + i) });
    const close = { ...h.input, mood: 'longing', parameters: { ...card(), weights: { ...card().weights, close: 3 } } };
    assert.ok(['daydream', 'humming', 'thinking'].includes(h.host.startNow('gene', null, close)!));
  }
});

test('L2: the started state holds while the user is here, goes back to company on an interaction, and its time never reaches the diary', () => {
  const h = lifeHost();
  const t0 = h.clock.now;
  h.tick({ lastInteractionAt: t0 });
  h.host.startNow('gene', 'daydream', h.input);
  h.clock.now += 20 * MINUTE;
  h.tick({ lastInteractionAt: t0, canExpress: false });
  assert.equal(h.host.view('gene')!.activity, 'daydream', 'the user is here (typing, a reply, the pet hidden): nothing replaces it');
  const day = [h.clock.now - 3 * 60 * MINUTE, h.clock.now + 60 * MINUTE] as const;
  h.host.interact('gene', h.clock.now);
  assert.equal(h.host.view('gene')!.activity, 'company');
  assert.equal(h.host.diaryLine('gene', day[0], day[1], () => 14 * 60), '', 'a test state is not something she did on her own');
  // Control: the same twenty minutes as a state the rules started do reach the diary.
  const real = lifeHost();
  real.tick({ lastInteractionAt: real.clock.now - 60 * MINUTE });
  const started = real.host.view('gene')!;
  assert.notEqual(started.activity, 'company');
  real.clock.now += 20 * MINUTE;
  real.host.interact('gene', real.clock.now);
  assert.ok(real.host.diaryLine('gene', real.clock.now - 3 * 60 * MINUTE, real.clock.now + 60 * MINUTE, () => 14 * 60).length > 0);
  assert.ok(herLifeIdleAfterMs(card()) > 0);
});

test('L2: a developer-mode diagnostic line is written for the change (state names and times only)', async () => {
  const h = lifeHost({ developer: true });
  h.host.startNow('gene', 'humming', h.input);
  await flush();
  assert.equal(h.appended.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(h.appended[0])).sort(), ['at', 'from', 'to', 'until']);
  assert.equal(JSON.parse(h.appended[0]).to, 'humming');
});

// ------------------------------------------------------------------------------------------------ the companion and the mood host

async function withMood(run: (context: { host: MoodHost; clock: { now: number }; fatigue: { mono: number } }) => Promise<void>, options: { developer?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-test-command-'));
  const clock = { now: 5_000_000 }, fatigue = { mono: 1_000_000 };
  const host = new MoodHost(directory, () => {}, () => clock.now, { fatigueClock: { wallMs: () => clock.now, monotonicMs: () => fatigue.mono, localMinute: () => 15 * 60 } });
  try {
    await host.load();
    host.activate('gene');
    if (options.developer !== false) host.setDeveloperMode(true);
    await run({ host, clock, fatigue });
  } finally {
    await host.flush().catch(() => {});
    assert.equal(path.dirname(directory), os.tmpdir());
    await rm(directory, { recursive: true, force: true });
  }
}

test('mood model: a forced attention skips boredom and the interval but keeps idle, the single cue, and the speech quota', () => {
  const p = card();
  let state = createMoodState(0, p);
  state = advanceMood(state, 10_000, { online: true }, p);
  assert.equal(getMoodSnapshot(state, 10_000, p).attentionCandidate, null, 'not bored: nothing would come on its own');
  assert.equal(applyMoodEvent(state, { type: 'attention', id: 'plain', kind: 'motion' }, 10_000, p).cue, null);
  for (const kind of ['look', 'motion', 'speech'] as const) {
    const forced = applyMoodEvent(state, { type: 'attention', id: `force-${kind}`, kind, force: true }, 10_000, p);
    assert.equal(forced.cue?.kind, kind, kind);
  }
  const speech = applyMoodEvent(state, { type: 'attention', id: 'f1', kind: 'speech', force: true }, 10_000, p);
  assert.equal(speech.unansweredSpeech, 1); assert.equal(speech.speechTimes.length, 1, 'a forced line spends the quota like any other');
  // Quota: the default card allows one unanswered line.
  const later = advanceMood(speech, 20_000, { online: true }, p);
  assert.equal(applyMoodEvent(later, { type: 'attention', id: 'f2', kind: 'speech', force: true }, 20_000, p).cue?.kind, 'speech', 'I-039: no hard stop on unanswered lines any more (the hourly quota still holds)');
  const answered = applyMoodEvent(later, { type: 'chat', id: 'hi' }, 20_000, p);
  const again = applyMoodEvent(advanceMood(answered, 25_000, { online: true }, p), { type: 'attention', id: 'f3', kind: 'speech', force: true }, 25_000, p);
  assert.equal(again.cue?.kind, 'speech');
  const full = { ...advanceMood(again, 30_000, { online: true }, p), cue: null, unansweredSpeech: 0 };
  assert.equal(applyMoodEvent(full, { type: 'attention', id: 'f4', kind: 'speech', force: true }, 30_000, p).cue, null, 'two an hour');
  // Not while she is being touched, nor while a cue is showing.
  const touched = applyMoodEvent(state, { type: 'phase', id: 'rua', phase: 'rua' }, 10_000, p);
  assert.equal(applyMoodEvent(touched, { type: 'attention', id: 'f5', kind: 'motion', force: true }, 10_000, p).cue, null);
  const cued = applyMoodEvent(state, { type: 'attention', id: 'c', kind: 'look', force: true }, 10_000, p);
  assert.equal(applyMoodEvent(cued, { type: 'attention', id: 'd', kind: 'motion', force: true }, 10_000, p).cue?.id, 'c');
  // A forced attention is only a plain look/motion/speech.
  for (const bad of [{ type: 'food', id: 'x', force: true }, { type: 'attention', id: 'x', kind: 'speech', force: false },
    { type: 'attention', id: 'x', kind: 'speech', force: true, source: { kind: 'ambient', sessionId: 's', observationId: 's:1' } },
    { type: 'attention', id: 'x', kind: 'motion', force: true, claimed: { id: 'y', kind: 'motion', at: 0 } }])
    assert.throws(() => applyMoodEvent(state, bad as never, 10_000, p), /Invalid forced attention|Only/u);
});

test('MoodHost.forceAttention: developer mode only; raises the cue; spends the quota; respects expressions off', async () => {
  await withMood(async ({ host }) => {
    assert.equal(host.forceAttention('motion'), true);
    assert.equal(host.get().snapshot.cue?.kind, 'motion');
    assert.equal(host.forceAttention('speech'), false, 'a cue is already showing');
  });
  await withMood(async ({ host, clock }) => {
    assert.equal(host.forceAttention('speech'), true);
    clock.now += 10_000;
    assert.equal(host.forceAttention('speech'), true, 'I-039: an unanswered line no longer blocks a forced one');
    host.event({ type: 'chat', id: 'answer' });
    clock.now += 10_000;
    assert.equal(host.forceAttention('speech'), false, 'two forced lines spent the default hourly quota of 2');
  });
  await withMood(async ({ host }) => {
    assert.equal(host.forceAttention('motion'), false, 'not developer mode');
    assert.equal(host.get().snapshot.cue, null);
  }, { developer: false });
  await withMood(async ({ host }) => {
    host.setExpressions(false);
    assert.equal(host.forceAttention('motion'), false);
    assert.equal(host.forceAttention('bogus' as never), false);
  });
});

test('MoodHost.setTestMood: developer mode only; shows the label at once; holds a context label; ends on a real event; restores the baseline', async () => {
  await withMood(async ({ host }) => {
    assert.equal(host.setTestMood('happy'), null);
    assert.notEqual(host.get().snapshot.primary, 'happy');
  }, { developer: false });
  await withMood(async ({ host, clock }) => {
    for (const label of Object.keys(MOOD_LABELS) as MoodLabel[]) {
      assert.equal(host.setTestMood(label), label, label);
      assert.equal(host.get().snapshot.primary, label, `the view says ${label}`);
    }
    // Held: happy needs a context that the real model drops after 30 seconds.
    host.setTestMood('happy');
    clock.now += 2 * MINUTE;
    assert.equal(host.get().snapshot.primary, 'happy');
    // The channels decay on their own: ten minutes on it is over (and so is the hold).
    clock.now += 9 * MINUTE;
    assert.notEqual(host.get().snapshot.primary, 'happy');
    // A real event ends the hold at once (longing is the real one again: she was just talked to).
    host.setTestMood('sad');
    assert.equal(host.get().snapshot.primary, 'sad');
    host.event({ type: 'chat', id: 'real-chat' });
    assert.notEqual(host.get().snapshot.primary, 'sad');
    // Restore: the card's baseline.
    host.setTestMood('sad');
    assert.equal(host.setTestMood(null), 'calm');
    assert.deepEqual(host.get().snapshot.values, host.get().parameters.baseline);
    assert.equal(host.get().snapshot.longing, 0);
  });
});

test('MoodHost.setTestMood: the hold is never saved (a restart shows the real model), and a character switch drops it', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-test-command-'));
  const clock = { now: 5_000_000 };
  try {
    const host = new MoodHost(directory, () => {}, () => clock.now);
    await host.load(); host.activate('gene'); host.setDeveloperMode(true);
    host.setTestMood('sad');
    assert.equal(host.get().snapshot.primary, 'sad');
    await host.flush();
    host.activate('other');
    assert.notEqual(host.get().snapshot.primary, 'sad');
    host.activate('gene');
    assert.notEqual(host.get().snapshot.primary, 'sad', 'the hold went with the switch');
    const restored = new MoodHost(directory, () => {}, () => clock.now);
    await restored.load(); restored.activate('gene'); restored.setDeveloperMode(true);
    assert.notEqual(restored.get().snapshot.primary, 'sad', 'longing is the real one after a restart');
    await restored.flush();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('MoodHost.setTestFatigue: a temporary drowsy look in the view only; it expires, cancels, and leaves the sleep model alone', async () => {
  await withMood(async ({ host, fatigue }) => {
    assert.equal(host.get().fatigue?.phase, 'awake');
    const realF = host.get().fatigue!.F;
    assert.equal(host.setTestFatigue('drowsy'), true);
    const view = host.get().fatigue!;
    assert.equal(view.phase, 'drowsy'); assert.equal(view.F, FATIGUE_TEST_F.drowsy);
    assert.equal(view.sleeping, false);
    assert.equal(host.setTestFatigue('light-drowsy'), true);
    assert.equal(host.get().fatigue?.phase, 'light-drowsy');
    assert.equal(host.setTestFatigue(null), true);
    assert.equal(host.get().fatigue?.phase, 'awake'); assert.equal(host.get().fatigue?.F, realF, 'the sleep model never changed');
    host.setTestFatigue('drowsy');
    fatigue.mono += 14 * MINUTE;
    assert.equal(host.get().fatigue?.phase, 'drowsy');
    fatigue.mono += 2 * MINUTE;
    assert.equal(host.get().fatigue?.phase, 'awake', 'back by itself after 15 minutes');
    host.setTestFatigue('drowsy');
    host.setTestMood(null);
    assert.equal(host.get().fatigue?.phase, 'awake', '"恢复心情" cancels the look too');
  });
  await withMood(async ({ host }) => {
    assert.equal(host.setTestFatigue('drowsy'), false);
    assert.equal(host.get().fatigue?.phase, 'awake');
  }, { developer: false });
});

test('M1 under each mood (what the user will see): the dance tier her desire gives for every mood label on an average awake card', () => {
  const tier = (mood: string) => moodLabelDanceDesire({ playfulWeight: 1, cautiousWeight: 1, playfulIntensity: 50, mood, fatigue: { phase: 'awake', F: 0.25 }, activity: 'company',
    heardSeconds: 30, request: 0 }).tier;
  assert.deepEqual(Object.fromEntries((Object.keys(MOOD_LABELS) as MoodLabel[]).map(label => [label, tier(label)])), {
    calm: 'nod', close: 'nod', content: 'nod', happy: 'dance', excited: 'dance', concerned: 'none', disappointed: 'none', upset: 'none', longing: 'nod',
    sad: 'none', relieved: 'nod', 'tense-expectation': 'nod',
  });
  const drowsy = moodLabelDanceDesire({ playfulWeight: 1, cautiousWeight: 1, playfulIntensity: 50, mood: 'happy', fatigue: { phase: 'drowsy', F: FATIGUE_TEST_F.drowsy }, activity: 'company',
    heardSeconds: 30, request: 0 });
  assert.equal(drowsy.tier, 'none', 'happy but drowsy: she does not move');
});

test('CompanionService.herLifeStartNow: starts her state for the active character, refuses with automatic expressions paused or without a character', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-test-command-'));
  try {
    const service = new CompanionService(directory, () => {});
    assert.deepEqual(service.herLifeStartNow('daydream'), { ok: false, reason: 'no-character' });
    service.mood.activate('gene');
    assert.deepEqual(service.herLifeStartNow('daydream'), { ok: true, activity: 'daydream' });
    assert.equal(service.herLife.view('gene')!.activity, 'daydream');
    const picked = service.herLifeStartNow(null);
    assert.equal(picked.ok, true);
    assert.deepEqual(service.herLifeStartNow('thinking'), { ok: true, activity: 'thinking' });
    service.mood.setExpressions(false);
    assert.deepEqual(service.herLifeStartNow('humming'), { ok: false, reason: 'expressions-off' });
    assert.equal(service.herLife.view('gene')!.activity, 'thinking', 'nothing was started');
    await service.flush().catch(() => {});
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------------------------------------ L4 她也会需要你

test('HerNeedsHost.startNow: she has that need at once, it is not counted against the day, and it lives like a real one (soothed by pats, comforts her)', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-test-command-'));
  try {
    const service = new CompanionService(directory, () => {});
    service.mood.activate('gene');
    for (const id of ['lonely', 'dream', 'lowEnergy', 'chatty'] as const) {
      assert.equal(service.herNeeds.startNow('gene', id), true, id);
      const view = service.herNeeds.view('gene')!;
      assert.equal(view.id, id); assert.equal(view.mode, 'need'); assert.equal(view.usedToday, 0, 'no start was recorded: the day\'s limits are untouched');
    }
    service.herNeeds.startNow('gene', 'lonely');
    const before = service.mood.get().snapshot.values;
    const soothed = service.herNeeds.interact('gene', 'touch', 60_000);
    assert.equal(soothed, 'lonely', 'a long pat soothes it, like a real one');
    assert.equal(service.herNeeds.view('gene')!.mode, 'glow');
    assert.ok(service.mood.get().snapshot.values.O > before.O, 'and the comfort lifts her mood');
    assert.equal(service.herNeeds.startNow('../x', 'lonely'), false);
    assert.equal(service.herNeeds.startNow('gene', 'bogus' as never), false);
    service.mood.setExpressions(false);
    service.herLifeTick(true); // the one-second tick carries the switch to the needs host
    assert.equal(service.herNeeds.startNow('gene', 'dream'), false, 'with automatic expressions paused nothing shows, so nothing starts');
    await service.flush().catch(() => {});
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------------------------------------ L1 内心循环

function loopHarness() {
  const state = { now: 1_000_000 };
  const gate = new ProactiveSpeechGate(() => state.now); gate.setScope('scope');
  let decides = 0;
  const loop = new InnerLoop({
    gate, clock: () => state.now, enabled: () => true, canStart: () => true, current: () => true,
    scope: () => ({ characterId: 'gene', gateScope: 'scope' }), parameters: () => DEFAULT_MOOD_PARAMETERS,
    quiet: () => ({ asleep: false, drowsy: false, night: false, quiet: false }), prompt: () => 'prompt',
    decide: async () => { decides++; return { text: '{"action":"none"}' }; },
    realize: () => {}, releaseSpeech: () => {}, offer: () => {}, present: async () => true, presentationCurrent: () => true, archive: async () => {},
  } as InnerLoopDependencies);
  const cue = (id: string) => ({ id, kind: 'motion' as const, at: state.now, until: state.now + 3_000 });
  return { loop, state, cue, decides: () => decides, dispose: () => { loop.dispose(); gate.dispose(); } };
}

test('InnerLoop.resetPacing: a second motion opportunity soon after the first is held back, unless the pacing is reset (quotas and gates stay)', async () => {
  const h = loopHarness();
  assert.equal(h.loop.offerOpportunity(h.cue('m1')), true);
  await flush();
  h.state.now += 60_000;
  assert.equal(h.loop.offerOpportunity(h.cue('m2')), false, 'the model was asked a minute ago: motion is paced at twice the card\'s interval');
  h.loop.resetPacing();
  assert.equal(h.loop.offerOpportunity(h.cue('m3')), true);
  await flush();
  assert.equal(h.decides(), 2);
  h.dispose();
});

// ------------------------------------------------------------------------------------------------ M1 音频律动

test('MusicChoice.rejudgeNow: she judges again at the next frame and a change takes effect without the minimum stay; nothing without music', () => {
  const ctx = (mood: string): MusicChoiceContext => ({ playfulWeight: 1, cautiousWeight: 1, playfulIntensity: 50, mood, fatigue: { phase: 'awake', F: 0.25 }, activity: 'company',
    scope: 'gene|a', request: null, nowMs: 0, expressive: true });
  // I-016: what she hears is music (the stage gives the fast layer's verdict every frame).
  const run = (choice: MusicChoice, seconds: number, mood: string) => { for (let i = 0; i < seconds * 30; i++) { choice.noteMusic(true); choice.frame(1 / 30, ctx(mood)); } };
  // She dances (happy); her mood drops to calm, so the scheduled judgement lowers her to a nod; two seconds later it drops to sad.
  const make = () => {
    const choice = new MusicChoice(moodLabelDanceDesire, () => 0.5); choice.setHearing(true); run(choice, 12, 'happy');
    assert.equal(choice.tier, 'dance');
    for (let i = 0; i < 30 * 30 && choice.tier === 'dance'; i++) { choice.noteMusic(true); choice.frame(1 / 30, ctx('calm')); }
    assert.equal(choice.tier, 'nod');
    run(choice, 2, 'sad');
    return choice;
  };
  const control = make();
  assert.equal(control.tier, 'nod', 'without the test she keeps her last choice until the next judgement (15 s apart) and the minimum stay (8 s)');
  const asked = make();
  assert.equal(asked.rejudgeNow(), true);
  run(asked, 1 / 15, 'sad');
  assert.equal(asked.tier, 'none', 'judged at once and acted on at once, without the minimum stay');
  const quiet = new MusicChoice(moodLabelDanceDesire, () => 0.5);
  assert.equal(quiet.rejudgeNow(), false, 'no music: nothing to judge');
  const always = new MusicChoice(moodLabelDanceDesire, () => 0.5); always.setAlways(true); always.setHearing(true);
  assert.equal(always.rejudgeNow(), false, '"让她一直跟着跳" is the original: no judging');
});

// ------------------------------------------------------------------------------------------------ G1 猜拳

async function rpsHarness(over: { visible?: boolean } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rps-test-command-'));
  const store = new RpsStore({ file: () => path.join(dir, 'rps.json'), now: () => 1_000_000 }); await store.load();
  const views: unknown[] = [];
  const state = { visible: over.visible ?? true };
  let n = 0;
  const host = new RpsHost({ store,
    character: () => ({ id: 'gene', persona: '角色：基恩', parameters: DEFAULT_MOOD_PARAMETERS, snapshot: { primary: 'happy', values: { D: 70, O: 50, E: 55, N: 50, C: 40 } },
      fatigue: null, herLife: 'company' }), visible: () => state.visible, recording: () => false, localDate: () => '2026-11-03',
    publish: view => views.push(view), mood: () => {}, chatBusy: () => false, clock: () => 1_000_000, random: seeded(5), nonce: () => `n${++n}`, createId: () => `id${++n}` });
  return { host, store, views, state, close: async () => { host.dispose(); await store.flush(); await rm(dir, { recursive: true, force: true }); } };
}

test('RpsHost.testInvite / testStart: her invitation buttons without spending the day\'s invitations; a match right away; hidden or busy refuses', async () => {
  const h = await rpsHarness();
  const invitesBefore = JSON.stringify(h.store.invites());
  assert.equal(h.host.testInvite(), true);
  assert.equal((h.views.at(-1) as { phase: string }).phase, 'invite');
  assert.equal(JSON.stringify(h.store.invites()), invitesBefore, 'the invitation quota is untouched');
  assert.equal(h.host.testStart(), true);
  assert.equal(h.host.active, true);
  assert.equal(h.host.testInvite(), false, 'a match is on');
  assert.equal(h.host.testStart(), false, 'one match at a time');
  await h.close();
  const hidden = await rpsHarness({ visible: false });
  assert.equal(hidden.host.testInvite(), false);
  assert.equal(hidden.host.testStart(), false);
  await hidden.close();
});

// ------------------------------------------------------------------------------------------------ L3 日记

test('DiaryWriter.writeNow: needs the profile\'s own recording switch; writes only days still due; once at a time', async () => {
  const scope: UserProfileScope = { characterId: 'character-a', providerScope: 'provider-a' };
  const today = '2026-11-02', yesterday = recentDiaryDates(today, 3)[0], day2 = recentDiaryDates(today, 3)[1];
  const at = (day: string, hour: number) => localDayRange(day).start + hour * 60 * MINUTE;
  const clock = { now: at(today, 9) };
  type Ticket = NonNullable<ReturnType<DiaryProfiles['diaryTicket']>>;
  const ticket = { scopeId: userProfileScopeId(scope), scopeEpoch: 1, enableEpoch: 1 } as Ticket;
  const state = { ticket: ticket as Ticket | null, due: [yesterday] as string[], model: 'sonnet' as string | null };
  const saved: string[] = [], calls: string[] = [];
  let release: () => void = () => {};
  const profiles: DiaryProfiles = {
    diaryTicket: () => state.ticket, diaryTicketValid: () => state.ticket !== null,
    diaryDue: (_ticket, dates) => dates.filter(date => state.due.includes(date)),
    noteDiaryAttempt: async () => true,
    saveDiary: async (_ticket, date) => { saved.push(date); state.due = state.due.filter(item => item !== date); return true; },
    recentDiaryPoints: () => '',
  };
  const writer = new DiaryWriter({ profiles, scope: () => scope,
    messages: (_scope, start) => [{ role: 'user', content: '今天开会了', createdAt: start + 3_600_000 }, { role: 'assistant', content: '辛苦啦', createdAt: start + 3_660_000 }],
    character: () => ({ persona: '角色名称：小测', language: '' }), model: () => state.model,
    generate: async request => { calls.push(request.model); await new Promise<void>(resolve => { release = resolve; }); return '{"entry":"今天陪你开会，我很开心。"}'; },
    written: () => {}, now: () => clock.now, retryDelayMs: 60_000 });
  state.ticket = null;
  assert.equal(writer.writeNow(), 'recording-off', 'recording is the diary\'s consent; this does not bypass it');
  assert.deepEqual(calls, []);
  state.ticket = ticket;
  state.model = null;
  assert.equal(writer.writeNow(), 'unavailable', 'chat is not Claude');
  state.model = 'sonnet';
  state.due = [];
  assert.equal(writer.writeNow(), 'nothing-due');
  state.due = [yesterday];
  assert.equal(writer.writeNow(), 'started');
  await flush();
  assert.deepEqual(calls, ['sonnet']);
  assert.equal(writer.writeNow(), 'busy');
  release();
  await new Promise<void>(resolve => { const check = () => writer.busy ? setTimeout(check, 2) : resolve(); check(); });
  assert.deepEqual(saved, [yesterday]);
  // The normal once-a-day pass has run today; writeNow still runs another when something is due.
  state.due = [day2];
  assert.equal(writer.writeNow(), 'started');
  await flush(); release();
  await new Promise<void>(resolve => { const check = () => writer.busy ? setTimeout(check, 2) : resolve(); check(); });
  assert.deepEqual(saved, [yesterday, day2]);
  assert.equal(localDateKey(clock.now), today);
  writer.dispose();
  assert.equal(writer.writeNow(), 'unavailable');
});
