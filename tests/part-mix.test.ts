// I-175 step 1 (docs/claude/2026-11-22-i175-part-mixer.md): the pure rules of shared/behaviors/part-mix/: the parts table, the mouth's base
// shape with lip-sync on top (amplitude and vowel), closed-mouth shapes waiting for a pause, and "how long". Fake clock; no three.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PARTS, VOWELS, type Vowel } from '../shared/behaviors/part-mix/interface';
import { MOUTH_TALK_THROUGH, PART_MIX_KNOBS } from '../shared/behaviors/part-mix/knobs';
import { NO_MOUTH_BASE, TalkEase, composeFeedMouth, mouthBaseOf, mouthRoleOfName, mouthRoleOfSlot, talkFade, talkThroughMouth, vowelOpenings } from '../shared/behaviors/part-mix/mouth';
import { ClosedMouthQueue, closedMouthMayStart, mouthActionKind } from '../shared/behaviors/part-mix/closed-mouth';
import { LineHolds, beatHold, sentenceEndAfter } from '../shared/behaviors/speech-beats/how-long';
import { SOURCES, claimsOn } from '../shared/behaviors/part-mix/sources';
import { composeMouth } from '../src/stage/channel-compositors';
import { faceNamed, faceSlots } from '../src/unbound/motion/showcase-motion';
import { emptyShowcaseFace } from '../src/unbound/window-mode/window-expression';
import { HER_FACE_ACTIONS } from '../shared/actions/her-actions';

test('the parts table: every part has a user; only lip-sync is the base of the opening; closed-mouth shapes never talk through; the pout does', () => {
  for (const part of PARTS) assert.ok(claimsOn(part).length > 0, `${part} has a source`);
  assert.deepEqual(claimsOn('mouthOpen').filter(c => c.claim.kind === 'base').map(c => c.id), ['lipSync']);
  const closed = SOURCES.find(s => s.id === 'closedMouth')!;
  for (const claim of Object.values(closed.parts)) { assert.equal(claim!.talkThrough, false); assert.equal(claim!.kind, 'exclusive'); }
  const small = SOURCES.find(s => s.id === 'smallAction')!;
  assert.equal(small.parts.mouthShape?.talkThrough, true, 'the pout is a mouth shape she can hold while she speaks (plan item 1)');
  for (const source of SOURCES) for (const claim of Object.values(source.parts)) assert.ok(claim!.easeS > 0, `${source.id} eases (never a one-frame jump)`);
  assert.equal(MOUTH_TALK_THROUGH, 0.6, 'plan item 2: 0.6 first');
});

test('mouth roles: shapes stay while she speaks, the opening and closed-mouth shapes give way (slots and the showcase\'s named shapes)', () => {
  for (const slot of ['a', 'i', 'u', 'e', 'o']) assert.equal(mouthRoleOfSlot(slot), 'opening', slot);
  assert.equal(mouthRoleOfSlot('mouthPucker'), 'shape');
  assert.equal(mouthRoleOfSlot('mouthSmile'), 'shape');
  assert.equal(mouthRoleOfSlot('blink'), null);
  // Every named shape the showcase writes (pout, sly, surprise, speech's jaw).
  const face = { ...emptyShowcaseFace(), pout: 1, sly: 1, surprise: 1, mouth: { a: 1, i: 0, u: 0, e: 0, o: 0 } };
  const roles = Object.fromEntries(Object.keys(faceNamed(face)).map(key => [key.split('|')[0], mouthRoleOfName(key)]));
  assert.deepEqual(roles, { mouthSmileLeft: 'shape', '驚き(総': null, jawOpen: 'opening', mouthFunnel: 'shape', cheekPuff: 'closed', '口横狭め': 'shape' });
  assert.equal(mouthRoleOfName('tongueOut'), 'closed');
  assert.equal(mouthRoleOfName('う'), 'opening');
  assert.equal(talkFade('shape', 1), 1);
  assert.equal(talkFade('opening', 0.25), 0.75);
  assert.equal(talkFade('closed', 1), 0);
  assert.equal(talkFade(null, 1), 1);
});

