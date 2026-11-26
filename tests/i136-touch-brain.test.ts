/**
 * I-136 (Unbound v1 step 2): the brain side of touches. Her face and reaction picked locally from her hormones, mood values and
 * character; a small, decaying nudge to her mood; whether she speaks decided locally (no switch), capped in the companion and uncapped in
 * Unbound; merged touches; and what Claude is told (the part, what she showed). Record: docs/claude/2026-11-15-unbound-v1-step2-touch.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MoodHost } from '../electron/mood/mood';
import { FixedBoredomTiming } from '../shared/behaviors/boredom-timing/fake';
import { FixedTouchFeedEffect } from '../shared/behaviors/touch-feed-effect/fake';
import { FixedBlush } from '../shared/behaviors/blush/fake';
import { applyMoodEvent, createMoodState, DEFAULT_MOOD_PARAMETERS, type MoodCue, type MoodValues } from '../shared/foundation/mood';
import type { MoodView } from '../shared/mood/mood-runtime';
import { deriveDispositions, type Dispositions } from '../shared/behaviors/reactions/dispositions';
import { hormoneTerm, scoreReactions } from '../shared/behaviors/reactions/choose';
import { REACTION_EVENTS, BODY_EVENT_IDS, WORD_EVENT_IDS } from '../shared/behaviors/reactions/events';
import { REACTION_TABLE } from '../shared/behaviors/reactions/knobs';
import type { ReactionNow } from '../shared/behaviors/reactions/interface';
import { pickTouchFace } from '../shared/behaviors/touch-response/face';
import { pinchFacePick, readTouchFace } from '../shared/behaviors/touch-response/view';
import { TouchMerger } from '../shared/behaviors/touch-response/merge';
import { decideTouchSpeech, touchSpeechChance } from '../shared/behaviors/touch-response/speak';
import { touchLift } from '../shared/behaviors/touch-response/mood';
import { REACTION_SHOWN_WORDS, touchWords } from '../shared/behaviors/touch-response/words';
import { TOUCH_FACES, TOUCH_RESPONSE_KNOBS } from '../shared/behaviors/touch-response/knobs';
import type { TouchSpeechInput } from '../shared/behaviors/touch-response/interface';
import { TouchBrain, type TouchMoodPort } from '../electron/mood/touch/brain';
import { reportTouch, setTouchSink } from '../electron/mood/touch/sink';
import { contactWords } from '../shared/mood/her-state';
import { perceptionTurnLine } from '../shared/brain/perception-rule';
import { buildInnerLoopPrompt, INNER_LOOP_TOUCH_RULE } from '../shared/initiative/inner-loop';
import { OpeningHost, type OpeningLoop } from '../electron/brain/opening-host';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { ENGLISH_JOURNAL_UI_COPY as JOURNAL_EN } from '../shared/foundation/ui-copy.journal.en';

const BASE: MoodValues = { D: 50, O: 50, E: 50, N: 50, C: 50 };
const CALM: Dispositions = deriveDispositions(null);
const fixed = (r = 0.5) => () => r;

function now(over: Partial<ReactionNow> = {}): ReactionNow {
  return { characterId: 'gene', dispositions: CALM, mood: 'calm', sleepy: false, at: 1_000_000, recent: [], values: { ...BASE }, baseline: { ...BASE },
    evidence: 1, boredom: 0, longing: 0, A: 0.5, ...over };
}

// ---------------------------------------------------------------- the face (local, no Claude)

test('the face: same mood numbers and fixed randomness give the same face; different hormones give different faces', () => {
  const a = pickTouchFace('pinch', now(), { random: fixed() }), b = pickTouchFace('pinch', now(), { random: fixed() });
  assert.equal(a.face, b.face);
  assert.deepEqual(a.scores, b.scores);
  assert.equal(a.face, 'smile', 'at her baseline a pinch gets a small smile');
  // Close and pleased (O, E, D above her baseline): a squinting smile. Tense (C, N up, E down): a wince. The label stays "calm" in all three,
  // so the difference comes from the numbers themselves, not the label.
  const warm = pickTouchFace('pinch', now({ values: { D: 70, O: 75, E: 70, N: 50, C: 40 } }), { random: fixed() });
  const tense = pickTouchFace('pinch', now({ values: { D: 45, O: 45, E: 35, N: 75, C: 80 } }), { random: fixed() });
  assert.equal(warm.face, 'beam');
  assert.equal(tense.face, 'wince');
  // Read against the card's baseline: the same raw numbers on a card whose baseline is already high are "at baseline".
  const highCard = pickTouchFace('pinch', now({ values: { D: 70, O: 75, E: 70, N: 50, C: 40 }, baseline: { D: 70, O: 75, E: 70, N: 50, C: 40 } }), { random: fixed() });
  assert.equal(highCard.face, 'smile');
});

test('the face: character, the part, sleepiness, recent repeats and a little randomness all count', () => {
  const lively = { ...CALM, lively: 90, restrained: 20 }, reserved = { ...CALM, shy: 85, restrained: 80 };
  const mild = { D: 58, O: 60, E: 58, N: 50, C: 48 };
  assert.equal(pickTouchFace('click', now({ values: mild, dispositions: lively }), { random: fixed() }).face, 'beam');
  assert.equal(pickTouchFace('click', now({ values: mild, dispositions: reserved }), { random: fixed() }).face, 'smile');
  // A click on the body startles more than one on the head.
  assert.equal(pickTouchFace('click', now({ part: 'torso' }), { random: fixed() }).face, 'blank');
  assert.notEqual(pickTouchFace('click', now({ part: 'head' }), { random: fixed() }).face, 'blank');
  // Sleepy with high sleep pressure: a sleepy squint.
  assert.equal(pickTouchFace('click', now({ sleepy: true, A: 0.9 }), { random: fixed() }).face, 'drowsy');
  // The face she just showed is a little less likely again; randomness can tip a close call.
  const again = pickTouchFace('pinch', now({ recent: [{ id: 'smile', at: 1_000_000 - 1_000 }] }), { random: fixed() });
  assert.notEqual(again.face, 'smile');
  const faces = new Set([0, 0.25, 0.5, 0.75, 1].map(r => pickTouchFace('click', now(), { random: fixed(r) }).face));
  assert.ok(faces.size >= 1);
});

test('I-037 scoring: the body path reads the mood numbers and the part; the word path (no numbers) scores exactly as before', () => {
  const close = { D: 50, O: 75, E: 55, N: 50, C: 45 };
  const blushAt = (over: Partial<ReactionNow>) => scoreReactions('pinch', now(over), { random: fixed() }).candidates.find(c => c.id === 'blush')?.score ?? -1;
  assert.ok(blushAt({ values: close }) > blushAt({}), 'closeness above her baseline makes a blush likelier');
  assert.ok(hormoneTerm(REACTION_TABLE.blush, now({ values: close })) > 0);
  // The word path gives no numbers: the hormone, part and strength terms are all zero, so its scores are the old formula's.
  const words = scoreReactions('praise', { characterId: 'gene', dispositions: CALM, mood: 'calm', sleepy: false, at: 0, recent: [] }, { random: fixed() });
  for (const c of words.candidates) assert.equal(c.parts.hormones ?? 0, 0);
  const row = REACTION_TABLE.blush;
  assert.equal(words.candidates.find(c => c.id === 'blush')!.score, row.events.praise);
  // Click on the face: pout and blush gain; on the torso they lose.
  const face = scoreReactions('click', now({ part: 'face' }), { random: fixed() }), torso = scoreReactions('click', now({ part: 'torso' }), { random: fixed() });
  const score = (s: typeof face, id: string) => s.candidates.find(c => c.id === id)?.score ?? -Infinity;
  assert.ok(score(face, 'pout') > score(torso, 'pout'));
  assert.ok(score(face, 'blush') > score(torso, 'blush'));
  // The registry: click and pull are body events with English journal words; haiku never judges them.
  assert.ok(BODY_EVENT_IDS.includes('click') && BODY_EVENT_IDS.includes('pull'));
  assert.ok(!WORD_EVENT_IDS.includes('click' as never));
  for (const id of ['click', 'pull'] as const) assert.ok(REACTION_EVENTS[id].label in JOURNAL_EN, id);
  for (const row of Object.values(TOUCH_FACES)) assert.ok(row.label in JOURNAL_EN, row.label);
});

// ---------------------------------------------------------------- whether she speaks (local, no switch)

function speech(over: Partial<TouchSpeechInput> = {}): TouchSpeechInput {
  return { kind: 'click', part: 'shoulder', count: 1, strength: 0, heldMs: 0, values: { ...BASE }, baseline: { ...BASE }, evidence: 1, boredom: 0, longing: 0,
    dispositions: CALM, sleepy: false, asleep: false, sinceSpokeMs: null, ...over };
}

test('speak: decided from her mood values and character, never a switch; asleep never; repeats raise it; just spoke lowers it', () => {
  const plain = touchSpeechChance(speech());
  assert.equal(plain.chance, TOUCH_RESPONSE_KNOBS.speak.base.click);
  assert.ok(touchSpeechChance(speech({ values: { D: 65, O: 75, E: 55, N: 55, C: 50 } })).chance > plain.chance, 'closeness and excitement raise it');
  assert.ok(touchSpeechChance(speech({ boredom: 60 })).chance > plain.chance, 'B: bored, she welcomes it');
  assert.ok(touchSpeechChance(speech({ longing: 50 })).chance > plain.chance, 'M: she missed you');
  assert.ok(touchSpeechChance(speech({ dispositions: { ...CALM, lively: 90 } })).chance > plain.chance, 'a lively character talks more');
  assert.ok(touchSpeechChance(speech({ dispositions: { ...CALM, restrained: 90 } })).chance < plain.chance, 'a restrained one less');
  assert.ok(touchSpeechChance(speech({ count: 4 })).chance > plain.chance, 'poked again and again');
  assert.ok(touchSpeechChance(speech({ sinceSpokeMs: 5_000 })).chance < plain.chance, 'she just spoke about a touch');
  assert.ok(touchSpeechChance(speech({ sleepy: true })).chance < plain.chance);
  assert.equal(touchSpeechChance(speech({ asleep: true, boredom: 100 })).chance, 0);
  assert.equal(touchSpeechChance(speech({ kind: 'pat', boredom: 100 })).chance, 0, 'a pat keeps its own ways (no line)');
  assert.ok(touchSpeechChance(speech({ count: 9, boredom: 100, longing: 100, values: { D: 100, O: 100, E: 100, N: 100, C: 100 } })).chance <= TOUCH_RESPONSE_KNOBS.speak.max);
  // The roll: same input, same random → same answer; the same random says yes for a warm, bored mood and no for a plain one.
  assert.equal(decideTouchSpeech(speech(), fixed(0.3)).speak, false);
  assert.equal(decideTouchSpeech(speech({ boredom: 60, values: { D: 60, O: 70, E: 55, N: 50, C: 50 } }), fixed(0.3)).speak, true);
  assert.equal(decideTouchSpeech(speech(), fixed(0.1)).speak, decideTouchSpeech(speech(), fixed(0.1)).speak);
});

// ---------------------------------------------------------------- merging

test('merge: the same kind and part within 10 s is one thing with a count; another part or a pause starts a new one; a pull is one pull', () => {
  const merger = new TouchMerger();
  const click = (at: number, part: 'shoulder' | 'head' = 'shoulder') => merger.note('gene', { kind: 'click', part, side: null, where: 'unbound', at });
  const first = click(0);
  assert.equal(first.fresh, true);
  assert.equal(click(3_000).episode.id, first.episode.id);
  assert.equal(click(12_000).episode.count, 3, 'each within 10 s of the previous one');
  assert.equal(click(13_000, 'head').fresh, true, 'another part');
  assert.equal(click(30_000).fresh, true, 'a pause');
  const pull = merger.note('gene', { kind: 'pull', part: 'hand', side: 'left', where: 'unbound', at: 40_000, strength: 0.3, ended: 'holding' });
  const end = merger.note('gene', { kind: 'pull', part: 'hand', side: 'left', where: 'unbound', at: 41_000, strength: 0.5, ended: 'released' });
  assert.equal(end.episode.id, pull.episode.id);
  assert.equal(end.episode.count, 1, 'its "still holding" report and its end are one pull');
  assert.equal(end.episode.strength, 0.5);
});

// ---------------------------------------------------------------- write back

test('write back: a gentle click raises closeness; poking and hard pulls raise tension; small and inside the lift bounds', () => {
  const ep = (over: object) => ({ kind: 'click' as const, part: 'head' as const, count: 1, strength: 0, heldMs: 0, ended: null, ...over });
  assert.deepEqual(touchLift(ep({}), { fresh: true, counted: true })!.delta, { O: 1 });
  assert.deepEqual(touchLift(ep({ part: 'torso' }), { fresh: true, counted: true })!.delta, { O: 0.5, N: 0.5 });
  assert.equal(touchLift(ep({ count: 2 }), { fresh: false, counted: true }), null, 'the second click of the same thing adds nothing');
  assert.deepEqual(touchLift(ep({ count: 3 }), { fresh: false, counted: true })!.delta, { N: 1, C: 0.5 });
  const pull = (over: object) => ({ kind: 'pull' as const, part: 'hand' as const, count: 1, strength: 0.2, heldMs: 800, ended: 'released' as const, ...over });
  assert.deepEqual(touchLift(pull({}), { fresh: true, counted: true })!.delta, { O: 1 });
  assert.equal(touchLift(pull({ ended: 'holding' }), { fresh: true, counted: true }), null, 'weighed when it ends');
  const hard = touchLift(pull({ strength: 0.9 }), { fresh: true, counted: true })!.delta;
  assert.ok((hard.N ?? 0) > 2 && (hard.C ?? 0) > 1 && hard.O === undefined);
  const free = touchLift(pull({ strength: 0.9, ended: 'broke-free' }), { fresh: true, counted: true })!.delta;
  assert.ok((free.C ?? 0) > (hard.C ?? 0));
  for (const delta of [hard, free]) for (const n of Object.values(delta)) assert.ok(Math.abs(n!) <= 5);
  assert.equal(touchLift({ ...ep({}), kind: 'pinch' }, { fresh: true, counted: true }), null, 'a pinch has its own mood event');
});

// ---------------------------------------------------------------- the brain host

function view(over: { values?: MoodValues; boredom?: number; expressions?: boolean; phase?: string; characterId?: string } = {}): MoodView {
  return { characterId: over.characterId ?? 'gene', expressions: over.expressions ?? true, revision: 1, token: 't', developerMode: false,
    parameters: { ...DEFAULT_MOOD_PARAMETERS }, gesture: null,
    snapshot: { values: over.values ?? { ...BASE }, primary: 'calm', boredom: over.boredom ?? 0, longing: 0 },
    fatigue: { phase: over.phase ?? 'awake', A: 0.4 } } as unknown as MoodView;
}

function brain(options: { view?: () => MoodView; random?: number; attention?: boolean } = {}) {
  let clock = 1_000_000;
  const timers: { at: number; run: () => void; id: number }[] = [];
  let serial = 0;
  const calls = { lifts: [] as { id: string; delta: Partial<MoodValues>; reason: string }[], attention: [] as string[], faces: 0, touched: [] as string[], journal: [] as any[] };
  let brainRef: TouchBrain;
  const mood: TouchMoodPort = {
    get: () => (options.view ?? (() => view()))(),
    lift: lift => { calls.lifts.push(lift); return true; },
    touchAttention: mode => {
      calls.attention.push(mode);
      if (options.attention === false) return false;
      // The real path: the mood clock publishes the cue, the opening choice asks the claimants (here: the brain) at once.
      const cue = { id: `cue-${calls.attention.length}`, kind: 'speech', at: clock, until: clock + 3_000 } as MoodCue;
      return brainRef.claims(cue);
    },
    touchFaceChanged: () => { calls.faces++; },
  };
  const b = new TouchBrain({ mood: () => mood, dispositions: () => CALM, clock: () => clock, random: fixed(options.random ?? 0.5),
    reactions: () => ({ touched: (event, _c, key) => { calls.touched.push(`${event}:${key}`); return { id: 'blush', level: 'light' }; } }),
    journal: row => { calls.journal.push(row); },
    timers: { set: (run, ms) => { const id = ++serial; timers.push({ at: clock + ms, run, id }); return id; }, clear: id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); } } });
  brainRef = b;
  const advance = (ms: number) => {
    clock += ms;
    for (;;) {
      timers.sort((x, y) => x.at - y.at);
      const due = timers[0];
      if (!due || due.at > clock) break;
      timers.shift();
      due.run();
    }
  };
  return { b, calls, advance, at: () => clock };
}

const click = (at: number, part: 'shoulder' | 'head' | 'torso' = 'shoulder', where: 'pet' | 'unbound' = 'unbound') => ({ kind: 'click' as const, part, side: null, where, at });

test('brain: a click picks her face (published), asks for one reaction per merged touch, nudges her mood, and decides once', () => {
  const { b, calls, advance, at } = brain({ random: 0.99 });
  b.touch(click(at()));
  assert.equal(calls.faces, 1);
  const face = b.moodPort.face!('gene', at(), null)!;
  assert.equal(face.kind, 'click');
  assert.ok(face.face in TOUCH_FACES);
  assert.deepEqual(calls.lifts.map(l => l.delta), [{ O: 1 }]);
  advance(500); b.touch(click(at()));
  advance(500); b.touch(click(at()));
  assert.equal(calls.touched.length, 1, 'merged clicks ask for one reaction');
  assert.deepEqual(calls.lifts.at(-1)!.delta, { N: 1, C: 0.5 }, 'the third poke');
  advance(TOUCH_RESPONSE_KNOBS.decideAfterMs + 10);
  assert.equal(calls.journal.length, 1);
  const row = calls.journal[0];
  assert.deepEqual({ kind: row.kind, part: row.part, where: row.where, count: row.count, speak: row.speak }, { kind: 'click', part: 'shoulder', where: 'unbound', count: 3, speak: 'quiet' });
  assert.equal(row.face, face.face);
  assert.ok(Number.isInteger(row.chance) && row.chance >= 0 && row.chance <= 9);
  // The face holds for a moment, then is gone from the view.
  advance(TOUCH_RESPONSE_KNOBS.faceHoldMs);
  assert.equal(b.moodPort.face!('gene', at(), null), null);
});

test('brain: deciding to speak asks for one speech cue: uncapped in Unbound, capped in the pet; the inner loop line says what happened', () => {
  const unbound = brain({ random: 0 });
  unbound.b.touch(click(unbound.at(), 'head', 'unbound'));
  unbound.advance(TOUCH_RESPONSE_KNOBS.decideAfterMs + 10);
  assert.deepEqual(unbound.calls.attention, ['free']);
  assert.equal(unbound.calls.journal[0].speak, 'asked');
  const line = unbound.b.promptLine('gene');
  assert.match(line, /^用户刚才点了你一下（头），你.+。$/u);
  const pet = brain({ random: 0 });
  pet.b.touch(click(pet.at(), 'head', 'pet'));
  pet.advance(TOUCH_RESPONSE_KNOBS.decideAfterMs + 10);
  assert.deepEqual(pet.calls.attention, ['capped']);
  // Refused by the companion's caps: held, nothing claimed afterwards.
  const capped = brain({ random: 0, attention: false });
  capped.b.touch(click(capped.at(), 'head', 'pet'));
  capped.advance(TOUCH_RESPONSE_KNOBS.decideAfterMs + 10);
  assert.equal(capped.calls.journal[0].speak, 'held');
  assert.equal(capped.b.claims({ id: 'x', kind: 'speech', at: 0 }), false, 'only the cue asked for during the ask is claimed');
  // She just spoke: the next touch soon after is far less likely to make her speak again (same random).
  unbound.advance(20_000);
  unbound.b.touch(click(unbound.at(), 'torso', 'unbound'));
  unbound.advance(TOUCH_RESPONSE_KNOBS.decideAfterMs + 10);
  const second = unbound.calls.journal[1];
  assert.ok(second.chance < unbound.calls.journal[0].chance);
});

test('brain: asleep or 自动表现 off: no face, no nudge, no line; the row says why', () => {
  const asleep = brain({ view: () => view({ phase: 'asleep' }), random: 0 });
  asleep.b.touch(click(asleep.at()));
  asleep.advance(TOUCH_RESPONSE_KNOBS.decideAfterMs + 10);
  assert.equal(asleep.calls.faces, 0); assert.equal(asleep.calls.lifts.length, 0); assert.deepEqual(asleep.calls.attention, []);
  assert.equal(asleep.calls.journal[0].speak, 'asleep');
  const off = brain({ view: () => view({ expressions: false }), random: 0 });
  off.b.touch(click(off.at()));
  off.advance(TOUCH_RESPONSE_KNOBS.decideAfterMs + 10);
  assert.equal(off.calls.faces, 0); assert.equal(off.calls.journal[0].speak, 'off');
});

test('brain: the chat turn is told the part and what she showed (once); a pinch tells her face; nothing new keeps the old words', () => {
  const { b, advance, at } = brain({ random: 0.99 });
  assert.equal(b.chatWords(['pat']), '', 'a pat with nothing she showed: the old words stay');
  b.touch(click(at(), 'shoulder'));
  b.reactionPlayed({ type: 'reaction', characterId: 'gene', event: 'click', decider: 'top', haiku: null, candidates: [], picks: [{ id: 'blush', level: 'light', done: true }] });
  const face = b.moodPort.face!('gene', at(), null)!.face;
  const line = b.chatWords([]);
  assert.equal(line, `用户刚才点了你一下（肩膀），你${TOUCH_FACES[face].words}、脸红了一下。`);
  assert.equal(b.chatWords([]), '', 'told once');
  // A pinch: its face is picked when it begins and is the one the view and the words use.
  b.moodPort.started!('pinch', 'pinch-1', 'gene');
  const pinchFace = b.moodPort.face!('gene', at(), 'pinch-1')!;
  assert.equal(pinchFace.kind, 'pinch');
  assert.deepEqual(pinchFacePick(pinchFace), { smile: TOUCH_FACES[pinchFace.face].smile, eyelids: TOUCH_FACES[pinchFace.face].eyelids });
  advance(400);
  b.moodPort.contacted!('pinch', at(), 'gene', 'pinch-1');
  assert.equal(b.chatWords(['pinch']), `用户刚才捏了捏你的脸，你${TOUCH_FACES[pinchFace.face].words}。`);
  // Into the turn's line (and without the brain's words, exactly as before).
  const turn = { screenSharing: false, cameraFrames: false, attached: [] } as never;
  const body = '用户刚才点了你一下（肩膀），你愣了一下。';
  assert.ok(perceptionTurnLine(turn, { hearing: { source: null, stage: null, transcript: false }, contacts: [], say: 'none', body }).endsWith(body));
  assert.ok(perceptionTurnLine(turn, { hearing: { source: null, stage: null, transcript: false }, contacts: ['pat'], say: 'none' }).endsWith(contactWords(['pat'])));
});

test('words: the part, what she showed, never an instruction, within the cap for every combination', () => {
  assert.equal(touchWords([{ kind: 'click', part: 'shoulder', count: 2, face: 'smile' }]), '用户刚才点了你两下（肩膀），你抿嘴笑了一下。');
  assert.equal(touchWords([{ kind: 'pull', part: 'hand', strength: 0.9, ended: 'broke-free', face: 'wince' }]), '用户刚才用力拉了拉你的手，你皱着眼躲了一下、挣开了。');
  assert.equal(touchWords([{ kind: 'pull', part: 'hand', ended: 'holding' }]), '用户刚才拉着你的手不放。');
  let longest = '';
  for (const face of Object.keys(TOUCH_FACES) as (keyof typeof TOUCH_FACES)[]) {
    const all = [{ kind: 'click' as const, part: 'shoulder' as const, count: 3, face, reactions: ['blush', 'shy', 'pout'] },
      { kind: 'pull' as const, part: 'shoulder' as const, ended: 'broke-free' as const, strength: 1, face, reactions: ['shy'] },
      { kind: 'pinch' as const, face, reactions: ['blush'] }, { kind: 'food' as const, reactions: ['happy'] }];
    const line = touchWords(all, '草莓蛋糕');
    if (line.length > longest.length) longest = line;
    assert.ok(line.length <= TOUCH_RESPONSE_KNOBS.wordsMax, line);
    assert.doesNotMatch(line, /请|要|应该|不要|别/u);
  }
  assert.ok(longest.startsWith('用户刚才连着点了你好几下（肩膀）'));
  for (const id of Object.keys(REACTION_TABLE)) assert.ok(REACTION_SHOWN_WORDS[id], `${id} has its "你当时……" words`);
});

// ---------------------------------------------------------------- caps: companion capped, Unbound uncapped

test('the speech cue for a touch: in the pet the interval and hourly cap hold; in Unbound they do not (the hard state still does)', () => {
  const p = DEFAULT_MOOD_PARAMETERS;
  let state = createMoodState(0, p);
  // She spoke a minute ago (well inside the 30-minute interval).
  state = applyMoodEvent(state, { type: 'attention', id: 'first', kind: 'speech', welcome: true }, 60_000, p);
  state = { ...state, cue: null };
  const capped = applyMoodEvent(state, { type: 'attention', id: 'pet', kind: 'speech', touch: 'capped' }, 120_000, p);
  assert.equal(capped.cue, null, 'the pet keeps its caps');
  const free = applyMoodEvent(state, { type: 'attention', id: 'unbound', kind: 'speech', touch: 'free' }, 120_000, p);
  assert.equal(free.cue?.id, 'unbound', 'Unbound sets no request cap');
  // The hourly cap too.
  const full = { ...state, speechTimes: Array.from({ length: p.frequency.speechPerHour }, (_, i) => 100_000 + i), lastSpeechAt: null };
  assert.equal(applyMoodEvent(full, { type: 'attention', id: 'pet2', kind: 'speech', touch: 'capped' }, 120_000, p).cue, null);
  assert.equal(applyMoodEvent(full, { type: 'attention', id: 'free2', kind: 'speech', touch: 'free' }, 120_000, p).cue?.id, 'free2');
  // The hard state holds even in Unbound: not during a pinch, not while a cue shows.
  assert.equal(applyMoodEvent({ ...state, phase: 'cheek' }, { type: 'attention', id: 'free3', kind: 'speech', touch: 'free' }, 120_000, p).cue, null);
  assert.throws(() => applyMoodEvent(state, { type: 'attention', id: 'bad', kind: 'look', touch: 'free' } as never, 120_000, p));
});

// ---------------------------------------------------------------- the proactive path

test('the opening choice gives the touch cue to the inner loop with focus "touch" (no budget roll); refused → quiet with the quota back', () => {
  const calls: string[] = [], refunds: string[] = [];
  let take = true;
  const loop: OpeningLoop = { offerOpportunity: (cue, focus) => { calls.push(`${(cue as MoodCue).id}:${focus ?? '-'}`); return take; }, canTake: () => true, claims: () => false,
    asleep: () => false, silence: () => true, restReminderDue: () => false, quietNow: () => ({ asleep: false, drowsy: false, night: false, quiet: false }) };
  const opening = new OpeningHost({ loop, innerOn: () => true, developerMode: () => false, clock: () => 10_500, releaseSpeech: cue => { refunds.push(cue.id); },
    budget: { room: () => ({ factor: 0, words: 'none' }), spend: () => { throw new Error('a touch answer spends nothing'); }, refund: () => {} } as never });
  const v = { characterId: 'gene', snapshot: { primary: 'calm' }, parameters: DEFAULT_MOOD_PARAMETERS } as never;
  const cue = (id: string) => ({ id, kind: 'speech', at: 10_000, until: 13_000 } as MoodCue);
  assert.equal(opening.claim(cue('t1'), { touch: () => true }, v), 'inner');
  assert.deepEqual(calls, ['t1:touch']);
  take = false;
  assert.equal(opening.claim(cue('t2'), { touch: () => true }, v), 'quiet');
  assert.deepEqual(refunds, ['t2']);
});

test('the inner loop prompt for a touch: what happened, the rule, no topic of her own; without it the prompt is unchanged', () => {
  const input = { persona: '她', mood: '心情', weights: DEFAULT_MOOD_PARAMETERS.weights, intensity: DEFAULT_MOOD_PARAMETERS.intensity, localMinute: 600,
    minutesSinceInteraction: 1, cue: 'speech' as const, allowSpeech: true, quiet: { asleep: false, drowsy: false, night: false, quiet: false }, topic: '话头：今天的天气。' };
  const plain = buildInnerLoopPrompt(input);
  const touched = buildInnerLoopPrompt({ ...input, touch: '用户刚才点了你一下（肩膀），你抿嘴笑了一下。' });
  assert.ok(touched.includes('用户刚才点了你一下（肩膀），你抿嘴笑了一下。'));
  assert.ok(touched.includes(INNER_LOOP_TOUCH_RULE));
  assert.ok(!touched.includes('话头：今天的天气。'), 'no topic of her own');
  assert.equal(buildInnerLoopPrompt({ ...input, touch: '' }), plain);
  assert.ok(!plain.includes(INNER_LOOP_TOUCH_RULE));
});

// ---------------------------------------------------------------- the sink and the journal

test('the sink hands a validated touch to the brain; the journal row keeps closed values only', () => {
  const seen: string[] = [];
  setTouchSink(event => { seen.push(`${event.kind}:${event.part}`); });
  try {
    assert.equal(reportTouch({ kind: 'click', part: 'arm', side: 'left', where: 'unbound', at: 1 }), true);
    assert.equal(reportTouch({ kind: 'click', part: 'chest', side: null, where: 'unbound', at: 1 }), false);
  } finally { setTouchSink(null); }
  assert.deepEqual(seen, ['click:arm']);
  const good = { type: 'touch', characterId: 'gene', kind: 'click', part: 'shoulder', where: 'unbound', count: 3, face: 'smile', reaction: 'blush', speak: 'asked', chance: 4 };
  const row = buildJournalEntry(good, 1);
  assert.ok(row);
  assert.equal(buildJournalEntry({ ...good, text: '你好' }, 1) === null || !JSON.stringify(buildJournalEntry({ ...good, text: '你好' }, 1)).includes('你好'), true, 'no text ever');
  for (const bad of [{ face: 'grin' }, { reaction: 'kiss' }, { part: 'chest' }, { chance: 10 }, { count: 0 }, { speak: 'said hi' }])
    assert.equal(buildJournalEntry({ ...good, ...bad }, 1), null, JSON.stringify(bad));
  const tr = (s: string) => { if (!(s in JOURNAL_EN) && /[一-鿿]/u.test(s)) throw new Error(`no English for ${s}`); return s; };
  const t = (s: string, ...v: readonly unknown[]) => tr(s).replace(/\{(\d)\}/gu, (_m, i) => String(v[Number(i)]));
  for (const kind of ['click', 'pull', 'pinch', 'pat', 'food']) for (const speak of ['quiet', 'asked', 'held', 'asleep', 'off']) for (const face of ['none', ...Object.keys(TOUCH_FACES)])
    for (const part of [null, 'head', 'hair', 'face', 'shoulder', 'arm', 'hand', 'torso', 'leg', 'foot', 'other'])
      assert.ok(describeJournalEntry(buildJournalEntry({ ...good, kind, speak, face, part, where: 'pet' }, 1)!, t).length > 0);
});

test('with the real mood host: a pinch publishes its picked face; a click nudges O up and it falls back; Unbound uncapped, pet capped', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-touch-brain-'));
  const clock = { now: 1_000_000 };
  const host = new MoodHost(directory, () => {}, () => clock.now, { boredomTiming: new FixedBoredomTiming(), touchFeedEffect: new FixedTouchFeedEffect(), blush: new FixedBlush() });
  try {
    await host.load();
    host.activate('gene');
    const b = new TouchBrain({ mood: () => host, dispositions: () => CALM, clock: () => clock.now, random: fixed(), timers: { set: () => 0, clear: () => {} } });
    host.setTouchPort(b.moodPort);
    // A pinch begins: the view carries the face picked for it (the stage's pinch layer reads it).
    const view = host.interaction({ token: host.get().token, sessionId: 'pinch1', type: 'phase', phase: 'cheek' });
    assert.equal(view.touchFace?.kind, 'pinch');
    assert.ok(pinchFacePick(view.touchFace), 'the pinch layer gets its smile and squint from the pick');
    host.interaction({ token: host.get().token, sessionId: 'pinch1', type: 'phase', phase: 'idle' });
    assert.equal(host.get().touchFace, undefined, 'only while that pinch lasts');
    // A click on her head: O up a little (times the card's sensitivity), then it falls back by its half-life.
    const before = host.get().snapshot.values.O;
    b.touch({ kind: 'click', part: 'head', side: null, where: 'unbound', at: clock.now });
    const after = host.get().snapshot.values.O;
    assert.ok(after > before && after - before <= 1.01, `${before} → ${after}`);
    assert.equal(host.get().touchFace?.kind, 'click');
    clock.now += 2 * DEFAULT_MOOD_PARAMETERS.halfLifeMs.O;
    const later = host.get().snapshot.values.O;
    assert.ok(later < after && later > before - 1e-9, 'it decays back toward her baseline');
    // The speech cue: free in Unbound even right after she spoke; capped in the companion.
    assert.equal(host.touchAttention('free'), true);
    clock.now += DEFAULT_MOOD_PARAMETERS.interaction.attentionMs + 1_000; // the cue has passed
    assert.equal(host.get().snapshot.cue, null);
    assert.equal(host.touchAttention('capped'), false, 'the pet keeps its 30-minute interval');
    assert.equal(host.touchAttention('free'), true, 'at the same moment Unbound is not capped');
  } finally {
    await host.flush().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('readTouchFace: a view can never ask for a bigger face than the table holds', () => {
  const face = readTouchFace({ id: 'touch-1', kind: 'pinch', face: 'beam', smile: 1, eyelids: 1, at: 0, until: 10 })!;
  assert.equal(face.smile, TOUCH_FACES.beam.smile);
  assert.equal(readTouchFace({ id: 'touch-1', kind: 'pinch', face: 'toString', smile: 0, eyelids: 0, at: 0, until: 10 }), null);
  assert.equal(pinchFacePick({ id: 'touch-1', kind: 'click', face: 'beam', smile: 0, eyelids: 0, at: 0, until: 10 }), null, 'a click face is not a pinch face');
});
