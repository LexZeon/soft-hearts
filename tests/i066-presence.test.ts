/**
 * I-066 你现在方便吗 (plan docs/claude/2026-11-10-proactive-presence-plan.md, record docs/claude/2026-11-10-i066-presence.md).
 * Fake clock, fake idle seconds and lock events, a fake haiku and synthetic frames; never real Claude, never a real screenshot,
 * never a profile. The chain under test is the app's own: electron/senses/user-activity.ts (the judgment and the screen look) →
 * electron/brain/opening-host.ts (hold, bring up, greet) → the real InnerLoop and ProactiveSpeechGate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PresenceJudge, greetChance, backSentence } from '../shared/behaviors/user-activity/presence';
import { HeldIntents } from '../shared/behaviors/user-activity/held';
import { parseScreenLook } from '../shared/behaviors/user-activity/screen-look';
import { USER_ACTIVITY_KNOBS } from '../shared/behaviors/user-activity/knobs';
import type { PresenceContext, UserActivitySample } from '../shared/behaviors/user-activity/interface';
import { createUserActivity, type PowerEventName } from '../electron/senses/user-activity';
import { OpeningHost, type OpeningClaimants } from '../electron/brain/opening-host';
import { claimedView } from '../electron/initiative/inner-loop/claim';
import { InnerLoop, type InnerLoopDependencies } from '../electron/initiative/inner-loop/inner-loop';
import { ProactiveSpeechGate } from '../electron/initiative/proactive-speech-gate';
import { OpeningChoiceDirector } from '../shared/behaviors/opening-choice/choose';
import { FixedOpeningChoice } from '../shared/behaviors/opening-choice/fake';
import { DEFAULT_MOOD_PARAMETERS, applyMoodEvent, createMoodState, getMoodSnapshot, type MoodCue } from '../shared/foundation/mood';
import type { MoodView } from '../shared/mood/mood-runtime';
import type { InnerLoopQuiet } from '../shared/initiative/inner-loop';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import type { SpeechCueOutcome, SpeechCueReason } from '../shared/voice/speech-cue';

const SECOND = 1_000, MINUTE = 60_000, HOUR = 60 * MINUTE;
const T0 = Date.UTC(2026, 10, 10, 2, 0, 0); // 10:00 in China: daytime
const rng = (seed: number) => { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; };
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
const AWAKE: InnerLoopQuiet = { asleep: false, drowsy: false, night: false, quiet: false };
const REST = getMoodSnapshot(createMoodState(1_000), 1_000);
const VIEW = { characterId: 'gene', snapshot: REST, parameters: DEFAULT_MOOD_PARAMETERS } as Pick<MoodView, 'characterId' | 'snapshot' | 'parameters'>;
const sample = (now: number, idleSeconds: number | null, extra: Partial<UserActivitySample> = {}): UserActivitySample =>
  ({ now, idleSeconds, locked: false, asleep: false, windowFocused: false, ...extra });
const ctx = (extra: Partial<PresenceContext> = {}): PresenceContext => ({ switchOn: true, lastInteractionAt: null, activity: null, ...extra });

// ---------------------------------------------------------------- the judgment (pure)

test('the judgment: recent input → yes; busy → gently, never no; locked → away/no; ≥ 5 min still → away/no', () => {
  const j = new PresenceJudge();
  j.tick(sample(T0, 3));
  assert.deepEqual(j.judge(T0, ctx()), { presence: 'idle', interrupt: 'yes', source: 'input' });
  assert.deepEqual(j.judge(T0, ctx({ activity: { state: 'busy' } })), { presence: 'busy', interrupt: 'gently', source: 'input' });
  j.tick(sample(T0 + SECOND, 200));
  assert.equal(j.judge(T0 + SECOND, ctx()).interrupt, 'yes', 'between 2 and 5 minutes without sharing: still there');
  j.tick(sample(T0 + 2 * SECOND, 5 * 60));
  assert.deepEqual(j.judge(T0 + 2 * SECOND, ctx()), { presence: 'away', interrupt: 'no', source: 'input', why: 'idle-long' });
  j.tick(sample(T0 + 3 * SECOND, 10, { locked: true }));
  assert.deepEqual(j.judge(T0 + 3 * SECOND, ctx()), { presence: 'away', interrupt: 'no', source: 'input', why: 'locked' });
  j.tick(sample(T0 + 4 * SECOND, 10, { asleep: true }));
  assert.equal(j.judge(T0 + 4 * SECOND, ctx()).presence, 'away');
  // A stale reading is no reading: only her recent interactions count then.
  assert.deepEqual(j.judge(T0 + 4 * SECOND + 10 * SECOND, ctx()), { presence: 'unknown', interrupt: 'no', source: 'input', why: 'not-known' });
});

test('back: input after an absence is "刚回来" for 2 minutes, with how long the user was away', () => {
  const j = new PresenceJudge();
  j.tick(sample(T0, 0));
  j.tick(sample(T0 + 40 * MINUTE, 40 * 60, { locked: true }));
  assert.equal(j.judge(T0 + 40 * MINUTE, ctx()).presence, 'away');
  j.tick(sample(T0 + 40 * MINUTE + SECOND, 0));
  const back = j.judge(T0 + 40 * MINUTE + SECOND, ctx({ activity: { state: 'busy' } }));
  assert.deepEqual(back, { presence: 'back', interrupt: 'yes', source: 'input', awayMinutes: 40 }, 'back beats busy: the best moment');
  assert.match(backSentence(back), /约 40 分钟，刚回来/);
  j.tick(sample(T0 + 42 * MINUTE + 2 * SECOND, 1));
  assert.equal(j.judge(T0 + 42 * MINUTE + 2 * SECOND, ctx()).presence, 'idle', 'over after 2 minutes');
  // A short absence (unlock after 1 minute) is a return too, but no greeting sentence.
  j.tick(sample(T0 + 50 * MINUTE, 0, { locked: true })); j.tick(sample(T0 + 51 * MINUTE, 0));
  const short = j.judge(T0 + 51 * MINUTE, ctx());
  assert.equal(short.presence, 'back'); assert.equal(backSentence(short), '');
});

test('switch off: only "the user interacted with her in the last 10 minutes" counts as present', () => {
  const j = new PresenceJudge();
  j.tick(sample(T0, 0)); // even with a reading, the switch decides
  assert.equal(j.judge(T0, ctx({ switchOn: false })).interrupt, 'no');
  assert.equal(j.judge(T0, ctx({ switchOn: false, lastInteractionAt: T0 - 9 * MINUTE })).interrupt, 'yes');
  assert.equal(j.judge(T0, ctx({ switchOn: false, lastInteractionAt: T0 - 11 * MINUTE })).interrupt, 'no');
});

test('the screen look: only with sharing on and unsure; meeting → no (even with input); desktop → away; unknown → hold; the rest → present', () => {
  for (const [verdict, expected] of [['meeting', { presence: 'meeting', interrupt: 'no' }], ['desktop', { presence: 'away', interrupt: 'no' }],
    ['unknown', { presence: 'unknown', interrupt: 'no' }], ['watching', { presence: 'idle', interrupt: 'yes' }], ['gaming', { presence: 'idle', interrupt: 'yes' }],
    ['working', { presence: 'idle', interrupt: 'yes' }], ['browsing', { presence: 'idle', interrupt: 'yes' }]] as const) {
    const j = new PresenceJudge();
    j.tick(sample(T0, 8 * 60));
    assert.equal(j.judge(T0, ctx()).presence, 'away', 'sharing off: no look, the input alone');
    assert.equal(j.beginLook(T0, ctx()), null, 'sharing off: never a look');
    const wants = j.judge(T0, ctx({ screenOn: true }));
    assert.equal(wants.interrupt, 'no'); assert.equal(wants.lookWanted, true);
    const token = j.beginLook(T0, ctx({ screenOn: true }));
    assert.ok(token !== null);
    assert.equal(j.judge(T0 + SECOND, ctx({ screenOn: true })).why, 'looking', 'in flight: held, no second look');
    assert.equal(j.beginLook(T0 + SECOND, ctx({ screenOn: true })), null);
    j.endLook(token!, verdict, T0 + 2 * SECOND);
    const after = j.judge(T0 + 2 * SECOND, ctx({ screenOn: true }));
    assert.deepEqual({ presence: after.presence, interrupt: after.interrupt }, expected, verdict);
    assert.equal(after.source, 'screen');
    if (verdict === 'meeting') {
      j.tick(sample(T0 + 3 * SECOND, 0));
      assert.equal(j.judge(T0 + 3 * SECOND, ctx({ screenOn: true })).presence, 'meeting', 'typing notes in a meeting is still a meeting');
    }
  }
});

test('the look limits: one verdict holds 3 minutes; at most 6 looks an hour; a failure waits as long as a verdict', () => {
  const j = new PresenceJudge(), on = ctx({ screenOn: true });
  let now = T0, looks = 0;
  for (let i = 0; i < 20; i++) {
    j.tick(sample(now, 3 * 60));
    const token = j.beginLook(now, on);
    if (token !== null) { looks++; j.endLook(token, i % 2 ? 'unknown' : null, now + SECOND); }
    assert.equal(j.beginLook(now + 2 * MINUTE, on), null, 'cached or failed a moment ago: no new look');
    now += 3 * MINUTE + 2 * SECOND;
  }
  assert.ok(looks <= 7 && looks >= 6, `20 tries over an hour: ${looks}`);
  assert.ok(j.looksInLastHour(now) <= USER_ACTIVITY_KNOBS.presence.look.perHour);
  // Strictly within one hour: never more than 6.
  const k = new PresenceJudge(); let t = T0, inHour = 0;
  while (t < T0 + HOUR) { k.tick(sample(t, 200)); const tok = k.beginLook(t, on); if (tok !== null) { inHour++; k.endLook(tok, 'unknown', t); } t += 3 * MINUTE + SECOND; }
  assert.equal(inHour, 6);
});

test('the local camera: somebody in front with sharing off → present; with sharing on the look still runs (a call has a person in it too)', () => {
  const j = new PresenceJudge();
  j.tick(sample(T0, 8 * 60), true);
  assert.deepEqual(j.judge(T0, ctx({ person: true })), { presence: 'idle', interrupt: 'yes', source: 'camera' });
  assert.equal(j.judge(T0, ctx({ person: true, screenOn: true })).lookWanted, true);
  assert.equal(j.judge(T0, ctx({ person: false })).presence, 'away');
});

test('a screen look answer is one closed word, never a guess', () => {
  assert.equal(parseScreenLook('开会'), 'meeting'); assert.equal(parseScreenLook(' 看视频。'), 'watching'); assert.equal(parseScreenLook('desktop'), 'desktop');
  for (const bad of ['', '开会和工作', '用户正在开一个很长的会议', null, 42, '会议']) assert.equal(parseScreenLook(bad), null, String(bad));
});

test('held intents: one only, the more important or the newer; gone after 2 hours', () => {
  const held = new HeldIntents();
  const intent = (kind: 'keepsake' | 'need' | 'talk', id: string, since: number) => ({ kind, characterId: 'gene', cue: { id, at: since }, since });
  assert.equal(held.hold(intent('talk', 'a', T0), T0), null);
  assert.equal(held.hold(intent('talk', 'b', T0 + 1), T0 + 1)?.cue.id, 'a', 'newer of the same weight replaces');
  assert.equal(held.hold(intent('keepsake', 'c', T0 + 2), T0 + 2)?.cue.id, 'b');
  assert.equal(held.hold(intent('talk', 'd', T0 + 3), T0 + 3)?.cue.id, 'd', 'a less important one is refused');
  assert.equal(held.peek(T0 + 119 * MINUTE)?.cue.id, 'c');
  assert.equal(held.peek(T0 + 2 * HOUR + 3), null);
  assert.equal(held.expired(T0 + 2 * HOUR + 3)?.cue.id, 'c');
  assert.equal(held.expired(T0 + 2 * HOUR + 4), null, 'expired only once');
});

test('the greeting chance: only after ≥ 30 minutes away; clingy cards more often', () => {
  const plain = { playful: 1, close: 1, comfortable: 1, cautious: 1 };
  assert.equal(greetChance({ presence: 'back', awayMinutes: 20 }, plain), 0);
  assert.equal(greetChance({ presence: 'idle' }, plain), 0);
  const base = greetChance({ presence: 'back', awayMinutes: 45 }, plain), clingy = greetChance({ presence: 'back', awayMinutes: 45 }, { ...plain, close: 1.8 });
  const shy = greetChance({ presence: 'back', awayMinutes: 45 }, { ...plain, cautious: 1.8 });
  assert.ok(base > 0 && base < 1 && clingy > base && shy < base, `${shy} < ${base} < ${clingy}`);
});

// ---------------------------------------------------------------- the host: the judgment, the screen look and its consent

function harness(options: { sharing?: boolean; ask?: (picture: string) => Promise<string>; switchOn?: boolean } = {}) {
  const clock = { now: T0 };
  const fake = { idle: 0 as number | null, sharing: options.sharing === true, captures: 0, asks: 0, pictures: [] as string[], looked: [] as string[], lastInteractionAt: null as number | null };
  const listeners = new Map<PowerEventName, () => void>();
  const ua = createUserActivity({ directory: () => null, idleSeconds: () => { if (fake.idle === null) throw new Error('unreadable'); return fake.idle; }, windowFocused: () => false,
    power: { on: (event, listener) => { listeners.set(event, listener); } }, clock: () => clock.now, lastInteractionAt: () => fake.lastInteractionAt,
    screen: { on: () => fake.sharing, capture: async () => { fake.captures++; return `data:image/jpeg;base64,${Buffer.from('synthetic').toString('base64')}`; },
      ask: async picture => { fake.asks++; fake.pictures.push(picture); return options.ask ? options.ask(picture) : '看视频'; } },
    looked: verdict => { fake.looked.push(verdict); } });
  if (options.switchOn === false) ua.setEnabled(false);
  const power = (event: PowerEventName) => listeners.get(event)?.();
  return { clock, fake, ua, power, tick: () => ua.tick(clock.now) };
}

test('host: screen sharing off → no screen look ever, whatever the judgment wanted', async () => {
  const h = harness({ sharing: false });
  for (let i = 0; i < 30; i++) { h.fake.idle = 6 * 60 + i; h.tick(); assert.equal(h.ua.askLook(), false); h.clock.now += 5 * MINUTE; }
  await flush();
  assert.equal(h.fake.captures, 0); assert.equal(h.fake.asks, 0);
});

test('host: one look (synthetic frame, fake haiku) lands as a cached verdict; only the category is journaled', async () => {
  const h = harness({ sharing: true, ask: async () => '开会' });
  h.fake.idle = 3 * 60; h.tick();
  assert.equal(h.ua.presence().lookWanted, true);
  assert.equal(h.ua.askLook(), true);
  assert.equal(h.ua.askLook(), false, 'one at a time');
  await flush();
  assert.equal(h.fake.captures, 1); assert.equal(h.fake.asks, 1);
  assert.deepEqual(h.fake.looked, ['meeting']);
  assert.equal(h.ua.presence().presence, 'meeting');
  assert.equal(h.ua.lookView().verdict, 'meeting');
  h.fake.sharing = false; // nothing tells the host: the next judgment drops the verdict itself
  assert.notEqual(h.ua.presence().presence, 'meeting', 'sharing off: the verdict goes with it');
});

test('host: a look that never answers is dropped on the second tick after 20 s (counted as failed), with no timer of its own', async () => {
  const h = harness({ sharing: true, ask: () => new Promise<string>(() => {}) });
  h.fake.idle = 3 * 60; h.tick();
  assert.equal(h.ua.askLook(), true); await flush();
  h.clock.now += 19 * SECOND; h.tick();
  assert.equal(h.ua.lookView().inFlight, true);
  h.clock.now += 2 * SECOND; h.tick();
  assert.equal(h.ua.lookView().inFlight, false); assert.deepEqual(h.fake.looked, ['failed']);
  assert.equal(h.ua.askLook(), false, 'a failure waits like a verdict before the next look');
  h.clock.now += 3 * MINUTE + SECOND; h.tick();
  assert.equal(h.ua.askLook(), true);
});

test('host: the switch off reads nothing and only her recent interactions count', () => {
  const h = harness({ switchOn: false });
  let reads = 0; h.fake.idle = 0;
  const ua = createUserActivity({ directory: () => null, idleSeconds: () => { reads++; return 0; }, windowFocused: () => false, clock: () => h.clock.now,
    lastInteractionAt: () => h.fake.lastInteractionAt });
  ua.setEnabled(false);
  ua.tick(h.clock.now);
  assert.equal(reads, 0);
  assert.equal(ua.presence().interrupt, 'no');
  h.fake.lastInteractionAt = h.clock.now - 2 * MINUTE;
  assert.equal(ua.presence().interrupt, 'yes');
});

// ---------------------------------------------------------------- the opening host with the real inner loop and gate

interface Journal { characterId: string; outcome: SpeechCueOutcome; why: SpeechCueReason }

function app(options: { sharing?: boolean; ask?: () => Promise<string>; chooser?: ConstructorParameters<typeof OpeningHost>[0]['chooser']; random?: () => number;
  keepsake?: 'tell' | 'write' | null; need?: boolean; welcome?: boolean; close?: number } = {}) {
  const h = harness({ sharing: options.sharing, ask: options.ask });
  const count = { model: 0, offers: 0, refunds: [] as string[], cues: [] as string[], memorial: 0, r20: 0, vision: 0, ambient: 0, writes: 0, invited: 0, welcomes: 0 };
  const journal: Journal[] = [];
  const gate = new ProactiveSpeechGate(() => h.clock.now); gate.setScope('scope');
  const deps: InnerLoopDependencies = {
    gate, clock: () => h.clock.now, enabled: () => true, canStart: () => !gate.busy, current: () => true,
    scope: () => ({ characterId: 'gene', gateScope: 'scope' }), parameters: () => DEFAULT_MOOD_PARAMETERS, quiet: () => ({ ...AWAKE }),
    prompt: (claim, _allow, _quiet, _life, _play, focus) => { count.cues.push(`${claim.id}:${focus ?? '-'}`); return 'prompt'; },
    decide: async () => { count.model++; return { text: '{"action":"speak","text":"在呢"}' }; },
    keepsake: { line: () => '给你留了一样东西' },
    realize: () => {}, releaseSpeech: claim => { count.refunds.push(claim.id); }, offer: () => { count.offers++; },
    present: async () => true, presentationCurrent: () => true, archive: async () => {},
  };
  const loop = new InnerLoop(deps);
  const opening = new OpeningHost({ loop, chooser: options.chooser ?? new FixedOpeningChoice(['mood', 'quiet']), innerOn: () => true, developerMode: () => true,
    clock: () => h.clock.now, random: options.random ?? (() => 0),
    play: () => true, need: () => options.need === true,
    keepsake: { peek: () => options.keepsake ?? null, write: () => { count.writes++; return true; } },
    releaseSpeech: cue => { count.refunds.push(cue.id); },
    presence: { view: () => h.ua.presence(), look: () => h.ua.askLook(), characterId: () => 'gene',
      personality: () => ({ playful: 1, close: options.close ?? 1, comfortable: 1, cautious: 1 }),
      welcome: () => { count.welcomes++; return options.welcome !== false; } },
    journal: entry => { journal.push(entry); } });
  const claimants: OpeningClaimants = {
    memorial: () => { count.memorial++; return false; }, r20: () => { count.r20++; return false; },
    vision: () => { count.vision++; return false; }, ambient: () => { count.ambient++; return false; },
  };
  let serial = 0;
  const cue = (source = false): MoodCue => ({ id: `cue-${++serial}`, kind: 'speech', at: h.clock.now, until: h.clock.now + 3_000,
    ...(source ? { source: { kind: 'ambient', sessionId: 'listen1', observationId: `listen1:${serial}` } } : {}) } as MoodCue);
  /** One speech opportunity, the way electron/main.ts's mood publish hands it over. */
  const opportunity = async (source = false) => { const c = cue(source); const owner = opening.claim(c, claimants, VIEW); await flush(); return { owner, cue: c }; };
  /** The one-second beat: the reading, then the opening host. */
  const second = async () => { h.tick(); loop.sweep(); opening.tick(); await flush(); };
  const ack = async () => { /* the companion window acknowledges the shown line (so the gate frees up) */
    const message = (loop as unknown as { pending: { message: { id: string } | null } | null }).pending?.message; if (message) await loop.ack(message.id); };
  return { ...h, count, journal, opening, loop, opportunity, second, ack, dispose: () => { loop.dispose(); gate.dispose(); } };
}

