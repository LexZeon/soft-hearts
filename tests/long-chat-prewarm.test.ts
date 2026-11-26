// Prewarm (docs/claude/2026-11-15-prewarm-restart.md): near the session budget the replacement is prepared while she is idle (a blank
// process, the opening built from her archive, one hidden request from a throwaway process in the same folder that caches it), and
// the switch happens right after one of her replies. The real persistent process runs a scripted fake that also simulates the API's
// prompt cache (exact prefix, matched at content-block boundaries, the conversation opening with the working-directory announcement)
// and makes the first character wait in proportion to the uncached input, so the tests can see what a cache hit buys.
// The timeouts the code under test sets (the wait before preparing, the hidden request's limit, the idle limit) run on a manual clock
// (helpers/manual-clock.ts): the test advances it, so a busy machine cannot make "she read for a while" come early or late. The fake
// child process still runs in real time, so the tests wait for what they can observe (a spawn, the switch) and never for a fixed time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatMessage } from '../shared/foundation/chat';
import { buildCodexChatPrompt } from '../electron/brain/conversation-context';
import { claudeInput } from '../electron/brain/claude';
import { CLAUDE_FOLLOW_UP_HEADER, OPENING_NOTE_HEADER, PREPARED_OPENING_HISTORY_INTRO, composePreparedOpening } from '../electron/brain/claude-session-prompt';
import { PersistentClaudeChat, type CompanionClaudeTask, type PersistentClaudeOptions } from '../electron/brain/claude-session';
import { LONG_CHAT_KNOBS, type LongChatKnobs } from '../shared/behaviors/long-chat/knobs';
import { PREWARM_DELAY_MS, SessionRestartLog, sanitizeRestartEntry, type SessionRestartEntry } from '../electron/brain/long-chat/prewarm';
import { manualClock } from './helpers/manual-clock';

import { fake } from './helpers/prewarm-fake-claude'; // the fake Claude with a simulated prompt cache (shared with tests/start-warm-paid.test.ts)

const persona = '你是测试角色小桃，说话温柔。';
const opening = '你们认识三天了。';
const note = '他喜欢猫。';
const u = (content: string): ChatMessage => ({ role: 'user', content });
const a = (content: string): ChatMessage => ({ role: 'assistant', content });
const pad = (index: number) => `第${index}句，` + '今天过得怎么样'.repeat(12);
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean> | boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) throw new Error('timed out waiting'); await wait(20); }
}
const dataOf = (block: string) => JSON.parse(block.split('<conversation-data>\n')[1].split('\n</conversation-data>')[0]) as { history: ChatMessage[]; currentUser?: string };

let count = 0;
function task(messages: ChatMessage[]): CompanionClaudeTask {
  const composed = [persona, opening, '当前心情：平静。'].join('\n\n');
  return {
    kind: 'chat', model: 'haiku', workingDirectory: os.tmpdir(), writable: false,
    get prompt() { return buildCodexChatPrompt(composed, messages); }, imageDataUrls: [], replyId: `r${++count}`,
    session: { key: 'conversation-1', basePersona: persona, persona: composed, openingContext: opening, openingNote: note, messages, data: () => null },
  };
}

