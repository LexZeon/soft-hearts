// Read-aloud while she is out in Unbound (docs/claude/2026-11-15-unbound-read-aloud.md). The rule stays the companion's: what is spoken
// must be what was displayed. Her Unbound bubble is the one display proof while she is out: the page reports exactly which text it
// painted, only from its own top frame; the host counts a report only for exactly the text it sent at that revision, in order,
// while the bubble can be seen. Her own lines (inner loop, a touch, a visual topic, an ambient comment) go into that bubble and are
// read under the same proof; asleep still never speaks. The real host handlers for ordinary replies are driven in
// tests/r27-prefix-host-caller.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
// Reads as text (test-affected selects this test when they change): 'electron/main.ts' (wiring rewrite step 4c: with electron/wiring/*.ts).
import { WIRING_PRELUDE, wiringFunction } from './helpers/wiring-source';
import ts from 'typescript';
import { UnboundBubbleProof, retractedLineId } from '../electron/unbound/read-aloud';
import { parseUnboundShown } from '../shared/unbound/shown';
import { UnboundHost, type UnboundHostPorts, type UnboundIpcEvent, type UnboundWindowLike } from '../electron/unbound/host';
import { type PetPort } from '../electron/unbound/mode';
import { unboundSource } from '../electron/unbound/source';
import { UNBOUND_EVENTS, UNBOUND_REQUESTS, type UnboundBubble } from '../shared/unbound/scene';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import type { DisplayFacts, Rect } from '../shared/unbound/world';
import { HeldLines, type HeldLinePorts } from '../src/brain/held-lines';
import { ShownReporter } from '../src/unbound/shown-reporter';
import { ReplyBubble } from '../src/unbound/bubbles';
import { ProactiveSpeechGate } from '../electron/initiative/proactive-speech-gate';
import { createInnerLoopHost } from '../electron/initiative/inner-loop/host';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/foundation/mood';
import type { FatiguePhase } from '../shared/mood/fatigue';
import { formatVisionPresentation, type VisionInitiative, type VisionInitiativeEvent } from '../shared/senses/vision-runtime';
import type { SpeechRequestContext } from '../shared/voice/tts';
import type { AmbientComment } from '../shared/senses/ambient-audio';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };

// ---- the proof itself -------------------------------------------------------------------------------------------------------------

function proof(timeoutMs = 200) {
  const place = { seen: true };
  const p = new UnboundBubbleProof({ active: () => place.seen, timeoutMs });
  return { p, place };
}

test('proof: a report counts only for exactly the text sent at that revision, for the current bubble, in order, while she is out', () => {
  const { p, place } = proof();
  const r1 = p.sent('reply-1', '你好'), r2 = p.sent('reply-1', '，今天');
  assert.equal(p.report({ id: 'reply-1', rev: r1, text: '你好呀', visible: true }), false, 'text the host never sent');
  assert.equal(p.report({ id: 'reply-1', rev: r2, text: '你好', visible: true }), false, 'not the text of that revision');
  assert.equal(p.report({ id: 'reply-2', rev: r1, text: '你好', visible: true }), false, 'another bubble');
  assert.equal(p.report({ id: 'reply-1', rev: 999, text: '你好', visible: true }), false, 'a revision never sent');
  assert.equal(p.report({ id: 'reply-1', rev: r1, text: '你好', visible: true, extra: 1 }), false, 'junk fields');
  place.seen = false;
  assert.equal(p.report({ id: 'reply-1', rev: r1, text: '你好', visible: true }), false, 'not out, or behind a full-screen program');
  place.seen = true;
  assert.equal(p.report({ id: 'reply-1', rev: r2, text: '你好，今天', visible: true }), true);
  assert.equal(p.shownText, '你好，今天');
  assert.equal(p.report({ id: 'reply-1', rev: r1, text: '你好', visible: true }), false, 'an older revision after a newer one (late, out of order)');
  assert.equal(p.isCompletedPrefixCurrent('你好，今天'), true);
  assert.equal(p.isCompletedPrefixCurrent('你好'), false, 'only exactly what is proven now');
  assert.equal(p.isPresentationCurrent('你好，今天'), true, 'the whole bubble');
  place.seen = false;
  assert.equal(p.isCompletedPrefixCurrent('你好，今天'), false, 'her window hidden: nothing is current, even before anyone dropped it');
  assert.equal(p.isPresentationCurrent('你好，今天'), false);
  place.seen = true;
  p.sent('reply-1', '天气');
  assert.equal(p.isPresentationCurrent('你好，今天'), false, 'more text is on its way: not the whole bubble any more');
  assert.equal(p.isCompletedPrefixCurrent('你好，今天'), true, 'what was proven is still on screen (the bubble only appends)');
  assert.equal(p.report({ id: 'reply-1', rev: r2, text: '你好，今天', visible: false }), true, 'the page says it is not visible');
  assert.equal(p.shownText, '');
  assert.equal(p.isCompletedPrefixCurrent('你好，今天'), false);
  p.sent('reply-2', '新的');
  assert.equal(p.report({ id: 'reply-1', rev: r2, text: '你好，今天', visible: true }), false, 'a late report about the old bubble never revives it');
});