test('away 30 minutes (locked): 3 speech cues → 0 spoken and 0 model calls; back → the held intent is brought up at the first chance', async () => {
  const a = app();
  a.fake.idle = 0; await a.second();
  a.power('lock-screen');
  for (let i = 0; i < 3; i++) {
    a.clock.now += 10 * MINUTE; a.fake.idle = (i + 1) * 600; await a.second();
    const { owner } = await a.opportunity();
    assert.equal(owner, 'held', `cue ${i}`);
  }
  assert.equal(a.count.model, 0, 'no model call while away'); assert.equal(a.count.offers, 0, 'nothing spoken');
  assert.equal(a.count.memorial + a.count.r20 + a.count.vision + a.count.writes, 0, 'nobody else was asked either');
  assert.deepEqual(a.count.refunds, ['cue-1', 'cue-2'], 'only one held: the older ones give their quota back');
  assert.deepEqual(a.journal.filter(j => j.outcome === 'held').map(j => j.why), ['away', 'away', 'away']);
  // Still locked: the one-second beat brings nothing up.
  for (let i = 0; i < 5; i++) { a.clock.now += SECOND; await a.second(); }
  assert.equal(a.count.model, 0);
  // Back: unlock and a key press.
  a.power('unlock-screen'); a.clock.now += SECOND; a.fake.idle = 0; await a.second();
  assert.equal(a.count.model, 1, 'brought up at once'); assert.equal(a.count.offers, 1);
  assert.deepEqual(a.count.cues, ['cue-3-h1:mood'], 'the held cue (its quota), as her own words');
  assert.ok(a.journal.some(j => j.outcome === 'delivered' && j.why === 'back'));
  assert.equal(a.opening.held.peek(a.clock.now), null);
  await a.ack();
  // Not twice, and no greeting on top of it.
  for (let i = 0; i < 5; i++) { a.clock.now += SECOND; await a.second(); }
  assert.equal(a.count.model, 1); assert.equal(a.count.welcomes, 0);
  a.dispose();
});

