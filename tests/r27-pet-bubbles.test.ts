import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { PetReplyUpdate } from '../shared/contracts';
import { PetUI } from '../src/ui/PetUI';
import { ReplySpeechState } from '../src/ui/reply-speech';
import { ReplyPresentationState, type ReadoutClock } from '../src/ui/reply-presentation';
import { validateReplyUpdate } from '../electron/reply-input';
import type { ReplyBubblePolicy } from '../shared/reply-bubbles';

function fakeClock() {
  let now = 0, next = 0; const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: ReadoutClock = { now: () => now, set: (fn, delay) => { const id = ++next; timers.set(id, { at: now + delay, fn }); return id as unknown as ReturnType<typeof setTimeout>; }, clear: id => { timers.delete(id as unknown as number); } };
  return { clock, advance(ms: number) { const end = now + ms; for (;;) { const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; timers.delete(due[0]); now = due[1].at; due[1].fn(); } now = end; } };
}

/** Real PetUI publication code with a stub native channel; the same call renderReadout makes. */
function petFixture(policy?: ReplyBubblePolicy) {
  const previousDocument = globalThis.document, previousWindow = globalThis.window;
  const body = { textContent: '', classList: { remove() {} } }, updates: PetReplyUpdate[] = [];
  globalThis.document = { getElementById: (id: string) => id === 'pet-answer-body' ? body : null } as unknown as Document;
  globalThis.window = { desktop: { updatePetReply: async (patch: PetReplyUpdate) => { updates.push(validateReplyUpdate(structuredClone(patch))); } } } as unknown as Window & typeof globalThis;
  const ui = Object.create(PetUI.prototype) as PetUI;
  Object.assign(ui, { replySpeech: new ReplySpeechState(), replyReader: { clear() {}, update() {} }, anchor: { x: 1, y: 1, visible: true },
    interactionProgress: 0, actions: { error(message: string) { assert.fail(message); } }, ...(policy ? { bubblePolicy: policy } : {}) });
  const time = fakeClock(), readout = new ReplyPresentationState(time.clock);
  return { ui, updates, time, readout, body,
    stream(id: string, chunks: string[]) {
      readout.begin(id); ui.beginAnswer(id);
      readout.startReadout(id, (prefix, _raw, ends) => ui.showAnswer(prefix, true, id, false, ends));
      let raw = ''; for (const chunk of chunks) { raw += chunk; readout.readoutContent(id, raw); }
      readout.finishReadout(id, () => {}); time.advance(10000); return raw;
    },
    restore() { globalThis.document = previousDocument; globalThis.window = previousWindow; } };
}
const texts = (update: PetReplyUpdate) => update.pieces!.ends.map((end, index, ends) => update.text!.slice(index ? ends[index - 1] : 0, end));

test('R27 same-bubble policy: one streamed reply stays in one bubble and advances by natural paragraphs', () => {
  const f = petFixture('same-bubble');
  try {
    const raw = f.stream('r', ['嗯，我在呢。', '今天累不累？', '\n\n要不要', '跟我说说？']);
    const bodies = f.updates.filter(update => update.text !== undefined);
    assert.equal(bodies[0].text, '嗯，我在呢。', 'the first sentence is published without waiting for the rest');
    assert.ok(bodies.every((update, index) => !index || update.text!.startsWith(bodies[index - 1].text!)), 'the native text stays the exact raw prefix');
    const last = bodies.at(-1)!;
    assert.equal(last.text, raw); assert.equal(last.segmented, false);
    assert.equal(last.pieces!.mode, 'paragraphs');
    assert.deepEqual(texts(last), ['嗯，我在呢。今天累不累？', '\n\n要不要跟我说说？']);
  } finally { f.restore(); }
});

test('R27 alternative: two complete sentences become two bubbles, in order', () => {
  const f = petFixture('bubble-per-sentence');
  try {
    f.stream('r', ['第一', '句。', '第二句。']);
    const bodies = f.updates.filter(update => update.text !== undefined);
    assert.deepEqual(bodies.map(update => texts(update)), [['第一'], ['第一句。'], ['第一句。', '第二句。']]);
    assert.ok(bodies.every(update => update.pieces!.mode === 'bubbles' && update.segmented === false));
  } finally { f.restore(); }
});

test('R27 pieces stay with this ordinary reply only: completion keeps them, proactive/segmented/new replies do not inherit them', () => {
  const f = petFixture('bubble-per-sentence');
  try {
    f.stream('r', ['第一句。第二句。']);
    // A non-retained completion of the same reply recomputes pieces from the completed text.
    f.ui.finishAnswer('第一句。第二句。第三句。', 'r', false, true, false);
    assert.deepEqual(texts(f.updates.at(-1)!), ['第一句。', '第二句。', '第三句。']);
    f.ui.finishAnswer('第一句。第二句。\n\n[已停止]', 'r', false, false, true);
    assert.equal(f.updates.at(-1)!.pieces, undefined, 'the segmented stop/error view keeps its own mode');
    f.ui.showAnswer('主动评论。第二句。', true, 'vision-1');
    assert.equal(f.updates.at(-1)!.pieces, undefined, 'proactive literal text keeps its original presentation');
    // Codex T-207 2D: a truncated native preview carries pieces of its own text (the note line, then the kept text), never
    // offsets into the original.
    f.ui.showAnswer('字'.repeat(32001) + '。', true, 'long', false, []);
    const preview = f.updates.at(-1)!;
    assert.equal(preview.text!.length, 32000);
    assert.deepEqual(preview.pieces?.ends, [preview.text!.indexOf('\n'), preview.text!.length]);
  } finally { f.restore(); }
});