test('proof: the report parser takes exactly a report', () => {
  assert.deepEqual(parseUnboundShown({ id: 'a-1', rev: 3, text: 'x', visible: true }), { id: 'a-1', rev: 3, text: 'x', visible: true });
  for (const junk of [null, 'x', [], { id: 'a b', rev: 1, text: 'x', visible: true }, { id: 'a', rev: 0, text: 'x', visible: true },
    { id: 'a', rev: 1.5, text: 'x', visible: true }, { id: 'a', rev: 1, text: 3, visible: true }, { id: 'a', rev: 1, text: 'x', visible: 'yes' },
    { id: 'a', rev: 1, text: 'x'.repeat(32_001), visible: true }]) assert.equal(parseUnboundShown(junk), null);
});

test('proof: waitForPresentation is true once the whole line is painted, false when it leaves the screen, is replaced, or never comes', async () => {
  const { p, place } = proof(60);
  const rev = p.line('line-1', '主动 · 自己想说的\n你回来啦');
  const shown = p.waitForPresentation('主动 · 自己想说的\n你回来啦');
  p.report({ id: 'line-1', rev, text: '主动 · 自己想说的\n你回来啦', visible: true });
  assert.equal(await shown, true);
  assert.equal(await p.waitForPresentation('别的话'), false, 'not what the bubble holds');
  const r2 = p.line('line-2', '再说一句');
  const dropped = p.waitForPresentation('再说一句');
  place.seen = false; p.invalidate();
  assert.equal(await dropped, false, 'hidden while waiting');
  place.seen = true;
  const replaced = p.waitForPresentation('再说一句');
  p.line('line-3', '另一句');
  assert.equal(await replaced, false, 'replaced while waiting');
  assert.equal(p.report({ id: 'line-2', rev: r2, text: '再说一句', visible: true }), false);
  p.line('line-4', '没人报告');
  assert.equal(await p.waitForPresentation('没人报告'), false, 'no report in time');
  const controller = new AbortController(), aborted = p.waitForPresentation('没人报告', controller.signal);
  controller.abort();
  assert.equal(await aborted, false);
});

test('proof: prefix mode commits with exactly the painted text once it covers the sentence; a drop while waiting fails it', async () => {
  const { p, place } = proof();
  const body = '第一句。第二句。';
  const r1 = p.sent('r', '第一'), commits: string[] = [];
  const signal = new AbortController().signal;
  const waiting = p.waitForCompletedPrefix(() => body, 4, signal, 10_000, text => { commits.push(text); return true; });
  p.report({ id: 'r', rev: r1, text: '第一', visible: true });
  await settle();
  assert.deepEqual(commits, [], 'half a sentence');
  const r2 = p.sent('r', '句。第');
  p.report({ id: 'r', rev: r2, text: '第一句。第', visible: true });
  assert.equal(await waiting, true);
  assert.deepEqual(commits, ['第一句。第'], 'the painted text, covering the sentence');
  // The next sentence waits; her window goes behind a full-screen program meanwhile.
  const next = p.waitForCompletedPrefix(() => body, 8, signal, 10_000, () => true);
  place.seen = false; p.invalidate();
  assert.equal(await next, false);
  // A shown text that is not the start of this reply's body never proves it.
  place.seen = true;
  const r3 = p.sent('r', '二句。');
  p.report({ id: 'r', rev: r3, text: '第一句。第二句。', visible: true });
  assert.equal(await p.waitForCompletedPrefix(() => '别的回复。第二句。', 4, signal, 10_000, () => true), false);
});

test('retractedLineId: only her lines taken back', () => {
  assert.equal(retractedLineId('desk:vision-initiative', { type: 'cancel', id: 'v1' }), 'v1');
  assert.equal(retractedLineId('desk:vision-initiative', { type: 'offer', id: 'v1' }), null);
  assert.equal(retractedLineId('desk:ambient-comment-cancelled', { id: 'a1' }), 'a1');
  assert.equal(retractedLineId('desk:reply-speech-cancelled', 'r1'), null);
  assert.equal(retractedLineId('desk:stream', { id: 'r1' }), null);
});

// ---- the Unbound host: the page's report, her lines, what takes them away ------------------------------------------------------------

