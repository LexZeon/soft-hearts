// I-186 step 0 (docs/claude/2026-11-22-i186-step0-session-pool.md): one warm Claude Code process per character. In-memory fake processes
// (no spawn), a manual clock and manual timers; the pool is driven the way the app drives it: a turn's session key is what the app accepted
// it under (it changes with every context change, like the companion's speech scope), close('context') is the companion's context change,
// and `stage` names who is on stage now.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../shared/foundation/chat';
import { ClaudeSessionPool, capVictims, chatSessionKey, sessionSlotKey, type ClaudeSessionPoolOptions } from '../electron/brain/session-pool';
import { PersistentClaudeChat, type ClaudeTimingInfo, type CompanionClaudeTask, type PersistentClaudeOptions } from '../electron/brain/claude-session';
import { ClaudeTurnError, type ClaudeChatProcess } from '../electron/brain/claude-process';
import { SESSION_POOL_KNOBS } from '../electron/brain/session-pool/knobs';

class FakeProcess {
  alive = true; busy = false; turnsStarted = 0; lastUsage = null; folder = '.'; interrupted = 0; superseded = 0;
  readonly sent: string[] = [];
  private resolveSlow: ((value: { output: string; superseded: boolean }) => void) | null = null;
  constructor(readonly model: string, readonly id: number, private readonly crash = false) {}
  async settled() {}
  close() { this.alive = false; }
  supersede() { if (!this.resolveSlow) return false; this.superseded++; const done = this.resolveSlow; this.resolveSlow = null; done({ output: '半句', superseded: true }); return true; }
  async runTurn(line: string, signal: AbortSignal, emit: (type: 'delta', text: string) => void) {
    this.turnsStarted++;
    const parsed = JSON.parse(line) as { message: { content: { type: string; text?: string }[] } };
    const text = parsed.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    this.sent.push(text);
    if (this.crash) throw new ClaudeTurnError('crashed', 'crash');
    // Markers apply to the current user message only, never to the history an opening carries.
    const data = /<conversation-data>\n([\s\S]*)\n<\/conversation-data>/.exec(text);
    const current = data ? String((JSON.parse(data[1]) as { currentUser?: unknown }).currentUser ?? '') : text;
    if (current.includes('#slow')) {
      emit('delta', '半句');
      this.busy = true;
      return new Promise<{ output: string; superseded: boolean }>((resolve, reject) => {
        this.resolveSlow = value => { this.busy = false; resolve(value); };
        signal.addEventListener('abort', () => { this.interrupted++; this.busy = false; this.resolveSlow = null; reject(signal.reason ?? new Error('aborted')); }, { once: true });
      });
    }
    emit('delta', '嗯');
    return { output: '嗯', superseded: false };
  }
}

const user = (content: string): ChatMessage => ({ role: 'user', content });
const her = (content: string): ChatMessage => ({ role: 'assistant', content });

interface WorldOptions { maxWarm?: number; maxTurns?: number; callMaxTurns?: number; crash?: boolean; pool?: Partial<ClaudeSessionPoolOptions> }