/** A chat whose archive is `archive` (each reply joins it, as the host archives it), and a log of what the app saw. */
function harness(script: string, knobs: Partial<LongChatKnobs> = {}, extra: Partial<PersistentClaudeOptions> = {}) {
  const archive: ChatMessage[] = [];
  const shown: string[] = [];
  const restarts: SessionRestartEntry[] = [];
  const dispatched: string[] = [];
  const clock = manualClock();
  /** How many times the wait before preparing was set: a reply that arms it is one the test has to "read" (advance past). */
  let armed = 0;
  const timers = { set: (callback: () => void, ms: number) => { if (ms === PREWARM_DELAY_MS) armed++; return clock.timers.set(callback, ms); }, clear: clock.timers.clear };
  const chat = new PersistentClaudeChat({ enabled: true, binary: async () => process.execPath, binaryArgs: [script], provider: () => ({ kind: 'claude', model: 'haiku' }),
    chattedBefore: () => true, interruptGraceMs: 300, log: () => {}, now: clock.now, timers,
    longChat: { ...LONG_CHAT_KNOBS, enabled: true, sessionMaxChars: 4_000, restartPrepareAt: 0.5, ...knobs },
    openingWindow: () => [...archive], restartLog: entry => restarts.push(entry),
    timing: { dispatched: id => dispatched.push(id), firstDelta: () => {} }, ...extra });
  const say = async (text: string) => {
    archive.push(u(text));
    let reply = '';
    await chat.stream(task([...archive]), new AbortController().signal, (type, value) => { if (type === 'delta') { reply += value; shown.push(value); } });
    archive.push(a(reply));
    return reply;
  };
  // Talks until the replacement process appears (the preparation started), pausing after each reply like a person reading it: a reply
  // that armed the wait is followed by the clock moving past it (again, while the host has not finished showing the reply), then the
  // test waits for the replacement process to show up.
  const untilPrepared = async (spawns: () => Promise<unknown[]>) => {
    let index = 0;
    while ((await spawns()).length < 2) {
      if (++index > 30) throw new Error('never prepared');
      const before = armed;
      await say(pad(index));
      if (armed === before) continue;
      for (let round = 0; round < 5; round++) { const seen = armed; clock.advance(PREWARM_DELAY_MS); if (armed === seen) break; }
      await until(async () => (await spawns()).length >= 2);
    }
    return index;
  };
  /** The prepared replacement's hidden request has ended (warmed or failed). */
  const warmEnded = () => until(() => { const prepared = (chat as unknown as { prepared: { warm: string } | null }).prepared; return !prepared || prepared.warm === 'warmed' || prepared.warm === 'failed'; });
  /** The replacement has been installed (or dropped): nothing is waiting to switch any more. */
  const switched = () => until(() => (chat as unknown as { prepared: unknown }).prepared === null);
  return { chat, archive, shown, restarts, dispatched, say, untilPrepared, clock, warmEnded, switched };
}

/** Pids of the spawns, in order, and which of them received the hidden request (a single block without currentUser). */
async function roles(f: Awaited<ReturnType<typeof fake>>) {
  const inputs = await f.inputs();
  const warm = inputs.filter(row => row.blocks.length === 1 && row.blocks[0].includes(PREPARED_OPENING_HISTORY_INTRO));
  return { inputs, warm, spawns: await f.spawns() };
}

/**
 * The old session's process, the replacement and the throwaway one that sends the hidden request. The spawn log is written when a process
 * has booted, and under load the throwaway process can boot before the replacement it was started after, so the order of the spawn log
 * says nothing about who is who: the throwaway process is the one whose first message is the hidden request (call this once it was sent).
 */
async function who(f: Awaited<ReturnType<typeof fake>>) {
  let found: { old: { pid: number; cwd: string }; replacement: { pid: number; cwd: string }; warmer: { pid: number; cwd: string } } | null = null;
  await until(async () => {
    const { inputs, warm, spawns } = await roles(f);
    const warmer = spawns.find(spawn => spawn.pid === warm[0]?.pid);
    // The old session is the one the conversation began on (its first input); it is not "the first line of the spawn log" either.
    const old = spawns.find(spawn => spawn.pid === inputs[0]?.pid);
    const replacement = warmer && old ? spawns.find(spawn => spawn.pid !== warmer.pid && spawn.pid !== old.pid) : undefined;
    if (warmer && old && replacement) found = { old, replacement, warmer };
    return found !== null;
  });
  return found!;
}

test('claudeInput: no preface is byte for byte the old message; a preface is its own first text block', () => {
  assert.equal(claudeInput({ prompt: '你好' }), JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '你好' }] } }) + '\n');
  const line = JSON.parse(claudeInput({ prompt: '你好', preface: '开场' }));
  assert.deepEqual(line.message.content, [{ type: 'text', text: '开场' }, { type: 'text', text: '你好' }]);
});

test('composePreparedOpening: persona, relationship lines, her note and the window; no current message, no turn context', () => {
  const text = composePreparedOpening({ basePersona: persona, openingContext: opening, openingNote: note, history: [u('早'), a('早呀')] });
  assert.ok(text.startsWith(`${persona}\n\n${opening}\n\n${OPENING_NOTE_HEADER}\n${note}\n\n${PREPARED_OPENING_HISTORY_INTRO}`));
  assert.deepEqual(dataOf(text), { history: [u('早'), a('早呀')] });
  assert.ok(!text.includes('当前心情'));
});

