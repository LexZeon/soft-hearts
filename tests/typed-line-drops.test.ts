// 2026-11-22 (docs/claude/2026-11-22-typed-line-drops.md; reported while typing in full-screen Unbound: answers seemed to wait too long,
// and it was typing, not voice): a typed line is never dropped silently. The real sendChat source runs in a sandbox with fake
// ports (the pattern of tests/message-expectation.test.ts); the host side (the full-screen box and its acks) runs with fake clocks. No model is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { transformSync } from 'esbuild';
import { scanBreathRequest } from '../shared/actions/breath-request';
import { scanFramingRequest } from '../shared/stage/framing-request';
import { scanStopReadoutRequest } from '../shared/voice/stop-readout-request';
import { outgoingChatMessages } from '../src/brain/reply-history';
import { lookHint, turnAttachments } from '../src/senses/look-send';
import { pauseCutForSend, receiveUnboundSay, sendUnboundLine } from '../src/brain/pause-talk-send';
import { SEND_DROP_HINT, SEND_DROP_KNOBS, parseUnboundSayAck, sendHeldBy, validSendWaits, type SendDropFact, type SendOutcome, type UnboundSayAck } from '../shared/brain';
import { validateChatRequest } from '../electron/settings/validation';
import { ReplyLatencyProbe, type ReplyLatencyRecord } from '../electron/brain/reply-latency';
import { JournalExtras } from '../electron/memory/journal/extras';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { UnboundSayAcks } from '../electron/unbound/say-ack';
import { sayLine, type UnboundSayLine } from '../electron/unbound/say-line';
import { UnboundTyping, SUBMIT_HINTS, type BoxRefill, type TypingPorts } from '../electron/unbound/typing';
import { testSendGuard } from './helpers/send-guard';
import { rendererSource as readRendererSource } from './helpers/renderer-source';

