// Free prewarm (docs/claude/2026-11-22-prewarm-free.md): a spare `claude` process is spawned (spawn only: nothing is written to it) for the
// character on stage whenever her first line is likely soon: the app is ready, another character came on stage, she is seen again after
// her process closed for idle, full-screen Unbound opened, a call started. In-memory fake processes, a manual clock and manual timers.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../shared/foundation/chat';
import type { SpareWhy } from '../shared/brain/journal-entries';
import { SPARE_WHYS, buildBrainJournalEntry } from '../shared/brain';
import { ClaudeSessionPool, chatSessionKey } from '../electron/brain/session-pool';
import type { ClaudeTimingInfo, CompanionClaudeTask } from '../electron/brain/claude-session';
import type { ClaudeChatProcess } from '../electron/brain/claude-process';

class FakeProcess {
  alive = true; busy = false; turnsStarted = 0; lastUsage = null; folder = '.';
  readonly sent: string[] = [];
  constructor(readonly model: string, readonly id: number) {}
  async settled() {}
  close() { this.alive = false; }
  async runTurn(line: string, _signal: AbortSignal, emit: (type: 'delta', text: string) => void) {
    this.turnsStarted++;
    this.sent.push(line);
    emit('delta', '嗯');
    return { output: '嗯', superseded: false };
  }
}

const flush = async () => { for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve)); };
const user = (content: string): ChatMessage => ({ role: 'user', content });

function world(options: { maxWarm?: number; claude?: boolean } = {}) {
  let clock = 0, nextTimer = 0, generation = 0;
  const timers = new Map<number, { due: number; callback: () => void }>();
  const processes: FakeProcess[] = [], rows: SpareWhy[] = [], infos: ClaudeTimingInfo[] = [];
  const state = { active: 'one' };
  const accepted = () => `${state.active}|${generation}`;
  const pool = new ClaudeSessionPool({
    enabled: true, binary: async () => 'claude', chattedBefore: () => false, provider: () => ({ kind: options.claude === false ? 'other' : 'claude', model: 'haiku' }),
    startProcess: async process => { const made = new FakeProcess(process.model, processes.length); processes.push(made); return made as unknown as ClaudeChatProcess; },
    now: () => clock, timers: { set: (callback, ms) => { timers.set(++nextTimer, { due: clock + ms, callback }); return nextTimer; }, clear: handle => { timers.delete(handle as number); } },
    idleMs: 600_000, hiddenIdleMs: 180_000, maxWarm: options.maxWarm ?? 3, log: () => {},
    timing: { dispatched: (_replyId, info) => { infos.push(info); }, firstDelta: () => {} },
    onSpare: why => { rows.push(why); },
    turn: () => ({ characterId: state.active, providerScope: 'p', accepted: accepted(), chat: chatSessionKey(state.active, 'p', `c-${state.active}`) }),
    stage: () => ({ characterId: state.active, providerScope: 'p' }),
  });
  const switchTo = (id: string) => { state.active = id; generation++; pool.close('context'); };
  const alive = () => processes.filter(process => process.alive).length;
  function advance(ms: number) {
    const until = clock + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.due <= until).sort((a, b) => a[1].due - b[1].due)[0];
      if (!due) break;
      timers.delete(due[0]);
      clock = due[1].due;
      due[1].callback();
    }
    clock = until;
  }
  async function say(text: string) {
    const task: CompanionClaudeTask = { kind: 'chat', model: 'haiku', workingDirectory: '.', writable: false, prompt: 'unused', imageDataUrls: [], replyId: `r${infos.length + 1}`,
      session: { key: accepted(), basePersona: state.active, persona: state.active, messages: [user(text)] } };
    return pool.stream(task, new AbortController().signal, () => {});
  }
  return { pool, state, processes, rows, infos, alive, switchTo, advance, say };
}

test('start: the app is ready with no chat yet in this run: exactly one spare for the character on stage, a second ask makes none', async () => {
  const w = world();
  w.pool.prewarm('start');
  w.pool.prewarm('start');
  await flush();
  assert.equal(w.processes.length, 1);
  assert.equal(w.alive(), 1);
  assert.deepEqual(w.rows, ['start']);
  assert.ok(w.processes.every(process => process.sent.length === 0), 'spawn only: nothing is written to the spare');
});

test('switch: another character comes on stage (nothing chatted before): one spare for her; switching back and forth piles up nothing', async () => {
  const w = world();
  w.pool.prewarm('start');
  await flush();
  w.switchTo('gene');
  await flush();
  assert.equal(w.processes.length, 2, 'one for One, one for Gene');
  assert.deepEqual(w.rows, ['start', 'switch']);
  for (let index = 0; index < 6; index++) { w.switchTo(index % 2 ? 'gene' : 'one'); await flush(); }
  assert.equal(w.processes.length, 2, 'each already has her spare: no new process on any later switch');
  assert.equal(w.alive(), 2);
  assert.deepEqual(w.rows, ['start', 'switch']);
});