test('the base shape reads the same from the showcase\'s pout and smile on every model (slots and named shapes)', () => {
  const pout = { ...emptyShowcaseFace(), pout: 0.82 };
  const p = mouthBaseOf(faceSlots(pout), faceNamed(pout));
  assert.ok(p.pucker > 0.7 && p.smile === 0 && p.strength >= p.pucker, JSON.stringify(p));
  const smile = { ...emptyShowcaseFace(), warm: 0.82 };
  const s = mouthBaseOf(faceSlots(smile), faceNamed(smile));
  assert.ok(s.smile > 0.6 && s.pucker === 0, JSON.stringify(s));
  assert.deepEqual(mouthBaseOf(null), NO_MOUTH_BASE);
  assert.deepEqual(mouthBaseOf({ blink: 1, smileEyes: 1 }), NO_MOUTH_BASE, 'eyes are not the mouth');
});

test('lip-sync on top of the base: the amplitude is never below 0.6 (never 0), 1 without a base, continuous; the vowel follows the base', () => {
  assert.equal(talkThroughMouth(NO_MOUTH_BASE).scale, 1);
  assert.deepEqual(talkThroughMouth(NO_MOUTH_BASE).vowels, { a: 1, i: 0, u: 0, e: 0, o: 0 });
  // The lean rules on a model whose every vowel parts the lips like あ (the floor never needed; 2026-11-22's floor is in mouth-shut-while-talking.test.ts).
  const ALL = { a: 1, i: 1, u: 1, e: 1, o: 1 }, K = PART_MIX_KNOBS;
  const full = talkThroughMouth({ pucker: 1, smile: 0, strength: 1 }, undefined, K, ALL);
  assert.equal(full.scale, MOUTH_TALK_THROUGH);
  assert.equal(full.vowels.u, 1, 'a full pout flaps on う');
  // 2026-11-22: a smile leans only smileVowelMax onto い (a blend: い alone barely parts the lips), the rest stays on あ.
  const smiling = talkThroughMouth({ pucker: 0, smile: 0.9, strength: 0.9 }, undefined, K, ALL);
  assert.ok(Math.abs(smiling.vowels.i - K.smileVowelMax) < 1e-9 && Math.abs(smiling.vowels.a - (1 - K.smileVowelMax)) < 1e-9, 'a smile leans a little to い');
  assert.equal(talkThroughMouth({ pucker: 1, smile: 0, strength: 1 }, v => v !== 'u', K, ALL).vowels.o, 1, 'no う on the model: お');
  assert.equal(talkThroughMouth({ pucker: 1, smile: 0, strength: 1 }, v => v === 'a', K, ALL).vowels.a, 1, 'neither う nor お: あ');
  assert.ok(Math.abs(talkThroughMouth({ pucker: 0, smile: 1, strength: 1 }, v => v !== 'i', K, ALL).vowels.e - K.smileVowelMax) < 1e-9, 'no い: え');
  // Sweep the base: the scale and every share move continuously, shares sum to 1, the scale stays in [0.6, 1].
  let last = talkThroughMouth(NO_MOUTH_BASE);
  for (let k = 1; k <= 400; k++) {
    const x = k / 400, now = talkThroughMouth({ pucker: x, smile: x / 3, strength: x });
    assert.ok(now.scale >= MOUTH_TALK_THROUGH - 1e-12 && now.scale <= 1, `scale ${now.scale}`);
    assert.ok(Math.abs(now.scale - last.scale) < 0.01, 'scale continuous');
    let sum = 0;
    for (const v of VOWELS) { sum += now.vowels[v]; assert.ok(Math.abs(now.vowels[v] - last.vowels[v]) < 0.02, `${v} continuous`); }
    assert.ok(Math.abs(sum - 1) < 1e-9, 'shares sum to 1');
    last = now;
  }
  // Even a knob set to 0 cannot stop the mouth: the floor is the knob, and the flap writes a share of a positive opening.
  const opened = vowelOpenings(0.4, talkThroughMouth({ pucker: 1, smile: 0, strength: 1 }, undefined, PART_MIX_KNOBS, { a: 1, i: 1, u: 1, e: 1, o: 1 }));
  assert.ok(opened.u > 0 && opened.u <= 0.4 * MOUTH_TALK_THROUGH / MOUTH_TALK_THROUGH);
});