const source = readRendererSource();
const ast = ts.createSourceFile('renderer.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const fn = (name: string) => { const found = ast.statements.filter(n => ts.isFunctionDeclaration(n) && n.name?.text === name); assert.equal(found.length, 1, name); return transformSync(found[0].getText(ast), { loader: 'ts', target: 'es2022' }).code; };
const SEND = fn('sendChat');
const HINT: [string, boolean] = [SEND_DROP_HINT, false];
const plain = (source: string, ...items: readonly unknown[]) => source.replace(/\{(\d+)\}/g, (_, i: string) => String(items[Number(i)]));

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const tick = async (n = 4) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

/** The real sendChat with fake ports. `chat` / `save` / `shared` / `test` are the window's calls; everything a drop does is collected. */
function sender(options: { clock?: { t: number }; activeChat?: string | null; testCommand?: boolean; saveWaitMs?: number } = {}) {
  const clock = options.clock ?? { t: 0 };
  const notices: [string, boolean][] = [], journal: SendDropFact[] = [], requests: any[] = [], events: any[] = [];
  const guard = testSendGuard({ now: () => clock.t, notices, journal, saveWaitMs: options.saveWaitMs });
  const input = { value: '' };
  const ports = {
    save: (): Promise<boolean> => Promise.resolve(true),
    shared: (): Promise<unknown[]> => Promise.resolve([]),
    chat: async (value: any): Promise<void> => { requests.push(value); },
    test: async (_text: string): Promise<{ handled: boolean; id: string }> => ({ handled: false, id: '' }),
  };
  const state = { ids: 0 };
  const wrapper = `let activeChat=initialActive,attachments=[],history=[],reply='',activeUser=null,assistantNode=null;`
    + `const claudeTasksOffered=()=>false,asksTestCommand=()=>testCommand,immersiveDeveloperMode=true,testNotes={begin(){}};`
    // no-pet-ok: the next line defines the existing flag name the wiring source reads
    + `const isPet=false,settings={provider:{kind:'claude'},voice:{}},characterState=null,userProfilePanel=null;const replyPresentation={interrupt(){return null}};`
    + `const crypto={randomUUID:()=>'id-'+(++state.ids)};const $=()=>input;const speech={stop(){},prewarm(){}};const syncBodyInputGate=()=>{},setChatBusy=()=>{},renderAttachments=()=>{};`
    + `const window={desktop:{noteUserInput:async()=>{},sharedAttachments:()=>ports.shared(),chat:v=>ports.chat(v),runTestCommand:t=>ports.test(t)}};`
    + `const saveBeforeSend=()=>ports.save();const onStream=e=>events.push(e);const uiText=t=>t;const sendGuard=guard;`
    + `${SEND};return {send:(...a)=>sendChat(...a),setActive:v=>{activeChat=v},active:()=>activeChat};`;
  const api = new Function('input', 'ports', 'events', 'state', 'guard', 'initialActive', 'testCommand', 'outgoingChatMessages', 'scanStopReadoutRequest', 'scanFramingRequest',
    'scanBreathRequest', 'lookHint', 'turnAttachments', 'pauseCutForSend', wrapper)(input, ports, events, state, guard, options.activeChat ?? null, options.testCommand === true,
    outgoingChatMessages, scanStopReadoutRequest, scanFramingRequest, scanBreathRequest, lookHint, turnAttachments, pauseCutForSend) as
    { send(bypass?: boolean, look?: boolean, unboundAt?: number): Promise<SendOutcome>; setActive(v: string | null): void; active(): string | null };
  return { ...api, input, ports, notices, journal, requests, events, guard, clock };
}

test('a stale local control no longer swallows every later line: blocked (said so) until the timeout, then the line goes', async () => {
  const s = sender();
  s.input.value = '停一下';
  assert.equal(await s.send(), 'sent');
  assert.equal(s.requests.length, 1, 'the local control went to the host');
  assert.equal(s.guard.pending, 'id-1', 'and holds the guard until its result');
  // The host never answers it (no stream, no view): before the fix every line after it vanished here, for good.
  s.input.value = '你好';
  assert.equal(await s.send(), 'readout-pending');
  assert.equal(s.input.value, '你好', 'the line stays in the box');
  assert.deepEqual(s.notices, [HINT], '"没发出去，再试一次" is shown');
  assert.deepEqual(s.journal.map(f => [f.why, f.from]), [['readout-pending', 'controls']], 'one journal fact, closed words');
  s.clock.t = SEND_DROP_KNOBS.readoutControlTimeoutMs - 1;
  assert.equal(await s.send(), 'readout-pending');
  s.clock.t = SEND_DROP_KNOBS.readoutControlTimeoutMs;
  assert.equal(await s.send(), 'sent', 'past the timeout the guard never blocks');
  assert.equal(s.requests.length, 2);
  assert.equal(s.requests[1].messages.at(-1).content, '你好');
  assert.equal(s.input.value, '', 'a line that went out leaves the box');
  assert.equal(SEND_DROP_KNOBS.readoutControlTimeoutMs, 10_000);
});

test('any result for the local control lets the next line go: its done or error, its companion-command view, the request failing', async () => {
  const receive = fn('receiveReadoutControl'), present = fn('presentCompanionCommand');
  for (const result of ['done', 'error', 'view', 'failed'] as const) {
    const s = sender();
    if (result === 'failed') s.ports.chat = async () => { throw new Error('上一项任务仍在进行'); };
    s.input.value = '停止朗读';
    const outcome = await s.send();
    if (result === 'failed') {
      assert.equal(outcome, 'host-refused');
      assert.equal(s.input.value, '停止朗读', 'a failed control keeps its line');
      assert.deepEqual(s.notices, [['Error: 上一项任务仍在进行', true]], 'the host\'s own words, as an error');
      s.ports.chat = async value => { s.requests.push(value); };
    } else {
      const turns = new Map([['id-1', { user: { role: 'user', content: '停止朗读' }, text: '', output: { textContent: '' }, finished: false }]]);
      const ctx = { readoutControlTurns: turns, sendGuard: s.guard, history: [] as unknown[], displayFailure: String, appendReplyHistory: (h: unknown[]) => h,
        commandMessageRows: new Map(), isPet: false }; // no-pet-ok: the existing flag name the wiring source reads
      if (result === 'view') new Function(...Object.keys(ctx), `${present};presentCompanionCommand({requestId:'id-1'})`)(...Object.values(ctx));
      else new Function(...Object.keys(ctx), `${receive};receiveReadoutControl({id:'id-1',kind:'chat',type:'${result}',text:''})`)(...Object.values(ctx));
    }
    assert.equal(s.guard.pending, null, result);
    s.input.value = '然后呢';
    assert.equal(await s.send(), 'sent', result);
  }
});

test('a line dropped for each reason comes back to the box with the hint and one journal line', async () => {
  // busy: a reply is being written in this window
  {
    const s = sender({ activeChat: 'r1' }); s.input.value = '等等';
    assert.equal(await s.send(), 'busy');
    assert.equal(s.input.value, '等等'); assert.deepEqual(s.notices, [HINT]); assert.deepEqual(s.journal.map(f => f.why), ['busy']); assert.equal(s.requests.length, 0);
  }
  // superseded while the settings saved (the box was already emptied): the stop button, or another turn began
  for (const other of [null, 'voice-turn']) {
    const s = sender(); const saved = deferred<boolean>(); s.ports.save = () => saved.promise; s.input.value = '我想说件事';
    const pending = s.send(); await tick();
    assert.equal(s.input.value, '', 'the box empties as the send starts');
    s.setActive(other); saved.resolve(true);
    assert.equal(await pending, 'superseded');
    assert.equal(s.input.value, '我想说件事', 'before the fix the line was gone here');
    assert.deepEqual(s.notices, [HINT]); assert.deepEqual(s.journal.map(f => f.why), ['superseded']); assert.equal(s.requests.length, 0);
  }
  // superseded while the window asked for the shared picture
  {
    const s = sender(); const shared = deferred<unknown[]>(); s.ports.shared = () => shared.promise; s.input.value = '看看这个';
    const pending = s.send(); await tick(8);
    s.setActive('other'); shared.resolve([]);
    assert.equal(await pending, 'superseded'); assert.equal(s.input.value, '看看这个'); assert.deepEqual(s.journal.map(f => f.why), ['superseded']);
  }
  // save-failed: the error row says it; the line comes back, nothing extra shown
  {
    const s = sender(); s.ports.save = async () => false; s.input.value = '你好';
    assert.equal(await s.send(), 'save-failed');
    assert.equal(s.input.value, '你好'); assert.deepEqual(s.notices, [], 'the error row already says it'); assert.equal(s.events[0].type, 'error');
    assert.deepEqual(s.journal.map(f => f.why), ['save-failed']);
  }
  // host-refused: the request threw while this was still the turn; superseded when another turn had begun by then
  {
    const s = sender(); s.ports.chat = async () => { throw new Error('上一项任务仍在进行'); }; s.input.value = '你好';
    assert.equal(await s.send(), 'host-refused');
    assert.equal(s.input.value, '你好'); assert.deepEqual(s.notices, []); assert.equal(s.events.at(-1).type, 'error');
    assert.deepEqual(s.journal.map(f => f.why), ['host-refused']);
    const t = sender(); t.ports.chat = async () => { t.setActive('other'); throw new Error('x'); }; t.input.value = '再来';
    assert.equal(await t.send(), 'superseded'); assert.equal(t.input.value, '再来'); assert.deepEqual(t.notices, [HINT]);
  }
  // a developer test command the host failed on
  {
    const s = sender({ testCommand: true }); s.ports.test = async () => { throw new Error('ipc down'); }; s.input.value = '测试：发呆';
    assert.equal(await s.send(), 'host-refused'); assert.equal(s.input.value, '测试：发呆'); assert.equal(s.guard.pending, null);
    assert.deepEqual(s.notices, [['Error: ipc down', true]]); assert.deepEqual(s.journal.map(f => f.why), ['host-refused']);
  }
});

test('a dropped line never overwrites a draft typed since, and a full-screen line shows nothing in this window (its own box says it)', async () => {
  const s = sender(); const saved = deferred<boolean>(); s.ports.save = () => saved.promise; s.input.value = '第一句';
  const pending = s.send(); await tick();
  s.input.value = '我又打了一句'; s.setActive(null); saved.resolve(true);
  assert.equal(await pending, 'superseded');
  assert.equal(s.input.value, '我又打了一句', 'the newer draft stays');
  const u = sender({ activeChat: 'r1' }); u.input.value = '全屏里打的';
  const submitted = Date.now() - 1_500;
  assert.equal(await u.send(true, false, submitted), 'busy');
  assert.deepEqual(u.notices, [], 'nothing in the hidden control window');
  assert.deepEqual(u.journal, [], '2026-11-23: a full-screen line\'s drop is journaled once, by the host, from the ack (electron/unbound/say-ack.ts)');
});

test('the full-screen line carries its submit time: sendMs counts from the box', async () => {
  const s = sender(); s.input.value = '你好';
  assert.equal(await s.send(true, false, 1_000_000), 'sent');
  assert.equal(s.requests[0].sentAt, 1_000_000);
  const t = sender(); t.input.value = '你好';
  const before = Date.now(); await t.send(); assert.ok(t.requests[0].sentAt >= before, 'a window line: its own send');
});

test('the journal line keeps only closed words and a number; anything else is refused', () => {
  const entry = buildJournalEntry({ type: 'send-dropped', characterId: 'gene', why: 'readout-pending', from: 'unbound', waitMs: 43_210.4, text: '我想说件事' } as never, 0);
  assert.ok(entry);
  assert.deepEqual({ why: (entry as any).why, from: (entry as any).from, waitMs: (entry as any).waitMs }, { why: 'readout-pending', from: 'unbound', waitMs: 43_210 });
  assert.ok(!JSON.stringify(entry).includes('我想说件事'), 'never the line');
  assert.match(describeJournalEntry(entry!, plain), /你打的一句没发出去（全屏输入框，上一个小指令还没回音）：发出后 43\.21 秒/);
  assert.equal(buildJournalEntry({ type: 'send-dropped', characterId: 'gene', why: 'typed: 你好', from: 'controls' } as never, 0), null);
  assert.equal(buildJournalEntry({ type: 'send-dropped', characterId: 'gene', why: 'busy', from: 'somewhere' } as never, 0), null);
});

// ---------------------------------------------------------------- the full-screen box: its line, the control window's word, the box again

function fakeTimers() {
  let now = 0, next = 1; const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    setTimer: (run: () => void, ms: number) => { const id = next++; timers.set(id, { at: now + ms, run }); return id; },
    clearTimer: (id: unknown) => { timers.delete(id as number); },
    advance(ms: number) {
      const end = now + ms;
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (t.at <= end && timers.has(id)) { timers.delete(id); now = Math.max(now, t.at); t.run(); }
      now = end;
    },
    get count() { return timers.size; },
  };
}