class FakePet implements PetPort {
  visible = true; minimized = false; destroyed = false; bounds: Rect = { x: 1100, y: 330, width: 400, height: 560 };
  isDestroyed() { return this.destroyed; } isVisible() { return this.visible; } isMinimized() { return this.minimized; }
  getBounds() { return { ...this.bounds }; } setBounds(bounds: Rect) { this.bounds = { ...bounds }; }
  hide() { this.visible = false; } showInactive() { this.visible = true; }
}
class FakeWindow implements UnboundWindowLike {
  readonly frame = {}; readonly sent: [string, unknown][] = [];
  visible = false; destroyed = false; bounds: Rect | null = null; private gone: (() => void)[] = [];
  readonly webContents = { id: 77, mainFrame: this.frame, send: (channel: string, value: unknown) => { this.sent.push([channel, value]); }, isDestroyed: () => this.destroyed };
  constructor(bounds?: Rect) { this.bounds = bounds ?? null; }
  isDestroyed() { return this.destroyed; } isVisible() { return this.visible && !this.destroyed; }
  showInactive() { this.visible = true; } hide() { this.visible = false; }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.visible = false; for (const callback of this.gone.splice(0)) callback(); }
  setIgnoreMouseEvents() {} setBounds(bounds: Rect) { this.bounds = bounds; } onGone(callback: () => void) { this.gone.push(callback); }
  event(frame: unknown = this.frame): UnboundIpcEvent { return { sender: { id: this.webContents.id, mainFrame: this.frame }, senderFrame: frame }; }
  bubbles(): UnboundBubble[] { return this.sent.filter(([name]) => name === UNBOUND_EVENTS.bubble).map(([, value]) => value as UnboundBubble); }
}
class FakeIpc {
  readonly handlers = new Map<string, (event: UnboundIpcEvent, ...args: unknown[]) => unknown>();
  handle(channel: string, listener: (event: UnboundIpcEvent, ...args: unknown[]) => unknown) { this.handlers.set(channel, listener); }
  removeHandler(channel: string) { this.handlers.delete(channel); }
  async call(channel: string, event: UnboundIpcEvent, ...args: unknown[]) { return this.handlers.get(channel)!(event, ...args); }
}
const DISPLAY: DisplayFacts = { bounds: { x: 0, y: 0, width: 1536, height: 960 }, workArea: { x: 0, y: 0, width: 1536, height: 912 }, scaleFactor: 2.5, internal: true };

function hostSetup(extra: Partial<UnboundHostPorts> = {}) {
  const ipc = new FakeIpc(), pet = new FakePet(), windows: FakeWindow[] = [];
  const settings = { ...DEFAULT_SETTINGS, model: { path: 'C:\\m\\her.pmx', url: 'mmd-asset://token/her.pmx', name: 'her.pmx' } };
  const fullscreen: { send?: (value: 'fullscreen' | 'clear') => void } = {};
  const ports: UnboundHostPorts = {
    ipcMain: ipc, pet: () => pet, petWanted: () => true, developerMode: () => true, source: () => unboundSource(settings, null), reviewed: async () => true,
    display: () => DISPLAY, measure: async () => null, openWindow: bounds => { const win = new FakeWindow(bounds); windows.push(win); return { window: win, loaded: Promise.resolve() }; },
    fullscreen: { start: send => { fullscreen.send = send; }, stop: () => {} }, restored: () => {}, publish: () => {}, readyTimeoutMs: 600_000, headTimeoutMs: 600_000, // these tests drive the page by hand; a real timer that fires first (a busy machine) is not what they are about
    ...extra,
  };
  return { host: new UnboundHost(ports), ipc, windows, pet, fullscreen };
}
async function enter(t: ReturnType<typeof hostSetup>) {
  t.host.apply({ active: true }); await settle();
  const win = t.windows.at(-1)!;
  await t.ipc.call(UNBOUND_REQUESTS.getScene, win.event());
  await t.ipc.call(UNBOUND_REQUESTS.ready, win.event(), { ok: true, modelHeightM: 1.6 });
  await settle();
  return win;
}
/** What src/unbound/shown-reporter.ts sends once the bubble painted everything it got. */
function paintAll(t: ReturnType<typeof hostSetup>, win: FakeWindow, frame: unknown = win.frame) {
  const last = win.bubbles().at(-1)!;
  const text = win.bubbles().filter(b => b.id === last.id && b.type === 'delta').map(b => b.text).join('');
  return t.ipc.call(UNBOUND_REQUESTS.shown, win.event(frame), { id: last.id, rev: last.rev, text, visible: true });
}