/** The app around the pool: characters, their conversations and personas, the accepted key, the clock. */
function world(options: WorldOptions = {}) {
  let clock = 0, nextTimer = 0, generation = 0, replies = 0;
  const timers = new Map<number, { due: number; callback: () => void }>();
  const processes: FakeProcess[] = [], closes: string[] = [], infos: Array<ClaudeTimingInfo & { replyId: string }> = [];
  const state = { active: 'one', provider: 'p1', model: 'haiku' };
  const conversations = new Map<string, string>([['one', 'c-one'], ['gene', 'c-gene'], ['ann', 'c-ann'], ['bo', 'c-bo']]);
  const personas = new Map<string, string>();
  const histories = new Map<string, ChatMessage[]>();
  const accepted = () => `${state.active}|${state.provider}|${generation}`; // like the companion's speech scope: changes on every context change
  const pool = new ClaudeSessionPool({
    enabled: true, binary: async () => 'claude', chattedBefore: () => false, provider: () => ({ kind: 'claude', model: state.model }),
    startProcess: async process => { const made = new FakeProcess(process.model, processes.length, options.crash === true); processes.push(made); return made as unknown as ClaudeChatProcess; },
    now: () => clock, timers: { set: (callback, ms) => { timers.set(++nextTimer, { due: clock + ms, callback }); return nextTimer; }, clear: handle => { timers.delete(handle as number); } },
    idleMs: 600_000, hiddenIdleMs: 180_000, ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}), ...(options.callMaxTurns ? { callMaxTurns: options.callMaxTurns } : {}),
    maxWarm: options.maxWarm ?? 3, log: line => { const match = /closed \(([\w:-]+)\)/.exec(line); if (match) closes.push(match[1]); },
    timing: { dispatched: (replyId, info) => { infos.push({ ...info, replyId }); }, firstDelta: () => {} },
    turn: () => ({ characterId: state.active, providerScope: state.provider, accepted: accepted(), chat: chatSessionKey(state.active, state.provider, conversations.get(state.active) ?? '') }),
    stage: () => ({ characterId: state.active, providerScope: state.provider }),
    ...options.pool,
  });
  const persona = (id: string) => personas.get(id) ?? `你是${id}。`;
  function task(text: string, key = accepted()): CompanionClaudeTask {
    const id = state.active, history = histories.get(id) ?? [];
    return { kind: 'chat', model: state.model, workingDirectory: '.', writable: false, prompt: 'unused', imageDataUrls: [], replyId: `r${++replies}`,
      session: { key, basePersona: persona(id), persona: `${persona(id)}\n\n心情`, messages: [...history, user(text)] } };
  }
  async function say(text: string, control?: Parameters<ClaudeSessionPool['stream']>[3], signal = new AbortController().signal) {
    const id = state.active, given = task(text);
    const history = histories.get(id) ?? [];
    const outcome = await pool.stream(given, signal, () => {}, control);
    histories.set(id, [...history, user(text), her(outcome.output)]);
    return { outcome };
  }
  function switchTo(id: string) { state.active = id; generation++; pool.close('context'); }
  function newConversation() { conversations.set(state.active, `c-${state.active}-${++generation}`); pool.close('context'); }
  function editPersona(text: string) { personas.set(state.active, text); generation++; pool.close('context'); }
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
  /** Which fake process holds each character's conversation now (the one that received her last turn). */
  const holder = new Map<string, FakeProcess>();
  async function turnOf(id: string, text: string) {
    if (state.active !== id) switchTo(id);
    const before = processes.map(process => process.sent.length);
    const result = await say(text);
    const served = processes.find((process, index) => process.sent.length > (before[index] ?? 0))!;
    holder.set(id, served);
    return { ...result, served };
  }
  return { pool, state, processes, closes, infos, holder, histories, task, say, switchTo, newConversation, editPersona, advance, turnOf, accepted,
    get clock() { return clock; } };
}

test('two characters alternating turns: neither process restarts (before: every switch-back started a cold process)', async () => {
  const w = world();
  const one1 = await w.turnOf('one', '你好');
  const gene1 = await w.turnOf('gene', '你好呀');
  const one2 = await w.turnOf('one', '我回来了');
  const gene2 = await w.turnOf('gene', '我也回来了');
  const one3 = await w.turnOf('one', '再聊一句');
  assert.equal(one2.served, one1.served, 'One\'s second turn is on her first process');
  assert.equal(one3.served, one1.served);
  assert.equal(gene2.served, gene1.served, 'Gene\'s second turn is on her first process');
  assert.notEqual(one1.served, gene1.served, 'each character has her own process');
  assert.equal(w.processes.length, 2, 'two processes in all, no restart');
  assert.ok(one1.served.alive && gene1.served.alive);
  assert.deepEqual(w.closes, [], 'nothing was closed');
  assert.deepEqual(w.infos.map(info => info.reuse), ['first', 'first', 'warm', 'warm', 'warm']);
  assert.deepEqual(w.infos.map(info => info.sessionTurn), [1, 1, 2, 2, 3], 'each process counts its own turns');
});