function box(options: { waitMs?: number } = {}) {
  const clock = fakeTimers(), noAck: { why: string; waitMs: number }[] = [];
  const acks = new UnboundSayAcks({ ...clock, journal: fact => { noAck.push(fact); } });
  const forwarded: UnboundSayLine[] = [], opened: (BoxRefill | undefined)[] = [], said: string[] = [];
  let closed = 0, open = true, state: 'unbound' | 'normal' = 'unbound';
  const ports: TypingPorts = {
    touch: () => true, shortcut: { register: () => true, unregister: () => {} },
    say: (text, tag) => sayLine({ chatAvailable: () => true, controlsAlive: () => true, interruptReply: () => null, send: line => { forwarded.push(line); } }, text, tag),
    acks, ackWaitMs: options.waitMs ?? 3_000,
    input: { open: (_rect, _panel, refill) => { open = true; opened.push(refill); }, close: () => { closed++; open = false; }, destroy: () => {}, isOpen: () => open },
    state: () => state, window: () => ({ x: 0, y: 0, width: 1000, height: 600 }), askHead: async () => null, said: text => { said.push(text); }, clock: () => clock.now(),
  };
  return { typing: new UnboundTyping(ports), acks, clock, forwarded, opened, said, noAck, closed: () => closed, setOpen(v: boolean) { open = v; }, setState(v: 'unbound' | 'normal') { state = v; } };
}

