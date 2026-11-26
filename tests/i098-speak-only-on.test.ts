// I-098 on (docs/claude/2026-11-12-i098-on.md): the switch by channel (development and source runs on, stable off); the mood book
// as a second step on the reactions' warm haiku (after that message's reaction call, never in its place, no new process, one
// book call either way; a one-off call only without a warm haiku); the judge asks for the user's state firmly and its answer is
// used as the tail's was; the judge states the tail's ranges and "no change" rule; the journal's mood-book line keeps the numbers.
// Fakes only: fake processes on a fake clock, fake haiku answers; no real model call.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CompanionService } from '../electron/brain/companion';
import type { ProviderConfig } from '../shared/foundation/settings';
import { MoodReplyProtocol } from '../electron/mood/mood-chat';
import { SPEAK_ONLY_STABLE, speakOnlyEnabled } from '../electron/brain/speak-only/rules';
import { SPEAK_ONLY_JUDGE_SYSTEM, SPEAK_ONLY_USER_STATE_RULE, speakOnlyJudgePrompt, speakOnlyWarmStepPrompt } from '../electron/brain/speak-only/judge';
import { SpeakOnlyJudge } from '../electron/brain/speak-only/judge-host';
import { speakOnlyRoute, type SpeakOnlyWarmPort } from '../electron/brain/speak-only/route';
import { speakOnlyAppJudge } from '../electron/brain/speak-only/wiring';
import { judgeBookInput, tailBookInput } from '../electron/brain/speak-only/book-journal';
import { WARM_LINE_DEFAULTS, type WarmProcess } from '../electron/initiative/inner-loop/warm-line';
import { ClaudeTurnError, type ClaudeTurnResult } from '../electron/brain/claude-process';
import { createReactions, type ReactionMoodPort } from '../electron/mood/reactions/wiring';
import { REACTION_KNOBS } from '../shared/behaviors/reactions/knobs';
import { FakeReactionJudge } from '../shared/behaviors/reactions/fake';
import { DEFAULT_MOOD_PARAMETERS, type MoodValues } from '../shared/foundation/mood';
import type { MoodView } from '../shared/mood/mood-runtime';
import { USER_STATES, USER_STATE_INSTRUCTION, USER_STATE_MIN_CONFIDENCE } from '../shared/senses/user-state';
import { buildJournalEntry, describeJournalEntry, type JournalInput } from '../shared/memory/journal';
import { ENGLISH_JOURNAL_UI_COPY } from '../shared/foundation/ui-copy.journal.en';

const SECOND = 1_000;
const provider: ProviderConfig = { kind: 'claude', baseUrl: 'https://first.example/v1', model: 'a' };
const JUDGE_TIRED = JSON.stringify({ context: 'concern', delta: { O: 2, C: 1 }, reason: '他累了', confidence: 0.9, gesture: 'none',
  user: { state: 'tired', confidence: 0.85, reason: '加班' } });
const REACTION_NONE = '{"event":"none","reactions":[],"delta":{},"confidence":0.9}';
const REACTION_LIFT = '{"event":"none","reactions":[],"delta":{"O":3},"confidence":0.9}';
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

// ---------------------------------------------------------------- the switch by channel

test('the switch: on in every channel, stable and an unmanaged packaged build included', () => {
  assert.equal(SPEAK_ONLY_STABLE, true);
  assert.equal(speakOnlyEnabled('development', true), true);
  assert.equal(speakOnlyEnabled('stable', true), true);
  assert.equal(speakOnlyEnabled(null, false), true, 'pnpm dev');
  assert.equal(speakOnlyEnabled(undefined, false), true);
  assert.equal(speakOnlyEnabled(null, true), true, 'a packaged build outside both channels behaves as stable');
  const oneShot = async () => '';
  assert.equal(speakOnlyAppJudge(false, oneShot, () => null), null, 'switched off: no judge at all');
  assert.equal(typeof speakOnlyAppJudge(speakOnlyEnabled('stable', true), oneShot, () => null)?.ask, 'function');
  assert.equal(typeof speakOnlyAppJudge(speakOnlyEnabled('development', true), oneShot, () => null)?.ask, 'function');
});

