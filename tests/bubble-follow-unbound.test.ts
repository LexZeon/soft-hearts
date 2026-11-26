// I-165: full-screen Unbound's bubble follows her voice too. The host holds the reply's
// text (electron/unbound/bubble-hold.ts) and sends it on as the reading window says each sentence became audible; the read-aloud display
// proof (electron/unbound/read-aloud.ts) and the page's bubble (src/unbound/bubbles.ts) see only what was sent. Fake clock throughout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { UnboundBubbleHold, type HeldBubbleEvent } from '../electron/unbound/bubble-hold';
import { UnboundBubbleProof } from '../electron/unbound/read-aloud';
import { ReplyBubble } from '../src/unbound/bubbles';

const BODY = '第一句。第二句话。';
const ENDS = [4, 9];

function world(options: { follows?: boolean } = {}) {
  let now = 0, next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const emitted: HeldBubbleEvent[] = [];
  const proof = new UnboundBubbleProof({ active: () => true });
  let known = 0;
  const hold = new UnboundBubbleHold({
    emit: event => {
      emitted.push(event);
      // What electron/unbound/host.ts sendBubble does with each piece: the proof records what the page was given.
      if (event.type === 'hold') proof.hold(event.id); else if (event.type === 'delta') proof.sent(event.id, event.text);
    },
    now: () => now, setTimer: (fn, ms) => { const id = ++next; timers.set(id, { at: now + ms, fn }); return id; }, clearTimer: id => { timers.delete(id as number); },
  });
  hold.connect({ follows: () => options.follows !== false, segmentEnd: (id, index) => id === 'r1' && index < known ? ENDS[index] : null });
  return { hold, proof, emitted,
    learn(count: number) { known = count; },
    advance(ms: number) { const end = now + ms; for (;;) { const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; timers.delete(due[0]); now = due[1].at; due[1].fn(); } now = end; },
    sentText: () => emitted.filter(event => event.type === 'delta').map(event => event.text).join(''),
  };
}

test('her full-screen bubble: "……" first, then each sentence when its audio starts; the done waits for the last piece', () => {
  const w = world();
  assert.equal(w.hold.take({ id: 'r1', type: 'delta', text: '第一句。' }), true);
  assert.deepEqual(w.emitted, [{ id: 'r1', type: 'hold', text: '' }], 'the bubble goes up with "……", none of the text');
  assert.equal(w.proof.holdCurrent(), true, 'the held bubble may carry the first sentence\'s preparation');
  w.learn(1); w.hold.take({ id: 'r1', type: 'delta', text: '第二句话。' });
  w.learn(2); w.hold.take({ id: 'r1', type: 'done', text: '' });
  assert.equal(w.sentText(), '', 'the whole reply arrived; nothing shown yet');
  w.hold.heard('r1', 0, 'start');
  assert.equal(w.sentText(), '第一句。');
  assert.equal(w.proof.holdCurrent(), false, 'text sent: no longer a held bubble');
  assert.ok(!w.emitted.some(event => event.type === 'done'), 'no done while text is still held (it would start the bubble fading)');
  w.hold.heard('r1', 0, 'end'); w.hold.heard('r1', 1, 'start');
  assert.equal(w.sentText(), BODY);
  assert.equal(w.emitted.at(-1)?.type, 'done', 'the done goes once everything was sent');
  assert.equal(w.hold.holding, null);
  // The page reports what it painted, at a revision the host sent: the proof is the unchanged one.
  assert.equal(w.proof.report({ id: 'r1', rev: w.proof.revision, text: BODY, visible: true }), true);
});

test('every fallback shows the rest at once: the reading over, cancelled, a stall; an error passes straight through', () => {
  for (const release of ['over', 'cancelled', 'stall'] as const) {
    const w = world();
    w.hold.take({ id: 'r1', type: 'delta', text: BODY }); w.learn(2); w.hold.heard('r1', 0, 'start');
    if (release === 'stall') w.advance(60_000); else w.hold.release('r1', release);
    assert.equal(w.sentText(), BODY, release);
    w.hold.take({ id: 'r1', type: 'done', text: '' });
    assert.equal(w.emitted.at(-1)?.type, 'done', `${release}: the done follows at once`);
  }
  const failed = world();
  failed.hold.take({ id: 'r1', type: 'delta', text: BODY });
  assert.equal(failed.hold.take({ id: 'r1', type: 'error', text: '' }), false, 'the host sends the error itself (the page hides the bubble)');
  assert.equal(failed.hold.holding, null);
});

test('a reply that does not follow her voice (read-aloud off, the knob off) streams to the bubble exactly as before', () => {
  const w = world({ follows: false });
  assert.equal(w.hold.take({ id: 'r1', type: 'delta', text: '第一句。' }), false);
  assert.equal(w.hold.take({ id: 'r1', type: 'done', text: '' }), false);
  assert.deepEqual(w.emitted, []);
});

test('a newer reply replaces the held one; the old reply\'s late facts change nothing', () => {
  const w = world();
  w.hold.take({ id: 'r1', type: 'delta', text: BODY }); w.learn(2);
  w.hold.take({ id: 'r2', type: 'delta', text: '新的。' });
  const count = w.emitted.length;
  w.hold.heard('r1', 0, 'start'); w.hold.release('r1', 'over');
  assert.equal(w.hold.holding, 'r2', 'the old reply\'s release does not release the new one');
  w.advance(60_000);
  assert.deepEqual(w.emitted.slice(count).filter(event => event.id === 'r1'), [], 'nothing of the old reply is ever sent');
  w.hold.reset(); // she came home
  assert.equal(w.hold.holding, null);
});

test('the page shows "……" for a held reply (nothing to prove), then the text it is given', () => {
  class El {
    hidden = false; className = ''; textContent = ''; scrollTop = 0; scrollHeight = 0; offsetWidth = 200; offsetHeight = 60;
    readonly style: Record<string, string> = {}; readonly children: El[] = []; dataset: Record<string, string> = {};
    readonly classList = { add() {}, remove() {} };
    constructor(readonly ownerDocument: { createElement(): El }) {}
    append(...nodes: El[]) { this.children.push(...nodes); }
  }
  const doc = { createElement: () => new El(doc) }, root = new El(doc);
  const bubble = new ReplyBubble(root as unknown as HTMLElement), node = root.children[0];
  bubble.place({ x: 500, y: 300, r: 40 }, { width: 1200, height: 800 }, true);
  bubble.receive({ id: 'r1', type: 'delta', text: '', hold: true });
  assert.equal(node.hidden, false); assert.equal(node.textContent, '……');
  assert.equal(bubble.state(), null, 'no revision: the page claims nothing');
  assert.equal(bubble.current, '', 'no text of hers on screen');
  bubble.receive({ id: 'r1', type: 'delta', text: '第一句。', rev: 3 });
  assert.equal(node.textContent, '第一句。');
  assert.deepEqual(bubble.state(), { id: 'r1', rev: 3, text: '第一句。', visible: true });
});
