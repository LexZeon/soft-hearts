// The paid prewarm step: when the app
// starts and when another character comes on stage, a hidden request from a throwaway process caches the opening in the spare's folder, and
// the first turn on that spare sends two blocks (block 1 the cached opening, block 2 the usual new-turn content). Run against the fake Claude
// with a simulated exact-prefix prompt cache (tests/helpers/prewarm-fake-claude.ts); the timeouts run on a manual clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import type { ChatMessage } from '../shared/foundation/chat';
import { buildCodexChatPrompt } from '../electron/brain/conversation-context';
import { CLAUDE_FOLLOW_UP_HEADER, PREPARED_OPENING_HISTORY_INTRO, composePreparedOpening } from '../electron/brain/claude-session-prompt';
import { PersistentClaudeChat, type CompanionClaudeTask, type PersistentClaudeOptions } from '../electron/brain/claude-session';
import { LONG_CHAT_KNOBS, type LongChatKnobs } from '../shared/behaviors/long-chat/knobs';
import type { SessionRestartEntry } from '../electron/brain/long-chat/prewarm';
import { StartWarmer, warmsOnStart, type StartOpeningInput } from '../electron/brain/long-chat/start-warm';
import { startOpeningInput } from '../electron/brain/long-chat/start-opening';
import type { ClaudeChatProcess } from '../electron/brain/claude-process';
import { manualClock } from './helpers/manual-clock';
import { fake } from './helpers/prewarm-fake-claude';

const persona = '你是测试角色小桃，说话温柔。';
const opening = '你们认识三天了。';
const note = '他喜欢猫。';
const u = (content: string): ChatMessage => ({ role: 'user', content });
const a = (content: string): ChatMessage => ({ role: 'assistant', content });
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean> | boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) throw new Error('timed out waiting'); await wait(20); }
}
const dataOf = (block: string) => JSON.parse(block.split('<conversation-data>\n')[1].split('\n</conversation-data>')[0]) as { history: ChatMessage[]; currentUser?: string };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

interface TaskShape { persona?: string; opening?: string }
let count = 0;
function task(messages: ChatMessage[], shape: TaskShape = {}): CompanionClaudeTask {
  const base = shape.persona ?? persona, relation = shape.opening ?? opening;
  const composed = [base, relation, '当前心情：平静。'].join('\n\n');
  return {
    kind: 'chat', model: 'haiku', workingDirectory: os.tmpdir(), writable: false,
    get prompt() { return buildCodexChatPrompt(composed, messages); }, imageDataUrls: [], replyId: `r${++count}`,
    session: { key: 'conversation-1', basePersona: base, persona: composed, openingContext: relation, openingNote: note, messages, data: () => null },
  };
}

type Internals = { startWarm: { warm: { status: string; process: unknown } | null } | null };
const warmState = (chat: PersistentClaudeChat) => (chat as unknown as Internals).startWarm?.warm ?? null;

