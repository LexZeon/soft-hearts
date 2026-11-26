// I-085 steps 2 and 4 (docs/claude/2026-11-12-i085-steps-2-4.md): a look before she speaks first, the little eye mark, and the mood
// write-back from haiku's closed tag. Fakes only: frames, haiku, clock, presence, mood; no camera, no model call, no Electron.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SELF_LOOK_KNOBS, type SelfLookKnobs } from '../shared/behaviors/self-look/knobs';
import {
  CARE_SENTENCE, SELF_LOOK_SYSTEM_PROMPT, SELF_LOOK_TAGS, parseSelfLookResult, selfLookEffects, selfLookHintLine, selfLookOpeningLine,
  type SelfLookMoment, type SelfLookMoodInput,
} from '../shared/initiative/self-look';
import { SelfLookHost, type SelfLookCamera, type SelfLookPorts, type SelfLookRow } from '../electron/initiative/self-look/host';
import { createSelfLook } from '../electron/initiative/self-look/wiring';
import { ImpulseHost, type ImpulseHostOptions, type ImpulseMoodRead } from '../electron/initiative/impulse/host';
import type { InitiativeRow } from '../shared/behaviors/impulse/interface';
import { buildInnerLoopPrompt, type InnerLoopPromptInput } from '../shared/initiative/inner-loop';
import { innerLoopPrompt } from '../electron/initiative/inner-loop/context';
import { DEFAULT_MOOD_PARAMETERS, MOOD_CHANNELS, type MoodValues } from '../shared/foundation/mood';
import { MOOD_MOMENTS, MOOD_MOMENT_KINDS, MOOD_MOMENT_REASONS } from '../shared/foundation/mood-moments';
import { MoodMoments, type MoodMomentLift } from '../electron/mood/mood-moments';
import { MOOD_EVENT_SOURCES, moodEventSource } from '../shared/memory/journal';
import { SelfLookMark, SELF_LOOK_MARK_MS } from '../src/initiative/SelfLookMark';

const MIN = 60_000, HOUR = 60 * MIN;
const calm = (): SelfLookMoodInput => ({ values: { D: 50, O: 50, E: 50, N: 50, C: 50 }, baseline: { D: 50, O: 50, E: 50, N: 50, C: 50 }, boredom: 0, longing: 0, fatigue: { F: 0.25, phase: 'awake' } });
const FRAME = 'data:image/jpeg;base64,SECRETFRAMEAAAA';
const LINE = '他靠在椅子上，在笑';
const tagged = (tag: string, line = LINE) => `${line}\n标签：${tag}`;
async function flush(): Promise<void> { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); }

// ---------------------------------------------------------------- the closed tag, strictly

test('tag: the five closed words parse; anything else is no tag (and writes nothing)', () => {
  for (const tag of SELF_LOOK_TAGS) assert.deepEqual(parseSelfLookResult(tagged(tag)), { text: LINE, tag });
  assert.deepEqual(parseSelfLookResult(`${LINE}\r\n标签:present\r\n`), { text: LINE, tag: 'present' }, 'half-width colon and CRLF');
  for (const raw of [LINE, `${LINE}\n标签：happy`, `${LINE}\n标签：Smiling`, `${LINE}\n标签：smiling，他很开心`, `${LINE}\n他看起来很累`, `${LINE}\n标签：smiling\n标签：tired`,
    `${LINE}\n\n标签：smiling\n多余的一行`, `${LINE} 标签：smiling`, `${LINE}\n标签：`, `${LINE}\n标签：present smiling`]) {
    const parsed = parseSelfLookResult(raw);
    assert.equal(parsed.tag, null, JSON.stringify(raw));
    assert.ok(parsed.text, `the line itself still reads: ${JSON.stringify(raw)}`);
  }
  // A tag with no line, or "看不清": nothing at all (the look failed).
  assert.deepEqual(parseSelfLookResult('标签：smiling'), { text: null, tag: null });
  assert.deepEqual(parseSelfLookResult('看不清\n标签：unclear'), { text: null, tag: null });
  assert.deepEqual(parseSelfLookResult(42), { text: null, tag: null });
  assert.deepEqual(parseSelfLookResult(''), { text: null, tag: null });
});

test('tag: the one haiku call asks for it (no second call) with the five words in the instructions', () => {
  for (const tag of SELF_LOOK_TAGS) assert.ok(SELF_LOOK_SYSTEM_PROMPT.includes(tag), tag);
  assert.match(SELF_LOOK_SYSTEM_PROMPT, /标签：词/u);
});