// ---------------------------------------------------------------- the judge prompt

test('the judge prompt asks for the user\'s state firmly, with the tail\'s closed states and confidence floor', () => {
  const prompt = speakOnlyJudgePrompt({ userText: '今天加班到十点，好累', reply: '辛苦了，快歇歇。', moodNow: '', persona: '' });
  assert.ok(prompt.includes(SPEAK_ONLY_USER_STATE_RULE));
  assert.ok(!prompt.includes(USER_STATE_INSTRUCTION), 'not the tail\'s optional wording');
  assert.ok(SPEAK_ONLY_USER_STATE_RULE.includes('就一定要写'));
  const named = SPEAK_ONLY_USER_STATE_RULE.match(/state只能是([a-z/()\p{Script=Han}]+)；/u)![1].replace(/\([^)]*\)/gu, '').split('/');
  assert.deepEqual(named, USER_STATES.filter(state => state !== 'unknown'), 'the same closed values as the tail');
  assert.ok(USER_STATE_INSTRUCTION.includes('tired/annoyed/low(情绪低落)/happy/excited/calm(缓过来了)') && SPEAK_ONLY_USER_STATE_RULE.includes('tired/annoyed/low(情绪低落)/happy/excited/calm(缓过来了)'));
  assert.ok(SPEAK_ONLY_USER_STATE_RULE.includes(`低于${USER_STATE_MIN_CONFIDENCE}`));
});

test('the judge states the tail\'s ranges and its "no change: empty delta" rule word for word', () => {
  const tail = new MoodReplyProtocol(() => {}).instruction();
  const judge = speakOnlyJudgePrompt({ userText: '你好', reply: '你好呀', moodNow: '', persona: '' });
  for (const rule of ['delta只可包含D/O/E/N/C，各值范围-6到6，不确定时为空。', '没有新变化用neutral和空delta。', '拿不准时用neutral和空delta']) {
    assert.ok(tail.includes(rule), `tail: ${rule}`);
    assert.ok(judge.includes(rule), `judge: ${rule}`);
  }
});

test('the warm step prompt says it is the book, not a reaction, then the judge\'s own system text and the same prompt', () => {
  const prompt = speakOnlyJudgePrompt({ userText: '你好', reply: '你好呀', moodNow: '', persona: '' });
  const step = speakOnlyWarmStepPrompt(prompt);
  assert.ok(step.startsWith('【记心情账】'));
  assert.ok(step.includes('不写event和reactions'));
  assert.ok(step.includes(SPEAK_ONLY_JUDGE_SYSTEM));
  assert.ok(step.endsWith(prompt));
});

// ---------------------------------------------------------------- the route (fake ports)

function fakePort(over: Partial<{ alive: boolean; calling: boolean; idle: () => Promise<void>; ask: (prompt: string, signal: AbortSignal) => Promise<string> }> = {}) {
  const state = { alive: over.alive ?? true, calling: over.calling ?? false, asked: [] as string[] };
  const port: SpeakOnlyWarmPort = { alive: () => state.alive, calling: () => state.calling, idle: over.idle ?? (async () => {}),
    ask: over.ask ?? (async prompt => { state.asked.push(prompt); return JUDGE_TIRED; }) };
  return { port, state };
}

test('route: no reaction judge (or its warm haiku is not alive): the one-off call, as before', async () => {
  for (const warm of [() => null, () => fakePort({ alive: false }).port, () => { throw new Error('gone'); }]) {
    const calls: string[] = [];
    const ask = speakOnlyRoute({ oneShot: async (prompt, system) => { calls.push(system); return prompt.length ? JUDGE_TIRED : ''; }, warm });
    assert.deepEqual(await ask('提示', SPEAK_ONLY_JUDGE_SYSTEM, new AbortController().signal), { text: JUDGE_TIRED, via: 'one-shot' });
    assert.deepEqual(calls, [SPEAK_ONLY_JUDGE_SYSTEM]);
  }
});