function harness(script: string, knobs: Partial<LongChatKnobs> = {}, extra: Partial<PersistentClaudeOptions> = {}, seed: ChatMessage[] = [u('早'), a('早呀。')]) {
  const archive: ChatMessage[] = [...seed];
  const shown: string[] = [];
  const restarts: SessionRestartEntry[] = [];
  const dispatched: string[] = [];
  const spares: string[] = [];
  const events = { availability: 0, failures: 0, newProcess: 0 };
  const clock = manualClock();
  const chat = new PersistentClaudeChat({ enabled: true, binary: async () => process.execPath, binaryArgs: [script], provider: () => ({ kind: 'claude', model: 'haiku' }),
    chattedBefore: () => true, interruptGraceMs: 300, log: () => {}, now: clock.now, timers: clock.timers,
    longChat: { ...LONG_CHAT_KNOBS, enabled: true, sessionMaxChars: 100_000, ...knobs },
    openingWindow: () => [...archive], restartLog: entry => restarts.push(entry), onSpare: why => spares.push(why), onNewProcess: () => { events.newProcess++; },
    startOpening: () => ({ basePersona: persona, openingContext: opening, openingNote: note, history: [...archive] }),
    availability: { success: () => { events.availability++; }, failure: () => { events.failures++; } },
    timing: { dispatched: id => dispatched.push(id), firstDelta: () => {} }, ...extra });
  const say = async (text: string, shape?: TaskShape) => {
    archive.push(u(text));
    let reply = '';
    await chat.stream(task([...archive], shape), new AbortController().signal, (type, value) => { if (type === 'delta') { reply += value; shown.push(value); } });
    archive.push(a(reply));
    return reply;
  };
  /** The spare is up and the warm (if any) has been decided: begin() runs in the same tick as the spare coming up. */
  const spareUp = () => until(() => spares.length >= 1);
  const warmed = () => until(() => warmState(chat)?.status === 'warmed');
  return { chat, archive, shown, restarts, dispatched, spares, events, clock, say, spareUp, warmed };
}

/** Who sent the hidden request (a single block that is a prepared opening), who the spare is. */
async function roles(f: Awaited<ReturnType<typeof fake>>) {
  const inputs = await f.inputs(), spawns = await f.spawns();
  const warm = inputs.filter(row => row.blocks.length === 1 && row.blocks[0].includes(PREPARED_OPENING_HISTORY_INTRO) && dataOf(row.blocks[0]).currentUser === undefined);
  return { inputs, spawns, warm };
}

/**
 * The hidden request has arrived and both processes are in the spawn log. The log is written when a process has booted, and under load the
 * throwaway process can boot (and send) before the spare it was started after has written its line (as in long-chat-prewarm.test.ts).
 */
const warmSent = (f: Awaited<ReturnType<typeof fake>>) => until(async () => { const { warm, spawns } = await roles(f); return warm.length === 1 && spawns.length >= 2; });

const OPENING_TEXT =(history: ChatMessage[]) => composePreparedOpening({ basePersona: persona, openingContext: opening, openingNote: note, history });

test('which triggers warm: only start and switch', () => {
  assert.deepEqual(['start', 'switch', 'visible', 'fullscreen', 'call', 'context', undefined].map(why => warmsOnStart(why)), [true, true, false, false, false, false, false]);
});