test('the box waits for the control window\'s word: sent closes it; dropped keeps the line with the hint; nothing is shown as said until it went', async () => {
  const b = box();
  const pending = b.typing.submit('你好呀');
  assert.equal(b.forwarded.length, 1);
  const { line, sentAt } = b.forwarded[0];
  assert.equal(line, 1); assert.equal(sentAt, 0, 'the host stamps the box\'s Enter');
  assert.equal(b.closed(), 0, 'still open while it waits'); assert.deepEqual(b.said, []);
  assert.equal(b.acks.ack({ line: 1, result: 'sent' }), true);
  assert.deepEqual(await pending, { ok: true });
  assert.equal(b.closed(), 1); assert.deepEqual(b.said, ['你好呀']);
  assert.equal(b.acks.ack({ line: 1, result: 'sent' }), false, 'one answer per line');
  b.setOpen(true); // she clicked again: the box is open for the next line
  const dropped = b.typing.submit('再说一句');
  b.acks.ack({ line: 2, result: 'dropped', why: 'readout-pending' });
  assert.deepEqual(await dropped, { ok: false, hint: SUBMIT_HINTS.dropped }, 'the page keeps the field (src/unbound/input.ts) and shows the hint');
  assert.equal(SUBMIT_HINTS.dropped, SEND_DROP_HINT);
  assert.equal(b.closed(), 1, 'not closed'); assert.deepEqual(b.said, ['你好呀'], 'not shown as said');
  assert.equal(b.clock.count, 0, 'no timer left behind');
});

