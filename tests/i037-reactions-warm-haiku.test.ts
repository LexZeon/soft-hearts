/**
 * I-037 reactions, the warm haiku (electron/inner-loop/warm-line.ts, docs/claude/2026-11-07-reactions-warm-haiku.md). Never a real
 * model call: fake processes on a fake clock, and a stand-in Claude Code script (stream-json, no network) for the real-process parts.
 *
 * What it pins: the warm process starts only when wanted, allowed and not busy (never at the moment of a message), is reused across
 * calls, counts as ready only after its boot, retires after maxTurns and is rebuilt only when quiet, is dropped after a failed call
 * and rebuilt when quiet (with a failure cap), keeps its process after the caller's own abort, closes when idle, on stop() and on
 * dispose() (a start still in flight is closed too); a real process is gone after dispose(). The reactions host asks a ready warm
 * haiku knobs.startDelayMs after the message without waiting for her first character, falls back to waiting for it when no warm
 * haiku is ready (or it went away meanwhile, or knobs.warmParallel is off), and still asks at most once per message. The app wiring
 * starts nothing while the switch is off, stops it when switched off and disposes it on quit. With stand-in processes on real
 * timers, her first character does not wait for haiku.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WarmLine, type WarmLineOptions, type WarmProcess } from '../electron/inner-loop/warm-line';
import { ClaudeChatProcess, ClaudeTurnError, type ClaudeTurnResult } from '../electron/claude-process';
import { claudeInput, claudeCallsInFlight } from '../electron/claude';
import { ReactionHost, type ReactionHostOptions, type ReactionNowSource } from '../electron/reactions/host';
import { createReactions, type ReactionMoodPort, type ReactionWarmPort } from '../electron/reactions/wiring';
import { FakeReactionJudge } from '../shared/behaviors/reactions/fake';
import { REACTION_KNOBS } from '../shared/behaviors/reactions/knobs';
import type { Dispositions } from '../shared/behaviors/reactions/dispositions';
import type { ReactionPerformer } from '../shared/behaviors/reactions/interface';
import { DEFAULT_MOOD_PARAMETERS, type MoodValues } from '../shared/mood';
import type { MoodView } from '../shared/mood-runtime';

const SECOND = 1_000;
/** Invented numbers (no real character's). */
const SIX: Dispositions = Object.freeze({ shy: 62, clingy: 45, lively: 55, soothable: 50, volatile: 40, restrained: 48 });