test('before (today\'s single process): the same alternation restarts on every switch, which is what the pool removes', async () => {
  // Kept as the "before" number of the record: one PersistentClaudeChat closes on every key change.
  const processes: FakeProcess[] = [];
  const chat = new PersistentClaudeChat({ enabled: true, binary: async () => 'claude', chattedBefore: () => false, provider: () => ({ kind: 'claude', model: 'haiku' }),
    startProcess: async options => { const made = new FakeProcess(options.model, processes.length); processes.push(made); return made as unknown as ClaudeChatProcess; }, log: () => {} });
  const histories = new Map<string, ChatMessage[]>();
  let generation = 0;
  for (const [id, text] of [['one', '你好'], ['gene', '你好呀'], ['one', '我回来了'], ['gene', '我也回来了']] as const) {
    generation++; chat.close('context');
    const history = histories.get(id) ?? [];
    await chat.stream({ kind: 'chat', model: 'haiku', workingDirectory: '.', writable: false, prompt: 'unused', imageDataUrls: [],
      session: { key: `${id}|${generation}`, basePersona: id, persona: id, messages: [...history, user(text)] } }, new AbortController().signal, () => {});
    histories.set(id, [...history, user(text), her('嗯')]);
  }
  assert.equal(processes.length, 4, 'four turns, four cold processes');
  chat.dispose();
});

test('a persona change closes only that character\'s process; the other stays warm', async () => {
  const w = world();
  const one = await w.turnOf('one', '你好');
  const gene = await w.turnOf('gene', '你好呀');
  w.switchTo('one');
  w.editPersona('你是one，今天换了说话方式。');
  assert.equal(one.served.alive, false, 'her process closed at the change');
  assert.equal(gene.served.alive, true, 'Gene\'s is untouched');
  const again = await w.turnOf('one', '还在吗');
  assert.notEqual(again.served, one.served, 'she starts a new process');
  const geneAgain = await w.turnOf('gene', '我回来了');
  assert.equal(geneAgain.served, gene.served, 'Gene is still on her process');
  assert.deepEqual(w.closes, ['context']);
});

test('a new conversation (or a deleted chat of the one on stage) closes only her process', async () => {
  const w = world();
  const gene = await w.turnOf('gene', '你好呀');
  const one = await w.turnOf('one', '你好');
  w.newConversation();
  assert.equal(one.served.alive, false);
  assert.equal(gene.served.alive, true);
});

test('a model or connection change closes the processes of the old connection (they cannot be used any more)', async () => {
  const w = world();
  const one = await w.turnOf('one', '你好');
  const gene = await w.turnOf('gene', '你好呀');
  w.state.provider = 'p2'; w.state.model = 'sonnet';
  w.switchTo('gene');
  assert.equal(one.served.alive, false);
  assert.equal(gene.served.alive, false);
  const again = await w.turnOf('gene', '换了模型');
  assert.equal(again.served.model, 'sonnet');
});

test('deleting a character\'s chats closes her process even when she is not on stage; another character is untouched', async () => {
  const w = world();
  const gene = await w.turnOf('gene', '你好呀');
  const one = await w.turnOf('one', '你好');
  w.pool.forgetCharacter('gene');
  assert.equal(gene.served.alive, false, 'what was deleted does not stay in her warm process');
  assert.equal(one.served.alive, true);
  w.pool.forgetCharacter(null); // the archive cannot say whose: every process goes
  assert.equal(one.served.alive, false);
});

test('idle per process: the one on stage is seen (10 minutes), a character switched away is not seen (3 minutes from the switch)', async () => {
  const w = world();
  const one = await w.turnOf('one', '你好');
  w.advance(5 * 60_000); // five quiet minutes with One on stage: still within her 10
  assert.equal(one.served.alive, true);
  const gene = await w.turnOf('gene', '你好呀'); // the switch: One is now not seen, from now on
  w.advance(179_000);
  assert.equal(one.served.alive, true, 'not before 3 minutes after the switch');
  w.advance(2_000);
  assert.equal(one.served.alive, false, 'closed 3 minutes after the switch');
  assert.ok(w.closes.includes('hidden'));
  assert.equal(gene.served.alive, true, 'Gene is on stage and seen');
  w.advance(600_000);
  assert.equal(gene.served.alive, false, 'Gene: the ordinary 10 minutes');
  assert.deepEqual(w.closes, ['hidden', 'idle']);
  const back = await w.turnOf('one', '我回来了');
  assert.equal(w.infos.at(-1)?.reuse, 'hidden', 'the journal says why her process had ended');
  assert.notEqual(back.served, one.served);
});

