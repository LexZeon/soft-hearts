// I-177: in full-screen Unbound a line sent while she is still
// answering is no longer refused. Her reply stops where it is (the bubble keeps what was shown), how far it got goes with the message
// (the window's own `pauseCut`, one path), the host hands her next turn PAUSE_TALK_CUT_NOTE when part was never shown, and the line is a
// normal turn. Fake clocks and ports only; no model is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { UnboundBubbleHold, type HeldBubbleEvent } from '../electron/unbound/bubble-hold';
import { sayLine, type UnboundSayLine } from '../electron/unbound/say-line';
import { UnboundTyping, SUBMIT_HINTS, type TypingPorts } from '../electron/unbound/typing';
import { handOutsideCut, pauseCutForSend, sendUnboundLine, unboundSayOf } from '../src/brain/pause-talk-send';
import { PauseTalkHost } from '../electron/brain/pause-talk/host';
import { validateChatRequest } from '../electron/settings/validation';
import { PAUSE_TALK_CUT_NOTE } from '../shared/behaviors/pause-talk/choose';
import { neverAskedPauseTalk } from '../shared/behaviors/pause-talk/fake';
import { ReplyBubble } from '../src/unbound/bubbles';

const BODY = '第一句。第二句话。';
const ENDS = [4, 9];

function world(options: { follows?: boolean } = {}) {
  let now = 0;
  const emitted: HeldBubbleEvent[] = [];
  let known = 0;
  const hold = new UnboundBubbleHold({ emit: event => { emitted.push(event); }, now: () => now, setTimer: () => 0, clearTimer: () => {} });
  hold.connect({ follows: () => options.follows !== false, segmentEnd: (id, index) => id === 'r1' && index < known ? ENDS[index] : null });
  return { hold, emitted, learn(count: number) { known = count; }, sentText: () => emitted.filter(e => e.type === 'delta').map(e => e.text).join('') };
}

test('mid-answer: the bubble keeps what was shown, the held rest is never sent, and the cut says how far it got', () => {
  const w = world();
  w.hold.take({ id: 'r1', type: 'delta', text: '第一句。' }); w.learn(1);
  w.hold.take({ id: 'r1', type: 'delta', text: '第二句话。' }); w.learn(2);
  w.hold.heard('r1', 0, 'start');
  assert.equal(w.sentText(), '第一句。');
  const cut = w.hold.interrupt();
  assert.deepEqual(cut, { id: 'r1', shown: 4 });
  assert.deepEqual(w.emitted.at(-1), { id: 'r1', type: 'done', text: '' }, 'the bubble ends where it is (it fades on its own linger)');
  // The reply's stop arrives later, and the reading's own events: nothing dumps the rest and nothing clears the bubble.
  w.hold.release('r1', 'cancelled'); w.hold.heard('r1', 1, 'start'); // the reading's stop comes first (a held bubble used to dump the rest here)
  assert.equal(w.sentText(), '第一句。', 'the unshown rest stays unshown');
  assert.equal(w.hold.take({ id: 'r1', type: 'error', text: '' }), true, 'the stop is taken here');
  assert.equal(w.emitted.filter(e => e.type === 'done').length, 1, 'one end only');
  assert.equal(w.emitted.some(e => e.type === 'error'), false);
  // The page: the bubble has the first sentence and stays (the host's done starts its linger, as for any reply).
  const page = new ReplyBubble(document());
  for (const e of w.emitted) page.receive(e.type === 'hold' ? { id: e.id, type: 'delta', text: '', hold: true } : { id: e.id, type: e.type as 'delta' | 'done', text: e.text });
  assert.equal(page.current, '第一句。');
});