test('feeding composes with lip-sync exactly as the companion stage does (copied, so the Unbound engine keeps it after I-176)', () => {
  for (const lip of [0, 0.3, 0.68]) for (const feed of [0, 0.2, 0.9]) for (const w of [0, 0.4, 1])
    assert.equal(composeFeedMouth(lip, feed, w), composeMouth(lip, feed, w), `${lip} ${feed} ${w}`);
});

test('TalkEase: eases toward the flap owning the opening and back, no jump at 60 or 30 fps, same curve', () => {
  const run = (fps: number) => { const ease = new TalkEase(); const out: number[] = []; for (let k = 0; k < fps * 2; k++) out.push(ease.frame(1 / fps, k < fps)); return out; };
  for (const fps of [60, 30]) {
    const v = run(fps);
    let maxStep = 0;
    for (let k = 1; k < v.length; k++) maxStep = Math.max(maxStep, Math.abs(v[k] - v[k - 1]));
    // Critically damped at ω = 14: the fastest it moves is ω/e ≈ 5.2 per second (0.086 a frame at 60 fps), starting from rest (no kink).
    assert.ok(maxStep < (fps === 60 ? 0.1 : 0.2), `${fps} fps largest step ${maxStep}`);
    assert.ok(v[0] < 0.1 && v[1] - v[0] > v[0], `the first frame starts slowly (speeds up after): ${v[0]}`);
    assert.ok(v[fps - 1] > 0.99 && v[v.length - 1] < 0.01, 'reaches both ends within a second');
  }
  const a = run(60), b = run(30);
  assert.ok(Math.abs(a[59] - b[29]) < 0.01, 'the same curve at both rates');
});

test('mouth action kinds: the pout talks through, cheek puff and tongue out wait; every face action on the mouth is one or the other', () => {
  assert.equal(mouthActionKind('pout'), 'talk-through');
  assert.equal(mouthActionKind('cheek-puff'), 'closed');
  assert.equal(mouthActionKind('tongue-out'), 'closed');
  assert.equal(mouthActionKind('kiss'), 'closed');
  assert.equal(mouthActionKind('wink'), null);
  for (const id of HER_FACE_ACTIONS) if (id !== 'wink') assert.notEqual(mouthActionKind(id), null, id);
});