test('start: one hidden request from a throwaway process in the spare\'s folder; the first turn then reads the opening from the cache', async () => {
  const f = await fake();
  const h = harness(f.script);
  try {
    h.chat.prewarm('start');
    await warmSent(f);
    const { warm, spawns } = await roles(f);
    assert.equal(spawns.length, 2, 'the spare and the throwaway process');
    const warmer = spawns.find(spawn => spawn.pid === warm[0].pid)!, spare = spawns.find(spawn => spawn.pid !== warm[0].pid)!;
    assert.equal(warmer.cwd, spare.cwd, 'the hidden request runs in the spare\'s folder (the same cache prefix)');
    // The hidden request is the opening and nothing else: no current message, no line made up for the user.
    assert.equal(warm[0].blocks[0], OPENING_TEXT(h.archive), 'exactly the prepared opening of this moment\'s window');
    assert.deepEqual(dataOf(warm[0].blocks[0]), { history: h.archive });
    await h.warmed();
    assert.equal((await roles(f)).inputs.filter(row => row.pid === spare.pid).length, 0, 'the spare was told nothing before the user wrote');
    // The user writes: the first reply is on the spare, two blocks, the first exactly the cached one.
    const reply = await h.say('现在呢？');
    const after = await roles(f);
    const first = after.inputs.at(-1)!;
    assert.equal(first.pid, spare.pid);
    assert.equal(first.blocks.length, 2);
    assert.equal(first.blocks[0], warm[0].blocks[0], 'block 1 is the cached opening');
    assert.ok(first.blocks[1].startsWith(CLAUDE_FOLLOW_UP_HEADER) && dataOf(first.blocks[1]).currentUser === '现在呢？');
    assert.ok(!first.blocks[1].includes(note) && !first.blocks[1].includes(opening), 'the opening parts are not repeated');
    assert.deepEqual(dataOf(first.blocks[1]).history, [], 'the window was in block 1: nothing of it repeats');
    assert.equal(reply, '第1轮回复。');
    assert.equal(after.spawns.length, 2, 'no other process');
    // Telemetry: one line, no text.
    assert.equal(h.restarts.length, 1);
    const [line] = h.restarts;
    assert.deepEqual([line.reason, line.prepared, line.warm, line.sessionChars, line.contextTokens], ['start', true, 'warmed', 0, null]);
    assert.ok((line.cacheReadTokens ?? 0) >= warm[0].blocks[0].length, 'the opening came from the cache');
    assert.ok((line.cacheCreationTokens ?? Infinity) < first.blocks[1].length + 200, 'only this turn was new');
    assert.ok(line.firstCharMs !== null);
    // Nothing of the hidden request anywhere else: not shown, not archived, not a turn, no availability report, no new-process handoff of its own.
    assert.ok(!h.shown.join('').includes('WARM-SECRET') && !h.archive.some(message => message.content.includes('WARM-SECRET')));
    assert.ok(!after.inputs.filter(row => row.pid !== warm[0].pid).some(row => row.blocks.join('').includes('WARM-SECRET')));
    assert.equal(h.dispatched.length, 1, 'only the user turn was dispatched (timing)');
    assert.deepEqual([h.events.availability, h.events.failures, h.events.newProcess], [1, 0, 1]);
    assert.deepEqual(h.spares, ['start']);
    // The spare's record of what Claude was told lines up: the second turn stays on the same process and sends only what is new.
    await h.say('还在吗');
    const second = (await roles(f)).inputs.at(-1)!;
    assert.equal(second.pid, spare.pid, 'the same process: no divergence');
    assert.equal(second.blocks.length, 1);
    assert.deepEqual(dataOf(second.blocks[0]), { history: [], currentUser: '还在吗' });
  } finally { h.chat.dispose(); await f.cleanup(); }
});

test('any close forgets the warm: a context change after it (a deleted chat, a new persona) leaves no warmed opening for the next turn', async () => {
  const f = await fake();
  const h = harness(f.script);
  try {
    h.chat.prewarm('start');
    await h.warmed();
    h.chat.close('context');
    assert.equal(warmState(h.chat), null, 'nothing of her window is kept');
    await h.say('现在呢？');
    const { inputs } = await roles(f);
    assert.equal(inputs.at(-1)!.blocks.length, 1, 'the spare opens the usual way');
    assert.equal(h.restarts.length, 0, 'and no warm is measured');
  } finally { h.chat.dispose(); await f.cleanup(); }
});

test('with an empty window (a character never talked to) the opening is persona, relationship and note; the first turn still sends two blocks', async () => {
  const f = await fake();
  const h = harness(f.script, {}, {}, []);
  try {
    h.chat.prewarm('start');
    await h.warmed();
    const reply = await h.say('第一次见面');
    const { inputs } = await roles(f);
    const first = inputs.at(-1)!;
    assert.equal(first.blocks.length, 2);
    assert.equal(first.blocks[0], OPENING_TEXT([]));
    assert.deepEqual(dataOf(first.blocks[1]), { history: [], currentUser: '第一次见面' });
    assert.equal(reply, '第1轮回复。');
  } finally { h.chat.dispose(); await f.cleanup(); }
});