test('nearing the limit prepares exactly one replacement; the switch happens after her reply; the first reply after it runs on the prepared process from the cache', async () => {
  const f = await fake();
  const h = harness(f.script);
  try {
    // Until half of the budget: one process, no preparation.
    const index = await h.untilPrepared(f.spawns);
    // The preparation started after a reply: a replacement and a throwaway process in the replacement's folder; one hidden request.
    await until(async () => (await roles(f)).warm.length === 1 && (await f.spawns()).length === 3);
    const before = await roles(f);
    const { old, replacement, warmer } = await who(f);
    assert.equal(warmer.cwd, replacement.cwd, 'the hidden request runs in the replacement folder (same cache prefix)');
    assert.notEqual(old.cwd, replacement.cwd);
    assert.equal(before.warm[0].pid, warmer.pid);
    assert.ok(!before.inputs.some(row => row.pid === replacement.pid), 'the replacement was told nothing before the user wrote');
    // The hidden request holds the archive window (everything said so far) and no current message.
    assert.deepEqual(dataOf(before.warm[0].blocks[0]).history, h.archive);
    // Wait for the warm to finish, then the user writes: the switch already happened (she was idle), so this goes to the replacement.
    await h.switched(); // the hidden request ends and, she being idle, the switch happens
    const reply = await h.say('现在呢？');
    const after = await roles(f);
    const first = after.inputs.at(-1)!;
    assert.equal(first.pid, replacement.pid, 'the first reply after the switch is on the prepared process');
    assert.equal(first.blocks.length, 2);
    assert.equal(first.blocks[0], before.warm[0].blocks[0], 'its first block is exactly the cached opening');
    assert.ok(first.blocks[1].startsWith(CLAUDE_FOLLOW_UP_HEADER) && dataOf(first.blocks[1]).currentUser === '现在呢？');
    assert.ok(!first.blocks[1].includes(note) && !first.blocks[1].includes(opening), 'the opening parts are not repeated');
    assert.equal(reply, '第1轮回复。');
    assert.equal(after.spawns.length, 3, 'no spare and no other process');
    assert.ok(existsSync(replacement.cwd), 'the warmer did not remove the folder it borrowed');
    // Telemetry: one line, an early prepared switch, read from the cache.
    assert.equal(h.restarts.length, 1);
    const [line] = h.restarts;
    assert.deepEqual([line.reason, line.prepared, line.warm], ['prepared', true, 'warmed']);
    assert.ok(line.sessionChars >= 2_000 && line.sessionChars < 4_000, `switched between 50% and 100% (${line.sessionChars})`);
    assert.ok((line.cacheReadTokens ?? 0) >= before.warm[0].blocks[0].length, 'the opening came from the cache');
    assert.ok((line.cacheCreationTokens ?? Infinity) < first.blocks[1].length + 200, 'only this turn was new');
    assert.ok(line.firstCharMs !== null && line.contextTokens !== null);
    // The hidden request is nowhere: not shown, not in any later prompt, not in the archive, not a measured turn.
    assert.ok(!h.shown.join('').includes('WARM-SECRET'));
    assert.ok(!after.inputs.filter(row => row.pid !== warmer.pid).some(row => row.blocks.join('').includes('WARM-SECRET')));
    assert.ok(!h.archive.some(message => message.content.includes('WARM-SECRET')));
    assert.equal(h.dispatched.length, index + 1, 'only user turns were dispatched');
    assert.equal(after.inputs.filter(row => row.pid === warmer.pid).length, 1, 'the throwaway process got exactly one message');
  } finally { h.chat.dispose(); await f.cleanup(); }
});