test('no word yet: the box closes; a drop that comes later, or no word at all, opens it again with the line (once)', async () => {
  const b = box();
  const pending = b.typing.submit('第一句');
  b.clock.advance(3_000); await tick();
  assert.deepEqual(await pending, { ok: true }, 'closed after the wait');
  assert.equal(b.closed(), 1);
  b.acks.ack({ line: 1, result: 'dropped', why: 'superseded' }); await tick(6);
  assert.deepEqual(b.opened, [{ text: '第一句', hint: SEND_DROP_HINT }], 'opened again with the line and the hint');
  // no word at all: the give-up opens it again and writes one journal line
  const lost = b.typing.submit('第二句'); b.clock.advance(3_000); await lost; b.setOpen(false);
  b.clock.advance(SEND_DROP_KNOBS.unboundAckGiveUpMs); await tick(6);
  assert.deepEqual(b.opened.at(-1), { text: '第二句', hint: SEND_DROP_HINT });
  assert.deepEqual(b.noAck, [{ why: 'superseded', waitMs: 3_000 }, { why: 'no-ack', waitMs: SEND_DROP_KNOBS.unboundAckGiveUpMs }], 'one host journal line per real drop (2026-11-23)');
  assert.equal(b.acks.ack({ line: 2, result: 'dropped', why: 'busy' }), false, 'a word after the give-up is ignored');
  await tick(6); assert.equal(b.opened.length, 2, 'never opened twice for one line');
  // a late 'sent' opens nothing
  const fine = b.typing.submit('第三句'); b.clock.advance(3_000); await fine;
  b.acks.ack({ line: 3, result: 'sent' }); await tick(6); assert.equal(b.opened.length, 2);
  // she went back to the small window meanwhile: nothing opens
  const away = b.typing.submit('第四句'); b.clock.advance(3_000); await away; b.setState('normal');
  b.acks.ack({ line: 4, result: 'dropped', why: 'busy' }); await tick(6); assert.equal(b.opened.length, 2);
  assert.equal(b.acks.pending, 0);
});