test('host: a finished bubble carries the linger the host decided from the whole text it showed (a failing or absent port: none, the page keeps it longest)', async () => {
  const asked: string[] = [];
  const t = hostSetup({ lingerMs: text => { asked.push(text); return 9_100; } }), win = await enter(t);
  t.host.stream({ id: 'reply-1', kind: 'chat', type: 'delta', text: '你回来' });
  t.host.stream({ id: 'reply-1', kind: 'chat', type: 'delta', text: '啦。今天好吗？' });
  t.host.stream({ id: 'reply-1', kind: 'chat', type: 'done', text: '' });
  assert.deepEqual(asked, ['你回来啦。今天好吗？'], 'asked once, with the whole reply');
  assert.deepEqual(win.bubbles().map(b => b.lingerMs), [undefined, undefined, 9_100]);
  assert.deepEqual(t.host.holdLine('amb-1', '这首歌真好听'), { held: true });
  assert.equal(win.bubbles().at(-1)!.lingerMs, 9_100);
  assert.equal(asked.at(-1), '这首歌真好听');
  const broken = hostSetup({ lingerMs: () => { throw new Error('mood host gone'); } }), w2 = await enter(broken);
  broken.host.stream({ id: 'r', kind: 'chat', type: 'delta', text: '嗯。' });
  broken.host.stream({ id: 'r', kind: 'chat', type: 'done', text: '' });
  assert.equal(w2.bubbles().at(-1)!.lingerMs, undefined);
  const none = hostSetup(), w3 = await enter(none);
  none.host.stream({ id: 'r', kind: 'chat', type: 'delta', text: '嗯。' });
  none.host.stream({ id: 'r', kind: 'chat', type: 'done', text: '' });
  assert.equal(w3.bubbles().at(-1)!.lingerMs, undefined);
});

test('host: her reply pieces carry revisions; only the shown window\'s own top frame can report them painted', async () => {
  const t = hostSetup(), win = await enter(t);
  assert.equal(t.host.state, 'unbound'); assert.equal(win.visible, true); assert.equal(t.host.readAloud.canShow(), true);
  t.host.stream({ id: 'reply-1', kind: 'chat', type: 'delta', text: '你回来啦。' });
  t.host.stream({ id: 'reply-1', kind: 'chat', type: 'done', text: '' });
  const [delta, done] = win.bubbles();
  assert.ok(Number.isSafeInteger(delta.rev) && delta.rev! > 0); assert.equal(done.rev, delta.rev);
  await assert.rejects(paintAll(t, win, {}), /未授权/, 'a forged report from another frame');
  await assert.rejects(t.ipc.call(UNBOUND_REQUESTS.shown, { sender: { id: 5, mainFrame: win.frame }, senderFrame: win.frame }, { id: 'reply-1', rev: delta.rev, text: '你回来啦。', visible: true }), /未授权/, 'another window');
  assert.equal(t.host.readAloud.shownText, '', 'neither counted');
  await paintAll(t, win);
  assert.equal(t.host.readAloud.shownText, '你回来啦。');
  assert.equal(t.host.readAloud.isPresentationCurrent('你回来啦。'), true);
  // I-199: a full-screen program comes to the front: her window stays, her bubble stays proven, nothing is dropped.
  t.fullscreen.send!('fullscreen'); await settle();
  assert.equal(t.host.readAloud.canShow(), true); assert.equal(t.host.readAloud.shownText, '你回来啦。');
  assert.equal(t.host.readAloud.isPresentationCurrent('你回来啦。'), true, 'the proof stays');
  t.fullscreen.send!('clear');
  assert.equal(t.host.readAloud.shownText, '你回来啦。');
  // An error takes the bubble away at once.
  t.host.stream({ id: 'reply-1', kind: 'chat', type: 'error', text: '' });
  assert.equal(t.host.readAloud.shownText, '');
  // She comes home: nothing proven on her bubble any more.
  t.host.stream({ id: 'reply-2', kind: 'chat', type: 'delta', text: '好。' });
  await paintAll(t, win);
  assert.equal(t.host.readAloud.shownText, '好。');
  let leaving: boolean | null = null;
  void t.host.readAloud.waitForCompletedPrefix(() => '好。再见。', 5, new AbortController().signal, 60_000, () => true).then(v => { leaving = v; });
  t.host.exit(); await settle();
  assert.equal(leaving, false, 'a sentence waiting on her bubble fails at once as she leaves (its readout is cancelled)');
  assert.equal(t.host.state, 'normal'); assert.equal(t.host.readAloud.canShow(), false); assert.equal(t.host.readAloud.shownText, '');
});

const message = (id: string, text: string): VisionInitiative => ({ id, text, origin: { kind: 'proactive', id, at: 1_000, sources: ['inner'], labels: ['自己想说的'] } }) as VisionInitiative;

