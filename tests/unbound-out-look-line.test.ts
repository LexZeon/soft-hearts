// 2026-11-21: while she is out in full-screen Unbound,
// the short line after a semantic look is said in her full-screen bubble (read aloud there), once, never beside it in the companion window; and every gate
// that meant "she can be seen and heard right now" reads herOnScreen (the companion window shown, or out with her bubble able to show) instead of the
// companion window itself. At home nothing changes. Reads as text (test-affected selects it): 'electron/wiring/initiative-look-wiring.ts', 'electron/wiring/mood-wiring.ts', 'electron/wiring/senses-listen-wiring.ts'.
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { SenseRouterHost, type SenseRouterPorts } from '../electron/senses/sense-router/host';
import { deliverSenseLine, senseLineFree, type SenseFreeFacts, type SenseLineRoute } from '../electron/senses/sense-router/free';
import { cameraLookLater } from '../shared/senses/camera-look';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { ENGLISH_JOURNAL_UI_COPY } from '../shared/foundation/ui-copy.journal.en';
import { HeldLines, type HeldLinePorts } from '../src/brain/held-lines';
import type { SenseLineMessage } from '../shared/senses/sense-router';
import { WIRING_PRELUDE, wiringOption } from './helpers/wiring-source';

function evaluate<T>(body: string, env: Record<string, unknown>): T {
  const code = ts.transpileModule(`${WIRING_PRELUDE}\n${body}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(env), code)(...Object.values(env)) as T;
}
const option = <T>(variable: string, name: string, env: Record<string, unknown>): T => evaluate<T>(`return (${wiringOption(variable, name)});`, env);
const plain = (source: string, ...items: readonly unknown[]) => source.replace(/\{(\d+)\}/g, (_, i: string) => String(items[Number(i)]));

const calm: SenseFreeFacts = { herOnScreen: true, dragging: false, replySpeechBusy: false, ambientSpeaking: false, proactiveBusy: false, chatPending: false, gameActive: false, userInputUntil: 0, now: 10 };

// ---------------------------------------------------------------- "free": seen and heard now, wherever she is

test('free: on screen (the companion shown or out with her bubble able to show) and nothing else of hers going on; every other thing still holds it', () => {
  assert.equal(senseLineFree(calm), true);
  assert.equal(senseLineFree({ ...calm, herOnScreen: false }), false, 'not seen anywhere: the line waits (and is dropped when the wait runs out)');
  for (const busy of [{ dragging: true }, { replySpeechBusy: true }, { ambientSpeaking: true }, { proactiveBusy: true }, { chatPending: true }, { gameActive: true }, { userInputUntil: 11 }])
    assert.equal(senseLineFree({ ...calm, ...busy }), false, JSON.stringify(busy));
});

// ---------------------------------------------------------------- where the line goes

const message: SenseLineMessage = { id: 'sense-1', text: '这身蓝衬衫挺精神的', origin: { kind: 'proactive', id: 'sense-1', at: 1, sources: ['camera'], labels: ['刚看了一眼摄像头'] } };
function route(world: { home: boolean; bubble?: boolean }) {
  const log: string[] = [];
  const r: SenseLineRoute = {
    homeShown: () => world.home,
    hold: (id, text) => { log.push(`hold ${id} ${text}`); return world.bubble !== false; },
    sendCompanion: (line, held) => { log.push(`companion ${line.id} held=${held}`); return true; },
    shownOut: id => { log.push(`shownOut ${id}`); },
  };
  return { r, log };
}

test('delivery: out, the line goes into her bubble once and the companion window only gets it as held (no second copy); at home, the companion window as before', () => {
  const out = route({ home: false });
  assert.equal(deliverSenseLine(out.r, message), 'out');
  assert.deepEqual(out.log, ['hold sense-1 这身蓝衬衫挺精神的', 'companion sense-1 held=true', 'shownOut sense-1']);
  const home = route({ home: true });
  assert.equal(deliverSenseLine(home.r, message), true);
  assert.deepEqual(home.log, ['companion sense-1 held=false'], 'at home nothing changes: no bubble call, no early report');
  const none = route({ home: false, bubble: false });
  assert.equal(deliverSenseLine(none.r, message), false, 'her bubble could not take it: nothing is sent anywhere');
  assert.deepEqual(none.log, ['hold sense-1 这身蓝衬衫挺精神的']);
});

// ---------------------------------------------------------------- the router, end to end

const JPEG = 'data:image/jpeg;base64,WU9V';
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
class Clock {
  now = 0; private timers: { at: number; fn: () => void; id: number }[] = []; private next = 0;
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

/** A router whose "she is out" and "free" are the real rules over a small world; `host.done` plays the wiring's shownOut. */
function world(options: { out: boolean; on?: boolean }) {
  const clock = new Clock();
  const state = { out: options.out, on: options.on ?? true, busy: false };
  const log: string[] = [], results: [string, object][] = [], bubbleLines: string[] = [], companionLines: { id: string; held: boolean }[] = [];
  let host!: SenseRouterHost;
  const routeOf: SenseLineRoute = {
    homeShown: () => !state.out,
    hold: (_id, text) => { bubbleLines.push(text); return true; },
    sendCompanion: (line, held) => { companionLines.push({ id: line.id, held }); return true; },
    shownOut: id => { host.done(true, { id, shown: true }); },
  };
  const ports: SenseRouterPorts = {
    enabled: () => true, on: () => ({ camera: state.on, screen: false, transcript: false }), identity: () => 'i', conversation: () => 'c',
    capture: async () => JPEG, heard: () => null,
    ask: async (_prompt, system) => system.includes('感知判定员') ? '{"senses":["camera"]}' : '他穿着一件蓝色衬衫。',
    line: async () => JSON.stringify({ text: '这身蓝衬衫挺精神的' }),
    character: () => ({ id: 'heroine', persona: 'p', language: '' }), mood: () => '',
    free: () => senseLineFree({ ...calm, herOnScreen: true, chatPending: state.busy, now: clock.now }),
    publish: line => deliverSenseLine(routeOf, line), speechStyle: () => {}, archive: async line => { log.push(`archive ${line.id}`); },
    cameraLook: (_id, result, detail) => results.push([result, detail ?? {}]),
    clock: () => clock.now, timers: clock.api, createId: () => 'x',
  };
  host = new SenseRouterHost(ports);
  return { host, clock, state, log, results, bubbleLines, companionLines };
}
async function ask(w: ReturnType<typeof world>, id: string, text: string): Promise<void> {
  w.host.userTurn(id, text, { merged: false }); w.host.firstChar(id); await w.clock.advance(100);
  w.host.replyDone(id, true, '嗯'); await w.clock.advance(100);
}

test('router, out: the look\'s line is said in her full-screen bubble once, archived once, held (not shown) in the companion window, and the journal says "delivered out"', async () => {
  const w = world({ out: true });
  await ask(w, 'm1', '我这身怎么样');
  assert.deepEqual(w.bubbleLines, ['这身蓝衬衫挺精神的'], 'one line in her bubble');
  assert.deepEqual(w.companionLines, [{ id: 'sense-x', held: true }], 'the companion window only remembers and reads it');
  assert.deepEqual(w.log, ['archive sense-x'], 'archived once');
  assert.deepEqual(w.results, [['seen', { out: true }]]);
  assert.equal(w.host.stats.shown, 1);
});

test('router, at home: the line goes to the companion window as it always did, the bubble is untouched, the journal says nothing extra', async () => {
  const w = world({ out: false });
  w.host.done(true, { id: 'nothing', shown: true }); // no line is waiting: ignored
  const wait = ask(w, 'm1', '我这身怎么样');
  await w.clock.advance(50);
  // the companion window reports the line shown (its own presenter does this at home)
  for (let i = 0; i < 20 && !w.companionLines.length; i++) await w.clock.advance(100);
  assert.deepEqual(w.companionLines, [{ id: 'sense-x', held: false }]);
  assert.deepEqual(w.bubbleLines, []);
  w.host.done(true, { id: 'sense-x', shown: true });
  await wait; await w.clock.advance(100);
  assert.deepEqual(w.results, [['seen', {}]]);
});

test('router: a newer message first drops the waiting line (it folds into that reply as today) and "别看" reads no frame; nothing is said out', async () => {
  const w = world({ out: true });
  w.state.busy = true; // not free: the line waits
  await ask(w, 'm1', '我这身怎么样');
  assert.deepEqual(w.bubbleLines, [], 'waiting while she is busy');
  w.host.userTurn('m2', '算了，别看', { merged: false }); await w.clock.advance(100);
  w.state.busy = false; await w.clock.advance(2_000);
  assert.deepEqual(w.bubbleLines, [], 'the old turn ended with the newer message: it is never said late');
  assert.deepEqual(w.results[0], ['cut-short', { stage: 'unsaid', end: 'newer' }]);
  const held = world({ out: true });
  held.host.userTurn('h1', '别看我', { merged: false }); held.host.firstChar('h1'); await held.clock.advance(100);
  held.host.replyDone('h1', true, '好'); await held.clock.advance(2_000);
  assert.deepEqual(held.bubbleLines, [], 'a "别看" message never looks and never says');
});

// ---------------------------------------------------------------- the journal

test('journal: "delivered out" rides only on a look whose line was said (later); the old reasons stay for lines that were not', () => {
  assert.deepEqual(cameraLookLater(false, 'seen', { out: true }), { seen: 'later', out: true });
  assert.deepEqual(cameraLookLater(false, 'seen'), { seen: 'later' });
  assert.deepEqual(cameraLookLater(false, 'cut-short', { stage: 'unsaid', end: 'not-free', out: true }), { seen: 'none', why: 'cut-short', stage: 'unsaid', end: 'not-free' }, 'a cut-short line carries its reason, not "out"');
  const write = (line: object) => buildJournalEntry({ type: 'camera-look', characterId: 'heroine', ...line }, 0);
  const entry = write({ seen: 'later', out: true });
  assert.ok(entry);
  assert.match(describeJournalEntry(entry!, plain), /她回完话又看了你一眼（她在全屏里说了）/u);
  assert.match(describeJournalEntry(entry!, (source, ...items) => plain(ENGLISH_JOURNAL_UI_COPY[source] ?? source, ...items)), /full-screen bubble/u);
  assert.equal(write({ seen: 'none', why: 'cut-short', out: true }), null, 'out on a look that was not said is no line');
  assert.equal(write({ seen: 'later', out: 'yes' }), null);
  assert.equal(write({ seen: 'later', out: true, why: 'cut-short' }), null);
});

// ---------------------------------------------------------------- her companion window: remember and read, never show

function held(options: { chat?: boolean } = {}) {
  const log: string[] = [];
  const ports: HeldLinePorts = {
    ackVision: async () => true, ackAmbient: async () => null, free: () => !options.chat, voiceOn: () => true,
    speak: async (text, context) => { log.push(`speak ${text} ${JSON.stringify(context)}`); }, stop: () => {}, ended: id => { log.push(`ended ${id}`); },
    rememberVision: () => {}, rememberAmbient: () => {}, rememberSense: line => { log.push(`remember ${line.id}`); },
  };
  return { lines: new HeldLines(ports), log };
}

test('companion window while she is out: a held sense line is remembered and read aloud once, never shown there; a line that is not held is left to the presenter', async () => {
  const { lines, log } = held();
  assert.equal(lines.sense({ ...message, held: true }), true);
  await flush();
  assert.deepEqual(log, ['remember sense-1', 'speak 这身蓝衬衫挺精神的 {"replyId":"sense-1"}', 'ended sense-1']);
  const other = held();
  assert.equal(other.lines.sense(message), false, 'at home the companion presenter shows it');
  assert.equal(other.lines.sense(null), false);
  assert.deepEqual(other.log, []);
  const bad = held();
  assert.equal(bad.lines.sense({ id: 'x', text: 'y', origin: null, held: true }), true, 'a malformed held line is swallowed, never shown');
  await flush();
  assert.deepEqual(bad.log, []);
  const busy = held({ chat: true });
  assert.equal(busy.lines.sense({ ...message, held: true }), true);
  await flush();
  assert.deepEqual(busy.log, [], 'a reply running in this window: not read over it');
});

// ---------------------------------------------------------------- how much she says is hers

test('the follow-up prompt: no one-short-sentence rule (zh, relaxed zh, en); she may say nothing, a word or a few sentences; only a sanity ceiling remains', async () => {
  const { senseLinePrompt, SENSE_LINE_SYSTEM_PROMPT } = await import('../shared/senses/sense-router');
  const input = { persona: 'p', userText: '我这身怎么样', reply: '嗯', notes: [{ sense: 'camera' as const, kind: 'seen' as const, facts: '蓝衬衫' }] };
  for (const prompt of [senseLinePrompt(input), senseLinePrompt({ ...input, relaxed: true })]) {
    assert.ok(!/不超过 30 个字|只有一行/u.test(prompt), 'no length or one-line rule');
    assert.match(prompt, /说多少你自己定/u);
    assert.match(prompt, /text 就留空/u, 'she may still say nothing');
  }
  const { SENSE_LINE_TEXT_RELAXED } = await import('../shared/foundation/i139-texts');
  const english = SENSE_LINE_TEXT_RELAXED.how(true, false, 'en' as never);
  assert.ok(!/at most 30|One line/u.test(english) && /up to you/u.test(english));
  assert.ok(!/补一句短的/u.test(SENSE_LINE_SYSTEM_PROMPT));
});

// ---------------------------------------------------------------- the wiring reads the same predicate

const companionWindow = (shown: boolean) => ({ isDestroyed: () => false, isVisible: () => shown, isMinimized: () => false, webContents: { id: 1 } });

test('wiring: the sense router\'s free, her own look\'s present and the mood judge\'s "shown" read herOnScreen (out counts), not the companion window', () => {
  const asked = { value: false };
  // `needs` in the sandbox reads each name from the env (the companion window is hidden in all of them)
  // no-pet-ok: `pet` and `petWindowDrag` are the wiring's own names that the sandbox reads
  const env = { pet: companionWindow(false), petWindowDrag: null, ambientSpeakingOwners: { size: 0 }, pending: { values: () => [][Symbol.iterator]() }, herOnScreen: () => asked.value };
  const free = option<() => boolean>('senseRouter', 'free', { ...env, senseLineFree, replySpeechBusy: () => false, userInputUntil: 0, proactiveSpeechGate: { busy: false }, rps: { host: { active: false } } });
  assert.equal(free(), false);
  asked.value = true;
  assert.equal(free(), true, 'out: the companion window is hidden but herOnScreen says she is seen');
  const present = option<() => boolean>('selfLook', 'present', { ...env, chatAvailability: { isAvailable: () => true } });
  assert.equal(present(), true);
  asked.value = false;
  assert.equal(present(), false);
  // no-pet-ok: petVisible is the mood judge option's existing name
  const judge = option<() => boolean>('moodJudge', 'petVisible', env);
  assert.equal(judge(), false);
  asked.value = true;
  assert.equal(judge(), true);
});

test('wiring: the computer\'s sound can start while her companion window is hidden only because she is out (onScreen), and not when it is hidden at home', () => {
  const state = { out: false, shown: false };
  // no-pet-ok: `pet` is the wiring's own name for the companion window
  const env = { process: { platform: 'win32' }, pet: { ...companionWindow(false), isVisible: () => state.shown, webContents: { id: 1 } }, ambientAsr: { ready: () => true },
    onScreen: (win: { isVisible(): boolean }) => win.isVisible() || state.out };
  const canStart = option<(owner: number) => boolean>('ambientAudio', 'canStart', env);
  assert.equal(canStart(1), false, 'hidden at home');
  state.out = true;
  assert.equal(canStart(1), true, 'hidden because she is out');
  assert.equal(canStart(2), false, 'another window never');
  state.out = false; state.shown = true;
  assert.equal(canStart(1), true, 'shown at home');
});
