/**
 * I-087 牵手、拉钩、击掌: the pure parts. Her mood's reads (O, N/C, early days, D, A) and the counts; the session state machine of each
 * use (offer, touch, hold, let go, timeout, interruptions) and its emoji hint; the abstract input (a fake pose source drives the
 * session exactly like the mouse); the strict readers; "你说做完了" word check; the host (mood writes, cooldowns, the pinky promise,
 * the first-hold keepsake gate, the journal line); the mood moments' table and cooldowns.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyHandsLedger, handsAllowed, handsLean, noteFirstHold, noteHandsEnd, noteHandsOffer, notePromise, forgetPromises, readHandsLedger, saysFinished,
  type HandsMood } from '../shared/behaviors/hands/choose';
import { HANDS_KNOBS, HAND_EMOJI, NEUTRAL_HAND_STYLE } from '../shared/behaviors/hands/knobs';
import { readHandsAnswer, readHandsEvent, readHandsRequest, type HandsEvent } from '../shared/behaviors/hands/interface';
import { HandsSession, type HandsSessionInput } from '../shared/behaviors/hands/session';
import { HandInput, PoseHandSource } from '../src/senses/hand-input';
import { HandsHost, HANDS_AFTER_MS, type HandsJournalInput } from '../electron/initiative/hands/host';
import { MOOD_MOMENTS } from '../shared/foundation/mood-moments';
import { MoodMoments } from '../electron/mood/mood-moments';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { ENGLISH_JOURNAL_UI_COPY as JOURNAL_EN } from '../shared/foundation/ui-copy.journal.en';

const V = (o: Partial<Record<'D' | 'O' | 'E' | 'N' | 'C' | 'S', number>> = {}) => ({ D: 50, O: 50, E: 50, N: 50, C: 50, S: 50, ...o }) as HandsMood['values'];
const mood = (values: Partial<Record<'D' | 'O' | 'E' | 'N' | 'C', number>> = {}, extra: Partial<HandsMood> = {}): HandsMood =>
  ({ values: V(values), baseline: V(), evidence: 1, A: 0.1, ...extra });

// ---------------------------------------------------------------- reading her mood

test('mood reads: O up → more often, longer wait, squeezes back; N or C high → seeks your hand, tighter; D → livelier; A → loose and sleepy', () => {
  const calm = handsLean(mood());
  assert.equal(calm.factor, 1); assert.deepEqual(calm.why, []); assert.equal(calm.wait, 1);
  const close = handsLean(mood({ O: 80 }));
  assert.ok(close.factor > 1.3, `O up: ${close.factor}`); assert.ok(close.why.includes('close')); assert.equal(close.style.squeezeBack, true); assert.ok(close.wait > 1);
  const distant = handsLean(mood({ O: 25 }));
  assert.ok(distant.factor < 1, 'O below her baseline: less often');
  const scared = handsLean(mood({ N: 90 }));
  assert.ok(scared.factor > 1.4 && scared.why.includes('scared'), `scared seeks your hand: ${scared.factor}`);
  assert.ok(scared.style.grip > calm.style.grip, 'holds tighter');
  assert.ok(handsLean(mood({ C: 90 })).why.includes('scared'), 'C high too');
  // Rules audit item 15 (2026-11-25): the relationship stage is no input; an old caller handing one in changes nothing.
  for (const stage of ['new', 'warming', 'close', 'old', null]) {
    const same = handsLean({ ...mood(), stage } as never);
    assert.deepEqual(same, calm, `stage ${String(stage)}`); assert.equal(same.style.hesitant, false); assert.ok(!same.why.includes('shy'));
  }
  const happy = handsLean(mood({ D: 90 }));
  assert.ok(happy.style.lively > 0.5 && happy.style.swing > 0.5);
  const sleepy = handsLean(mood({}, { A: 0.8 }));
  assert.equal(sleepy.style.sleepy, true); assert.ok(sleepy.style.grip < calm.style.grip, 'a loose hold');
  // Relative to the card's baseline: the same O reads differently on a warmer card.
  assert.ok(handsLean({ ...mood({ O: 70 }), baseline: V({ O: 70 }) }).factor === 1);
});

test('counts: her own reaches are few and apart; the resting mouse waits after one you did not take; a new day resets', () => {
  const t0 = new Date(2026, 10, 11, 14, 0).getTime();
  let ledger = emptyHandsLedger();
  assert.equal(handsAllowed(ledger, 'own', t0), true);
  ledger = noteHandsOffer(ledger, 'own', t0);
  assert.equal(handsAllowed(ledger, 'own', t0 + 10 * 60_000), false, 'own gap');
  assert.equal(handsAllowed(ledger, 'own', t0 + HANDS_KNOBS.own.gapMs), true);
  assert.equal(handsAllowed(ledger, 'rest', t0 + 60_000), false, 'rest waits after any reach');
  assert.equal(handsAllowed(ledger, 'rest', t0 + HANDS_KNOBS.rest.gapMs), true);
  ledger = noteHandsEnd(ledger, 'not-taken', t0 + HANDS_KNOBS.rest.gapMs);
  assert.equal(handsAllowed(ledger, 'rest', t0 + HANDS_KNOBS.rest.gapMs + 60_000), false, 'not taken: a while longer (no guilt, just room)');
  assert.equal(noteHandsEnd(ledger, 'taken', t0), ledger, 'taken changes nothing here');
  let many = emptyHandsLedger();
  for (let i = 0; i < HANDS_KNOBS.own.perDay; i++) many = noteHandsOffer(many, 'own', t0 + i * HANDS_KNOBS.own.gapMs);
  const later = t0 + HANDS_KNOBS.own.perDay * HANDS_KNOBS.own.gapMs;
  assert.equal(handsAllowed(many, 'own', later), false, 'per day');
  assert.equal(handsAllowed(many, 'own', new Date(2026, 10, 12, 9, 0).getTime()), true, 'a new day');
  let fives = emptyHandsLedger();
  fives = noteHandsOffer(fives, 'game', t0);
  assert.equal(handsAllowed(fives, 'finished', t0 + 60_000), false, 'high fives a little apart');
  assert.equal(handsAllowed(fives, 'plan', t0 + 60_000), true, 'the pinky has its own count');
});

test('the first hold is kept only with 「允许记录」 on; off it is only noted so a later hold is not "the first"', () => {
  const on = noteFirstHold(emptyHandsLedger(), true);
  assert.equal(on.keep, true); assert.equal(on.ledger.firstHold, 'kept');
  assert.equal(noteFirstHold(on.ledger, true).keep, false, 'only once');
  const off = noteFirstHold(emptyHandsLedger(), false);
  assert.equal(off.keep, false); assert.equal(off.ledger.firstHold, 'held');
  assert.equal(noteFirstHold(off.ledger, true).keep, false, 'the first hold happened with recording off: none later is called the first');
});

test('pinky promises: marked plan ids, bounded, no duplicates; recording off forgets them; the stored ledger is read strictly', () => {
  let ledger = notePromise(emptyHandsLedger(), ['p1', 'p2'], 5);
  ledger = notePromise(ledger, ['p2', 'p3'], 6);
  assert.deepEqual(ledger.promises.map(p => p.planId), ['p1', 'p2', 'p3']);
  assert.deepEqual(forgetPromises(ledger).promises, []);
  assert.deepEqual(readHandsLedger(JSON.parse(JSON.stringify(ledger))), ledger);
  assert.equal(readHandsLedger({ ...ledger, firstHold: 'maybe' }), null);
  assert.equal(readHandsLedger({ ...ledger, promises: [{ planId: '../x', at: 1 }] }), null);
  assert.equal(readHandsLedger({ ...ledger, own: -1 }), null);
});

test('"你说做完了一件事": a local word check, with "not yet" and questions left out', () => {
  for (const yes of ['终于做完了！', '论文写完了', '搞定了', '今天的任务完成了', '我把报告交了', 'finally finished it', 'done!']) assert.equal(saysFinished(yes), true, yes);
  for (const no of ['还没做完', '快写完了', '做完了吗？', '你搞定了没', '明天要完成', '我在写作业', '', 'I am not done', 42]) assert.equal(saysFinished(no), false, String(no));
});

// ---------------------------------------------------------------- the IPC readers

test('the narrow IPC: exact shapes, closed words', () => {
  assert.deepEqual(readHandsAnswer({ id: 'hands-abc', outcome: 'taken' }), { id: 'hands-abc', outcome: 'taken' });
  assert.equal(readHandsAnswer({ id: 'hands-abc', outcome: 'taken', extra: 1 }), null);
  assert.equal(readHandsAnswer({ id: 'give-abc', outcome: 'taken' }), null);
  assert.equal(readHandsAnswer({ id: 'hands-abc', outcome: 'grabbed' }), null);
  assert.deepEqual(readHandsRequest({ use: 'hold' }), { use: 'hold' });
  assert.equal(readHandsRequest({ use: 'pinky' }), null, 'the window may only say the mouse rested near her');
  const offer: HandsEvent = { type: 'offer', id: 'hands-1', use: 'hold', why: ['rest'], waitMs: 12000, style: NEUTRAL_HAND_STYLE };
  assert.deepEqual(readHandsEvent(offer), offer);
  assert.equal(readHandsEvent({ ...offer, why: ['because'] }), null);
  assert.equal(readHandsEvent({ ...offer, waitMs: 10 }), null);
  assert.equal(readHandsEvent({ ...offer, style: { ...NEUTRAL_HAND_STYLE, grip: 3 } }), null);
  assert.deepEqual(readHandsEvent({ type: 'cancel', id: 'hands-1' }), { type: 'cancel', id: 'hands-1' });
});

// ---------------------------------------------------------------- the session

const idle: Omit<HandsSessionInput, 'now'> = { arrived: false, touch: false, far: false, blocked: false, stageIdle: false };
const offerOf = (use: 'hold' | 'pinky' | 'high-five', extra: Partial<typeof NEUTRAL_HAND_STYLE> = {}) => ({ id: 'hands-s', use, waitMs: 5000, style: { ...NEUTRAL_HAND_STYLE, ...extra } });

test('hold: reach → wait → a touch holds (answered taken); squeezes now and then; a second touch lets go; the far mouse lets go after a moment', () => {
  const s = new HandsSession(offerOf('hold', { squeezeBack: true }), 0, () => 0.5);
  assert.deepEqual(s.step({ ...idle, now: 100 }), { commands: [], answers: [] });
  s.step({ ...idle, now: 900, arrived: true });
  assert.equal(s.phase, 'waiting');
  assert.deepEqual(s.step({ ...idle, now: 2000, touch: true }), { commands: ['hold'], answers: ['taken'] });
  assert.equal(s.phase, 'held');
  // squeeze: (7 s + 9 s × 0.5) × 0.6 after the hold
  const due = 2000 + (HANDS_KNOBS.squeezeEveryMs[0] + (HANDS_KNOBS.squeezeEveryMs[1] - HANDS_KNOBS.squeezeEveryMs[0]) * 0.5) * HANDS_KNOBS.squeezeBack;
  assert.deepEqual(s.step({ ...idle, now: due - 1 }).commands, []);
  assert.deepEqual(s.step({ ...idle, now: due }).commands, ['squeeze']);
  assert.deepEqual(s.step({ ...idle, now: due + 100, far: true }).commands, [], 'far for a moment: not yet');
  assert.deepEqual(s.step({ ...idle, now: due + 200 }).commands, [], 'back near: the far clock restarts');
  s.step({ ...idle, now: due + 300, far: true });
  assert.deepEqual(s.step({ ...idle, now: due + 300 + HANDS_KNOBS.farMs, far: true }), { commands: ['release'], answers: ['let-go'] });
  assert.equal(s.phase, 'back'); assert.equal(s.answered, true);
  s.step({ ...idle, now: due + 2000, stageIdle: true });
  assert.equal(s.done, true);
  const again = new HandsSession(offerOf('hold'), 0);
  again.step({ ...idle, now: 1, touch: true });
  assert.deepEqual(again.step({ ...idle, now: 3000, touch: true }), { commands: ['release'], answers: ['let-go'] }, 'click again: let go');
  const sleepy = new HandsSession(offerOf('hold', { sleepy: true }), 0);
  sleepy.step({ ...idle, now: 1, touch: true });
  for (let t = 2; t < 60_000; t += 500) assert.deepEqual(sleepy.step({ ...idle, now: t }).commands, [], 'sleepy: no squeezes, she just holds');
});

test('not taken: after the wait she takes her hand back quietly (one answer); blocked → interrupted; the host cancels → interrupted once', () => {
  const s = new HandsSession(offerOf('hold'), 0);
  s.step({ ...idle, now: 800, arrived: true });
  assert.deepEqual(s.step({ ...idle, now: 800 + 4999 }).answers, []);
  assert.deepEqual(s.step({ ...idle, now: 800 + 5000 }), { commands: ['release'], answers: ['not-taken'] });
  assert.deepEqual(s.cancel(), { commands: [], answers: [] }, 'already going back: nothing more');
  const b = new HandsSession(offerOf('high-five'), 0);
  assert.deepEqual(b.step({ ...idle, now: 10, blocked: true }), { commands: ['release'], answers: ['interrupted'] });
  const c = new HandsSession(offerOf('hold'), 0);
  c.step({ ...idle, now: 10, touch: true });
  assert.deepEqual(c.cancel(), { commands: ['release'], answers: ['interrupted'] }, 'holding, then cancelled: the end is answered');
  const r = new HandsSession(offerOf('hold'), 0);
  r.step({ ...idle, now: 10 });
  assert.equal(r.phase, 'reaching');
  r.step({ ...idle, now: 6_500 });
  assert.equal(r.phase, 'waiting', 'a reach that never reports arriving (no arm) still waits and ends');
});

test('pinky and high five: one touch is the whole thing (taken once), her hand meets yours, then comes back', () => {
  for (const use of ['pinky', 'high-five'] as const) {
    const s = new HandsSession(offerOf(use), 0);
    s.step({ ...idle, now: 700, arrived: true });
    assert.deepEqual(s.step({ ...idle, now: 1500, touch: true }), { commands: ['touch'], answers: ['taken'] });
    assert.equal(s.answered, true);
    assert.deepEqual(s.step({ ...idle, now: 1500 + HANDS_KNOBS.touchMs - 1 }).commands, []);
    assert.deepEqual(s.step({ ...idle, now: 1500 + HANDS_KNOBS.touchMs }), { commands: ['release'], answers: [] });
    assert.deepEqual(s.cancel(), { commands: [], answers: [] });
  }
});

test('the emoji hint (waiting, then the done one): over her hand while she reaches and waits, at the touch and while holding; never after', () => {
  const s = new HandsSession(offerOf('hold'), 0);
  assert.equal(s.emoji(false), null, 'not over her hand: none');
  assert.equal(s.emoji(true), '🫱');
  s.step({ ...idle, now: 1, touch: true });
  assert.equal(s.emoji(false), '🤝', 'holding: wherever your pointer is');
  s.step({ ...idle, now: 2, touch: true });
  assert.equal(s.emoji(true), null, 'let go: gone at once');
  const p = new HandsSession(offerOf('pinky'), 0), h = new HandsSession(offerOf('high-five'), 0);
  assert.equal(p.emoji(true), HAND_EMOJI.pinky); assert.equal(h.emoji(true), '✋');
  p.step({ ...idle, now: 1, touch: true });
  assert.equal(p.emoji(false), '🤞', 'at the touch');
});

test('the abstract input: a fake pose source drives the same session exactly like the mouse (only "where" and "a touch")', () => {
  const path = Array.from({ length: 80 }, (_, i) => ({ x: -0.3 + 0.004 * i, y: -0.1 + 0.002 * i }));
  const run = (pose: boolean) => {
    const input = new HandInput(), source = new PoseHandSource();
    if (pose) input.use(source);
    const session = new HandsSession(offerOf('hold'), 0, () => 0.3), out: unknown[] = [];
    path.forEach((p, i) => {
      if (pose) source.update(p);
      const reading = input.frame(pose ? { x: 0.9, y: 0.9 } : p, true); // the mouse is elsewhere while the pose source leads
      if (i === 20) input.touch();
      const far = !reading || Math.abs(reading.x) > 0.95;
      out.push(reading && { ...reading }, session.step({ now: i * 100, arrived: i > 5, touch: input.takeTouch(), far, blocked: false, stageIdle: false }));
    });
    return out;
  };
  assert.deepEqual(run(true), run(false));
  const input = new HandInput();
  assert.equal(input.frame({ x: 0.2, y: 0.1 }, false), null, '跟随鼠标 off: the mouse source knows nothing');
  input.touch(); input.touch();
  assert.equal(input.takeTouch(), true); assert.equal(input.takeTouch(), false, 'several touches in one frame are one');
});

// ---------------------------------------------------------------- the host

interface Harness { host: HandsHost; sent: HandsEvent[]; moments: string[]; journal: HandsJournalInput[]; kept: number[]; ledger: () => any; set: { now: number; free: boolean; recording: boolean; enabled: boolean; random: number; mood: HandsMood; plans: string[] }; timers: { fire(): void } }
function harness(): Harness {
  const set = { now: new Date(2026, 10, 11, 15, 0).getTime(), free: true, recording: true, enabled: true, random: 0, mood: mood(), plans: ['plan-1'] };
  const sent: HandsEvent[] = [], moments: string[] = [], journal: HandsJournalInput[] = [], kept: number[] = [];
  let stored = emptyHandsLedger();
  const pending: (() => void)[] = [];
  const host = new HandsHost({
    store: { load: async () => {}, loaded: () => true, ledger: () => stored, set: async (_id, next) => { stored = next; return true; }, known: () => ['gene'] },
    enabled: () => set.enabled, free: () => set.free, characterId: () => 'gene', mood: () => set.mood,
    send: event => { sent.push(event); return true; }, moment: (kind, _id, key) => { moments.push(`${kind}:${key}`); },
    journal: entry => { journal.push(entry); }, recording: () => set.recording,
    keepFirstHold: async (_id, at) => { kept.push(at); return true; }, recentPlans: () => set.plans,
    clock: () => set.now, random: () => set.random,
    timers: { set: callback => { pending.push(callback); return pending.length; }, clear: () => {} },
  });
  return { host, sent, moments, journal, kept, ledger: () => stored, set, timers: { fire: () => { const run = pending.splice(0); run.forEach(callback => callback()); } } };
}
const lastOffer = (h: Harness) => h.sent.filter(e => e.type === 'offer').at(-1) as Extract<HandsEvent, { type: 'offer' }>;

test('host: the resting mouse (pet only) → hold; taken → the held-hands moment, the first hold kept, one journal line; let go → nothing more', async () => {
  const h = harness();
  assert.equal(h.host.request(false, { use: 'hold' }), false, 'only the pet window');
  assert.equal(h.host.request(true, { use: 'hold' }), true);
  const offer = lastOffer(h);
  assert.equal(offer.use, 'hold'); assert.deepEqual(offer.why, ['rest']);
  assert.equal(h.host.answer(true, { id: offer.id, outcome: 'taken' }), true);
  await Promise.resolve();
  assert.deepEqual(h.moments, [`held-hands:${offer.id}`]);
  assert.equal(h.kept.length, 1, 'the first hold, kept (recording on)');
  assert.deepEqual(h.journal, [{ type: 'hands', characterId: 'gene', use: 'hold', outcome: 'taken', why: ['rest'], first: true }]);
  assert.equal(h.host.current()?.taken, true, 'holding: the reach stays');
  assert.equal(h.host.answer(true, { id: offer.id, outcome: 'let-go' }), true);
  assert.equal(h.host.current(), null);
  assert.deepEqual(h.moments.length, 1, 'let go: nothing written');
  assert.equal(h.journal.length, 1, 'one line per reach');
  // The next hold is not the first one.
  h.set.now += HANDS_KNOBS.rest.gapMs;
  h.host.request(true, { use: 'hold' });
  h.host.answer(true, { id: lastOffer(h).id, outcome: 'taken' });
  assert.equal(h.kept.length, 1); assert.equal(h.journal.at(-1)!.first, undefined);
});

test('host: recording off → the first hold is not kept (only noted); not taken → nothing written but the line, and the next ask waits', () => {
  const h = harness();
  h.set.recording = false;
  h.host.request(true, { use: 'hold' });
  h.host.answer(true, { id: lastOffer(h).id, outcome: 'taken' });
  assert.equal(h.kept.length, 0); assert.equal(h.ledger().firstHold, 'held');
  h.host.answer(true, { id: lastOffer(h).id, outcome: 'let-go' });
  const g = harness();
  g.host.request(true, { use: 'hold' });
  const offer = lastOffer(g);
  g.host.answer(true, { id: offer.id, outcome: 'not-taken' });
  assert.deepEqual(g.moments, [], 'no guilt: no mood change');
  assert.deepEqual(g.journal.map(j => j.outcome), ['not-taken']);
  g.set.now += HANDS_KNOBS.rest.gapMs;
  assert.equal(g.host.request(true, { use: 'hold' }), false, 'after one you did not take, she waits a while longer');
});

test('host: her own wish rides a small-motion cue (decided once; never a speech cue; never while not free or switched off); her mood leans the chance', () => {
  const h = harness();
  h.set.random = 0.15; // below own.chance (0.16) at factor 1
  assert.equal(h.host.claimCue({ id: 'c1', kind: 'speech' }), false);
  assert.equal(h.host.claimCue({ id: 'c2', kind: 'motion' }), true);
  assert.equal(h.host.claimCue({ id: 'c2', kind: 'motion' }), true, 'the same cue keeps its owner');
  assert.deepEqual(lastOffer(h).why, ['herself']);
  h.host.answer(true, { id: lastOffer(h).id, outcome: 'not-taken' });
  const shy = harness();
  shy.set.random = 0.15; shy.set.mood = { ...mood(), stage: 'new' } as never;
  assert.equal(shy.host.claimCue({ id: 'c3', kind: 'motion' }), true, 'early days: no longer less often (the stage is not read)');
  const scared = harness();
  scared.set.random = 0.3; scared.set.mood = mood({ N: 92 });
  assert.equal(scared.host.claimCue({ id: 'c4', kind: 'motion' }), true, 'scared: she seeks your hand');
  assert.ok(lastOffer(scared).why.includes('scared') && lastOffer(scared).style.grip > 0.6);
  const off = harness();
  off.set.enabled = false;
  assert.equal(off.host.claimCue({ id: 'c5', kind: 'motion' }), false, '内心循环 / 自动表现 off: never by herself');
  const busy = harness();
  busy.set.free = false;
  assert.equal(busy.host.claimCue({ id: 'c6', kind: 'motion' }), false, 'asleep, hidden, busy, patted or fed: never');
  assert.equal(busy.host.request(true, { use: 'hold' }), false);
});

test('host: a plan just said → her pinky; taken marks the plan as promised (recording on only); not via the late note', () => {
  const h = harness();
  h.host.planNoted('note');
  assert.equal(h.sent.length, 0, 'the segment note comes much later: not "just said"');
  h.host.planNoted('early');
  const offer = lastOffer(h);
  assert.equal(offer.use, 'pinky'); assert.deepEqual(offer.why, ['plan']);
  h.host.answer(true, { id: offer.id, outcome: 'taken' });
  assert.deepEqual(h.ledger().promises.map((p: any) => p.planId), ['plan-1']);
  assert.deepEqual(h.moments, [], 'a pinky promise writes no mood (it goes into her plan memory)');
  assert.equal(h.host.current(), null, 'one touch is the whole thing');
  h.host.recordingOff();
  assert.deepEqual(h.ledger().promises, [], 'recording off: the promises go with the plans');
  const off = harness();
  off.set.recording = false;
  off.host.planNoted('early');
  assert.equal(off.sent.length, 0, 'recording off: no plans, no pinky');
});

test('host: a won game or "做完了" → a high five after a moment; taken → the high-five moment; the words are never kept', () => {
  const h = harness();
  h.host.gameEnded('none');
  h.timers.fire();
  assert.equal(h.sent.length, 0, 'a draw: no high five');
  h.host.gameEnded('user');
  assert.equal(h.sent.length, 0, 'not at once: her arm comes back from the game first');
  h.timers.fire();
  const offer = lastOffer(h);
  assert.equal(offer.use, 'high-five'); assert.deepEqual(offer.why, ['game']);
  h.host.answer(true, { id: offer.id, outcome: 'taken' });
  assert.deepEqual(h.moments, [`high-five:${offer.id}`]);
  h.set.now += HANDS_KNOBS.highFive.gapMs;
  h.host.userSaid('req-1', '还没做完');
  h.host.chatDone('req-1', true); h.timers.fire();
  assert.equal(h.sent.filter(e => e.type === 'offer').length, 1, '"not yet": nothing');
  h.host.userSaid('req-2', '论文终于写完了！');
  h.host.chatDone('req-2', false); h.timers.fire();
  assert.equal(h.sent.filter(e => e.type === 'offer').length, 1, 'her reply failed: nothing');
  h.host.userSaid('req-3', '搞定了');
  h.host.chatDone('req-3', true); h.timers.fire();
  assert.deepEqual(lastOffer(h).why, ['finished']);
  assert.ok(HANDS_AFTER_MS.finished > 0);
  assert.ok(!JSON.stringify(h.journal).includes('搞定'), 'never the words');
});

test('host: one reach at a time; an unanswered reach ends as not taken; cancel answers interrupted and tells the window', () => {
  const h = harness();
  h.host.request(true, { use: 'hold' });
  h.host.planNoted('early');
  assert.equal(h.sent.length, 1, 'one at a time');
  h.timers.fire();
  assert.equal(h.host.current(), null); assert.deepEqual(h.journal.map(j => j.outcome), ['not-taken']);
  const c = harness();
  c.host.request(true, { use: 'hold' });
  c.host.cancel();
  assert.deepEqual(c.sent.at(-1), { type: 'cancel', id: lastOffer(c).id }); assert.deepEqual(c.journal.map(j => j.outcome), ['interrupted']);
  assert.equal(c.host.answer(true, { id: lastOffer(c).id, outcome: 'taken' }), false, 'a late answer does nothing');
});

// ---------------------------------------------------------------- mood moments and the journal line

test('mood moments: holding → O up, C down, E a little (30 min cooldown); a high five → D (15 min); relative to her baseline', () => {
  assert.deepEqual(MOOD_MOMENTS['held-hands'].delta, { O: 1.5, C: -1, E: 0.5 });
  assert.deepEqual(MOOD_MOMENTS['high-five'].delta, { D: 1.5 });
  let now = 1_000_000;
  const lifts: { id: string; delta: Record<string, number> }[] = [];
  const moments = new MoodMoments({ clock: () => now, current: () => 'gene', state: () => ({ values: V(), baseline: V(), evidence: 1, primary: 'calm' }),
    lift: lift => { lifts.push(lift as any); return true; } });
  assert.equal(moments.note('held-hands', 'gene', 'a'), true);
  assert.deepEqual(lifts[0].delta, { O: 1.5, C: -1, E: 0.5 });
  assert.equal(moments.note('held-hands', 'gene', 'b'), false, 'cooldown');
  now += 30 * 60_000;
  assert.equal(moments.note('held-hands', 'gene', 'c'), true);
  assert.equal(moments.note('high-five', 'gene', 'd'), true, 'its own family');
  assert.deepEqual(lifts.at(-1)!.delta, { D: 1.5 });
  assert.equal(moments.note('high-five', 'gene', 'e'), false);
});

test('journal: one closed line per reach in Chinese with an English copy; free words and a wrong "first" are refused', () => {
  const at = new Date(2026, 10, 11, 21, 5).getTime();
  const entry = buildJournalEntry({ type: 'hands', characterId: 'gene', use: 'hold', outcome: 'taken', why: ['rest', 'close'], first: true }, at)!;
  assert.ok(entry);
  const zh = describeJournalEntry(entry, (source, ...values) => values.reduce<string>((s, v, i) => s.replace(`{${i}}`, String(v)), source));
  assert.equal(zh, '21:05 你们第一次牵了手（牵手，你的鼠标停在她身边、她很想亲近你）');
  const en = describeJournalEntry(entry, (source, ...values) => values.reduce<string>((s, v, i) => s.replace(`{${i}}`, String(v)), (JOURNAL_EN as Record<string, string>)[source] ?? source));
  assert.ok(/^21:05 You held hands for the first time/u.test(en) && !/[一-鿿]/u.test(en), en);
  const pinky = describeJournalEntry(buildJournalEntry({ type: 'hands', characterId: 'gene', use: 'pinky', outcome: 'not-taken', why: ['plan'] }, at)!, (source, ...values) => values.reduce<string>((s, v, i) => s.replace(`{${i}}`, String(v)), source));
  assert.match(pinky, /她伸出小指想拉钩/u);
  assert.equal(buildJournalEntry({ type: 'hands', characterId: 'gene', use: 'hold', outcome: 'taken', why: ['because she said so'] }, at), null);
  assert.equal(buildJournalEntry({ type: 'hands', characterId: 'gene', use: 'pinky', outcome: 'taken', why: [], first: true }, at), null);
  assert.equal(buildJournalEntry({ type: 'hands', characterId: 'gene', use: 'hold', outcome: 'taken', why: [], text: '牵手' }, at)?.hasOwnProperty('text') ?? false, false);
});

test('the cursor emoji: waiting hint differs from the taken one; a hold keeps the taken one until let-go, pinky and high-five show it briefly then none', () => {
  const waiting = { hold: '🫱', pinky: '🤙', 'high-five': '✋' } as const, done = { hold: '🤝', pinky: '🤞', 'high-five': '🙌' } as const;
  for (const use of ['hold', 'pinky', 'high-five'] as const) {
    const s = new HandsSession(offerOf(use), 0, () => 0.5);
    s.step({ ...idle, now: 900, arrived: true });
    assert.equal(s.emoji(false), null, 'not over her hand: no hint');
    assert.equal(s.emoji(true), waiting[use]);
    s.step({ ...idle, now: 2000, touch: true });
    assert.equal(s.emoji(false), done[use], 'taken: the done emoji, wherever the pointer is');
    assert.notEqual(done[use], waiting[use]);
    if (use === 'hold') {
      s.step({ ...idle, now: 5000 });
      assert.equal(s.emoji(false), '🤝', 'still holding: it stays');
      s.step({ ...idle, now: 6000, touch: true });
    } else s.step({ ...idle, now: 2000 + HANDS_KNOBS.touchMs });
    assert.equal(s.phase, 'back');
    assert.equal(s.emoji(true), null, 'let go / touch over: the normal pointer again');
  }
});