test('route: with a warm haiku, the book is one step on it (the warm step prompt), never also a one-off call', async () => {
  let oneShot = 0;
  const { port, state } = fakePort();
  const ask = speakOnlyRoute({ oneShot: async () => { oneShot++; return ''; }, warm: () => port });
  assert.deepEqual(await ask('提示', SPEAK_ONLY_JUDGE_SYSTEM, new AbortController().signal), { text: JUDGE_TIRED, via: 'warm' });
  assert.deepEqual(state.asked, [speakOnlyWarmStepPrompt('提示')]);
  assert.equal(oneShot, 0);
  // A failed step is the book's failure: no second (one-off) call.
  const failing = fakePort({ ask: async () => { throw new Error('broken'); } });
  const ask2 = speakOnlyRoute({ oneShot: async () => { oneShot++; return ''; }, warm: () => failing.port });
  await assert.rejects(ask2('提示', SPEAK_ONLY_JUDGE_SYSTEM, new AbortController().signal));
  assert.equal(oneShot, 0);
});

test('route: waits for this message\'s reaction call; a newer message (abort) ends the wait with no call at all', async () => {
  const idle = deferred<void>();
  let oneShot = 0;
  const { port, state } = fakePort({ idle: () => idle.promise });
  const ask = speakOnlyRoute({ oneShot: async () => { oneShot++; return ''; }, warm: () => port });
  const answer = ask('提示', SPEAK_ONLY_JUDGE_SYSTEM, new AbortController().signal);
  await flush();
  assert.deepEqual(state.asked, [], 'not while the reaction call runs');
  idle.resolve();
  assert.equal((await answer).via, 'warm');
  assert.equal(state.asked.length, 1);
  // Aborted while waiting.
  const never = deferred<void>(), controller = new AbortController();
  const waiting = fakePort({ idle: () => never.promise });
  const ask2 = speakOnlyRoute({ oneShot: async () => { oneShot++; return ''; }, warm: () => waiting.port });
  const pending = ask2('提示', SPEAK_ONLY_JUDGE_SYSTEM, controller.signal);
  await flush();
  controller.abort();
  await assert.rejects(pending);
  assert.equal(waiting.state.asked.length, 0);
  assert.equal(oneShot, 0);
  // The warm haiku went away (or is busy with a newer call) while waiting: the one-off call instead.
  const gone = fakePort();
  const ask3 = speakOnlyRoute({ oneShot: async () => { oneShot++; return JUDGE_TIRED; }, warm: () => gone.port });
  gone.port.idle = async () => { gone.state.alive = false; };
  assert.equal((await ask3('提示', SPEAK_ONLY_JUDGE_SYSTEM, new AbortController().signal)).via, 'one-shot');
  assert.equal(oneShot, 1);
});

// ---------------------------------------------------------------- the real reactions wiring (fake processes, fake clock)

class Clock {
  now = Date.UTC(2026, 10, 12, 12, 0, 0); private timers: { at: number; fn: () => void; id: number }[] = []; private next = 0;
  readonly api = { set: (fn: () => void, ms: number) => { const id = ++this.next; this.timers.push({ at: this.now + Math.max(0, ms), fn, id }); return id; },
    clear: (id: unknown) => { this.timers = this.timers.filter(t => t.id !== id); } };
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      await flush();
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const due = this.timers[0];
      if (!due || due.at > end) break;
      this.timers.shift(); this.now = Math.max(this.now, due.at); due.fn();
    }
    this.now = end;
    await flush();
  }
}