test('effects: the table — present O; smiling O and E; tired O and a caring lean (never stress); away, unclear, unknown nothing', () => {
  assert.deepEqual(selfLookEffects('present'), { moments: ['look-present'], care: false });
  assert.deepEqual(selfLookEffects('smiling'), { moments: ['look-present', 'look-smile'], care: false });
  assert.deepEqual(selfLookEffects('tired'), { moments: ['look-present'], care: true });
  for (const tag of ['away', 'unclear', null, undefined, 'happy', 'SMILING', 42, {}]) assert.deepEqual(selfLookEffects(tag), { moments: [], care: false }, String(tag));
});

// ---------------------------------------------------------------- the moments: O and E only, only up, capped

test('moments: look-present is O up, look-smile is E up — never C, never a dip, never A, and capped like every other moment', () => {
  for (const kind of ['look-present', 'look-smile'] as const) {
    const spec = MOOD_MOMENTS[kind];
    const channels = Object.keys(spec.delta);
    assert.ok(channels.length === 1 && channels.every(channel => channel === 'O' || channel === 'E'), `${kind}: ${channels}`);
    assert.ok(Object.values(spec.delta).every(amount => (amount as number) > 0 && (amount as number) <= 1.5), `${kind} small and only up`);
    assert.ok(!('C' in spec.delta) && !('A' in spec.delta));
    assert.ok(spec.cooldownMs >= 20 * MIN && spec.perDay <= 8, `${kind} is capped`);
    assert.equal(spec.keepReason, true, 'numbers only: no new reason she could bring up');
    assert.ok(MOOD_MOMENT_REASONS[kind].length > 2 && MOOD_MOMENT_KINDS.includes(kind));
    assert.ok((MOOD_EVENT_SOURCES as readonly string[]).includes(`moment-${kind}`), 'the journal knows its source');
    assert.equal(moodEventSource('lift', MOOD_MOMENT_REASONS[kind]), `moment-${kind}`);
  }
  assert.equal(MOOD_MOMENTS['look-present'].group === MOOD_MOMENTS['look-smile'].group, false, 'two families: smiling does not use up the "saw you" count');
  assert.ok(MOOD_CHANNELS.every(channel => channel !== ('A' as never)), 'A is not a mood channel: a moment cannot write it');
});

test('moments through the real gate: a second look inside the cooldown moves nothing; a card already high in O gets less', () => {
  let now = new Date(2026, 10, 12, 10, 0, 0).getTime();
  const lifts: MoodMomentLift[] = [];
  let values: MoodValues = { D: 50, O: 50, E: 50, N: 50, C: 50 };
  const moments = new MoodMoments({ clock: () => now, current: () => 'gene', state: () => ({ values, baseline: { D: 50, O: 50, E: 50, N: 50, C: 50 }, evidence: 1, primary: 'calm' }),
    lift: lift => { lifts.push(lift); return true; } });
  assert.equal(moments.note('look-present'), true);
  assert.deepEqual(lifts[0].delta, { O: 1 });
  assert.equal(lifts[0].keepReason, true);
  now += 5 * MIN;
  assert.equal(moments.note('look-present'), false, 'the cooldown');
  now += MOOD_MOMENTS['look-present'].cooldownMs;
  assert.equal(moments.note('look-present'), true);
  for (let i = 0; i < 9; i++) { now += MOOD_MOMENTS['look-present'].cooldownMs; moments.note('look-present'); }
  assert.equal(lifts.filter(lift => lift.id.startsWith('moment-look-present')).length, MOOD_MOMENTS['look-present'].perDay, 'the day count');
  values = { ...values, E: 99 };
  assert.equal(moments.note('look-smile'), false, 'E already far above its baseline: nothing more');
});

// ---------------------------------------------------------------- the host with fakes