test('host: her own line goes into her bubble only while it can be seen; a retraction takes it out', async () => {
  const t = hostSetup();
  assert.deepEqual(t.host.holdVisionLine(message('line-1', '你在忙吗')), {}, 'home: the offer goes to the pet as before');
  const win = await enter(t);
  assert.deepEqual(t.host.holdVisionLine(message('line-1', '你在忙吗')), { held: true });
  const [delta, done] = win.bubbles();
  assert.deepEqual([delta.id, delta.type, delta.text, done.type], ['line-1', 'delta', formatVisionPresentation(message('line-1', '你在忙吗')), 'done']);
  assert.deepEqual(t.host.holdLine('amb-1', ''), {}, 'nothing to show');
  assert.deepEqual(t.host.holdLine('bad id', 'x'), {});
  await paintAll(t, win);
  assert.equal(t.host.readAloud.isPresentationCurrent(delta.text), true);
  t.host.retracted('desk:vision-initiative', { type: 'cancel', id: 'other' });
  assert.equal(t.host.readAloud.isPresentationCurrent(delta.text), true, 'another id: untouched');
  t.host.retracted('desk:vision-initiative', { type: 'cancel', id: 'line-1' });
  assert.equal(t.host.readAloud.isPresentationCurrent(delta.text), false);
  assert.deepEqual(win.bubbles().at(-1), { id: 'line-1', type: 'error', text: '', rev: delta.rev }, 'the page hides it at once');
  t.fullscreen.send!('fullscreen');
  assert.deepEqual(t.host.holdLine('amb-1', '这首歌真好听'), { held: true }, 'I-199: in front of a full-screen program her bubble still shows it');
});

// ---- the companion window's renderer while she is out: held lines are acknowledged and read, never shown on the hidden companion ---------------

function held(overrides: Partial<HeldLinePorts> = {}) {
  const log: string[] = [], spoken: { text: string; context: SpeechRequestContext }[] = [], remembered: string[] = [];
  let ack: (value: boolean) => void = () => {};
  const ports: HeldLinePorts = {
    ackVision: () => new Promise<boolean>(resolve => { ack = resolve; }),
    ackAmbient: async id => ({ comment: { id, text: '这段好听' } as AmbientComment, context: { replyId: id } }),
    free: () => true, voiceOn: () => true,
    speak: async (text, context) => { spoken.push({ text, context }); },
    stop: () => { log.push('stop'); }, ended: (id, kind) => { log.push(`ended ${kind} ${id}`); },
    rememberVision: m => { remembered.push(m.id); }, rememberAmbient: c => { remembered.push(c.id); },
    ...overrides,
  };
  return { lines: new HeldLines(ports), log, spoken, remembered, ack: (value: boolean) => ack(value) };
}
const offer = (id: string, text: string, extra: Partial<Extract<VisionInitiativeEvent, { type: 'offer' }>> = {}): VisionInitiativeEvent => ({ type: 'offer', message: message(id, text), held: true, ...extra });

test('held lines: acknowledged first, then remembered and read with its own context; never before the host accepts', async () => {
  const h = held();
  assert.equal(h.lines.vision({ type: 'offer', message: message('home', 'x') }), false, 'not held: the pet shows it as before');
  assert.equal(h.lines.vision(offer('line-1', '你在忙吗')), true);
  await settle();
  assert.deepEqual(h.spoken, [], 'nothing read before the host accepted it');
  h.ack(true); await settle();
  assert.deepEqual(h.remembered, ['line-1']);
  assert.deepEqual(h.spoken, [{ text: '你在忙吗', context: { replyId: 'line-1' } }], 'her words, not the label');
  assert.deepEqual(h.log, ['stop', 'ended vision line-1']);
});

test('held lines: refused, silent, cancelled while waiting, or not free: nothing read', async () => {
  const refused = held();
  refused.lines.vision(offer('a', '一')); refused.ack(false); await settle();
  assert.deepEqual([refused.spoken, refused.remembered], [[], []]);
  const silent = held();
  silent.lines.vision(offer('b', '二', { silent: true })); silent.ack(true); await settle();
  assert.deepEqual([silent.spoken, silent.remembered], [[], ['b']], 'in a meeting: shown and kept, never read');
  const cancelled = held();
  cancelled.lines.vision(offer('c', '三')); await settle();
  assert.equal(cancelled.lines.vision({ type: 'cancel', id: 'c' }), false, 'the pet\'s own cancel handling still runs');
  cancelled.ack(true); await settle();
  assert.deepEqual([cancelled.spoken, cancelled.remembered], [[], []], 'a late acceptance after the cancel does nothing');
  const busy = held({ free: () => false });
  busy.lines.vision(offer('d', '四')); busy.ack(true); await settle();
  assert.deepEqual(busy.spoken, []);
  const quiet = held({ voiceOn: () => false });
  quiet.lines.vision(offer('e', '五')); quiet.ack(true); await settle();
  assert.deepEqual([quiet.spoken, quiet.remembered], [[], ['e']], 'read-aloud off');
});

test('held lines: an ambient comment uses the host\'s acceptance and its speech context', async () => {
  const h = held();
  assert.equal(h.lines.ambient({ id: 'amb-1', sessionId: 's', text: '这段好听' }), false, 'not held');
  assert.equal(h.lines.ambient({ id: 'amb-1', sessionId: 's', text: '这段好听', held: true }), true);
  await settle();
  assert.deepEqual(h.spoken, [{ text: '这段好听', context: { replyId: 'amb-1' } }]);
  const refused = held({ ackAmbient: async () => null });
  refused.lines.ambient({ id: 'amb-2', sessionId: 's', text: 'x', held: true }); await settle();
  assert.deepEqual(refused.spoken, []);
});