class FakeProcess implements WarmProcess {
  alive = true; busy = false; lines: string[] = [];
  private live: { resolve(result: ClaudeTurnResult): void; reject(error: Error): void; emit(type: 'delta', text: string): void } | null = null;
  constructor(readonly systemPrompt: string) {}
  settled(): Promise<void> { return Promise.resolve(); }
  runTurn(line: string, signal: AbortSignal, emit: (type: any, text: string) => void): Promise<ClaudeTurnResult> {
    if (!this.alive) return Promise.reject(new ClaudeTurnError('gone', 'crash'));
    if (this.live) return Promise.reject(new ClaudeTurnError('busy', 'failed'));
    this.lines.push(line); this.busy = true;
    return new Promise((resolve, reject) => {
      this.live = { resolve, reject, emit };
      signal.addEventListener('abort', () => { this.live = null; this.busy = false; reject(new Error('stopped')); }, { once: true });
    });
  }
  get running(): boolean { return !!this.live; }
  answer(text: string): void { const live = this.live!; this.live = null; this.busy = false; live.emit('delta', text); live.resolve({ output: text, superseded: false }); }
  close(): void { this.alive = false; if (this.live) { const live = this.live; this.live = null; live.reject(new ClaudeTurnError('closed', 'closed')); } }
}

function moodPort(lifts: string[]): ReactionMoodPort {
  const values: MoodValues = { D: 50, O: 50, E: 50, N: 50, C: 50 };
  const view = { characterId: 'heroine', expressions: true, parameters: DEFAULT_MOOD_PARAMETERS, snapshot: { primary: 'calm', values, phase: 'idle', intensity: DEFAULT_MOOD_PARAMETERS.intensity, blush: null },
    fatigue: { phase: 'awake' } } as unknown as MoodView;
  return { get: () => view, isTestMoodActive: () => false, setReactionPort: () => {}, reactionBlush: () => ({ done: true }), lift: lift => { lifts.push(lift.id); } };
}

