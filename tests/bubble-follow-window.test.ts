// I-165: the companion window's bubble follows her
// voice. The real PetUI publication code (as tests/r27-pet-bubbles.test.ts drives it), the real R27 readout and the real follow view, // no-pet-ok: PetUI / pet-answer-body are the existing names of the companion window's UI
// wired as src/wiring/bubble-follow-wiring.ts wires them; every patch goes through the host's own validator. Fake clock throughout.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { PetReplyUpdate } from '../shared/foundation/pet-reply'; // no-pet-ok: PetUI / pet-answer-body are the existing names of the companion window's UI
import { PetUI } from '../src/stage/PetUI'; // no-pet-ok: PetUI / pet-answer-body are the existing names of the companion window's UI
import { ReplySpeechState } from '../src/voice/reply-speech';
import { ReplyPresentationState, type ReadoutClock } from '../src/brain/reply-presentation';
import { BubbleFollowView } from '../src/voice/bubble-follow-view';
import { ReplyVoiceCap } from '../src/stage/reply-voice-cap';
import { validateReplyUpdate } from '../electron/brain/reply-input';
import type { BubbleFollowMode } from '../shared/voice/bubble-follow/knobs';

function fakeClock() {
  let now = 0, next = 0; const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: ReadoutClock = { now: () => now, set: (fn, delay) => { const id = ++next; timers.set(id, { at: now + delay, fn }); return id as unknown as ReturnType<typeof setTimeout>; }, clear: id => { timers.delete(id as unknown as number); } };
  return { clock, now: () => now, advance(ms: number) { const end = now + ms; for (;;) { const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; timers.delete(due[0]); now = due[1].at; due[1].fn(); } now = end; } };
}

const REPLY = '第一句。第二句话。第三。';
const ENDS = [4, 9, 12];

function world(mode: BubbleFollowMode = 'sentence') {
  const previousDocument = globalThis.document, previousWindow = globalThis.window;
  const body = { textContent: '', classList: { remove() {} } }, updates: PetReplyUpdate[] = []; // no-pet-ok: PetUI / pet-answer-body are the existing names of the companion window's UI
  globalThis.document = { getElementById: (id: string) => id === 'pet-answer-body' ? body : null } as unknown as Document; // no-pet-ok: PetUI / pet-answer-body are the existing names of the companion window's UI
  globalThis.window = { desktop: { updatePetReply: async (patch: PetReplyUpdate) => { updates.push(validateReplyUpdate(structuredClone(patch))); } } } as unknown as Window & typeof globalThis; // no-pet-ok: PetUI / pet-answer-body are the existing names of the companion window's UI
  const ui = Object.create(PetUI.prototype) as PetUI; // no-pet-ok: PetUI / pet-answer-body are the existing names of the companion window's UI
  const reader: string[] = [];
  Object.assign(ui, { replySpeech: new ReplySpeechState(), replyReader: { clear() {}, update(text: string) { reader.push(text); } }, anchor: { x: 1, y: 1, visible: true },
    interactionProgress: 0, actions: { error(message: string) { assert.fail(message); } }, bubblePolicy: 'bubble-per-sentence' });
  const time = fakeClock(), readout = new ReplyPresentationState(time.clock);
  const follow = new BubbleFollowView({ now: time.now, setTimer: (fn, ms) => time.clock.set(fn, ms), clearTimer: handle => time.clock.clear(handle as ReturnType<typeof setTimeout>),
    apply: (id, cap) => ui.setVoiceCap(id, cap), mode: () => mode });
  const texts = () => updates.filter(update => update.text !== undefined).map(update => update.text);
  return { ui, updates, time, readout, follow, body, reader, texts,
    /** chat-wiring: the reply is accepted, its bubble shows the waiting dots; the first delta engages the follow view (startStreamingReplySpeech). */
    begin(id = 'r1') { readout.begin(id); ui.showWaiting(id); follow.engage(id); readout.startReadout(id, (prefix, _raw, ends) => ui.showAnswer(prefix, true, id, false, ends)); },
    stream(text: string, id = 'r1') { readout.readoutContent(id, text); },
    /** The host's sentence lease broadcast (desk:reply-speech-segment). */
    lease(index: number, id = 'r1') { follow.segment({ replyId: id, index, visibleText: REPLY.slice(0, ENDS[index]) }); },
    heard(index: number, phase: 'start' | 'end' | 'skip', id = 'r1') { follow.heard({ replyId: id, segmentIndex: index, phase }); },
    last: () => updates.at(-1),
    restore() { globalThis.document = previousDocument; globalThis.window = previousWindow; } };
}