test('a held intent is brought up at a live cue too, before anything else; a held keepsake line comes back as the keepsake line', async () => {
  const a = app({ keepsake: 'tell' });
  a.fake.idle = 6 * 60; await a.second();
  assert.equal((await a.opportunity()).owner, 'held');
  assert.equal(a.count.writes, 0);
  // Back without a beat in between (the cue comes first): the held one is said on this cue.
  a.fake.idle = 0; a.clock.now += SECOND; a.ua.tick(a.clock.now);
  const { owner, cue } = await a.opportunity();
  assert.equal(owner, 'inner');
  assert.deepEqual(a.count.cues.length, 0, 'the keepsake line needs no prompt and no model');
  assert.equal(a.count.model, 0); assert.equal(a.count.offers, 1);
  assert.ok(a.journal.some(j => j.outcome === 'delivered'));
  assert.ok(cue.id);
  a.dispose();
});

test('busy → she still speaks sometimes (gently: the busy lean, never a stop)', async () => {
  const a = app({ chooser: new OpeningChoiceDirector({ random: rng(5) }) });
  // Busy: keep the tracker busy by typing for 12 minutes (focus rises), the judgment then says busy / gently.
  for (let t = 0; t < 12 * 60; t += 5) { a.fake.idle = 1; a.clock.now += 5 * SECOND; a.tick(); }
  assert.equal(a.ua.presence().presence, 'busy');
  assert.equal(a.ua.presence().interrupt, 'gently');
  let spoke = 0;
  for (let i = 0; i < 40; i++) {
    const { owner } = await a.opportunity();
    if (owner === 'inner') { spoke++; await a.ack(); }
    assert.notEqual(owner, 'held');
    a.clock.now += 5 * SECOND; a.fake.idle = 1; a.tick();
  }
  assert.ok(spoke >= 8, `spoke ${spoke} of 40 while busy`);
  assert.ok(a.journal.some(j => j.why === 'busy-declined'), 'a let-pass while busy is journaled as such');
  a.dispose();
});