test('a drop while she waited but the box had closed (clicked away): it opens again with the line', async () => {
  const b = box();
  const pending = b.typing.submit('嗯嗯'); b.setOpen(false);
  b.acks.ack({ line: 1, result: 'dropped', why: 'host-refused' });
  assert.deepEqual(await pending, { ok: false }); await tick(6);
  assert.deepEqual(b.opened, [{ text: '嗯嗯', hint: SEND_DROP_HINT }]);
});

test('the control window answers each line exactly once, sends it exactly once, carries its submit time and puts a draft back', async () => {
  const acks: UnboundSayAck[] = []; const box = { value: '我在这边打的草稿' }; const sends: (number | undefined)[] = [];
  await receiveUnboundSay({ text: '你好', line: 7, sentAt: 123 }, { box: () => box, answering: () => false, stop: async () => {}, ack: a => { acks.push(a); },
    send: async at => { sends.push(at); assert.equal(box.value, '你好', 'the line is in the box while it is sent'); box.value = ''; return 'sent'; } });
  assert.deepEqual(acks, [{ line: 7, result: 'sent' }]); assert.deepEqual(sends, [123]); assert.equal(box.value, '我在这边打的草稿');
  await receiveUnboundSay({ text: '再说', line: 8, sentAt: 124 }, { box: () => box, answering: () => false, stop: async () => {}, ack: a => { acks.push(a); }, send: async () => 'busy' });
  assert.deepEqual(acks.at(-1), { line: 8, result: 'dropped', why: 'busy' }); assert.equal(box.value, '我在这边打的草稿', 'the line leaves this box (it goes back to hers)');
  await receiveUnboundSay({ text: '三', line: 9 }, { box: () => box, answering: () => false, stop: async () => {}, ack: a => { acks.push(a); }, send: async () => undefined });
  assert.deepEqual(acks.at(-1), { line: 9, result: 'dropped', why: 'superseded' }, 'nothing sent and no reason known is still a drop');
  assert.equal(receiveUnboundSay(42, { box: () => box, answering: () => false, stop: async () => {}, ack: () => {}, send: async () => 'sent' }), null);
  assert.equal(acks.length, 3);
  assert.equal(parseUnboundSayAck({ line: 1, result: 'dropped', why: 'because 你好' }), null, 'the host takes only closed reasons');
  assert.equal(parseUnboundSayAck({ line: 0, result: 'sent' }), null);
});

test('a stop that hangs: the line goes after the stop timeout, exactly once (a late stop sends nothing more)', { timeout: 10_000 }, async () => {
  let release!: () => void; const sends: number[] = []; const started = Date.now();
  const outcome = await sendUnboundLine({ answering: () => true, stop: () => new Promise<void>(r => { release = r; }), send: async () => { sends.push(Date.now() - started); return 'sent'; } }, undefined, 30);
  assert.equal(outcome, 'sent'); assert.equal(sends.length, 1); assert.ok(sends[0] >= 25, 'it waited for the timeout');
  release(); await tick(8); assert.equal(sends.length, 1, 'no second send when the stop finally ends');
  assert.equal(SEND_DROP_KNOBS.unboundStopTimeoutMs, 2_000);
  const quick: string[] = [];
  await sendUnboundLine({ answering: () => true, stop: async () => { quick.push('stop'); }, send: async () => { quick.push('send'); return 'sent'; } }, undefined, 60_000);
  assert.deepEqual(quick, ['stop', 'send'], 'a stop that ends at once does not wait for the timeout');
});

test('end to end: box → host → control window (a dropped line) → ack → the box keeps the line; a sent line closes it', async () => {
  const b = box();
  const controls = (line: UnboundSayLine, outcome: SendOutcome) => receiveUnboundSay(line, { box: () => ({ value: '' }), answering: () => false, stop: async () => {},
    send: async () => outcome, ack: a => { b.acks.ack(JSON.parse(JSON.stringify(a))); } });
  const first = b.typing.submit('先说这个'); await controls(b.forwarded[0], 'readout-pending');
  assert.deepEqual(await first, { ok: false, hint: SEND_DROP_HINT });
  const second = b.typing.submit('先说这个'); await controls(b.forwarded[1], 'sent');
  assert.deepEqual(await second, { ok: true }); assert.deepEqual(b.said, ['先说这个']);
});