test('whole-sentence reveal: "……" until her first sentence sounds, then each sentence exactly when its audio starts', () => {
  const w = world();
  try {
    w.begin(); w.stream(REPLY); w.time.advance(10_000);
    assert.deepEqual(w.texts(), [''], 'only the waiting dots, though the whole reply has arrived and R27 has drained it');
    assert.equal(w.last()?.state, 'waiting');
    w.ui.expectAnswerSpeech('r1'); w.readout.finishReadout('r1', () => w.ui.finishAnswer(REPLY, 'r1', false, true, false));
    w.time.advance(1000);
    assert.ok(w.updates.every(update => update.text === undefined || update.text === ''), 'speech expected and readout finished never empty or fill the held bubble');
    assert.equal(w.updates.filter(update => update.state && update.state !== 'waiting').length, 0, 'no state other than waiting reaches the native bubble');
    w.lease(0); w.time.advance(1500);
    assert.deepEqual(w.texts(), [''], 'the first lease is out (synthesis may start), still nothing shown');
    w.heard(0, 'start');
    assert.equal(w.last()?.text, '第一句。'); assert.equal(w.last()?.state, 'streaming');
    w.lease(1); w.time.advance(2000);
    assert.equal(w.last()?.text, '第一句。', 'the second sentence waits for its own audio');
    w.heard(0, 'end'); w.heard(1, 'start');
    assert.equal(w.last()?.text, '第一句。第二句话。');
    assert.deepEqual(w.reader.at(-1), REPLY, 'the full reader keeps the whole reply all along');
    w.lease(2); w.heard(1, 'end'); w.heard(2, 'start');
    assert.equal(w.last()?.text, REPLY);
    assert.ok(w.texts().every((text, index, all) => !index || text!.startsWith(all[index - 1]!)), 'never reordered: each patch extends the last');
  } finally { w.restore(); }
});

test('the bubble\'s linger counts from the end of the last sentence heard: no complete until the reading is over, then complete with the whole text', () => {
  const w = world();
  try {
    w.begin(); w.stream(REPLY); w.ui.expectAnswerSpeech('r1');
    w.readout.finishReadout('r1', () => w.ui.finishAnswer(REPLY, 'r1', false, true, false)); w.time.advance(10_000);
    w.lease(0); w.heard(0, 'start'); w.lease(1); w.heard(1, 'start'); w.lease(2); w.heard(2, 'start');
    assert.equal(w.updates.filter(update => update.state === 'complete').length, 0, 'while she still speaks, the host has no lifetime to count');
    w.time.advance(5000);
    // chat-wiring finishReplySpeechPresentation: the follow view is told first, then the bubble may complete.
    w.follow.over('r1'); w.ui.endAnswerSpeech('r1');
    const complete = w.updates.filter(update => update.state === 'complete');
    assert.equal(complete.length, 1, 'one completion, when her last sentence has played out');
    assert.equal(w.texts().at(-1), REPLY);
  } finally { w.restore(); }
});

for (const [why, release] of [
  ['the reading is over', (w: ReturnType<typeof world>) => w.follow.over('r1', 'over')],
  ['her voice failed (or Drama 3\'s month ran out)', (w: ReturnType<typeof world>) => w.follow.over('r1', 'error')],
  ['the reading was cancelled (talked over in a call, voice switched off)', (w: ReturnType<typeof world>) => w.follow.over('r1', 'cancelled')],
  ['the user interrupted (new message, stop, microphone on)', (w: ReturnType<typeof world>) => w.follow.over('r1', 'interrupted')],
  ['her voice stalled', (w: ReturnType<typeof world>) => w.time.advance(31_000)],
] as const) {
  test(`fallback: ${why}: everything shows at once, nothing lost, nothing reordered`, () => {
    const w = world();
    try {
      w.begin(); w.stream(REPLY); w.time.advance(5000); w.lease(0); w.heard(0, 'start');
      assert.equal(w.last()?.text, '第一句。');
      release(w);
      assert.equal(w.texts().at(-1), REPLY);
      w.heard(1, 'start'); w.lease(1);
      assert.equal(w.texts().at(-1), REPLY, 'a late fact never holds it back again');
    } finally { w.restore(); }
  });
}

test('fallback: read-aloud off or the knob off: the bubble shows text as before (R27 pacing, nothing held)', () => {
  const w = world('off');
  try {
    w.begin(); w.stream(REPLY);
    assert.equal(w.texts()[1], '第一句。', 'the first sentence is published at once, as before');
    w.time.advance(10_000);
    assert.equal(w.texts().at(-1), REPLY);
  } finally { w.restore(); }
});