test('the user writes while the replacement is being prepared: the warm session answers, nothing lost or doubled, the switch comes after that reply', async () => {
  const f = await fake();
  const h = harness(f.script);
  try {
    // The hidden request is held until her next reply has started: a fixed 700 ms was only "still going" on a fast machine, and when it
    // had already ended the replacement was legitimately switched in before that reply (a different, correct, behaviour).
    await f.holdWarm();
    await h.untilPrepared(f.spawns);
    await until(async () => (await f.spawns()).length === 3 && (await roles(f)).warm.length === 1); // the throwaway process is up and its hidden request is in flight
    const { old, replacement } = await who(f);
    const saying = h.say('慢一点回答 #slow'); // 1.5 s
    await until(async () => (await roles(f)).inputs.some(row => row.blocks.at(-1)?.includes('#slow'))); // her reply has begun
    await f.releaseWarm(); // the hidden request finishes during this reply (or just after it, on a slow machine)
    const reply = await saying;
    const mid = await roles(f);
    assert.equal(mid.warm.length, 1);
    assert.equal(mid.inputs.at(-1)!.pid, old.pid, 'answered on the current warm session');
    assert.ok(reply.endsWith('轮回复。'));
    assert.ok(!mid.inputs.some(row => row.pid === replacement.pid), 'not switched in the middle of her reply');
    await h.switched(); // the hidden request is done and she is idle: the switch comes right after that reply at the latest
    await h.say('然后呢');
    const after = await roles(f);
    const first = after.inputs.at(-1)!;
    assert.equal(first.pid, replacement.pid, 'switched right after that reply');
    const data = dataOf(first.blocks[1]);
    // The exchange during preparation is not in the cached opening, so it comes as new history: nothing lost, nothing twice.
    assert.deepEqual(data.history, [u('慢一点回答 #slow'), a(reply)]);
    assert.equal(data.currentUser, '然后呢');
    const known = [...dataOf(first.blocks[0]).history, ...data.history, u(data.currentUser!)];
    assert.deepEqual(known, h.archive.slice(0, -1), 'the new process knows every line exactly once');
    assert.equal(after.warm.length, 1, 'one hidden request for this restart');
    assert.equal(h.shown.filter(text => text === reply).length >= 1, true);
  } finally { h.chat.dispose(); await f.cleanup(); }
});

test('the old session reaches the hard limit while the replacement is warming: the next turn takes the replacement, no spare', async () => {
  const f = await fake();
  const h = harness(f.script, { sessionMaxChars: 3_000, restartPrepareAt: 0.5 });
  try {
    await f.slowWarm(4_000);
    await h.untilPrepared(f.spawns);
    await until(async () => (await f.spawns()).length === 3 && (await roles(f)).warm.length === 1);
    // A long message that pushes the old session over its budget at once.
    await h.say('很长的一段话 #slow ' + '我想说的话'.repeat(400));
    await h.say('还在吗');
    const after = await roles(f);
    const { replacement } = await who(f);
    assert.equal(after.inputs.at(-1)!.pid, replacement.pid);
    assert.equal(after.spawns.length, 3, 'the budget restart used the prepared process instead of starting a spare');
    assert.equal(after.warm.length, 1);
    assert.equal(h.restarts.length, 1);
    assert.deepEqual([h.restarts[0].reason, h.restarts[0].prepared], ['budget', true]);
  } finally { h.chat.dispose(); await f.cleanup(); }
});

test('a prepared opening that no longer lines up: the blank replacement opens the usual way with the whole window', async () => {
  const f = await fake();
  let skew = false;
  const h = harness(f.script, {}, {});
  // The archive window seen at preparation ends with a line the next turn's window will not have (say, a message deleted meanwhile).
  (h.chat as unknown as { options: PersistentClaudeOptions }).options.openingWindow = () => skew ? [...h.archive] : [...h.archive, u('（后来删掉的话）')];
  try {
    await h.untilPrepared(f.spawns);
    await until(async () => (await roles(f)).warm.length === 1);
    await h.switched();
    skew = true;
    await h.say('还记得吗');
    const after = await roles(f);
    const first = after.inputs.at(-1)!;
    const { replacement } = await who(f);
    assert.equal(first.pid, replacement.pid);
    assert.equal(first.blocks.length, 1, 'no prepared block');
    assert.ok(first.blocks[0].startsWith(persona) && !first.blocks[0].startsWith(CLAUDE_FOLLOW_UP_HEADER));
    assert.deepEqual(dataOf(first.blocks[0]).history, h.archive.slice(0, -2), 'every line, no gap');
  } finally { h.chat.dispose(); await f.cleanup(); }
});

test('during a call nothing is prepared or switched; the end of the call lets a warmed replacement in', async () => {
  const f = await fake();
  const h = harness(f.script);
  try {
    await f.slowWarm(2_000); // the hidden request is long enough for the next call to start while it is still going
    h.chat.holdWarm(true);
    for (let index = 1; index <= 7; index++) { await h.say(pad(index)); h.clock.advance(PREWARM_DELAY_MS); }
    h.clock.advance(PREWARM_DELAY_MS);
    assert.equal((await f.spawns()).length, 1, 'nothing prepared during a call');
    h.chat.holdWarm(false);
    // After the call, the next reply (past half of the budget) prepares; the switch waits for her to be idle.
    await h.untilPrepared(f.spawns);
    await until(async () => (await roles(f)).warm.length === 1);
    h.chat.holdWarm(true); // a new call starts before the warm ends: no switch while it is on
    await h.warmEnded();
    await h.say('通话里的一句');
    const { old, replacement } = await who(f);
    assert.equal((await f.inputs()).at(-1)!.pid, old.pid, 'the call keeps the old session');
    h.chat.holdWarm(false); // the call ended: she is idle, the warmed replacement switches in
    await h.say('挂了');
    assert.equal((await f.inputs()).at(-1)!.pid, replacement.pid);
  } finally { h.chat.holdWarm(false); h.chat.dispose(); await f.cleanup(); }
});