test('switching back within 3 minutes finds her process warm', async () => {
  const w = world();
  const one = await w.turnOf('one', '你好');
  await w.turnOf('gene', '你好呀');
  w.advance(150_000);
  const back = await w.turnOf('one', '我回来了');
  assert.equal(back.served, one.served);
  assert.equal(w.infos.at(-1)?.reuse, 'warm');
});

test('hiding the companion window applies the 3-minute rule to the one on stage only', async () => {
  const w = world();
  const gene = await w.turnOf('gene', '你好呀');
  const one = await w.turnOf('one', '你好'); // Gene switched away at 0
  w.advance(100_000);
  await w.turnOf('one', '还在'); // One's last activity at 100 s
  w.pool.noteVisible(false);
  w.advance(80_000);
  assert.equal(gene.served.alive, false, 'Gene: 3 minutes after her switch');
  assert.equal(one.served.alive, true, 'One: 3 minutes after her last activity, not yet');
  w.advance(100_000);
  assert.equal(one.served.alive, false);
});

test('seen elsewhere (out in full-screen) keeps the 10-minute rule for the one on stage only', async () => {
  let out = true;
  const w = world({ pool: { seenElsewhere: () => out } });
  const gene = await w.turnOf('gene', '你好呀');
  const one = await w.turnOf('one', '你好');
  w.pool.noteVisible(false);
  w.advance(300_000);
  assert.equal(one.served.alive, true, 'she is out on screen: still seen');
  assert.equal(gene.served.alive, false, 'Gene is not on stage: not seen, whatever full-screen says');
  out = false;
});

test('the cap of 3 closes the least recently used, never the one speaking', async () => {
  const w = world();
  const one = await w.turnOf('one', '你好');
  const gene = await w.turnOf('gene', '你好呀');
  const ann = await w.turnOf('ann', '嗨');
  await w.turnOf('gene', '又是我'); // Gene used again: One is now the least recently used
  const bo = await w.turnOf('bo', '你好');
  assert.equal(one.served.alive, false, 'One, used longest ago, closed');
  assert.ok(gene.served.alive && ann.served.alive && bo.served.alive, 'three stay warm');
  assert.equal(w.closes.filter(reason => reason === 'cap').length, 1);
  assert.equal(w.pool.slots().filter(slot => slot.warm).length, 3);
  const back = await w.turnOf('one', '我回来了');
  assert.equal(w.infos.at(-1)?.reuse, 'cap', 'the journal says the cap closed her process');
  assert.equal(ann.served.alive, false, 'now Ann was the least recently used');
  assert.ok(back.served.alive && gene.served.alive && bo.served.alive);
});

test('the cap never closes the speaking character, even at 1', async () => {
  const w = world({ maxWarm: 1 });
  const one = await w.turnOf('one', '你好');
  const gene = await w.turnOf('gene', '你好呀');
  assert.equal(one.served.alive, false);
  assert.equal(gene.served.alive, true, 'the speaking one stays');
  const geneAgain = await w.turnOf('gene', '还是我');
  assert.equal(geneAgain.served, gene.served);
});

test('capVictims: least recently used first, never the kept one or a busy one', () => {
  const slot = (key: string, lastUsed: number, warm = true, busy = false) => ({ key, lastUsed, warm, busy });
  const keep = slot('d', 9);
  assert.deepEqual(capVictims([slot('a', 1), slot('b', 2), slot('c', 3), keep], keep, 3).map(s => s.key), ['a']);
  assert.deepEqual(capVictims([slot('a', 5), slot('b', 2), slot('c', 3), keep], keep, 2).map(s => s.key), ['b', 'c']);
  assert.deepEqual(capVictims([slot('a', 1, true, true), slot('b', 2), keep], keep, 2).map(s => s.key), ['b'], 'a busy one is skipped');
  assert.deepEqual(capVictims([slot('a', 1, false), slot('b', 2), keep], keep, 2).map(s => s.key), [], 'one that holds no process does not count');
  assert.deepEqual(capVictims([keep], keep, 1), []);
  assert.deepEqual(capVictims([slot('a', 1), keep], keep, 0).map(s => s.key), ['a'], 'a cap below 1 still keeps the speaking one');
});