test('meeting via the screen look → nothing, no model, no sound; a listen-together pause point is silent too', async () => {
  const a = app({ sharing: true, ask: async () => '开会' });
  a.fake.idle = 4 * 60; await a.second();
  const first = await a.opportunity();
  assert.equal(first.owner, 'held', 'unsure: held while she looks');
  assert.equal(a.fake.asks, 1, 'one look'); assert.deepEqual(a.fake.looked, ['meeting']);
  assert.equal(a.ua.presence().presence, 'meeting');
  // Typing notes in the meeting: still nothing.
  a.fake.idle = 0;
  for (let i = 0; i < 10; i++) { a.clock.now += SECOND; await a.second(); }
  const during = await a.opportunity();
  assert.equal(during.owner, 'held');
  const pause = await a.opportunity(true);
  assert.equal(pause.owner, 'held', 'listen-together keeps its rules, except a meeting');
  assert.equal(a.count.model, 0); assert.equal(a.count.offers, 0); assert.equal(a.count.ambient, 0);
  assert.equal(a.fake.asks, 1, 'the verdict is cached: no second look within 3 minutes');
  assert.ok(a.journal.some(j => j.outcome === 'unspoken' && j.why === 'meeting'));
  // The hidden cue never reaches the renderer's own reactions.
  const view = { ...VIEW, snapshot: { ...REST, cue: during.cue } } as MoodView;
  assert.equal(claimedView(view, 'held').snapshot.cue, null);
  a.dispose();
});