interface Harness {
  host: SelfLookHost;
  rows: SelfLookRow[];
  moments: SelfLookMoment[];
  eyes: number;
  captures: number;
  asks: number;
  state: { enabled: boolean; camera: SelfLookCamera; scope: string; mood: SelfLookMoodInput | null; present: boolean; typing: boolean; last: number | null; now: number };
  answer: string | (() => Promise<string>);
  frame: string | null;
  timers: { set: (callback: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
  fire(ms: number): void;
  advance(ms: number): void;
}
function harness(options: { knobs?: Partial<SelfLookKnobs>; ports?: Partial<SelfLookPorts> } = {}): Harness {
  const pending = new Map<number, { at: number; callback: () => void }>();
  let seq = 0, timerNow = 0;
  const h = {
    rows: [] as SelfLookRow[], moments: [] as SelfLookMoment[], eyes: 0, captures: 0, asks: 0, answer: tagged('present') as string | (() => Promise<string>), frame: FRAME as string | null,
    state: { enabled: true, camera: 'on' as SelfLookCamera, scope: 'gene|c1', mood: { ...calm(), boredom: 100 } as SelfLookMoodInput | null, present: true, typing: false, last: 0 as number | null, now: 40 * MIN },
  } as Harness;
  h.timers = {
    set: (callback, ms) => { const id = ++seq; pending.set(id, { at: timerNow + ms, callback }); return id; },
    clear: handle => { pending.delete(handle as number); },
  };
  h.fire = ms => { timerNow += ms; for (const [id, timer] of [...pending]) if (timer.at <= timerNow) { pending.delete(id); timer.callback(); } };
  h.advance = ms => { h.state.now += ms; };
  h.host = new SelfLookHost({
    enabled: () => h.state.enabled, camera: () => h.state.camera, scope: () => h.state.scope, mood: () => h.state.mood, present: () => h.state.present,
    typing: () => h.state.typing, lastInteractionAt: () => h.state.last, idleSeconds: () => null,
    capture: async () => { h.captures++; return h.frame; },
    ask: async () => { h.asks++; return typeof h.answer === 'function' ? h.answer() : h.answer; },
    journal: row => { h.rows.push(row); }, eye: () => { h.eyes++; }, moment: kind => { h.moments.push(kind); },
    clock: () => h.state.now, timers: h.timers, knobs: options.knobs, ...options.ports,
  });
  return h;
}

test('step 4b through the look she wanted: the tag becomes the moments and the caring lean; the picture and the line never reach the mood', async () => {
  const smile = harness();
  smile.answer = tagged('smiling');
  smile.host.tick(); await flush();
  assert.deepEqual(smile.moments, ['look-present', 'look-smile']);
  const tired = harness();
  tired.answer = tagged('tired');
  tired.host.tick(); await flush();
  assert.deepEqual(tired.moments, ['look-present'], 'tired: she saw you there; nothing for her stress');
  const first = tired.host.hint('今天好累', false, true);
  assert.ok(first.includes(CARE_SENTENCE), 'her next line leans caring');
  assert.ok(!tired.host.hint('还在', false, true).includes(CARE_SENTENCE), 'one turn, not every turn');
  assert.ok(tired.host.hint('还在', false, true).includes('他靠在椅子上'), 'the line itself still goes along');
  for (const text of [JSON.stringify(smile.moments), JSON.stringify(smile.rows)]) assert.ok(!text.includes('SECRETFRAME') && !text.includes('椅子'));
});

test('step 4b: no tag, an unknown tag, away and unclear write nothing (but the look still happened and still lights the eye)', async () => {
  for (const answer of [LINE, tagged('happy'), tagged('away', '座位上没人'), tagged('unclear'), `${LINE}\n标签：smiling\n标签：smiling`]) {
    const h = harness();
    h.answer = answer;
    h.host.tick(); await flush();
    assert.deepEqual(h.moments, [], JSON.stringify(answer));
    assert.equal(h.eyes, 1, 'she looked: the eye lights');
    assert.deepEqual(h.rows, [{ why: 'bored', sense: 'camera', result: 'looked', hour: 1 }]);
  }
  const away = harness();
  away.answer = tagged('away', '座位上没人');
  away.host.tick(); await flush();
  assert.equal(away.host.hint('嗨', false, true).includes(CARE_SENTENCE), false, 'an empty seat is not a reason to fuss');
});

test('step 4b: nothing is written when the look was stopped (a "别看" said while she looked), failed, or skipped', async () => {
  let release: (value: string) => void = () => {};
  const stopped = harness();
  stopped.answer = () => new Promise<string>(resolve => { release = resolve; });
  stopped.host.tick(); await flush();
  stopped.state.camera = 'held';
  stopped.host.mediaChanged();
  release(tagged('smiling')); await flush();
  assert.deepEqual(stopped.moments, []);
  assert.equal(stopped.host.holding, false);
  // A "别看" (or the camera off) that arrives while haiku answers, even when nothing aborted the look: the answer is not used at all.
  for (const camera of ['held', 'off'] as const) {
    const quiet = harness();
    quiet.answer = () => new Promise<string>(resolve => { release = resolve; });
    quiet.host.tick(); await flush();
    quiet.state.camera = camera;
    release(tagged('smiling')); await flush();
    assert.deepEqual([quiet.moments, quiet.host.holding], [[], false], camera);
    assert.deepEqual(quiet.rows.map(row => row.result), [camera === 'held' ? 'skipped-held' : 'skipped-off']);
  }
  const failed = harness();
  failed.answer = '看不清';
  failed.host.tick(); await flush();
  assert.deepEqual(failed.moments, []);
  const noFrame = harness();
  noFrame.frame = null;
  noFrame.host.tick(); await flush();
  assert.deepEqual([noFrame.moments, noFrame.eyes], [[], 0], 'no frame: no moment and no eye');
  for (const camera of ['held', 'off'] as const) {
    const h = harness();
    h.state.camera = camera;
    h.host.tick(); await flush();
    assert.deepEqual([h.moments, h.eyes, h.captures], [[], 0, 0], camera);
  }
});

test('step 4b: a throwing mood or eye never stops the look or her line', async () => {
  const h = harness({ ports: { moment: () => { throw new Error('mood'); }, eye: () => { throw new Error('eye'); } } });
  h.answer = tagged('smiling');
  h.host.tick(); await flush();
  assert.equal(h.host.holding, true);
  assert.deepEqual(h.rows, [{ why: 'bored', sense: 'camera', result: 'looked', hour: 1 }]);
});

// ---------------------------------------------------------------- step 2: the look before she speaks first

test('step 2: one frame, one haiku call, journal why "开口前", and the fresh line is her proactive line\'s context (not used up)', async () => {
  const h = harness();
  h.answer = tagged('present');
  const got = await h.host.beforeSpeaking();
  assert.equal(got, true);
  assert.deepEqual([h.captures, h.asks, h.eyes], [1, 1, 1]);
  assert.deepEqual(h.rows, [{ why: 'opening', sense: 'camera', result: 'looked', hour: 1 }]);
  assert.deepEqual(h.moments, ['look-present']);
  h.advance(2 * MIN);
  const line = h.host.openingLine();
  assert.match(line, /^【开口前你自己看了一眼】2 分钟前你用摄像头看了用户一眼：他靠在椅子上，在笑。/u);
  assert.match(line, /在忙.*很短/u, 'busy → short');
  assert.match(line, /闲着.*多聊/u, 'idle → chattier');
  assert.equal(h.host.openingLine(), line, 'reading it does not use it up');
  assert.match(h.host.hint('嗨', false, true), /你自己看了一眼/u, 'the next chat turn may still have it');
  for (const text of [line, JSON.stringify(h.rows)]) assert.ok(!text.includes('SECRETFRAME'));
  assert.ok(!/(\d+\s*(?:字|秒))/u.test(line), 'no length or time formula handed to her');
});

test('step 2: tired in the opening line leans caring; nobody there says she may stay quiet', async () => {
  const tired = harness();
  tired.answer = tagged('tired');
  await tired.host.beforeSpeaking();
  assert.ok(tired.host.openingLine().includes(CARE_SENTENCE));
  assert.ok(selfLookOpeningLine('座位上没人', 0).includes('座位上没人，可以不说'));
  assert.ok(selfLookHintLine('他在笑', 0, true).includes(CARE_SENTENCE) && !selfLookHintLine('他在笑', 0).includes(CARE_SENTENCE));
});

test('step 2 limits: 「发图片」 off — no look, no row, she just speaks; "别看" — no look, one row; setting off, hidden, asleep, typing — nothing', async () => {
  const off = harness();
  off.state.camera = 'off';
  assert.equal(await off.host.beforeSpeaking(), false);
  assert.deepEqual([off.captures, off.asks, off.rows, off.eyes], [0, 0, [], 0]);
  const held = harness();
  held.state.camera = 'held';
  assert.equal(await held.host.beforeSpeaking(), false);
  assert.deepEqual([held.captures, held.asks, held.eyes], [0, 0, 0]);
  assert.deepEqual(held.rows, [{ why: 'opening', sense: 'camera', result: 'skipped-held' }]);
  assert.equal(await held.host.beforeSpeaking(), false);
  assert.equal(held.rows.length, 1, 'at most one such row an hour');
  const cases: [string, (h: Harness) => void][] = [
    ['setting off', h => { h.state.enabled = false; }], ['hidden', h => { h.state.present = false; }], ['typing', h => { h.state.typing = true; }],
    ['asleep', h => { h.state.mood = { ...calm(), fatigue: { phase: 'asleep', sleeping: true } }; }], ['no scope', h => { h.state.scope = ''; }],
  ];
  for (const [name, setup] of cases) {
    const h = harness();
    setup(h);
    assert.equal(await h.host.beforeSpeaking(), false, name);
    assert.deepEqual([h.captures, h.asks, h.eyes, h.rows.length], [0, 0, 0, 0], name);
  }
});

test('step 2: a fresh line is reused instead of a second look; I-168: no ten minutes and no hourly count once it has expired', async () => {
  const reuse = harness();
  assert.equal(await reuse.host.beforeSpeaking(), true);
  reuse.advance(3 * MIN);
  assert.equal(await reuse.host.beforeSpeaking(), true);
  assert.deepEqual([reuse.captures, reuse.asks], [1, 1], 'the line is still fresh: no second look');
  // The line expired: she looks again right away (no ten minutes, no hourly count).
  const cool = harness({ knobs: { lineTtlMs: 1 * MIN } });
  await cool.host.beforeSpeaking();
  cool.advance(3 * MIN);
  assert.equal(await cool.host.beforeSpeaking(), true);
  assert.equal(cool.captures, 2);
  assert.deepEqual(cool.rows.map(row => row.result), ['looked', 'looked']);
  const hourly = harness({ knobs: { lineTtlMs: 1 } });
  for (let i = 0; i < 4; i++) { hourly.advance(MIN); await hourly.host.beforeSpeaking(); }
  assert.equal(hourly.captures, 4, 'four in four minutes');
  // The look she wanted (tick) and the one before speaking share the same caps and the same line.
  const shared = harness();
  shared.host.tick(); await flush();
  assert.equal(await shared.host.beforeSpeaking(), true);
  assert.equal(shared.captures, 1);
  shared.host.tick(); await flush();
  assert.equal(shared.captures, 1, 'and the want does not look again while the line is fresh and the gap holds');
});

test('step 2: a failing, empty or late look never blocks her: she speaks without it (and a late line is still hers for the chat)', async () => {
  const empty = harness();
  empty.answer = '看不清';
  assert.equal(await empty.host.beforeSpeaking(), false);
  assert.equal(empty.host.openingLine(), '');
  const broken = harness();
  broken.answer = () => Promise.reject(new Error('haiku'));
  assert.equal(await broken.host.beforeSpeaking(), false);
  assert.deepEqual(broken.rows, [{ why: 'opening', sense: 'camera', result: 'failed' }]);
  const noFrame = harness();
  noFrame.frame = null;
  assert.equal(await noFrame.host.beforeSpeaking(), false);
  // Late: the wait is bounded; she goes on without it; the answer arriving afterwards is kept like any other look's.
  let release: (value: string) => void = () => {};
  const late = harness();
  late.answer = () => new Promise<string>(resolve => { release = resolve; });
  let done = false;
  const waiting = late.host.beforeSpeaking().then(value => { done = true; return value; });
  await flush();
  assert.equal(done, false, 'still waiting for haiku');
  late.fire(SELF_LOOK_KNOBS.openingWaitMs);
  assert.equal(await waiting, false, 'the wait ended: she speaks without it');
  release(tagged('present')); await flush();
  assert.equal(late.host.holding, true, 'the late line is kept');
  assert.equal(await late.host.beforeSpeaking(), true);
  // A look already under way (the one she wanted) is waited for, not doubled.
  let release2: (value: string) => void = () => {};
  const under = harness();
  under.answer = () => new Promise<string>(resolve => { release2 = resolve; });
  under.host.tick(); await flush();
  const waiting2 = under.host.beforeSpeaking();
  release2(tagged('present')); await flush();
  assert.equal(await waiting2, true);
  assert.equal(under.captures, 1);
});

test('step 2: the opening line goes with a "别看", the camera off, a switch of character or conversation, and expiry; a chat turn never starts a look', async () => {
  for (const drop of [(h: Harness) => { h.state.camera = 'held'; }, (h: Harness) => { h.state.camera = 'off'; }, (h: Harness) => { h.state.scope = 'gene|c2'; },
    (h: Harness) => { h.advance(SELF_LOOK_KNOBS.lineTtlMs); }, (h: Harness) => { h.state.enabled = false; }]) {
    const h = harness();
    await h.host.beforeSpeaking();
    assert.notEqual(h.host.openingLine(), '');
    drop(h);
    assert.equal(h.host.openingLine(), '');
  }
  const chat = harness();
  chat.host.hint('你好', false, true);
  chat.host.hint('你好', false, false);
  chat.host.openingLine();
  assert.deepEqual([chat.captures, chat.asks], [0, 0], 'only her own initiative asks for the look');
});

// ---------------------------------------------------------------- the impulse host: the look comes between "talk" and the opportunity

const T0 = Date.UTC(2026, 10, 12, 6, 0, 0);
const base = (): MoodValues => ({ D: 50, O: 50, E: 50, N: 50, C: 50 });
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
interface Rig {
  now: number; canExpress: boolean; quiet: boolean; asleep: boolean; presence: 'ok' | 'meeting' | 'away'; unanswered: number; balance: number;
  order: string[]; rows: InitiativeRow[]; looks: number; talks: number; glances: number;
  look: ((characterId: string) => Promise<unknown>) | undefined;
}
function rig(over: Partial<Rig> = {}, seed = 11) {
  const f: Rig = { now: T0, canExpress: true, quiet: false, asleep: false, presence: 'ok', unanswered: 0, balance: 1, order: [], rows: [], looks: 0, talks: 0, glances: 0, look: async () => undefined, ...over };
  const mood = (): ImpulseMoodRead => ({ characterId: 'gene', values: { ...base(), O: 80, D: 76, N: 66 }, baseline: base(), evidence: 1, boredom: 60, longing: 40, A: 0.25, personality: {},
    lastInteractionAt: T0, unanswered: f.unanswered, primary: 'happy', context: 'neutral', reason: '安静陪伴' });
  const options: ImpulseHostOptions = {
    clock: () => f.now, random: seeded(seed), mood, quiet: () => ({ asleep: f.asleep, quiet: f.quiet }),
    presence: () => f.presence === 'ok' ? { presence: 'idle', interrupt: 'yes', source: 'input' } : f.presence === 'meeting' ? { presence: 'meeting', interrupt: 'no', source: 'input', why: 'meeting' } as never
      : { presence: 'away', interrupt: 'no', source: 'input', why: 'idle-long' } as never,
    canExpress: () => f.canExpress, balance: () => f.balance,
    talkNow: () => { f.talks++; f.order.push('talk'); return true; }, glanceNow: () => { f.glances++; return true; }, journal: row => { f.rows.push(row); },
    lift: () => true,
    ...(f.look ? { lookFirst: (id: string) => { f.looks++; f.order.push('look'); return f.look!(id); } } : {}),
  };
  const host = new ImpulseHost(options);
  const run = async (ms: number) => { for (let t = 0; t < ms; t += 1_000) { f.now += 1_000; host.tick(); if (t % 60_000 === 0) await flush(); } await flush(); };
  const until = async (done: () => boolean, maxMs = 6 * HOUR) => { for (let t = 0; t < maxMs && !done(); t += 1_000) { f.now += 1_000; host.tick(); await flush(); } };
  return { f, host, run, until };
}

test('impulse: when she decides to talk the look comes first, and only then the opportunity is asked for', async () => {
  let release: () => void = () => {};
  const r = rig({ look: () => new Promise<void>(resolve => { release = resolve; }) });
  await r.until(() => r.f.looks >= 1);
  assert.equal(r.f.looks, 1, 'she decided to talk');
  assert.deepEqual(r.f.order, ['look'], 'the opportunity waits for the look');
  assert.equal(r.f.talks, 0);
  release(); await flush();
  assert.deepEqual(r.f.order, ['look', 'talk'], 'look, then talk');
  assert.equal(r.f.rows.filter(row => row.kind === 'talk').length, 1);
});

test('impulse: the look is only for talking — never for a glance, humming, nothing, or where the floor holds', async () => {
  // Every look call is followed by exactly one talk (the look is never asked for anything else).
  const open = rig();
  await open.run(30 * HOUR);
  assert.ok(open.f.looks > 3 && open.f.looks === open.f.talks, `looks ${open.f.looks} talks ${open.f.talks}`);
  const reaches = open.f.rows.length;
  assert.ok(open.f.looks < reaches, 'some reaches were a glance or "not this time": no look for those');
  assert.ok(open.f.glances > 0);
  for (const [name, over] of [['night', { quiet: true }], ['asleep', { asleep: true }], ['meeting', { presence: 'meeting' }], ['away', { presence: 'away' }],
    ['typing or hidden', { canExpress: false }], ['unanswered', { unanswered: 1 }], ['no balance', { balance: 0 }]] as [string, Partial<Rig>][]) {
    const h = rig(over);
    await h.run(12 * HOUR);
    assert.equal(h.f.looks, 0, `${name}: no look`);
    assert.equal(h.f.talks, 0, name);
  }
});

test('impulse: the floor is read again after the look — she does not talk into a user who started typing meanwhile', async () => {
  let release: () => void = () => {};
  const r = rig({ look: () => new Promise<void>(resolve => { release = resolve; }) });
  await r.until(() => r.f.looks >= 1);
  assert.ok(r.f.looks === 1 && r.f.talks === 0);
  r.f.canExpress = false;
  release(); await flush();
  assert.equal(r.f.talks, 0, 'not now: the opportunity is not asked for');
  assert.ok(r.f.rows.some(row => row.kind === 'none' && row.why === 'floor' && row.floor === 'not-now'), JSON.stringify(r.f.rows));
  for (const [name, change] of [['night', (f: Rig) => { f.quiet = true; }], ['asleep', (f: Rig) => { f.asleep = true; }], ['meeting', (f: Rig) => { f.presence = 'meeting'; }]] as [string, (f: Rig) => void][]) {
    const g = rig({ look: () => new Promise<void>(resolve => { release = resolve; }) });
    await g.until(() => g.f.looks >= 1);
    change(g.f);
    release(); await flush();
    assert.equal(g.f.talks, 0, name);
  }
});

test('impulse: a look that throws, rejects or never matters does not stop her talking; no look port: as before', async () => {
  for (const look of [() => Promise.reject(new Error('x')), () => { throw new Error('y'); }, async () => 'anything']) {
    const r = rig({ look: look as never });
    await r.run(4 * HOUR);
    assert.ok(r.f.talks > 0, 'she still talks');
  }
  const plain = rig({ look: undefined });
  await plain.run(8 * HOUR);
  assert.ok(plain.f.talks > 0 && plain.f.looks === 0);
});

test('impulse: the look is not a new timer and does not move the floor — the same seed talks as often with and without the look (a bounded look)', async () => {
  const a = rig({ look: undefined }, 5), b = rig({}, 5);
  await a.run(20 * HOUR); await b.run(20 * HOUR);
  assert.equal(b.f.talks, a.f.talks, 'an instant look changes nothing about when she talks');
  assert.deepEqual(b.f.rows.map(row => `${row.kind}${row.why ?? ''}${row.floor ?? ''}`), a.f.rows.map(row => `${row.kind}${row.why ?? ''}${row.floor ?? ''}`));
});

// ---------------------------------------------------------------- the prompt and the wiring

const promptInput = (over: Partial<InnerLoopPromptInput> = {}): InnerLoopPromptInput => ({
  persona: '你是 Gene。', mood: '当前角色内在状态：平静。', weights: DEFAULT_MOOD_PARAMETERS.weights, intensity: DEFAULT_MOOD_PARAMETERS.intensity,
  localMinute: 15 * 60, minutesSinceInteraction: 35, cue: 'speech', allowSpeech: true, quiet: { asleep: false, drowsy: false, night: false, quiet: false }, ...over,
});

test('prompt: the look line is in the proactive line\'s context only where she may speak on her own; elsewhere it is not written', () => {
  const look = selfLookOpeningLine(LINE, 60_000);
  assert.ok(buildInnerLoopPrompt(promptInput({ look })).includes('【开口前你自己看了一眼】'));
  assert.ok(!buildInnerLoopPrompt(promptInput()).includes('开口前你自己看了一眼'));
  for (const over of [{ quiet: { asleep: false, drowsy: false, night: true, quiet: true } }, { quiet: { asleep: false, drowsy: true, night: false, quiet: true, restReminder: true } },
    { allowSpeech: false }, { cue: 'motion' }, { play: true, inviteOnly: true }] as Partial<InnerLoopPromptInput>[])
    assert.ok(!buildInnerLoopPrompt(promptInput({ look, ...over })).includes('开口前你自己看了一眼'), JSON.stringify(over));
  // Through the real source reader: a throwing or empty source writes nothing.
  const sources = { now: () => 1, localMinute: () => 15 * 60, persona: () => 'p', language: () => '', mood: () => '', parameters: () => DEFAULT_MOOD_PARAMETERS,
    lastInteractionAt: () => 0, profileEnabled: () => false, profilePoints: () => '', audioReading: () => false, ambientText: () => '' };
  const claim = { id: 'c', kind: 'speech', at: 1, characterId: 'x', gateScope: 's' } as never;
  const awake = { asleep: false, drowsy: false, night: false, quiet: false };
  assert.ok(innerLoopPrompt({ ...sources, look: () => look } as never, claim, true, awake).includes('开口前你自己看了一眼'));
  assert.ok(!innerLoopPrompt({ ...sources, look: () => { throw new Error('no'); } } as never, claim, true, awake).includes('开口前'));
  assert.ok(!innerLoopPrompt({ ...sources, look: () => look } as never, { kind: 'motion', id: 'm', at: 1, characterId: 'x', gateScope: 's' } as never, true, awake).includes('开口前'));
  assert.ok(!innerLoopPrompt({ ...sources, look: () => look } as never, claim, false, awake).includes('开口前'));
  // Where she may not speak on her own, the source is not even asked (nothing read for nothing).
  let asked = 0;
  const counting = { ...sources, look: () => { asked++; return look; } } as never;
  innerLoopPrompt(counting, { kind: 'motion', id: 'm', at: 1, characterId: 'x', gateScope: 's' } as never, true, awake);
  innerLoopPrompt(counting, claim, false, awake);
  assert.equal(asked, 0);
  innerLoopPrompt(counting, claim, true, awake);
  assert.equal(asked, 1);
});

test('wiring: createSelfLook hands out beforeSpeaking and openingLine, passes the eye and the moments, and never throws', async () => {
  const eyes: number[] = [], moments: string[] = [];
  const view = { snapshot: { values: base(), boredom: 100, longing: 0, lastInteractionAt: 0 }, parameters: { baseline: base(), evidence: { level: 1 } }, fatigue: { F: 0.2, phase: 'awake', sleeping: false } } as never;
  const wiring = createSelfLook({
    enabled: () => true, camera: () => ({ frames: true, held: false }), characterId: () => 'gene', conversationId: () => 'c1', mood: () => view, present: () => true, typing: () => false,
    idleSeconds: () => null, capture: async () => FRAME, eye: () => { eyes.push(1); }, moment: kind => { moments.push(kind); },
    ports: { ask: async () => tagged('smiling'), clock: () => 40 * MIN, timers: { set: () => ({}), clear: () => {} } },
  });
  assert.equal(await wiring.beforeSpeaking(), true);
  assert.deepEqual([eyes.length, moments], [1, ['look-present', 'look-smile']]);
  assert.match(wiring.openingLine(), /开口前你自己看了一眼/u);
  wiring.cancel();
  assert.equal(wiring.openingLine(), '');
  const broken = createSelfLook({
    enabled: () => { throw new Error('x'); }, camera: () => { throw new Error('x'); }, characterId: () => { throw new Error('x'); }, conversationId: () => null, mood: () => null,
    present: () => true, typing: () => false, idleSeconds: () => null, capture: async () => null,
  });
  assert.equal(await broken.beforeSpeaking(), false);
  assert.equal(broken.openingLine(), '');
});

// ---------------------------------------------------------------- the little eye (companion window)

function fakeDocument() {
  const make = () => {
    const classes = new Set<string>();
    const el = { hidden: false, className: '', innerHTML: '', attrs: {} as Record<string, string>, classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), contains: (c: string) => classes.has(c) },
      setAttribute(name: string, value: string) { el.attrs[name] = value; }, append() {}, textContent: '' };
    return el;
  };
  return { createElement: make as never };
}
test('eye mark: lights when told, fades by itself, restarts instead of stacking, never shows while the window is hidden, has an accessible name and no text', () => {
  let handler: (() => void) | null = null, unsubscribed = 0;
  const timers = new Map<number, () => void>();
  let seq = 0;
  const mark = new SelfLookMark({ append() {} } as never, { onSelfLook: callback => { handler = callback; return () => { unsubscribed++; }; } }, {
    document: fakeDocument(), timers: { set: callback => { timers.set(++seq, callback); return seq; }, clear: handle => { timers.delete(handle as number); } }, blocked: () => hidden,
  });
  let hidden = false;
  mark.init(); mark.init();
  const el = mark.element as unknown as { hidden: boolean; innerHTML: string; attrs: Record<string, string>; classList: { contains(c: string): boolean } };
  assert.equal(el.hidden, true);
  assert.equal(el.attrs.role, 'img');
  assert.ok(el.attrs['aria-label'].length > 0);
  assert.ok(!/<text|>[^<\s]+</u.test(el.innerHTML), 'the picture has no words in it');
  handler!();
  assert.deepEqual([el.hidden, el.classList.contains('is-lit'), timers.size], [false, true, 1]);
  handler!();
  assert.equal(timers.size, 1, 'a second look restarts the time, it does not stack');
  [...timers.values()][0]();
  assert.deepEqual([el.hidden, el.classList.contains('is-lit')], [true, false]);
  hidden = true;
  handler!();
  assert.equal(el.hidden, true, 'a hidden window shows nothing');
  mark.dispose();
  assert.equal(unsubscribed, 1);
  assert.ok(SELF_LOOK_MARK_MS >= 1_000 && SELF_LOOK_MARK_MS <= 5_000, 'brief');
});