async function warmApp(t: TestContext, speakOnly = true) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'i098-on-'));
  const clock = new Clock(), processes: FakeProcess[] = [], lifts: string[] = [];
  const oneShotReactions = new FakeReactionJudge(REACTION_NONE);
  const app = createReactions({ directory: () => directory, defaultEnabled: true, speakOnly, mood: () => moodPort(lifts), persona: () => '', petVisible: () => true, available: () => true,
    actions: () => null, stage: () => true, ask: oneShotReactions.ask, chatBusy: () => false,
    host: { clock: () => clock.now, timers: clock.api },
    warmLine: { binary: async () => 'x', clock: () => clock.now, timers: clock.api, startProcess: async o => { const p = new FakeProcess(o.systemPrompt); processes.push(p); return p; } } });
  await app.load();
  await clock.advance(20 * SECOND); // started (REACTION_WARM_STARTUP_MS) and booted
  t.after(async () => { await app.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { app, clock, processes, lifts, oneShotReactions };
}

test('wiring: one message = the reaction call early, then the book as a second step on the same warm process (no new process, no one-off call)', async (t: TestContext) => {
  const w = await warmApp(t);
  assert.equal(w.processes.length, 1);
  assert.equal(w.app.warm?.ready, true);
  let oneShot = 0;
  const judge = new SpeakOnlyJudge({ ask: speakOnlyRoute({ oneShot: async () => { oneShot++; return JUDGE_TIRED; }, warm: () => w.app.speakOnlyWarm() }) });
  const p = w.processes[0];
  w.app.userTurn('m1', '今天加班到十点，好累');
  judge.begin('m1');
  await w.clock.advance(REACTION_KNOBS.startDelayMs);
  assert.equal(p.lines.length, 1, 'the reaction call goes early, beside her reply');
  // Her reply completes while the reaction call still runs: the book waits for it.
  const judged = judge.judge('m1', { userText: '今天加班到十点，好累', reply: '辛苦了，快歇歇。', moodNow: '', persona: '' });
  await flush();
  assert.equal(p.lines.length, 1, 'the book never takes the process from the reaction call');
  p.answer(REACTION_LIFT);
  await flush();
  assert.deepEqual(w.lifts, ['reaction-mood-m1'], 'the reaction\'s share landed first');
  assert.equal(p.lines.length, 2, 'then the book, on the same process');
  assert.ok(p.lines[1].includes('【记心情账】') && p.lines[1].includes('辛苦了，快歇歇。'));
  p.answer(JUDGE_TIRED);
  const outcome = await judged;
  assert.equal(outcome.kind, 'judged');
  assert.equal(outcome.kind === 'judged' && outcome.via, 'warm');
  assert.equal(outcome.kind === 'judged' && outcome.judgment.userState?.state, 'tired');
  assert.equal(w.processes.length, 1, 'no process was started for the book');
  assert.equal(oneShot, 0);
  assert.equal(w.oneShotReactions.calls, 0);
  assert.equal(w.app.host.stats.asked, 1, 'one reaction call');
});

test('wiring: a reply that completes before the reaction call started: the reaction call still goes first', async (t: TestContext) => {
  const w = await warmApp(t);
  const judge = new SpeakOnlyJudge({ ask: speakOnlyRoute({ oneShot: async () => JUDGE_TIRED, warm: () => w.app.speakOnlyWarm() }) });
  const p = w.processes[0];
  w.app.userTurn('m2', '你好');
  judge.begin('m2');
  const judged = judge.judge('m2', { userText: '你好', reply: '嗯', moodNow: '', persona: '' });
  await flush();
  assert.equal(p.lines.length, 0, 'the book waits while the reaction call is still to come');
  await w.clock.advance(REACTION_KNOBS.startDelayMs);
  assert.equal(p.lines.length, 1);
  assert.ok(!p.lines[0].includes('【记心情账】'), 'the first call is the reaction call');
  p.answer(REACTION_NONE);
  await flush();
  assert.equal(p.lines.length, 2);
  p.answer(JUDGE_TIRED);
  assert.equal((await judged).kind, 'judged');
});

test('wiring: the reaction judge off: the book is the one-off call; speak-only doubles the warm process\'s call limit', async (t: TestContext) => {
  const w = await warmApp(t);
  w.app.setEnabled(false);
  let oneShot = 0;
  const judge = new SpeakOnlyJudge({ ask: speakOnlyRoute({ oneShot: async () => { oneShot++; return JUDGE_TIRED; }, warm: () => w.app.speakOnlyWarm() }) });
  judge.begin('m3');
  const outcome = await judge.judge('m3', { userText: '你好', reply: '嗯', moodNow: '', persona: '' });
  assert.equal(outcome.kind === 'judged' && outcome.via, 'one-shot');
  assert.equal(oneShot, 1);
  const limits = (app: unknown) => (app as { warm: { limits: { maxTurns: number } } }).warm.limits.maxTurns;
  assert.equal(limits(w.app), WARM_LINE_DEFAULTS.maxTurns * 2);
  const plain = await warmApp(t, false);
  assert.equal(limits(plain.app), WARM_LINE_DEFAULTS.maxTurns);
});

test('wiring: a newer message aborts the book still waiting; its reaction call and book come next, in order', async (t: TestContext) => {
  const w = await warmApp(t);
  let oneShot = 0;
  const judge = new SpeakOnlyJudge({ ask: speakOnlyRoute({ oneShot: async () => { oneShot++; return JUDGE_TIRED; }, warm: () => w.app.speakOnlyWarm() }) });
  const p = w.processes[0];
  w.app.userTurn('a', '第一句'); judge.begin('a');
  await w.clock.advance(REACTION_KNOBS.startDelayMs);
  const first = judge.judge('a', { userText: '第一句', reply: '嗯', moodNow: '', persona: '' });
  await flush();
  w.app.userTurn('b', '第二句'); judge.begin('b'); // the reaction host supersedes 'a' (its call aborted); the judge aborts a's wait
  assert.equal((await first).kind, 'superseded');
  await w.clock.advance(REACTION_KNOBS.startDelayMs);
  assert.equal(p.lines.length, 2, 'b\'s reaction call');
  const second = judge.judge('b', { userText: '第二句', reply: '嗯嗯', moodNow: '', persona: '' });
  p.answer(REACTION_NONE);
  await flush();
  assert.equal(p.lines.length, 3);
  p.answer(JUDGE_TIRED);
  assert.equal((await second).kind, 'judged');
  assert.equal(oneShot, 0);
  assert.equal(p.lines.filter(line => line.includes('【记心情账】')).length, 1, 'only b\'s book was asked');
});

test('wiring: a spoken message while the book still runs: its reaction call waits for the book instead of failing', async (t: TestContext) => {
  const w = await warmApp(t);
  const judge = new SpeakOnlyJudge({ ask: speakOnlyRoute({ oneShot: async () => JUDGE_TIRED, warm: () => w.app.speakOnlyWarm() }) });
  const p = w.processes[0];
  w.app.userTurn('t1', '打字的一句'); judge.begin('t1');
  await w.clock.advance(REACTION_KNOBS.startDelayMs);
  p.answer(REACTION_NONE);
  const book = judge.judge('t1', { userText: '打字的一句', reply: '嗯', moodNow: '', persona: '' });
  await flush();
  assert.equal(p.lines.length, 2, 'the book runs');
  w.app.userTurn('v1', '说出来的一句'); // a voice turn: the companion's judge is not told
  await w.clock.advance(REACTION_KNOBS.startDelayMs);
  assert.equal(p.lines.length, 2, 'the reaction call waits for the book');
  p.answer(JUDGE_TIRED);
  assert.equal((await book).kind, 'judged');
  await flush();
  assert.equal(p.lines.length, 3, 'then the reaction call');
  p.answer(REACTION_NONE);
  await flush();
  assert.equal(w.app.host.stats.answered, 2);
  assert.equal(w.app.host.stats.failed, 0);
});

// ---------------------------------------------------------------- the companion: user state as the tail's, the journal line

async function withService(run: (service: CompanionService, lines: JournalInput[]) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'i098-on-companion-'));
  const lines: JournalInput[] = [];
  const service = new CompanionService(directory, () => {}, { journal: { record: input => { lines.push(input); } } });
  try { await service.load(); await service.context('gene', provider, 'Gene'); await run(service, lines); }
  finally { await service.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}