// ---------------------------------------------------------------- a voice call (coordinator / 21:00 line 39 s late)

test('call world: a typed line during a call (her voice reply barged in, its cancel never settles) and after it (the capture still holds the save) goes out within the caps, once', { timeout: 10_000 }, async () => {
  // During the call the control window's activeChat is her voice reply's id (src/wiring/voice-chat-wiring.ts 'start' → beginChat). A barged-in
  // turn that never got a terminal keeps it there. The full-screen line stops it first: stopChat clears activeChat at once, then awaits
  // window.desktop.cancel(voice id); here that never settles. The host's save is held behind the voice capture's writes (21:00: the line
  // reached the host only when the capture left running after the call stopped, 73 s after the call's end).
  const s = sender({ activeChat: 'voice-reply-barged', saveWaitMs: 60 });
  const captureStops = deferred<boolean>(); s.ports.save = () => captureStops.promise;
  let stops = 0;
  const stop = async () => { stops++; s.setActive(null); await new Promise<void>(() => {}); };
  const acks: UnboundSayAck[] = [];
  const say = (text: string, line: number) => receiveUnboundSay({ text, line, sentAt: Date.now() }, { box: () => s.input, answering: () => s.active() !== null, stop,
    send: at => s.send(true, false, at), ack: a => { acks.push(a); }, stopTimeoutMs: 50 });
  const started = Date.now();
  await say('Mumi', 1);
  assert.equal(stops, 1, 'her voice reply was stopped first');
  assert.deepEqual(acks, [{ line: 1, result: 'sent' }], 'before the fix this waited for ever on the cancel, then on the save');
  assert.equal(s.requests[0].messages.at(-1).content, 'Mumi');
  const first = s.requests[0].waits;
  assert.ok(first.before >= 45 && first.save >= 55, `the two waits are named: ${JSON.stringify(first)}`);
  assert.deepEqual(sendHeldBy(first.before + first.save + 5, first)?.held, first.save > first.before ? 'save' : 'before', 'a tie goes to the earlier wait (sendHeldBy keeps the first of equals); the two measured waits can tie to the millisecond under load');
  // After the call: no reply running, the capture still holds the save.
  s.setActive(null);
  await say('老婆可爱捏', 2);
  assert.deepEqual(acks.at(-1), { line: 2, result: 'sent' });
  assert.equal(stops, 1, 'nothing to stop after the call');
  assert.equal(s.requests.length, 2, 'each line exactly once');
  assert.ok(s.requests[1].waits.save >= 55 && s.requests[1].waits.before < 1_000);
  assert.ok(Date.now() - started < 2_000, 'well inside the caps');
  captureStops.resolve(true); await tick(8);
  assert.equal(s.requests.length, 2, 'the save finishing late sends nothing more');
  assert.equal(SEND_DROP_KNOBS.saveWaitMs, 2_000);
});

// ---------------------------------------------------------------- which wait held a typed line (coordinator 2026-11-22: sendMs 43 s / 33 s / 12 s / 7.8 s on typed full-screen turns)

test('the request carries where the window spent its send: before (the full-screen hand-over and stop), note, save, look', async () => {
  const s = sender(); s.input.value = '你好';
  s.ports.shared = () => new Promise(resolve => setTimeout(() => resolve([]), 40));
  s.ports.save = () => new Promise(resolve => setTimeout(() => resolve(true), 20));
  const submitted = Date.now() - 1_200;
  assert.equal(await s.send(true, false, submitted), 'sent');
  const waits = s.requests[0].waits;
  assert.deepEqual(Object.keys(waits).sort(), ['before', 'look', 'note', 'save']);
  assert.ok(waits.before >= 1_200 && waits.before < 60_000, 'from the box\'s Enter to this send');
  assert.ok(waits.look >= 30, `the pictures: ${waits.look}`); assert.ok(waits.save >= 10, `the save: ${waits.save}`);
});