// ---- her own line while out, end to end: the real inner loop, the real Unbound host, the companion renderer's held lines ------------------

function innerOut() {
  const t = hostSetup();
  const state = { now: 1_000_000, phase: 'awake' as FatiguePhase };
  const gate = new ProactiveSpeechGate(() => state.now); gate.setScope('g');
  const prompts: string[] = [];
  let lines: HeldLines;
  const spoken: string[] = [], archived: string[] = [];
  // electron/main.ts: canExpress and current read "she can show a line" (her bubble while she is out), the surface is her bubble.
  const canShow = () => t.host.readAloud.canShow();
  const inner = createInnerLoopHost({
    gate, clock: () => state.now, setting: () => true, expressions: () => true, canExpress: canShow, current: canShow,
    characterId: () => 'gene', gateScope: () => 'g', parameters: () => DEFAULT_MOOD_PARAMETERS, fatiguePhase: () => state.phase,
    context: { localMinute: () => 15 * 60, persona: () => '你是 Gene。', language: () => '', mood: () => '平静。', lastInteractionAt: () => null,
      profileEnabled: () => false, profilePoints: () => '', audioReading: () => false, ambientText: () => '', touch: () => '用户刚才点了你一下（肩膀）。' },
    random: () => 0,
    decide: async prompt => { prompts.push(prompt); return { text: '{"action":"speak","text":"嗯？叫我吗"}' }; },
    realize: () => {}, releaseSpeech: () => {},
    // electron/main.ts's inner-loop offer: the companion gets it, marked held when her bubble took it.
    offer: m => { lines.vision({ type: 'offer', message: m, ...t.host.holdVisionLine(m) }); },
    cancelOffer: id => t.host.retracted('desk:vision-initiative', { type: 'cancel', id }),
    surface: () => t.host.readAloud, presentationIdentity: () => 'id',
    archive: async m => { archived.push(m.id); }, developerMode: () => false, diagnosticsFile: () => null, diagnosticsChanged: () => {},
  });
  lines = new HeldLines({ ackVision: id => inner.loop.ack(id), ackAmbient: async () => null, free: () => true, voiceOn: () => true,
    speak: async text => { spoken.push(text); }, stop: () => {}, ended: () => {}, rememberVision: () => {}, rememberAmbient: () => {} });
  const cue = (id: string) => ({ id, kind: 'speech' as const, at: state.now, until: state.now + 3_000 });
  return { t, inner, gate, state, prompts, spoken, archived, cue, dispose: () => { inner.loop.dispose(); gate.dispose(); } };
}

test('out in Unbound: her answer to a touch is shown in her bubble, then read; only after the bubble reported it painted', async () => {
  const o = innerOut(), win = await enter(o.t);
  try {
    assert.equal(o.inner.loop.offerOpportunity(o.cue('touch-1'), 'touch'), true, 'she may express herself: her bubble can show it');
    await settle();
    assert.match(o.prompts[0], /用户刚才点了你一下/);
    const line = win.bubbles().find(b => b.type === 'delta')!;
    assert.equal(line.text, '主动 · 自己想说的\n嗯？叫我吗');
    assert.deepEqual(o.spoken, [], 'not painted yet: nothing read');
    await paintAll(o.t, win);
    await settle();
    assert.deepEqual(o.spoken, ['嗯？叫我吗']);
    assert.deepEqual(o.archived, [line.id]);
  } finally { o.dispose(); }
});

test('out in Unbound: a line that never reached her bubble\'s screen is never read; asleep she never speaks; hidden she is not asked', async () => {
  const o = innerOut();
  await enter(o.t);
  try {
    o.inner.loop.offerOpportunity(o.cue('one'), 'touch'); await settle();
    // She goes home before the page could paint the line (I-199: a full-screen program no longer hides her; leaving does).
    o.t.host.exit();
    await settle(); // gone while it waited: the presentation fails at once
    assert.deepEqual(o.spoken, [], 'never shown, never read');
    assert.equal(o.inner.loop.offerOpportunity(o.cue('two'), 'touch'), false, 'her bubble cannot be seen: no opportunity at all');
    const again = await enter(o.t);
    o.state.now += 3_600_000; o.state.phase = 'asleep';
    const before = again.bubbles().length;
    o.inner.loop.offerOpportunity(o.cue('three'), 'touch'); await settle();
    assert.equal(again.bubbles().length, before, 'asleep: nothing put in her bubble');
    assert.deepEqual(o.spoken, []);
  } finally { o.dispose(); }
});

// ---- the page: what it reports, and the bubble that waits for her voice ------------------------------------------------------------