class Clock {
  now = Date.UTC(2026, 10, 7, 12, 0, 0); private timers: { at: number; fn: () => void; id: number }[] = []; private next = 0;
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
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

/** A stand-in process: records written lines; answer()/fail() end the live turn; abort rejects at once and drains. */
class FakeProcess implements WarmProcess {
  alive = true; busy = false; closed = 0; lines: string[] = [];
  private live: { resolve(result: ClaudeTurnResult): void; reject(error: Error): void; emit(type: 'delta', text: string): void } | null = null;
  constructor(readonly systemPrompt: string, readonly model: string) {}
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
  answer(text: string): void { const live = this.live!; this.live = null; this.busy = false; live.emit('delta', text); live.resolve({ output: text, superseded: false }); }
  fail(): void { const live = this.live!; this.live = null; this.busy = false; live.reject(new ClaudeTurnError('broken', 'failed')); }
  close(): void { this.closed++; this.alive = false; if (this.live) { const live = this.live; this.live = null; live.reject(new ClaudeTurnError('closed', 'closed')); } }
}

function warmWorld(clock: Clock, extra: Partial<WarmLineOptions> = {}) {
  const state = { allowed: true, busy: false, system: '系统提示词A', failStart: false };
  const processes: FakeProcess[] = [];
  const line = new WarmLine({
    systemPrompt: () => state.system, allowed: () => state.allowed, busy: () => state.busy, binary: async () => 'claude-test',
    startProcess: async options => {
      if (state.failStart) throw new Error('cannot start');
      const p = new FakeProcess(options.systemPrompt, options.model); processes.push(p); return p;
    },
    clock: () => clock.now, timers: clock.api, bootMs: 4 * SECOND, retryMs: 5 * SECOND, idleMs: 10 * 60 * SECOND, maxTurns: 3, ...extra,
  });
  return { line, state, processes };
}

// ---------------------------------------------------------------- WarmLine

test('warm line: starts only when wanted, allowed and not busy; ready only after its boot; one process serves many calls', async () => {
  const clock = new Clock(), w = warmWorld(clock);
  await clock.advance(60 * SECOND);
  assert.equal(w.processes.length, 0, 'nothing until want()');
  w.state.busy = true;
  w.line.want();
  await clock.advance(4 * SECOND);
  assert.equal(w.processes.length, 0, 'never right at want(): first after its delay');
  await clock.advance(20 * SECOND);
  assert.equal(w.processes.length, 0, 'never while her reply runs');
  w.state.busy = false; w.state.allowed = false;
  await clock.advance(20 * SECOND);
  assert.equal(w.processes.length, 0, 'never while not allowed (switch off, hidden, Claude down)');
  w.state.allowed = true;
  for (let i = 0; i < 60 && !w.processes.length; i++) await clock.advance(100);
  assert.equal(w.processes.length, 1);
  assert.equal(w.processes[0].model, 'haiku'); assert.equal(w.processes[0].systemPrompt, '系统提示词A');
  assert.equal(w.line.alive, true); assert.equal(w.line.ready, false, 'still booting');
  await clock.advance(4 * SECOND);
  assert.equal(w.line.ready, true);
  for (const word of ['一', '二']) {
    const call = w.line.ask(`提示${word}`, new AbortController().signal);
    await flush();
    w.processes[0].answer(`{"答":"${word}"}`);
    assert.equal(await call, `{"答":"${word}"}`);
  }
  assert.equal(w.processes.length, 1, 'reused');
  assert.deepEqual(w.processes[0].lines, [claudeInput({ prompt: '提示一', imageDataUrls: [] }), claudeInput({ prompt: '提示二', imageDataUrls: [] })]);
  // A different system prompt is never served by this process.
  w.state.system = '系统提示词B';
  assert.equal(w.line.ready, false); assert.equal(w.line.alive, false);
  await clock.advance(6 * SECOND);
  assert.equal(w.processes[0].closed, 1); assert.equal(w.processes.length, 2); assert.equal(w.processes[1].systemPrompt, '系统提示词B');
});

test('warm line: retires after maxTurns, rebuilt only when quiet; a failed call drops it and it is rebuilt when quiet, up to the failure cap', async () => {
  const clock = new Clock(), w = warmWorld(clock);
  w.line.want(0); await clock.advance(5 * SECOND);
  const ask = async (text: string) => { const call = w.line.ask(text, new AbortController().signal); await flush(); w.processes.at(-1)!.answer('ok'); return call; };
  for (let i = 0; i < 3; i++) await ask(`第${i}句`);
  assert.equal(w.line.ready, false, 'due to retire after maxTurns');
  assert.equal(w.line.alive, true, 'still usable for a call that does not race her first character');
  w.state.busy = true;
  await clock.advance(30 * SECOND);
  assert.equal(w.processes[0].closed, 0, 'not retired while her reply runs');
  w.state.busy = false;
  await clock.advance(5 * SECOND);
  assert.equal(w.processes[0].closed, 1); assert.equal(w.processes.length, 2);
  await clock.advance(4 * SECOND);
  assert.equal(w.line.ready, true);
  // A failed call: the process is not trusted again.
  const call = w.line.ask('坏的一句', new AbortController().signal); await flush();
  w.processes[1].fail();
  await assert.rejects(call);
  assert.equal(w.processes[1].closed, 1); assert.equal(w.line.alive, false);
  w.state.busy = true; await clock.advance(30 * SECOND);
  assert.equal(w.processes.length, 2, 'rebuilt only when quiet');
  w.state.busy = false; await clock.advance(5 * SECOND);
  assert.equal(w.processes.length, 3);
  // Starts that fail stop after the cap (3 failures in a row: the failed call counted as one).
  w.processes[2].close();
  w.state.failStart = true;
  await clock.advance(5 * 60 * SECOND);
  assert.equal(w.processes.length, 3);
  assert.equal(w.line.holding, false, 'gave up');
  w.state.failStart = false;
  await clock.advance(60 * SECOND);
  assert.equal(w.processes.length, 3, 'still given up until want(reset)');
  w.line.want(0, true); await clock.advance(1);
  assert.equal(w.processes.length, 4);
});

test('warm line: the caller\'s own abort keeps the process; idle closes it and nothing starts until want(); stop and dispose close it', async () => {
  const clock = new Clock(), w = warmWorld(clock);
  w.line.want(0); await clock.advance(5 * SECOND);
  const controller = new AbortController();
  const call = w.line.ask('一句', controller.signal); await flush();
  controller.abort();
  await assert.rejects(call);
  assert.equal(w.processes[0].closed, 0); assert.equal(w.line.ready, true);
  await assert.rejects(w.line.ask('二', AbortSignal.abort()), 'an already-stopped call writes nothing');
  assert.equal(w.processes[0].lines.length, 1);
  await clock.advance(10 * 60 * SECOND + 30 * SECOND);
  assert.equal(w.processes[0].closed, 1, 'idle');
  await clock.advance(30 * 60 * SECOND);
  assert.equal(w.processes.length, 1, 'not wanted after idle');
  await assert.rejects(w.line.ask('三', new AbortController().signal), 'no process: the caller makes its own call');
  w.line.want(); await clock.advance(5 * SECOND);
  assert.equal(w.processes.length, 2);
  w.line.stop();
  assert.equal(w.processes[1].closed, 1);
  await clock.advance(60 * SECOND);
  assert.equal(w.processes.length, 2, 'stopped: nothing more');
  // A start in flight when the app quits is closed as soon as it arrives.
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const late: FakeProcess[] = [];
  const d = new WarmLine({ systemPrompt: () => 's', allowed: () => true, binary: async () => 'x', clock: () => clock.now, timers: clock.api,
    startProcess: async options => { await gate; const p = new FakeProcess(options.systemPrompt, options.model); late.push(p); return p; } });
  d.want(0); await clock.advance(1);
  assert.equal(d.holding, true);
  d.dispose(); release(); await flush();
  assert.equal(late.length, 1); assert.equal(late[0].closed, 1); assert.equal(d.holding, false);
  d.want(0); await clock.advance(60 * SECOND);
  assert.equal(late.length, 1, 'disposed for good');
});

// ---------------------------------------------------------------- the host

/** knobs.warmParallel on (the default since the second 10-pair A/B; spelled out so these tests do not depend on the default). */
const PARALLEL = { knobs: { warmParallel: true } } as const;

function hostWorld(clock: Clock, ask: FakeReactionJudge, options: Partial<ReactionHostOptions> = {}) {
  const store = { enabled: true, calls: 0, chats: 0, today: () => store.calls, noteCall: () => ++store.calls, chatsToday: () => store.chats, noteChat: () => ++store.chats };
  const now = (): ReactionNowSource => ({ characterId: 'heroine', dispositions: SIX, mood: 'calm', moodWords: '平静', fatigue: '', sleepy: false, values: null, persona: '安静' });
  const quietPerformer: ReactionPerformer = { stage: false, gate: () => null, perform: () => ({ done: true }) };
  const host = new ReactionHost({ ask: ask.ask, store, now, quiet: () => null, performers: { blush: quietPerformer, shy: quietPerformer, happy: quietPerformer, action: quietPerformer },
    lift: () => {}, clock: () => clock.now, timers: clock.api, random: () => 0.5, localDate: () => 'day', ...options });
  return { host, store };
}

test('host, knobs.warmParallel on: a ready warm haiku is asked knobs.startDelayMs after the message without waiting for her first character; once per message', async () => {
  const clock = new Clock(), ask = new FakeReactionJudge({ hang: true });
  const warm = { ready: true }, signals: AbortSignal[] = [];
  const w = hostWorld(clock, ask, { ...PARALLEL, warm: () => warm.ready, ask: (prompt, system, signal) => { signals.push(signal); return ask.ask(prompt, system, signal); } });
  w.host.userTurn('m1', '你今天好可爱');
  await clock.advance(REACTION_KNOBS.startDelayMs - 1);
  assert.equal(ask.calls, 0, 'never before knobs.startDelayMs');
  await clock.advance(1);
  assert.equal(ask.calls, 1, 'beside her reply, no first character yet');
  w.host.firstChar('m1'); w.host.firstChar('m1');
  await clock.advance(5 * SECOND);
  assert.equal(ask.calls, 1, 'her first character starts nothing more');
  assert.equal(w.host.stats.parallel, 1); assert.equal(w.host.stats.afterFirstChar, 0);
  // The next message supersedes the older call (aborted) and is asked once.
  w.host.userTurn('m2', '真的'); await clock.advance(REACTION_KNOBS.startDelayMs);
  assert.equal(ask.calls, 2); assert.equal(w.host.stats.superseded, 1);
  assert.equal(signals[0].aborted, true);
});

test('host (X-342): the same message id again is neither counted nor judged again, while waiting, after an answer or after a timeout', async () => {
  for (const after of ['waiting', 'answered', 'timeout'] as const) {
    const clock = new Clock(), ask = new FakeReactionJudge(after === 'timeout' ? { hang: true } : JSON.stringify({ event: 'none', reactions: [], delta: {}, confidence: 0.9 }));
    const w = hostWorld(clock, ask, { ...PARALLEL, warm: () => true });
    w.host.userTurn('m1', '你今天好可爱');
    if (after !== 'waiting') await clock.advance(REACTION_KNOBS.startDelayMs + (after === 'timeout' ? REACTION_KNOBS.timeoutMs : 0) + SECOND);
    w.host.userTurn('m1', '你今天好可爱'); w.host.firstChar('m1');
    await clock.advance(REACTION_KNOBS.timeoutMs + 2 * SECOND);
    assert.equal(ask.calls, 1, after); assert.equal(w.store.chats, 1, after);
    assert.equal(w.host.stats.superseded, 0, `${after}: the repeat does not cut the first one short`);
    w.host.userTurn('m2', '真的'); await clock.advance(REACTION_KNOBS.startDelayMs);
    assert.equal(ask.calls, 2, `${after}: a new message is judged`);
  }
});

test('host (X-342): quiet by the time the judge would start (自动表现 off, asleep, hidden) means no call; off or asleep also records no reaction', async () => {
  for (const quietNow of ['off', 'asleep', 'hidden'] as const) {
    for (const parallel of [true, false]) {
      const clock = new Clock(), ask = new FakeReactionJudge({ hang: true });
      let quiet: 'off' | 'asleep' | 'hidden' | null = null;
      const recorded: string[] = [];
      const w = hostWorld(clock, ask, { ...(parallel ? PARALLEL : {}), warm: () => parallel, quiet: () => quiet, journal: entry => { recorded.push(`${entry.event}/${entry.haiku}`); } });
      w.host.userTurn('m1', '你今天好可爱');
      await clock.advance(REACTION_KNOBS.startDelayMs - 100);
      quiet = quietNow;
      w.host.firstChar('m1');
      await clock.advance(REACTION_KNOBS.firstCharWaitMs + SECOND);
      assert.equal(ask.calls, 0, `${quietNow} ${parallel}`);
      assert.deepEqual(recorded, quietNow === 'hidden' ? [] : ['none/quiet'], `${quietNow} ${parallel}`);
    }
  }
});

test('host: knobs.warmParallel off, or no ready warm haiku (none, went away meanwhile): asked only after her first character', async () => {
  assert.equal(REACTION_KNOBS.warmParallel, true, 'default on since the second 10-pair A/B (20 pairs: her first character 44 ms slower per pair, 11 of 20)');
  for (const variant of ['none', 'gone', 'off'] as const) {
    const clock = new Clock(), ask = new FakeReactionJudge({ hang: true });
    const warm = { ready: variant !== 'none' };
    const w = hostWorld(clock, ask, { warm: () => warm.ready, ...(variant === 'off' ? { knobs: { warmParallel: false } } : PARALLEL) });
    w.host.userTurn('m1', '你今天好可爱');
    if (variant === 'gone') warm.ready = false;
    await clock.advance(2 * SECOND);
    assert.equal(ask.calls, 0, `${variant}: her first character goes first`);
    w.host.firstChar('m1');
    await clock.advance(REACTION_KNOBS.startDelayMs);
    assert.equal(ask.calls, 1, variant);
    assert.equal(w.host.stats.afterFirstChar, 1, variant);
    if (variant === 'gone') assert.equal(w.host.stats.demoted, 1);
  }
  // Went away after her first character already showed: asked right then (no process raced her first character).
  const clock = new Clock(), ask = new FakeReactionJudge({ hang: true });
  const warm = { ready: true };
  const w = hostWorld(clock, ask, { ...PARALLEL, warm: () => warm.ready });
  w.host.userTurn('m1', '一'); w.host.firstChar('m1'); warm.ready = false;
  await clock.advance(REACTION_KNOBS.startDelayMs);
  assert.equal(ask.calls, 1); assert.equal(w.host.stats.demoted, 1);
  // No first character at all (a spoken turn): knobs.firstCharWaitMs after the message.
  const c2 = new Clock(), a2 = new FakeReactionJudge({ hang: true }), w2 = hostWorld(c2, a2, { ...PARALLEL, warm: () => false });
  w2.host.userTurn('v', '你好'); await c2.advance(REACTION_KNOBS.firstCharWaitMs - 1);
  assert.equal(a2.calls, 0); await c2.advance(1); assert.equal(a2.calls, 1);
});

// ---------------------------------------------------------------- the app wiring

function moodPort(): ReactionMoodPort {
  const values: MoodValues = { D: 50, O: 50, E: 50, N: 50, C: 50 };
  const view = { characterId: 'heroine', expressions: true, parameters: DEFAULT_MOOD_PARAMETERS, snapshot: { primary: 'calm', values, phase: 'idle', intensity: DEFAULT_MOOD_PARAMETERS.intensity, blush: null },
    fatigue: { phase: 'awake' } } as unknown as MoodView;
  return { get: () => view, isTestMoodActive: () => false, setReactionPort: () => {}, reactionBlush: () => ({ done: true }), lift: () => {} };
}

test('wiring: the switch off starts no warm process; on wants one (never at once); off stops it; quit disposes it; calls go to it when alive', async (t: TestContext) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'i037-warm-wiring-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls: string[] = [];
  const port: ReactionWarmPort & { readyNow: boolean; aliveNow: boolean } = {
    readyNow: false, aliveNow: false, get ready() { return this.readyNow; }, get alive() { return this.aliveNow; },
    want: (delay?: number, reset?: boolean) => { calls.push(`want ${delay ?? '-'} ${reset ?? false}`); },
    ask: async prompt => { calls.push(`warm-ask ${prompt.length > 0}`); return '{"event":"none","reactions":[],"delta":{},"confidence":0.9}'; },
    stop: () => { calls.push('stop'); }, dispose: () => { calls.push('dispose'); },
  };
  const oneShot = new FakeReactionJudge('{"event":"none","reactions":[],"delta":{},"confidence":0.9}');
  const app = createReactions({ directory: () => directory, defaultEnabled: false, mood: () => moodPort(), persona: () => '', petVisible: () => true, available: () => true,
    actions: () => null, stage: () => true, ask: oneShot.ask, warm: port });
  await app.load();
  app.userTurn('m0', '你好');
  assert.deepEqual(calls, [], 'off: nothing is wanted');
  app.setEnabled(true);
  assert.deepEqual(calls, ['want - true']);
  app.userTurn('m1', '你好');
  assert.equal(calls.at(-1), 'want - false', 'each message asks for one again (started later, when quiet)');
  // Calls: to the warm process when it is alive, otherwise a one-off call.
  port.aliveNow = true;
  assert.equal(await app.host['options'].ask('提示', app.host.systemPrompt, new AbortController().signal), '{"event":"none","reactions":[],"delta":{},"confidence":0.9}');
  assert.equal(calls.at(-1), 'warm-ask true');
  port.aliveNow = false;
  await app.host['options'].ask('提示', app.host.systemPrompt, new AbortController().signal);
  assert.equal(oneShot.calls, 1);
  app.setEnabled(false);
  assert.equal(calls.at(-1), 'stop');
  await app.dispose();
  assert.equal(calls.at(-1), 'dispose');
  // The default WarmLine (seams only): nothing while the switch is off, one process once on, gone on quit.
  const clock = new Clock(), processes: FakeProcess[] = [];
  const real = createReactions({ directory: () => directory, defaultEnabled: false, mood: () => moodPort(), persona: () => '', petVisible: () => true, available: () => true,
    actions: () => null, stage: () => true, ask: oneShot.ask, chatBusy: () => false,
    warmLine: { binary: async () => 'x', clock: () => clock.now, timers: clock.api, startProcess: async o => { const p = new FakeProcess(o.systemPrompt, o.model); processes.push(p); return p; } } });
  await real.load(); await clock.advance(5 * 60 * SECOND);
  real.userTurn('m', '你好'); await clock.advance(5 * 60 * SECOND);
  assert.equal(processes.length, 0, 'switch off: no warm process');
  real.setEnabled(true); await clock.advance(10 * SECOND);
  assert.equal(processes.length, 1);
  assert.equal(processes[0].systemPrompt, real.host.systemPrompt, 'started with the reactions\' own system prompt');
  real.setEnabled(false);
  assert.equal(processes[0].closed, 1, 'switched off: closed at once');
  real.setEnabled(true); await clock.advance(10 * SECOND);
  assert.equal(processes.length, 2);
  await real.dispose();
  assert.equal(processes[1].closed, 1, 'quit: closed');
});