test('switch warms too; visible, fullscreen, call and context do not (the spare comes up, nothing is sent)', async () => {
  for (const why of ['switch', 'visible', 'fullscreen', 'call', 'context'] as const) {
    const f = await fake();
    const h = harness(f.script);
    try {
      if (why === 'call') h.chat.holdWarm(true); else h.chat.prewarm(why);
      await h.spareUp();
      assert.deepEqual(h.spares, [why === 'call' ? 'call' : why]);
      if (why === 'switch') await warmSent(f);
      else { assert.equal(warmState(h.chat), null, `${why}: no warm was begun`); await wait(150); assert.equal((await roles(f)).inputs.length, 0, `${why}: nothing was sent`); }
    } finally { h.chat.dispose(); await f.cleanup(); }
  }
});

test('the 5-minute dedupe: a second spare for the same character within the gap is not warmed; after the gap it is', async () => {
  const f = await fake();
  const h = harness(f.script);
  try {
    h.chat.prewarm('start');
    await h.warmed();
    h.chat.close('idle');
    h.chat.prewarm('switch');
    await until(() => h.spares.length === 2);
    assert.equal(warmState(h.chat), null, 'within five minutes: no second request');
    h.chat.close('idle');
    h.clock.advance(300_000);
    h.chat.prewarm('switch');
    await until(() => h.spares.length === 3);
    assert.notEqual(warmState(h.chat), null, 'after the gap it warms again');
    await until(async () => (await roles(f)).warm.length === 2);
  } finally { h.chat.dispose(); await f.cleanup(); }
});

test('the user writes before the warm finishes: she answers as today on the spare, once; nothing is doubled', async () => {
  const f = await fake();
  const h = harness(f.script);
  try {
    await f.holdWarm(); // the hidden request is held until the test lets it go
    h.chat.prewarm('start');
    await warmSent(f);
    assert.equal(warmState(h.chat)?.status, 'warming');
    const reply = await h.say('你好');
    const { inputs, spawns } = await roles(f);
    const spare = spawns.find(spawn => spawn.pid !== inputs[0].pid)!;
    const first = inputs.find(row => row.pid === spare.pid)!;
    assert.equal(first.blocks.length, 1, 'the whole opening in one block, as without a warm');
    assert.ok(first.blocks[0].includes(persona) && dataOf(first.blocks[0]).currentUser === '你好');
    assert.equal(reply, '第1轮回复。');
    assert.equal(h.shown.length, 1, 'one answer, no double');
    assert.equal(inputs.filter(row => row.pid === spare.pid).length, 1);
    assert.deepEqual([h.restarts[0]?.reason, h.restarts[0]?.prepared, h.restarts[0]?.warm], ['start', false, 'warming']);
    assert.equal(warmState(h.chat), null, 'the warm is over');
    assert.ok(!h.shown.join('').includes('WARM-SECRET'));
    await f.releaseWarm();
  } finally { await f.releaseWarm(); h.chat.dispose(); await f.cleanup(); }
});

test('quitting while the warm runs: the hidden request stops and no process stays', async () => {
  const f = await fake();
  const h = harness(f.script);
  try {
    await f.holdWarm();
    h.chat.prewarm('start');
    await warmSent(f);
    const pids = (await f.spawns()).map(spawn => spawn.pid);
    assert.equal(pids.length, 2);
    h.chat.dispose();
    await until(() => pids.every(pid => !alive(pid)));
    assert.equal(warmState(h.chat), null);
    assert.equal(h.restarts.length, 0);
    assert.equal(h.dispatched.length, 0);
  } finally { await f.releaseWarm(); h.chat.dispose(); await f.cleanup(); }
});

test('quitting while the throwaway process is still starting: it is closed the moment it is up', async () => {
  const f = await fake();
  const h = harness(f.script);
  try {
    h.chat.prewarm('start');
    await h.spareUp(); // begin() has run: the throwaway process is starting
    h.chat.dispose();
    await wait(300);
    const pids = (await f.spawns()).map(spawn => spawn.pid);
    await until(() => pids.every(pid => !alive(pid)));
    assert.equal((await roles(f)).inputs.length, 0, 'nothing was sent after the quit');
  } finally { h.chat.dispose(); await f.cleanup(); }
});