test('interrupt mid-reply shows the rest; a cancelled reading never revives a hidden bubble or overwrites the next reply', () => {
  const w = world();
  try {
    w.begin(); w.stream(REPLY); w.time.advance(5000); w.lease(0); w.heard(0, 'start');
    w.ui.hideAnswer(); // her window hid, or the bubble timed out
    const count = w.updates.length;
    w.follow.over('r1', 'cancelled'); w.time.advance(60_000);
    assert.equal(w.updates.length, count, 'nothing is published for a hidden reply');

    w.begin('r2'); w.stream('新的回复。', 'r2');
    w.heard(1, 'start', 'r1'); w.follow.over('r1');
    assert.deepEqual(w.updates.slice(count).filter(update => update.text !== undefined).map(update => update.text), [''], 'the old reply\'s late facts change nothing on the new one');
    w.follow.segment({ replyId: 'r2', index: 0, visibleText: '新的回复。' }); w.heard(0, 'start', 'r2');
    assert.equal(w.last()?.text, '新的回复。');
  } finally { w.restore(); }
});

test('a reply already showing text is never hidden again by a late engage', () => {
  const w = world();
  try {
    w.readout.begin('r1'); w.ui.showWaiting('r1');
    w.readout.startReadout('r1', (prefix, _raw, ends) => w.ui.showAnswer(prefix, true, 'r1', false, ends));
    w.stream('第一句。');
    assert.equal(w.last()?.text, '第一句。');
    w.follow.engage('r1'); // read-aloud switched on mid-reply
    w.stream(REPLY); w.time.advance(10_000);
    assert.equal(w.texts().at(-1), REPLY, 'still shown as it streams');
    assert.ok(!w.updates.slice(1).some(update => update.state === 'waiting'), 'never back to the waiting dots');
  } finally { w.restore(); }
});

test('char mode: inside a sentence the bubble grows with the sentence\'s audio time, never ahead of it', () => {
  const w = world('char');
  try {
    w.begin(); w.stream(REPLY); w.time.advance(5000); w.lease(0); w.lease(1);
    w.heard(0, 'start');
    const start = w.texts().length;
    w.time.advance(220); // charMs 220: one unit per 220 ms for the first sentence
    assert.equal(w.texts().at(-1), '第');
    w.time.advance(440);
    assert.equal(w.texts().at(-1), '第一句');
    w.heard(0, 'end');
    assert.equal(w.texts().at(-1), '第一句。', 'its audio ended: the sentence whole');
    w.heard(1, 'start'); w.time.advance(10_000);
    assert.equal(w.texts().at(-1), '第一句。第二句话。', 'never past the sentence being said');
    const grown = w.texts().slice(start);
    assert.ok(grown.every((text, index, all) => !index || text!.length >= all[index - 1]!.length), 'one direction only');
  } finally { w.restore(); }
});

test('reading map (I-164): what she says may differ from what is shown; the bubble is cut by shown-text offsets, always shown text', () => {
  const w = world();
  try {
    const shown = 'W先生，你好。今天见。';
    w.begin(); w.stream(shown); w.time.advance(5000);
    // The host's lease carries the shown prefix; the voice exit says "达布流先生" (longer) — never seen by the bubble.
    w.follow.segment({ replyId: 'r1', index: 0, visibleText: 'W先生，你好。', text: '达布流先生，你好。' });
    w.heard(0, 'start');
    assert.equal(w.last()?.text, 'W先生，你好。', 'the shown sentence, whole, by its shown length');
    w.follow.segment({ replyId: 'r1', index: 1, visibleText: shown, text: '今天见。' }); w.heard(1, 'start');
    assert.equal(w.last()?.text, shown);
  } finally { w.restore(); }
});

test('the cap never splits a character outside the basic plane nor a combined emoji', () => {
  const cap = new ReplyVoiceCap();
  assert.equal(cap.set('r', 0, false), true);
  assert.equal(cap.limit('r', '好😀呀'), 0);
  cap.set('r', 2, false);
  assert.equal(cap.limit('r', '好😀呀'), 1, 'the emoji is two code units: not half of it');
  cap.set('r', 3, false);
  assert.equal(cap.limit('r', '好😀呀'), 3);
  const family = '👩‍👩‍👧好';
  cap.set('f', 0, false); cap.set('f', 3, false);
  assert.equal(cap.limit('f', family), 0, 'a combined emoji shows whole or not at all');
  assert.equal(cap.limit('other', family), null, 'a cap only applies to its own reply');
  cap.set('f', null, false);
  assert.equal(cap.limit('f', family), null);
  assert.equal(cap.set('f', 2, false), false, 'released for good');
});