// ---------------------------------------------------------------- real processes (a stand-in Claude Code script)

const fakeScript = (verify: string) => `
import { createInterface } from 'node:readline';
import { verifyArguments } from ${JSON.stringify(verify)};
const verdict = verifyArguments(process.argv.slice(2));
const send = event => process.stdout.write(JSON.stringify(event) + '\\n');
let live = null;
createInterface({ input: process.stdin }).on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } });
    if (live) { clearTimeout(live); live = null; send({ type: 'result', subtype: 'error_during_execution', is_error: true }); }
    return;
  }
  if (message.type !== 'user') return;
  if (!verdict.ok) { send({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'fake: ' + verdict.reason }); return; }
  const text = message.message.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const delay = Number(/DELAY=(\\d+)/.exec(text)?.[1] ?? 0);
  const answer = /ANSWER=(.*)$/m.exec(text)?.[1] ?? '{"event":"none","reactions":[],"delta":{},"confidence":0.9}';
  send({ type: 'system', subtype: 'init', model: verdict.model, tools: [], mcp_servers: [] });
  live = setTimeout(() => {
    live = null;
    send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } } });
    send({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
  }, delay);
});
`;

async function standIn(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'i037-warm-real-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  const script = path.join(root, 'claude.mjs');
  await writeFile(script, fakeScript(pathToFileURL(path.resolve('scripts/lib/fake-claude.mjs')).href));
  const children: ChildProcess[] = [];
  const startProcess = (options: Parameters<typeof ClaudeChatProcess.start>[0]) => ClaudeChatProcess.start({ ...options,
    spawn: ((...args: Parameters<typeof nodeSpawn>) => { const child = nodeSpawn(...args); children.push(child); return child; }) as typeof nodeSpawn });
  return { script, children, startProcess };
}
const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;
async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) throw new Error('timed out waiting'); await new Promise(done => setTimeout(done, 10)); }
}