test('page: the reporter sends what a frame placed only at the next frame, once per change, and again after the window was hidden', () => {
  const sent: unknown[] = [];
  const r = new ShownReporter(report => { sent.push(report); });
  r.flush(); assert.deepEqual(sent, []);
  r.observe({ id: 'a', rev: 1, text: '你', visible: true });
  assert.deepEqual(sent, [], 'not painted yet');
  r.flush(); assert.deepEqual(sent, [{ id: 'a', rev: 1, text: '你', visible: true }]);
  r.observe({ id: 'a', rev: 1, text: '你', visible: true }); r.flush();
  assert.equal(sent.length, 1, 'no change, no report');
  r.observe({ id: 'a', rev: 2, text: '你好', visible: true }); r.observe({ id: 'a', rev: 2, text: '你好', visible: false }); r.flush();
  assert.deepEqual(sent.at(-1), { id: 'a', rev: 2, text: '你好', visible: false }, 'the last placement of the frame');
  r.reset(); r.flush();
  assert.equal(sent.length, 3, 'said again after being hidden');
});

class FakeEl {
  hidden = false; className = ''; textContent = ''; scrollTop = 0; scrollHeight = 0; offsetWidth = 200; offsetHeight = 60;
  readonly style: Record<string, string> = {}; readonly children: FakeEl[] = []; dataset: Record<string, string> = {};
  private readonly classes = new Set<string>();
  readonly classList = { add: (c: string) => { this.classes.add(c); }, remove: (c: string) => { this.classes.delete(c); }, has: (c: string) => this.classes.has(c) };
  constructor(readonly ownerDocument: { createElement(tag: string): FakeEl }) {}
  append(...nodes: FakeEl[]) { this.children.push(...nodes); }
  setAttribute() {}
}
function bubbleOnPage() {
  const doc = { createElement: () => new FakeEl(doc) };
  const root = new FakeEl(doc);
  const b = new ReplyBubble(root as unknown as HTMLElement);
  const node = root.children[0];
  b.place({ x: 500, y: 300, r: 40 }, { width: 1200, height: 800 }, true);
  return { b, node };
}

test('page: the bubble says exactly what it has on screen (untrimmed text, the host revision), and not while faded or off-window', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { b, node } = bubbleOnPage();
  assert.equal(b.state(), null, 'nothing yet');
  b.receive({ id: 'r', type: 'delta', text: ' 你好', rev: 4 });
  assert.deepEqual(b.state(), { id: 'r', rev: 4, text: ' 你好', visible: true });
  assert.equal(node.textContent, '你好');
  b.place(null, { width: 1200, height: 800 }, true);
  assert.equal(b.state()!.visible, false, 'her head left the window');
  b.place({ x: 500, y: 300, r: 40 }, { width: 1200, height: 800 }, true);
  b.receive({ id: 'r', type: 'done', text: '', rev: 4, lingerMs: 5_000 });
  t.mock.timers.tick(60_000);
  assert.equal(b.state()!.visible, false, 'faded out after its linger');
  b.receive({ id: 'r2', type: 'delta', text: '没有版本号' });
  assert.equal(b.state(), null, 'no revision: nothing to prove');
});

test('page: a finished bubble waits while her voice sounds, then stays a little; a retraction still hides it at once', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { b } = bubbleOnPage();
  b.receive({ id: 'r', type: 'delta', text: '一句很长很长的话。', rev: 1 });
  b.voiceSounding(true);
  b.receive({ id: 'r', type: 'done', text: '', rev: 1, lingerMs: 7_000 });
  t.mock.timers.tick(80_000);
  assert.equal(b.state()!.visible, true, 'still reading it out: the bubble stays');
  b.voiceSounding(false);
  t.mock.timers.tick(7_000 - 100); // the host's own number, from the moment the last sentence was read out
  assert.equal(b.state()!.visible, true);
  t.mock.timers.tick(1_000);
  assert.equal(b.state()!.visible, false, 'then it fades');
  // A voice that started while the countdown ran pauses it.
  b.receive({ id: 'r2', type: 'delta', text: '短的。', rev: 2 });
  b.receive({ id: 'r2', type: 'done', text: '', rev: 2, lingerMs: 6_000 });
  t.mock.timers.tick(1_000);
  b.voiceSounding(true);
  t.mock.timers.tick(30_000);
  assert.equal(b.state()!.visible, true);
  b.voiceSounding(false);
  t.mock.timers.tick(5_900);
  assert.equal(b.state()!.visible, true, 'after the voice, the full number the host gave starts again');
  t.mock.timers.tick(1_000);
  assert.equal(b.state()!.visible, false);
  b.receive({ id: 'r2', type: 'delta', text: '再来。', rev: 3 });
  b.receive({ id: 'r2', type: 'done', text: '', rev: 3, lingerMs: 6_000 });
  b.voiceSounding(true);
  // Taken back while she speaks: gone at once.
  b.receive({ id: 'r2', type: 'error', text: '', rev: 2 });
  t.mock.timers.tick(1_000);
  assert.equal(b.state()!.visible, false);
});