test('switching away drops a pending warm (a newer trigger is for the other character)', async () => {
  const f = await fake();
  const h = harness(f.script);
  try {
    await f.holdWarm();
    h.chat.prewarm('switch');
    await warmSent(f);
    const warmer = (await roles(f)).warm[0].pid;
    h.chat.noteVisible(false, true); // the stage moved on
    assert.equal(warmState(h.chat), null);
    await until(() => !alive(warmer));
    assert.equal(h.restarts.length, 0);
  } finally { await f.releaseWarm(); h.chat.dispose(); await f.cleanup(); }
});

test('a persona that changed since the warm: the first turn opens the usual way (no stale opening); the lines of relationship that differ stay in block 2', async () => {
  const f = await fake();
  const h = harness(f.script);
  const g = await fake();
  const k = harness(g.script);
  try {
    h.chat.prewarm('start');
    await h.warmed();
    await h.say('现在呢？', { persona: persona + '（改过的设定）' });
    const first = (await roles(f)).inputs.at(-1)!;
    assert.equal(first.blocks.length, 1, 'persona changed: no prepared block');
    assert.equal(h.restarts[0].prepared, false);
    k.chat.prewarm('start');
    await k.warmed();
    await k.say('现在呢？', { opening: '你们认识四天了。' });
    const second = (await roles(g)).inputs.at(-1)!;
    assert.equal(second.blocks.length, 2);
    assert.equal(second.blocks[0], OPENING_TEXT(k.archive.slice(0, 2)));
    assert.ok(second.blocks[1].includes('你们认识四天了。'), 'this turn\'s own relationship lines are not lost');
  } finally { h.chat.dispose(); k.chat.dispose(); await f.cleanup(); await g.cleanup(); }
});

test('the window moved on since the warm (a message in between): it lines up, the newer lines go in block 2', async () => {
  const f = await fake();
  const h = harness(f.script);
  try {
    h.chat.prewarm('start');
    await h.warmed();
    h.archive.push(u('等一下'), a('嗯，在听。'));
    await h.say('现在呢？');
    const first = (await roles(f)).inputs.at(-1)!;
    assert.equal(first.blocks.length, 2);
    assert.deepEqual(dataOf(first.blocks[1]).history, [u('等一下'), a('嗯，在听。')]);
  } finally { h.chat.dispose(); await f.cleanup(); }
});

test('off: without startOpening, with the gap at 0, or with the new chat off, nothing is warmed', async () => {
  for (const [label, knobs, extra] of [['no host input', {}, { startOpening: undefined }], ['gap 0', { startWarmMinGapMs: 0 }, {}], ['new chat off', { enabled: false }, {}]] as const) {
    const f = await fake();
    const h = harness(f.script, knobs as Partial<LongChatKnobs>, extra as Partial<PersistentClaudeOptions>);
    try {
      h.chat.prewarm('start');
      await h.spareUp();
      assert.equal(warmState(h.chat), null, label);
      await wait(150);
      assert.equal((await roles(f)).inputs.length, 0, label);
    } finally { h.chat.dispose(); await f.cleanup(); }
  }
});

// ---- StartWarmer on its own (stand-in processes, no child) ----