test('real process: the warm line\'s Claude Code gets the isolation flags (no tools) and haiku, is reused, and is gone after dispose()', async (t: TestContext) => {
  const s = await standIn(t);
  const line = new WarmLine({ systemPrompt: () => '测试用系统提示词', allowed: () => true, binary: async () => process.execPath, binaryArgs: [s.script],
    startProcess: s.startProcess, bootMs: 0, retryMs: 10 });
  line.want(0);
  await until(() => line.ready);
  const first = await line.ask('ANSWER={"a":1}', new AbortController().signal);
  const second = await line.ask('ANSWER={"a":2}', new AbortController().signal);
  assert.equal(first, '{"a":1}', 'the stand-in refuses anything but the isolation flags (tools off) with --model haiku');
  assert.equal(second, '{"a":2}');
  assert.equal(s.children.length, 1, 'one process for both calls');
  assert.ok(s.children[0].spawnargs.includes('--model') && s.children[0].spawnargs.includes('haiku'));
  line.dispose();
  await until(() => exited(s.children[0]));
});

test('real processes: with a warm haiku her first character does not wait for haiku (stand-ins on real timers)', async (t: TestContext) => {
  const s = await standIn(t);
  const line = new WarmLine({ systemPrompt: () => 'reactions', allowed: () => true, binary: async () => process.execPath, binaryArgs: [s.script],
    startProcess: s.startProcess, bootMs: 0, retryMs: 10 });
  t.after(() => line.dispose());
  line.want(0);
  await until(() => line.ready);
  // Her reply: another stand-in process whose first character comes 900 ms after the message.
  const chat = await s.startProcess({ binary: process.execPath, binaryArgs: [s.script], model: 'opus', systemPrompt: 'chat' });
  t.after(() => chat.close());
  const marks: Record<string, number> = {};
  let haikuCalls = 0;
  const store = { enabled: true, today: () => 0, noteCall: () => 1, chatsToday: () => 0, noteChat: () => 1 };
  const performer: ReactionPerformer = { stage: false, gate: () => null, perform: () => ({ done: true }) };
  const host = new ReactionHost({ store, quiet: () => null, lift: () => {}, warm: () => line.ready, knobs: { warmParallel: true },
    now: () => ({ characterId: 'c', dispositions: SIX, mood: 'calm', moodWords: '平静', fatigue: '', sleepy: false, values: null, persona: '' }),
    performers: { blush: performer, shy: performer, happy: performer, action: performer },
    journal: () => { marks.reacted ??= performance.now(); },
    ask: async (prompt, _system, signal) => { haikuCalls++; marks.haikuStart = performance.now(); return line.ask(`DELAY=400\n${prompt}`, signal); } });
  t.after(() => host.dispose());
  const t0 = performance.now();
  host.userTurn('m1', '你好可爱');
  await chat.runTurn(claudeInput({ prompt: 'DELAY=900\nANSWER=你好呀', imageDataUrls: [] }), new AbortController().signal, type => {
    if (type === 'delta' && marks.first === undefined) { marks.first = performance.now(); host.firstChar('m1'); }
  });
  await until(() => marks.reacted !== undefined);
  const first = marks.first - t0, haikuStart = marks.haikuStart - t0;
  assert.ok(haikuStart < first, `haiku started beside her reply (${Math.round(haikuStart)} ms) before her first character (${Math.round(first)} ms)`);
  assert.ok(haikuStart >= REACTION_KNOBS.startDelayMs - 5, 'not before knobs.startDelayMs');
  assert.ok(first < 900 + 1_500, `her first character (${Math.round(first)} ms) is not held for haiku`);
  assert.equal(haikuCalls, 1, 'one haiku call for the message');
  assert.equal(host.stats.parallel, 1);
});