// ---- electron/main.ts gates: she can express herself while out only when her bubble can show it ------------------------------------

// Wiring rewrite step 4c: each function is read across electron/main.ts and electron/wiring/*.ts (exactly one; wiringFunction), and what a
// part's wiring reads from its needs comes from the context's own names (WIRING_PRELUDE).
const declaration = (name: string) => wiringFunction(name);

test('main gates: out in Unbound she may express herself (inner loop, a touch, her topics) only while her bubble can show it; typing and a chat still hold her', () => {
  const code = ts.transpileModule([WIRING_PRELUDE, ...['herOnScreen', 'replySurface', 'companionCanExpress', 'visionEligible'].map(declaration)].join('\n'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const world = { petShown: false, bubble: true, out: true, typingUntil: 0, chat: false, phase: 'idle' };
  const petReply = { pet: true };
  const readAloud = { canShow: () => world.out && world.bubble };
  const ctx: Record<string, unknown> = {
    pet: { isDestroyed: () => false, isVisible: () => world.petShown, isMinimized: () => false },
    get unbound() { return { state: world.out ? 'unbound' : 'normal', readAloud }; }, petReply,
    petWindowDrag: null, get userInputUntil() { return world.typingUntil; }, Date,
    replySpeechBusy: () => false, ambientSpeakingOwners: new Set(), proactiveSpeechGate: { busy: false },
    get pending() { return new Map(world.chat ? [['x', { kind: 'chat' }]] : []); }, rps: { host: { active: false } },
    companion: { mood: { get: () => ({ snapshot: { phase: world.phase } }) } }, store: {}, proactiveVisionEnabled: true,
    media: { state: { screenSharing: true }, sharesCameraFrames: () => false },
  };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  const call = (name: string) => vm.runInContext(`${name}()`, ctx);
  assert.equal(call('companionCanExpress'), true, 'out, her bubble can be seen');
  assert.equal(call('visionEligible'), true);
  assert.equal(call('replySurface'), readAloud, 'her bubble is the proof');
  world.bubble = false;
  assert.equal(call('companionCanExpress'), false, 'behind a full-screen program');
  assert.equal(call('visionEligible'), false);
  world.bubble = true; world.typingUntil = Date.now() + 60_000;
  assert.equal(call('companionCanExpress'), false, 'the user is typing');
  world.typingUntil = 0; world.chat = true;
  assert.equal(call('companionCanExpress'), false, 'a reply is under way');
  world.chat = false; world.phase = 'busy';
  assert.equal(call('visionEligible'), false, 'not idle');
  world.phase = 'idle'; world.out = false;
  assert.equal(call('companionCanExpress'), false, 'home with her pet hidden: as before');
  assert.equal(call('replySurface'), petReply, 'home: the pet\'s reply window is the proof');
  world.petShown = true;
  assert.equal(call('companionCanExpress'), true);
});

test('host (I-165): a reply that follows her voice goes up as "……"; its text follows her sentences, each with its revision and the same proof', async () => {
  const t = hostSetup(), win = await enter(t);
  let known = 0; const ends = [4, 9];
  t.host.bubbleHold.connect({ follows: id => id === 'reply-1', segmentEnd: (id, index) => id === 'reply-1' && index < known ? ends[index] : null });
  t.host.stream({ id: 'reply-1', kind: 'chat', type: 'delta', text: '第一句。' });
  assert.deepEqual(win.bubbles(), [{ id: 'reply-1', type: 'delta', text: '', hold: true }], '"……" first, no revision, none of her text');
  assert.equal(t.host.readAloud.holdCurrent(), true);
  known = 1; t.host.stream({ id: 'reply-1', kind: 'chat', type: 'delta', text: '第二句话。' });
  known = 2; t.host.stream({ id: 'reply-1', kind: 'chat', type: 'done', text: '' });
  assert.equal(win.bubbles().length, 1, 'held: nothing more yet');
  t.host.bubbleHold.heard('reply-1', 0, 'start');
  const first = win.bubbles().at(-1)!;
  assert.equal(first.text, '第一句。'); assert.ok(Number.isSafeInteger(first.rev) && first.rev! > 0);
  await paintAll(t, win);
  assert.equal(t.host.readAloud.shownText, '第一句。', 'the page proves exactly what it was given');
  t.host.bubbleHold.release('reply-1', 'over');
  assert.deepEqual(win.bubbles().slice(-2).map(b => [b.type, b.text]), [['delta', '第二句话。'], ['done', '']], 'the rest, then the done');
  t.host.stream({ id: 'reply-2', kind: 'chat', type: 'delta', text: '不跟的回复。' });
  assert.equal(win.bubbles().at(-1)!.text, '不跟的回复。', 'a reply that does not follow streams as before');
});