interface Stub { process: ClaudeChatProcess; closed: string[]; turns: number }
function stub(model = 'haiku', folder = '/tmp/spare'): Stub {
  const closed: string[] = [];
  const state = { turns: 0 };
  const process = { alive: true, turnsStarted: 0, model, folder, close: (reason?: string) => { closed.push(reason ?? ''); },
    runTurn: async (_line: string, _signal: AbortSignal, _emit: unknown, hooks?: { firstOutput?(): void }) => { state.turns++; hooks?.firstOutput?.(); return { output: '', superseded: false }; } } as unknown as ClaudeChatProcess;
  return { process, closed, get turns() { return state.turns; } };
}
function warmer(overrides: Partial<ConstructorParameters<typeof StartWarmer>[0]> = {}) {
  const clock = manualClock();
  const started: Stub[] = [];
  const input: StartOpeningInput = { basePersona: persona, openingContext: opening, openingNote: note, history: [u('早')] };
  const w = new StartWarmer({ input: () => input, minGapMs: () => 300_000, blocked: () => false, now: clock.now, timers: clock.timers,
    startWarmer: async () => { const s = stub(); started.push(s); return s.process; }, ...overrides });
  return { w, clock, started };
}

test('StartWarmer: nothing is warmed while a reply streams, a call is on or the chat is gone (blocked)', async () => {
  const { w, started } = warmer({ blocked: () => true });
  w.begin('start', stub().process);
  await wait(30);
  assert.equal(started.length, 0);
});

test('StartWarmer: a newer trigger for the same spare finds the pending request and sends no second one', async () => {
  const { w, started } = warmer();
  const spare = stub().process;
  w.begin('start', spare);
  w.begin('switch', spare);
  await until(() => started.length >= 1);
  await wait(30);
  assert.equal(started.length, 1);
  assert.equal(started[0].turns, 1);
});

test('StartWarmer: another spare while one is pending cancels the older (when the gap allows it)', async () => {
  let gap = 300_000;
  const clock = manualClock();
  const made: Stub[] = [];
  const gate: { release: (() => void) | null } = { release: null };
  const hold = new Promise<void>(resolve => { gate.release = resolve; });
  const two = new StartWarmer({ input: () => ({ basePersona: persona, openingContext: null, openingNote: null, history: [] }), minGapMs: () => gap, blocked: () => false, now: clock.now, timers: clock.timers,
    startWarmer: async () => { const s = stub(); made.push(s); await hold; return s.process; } });
  const spareA = stub().process, spareB = stub().process;
  two.begin('start', spareA);
  gap = 1; clock.advance(10);
  two.begin('switch', spareB);
  gate.release!();
  await until(() => made.length === 2);
  await wait(30);
  assert.deepEqual(made.map(item => item.turns), [0, 1], 'the older never sent its request; the newer did');
  assert.ok(made[0].closed.length >= 1, 'and its throwaway process was closed');
});

test('StartWarmer: only a warm that finished and matches is used; a turn that takes another process ends it', async () => {
  const { w } = warmer();
  const spare = stub().process, other = stub().process;
  w.begin('start', spare);
  await until(async () => (w as unknown as { warm: { status: string } | null }).warm?.status === 'warmed');
  assert.equal(w.adopt(other, { basePersona: persona }, [u('早')]), null, 'not this spare');
  assert.equal((w as unknown as { warm: unknown }).warm, null, 'and the warm is gone');
  w.begin('start', spare); // inside the gap: nothing new
  assert.equal((w as unknown as { warm: unknown }).warm, null);
});

test('startOpeningInput: persona, relationship lines, note and window; no persona: nothing to warm; layers only with the relaxed switch', () => {
  const ports = { persona: () => persona, relationship: () => opening, note: () => note, window: () => [u('早')], relaxed: () => null, openingMemory: () => ({ date: '今天', text: '一件事' }) };
  assert.deepEqual(startOpeningInput(ports), { basePersona: persona, openingContext: opening, openingNote: note, history: [u('早')] });
  assert.equal(startOpeningInput({ ...ports, persona: () => '' }), null);
  assert.deepEqual(startOpeningInput({ ...ports, relationship: () => '', note: () => null, window: () => null }), { basePersona: persona, openingContext: null, openingNote: null, history: [] });
  const relaxed = { language: 'zh-CN' as const };
  assert.deepEqual(startOpeningInput({ ...ports, relaxed: () => relaxed as never })?.openingMemory, { date: '今天', text: '一件事' });
});