test('real processes, knobs.warmParallel off: haiku waits for her first character, then goes to the warm process (no process is started for it)', async (t: TestContext) => {
  const s = await standIn(t);
  const line = new WarmLine({ systemPrompt: () => 'reactions', allowed: () => true, binary: async () => process.execPath, binaryArgs: [s.script],
    startProcess: s.startProcess, bootMs: 0, retryMs: 10 });
  t.after(() => line.dispose());
  line.want(0);
  await until(() => line.ready);
  const marks: Record<string, number> = {};
  const store = { enabled: true, today: () => 0, noteCall: () => 1, chatsToday: () => 0, noteChat: () => 1 };
  const performer: ReactionPerformer = { stage: false, gate: () => null, perform: () => ({ done: true }) };
  const host = new ReactionHost({ store, quiet: () => null, lift: () => {}, warm: () => line.ready, knobs: { warmParallel: false },
    now: () => ({ characterId: 'c', dispositions: SIX, mood: 'calm', moodWords: '平静', fatigue: '', sleepy: false, values: null, persona: '' }),
    performers: { blush: performer, shy: performer, happy: performer, action: performer }, journal: () => { marks.reacted ??= performance.now(); },
    // As electron/reactions/wiring.ts: the warm process whenever it is alive.
    ask: async (prompt, _system, signal) => { marks.haikuStart = performance.now(); assert.ok(line.alive); return line.ask(prompt, signal); } });
  t.after(() => host.dispose());
  host.userTurn('m1', '你好可爱');
  await new Promise(done => setTimeout(done, 600));
  assert.equal(marks.haikuStart, undefined, 'not before her first character');
  const first = performance.now();
  host.firstChar('m1');
  await until(() => marks.reacted !== undefined);
  assert.ok(marks.haikuStart >= first);
  assert.equal(s.children.length, 1, 'answered by the warm process');
  assert.equal(host.stats.afterFirstChar, 1);
});