test('the judge\'s user field is applied as the tail\'s was (same store, same state), and both write a mood-book line', async () => {
  let viaJudge: unknown, viaTail: unknown;
  await withService(async (service, lines) => {
    service.setSpeakOnly(speakOnlyAppJudge(true, async () => JUDGE_TIRED, () => null));
    const turn = await service.begin('u-1', '今天加班到十点，好累', 'Gene', () => {});
    turn.push('delta', '辛苦了，快歇歇。');
    await turn.finish('complete');
    assert.equal((await turn.speakOnlyJudged!())?.kind, 'judged');
    viaJudge = service.userState.view('gene')?.state;
    const book = lines.filter(line => line.type === 'mood-book');
    assert.deepEqual(book, [{ type: 'mood-book', characterId: 'gene', by: 'judge', outcome: 'judged', via: 'one-shot', context: 'concern', delta: { O: 2, C: 1 }, user: true,
      ms: (book[0] as { ms: number }).ms, turn: 'u-1', now: (book[0] as { now: unknown }).now }]);
    assert.deepEqual(Object.keys((book[0] as unknown as { now: object }).now).sort(), ['A', 'B', 'F', 'M', 'label', 'phase', 'values'], 'I-179: the line also carries her whole mood then');
    assert.ok(lines.some(line => line.type === 'user-state' && line.state === 'tired'), 'the user-state line, as with the tail');
  });
  await withService(async (service, lines) => {
    const turn = await service.begin('u-2', '今天加班到十点，好累', 'Gene', () => {});
    const marker = turn.persona.match(/<sh-state-[a-f0-9]+>/u)![0];
    const tail = JSON.parse(JUDGE_TIRED);
    turn.push('delta', `辛苦了，快歇歇。\n${marker}${JSON.stringify(tail)}${marker.replace('<', '</')}`);
    await turn.finish('complete');
    viaTail = service.userState.view('gene')?.state;
    const tailBook = lines.filter(line => line.type === 'mood-book') as { now?: unknown }[];
    assert.deepEqual(tailBook, [{ type: 'mood-book', characterId: 'gene', by: 'tail', outcome: 'judged', context: 'concern', delta: { O: 2, C: 1 }, user: true, turn: 'u-2', now: tailBook[0]?.now }]);
  });
  assert.equal(viaJudge, 'tired');
  assert.equal(viaTail, viaJudge);
});