test('stop and interrupt reach only the speaking character\'s process; the cut turn stays in hers, so both continue warm', async () => {
  const w = world();
  const gene = await w.turnOf('gene', '你好呀');
  const one = await w.turnOf('one', '你好');
  // Stop: the user stops One mid-reply.
  const stop = new AbortController();
  const stopping = w.say('#slow 讲个长故事', undefined, stop.signal);
  await new Promise(resolve => setImmediate(resolve));
  stop.abort();
  await assert.rejects(stopping);
  // The cut note: the window shows the stopped reply as far as it got, and her session recorded the same, so the next turn lines up.
  w.histories.set('one', [...w.histories.get('one')!, user('#slow 讲个长故事'), her('半句')]);
  assert.equal(one.served.interrupted, 1, 'One\'s process was interrupted');
  assert.equal(gene.served.interrupted, 0, 'Gene\'s was not');
  assert.ok(one.served.alive && gene.served.alive, 'neither closed by a stop');
  // Interrupt (a new message while she speaks): the supersede hook goes to One's process only.
  let supersede: (() => boolean) | null = null;
  const speaking = w.say('#slow 再讲一个', { started: hook => { supersede = hook; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(supersede!(), true);
  const outcome = await speaking;
  assert.equal(outcome.outcome.superseded, true);
  assert.equal(one.served.superseded, 1);
  assert.equal(gene.served.superseded, 0);
  assert.equal(one.served.alive, true, 'an interrupt does not close her process');
  const next = await w.turnOf('one', '好吧');
  assert.equal(next.served, one.served);
  const geneNext = await w.turnOf('gene', '我在');
  assert.equal(geneNext.served, gene.served);
});

test('calls use the calling character\'s process and its own turn count', async () => {
  const w = world({ maxTurns: 2, callMaxTurns: 4 });
  const one = await w.turnOf('one', '1');
  const gene = await w.turnOf('gene', '1');
  await w.turnOf('one', '2'); // One's second turn: her budget of 2 retires her process
  assert.equal(one.served.alive, false, 'One retired after her own 2 turns');
  assert.equal(gene.served.alive, true, 'Gene has had one turn: not retired');
  const geneTwo = await w.turnOf('gene', '2');
  assert.equal(geneTwo.served, gene.served);
  assert.equal(gene.served.alive, false, 'Gene retired after her own 2');
  // A call with Gene: her process is held warm and counts to the call's cap; One, off stage, still idles out.
  const fresh = await w.turnOf('one', '3');
  w.switchTo('gene');
  w.pool.holdWarm(true);
  const call: FakeProcess[] = [];
  for (const text of ['喂', '在吗', '听得到吗']) call.push((await w.turnOf('gene', text)).served);
  assert.equal(new Set(call).size, 1, 'three call turns on one process (the ordinary cap of 2 does not apply during the call)');
  w.advance(181_000);
  assert.equal(fresh.served.alive, false, 'One, not on stage, closed after 3 minutes during Gene\'s call');
  assert.equal(call[0].alive, true, 'the call holds Gene\'s process');
  w.pool.holdWarm(false);
  w.advance(600_001);
  assert.equal(call[0].alive, false, 'after the call the idle clock runs again');
});

test('a turn accepted for an older context never closes the process of the one on stage', async () => {
  const w = world();
  await w.turnOf('one', '你好');
  const stale = w.task('迟到的一句');
  const gene = await w.turnOf('gene', '你好呀');
  await assert.rejects(w.pool.stream(stale, new AbortController().signal, () => {}), (error: unknown) => error instanceof ClaudeTurnError && error.kind === 'closed');
  assert.equal(gene.served.alive, true);
  const again = await w.turnOf('gene', '还在');
  assert.equal(again.served, gene.served);
});

test('the slot key names the character, the connection and the model; the chat key leaves out the context generation', () => {
  assert.notEqual(sessionSlotKey('one', 'p', 'haiku'), sessionSlotKey('gene', 'p', 'haiku'));
  assert.notEqual(sessionSlotKey('one', 'p', 'haiku'), sessionSlotKey('one', 'q', 'haiku'));
  assert.notEqual(sessionSlotKey('one', 'p', 'haiku'), sessionSlotKey('one', 'p', 'opus'));
  assert.equal(chatSessionKey('one', 'p', 'c1'), chatSessionKey('one', 'p', 'c1'));
  assert.notEqual(chatSessionKey('one', 'p', 'c1'), chatSessionKey('one', 'p', 'c2'));
  assert.equal(SESSION_POOL_KNOBS.maxWarm, 3);
});

test('two failures in a row switch every character to one process per message for the rest of the run', async () => {
  const perMessage: string[] = [];
  const w = world({ crash: true, pool: { perMessage: async (task, _signal, emit) => { perMessage.push(task.kind); emit('delta', '嗯'); } } });
  await assert.rejects(w.turnOf('one', '你好'));
  await assert.rejects(w.turnOf('one', '你好'));
  assert.equal(w.pool.active, false);
  await w.turnOf('gene', '你好呀');
  assert.equal(perMessage.length, 1, 'Gene too goes per message');
});

type ChatLike = Pick<PersistentClaudeChat, 'stream' | 'close' | 'noteVisible' | 'prewarm' | 'dispose'>;

/** One character: the pool (both ways it is built) and today's PersistentClaudeChat send the same messages to the same processes. */
test('a single character behaves exactly as today', async () => {
  const run = async (make: (options: PersistentClaudeOptions, keys: () => { accepted: string; chat: string }) => ChatLike) => {
    let clock = 0, next = 0, generation = 0, conversation = 'c1';
    const timers = new Map<number, { due: number; callback: () => void }>();
    const processes: FakeProcess[] = [], infos: string[] = [];
    const accepted = () => `one|${generation}|${conversation}`;
    const chat = make({ enabled: true, binary: async () => 'claude', chattedBefore: () => true, provider: () => ({ kind: 'claude', model: 'haiku' }), maxTurns: 3,
      startProcess: async options => { const made = new FakeProcess(options.model, processes.length); processes.push(made); return made as unknown as ClaudeChatProcess; },
      now: () => clock, timers: { set: (callback, ms) => { timers.set(++next, { due: clock + ms, callback }); return next; }, clear: handle => { timers.delete(handle as number); } },
      idleMs: 600_000, hiddenIdleMs: 180_000, log: () => {}, timing: { dispatched: (_id, info) => { infos.push(`${info.process}/${info.reuse}/${info.sessionTurn}`); }, firstDelta: () => {} } },
    () => ({ accepted: accepted(), chat: chatSessionKey('one', 'p', conversation) }));
    const advance = (ms: number) => { const until = clock + ms; for (;;) { const due = [...timers.entries()].filter(([, t]) => t.due <= until).sort((a, b) => a[1].due - b[1].due)[0]; if (!due) break; timers.delete(due[0]); clock = due[1].due; due[1].callback(); } clock = until; };
    let history: ChatMessage[] = [];
    const say = async (text: string, signal = new AbortController().signal) => {
      const outcome = await chat.stream({ kind: 'chat', model: 'haiku', workingDirectory: '.', writable: false, prompt: 'unused', imageDataUrls: [], replyId: `r${text}`,
        session: { key: accepted(), basePersona: 'p', persona: 'p 心情', messages: [...history, user(text)] } }, signal, () => {});
      history = [...history, user(text), her(outcome.output)];
      for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); // a spare's start settles before the clock moves (real timers are never 0 ms)
    };
    chat.noteVisible(true); // the window is shown at start: a spare
    await new Promise(resolve => setImmediate(resolve));
    for (const text of ["一", "二", "三", "四"]) await say(text); // the budget of 3 retires the first process
    const stop = new AbortController(), stopped = say('#slow 五', stop.signal);
    for (let i = 0; i < 1000 && !processes.some(process => process.busy); i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(processes.some(process => process.busy), 'the slow turn is running');
    stop.abort();
    await stopped.catch(() => {});
    history = [...history, user('#slow 五'), her('半句')];
    await say("六");
    advance(120_000); chat.noteVisible(false); advance(200_000); // hidden: closed
    await say("七");
    generation++; conversation = 'c2'; history = []; chat.close('context'); // a new conversation
    await new Promise(resolve => setImmediate(resolve));
    await say("八");
    chat.noteVisible(true); chat.prewarm();
    advance(700_000);
    chat.dispose();
    return { infos, spawned: processes.length, sent: processes.map(process => process.sent), alive: processes.map(process => process.alive) };
  };
  const today = await run(options => new PersistentClaudeChat(options));
  const single = await run(options => new ClaudeSessionPool(options));
  const pooled = await run((options, keys) => new ClaudeSessionPool({ ...options, turn: () => ({ characterId: 'one', providerScope: 'p', ...keys() }), stage: () => ({ characterId: 'one', providerScope: 'p' }) }));
  assert.ok(today.spawned >= 4, `the scenario starts several processes (${today.spawned})`);
  for (const [name, got] of [['without turn', single], ['with one character', pooled]] as const) {
    assert.deepEqual(got.infos, today.infos, `${name}: the same process kinds, reuse reasons and turn numbers`);
    assert.equal(got.spawned, today.spawned, `${name}: the same number of processes`);
    assert.deepEqual(got.sent, today.sent, `${name}: the same messages to each`);
    assert.deepEqual(got.alive, today.alive, `${name}: the same ones closed`);
  }
});

test('I-209 step 2: a turn carries its owner; it runs in her slot even while someone else is on stage, and a stale one of hers is refused', async () => {
  const seatKeys = new Map<string, string>([['gene', 'gene-seat-1']]);
  // The app's sources: the desktop companion ('one') as before; someone else on stage answers with her own seat's keys.
  const w = world({ pool: { turn: owner => !owner || owner === 'one'
    ? { characterId: 'one', providerScope: 'p1', accepted: 'one|p1|0', chat: chatSessionKey('one', 'p1', 'c-one') }
    : seatKeys.has(owner) ? { characterId: owner, providerScope: 'p1', accepted: seatKeys.get(owner)!, chat: chatSessionKey(owner, 'p1', `c-${owner}`) } : null } });
  await w.say('你好'); // the companion's turn, no owner: her slot as before
  const geneTask = w.task('我也在', 'gene-seat-1');
  geneTask.session!.owner = 'gene';
  await w.pool.stream(geneTask, new AbortController().signal, () => {});
  assert.deepEqual(w.pool.slots().map(slot => [slot.characterId, slot.onStage]).sort(), [['gene', false], ['one', true]], 'Gene ran in her own slot; One stays on stage');
  assert.equal(w.processes.length, 2);
  // A switch of the companion does not change Gene's accepted key, so her warm process is still hers.
  const again = w.task('还在', 'gene-seat-1'); again.session!.owner = 'gene';
  again.session!.messages = [...geneTask.session!.messages, her('嗯'), user('还在')]; // her own history goes on
  await w.pool.stream(again, new AbortController().signal, () => {});
  assert.equal(w.processes.length, 2, 'her second turn is warm in her slot');
  // Her seat changed (she left the stage and came back): the old accepted key is refused, never sent to anyone.
  seatKeys.set('gene', 'gene-seat-2');
  const stale = w.task('迟到', 'gene-seat-1'); stale.session!.owner = 'gene';
  await assert.rejects(w.pool.stream(stale, new AbortController().signal, () => {}), /所属的角色或对话已改变/);
  const gone = w.task('不在台上', 'x'); gone.session!.owner = 'nobody';
  await assert.rejects(w.pool.stream(gone, new AbortController().signal, () => {}), /所属的角色或对话已改变/);
});