test('the stand-in refuses a process started with tools (so the isolation check above means something)', async (t: TestContext) => {
  const s = await standIn(t);
  const child = nodeSpawn(process.execPath, [s.script, '-p', '--tools', 'Bash'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stdin.write(claudeInput({ prompt: 'ANSWER=x', imageDataUrls: [] }));
  await until(() => out.includes('result'));
  child.kill();
  assert.match(out, /fake: argv/);
  assert.equal(await readFile(s.script, 'utf8').then(text => text.includes('verifyArguments')), true);
});

test('X-344: a call on the warm haiku counts as a model call (claudeCallsInFlight) while it runs, also after a failure or the caller\'s stop', async () => {
  const clock = new Clock(), w = warmWorld(clock);
  w.line.want();
  for (let i = 0; i < 60 && !w.processes.length; i++) await clock.advance(100);
  await clock.advance(5 * SECOND);
  const base = claudeCallsInFlight();
  const call = w.line.ask('提示', new AbortController().signal);
  await flush();
  assert.equal(claudeCallsInFlight(), base + 1, 'I-021 (modelBusy) sees it');
  w.processes[0].answer('{}');
  await call;
  assert.equal(claudeCallsInFlight(), base);
  // The caller stops it.
  const stop = new AbortController(), second = w.line.ask('提示二', stop.signal);
  await flush();
  assert.equal(claudeCallsInFlight(), base + 1);
  stop.abort();
  await assert.rejects(second);
  assert.equal(claudeCallsInFlight(), base);
  // The process breaks.
  const third = w.line.ask('提示三', new AbortController().signal);
  await flush();
  assert.equal(claudeCallsInFlight(), base + 1);
  w.processes[0].fail();
  await assert.rejects(third);
  assert.equal(claudeCallsInFlight(), base);
});
