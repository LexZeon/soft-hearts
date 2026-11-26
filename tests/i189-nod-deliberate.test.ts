/**
 * I-189 #3 follow-up (evening: "点头回答太灵敏。"): a nod or shake answers her question only when it is a clear,
 * deliberate double move, facing the screen, right after she finished a yes/no question, and never while typing or in a call.
 * Recorded-like synthetic sequences (10 fps, shoulders 0.2 of the frame wide = 5 frame widths per shoulder width); no real person.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_POSE_SIGNAL, type PosePoint, type PoseSignal } from '../shared/senses/pose-signals';
import { HeadGestureDetector } from '../shared/behaviors/pose-uses/nod';
import { gestureTurnText } from '../shared/behaviors/pose-uses/lines';
import { POSE_USES_KNOBS } from '../shared/behaviors/pose-uses/knobs';
import { PoseUsesHost } from '../electron/senses/pose-uses/host';

const SW = 0.2; // shoulder width in frame widths
const sig = (over: Partial<PoseSignal> = {}): PoseSignal => ({ ...EMPTY_POSE_SIGNAL, present: true, confidence: 0.9, facing: 'toward', facingConfidence: 0.8, posture: 'sitting', postureConfidence: 0.8, energy: 0.1, people: 1, ...over });
const body = (nose: PosePoint, mid = { x: 0.5, y: 0.7 }): (PosePoint | null)[] => {
  const p: (PosePoint | null)[] = Array.from({ length: 17 }, () => null);
  p[0] = nose; p[5] = { x: mid.x - SW / 2, y: mid.y }; p[6] = { x: mid.x + SW / 2, y: mid.y };
  return p;
};
/** Nose offsets in shoulder widths; `body` places them against the shoulders. */
interface Frame { nx: number; ny: number; mx?: number; my?: number }
const frames = (n: number, f: (i: number) => Frame): Frame[] => Array.from({ length: n }, (_, i) => f(i));
const cycles = (i: number, n: number, count: number) => (1 - Math.cos(2 * Math.PI * (i / (n - 1)) * count)) / 2;
const place = (fr: Frame) => ({ nose: { x: 0.5 + (fr.nx + 0) * SW + (fr.mx ?? 0) * SW, y: 0.45 + fr.ny * SW + (fr.my ?? 0) * SW }, mid: { x: 0.5 + (fr.mx ?? 0) * SW, y: 0.7 + (fr.my ?? 0) * SW } });
const run = (seq: Frame[], knobs?: ConstructorParameters<typeof HeadGestureDetector>[0]): string | null => {
  const d = new HeadGestureDetector(knobs);
  let found: string | null = null;
  seq.forEach((fr, i) => { const { nose, mid } = place(fr); found ??= d.push(body(nose, mid), i * 100); });
  return found;
};

const doubleNod = frames(13, i => ({ nx: 0, ny: 0.35 * cycles(i, 13, 2) }));
const doubleShake = frames(13, i => ({ nx: 0.4 * cycles(i, 13, 2), ny: 0 }));

/** What the knobs said before this change (2026-11-22), to show the same sequences fooled it. */
const OLD = { ...POSE_USES_KNOBS.nod, step: 0.06, nodSwings: 2, shakeSwings: 3, nodRange: 0.12, shakeRange: 0.14, crossRatio: 0.6, spanMs: 1_800, facingConfidence: 0.4, maxBodyMove: 99 };

test('a deliberate double nod and a double shake are recognised; one nod is not', () => {
  assert.equal(run(doubleNod), 'nod');
  assert.equal(run(doubleShake), 'shake');
  assert.equal(run(frames(7, i => ({ nx: 0, ny: 0.35 * cycles(i, 7, 1) }))), null, 'a single nod');
  assert.equal(run(frames(7, i => ({ nx: 0.4 * cycles(i, 7, 1), ny: 0 }))), null, 'a single swing sideways');
});