test('an unusable or superseded book still writes its line (no numbers)', async () => {
  await withService(async (service, lines) => {
    service.setSpeakOnly(speakOnlyAppJudge(true, async () => JSON.stringify({ context: 'positive', delta: { E: 9 }, reason: 'x', confidence: 0.9 }), () => null));
    const turn = await service.begin('x-1', '你好', 'Gene', () => {});
    turn.push('delta', '你好呀');
    await turn.finish('complete');
    assert.equal((await turn.speakOnlyJudged!())?.kind, 'unusable');
    const book = lines.filter(line => line.type === 'mood-book') as Extract<JournalInput, { type: 'mood-book' }>[];
    assert.equal(book.length, 1);
    assert.equal(book[0].outcome, 'unusable');
    assert.equal(book[0].delta, undefined);
  });
});

// ---------------------------------------------------------------- the journal line

test('journal: the mood-book line keeps closed values and numbers only, and reads in both languages', () => {
  const at = Date.UTC(2026, 10, 12, 10, 0, 0);
  const judged = judgeBookInput('gene', { kind: 'judged', ms: 912.4, via: 'warm', raw: '秘密的原文', judgment: { appraisal: { context: 'positive', delta: { D: 2, E: 1.25 }, reason: '原因原文', gesture: 'none' }, userState: null, chatAction: null } });
  const entry = buildJournalEntry(judged, at)!;
  assert.ok(entry);
  const text = JSON.stringify(entry);
  for (const word of ['秘密的原文', '原因原文']) assert.ok(!text.includes(word));
  assert.deepEqual({ ...entry, v: undefined, at: undefined, time: undefined }, { ...judged, delta: { D: 2, E: 1.3 }, ms: 912, reason: '记了一笔心情账', v: undefined, at: undefined, time: undefined });
  const plain = (source: string, ...values: readonly unknown[]) => source.replace(/\{(\d+)\}/gu, (_m, i) => String(values[Number(i)]));
  const zh = describeJournalEntry(entry, plain);
  assert.match(zh, /^[0-9]{2}:[0-9]{2} /u);
  assert.equal(zh.slice(6), '记了一笔心情账（haiku 在她说完后记，待命的 haiku 接着问，开心，D+2 E+1.3，0.9 秒）');
  const en = describeJournalEntry(entry, (source: string, ...values: readonly unknown[]) => {
    assert.ok(ENGLISH_JOURNAL_UI_COPY[source] !== undefined || /^[\s\dDOENC+.-]*$/u.test(source), `English copy: ${source}`);
    return (ENGLISH_JOURNAL_UI_COPY[source] ?? source).replace(/\{(\d+)\}/gu, (_m, i) => String(values[Number(i)]));
  });
  assert.ok(en.slice(6).startsWith('Her mood was booked for this message ('), en);
  const tail = buildJournalEntry(tailBookInput('gene', { context: 'neutral', delta: {} }, { state: 'calm', confidence: 0.8, reason: '' }), at)!;
  assert.ok(describeJournalEntry(tail, plain).endsWith('记了一笔心情账（她自己写的尾注，平常，心情数不动，写了你的状态）'));
  for (const outcome of ['failed', 'capped', 'superseded'] as const) assert.ok(buildJournalEntry(judgeBookInput('gene', outcome === 'failed' ? { kind: outcome, ms: 3 } : { kind: outcome }), at));
  // Refused: a delta outside D/O/E/N/C or ±6, an unknown outcome, numbers on a line without an answer, a tail with a via.
  for (const bad of [
    { ...judged, delta: { A: 1 } }, { ...judged, delta: { E: 7 } }, { ...judged, outcome: 'great' }, { ...judged, by: 'opus' },
    { type: 'mood-book', characterId: 'gene', by: 'judge', outcome: 'failed', delta: { E: 1 } }, { ...tailBookInput('gene', { context: 'neutral', delta: {} }, null), via: 'warm' },
    { ...judged, context: '秘密' },
  ]) assert.equal(buildJournalEntry(bad, at), null, JSON.stringify(bad));
});