test('closed-mouth shapes: never start while the held flag is on; start in a pause or after; dropped 3 s after; a cancel drops all (fake clock)', () => {
  const world = (held: boolean, free = true, sentenceOpen = false) => ({ held, free, sentenceOpen });
  assert.equal(closedMouthMayStart(world(true)), false, 'never while she speaks');
  assert.equal(closedMouthMayStart(world(false, true, true)), false, 'never mid-sentence with read-aloud off');
  assert.equal(closedMouthMayStart(world(false, false)), false, 'another owner holds her mouth');
  assert.equal(closedMouthMayStart(world(false)), true);
  // A streamed reading: held on for 3 s, then quiet.
  const q = new ClosedMouthQueue<string>();
  q.push('puff', 0.5);
  let started: { what: string; at: number } | null = null;
  for (let k = 0; k <= 60 * 5; k++) {
    const t = k / 60, got = q.frame(t, world(t < 3.3));
    if (got) { assert.equal(started, null, 'returned once'); started = { what: got, at: t }; }
  }
  assert.ok(started && started.at >= 3.3 && started.at < 3.3 + 1 / 60 + 1e-9, `started right after the reading: ${JSON.stringify(started)}`);
  // Quiet but a touch holds her mouth for 4 s: dropped once 3 s of the pause have passed.
  const late = new ClosedMouthQueue<string>();
  late.push('puff', 0);
  let got: string | null = null;
  for (let k = 0; k <= 60 * 6; k++) { const t = k / 60; got ??= late.frame(t, world(t < 1, t > 5)); }
  assert.equal(got, null, 'a pause that ended past 3 s: not played late');
  assert.equal(late.dropped, 1);
  // A pause in the middle of the reading counts; the drop count restarts when she speaks again.
  const mid = new ClosedMouthQueue<string>();
  mid.push('puff', 0);
  let midAt: number | null = null;
  for (let k = 0; k <= 60 * 8; k++) { const t = k / 60, held = t < 1 || (t > 1.6 && t < 6); const out = mid.frame(t, world(held, !held && t > 6.5)); if (out) midAt = t; }
  assert.ok(midAt !== null && midAt >= 6.5, `the pause at 1.0–1.6 s was taken by another owner; it waited and started after the reading: ${midAt}`);
  // Cancelled: nothing plays even when she is quiet and free.
  const cancelled = new ClosedMouthQueue<string>();
  cancelled.push('puff', 0);
  cancelled.cancel();
  for (let k = 0; k <= 60 * 2; k++) assert.equal(cancelled.frame(k / 60, world(false)), null);
  // The cap: never more than `max` waiting (the oldest goes).
  const many = new ClosedMouthQueue<string>(2);
  many.push('a', 0); many.push('b', 0); many.push('c', 0);
  assert.equal(many.size, 2);
  assert.equal(many.frame(1, world(false)), 'b');
});

test('"how long": no suffix = as today; once = never held; line = held to this sentence\'s pause', () => {
  assert.equal(beatHold(undefined, true), true);
  assert.equal(beatHold(undefined, false), false);
  assert.equal(beatHold('once', true), false);
  assert.equal(beatHold('line', true), 'line');
  assert.equal(beatHold('line', false), false, 'a performance-only reply holds nothing');
  const text = '今天起得好早。「真的吗？」昨晚睡得好吗？还行';
  assert.equal(sentenceEndAfter(text, 0), 7);
  assert.equal(sentenceEndAfter(text, 7), 13, 'the closing quote belongs to the sentence');
  assert.equal(sentenceEndAfter(text, 13), 20);
  assert.equal(sentenceEndAfter(text, 20), text.length, 'not ended yet: the text\'s end');
  // The bubble: over once a character after the sentence shows.
  const lines = new LineHolds();
  lines.setText(text);
  lines.hold(0);
  assert.equal(lines.reached(7), false);
  assert.equal(lines.reached(8), true);
  assert.equal(lines.reached(9), false, 'once');
  // The reading: the next segment starting at the end counts.
  lines.hold(7);
  assert.equal(lines.reached(7, true), false);
  assert.equal(lines.reached(13, true), true);
  // A sentence still being written is not over.
  const growing = new LineHolds();
  growing.setText('我想想');
  growing.hold(0);
  assert.equal(growing.reached(3), false);
  growing.setText('我想想，嗯。好');
  assert.equal(growing.reached(7), true);
});

test('vowel names used by the flap exist as universal slots (a fallback chain never names a vowel the table lacks)', () => {
  const has = new Set<Vowel>(VOWELS);
  for (const base of [{ pucker: 1, smile: 0, strength: 1 }, { pucker: 0, smile: 1, strength: 1 }]) for (const [v, share] of Object.entries(talkThroughMouth(base).vowels)) if (share > 0) assert.ok(has.has(v as Vowel));
  assert.equal(PART_MIX_KNOBS.closedMouthDropS, 3, 'plan item 3: 3 s after the reading');
});