test('switch to a character that was never chatted with: the first reply is on the spare (prewarmed), and the spare was told nothing before it', async () => {
  const w = world();
  w.pool.prewarm('start');
  await flush();
  w.switchTo('gene');
  await flush();
  const spare = w.processes[1]!;
  assert.equal(spare.sent.length, 0);
  await w.say('你好');
  assert.equal(w.processes.length, 2, 'no process was started for the turn');
  assert.equal(spare.sent.length, 1, 'the first reply went to the spare');
  assert.equal(w.infos[0]!.process, 'prewarmed');
});

test('visible: after her process closed for idle (hidden 3 minutes), showing her window spawns one spare; again and again makes one', async () => {
  const w = world();
  w.pool.prewarm('start');
  await flush();
  w.pool.noteVisible(false);
  w.advance(181_000);
  assert.equal(w.alive(), 0, 'the spare closes like today (3 minutes hidden)');
  w.pool.noteVisible(true);
  w.pool.noteVisible(true);
  await flush();
  assert.equal(w.processes.length, 2);
  assert.equal(w.alive(), 1);
  assert.deepEqual(w.rows, ['start', 'visible']);
});

test('fullscreen and call: each spawns one spare when none exists; a call holds it (no idle close) and hang-up lets the idle clock run again', async () => {
  const w = world();
  w.pool.prewarm('fullscreen');
  await flush();
  assert.deepEqual(w.rows, ['fullscreen']);
  w.pool.prewarm('fullscreen');
  await flush();
  assert.equal(w.processes.length, 1, 'already one: no duplicate');
  w.advance(601_000);
  assert.equal(w.alive(), 0, 'the idle rule closes the spare (10 minutes seen)');
  w.pool.holdWarm(true);
  await flush();
  assert.deepEqual(w.rows, ['fullscreen', 'call']);
  assert.equal(w.alive(), 1);
  w.advance(3_600_000);
  assert.equal(w.alive(), 1, 'a call keeps it');
  w.pool.holdWarm(false);
  w.advance(601_000);
  assert.equal(w.alive(), 0, 'after hang-up the idle rule closes it as today');
});

test('a call that starts while a process is already warm spawns no second one', async () => {
  const w = world();
  await w.say('你好');
  const before = w.processes.length;
  w.pool.holdWarm(true);
  await flush();
  assert.equal(w.processes.length, before);
  assert.equal(w.alive(), 1);
});

test('exiting: after dispose nothing is spawned by any trigger', async () => {
  const w = world();
  w.pool.prewarm('start');
  await flush();
  w.pool.dispose();
  const made = w.processes.length;
  w.pool.prewarm('start'); w.pool.prewarm('fullscreen'); w.pool.noteVisible(true); w.pool.holdWarm(true); w.switchTo('gene');
  await flush();
  assert.equal(w.processes.length, made);
  assert.equal(w.alive(), 0);
});

test('a start that is still spawning when the app exits leaves no process behind', async () => {
  const w = world();
  w.pool.prewarm('start');
  w.pool.dispose();
  await flush();
  assert.equal(w.alive(), 0);
  assert.deepEqual(w.rows, [], 'no row for a spare that was not kept');
});

test('the pool limit holds: four characters switched in turn keep at most 3 processes, the spare of the one on stage among them', async () => {
  const w = world({ maxWarm: 3 });
  w.pool.prewarm('start');
  for (const id of ['gene', 'ann', 'bo']) { await flush(); w.switchTo(id); }
  await flush();
  assert.equal(w.processes.length, 4);
  assert.equal(w.alive(), 3);
  assert.equal(w.processes[3]!.alive, true, 'the one on stage keeps hers');
  assert.equal(w.processes[0]!.alive, false, 'the least recently used went');
});

test('a user who does not chat with Claude gets no spare (the provider is not Claude)', async () => {
  const w = world({ claude: false });
  w.pool.prewarm('start'); w.pool.noteVisible(true); w.switchTo('gene');
  await flush();
  assert.equal(w.processes.length, 0);
});

test('a plain build (no turn: one slot) keeps today\'s rule: no spare before any chat', async () => {
  const processes: FakeProcess[] = [];
  const pool = new ClaudeSessionPool({ enabled: true, binary: async () => 'claude', chattedBefore: () => false, provider: () => ({ kind: 'claude', model: 'haiku' }), log: () => {},
    startProcess: async process => { const made = new FakeProcess(process.model, processes.length); processes.push(made); return made as unknown as ClaudeChatProcess; } });
  pool.prewarm('start');
  await flush();
  assert.equal(processes.length, 0);
});

test('the journal row: closed words only, and nothing else gets in', () => {
  for (const why of SPARE_WHYS) assert.deepEqual(buildBrainJournalEntry('spare-process', { why, text: '不该进来' }, 'one'), { type: 'spare-process', characterId: 'one', why });
  assert.equal(buildBrainJournalEntry('spare-process', { why: '任意一句话' }, 'one'), null);
  assert.equal(buildBrainJournalEntry('spare-process', {}, 'one'), null);
});