test('unsure with sharing on: the look says "watching" → the held line is brought up a moment later (no lost chance)', async () => {
  const a = app({ sharing: true, ask: async () => '看视频' });
  a.fake.idle = 8 * 60; await a.second();
  assert.equal((await a.opportunity()).owner, 'held');
  assert.equal(a.fake.asks, 1);
  a.clock.now += SECOND; await a.second();
  assert.equal(a.count.model, 1, 'watching counts as there: brought up');
  assert.ok(a.journal.some(j => j.outcome === 'delivered' && j.why === 'present'));
  a.dispose();
});

test('a held intent expires after 2 hours: its quota goes back, nothing is said on return', async () => {
  const a = app();
  a.fake.idle = 6 * 60; await a.second();
  assert.equal((await a.opportunity()).owner, 'held');
  a.clock.now += 2 * HOUR + SECOND; a.fake.idle = 2 * 3600; await a.second();
  assert.deepEqual(a.count.refunds, ['cue-1']);
  assert.ok(a.journal.some(j => j.outcome === 'expired' && j.why === 'too-long'));
  a.fake.idle = 0; a.clock.now += SECOND; await a.second();
  assert.equal(a.count.model, 0, 'too old: not said');
  a.dispose();
});

test('back from a long absence with nothing held: the greeting roll asks the mood clock once; short absences and a failed roll do not', async () => {
  for (const [away, random, close, expected] of [[45, 0.01, 1, 1], [45, 0.99, 1, 0], [20, 0.01, 2, 0], [45, 0.5, 2, 1], [45, 0.5, 1, 0]] as const) {
    const a = app({ random: () => random, close });
    a.fake.idle = 0; await a.second();
    a.power('lock-screen'); a.clock.now += away * MINUTE; a.fake.idle = away * 60; await a.second();
    a.power('unlock-screen'); a.clock.now += SECOND; a.fake.idle = 0; await a.second();
    for (let i = 0; i < 5; i++) { a.clock.now += SECOND; await a.second(); }
    assert.equal(a.count.welcomes, expected, `away ${away} min, roll ${random}, close ${close}`);
    if (expected) {
      // The cue the mood clock then publishes is her greeting: her own words (the inner loop decides; not a fixed line).
      const { owner } = await a.opportunity();
      assert.equal(owner, 'inner'); assert.match(a.count.cues.at(-1)!, /:mood$/);
      assert.ok(a.journal.some(j => j.outcome === 'greet'));
    }
    a.dispose();
  }
});