test('small head bobs, reading, talking and looking down at the keyboard are not answers (and the old knobs counted some)', () => {
  const smallBobs = frames(40, i => ({ nx: 0, ny: 0.14 * cycles(i, 40, 6) }));             // +-0.07 shoulder widths, 1.5 Hz
  const reading = frames(100, i => ({ nx: 0.05 * Math.sin(i / 5), ny: 0.3 * (i / 100) + 0.04 * Math.sin(i * 1.7) })); // slow drift down + saccade jitter, 10 s
  const talking = frames(100, i => ({ nx: 0.04 * Math.sin(i * 0.9), ny: 0.07 * Math.abs(Math.sin(i * 1.3)) }));       // mouth/jaw bobbing, 10 s
  const lookDown = frames(30, i => ({ nx: 0, ny: i < 8 ? 0.55 * (i / 8) : i < 20 ? 0.55 : 0.55 * (1 - (i - 20) / 9) })); // down, stay, back up
  const nodWhileShifting = frames(13, i => ({ nx: 0, ny: 0.35 * cycles(i, 13, 2), my: 0.5 * (i / 12) }));              // the whole body leans in
  for (const [name, seq] of [['small bobs', smallBobs], ['reading', reading], ['talking', talking], ['looking down', lookDown], ['leaning in while nodding', nodWhileShifting]] as const) {
    assert.equal(run(seq), null, name);
  }
  assert.equal(run(lookDown, OLD), 'nod', 'before: looking down at the keyboard and back up was a nod');
  assert.equal(run(smallBobs, OLD), 'nod', 'before: small bobs were a nod');
  assert.equal(run(nodWhileShifting, OLD), 'nod', 'before: a body shifting in the chair still counted');
});

test('a nod that is too slow to be a deliberate double nod is nothing (more than spanMs)', () => {
  assert.equal(run(frames(25, i => ({ nx: 0, ny: 0.35 * cycles(i, 25, 2) }))), null, 'two nods over 2.4 s');
});

// ---------------------------------------------------------------- the host: window, typing, facing

function rig() {
  const s = { now: 1_000_000, line: null as { text: string; at: number } | null, busy: false, can: true };
  const sent: string[] = [];
  const host = new PoseUsesHost({ clock: () => s.now, dayKey: () => 'd', language: () => 'zh-CN', herLine: () => s.line, herBusy: () => s.busy, canAnswer: () => s.can, answer: t => { sent.push(t); return true; } });
  const feed = (seq: Frame[], over: Partial<PoseSignal> = {}) => seq.forEach(fr => { const { nose, mid } = place(fr); host.note(sig({ points: body(nose, mid), face: nose, ...over })); s.now += 100; });
  const rest = (ms: number, over: Partial<PoseSignal> = {}) => { for (let t = 0; t < ms; t += 100) feed([{ nx: 0, ny: 0 }], over); };
  return { s, sent, host, feed, rest };
}
const ask = (r: ReturnType<typeof rig>, text = '要不要喝点水？') => { r.s.line = { text, at: r.s.now }; };

test('the host: a double nod right after her question answers once; a single nod, a late nod, a nod during her speech do not', () => {
  const r = rig(); ask(r); r.rest(1_500);
  r.feed(frames(7, i => ({ nx: 0, ny: 0.35 * cycles(i, 7, 1) })));
  assert.deepEqual(r.sent, [], 'one nod');
  r.rest(500);
  r.feed(doubleNod);
  assert.deepEqual(r.sent, [gestureTurnText('nod')]);

  const late = rig(); ask(late); late.rest((POSE_USES_KNOBS.nod.windowSeconds + 1) * 1000); late.feed(doubleNod);
  assert.deepEqual(late.sent, [], 'later than the window');

  const talking = rig(); ask(talking); talking.s.busy = true; talking.rest(3_000); talking.feed(doubleNod);
  assert.deepEqual(talking.sent, [], 'she is still speaking');
  talking.s.busy = false; talking.rest(1_500); talking.feed(doubleShake);
  assert.deepEqual(talking.sent, [gestureTurnText('shake')], 'once she is done the window opens');
});

test('the host: typing or a call blocks it, and for a moment after; facing the keyboard blocks it; blocked frames never use up her question', () => {
  const r = rig(); ask(r); r.s.can = false; r.rest(500); r.feed(doubleNod);
  assert.deepEqual(r.sent, [], 'typing');
  r.s.can = true; r.rest(300); r.feed(doubleNod);
  assert.deepEqual(r.sent, [], 'just stopped typing (quietAfterMs)');
  ask(r); r.rest(POSE_USES_KNOBS.nod.quietAfterMs + 200); r.feed(doubleNod);
  assert.deepEqual(r.sent, [gestureTurnText('nod')], 'after a quiet moment, a nod to a question counts');

  const side = rig(); ask(side); side.rest(1_500); side.feed(doubleNod, { facing: 'side', facingConfidence: 0.9 });
  assert.deepEqual(side.sent, [], 'side face');
  const unsure = rig(); ask(unsure); unsure.rest(1_500); unsure.feed(doubleNod, { facingConfidence: POSE_USES_KNOBS.nod.facingConfidence - 0.1 });
  assert.deepEqual(unsure.sent, [], 'toward, but not sure enough');
});
