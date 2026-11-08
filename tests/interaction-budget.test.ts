/**
 * I-010 互动余额（docs/claude/2026-11-05-i010-interaction-budget.md）：纯规则、主机、和接上的每一处。全部是假时钟、假模型，没有源码截取。
 *  - 余额跟着互动长、跟着离开少；性格改变花费；深夜加倍；强烈的心情能越过软上限；
 *  - 同一件事只记一次，晚到的不会比准时到多，退回只退一次；
 *  - 接上的每一处（开口、小情绪、猜拳邀请和局里的话、一起听、停停说说）都听余额的，没接余额时和原来一模一样。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  budgetAgainAfter, budgetRoom, budgetScale, createBudget, creditBudget, interactionsSince, refundBudget, settleBudget, spendBudget,
} from '../shared/behaviors/interaction-budget/choose';
import { INTERACTION_BUDGET_KNOBS } from '../shared/behaviors/interaction-budget/knobs';
import { OpenBudget } from '../shared/behaviors/interaction-budget/fake';
import type { InteractionBudget } from '../shared/behaviors/interaction-budget/interface';
import { InteractionBudgetHost, openingBudget } from '../electron/interaction-budget/host';
import { budgetCreditKind, CompanionService } from '../electron/companion';
import { OpeningHost, type OpeningLoop } from '../electron/inner-loop/opening-host';
import { FixedOpeningChoice } from '../shared/behaviors/opening-choice/fake';
import { herNeedLimitInput, herNeedLimits, createHerNeedState } from '../shared/her-needs';
import { HerNeedsHost } from '../electron/her-needs/host';
import { rpsInviteVerdict, type RpsInviteInput } from '../shared/rps-personality';
import { rpsVoiceChance, type RpsVoiceInput } from '../shared/rps-voice';
import { RpsHost } from '../electron/rps/host';
import { RpsStore } from '../electron/rps/store';
import { RPS_TIMING, type RpsView } from '../shared/rps';
import { listenWillSpeak } from '../shared/listen-proactive';
import { PauseTalkHost, type PauseTalkTimers } from '../electron/pause-talk/host';
import { formatBudgetLines, formatPauseTalkLines } from '../src/ui/MoodPanel';
import { DEFAULT_MOOD_PARAMETERS, createMoodState, getMoodSnapshot, type MoodCue } from '../shared/mood';
import type { MoodView } from '../shared/mood-runtime';
import type { PauseTalkNow } from '../shared/behaviors/pause-talk/interface';

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const K = INTERACTION_BUDGET_KNOBS;
const T0 = 1_800_000_000_000;
const PLAIN = { scale: 1, night: false };
const balance = (state: ReturnType<typeof createBudget>, now: number) => { const s = settleBudget(state, now); return s.earned + s.floor; };

// ---------------------------------------------------------------- pure rules

test('the balance grows with real interaction and shrinks with absence; the floor alone comes back slowly, never more than 1', () => {
  let state = createBudget(T0);
  assert.equal(balance(state, T0), K.floor.max, 'a fresh start is the floor alone');
  for (let i = 0; i < 6; i++) state = creditBudget(state, { kind: 'message', id: `m${i}` }, T0 + i * MINUTE).state;
  const lively = balance(state, T0 + 6 * MINUTE);
  assert.ok(lively > 6.5 && lively < 7.1, `six messages: ${lively}`);
  // Away: half every three hours (the floor stays).
  assert.ok(Math.abs(settleBudget(state, T0 + 6 * MINUTE + 3 * HOUR).earned - settleBudget(state, T0 + 6 * MINUTE).earned / 2) < 1e-6);
  const morning = settleBudget(state, T0 + 12 * HOUR);
  assert.ok(morning.earned < 0.5, `an evening and night away: almost nothing earned is left (${morning.earned})`);
  // Spend everything, then wait: the floor comes back at its own pace and stops at its max.
  let spent = state;
  for (let i = 0; i < 12; i++) spent = spendBudget(spent, { kind: 'speak', id: `s${i}`, ...PLAIN }, T0 + 7 * MINUTE).state;
  assert.equal(balance(spent, T0 + 7 * MINUTE), 0, 'never below zero');
  assert.ok(Math.abs(balance(spent, T0 + 7 * MINUTE + 4 * HOUR) - 4 * K.floor.perHour) < 1e-6);
  assert.equal(balance(spent, T0 + 7 * MINUTE + 48 * HOUR), K.floor.max);
  // The earned pool has a ceiling: a frantic session never turns into a reserve to pour out later.
  let frantic = createBudget(T0);
  for (let i = 0; i < 100; i++) frantic = creditBudget(frantic, { kind: 'answer', id: `a${i}` }, T0).state;
  assert.equal(settleBudget(frantic, T0).earned, K.earnedMax);
});

test('room: none pressed when the balance covers it, smoothly pressed below, a strong feeling climbs over, night doubles the cost', () => {
  const state = createBudget(T0); // the floor alone: 1
  assert.equal(budgetRoom(state, 'speak', T0, PLAIN).factor, 1, 'the floor covers one line, as before');
  assert.equal(budgetRoom(state, 'need', T0, PLAIN).factor, 0, 'the floor pays only for "look at you once, say one thing": no small need from it');
  const once = creditBudget(state, { kind: 'message', id: 'm' }, T0).state;
  const need = budgetRoom(once, 'need', T0, PLAIN).factor;
  assert.ok(need > 0.6 && need < 0.8, `a need (1.5) on one message: ${need}`);
  assert.equal(spendBudget(state, { kind: 'need', id: 'n', ...PLAIN }, T0).state.floor, K.floor.max, 'and never takes from the floor');
  const empty = spendBudget(state, { kind: 'speak', id: 'x', ...PLAIN }, T0).state;
  assert.equal(budgetRoom(empty, 'speak', T0, PLAIN).factor, 0, 'nothing left: no room');
  const half = settleBudget(empty, T0 + 4 * HOUR); // 0.5
  const halfRoom = budgetRoom(half, 'speak', T0 + 4 * HOUR, PLAIN);
  assert.ok(halfRoom.factor > 0.4 && halfRoom.factor < 0.6, `smooth, not a cliff: ${halfRoom.factor}`);
  assert.equal(budgetRoom(half, 'speak', T0 + 4 * HOUR, { ...PLAIN, ask: { mood: 'longing' } }).strong, true);
  assert.ok(budgetRoom(half, 'speak', T0 + 4 * HOUR, { ...PLAIN, ask: { mood: 'longing' } }).factor > halfRoom.factor + 0.2, 'missing you climbs over the soft cap');
  assert.equal(budgetRoom(half, 'speak', T0 + 4 * HOUR, { ...PLAIN, ask: { mood: 'calm' } }).factor, halfRoom.factor, 'an ordinary mood does not');
  assert.equal(budgetRoom(state, 'speak', T0, { scale: 1, night: true }).cost, 2, 'night doubles the cost');
  assert.ok(budgetRoom(state, 'speak', T0, { scale: 1, night: true }).factor < 1);
});

test('character: a clingy, playful card spends less; a cautious one more; the same balance gives them different room', () => {
  const clingy = budgetScale({ close: 1.6, playful: 1.6, cautious: 0.7 }), plain = budgetScale({}), cautious = budgetScale({ close: 0.8, playful: 0.9, cautious: 1.6 });
  assert.ok(clingy < plain && plain === 1 && cautious > plain, `${clingy} < ${plain} < ${cautious}`);
  assert.ok(clingy >= K.character.min && cautious <= K.character.max);
  const state = creditBudget(createBudget(T0), { kind: 'message', id: 'm' }, T0).state;
  const room = (scale: number) => budgetRoom(state, 'need', T0, { scale, night: false }).factor;
  assert.ok(room(clingy) > room(plain) && room(plain) > room(cautious), `${room(clingy)} > ${room(plain)} > ${room(cautious)}`);
  // "Again after N interactions" by character.
  assert.ok(budgetAgainAfter('invite', { playful: 1.6 }) < budgetAgainAfter('invite', {}));
  assert.ok(budgetAgainAfter('invite', { cautious: 1.6, playful: 0.8 }) > budgetAgainAfter('invite', {}));
  // F7's haiku (share): a quiet card asks less often, an ordinary or lively one every time.
  assert.equal(budgetRoom(state, 'pausePlan', T0, { scale: 1, night: false }).factor, 1);
  assert.equal(budgetRoom(state, 'pausePlan', T0, { scale: clingy, night: false }).factor, 1);
  const quiet = budgetRoom(state, 'pausePlan', T0, { scale: cautious, night: false }).factor;
  assert.ok(quiet < 1 && quiet >= K.share.pausePlan!, `${quiet}`);
});

test('one interaction counts once; a late one is decayed for its lateness; a clock going back grows nothing; a refund only once', () => {
  let state = createBudget(T0);
  const once = creditBudget(state, { kind: 'message', id: 'm1' }, T0);
  state = once.state;
  const again = creditBudget(state, { kind: 'message', id: 'm1' }, T0 + MINUTE);
  assert.equal(again.counted, false);
  assert.equal(balance(again.state, T0 + MINUTE), balance(state, T0 + MINUTE), 'the same id never adds twice');
  // Late by three hours: it adds what it would have left by now, not a fresh 1.
  const fresh = creditBudget(createBudget(T0), { kind: 'message', id: 'on-time' }, T0 + 3 * HOUR);
  const late = creditBudget(createBudget(T0), { kind: 'message', id: 'late', at: T0 }, T0 + 3 * HOUR);
  assert.ok(Math.abs(settleBudget(late.state, T0 + 3 * HOUR).earned - 0.5) < 1e-6);
  assert.ok(settleBudget(fresh.state, T0 + 3 * HOUR).earned > settleBudget(late.state, T0 + 3 * HOUR).earned);
  // A future timestamp counts as now.
  assert.equal(settleBudget(creditBudget(createBudget(T0), { kind: 'message', id: 'f', at: T0 + HOUR }, T0).state, T0).earned, 1);
  // The clock went back: nothing grows.
  const spent = spendBudget(createBudget(T0), { kind: 'speak', id: 's', ...PLAIN }, T0 + HOUR).state;
  assert.equal(balance(spent, T0), balance(spent, T0 + HOUR));
  // Spend once per id; refund once, exactly what it took.
  let s2 = creditBudget(createBudget(T0), { kind: 'message', id: 'm' }, T0).state; // 2
  s2 = spendBudget(s2, { kind: 'speak', id: 'cue', ...PLAIN }, T0).state; // 1
  assert.equal(spendBudget(s2, { kind: 'speak', id: 'cue', ...PLAIN }, T0).spent, false);
  const back = refundBudget(s2, 'cue', T0);
  assert.equal(back.refunded, true); assert.equal(balance(back.state, T0), 2);
  assert.equal(refundBudget(back.state, 'cue', T0).refunded, false, 'a refund never comes twice');
  assert.equal(refundBudget(back.state, 'never-spent', T0).refunded, false);
  assert.equal(back.state.log[0].refunded, true, 'the panel shows it as given back');
  // interactionsSince: only what this run saw.
  let run = createBudget(T0);
  run = creditBudget(run, { kind: 'message', id: 'before-run', at: T0 - HOUR }, T0).state;
  run = creditBudget(run, { kind: 'touch', id: 'p1' }, T0 + MINUTE).state;
  run = creditBudget(run, { kind: 'message', id: 'm2' }, T0 + 2 * MINUTE).state;
  assert.equal(interactionsSince(run, T0 - 2 * HOUR), 2, 'before this run began nothing is known, so nothing counts');
  assert.equal(interactionsSince(run, T0 + MINUTE), 1);
});

// ---------------------------------------------------------------- host and the contract (real vs fake)

test('host and fake keep the same contract; the host never reads the mood back and keeps nothing on disk', () => {
  const clock = { now: T0 };
  const real = new InteractionBudgetHost({ clock: () => clock.now }), fake = new OpenBudget();
  for (const budget of [real, fake] as InteractionBudget[]) {
    assert.equal(typeof budget.credit('gene', 'message', 'm1'), 'boolean');
    const room = budget.room('gene', 'speak');
    assert.ok(room.factor >= 0 && room.factor <= 1 && typeof room.words === 'string');
    assert.equal(typeof budget.spend('gene', 'speak', 'cue'), 'boolean');
    assert.equal(typeof budget.refund('gene', 'cue'), 'boolean');
    assert.ok(budget.interactionsSince('gene', T0 - HOUR) >= 0);
    assert.ok(budget.againAfter('gene', 'invite') >= 0);
  }
  assert.equal(fake.room('gene', 'need').factor, 1, 'the fake never presses (the rules before I-010)');
  real.observe('gene', { weights: { cautious: 1.6 }, night: true });
  const view = real.view('gene')!;
  assert.equal(view.night, true); assert.ok(view.scale > 1);
  assert.deepEqual(view.recent.map(entry => [entry.kind, entry.refunded === true]), [['speak', true], ['message', false]], 'newest first; the given-back spend is marked');
  assert.equal(real.credit('bad id with spaces', 'message', 'x'), false);
  assert.equal(real.view('nobody'), null);
  assert.equal(real.room('gene', 'speak').cost, 2 * view.scale, 'night × character');
});

// ---------------------------------------------------------------- the one place interactions are counted (real MoodHost path)

test('through CompanionService: a pat counts once however many events it sends; a message answering her line counts as an answer; a game as a game', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-budget-service-'));
  const clock = { now: Date.now() };
  const service = new CompanionService(directory, () => {}, { budget: { clock: () => clock.now } });
  try {
    await service.load(); await service.context('gene', { kind: 'claude', baseUrl: 'https://budget.invalid/v1', model: 'fixture' }, 'Gene');
    const id = service.mood.get().characterId;
    const token = () => service.mood.get().token;
    // She speaks up (a speech opportunity), nobody has answered yet: the next message answers her line and counts more.
    service.mood.setDeveloperMode(true);
    assert.equal(service.mood.forceAttention('speech'), true);
    service.mood.event({ type: 'chat', id: 'msg-answer', reason: '测试' }, id);
    assert.deepEqual(service.budget.view(id)!.recent.map(entry => [entry.kind, entry.delta]), [['answer', K.gains.answer]]);
    service.mood.event({ type: 'chat', id: 'msg-after', reason: '测试' }, id);
    assert.equal(service.budget.view(id)!.recent[0].kind, 'message', 'only the first message after her line is an answer');
    service.mood.setDeveloperMode(false);
    // A pat: the renderer reports many small strokes within one contact.
    service.mood.interaction({ token: token(), type: 'phase', sessionId: 'pat-a', phase: 'rua' });
    for (let i = 0; i < 4; i++) {
      await new Promise(resolve => setTimeout(resolve, 120));
      service.mood.interaction({ token: token(), type: 'rua', sessionId: 'pat-a', id: `stroke-${i}`, activeMs: 100 });
    }
    service.mood.interaction({ token: token(), type: 'phase', sessionId: 'pat-a', phase: 'idle' });
    const after = service.budget.view(id)!;
    assert.deepEqual(after.recent.map(entry => entry.kind), ['touch', 'message', 'answer'], 'one contact, one count');
    assert.equal(after.recent[0].delta, K.gains.touch);
    // A message, then the same accepted event again (a retry): once.
    service.mood.event({ type: 'chat', id: 'msg-1', reason: '测试' }, id);
    service.mood.event({ type: 'chat', id: 'msg-1', reason: '测试' }, id);
    assert.deepEqual(service.budget.view(id)!.recent.map(entry => entry.kind), ['message', 'touch', 'message', 'answer']);
    // A finished 猜拳 match (its own chat event with topic rps) counts as a game.
    service.mood.event({ type: 'chat', id: 'rps-match', delta: { D: 2 }, context: 'positive', topic: 'rps', reason: '猜拳' }, id);
    assert.equal(service.budget.view(id)!.recent[0].kind, 'game');
  } finally { await service.flush().catch(() => {}); service.herNeeds.dispose(); await rm(directory, { recursive: true, force: true }); }
  // What one accepted event counts as.
  assert.equal(budgetCreditKind({ type: 'chat', topic: null, answered: true }), 'answer');
  assert.equal(budgetCreditKind({ type: 'chat', topic: null, answered: false }), 'message');
  assert.equal(budgetCreditKind({ type: 'chat', topic: 'rps', answered: true }), 'game');
  assert.equal(budgetCreditKind({ type: 'rua', topic: null, answered: false }), 'touch');
  assert.equal(budgetCreditKind({ type: 'food', topic: null, answered: false }), 'food');
});

// ---------------------------------------------------------------- 主动开口 (opening choice)

const REST = getMoodSnapshot(createMoodState(1_000), 1_000);
const VIEW = { characterId: 'gene', snapshot: REST, parameters: DEFAULT_MOOD_PARAMETERS } as Pick<MoodView, 'characterId' | 'snapshot' | 'parameters'>;
let cueSerial = 0;
const speech = (): MoodCue => ({ id: `cue-${++cueSerial}`, kind: 'speech', at: 10_000, until: 13_000 } as MoodCue);
function loop(): OpeningLoop & { offers: string[] } {
  const value = { offers: [] as string[],
    offerOpportunity: (cue: unknown, focus?: string) => { value.offers.push(`${(cue as MoodCue).id}:${focus ?? '-'}`); return true; },
    canTake: () => true, claims: () => false, asleep: () => false, silence: () => true, restReminderDue: () => false,
    quietNow: () => ({ asleep: false, drowsy: false, night: false, quiet: false }) };
  return value;
}

test('主动开口: no room → she stays quiet and the quota comes back; room → exactly as without a budget, and the one who speaks spends', () => {
  const clock = { now: T0 };
  const budget = new InteractionBudgetHost({ clock: () => clock.now });
  const refunds: string[] = [];
  const make = (withBudget: boolean, random = () => 0.5) => {
    const l = loop();
    const opening = new OpeningHost({ loop: l, chooser: new FixedOpeningChoice(['mood', 'quiet']), innerOn: () => true, developerMode: () => true, clock: () => clock.now,
      releaseSpeech: cue => { refunds.push(cue.id); budget.refund('gene', cue.id); }, random, ...(withBudget ? { budget: openingBudget(() => budget) } : {}) });
    return { l, opening };
  };
  // The floor covers one line: she speaks, as before, and it is paid.
  const a = make(true), first = speech();
  assert.equal(a.opening.claim(first, {}, VIEW), 'inner');
  assert.equal(budget.view('gene')!.recent[0].kind, 'speak');
  assert.equal(budget.view('gene')!.balance, 0);
  // Nothing left: quiet, quota returned, nothing offered to the inner loop.
  const second = speech();
  assert.equal(a.opening.claim(second, {}, VIEW), 'quiet');
  assert.ok(refunds.includes(second.id));
  assert.deepEqual(a.l.offers, [`${first.id}:mood`]);
  assert.ok(a.opening.recent('gene')[0].why.some(line => line.startsWith('互动余额')), a.opening.recent('gene')[0].why.join('；'));
  // The user writes: room again.
  budget.credit('gene', 'message', 'hello');
  assert.equal(a.opening.claim(speech(), {}, VIEW), 'inner');
  // The inner loop gave the cue back unspoken: the spend comes back too (once).
  const spentBefore = budget.view('gene')!.balance;
  const third = speech();
  budget.credit('gene', 'answer', 'reply');
  const c = make(true);
  assert.equal(c.opening.claim(third, {}, VIEW), 'inner');
  const paid = budget.view('gene')!.balance;
  budget.refund('gene', third.id); budget.refund('gene', third.id);
  assert.ok(Math.abs(budget.view('gene')!.balance - (paid + 1)) < 0.02, `${spentBefore} → ${paid} → ${budget.view('gene')!.balance}`);
  // Without a budget: exactly the old behaviour (never a roll, never quiet for lack of room).
  const old = make(false, () => { throw new Error('no roll without a budget'); });
  for (let i = 0; i < 5; i++) assert.equal(old.opening.claim(speech(), {}, VIEW), 'inner');
});

test('主动开口: with full room the same cues get the same owners as without a budget (the roll never shifts her pick)', () => {
  const owners = (withBudget: boolean) => {
    const budget = new OpenBudget(), l = loop(), seen: string[] = [];
    const opening = new OpeningHost({ loop: l, chooser: new FixedOpeningChoice(['play', 'mood', 'quiet']), innerOn: () => true, developerMode: () => false, clock: () => T0,
      releaseSpeech: () => {}, play: () => true, ...(withBudget ? { budget: { room: () => ({ factor: 1, words: '' }), spend: () => { budget.calls.spend++; }, refund: () => {} } } : {}) });
    for (let i = 0; i < 6; i++) seen.push(String(opening.claim(speech(), {}, VIEW)));
    return { seen, offers: l.offers.map(entry => entry.split(':')[1]), spends: budget.calls.spend };
  };
  const before = owners(false), after = owners(true);
  assert.deepEqual(after.seen, before.seen); assert.deepEqual(after.offers, before.offers);
  assert.equal(after.spends, 6, 'each speaking pick spends once');
});

// ---------------------------------------------------------------- 她也会需要你

test('小情绪: the room replaces "needs today" (not the interaction spacing); a real start spends, the test command never does', async () => {
  const state = { ...createHerNeedState('2026-11-05'), used: ['lonely', 'chatty', 'lonely'] as ('lonely' | 'chatty')[] };
  const input = (balance: number | null) => herNeedLimitInput(state, { now: T0, startedAt: T0 - 2 * HOUR, night: false, balance });
  const old = herNeedLimits(input(null), 'lonely'), roomy = herNeedLimits(input(1), 'lonely'), none = herNeedLimits(input(0), 'lonely');
  assert.ok(old.soft < 0.01, `three today: the old curve shuts it (${old.soft})`);
  assert.ok(roomy.soft > old.soft * 10, `with room the day's count no longer matters (${roomy.soft})`);
  assert.equal(none.soft, 0, 'no room, no start');
  // The host spends on a real start only.
  const clock = { now: T0 }, spent: string[] = [];
  const needs = new HerNeedsHost({ file: () => null, diagnosticsFile: () => null, developerMode: () => false, changed: () => {}, lift: () => {}, clock: () => clock.now,
    random: () => 0, trigger: () => ({ lonely: 1 }), balance: () => 1, spent: (_id, need) => { spent.push(need); } });
  await needs.load();
  const tick = () => needs.tick('gene', { now: clock.now, day: '2026-11-05', expressions: true, canExpress: true, phase: 'idle', lastInteractionAt: null, fatigue: 'awake',
    boredom: 90, mood: 'calm', channels: { D: 50, O: 50, E: 50, N: 50, C: 50 }, parameters: DEFAULT_MOOD_PARAMETERS, localMinute: 14 * 60 });
  clock.now += 20 * MINUTE; tick(); clock.now += 1_000; tick(); clock.now += 1_000; tick();
  assert.equal(needs.view('gene')?.id, 'lonely');
  assert.deepEqual(spent, ['lonely']);
  needs.startNow('gene', 'chatty');
  assert.deepEqual(spent, ['lonely'], 'the developer test command is free');
  needs.dispose();
});

// ---------------------------------------------------------------- 猜拳

const inviteBase: RpsInviteInput = { now: T0, today: '2026-11-05', playfulness: 1, quiet: false, herLife: null, gameActive: false, invites: [], lastGameAt: null };
test('猜拳邀请: counted in interactions since the last invitation and game (by character), never "2 a day"; without a budget the old rules', () => {
  const recent = [{ at: T0 - 10 * MINUTE, date: '2026-11-05' }];
  assert.equal(rpsInviteVerdict({ ...inviteBase, invites: recent }), 'gap', 'old: 2 hours apart');
  assert.equal(rpsInviteVerdict({ ...inviteBase, invites: recent, interactions: { sinceInvite: 1, sinceGame: null, needed: 3 } }), 'gap');
  assert.equal(rpsInviteVerdict({ ...inviteBase, invites: recent, interactions: { sinceInvite: 3, sinceGame: null, needed: 3 } }), 'ok', '3 interactions later, 10 minutes is enough');
  assert.equal(rpsInviteVerdict({ ...inviteBase, lastGameAt: T0 - 5 * MINUTE, interactions: { sinceInvite: null, sinceGame: 0, needed: 3 } }), 'after-game');
  const two = [{ at: T0 - 5 * HOUR, date: '2026-11-05' }, { at: T0 - 3 * HOUR, date: '2026-11-05' }];
  assert.equal(rpsInviteVerdict({ ...inviteBase, invites: two }), 'day', 'old: 2 a day');
  assert.equal(rpsInviteVerdict({ ...inviteBase, invites: two, interactions: { sinceInvite: 8, sinceGame: null, needed: 3 } }), 'ok', 'a lively day has no daily cap');
  // Her mood and the quiet rules still come first.
  assert.equal(rpsInviteVerdict({ ...inviteBase, quiet: true, interactions: { sinceInvite: 9, sinceGame: 9, needed: 1 } }), 'quiet');
  assert.equal(rpsInviteVerdict({ ...inviteBase, playfulness: 0.5, interactions: { sinceInvite: 9, sinceGame: 9, needed: 1 } }), 'mood');
});

test('猜拳 host: her invitations wait for your interactions (not hours, not 2 a day), and a line she says in a game spends', async () => {
  const clock = { now: T0 }, timers: { at: number; run: () => void; id: number }[] = [];
  let serial = 0;
  const api = { set: (run: () => void, ms: number) => { const id = ++serial; timers.push({ at: clock.now + ms, run, id }); return id; },
    clear: (id: unknown) => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); } };
  const advance = (ms: number) => { const end = clock.now + ms; for (;;) { timers.sort((a, b) => a.at - b.at); const due = timers[0];
    if (!due || due.at > end) break; timers.shift(); clock.now = due.at; due.run(); } clock.now = end; };
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-budget-rps-'));
  const store = new RpsStore({ file: () => path.join(directory, 'rps.json'), now: () => clock.now }); await store.load();
  const budget = new InteractionBudgetHost({ clock: () => clock.now });
  const views: (RpsView | null)[] = [];
  const host = new RpsHost({ store, character: () => ({ id: 'gene', persona: '角色：基恩', parameters: DEFAULT_MOOD_PARAMETERS,
      snapshot: { primary: 'happy', values: { D: 70, O: 50, E: 55, N: 50, C: 40 } }, fatigue: null, herLife: 'company' }),
    visible: () => true, recording: () => false, localDate: () => '2026-11-05', publish: view => { views.push(view); }, mood: () => {}, chatBusy: () => false,
    quick: async () => '{"text":"嘿嘿，这局算我的"}', available: () => true, clock: () => clock.now, random: () => 0.3, voiceRandom: () => 0, timers: api,
    nonce: () => `n${++serial}`, createId: () => `id${++serial}`, budget: () => budget });
  try {
    assert.equal(host.inviteEligible('gene', false), true);
    host.invited('gene');
    advance(RPS_TIMING.inviteMs + 10); // ignored: it goes away
    advance(5 * HOUR);
    assert.equal(host.inviteEligible('gene', false), false, 'five hours and no interaction since her last invitation: not again (the old rule would have let her)');
    for (const id of ['a', 'b', 'c', 'd']) budget.credit('gene', 'message', id);
    assert.equal(host.inviteEligible('gene', false), true, 'a few interactions later she may');
    host.invited('gene'); advance(RPS_TIMING.inviteMs + 10);
    for (const id of ['e', 'f', 'g', 'h']) budget.credit('gene', 'message', id);
    assert.equal(host.inviteEligible('gene', false), true, 'a third invitation the same day is fine on a lively day');
    // "下次吧" answers her invitation: counted once (a click, not a mood event).
    host.invited('gene');
    const invite = views.at(-1)!;
    assert.equal(host.respond({ id: invite.id, action: 'decline' }), true);
    assert.equal(host.respond({ id: invite.id, action: 'decline' }), false);
    assert.deepEqual(budget.view('gene')!.recent.filter(entry => entry.kind === 'answer').map(entry => entry.delta), [K.gains.answer]);
    advance(RPS_TIMING.endMs + 5_000);
    // A game she says a line in: it spends from the budget once.
    host.testStart();
    for (let guard = 0; guard < 400 && host.active; guard++) {
      for (let i = 0; i < 20; i++) await Promise.resolve();
      const view = views.at(-1);
      if (view?.say) { host.respond({ id: view.say.id, action: 'said' }); host.respond({ id: view.say.id, action: 'said' }); continue; }
      if (view?.accepting && view.userHand === null) { advance(200); host.throwHand({ gameId: view.id, round: view.round, hand: 'rock', source: 'click' }); continue; }
      advance(250);
    }
    const lines = budget.view('gene')!.recent.filter(entry => entry.kind === 'gameLine');
    assert.ok(host.stats.linesSaid >= 1, 'she said something');
    assert.equal(lines.length, host.stats.linesSaid, 'each line said spends once (a repeated "said" does not)');
  } finally { host.dispose(); await store.flush(); await rm(directory, { recursive: true, force: true }); }
});

const voiceBase = (extra: Partial<RpsVoiceInput> = {}): RpsVoiceInput => ({
  moment: { kind: 'round', earlier: [], score: { her: 1, user: 0 }, round: { her: 'rock', user: 'scissors', outcome: 'her', intent: 'fair', reaction: 'win-round', tease: null } },
  parameters: { weights: DEFAULT_MOOD_PARAMETERS.weights, intensity: DEFAULT_MOOD_PARAMETERS.intensity }, mood: 'calm', fatigue: 'awake',
  saidThisMatch: 0, spokeLastRound: false, saidToday: 0, ...extra });
test('猜拳里说一句: the room replaces "lines today"; the in-match press stays; without a room the old press', () => {
  assert.equal(rpsVoiceChance(voiceBase({ saidToday: 90 })), rpsVoiceChance(voiceBase({ saidToday: 90, room: null })));
  assert.ok(rpsVoiceChance(voiceBase({ saidToday: 90, room: 1 })) > rpsVoiceChance(voiceBase({ saidToday: 90 })), 'a lively day: lines today no longer matter');
  assert.equal(rpsVoiceChance(voiceBase({ room: 0 })), 0, 'no room: an ordinary moment stays quiet');
  assert.ok(rpsVoiceChance(voiceBase({ room: 1, saidThisMatch: 2 })) < rpsVoiceChance(voiceBase({ room: 1 })), 'still fewer the more she said in this match');
});

// ---------------------------------------------------------------- 一起听

test('一起听: with the budget wired the 3-hour count no longer presses (the opening choice does); without, as before', () => {
  const at = (budgeted: boolean, spoken: number) => [0.05, 0.2, 0.35, 0.45].filter(random => listenWillSpeak({ mention: true, mood: 'calm', spokenRecently: spoken, random, budgeted })).length;
  assert.equal(at(false, 0), at(true, 0), 'nothing said yet: the same');
  assert.ok(at(true, 3) > at(false, 3), 'said three times: only the old rule presses');
  assert.equal(listenWillSpeak({ mention: false, mood: 'happy', spokenRecently: 0, random: 0, budgeted: true }), false, 'nothing worth mentioning is still nothing');
});

// ---------------------------------------------------------------- 停停说说 (F7)

type PauseBudget = Pick<InteractionBudget, 'room' | 'spend' | 'refund'>;
function pauseHost(options: { budget: PauseBudget | null; random?: () => number; answer?: string }) {
  let now = T0;
  const timers: { at: number; run: () => void; done: boolean }[] = [];
  const t: PauseTalkTimers = { set: (callback, ms) => { const timer = { at: now + ms, run: callback, done: false }; timers.push(timer); return timer; },
    clear: handle => { (handle as { done: boolean }).done = true; } };
  const sent: unknown[] = [], asked: string[] = [];
  const her: PauseTalkNow = { characterId: 'gene', persona: 'Gene', personality: { playful: 1, close: 1, comfortable: 1, cautious: 1 }, label: '平静',
    values: { D: 50, O: 50, E: 50, N: 50, C: 50 }, fatigue: '清醒', shy: false, at: T0 };
  const host = new PauseTalkHost({ ask: async prompt => { asked.push(prompt); return options.answer ?? '{"pauses":[{"after":1,"ms":800}],"wait":{"after":"question","ms":8000}}'; },
    enabled: () => true, available: () => true, now: () => her, send: cue => { sent.push(cue); }, developerMode: () => true, clock: () => now, timers: t,
    ...(options.budget ? { budget: () => options.budget } : {}), ...(options.random ? { random: options.random } : {}) });
  const run = async (ms: number) => {
    now += ms;
    for (const timer of timers.filter(item => !item.done && item.at <= now)) { timer.done = true; timer.run(); }
    for (let i = 0; i < 10; i++) await new Promise<void>(resolve => setImmediate(resolve));
  };
  return { host, sent, asked, run };
}

test('停停说说: a quiet card asks haiku less often; asking spends; a wait is kept only with room to go on alone (given back if you cut in)', async () => {
  // Without a budget: every message asks, the plan's wait is sent as haiku gave it (the F7 tests cover the rest).
  const plain = pauseHost({ budget: null });
  plain.host.userTurn('r1', '你好呀', null, 'gene'); await plain.run(400);
  assert.equal(plain.asked.length, 1); assert.ok((plain.sent[0] as { wait: unknown }).wait);
  // A budget with no room for either: no haiku (her usual pace), the developer line says why.
  const closed: PauseBudget = { room: () => ({ factor: 0, balance: 0, cost: 1, strong: false, words: '' }), spend: () => true, refund: () => true };
  const none = pauseHost({ budget: closed, random: () => 0.5 });
  none.host.userTurn('r2', '你好呀', null, 'gene'); await none.run(400);
  assert.equal(none.asked.length, 0);
  assert.equal(none.host.view()!.why[0].skipped, 'budget');
  assert.match(formatPauseTalkLines(none.host.view()!), /互动余额这次没给余地/u);
  // Room to ask but not to go on alone: the plan is sent without its wait (her pauses stay), and the panel says so.
  const clock = { now: T0 };
  const real = new InteractionBudgetHost({ clock: () => clock.now });
  real.spend('gene', 'speak', 'drain'); // the floor is gone
  real.credit('gene', 'message', 'only-one'); // 1 earned: covers the ask (0.2), then only 0.8 left for "go on" (0.5): factor < 1
  const fixedRoll = pauseHost({ budget: { room: (id, kind) => kind === 'continue' ? { factor: 0, balance: 0, cost: 0.5, strong: false, words: '' } : real.room(id, kind),
    spend: (id, kind, key) => real.spend(id, kind, key), refund: (id, key) => real.refund(id, key) }, random: () => 0.5 });
  fixedRoll.host.userTurn('r3', '你好呀', null, 'gene'); await fixedRoll.run(400);
  assert.equal(fixedRoll.asked.length, 1);
  const cue = fixedRoll.sent[0] as { wait: unknown; pauses: unknown[] };
  assert.equal(cue.wait, null); assert.equal(cue.pauses.length, 1);
  assert.equal(fixedRoll.host.view()!.why[0].waitDropped, true);
  assert.equal(real.view('gene')!.recent[0].kind, 'pausePlan', 'asking spent');
  // With room: the wait is kept and paid; the user cutting into that reply gives it back, once.
  const budget = new InteractionBudgetHost({ clock: () => clock.now });
  budget.credit('gene', 'message', 'm1'); budget.credit('gene', 'message', 'm2');
  const kept = pauseHost({ budget, random: () => 0.1 });
  kept.host.userTurn('r4', '你好呀', null, 'gene'); await kept.run(400);
  assert.ok((kept.sent[0] as { wait: unknown }).wait);
  const paid = budget.view('gene')!.balance;
  assert.equal(budget.view('gene')!.recent[0].kind, 'continue');
  kept.host.delta('r4', '第一句。你呢？第三句。');
  kept.host.userTurn('r5', '我在', { id: 'r4', shown: 5 }, 'gene');
  assert.ok(Math.abs(budget.view('gene')!.balance - (paid + K.costs.continue)) < 0.02, 'cut in during the wait: given back');
  kept.host.userTurn('r6', '还在', { id: 'r4', shown: 5 }, 'gene');
  assert.equal(budget.view('gene')!.recent.filter(entry => entry.kind === 'continue' && entry.refunded).length, 1, 'once');
  for (const h of [plain, none, fixedRoll, kept]) h.host.dispose();
});

// ---------------------------------------------------------------- developer panel

test('developer panel: the balance, the character multiplier, the night and the last few changes; numbers and kinds only', () => {
  assert.equal(formatBudgetLines(undefined), '互动余额：暂无');
  const clock = { now: T0 };
  const budget = new InteractionBudgetHost({ clock: () => clock.now });
  budget.observe('gene', { weights: { close: 1.6, playful: 1.6, cautious: 0.7 }, night: false });
  budget.credit('gene', 'message', 'secret text never here');
  budget.spend('gene', 'invite', 'cue-1'); budget.refund('gene', 'cue-1');
  const text = formatBudgetLines(budget.view('gene')!);
  assert.match(text, /^互动余额：\d+\.\d（攒下 \d+\.\d \+ 保底 \d+\.\d）· 性格 × 0\.\d · 最近一小时互动 1 次\n最近：/u);
  assert.match(text, /她邀请玩猜拳 −\d\.\d（退回） · .*你发消息 \+1\.0/u);
  assert.doesNotMatch(text, /secret/u);
  budget.observe('gene', { weights: {}, night: true });
  assert.match(formatBudgetLines(budget.view('gene')!), /深夜花费加倍/u);
});