test('a reply fully shown carries no note; a hold that has not shown anything is cleared', () => {
  const full = world();
  full.hold.take({ id: 'r1', type: 'delta', text: BODY }); full.learn(2); full.hold.take({ id: 'r1', type: 'done', text: '' });
  full.hold.heard('r1', 0, 'start'); full.hold.heard('r1', 1, 'start');
  assert.equal(full.sentText(), BODY);
  assert.equal(full.hold.interrupt(), null, 'everything was shown: nothing unsaid (the voice stops with the new turn, that is all)');
  const none = world();
  none.hold.take({ id: 'r1', type: 'delta', text: BODY });
  assert.deepEqual(none.hold.interrupt(), { id: 'r1', shown: 0 }, 'only the "……" was up: all of it was unseen');
  assert.deepEqual(none.emitted.at(-1), { id: 'r1', type: 'error', text: '' }, 'and the empty bubble goes away');
  assert.equal(world().hold.interrupt(), null, 'no reply, no cut');
  // Still streaming but everything that had arrived was already shown: nothing unsaid either.
  const caught = world();
  caught.hold.take({ id: 'r1', type: 'delta', text: '第一句。' }); caught.learn(1); caught.hold.heard('r1', 0, 'start');
  assert.equal(caught.sentText(), '第一句。');
  assert.equal(caught.hold.interrupt(), null, 'all that had streamed in was shown');
});

test('a reply streaming without the voice holding it back: the bubble has all that streamed, no note; its stop keeps the bubble', () => {
  const w = world({ follows: false });
  assert.equal(w.hold.take({ id: 'r1', type: 'delta', text: '第一句。' }), false);
  assert.equal(w.hold.interrupt(), null, 'what was streamed is what was shown');
  assert.equal(w.hold.take({ id: 'r1', type: 'error', text: '' }), true);
  assert.deepEqual(w.emitted, [{ id: 'r1', type: 'done', text: '' }], 'the stop ends the bubble instead of clearing it');
  // A later, unrelated failure still clears the bubble as before.
  assert.equal(w.hold.take({ id: 'r2', type: 'delta', text: '新的。' }), false);
  assert.equal(w.hold.take({ id: 'r2', type: 'error', text: '' }), false, 'not interrupted by a send: the host sends the error itself');
});

test('accidental things do not interrupt: only interrupt() (the user\'s sent line) marks a reply stopped', () => {
  const w = world();
  w.hold.take({ id: 'r1', type: 'delta', text: BODY }); w.learn(2);
  w.hold.heard('r1', 0, 'start'); w.hold.heard('r1', 0, 'end');
  w.hold.release('r1', 'stall'); // a stall, a focus change, a screenshot: the reading's own facts
  assert.equal(w.sentText(), BODY, 'a stall shows the rest, as before; it is not an interruption');
  assert.equal(w.hold.take({ id: 'r1', type: 'error', text: '' }), false, 'an error nobody interrupted passes through');
});

function document(): HTMLElement {
  const make = (): any => ({ hidden: false, className: '', style: {}, children: [] as any[], textContent: '', classList: { add() {}, remove() {} }, offsetWidth: 10, offsetHeight: 10, scrollTop: 0, scrollHeight: 0,
    append(...nodes: any[]) { this.children.push(...nodes); }, ownerDocument: { createElement: make } });
  return make() as HTMLElement;
}

test('sayLine: a send while she answers goes out with how far she got; nothing is refused for that', () => {
  const sent: UnboundSayLine[] = [];
  const ports = (cut: { id: string; shown: number } | null, over: Partial<Parameters<typeof sayLine>[0]> = {}) => ({ chatAvailable: () => true, controlsAlive: () => true, interruptReply: () => cut, send: (line: UnboundSayLine) => { sent.push(line); }, ...over });
  assert.equal(sayLine(ports({ id: 'r1', shown: 4 }), '等一下'), 'sent');
  assert.deepEqual(sent.at(-1), { text: '等一下', cut: { id: 'r1', shown: 4 } });
  assert.equal(sayLine(ports(null), '嗯'), 'sent');
  assert.deepEqual(sent.at(-1), { text: '嗯' }, 'a reply fully shown: no cut');
  assert.equal(sayLine(ports(null, { interruptReply: () => { throw new Error('x'); } }), '嗯嗯'), 'sent', 'a failing bubble never keeps the line from going');
  assert.equal(sayLine(ports(null, { chatAvailable: () => false }), 'x'), 'unavailable');
  assert.equal(sayLine(ports(null, { controlsAlive: () => false }), 'x'), 'unavailable');
  assert.equal(sent.length, 3, 'unavailable sends nothing and stops nothing');
});