test('every consumer obeys "no": memorial, R20, screen, sound, her need, an invite, a keepsake written or told, the special-day line', async () => {
  for (const variant of ['plain', 'need', 'keepsake-tell', 'keepsake-write'] as const) {
    const a = app({ need: variant === 'need', keepsake: variant === 'keepsake-tell' ? 'tell' : variant === 'keepsake-write' ? 'write' : null,
      chooser: new FixedOpeningChoice(['keepsake', 'play', 'mood', 'screen', 'listen', 'quiet']) });
    a.power('lock-screen'); a.fake.idle = 600; await a.second();
    for (let i = 0; i < 3; i++) { const { owner } = await a.opportunity(); assert.equal(owner, 'held', variant); }
    assert.deepEqual({ memorial: a.count.memorial, r20: a.count.r20, vision: a.count.vision, ambient: a.count.ambient, writes: a.count.writes, model: a.count.model, offers: a.count.offers },
      { memorial: 0, r20: 0, vision: 0, ambient: 0, writes: 0, model: 0, offers: 0 }, variant);
    const held = a.opening.held.peek(a.clock.now);
    assert.equal(held?.kind, variant === 'need' ? 'need' : variant === 'keepsake-tell' ? 'keepsake' : 'talk', variant);
    a.dispose();
  }
});