test('which wait held it longest; the rest of sendMs is the request on its way; malformed waits are absent', () => {
  assert.deepEqual(sendHeldBy(42_952, { before: 400, note: 3, save: 120, look: 41_900 }), { held: 'look', heldMs: 41_900 });
  assert.deepEqual(sendHeldBy(12_196, { before: 2_050, note: 2, save: 9_800, look: 10 }), { held: 'save', heldMs: 9_800 });
  assert.deepEqual(sendHeldBy(7_752, { before: 10, note: 1, save: 20, look: 30 }), { held: 'ipc', heldMs: 7_691 });
  assert.deepEqual(sendHeldBy(30, { before: 10, note: 0, save: 10, look: 0 }), { held: 'before', heldMs: 10 }, 'equal waits: the earlier one is named, always');
  assert.equal(sendHeldBy(null, { before: 1, note: 1, save: 1, look: 1 }), null);
  assert.equal(sendHeldBy(500, undefined), null);
  assert.deepEqual(validSendWaits({ before: 1.4, note: 0, save: 2, look: 3, extra: 'x' }), { before: 1, note: 0, save: 2, look: 3 });
  for (const bad of [null, [], { before: -1, note: 0, save: 0, look: 0 }, { before: 1, note: 0, save: 0 }, { before: 'a', note: 0, save: 0, look: 0 }, { before: 1e9, note: 0, save: 0, look: 0 }])
    assert.equal(validSendWaits(bad), undefined);
  const base = { id: 'r1', messages: [{ role: 'user', content: '你好' }], attachments: [] };
  assert.deepEqual((validateChatRequest({ ...base, sentAt: 5, waits: { before: 1, note: 2, save: 3, look: 4 } }) as { waits?: unknown }).waits, { before: 1, note: 2, save: 3, look: 4 });
  assert.equal((validateChatRequest({ ...base, waits: { before: 1, note: 2, save: 3, look: 4 } }) as { waits?: unknown }).waits, undefined, 'only beside sentAt');
});

test('the first-character line names the wait that held the line (closed word, a number), host to journal', () => {
  let record: ReplyLatencyRecord | null = null;
  const probe = new ReplyLatencyProbe({ enabled: () => true, file: () => '', log: () => {}, now: () => 0, wallNow: () => 100_000, onRecord: r => { record = r; } });
  probe.begin('r1', 'claude', 100_000 - 42_952, { pauseTalk: false, carried: false, waits: { before: 400, note: 3, save: 120, look: 41_900 } });
  probe.begin('r2', 'claude'); // finalizes r1
  assert.deepEqual(record!.sendWaits, { before: 400, note: 3, save: 120, look: 41_900 });
  const extras = new JournalExtras({ sink: { record: () => null } as never, characterId: () => 'c', engine: () => 'local', uptimeMs: () => 0, blushStage: () => {} });
  const timed = extras.firstChar({ firstContentMs: 46_511, firstBubbleMs: 46_600, origin: 'renderer-send', sendToHostMs: 42_952, sendWaits: record!.sendWaits });
  assert.equal(timed.held, 'look'); assert.equal(timed.heldMs, 41_900);
  const line = buildJournalEntry({ type: 'first-char', characterId: 'c', ms: 46_511, pauseTalk: false, carried: false, ...timed }, 0);
  assert.equal((line as { held?: string }).held, 'look');
  assert.match(describeJournalEntry(line!, plain), /发出后 42\.95 秒主进程才收到，最久的一段是取这一轮的画面 41\.90 秒/);
  assert.equal((buildJournalEntry({ type: 'first-char', characterId: 'c', ms: 1, pauseTalk: false, carried: false, sendMs: 5, held: 'the camera', heldMs: 4 } as never, 0) as { held?: string }).held, undefined);
});