test('the input box: Enter while she answers is sent and closes the box, with no "still answering" hint', async () => {
  const said: string[] = [];
  let closed = 0;
  const ports: TypingPorts = { touch: () => true, say: text => { said.push(text); return 'sent'; }, shortcut: { register: () => true, unregister: () => {} },
    input: { open: () => {}, close: () => { closed++; }, destroy: () => {} }, state: () => 'unbound', window: () => ({ x: 0, y: 0, width: 1000, height: 600 }),
    askHead: async () => null, said: () => {}, clock: () => 0 };
  const typing = new UnboundTyping(ports);
  assert.deepEqual(await typing.submit('我想说件事'), { ok: true });
  assert.deepEqual(said, ['我想说件事']);
  assert.equal(closed, 1);
  assert.ok(!(Object.values(SUBMIT_HINTS) as string[]).includes('她还在回答，等她说完再发。'));
});

test('the control window: a reply still streaming there is stopped first, then the line goes out carrying the cut; the cut is not left behind', async () => {
  const log: string[] = [];
  let answering = true;
  const send = async () => { log.push('send'); const cut = pauseCutForSend({ interrupt: () => null }); log.push(JSON.stringify(cut ?? null)); return 'sent' as const; };
  await sendUnboundLine({ answering: () => answering, stop: async () => { log.push('stop'); answering = false; }, send }, { id: 'r1', shown: 4 });
  assert.deepEqual(log, ['stop', 'send', '{"id":"r1","shown":4}']);
  assert.equal(pauseCutForSend({ interrupt: () => null }), undefined, 'handed once, around that one send');
  log.length = 0;
  await sendUnboundLine({ answering: () => false, stop: async () => { log.push('stop'); }, send }, undefined);
  assert.deepEqual(log, ['send', 'null'], 'nothing streaming here: no stop; a fully shown reply: no cut');
  // The window's own reveal, when it has one, wins; a send that fails still clears the hand-over.
  handOutsideCut({ id: 'x', shown: 1 });
  assert.deepEqual(pauseCutForSend({ interrupt: () => ({ id: 'own', shown: 9 }) }), { id: 'own', shown: 9 });
  assert.equal(pauseCutForSend({ interrupt: () => null }), undefined);
  assert.equal(await sendUnboundLine({ answering: () => false, stop: async () => {}, send: async () => { throw new Error('no'); } }, { id: 'r1', shown: 2 }), 'host-refused',
    '2026-11-22: a send that throws is a drop the box hears of, not a rejection');
  assert.equal(pauseCutForSend({ interrupt: () => null }), undefined);
});

test('the control window reads a line from the host as a bare string or as the line with its cut; anything else is nothing', () => {
  assert.deepEqual(unboundSayOf('你好'), { text: '你好' });
  assert.deepEqual(unboundSayOf({ text: '等一下', cut: { id: 'r1', shown: 4 } }), { text: '等一下', cut: { id: 'r1', shown: 4 } });
  assert.deepEqual(unboundSayOf({ text: '嗯' }), { text: '嗯' });
  assert.equal(unboundSayOf(null), null);
  assert.equal(unboundSayOf({ cut: { id: 'r1', shown: 1 } }), null);
  assert.equal(unboundSayOf(7), null);
});

test('one path: the cut the bubble gives is accepted by the host\'s chat request and becomes the same note the window gets', () => {
  const w = world();
  w.hold.take({ id: 'r1', type: 'delta', text: BODY }); w.learn(2); w.hold.heard('r1', 0, 'start');
  const cut = w.hold.interrupt()!;
  const request = validateChatRequest({ id: 'r2', messages: [{ role: 'user', content: '等一下' }], attachments: [], pauseCut: cut }) as { pauseCut?: unknown };
  assert.deepEqual(request.pauseCut, cut);
  const host = new PauseTalkHost({ ask: neverAskedPauseTalk(), enabled: () => false, available: () => true, now: () => null, send: () => {}, developerMode: () => false,
    clock: () => 0, timers: { set: () => 0, clear: () => {} } });
  const line = host.userTurn('r2', '等一下', request.pauseCut as typeof cut, 'gene');
  assert.equal(line, PAUSE_TALK_CUT_NOTE);
  assert.ok(!line!.includes('第二句'), 'nothing of the unshown text');
  assert.equal(host.userTurn('r3', '嗯', null, 'gene'), null, 'a reply fully shown: no note');
});