test('一起听、一起看 keep their own rules (the plan): a pause-point cue while the user is away is not held; in a meeting it is', async () => {
  const a = app();
  a.power('lock-screen'); a.fake.idle = 600; await a.second();
  assert.notEqual((await a.opportunity(true)).owner, 'held');
  assert.equal(a.count.ambient > 0, true, 'the listen line was asked as before');
  a.dispose();
});

test('mutation check: without the presence port nothing is held (the gate is what stops her)', async () => {
  const a = app();
  const bare = new OpeningHost({ loop: a.loop, chooser: new FixedOpeningChoice(['mood', 'quiet']), innerOn: () => true, developerMode: () => false,
    clock: () => a.clock.now, releaseSpeech: () => {} });
  a.power('lock-screen'); a.fake.idle = 600; await a.second();
  const owner = bare.claim({ id: 'x1', kind: 'speech', at: a.clock.now, until: a.clock.now + 3_000 }, {}, VIEW);
  await flush();
  assert.equal(owner, 'inner'); assert.equal(a.count.model, 1, 'without the gate she would have called the model while the user was away');
  a.dispose();
});

// ---------------------------------------------------------------- the mood clock's welcome cue

test('welcome attention: a speech cue without waiting for boredom, but the interval and the hourly cap still hold', () => {
  const p = DEFAULT_MOOD_PARAMETERS;
  let state = createMoodState(T0, p);
  state = applyMoodEvent(state, { type: 'attention', id: 'w1', kind: 'speech', welcome: true }, T0, p);
  assert.equal(state.cue?.id, 'w1', 'boredom 0, still a cue');
  const plain = applyMoodEvent(createMoodState(T0, p), { type: 'attention', id: 'p1', kind: 'speech' }, T0, p);
  assert.equal(plain.cue, null, 'without welcome: boredom first');
  const again = applyMoodEvent({ ...state, cue: null }, { type: 'attention', id: 'w2', kind: 'speech', welcome: true }, T0 + MINUTE, p);
  assert.equal(again.cue, null, 'the speech interval holds');
  assert.throws(() => applyMoodEvent(state, { type: 'attention', id: 'w3', kind: 'motion', welcome: true } as never, T0, p));
});