test('off: new chat off, or restartPrepareAt 0, or no archive window: no hidden request and exactly the old inputs', async () => {
  const runs: string[][][] = [];
  for (const variant of ['plain', 'knob-zero', 'long-off'] as const) {
    const f = await fake();
    const h = harness(f.script, variant === 'knob-zero' ? { restartPrepareAt: 0 } : variant === 'long-off' ? { enabled: false } : {},
      variant === 'plain' ? { openingWindow: undefined } : {});
    try {
      for (let index = 1; index <= 12; index++) { await h.say(pad(index)); h.clock.advance(PREWARM_DELAY_MS); }
      await wait(200); // nothing is waiting for it: a settle before checking that no hidden request ever started
      const { warm, inputs } = await roles(f);
      assert.equal(warm.length, 0, variant);
      assert.ok(inputs.every(row => row.blocks.length === 1), variant);
      if (variant === 'long-off') assert.equal(h.restarts.length, 0);
      else assert.ok(h.restarts.length >= 1 && h.restarts.every(line => !line.prepared && line.warm === 'none'), variant);
      if (variant !== 'long-off') runs.push(inputs.map(row => row.blocks));
      else {
        // The retired process is replaced asynchronously; under a loaded machine 200 ms was not always enough (2026-11-15), so wait up to 5 s.
        let spawned = (await f.spawns()).length;
        for (const until = Date.now() + 5000; spawned < 2 && Date.now() < until; spawned = (await f.spawns()).length) await wait(100);
        assert.equal(spawned >= 2, true, 'old 12-turn / 60 000 rules still apply');
      }
    } finally { h.chat.dispose(); await f.cleanup(); }
  }
  assert.deepEqual(runs[0], runs[1], 'restartPrepareAt 0 sends exactly what no preparation sends');
});

test('a context change drops the preparation: the hidden request stops, the blank replacement becomes the spare', async () => {
  const f = await fake();
  const h = harness(f.script);
  try {
    await f.slowWarm(4_000); // still warming when the context changes
    await h.untilPrepared(f.spawns);
    await until(async () => (await roles(f)).warm.length === 1);
    h.chat.close('context');
    h.archive.length = 0;
    await h.say('新的对话');
    const after = await roles(f);
    const { replacement } = await who(f);
    const first = after.inputs.at(-1)!;
    assert.equal(first.pid, replacement.pid, 'the blank replacement served as the spare');
    assert.equal(first.blocks.length, 1);
    assert.deepEqual(dataOf(first.blocks[0]).history, []);
    await wait(4_200); // when the hidden request would have answered: it was stopped, nothing of it shows up anywhere
    assert.ok(!h.shown.join('').includes('WARM-SECRET'));
    assert.equal((await f.spawns()).length, 3, 'nothing else started');
  } finally { h.chat.dispose(); await f.cleanup(); }
});

test('restart log: developer mode only, numbers and closed words only', async () => {
  const written: string[] = [];
  let dev = false;
  const log = new SessionRestartLog({ enabled: () => dev, file: () => 'x.jsonl', wallNow: () => 0, write: async (_file, line) => { written.push(line); } });
  const entry: SessionRestartEntry = { reason: 'prepared', prepared: true, warm: 'warmed', sessionChars: 101_000, contextTokens: 120_000, firstCharMs: 1_250, cacheReadTokens: 14_000, cacheCreationTokens: 300 };
  assert.equal(log.record(entry), false);
  dev = true;
  assert.equal(log.record(entry), true);
  assert.deepEqual(JSON.parse(written[0]), { at: '1970-01-01T00:00:00.000Z', ...entry });
  assert.equal(sanitizeRestartEntry({ ...entry, reason: '她说了什么' }), null);
  assert.equal(sanitizeRestartEntry({ ...entry, text: '原话' })?.toString(), sanitizeRestartEntry(entry)?.toString());
  assert.ok(!('text' in sanitizeRestartEntry({ ...entry, text: '原话' })!));
});