// ---------------------------------------------------------------- the journal and the morning check

test('journal: speech-cue lines are closed pairs only; a screen look keeps only its category', () => {
  assert.ok(buildJournalEntry({ type: 'speech-cue', characterId: 'gene', outcome: 'held', why: 'meeting' }, T0));
  assert.equal(buildJournalEntry({ type: 'speech-cue', characterId: 'gene', outcome: 'held', why: 'chose-not' }, T0), null, 'wrong pair');
  assert.equal(buildJournalEntry({ type: 'speech-cue', characterId: 'gene', outcome: 'held', why: 'away', text: '我想你了' }, T0)?.toString().includes('我想你了') ?? false, false);
  const look = buildJournalEntry({ type: 'presence-look', characterId: 'gene', look: 'watching', description: '用户在看某部剧' }, T0);
  assert.ok(look); assert.equal(JSON.stringify(look).includes('某部剧'), false);
  assert.equal(buildJournalEntry({ type: 'presence-look', characterId: 'gene', look: '用户在开会' }, T0), null);
  const tr = (source: string, ...items: readonly unknown[]) => source.replace(/\{(\d+)\}/g, (_, i: string) => String(items[Number(i)]));
  assert.match(describeJournalEntry(buildJournalEntry({ type: 'speech-cue', characterId: 'gene', outcome: 'unspoken', why: 'busy-declined' }, T0)!, tr), /她想开口，这次没说（你在忙，她收着了）/);
});
