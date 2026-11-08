// F7 说话节奏 in the paced readout (src/ui/reply-presentation.ts).
// Kept as the base for "停停说说": the first bubble never waits, a bubble's hold starts once, every timer dies with its
// reply (cancel, clear, a new reply, hiding), a feed pause resumes where it was, and the shown pieces add up to the original.
// By default the pacing is exactly R27's. The mood multiplier, visible-character hold, 4 s budget, "……" stop and afterthought pause
// are a fallback, 兜底（待定）, off by default; the tests marked so exercise its mechanics only, not a final behaviour.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ReplyPresentationState, type ReadoutClock } from '../src/ui/reply-presentation';
import { REPLY_RHYTHM_BUDGET_MS, REPLY_RHYTHM_FALLBACK_ENABLED } from '../shared/reply-rhythm';

function fakeClock() {
  let now = 0, next = 0; const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: ReadoutClock = { now: () => now, set: (fn, delay) => { const id = ++next; timers.set(id, { at: now + delay, fn }); return id as unknown as ReturnType<typeof setTimeout>; }, clear: id => { timers.delete(id as unknown as number); } };
  return { clock, get now() { return now; }, pending: () => timers.size,
    advance(ms: number) { const end = now + ms; for (;;) { const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; timers.delete(due[0]); now = due[1].at; due[1].fn(); } now = end; } };
}
/** A readout with its paints and their times; `fallback` turns on the 兜底（待定） rules. */
function readout(options: { multiplier?: number; shy?: boolean; fallback?: boolean } = {}) {
  const time = fakeClock(), s = new ReplyPresentationState(time.clock, undefined, { rhythmFallback: options.fallback === true });
  const paints: Array<{ at: number; text: string; ends: number[] }> = [];
  s.begin('r');
  if (options.multiplier !== undefined) s.setRhythm('r', { multiplier: options.multiplier, shy: options.shy === true });
  s.startReadout('r', (prefix, _raw, ends) => paints.push({ at: time.now, text: prefix, ends: [...ends] }));
  return { time, s, paints, last: () => paints.at(-1)?.text ?? '' };
}
const modes = [{ name: '默认', fallback: false }, { name: '兜底（待定）', fallback: true }] as const;

test('default: the fallback is off and the bubbles keep exactly R27\'s pacing', () => {
  assert.equal(REPLY_RHYTHM_FALLBACK_ENABLED, false);
  const { time, s, last } = readout({ multiplier: 1.15, shy: true });
  assert.equal(s.setRhythm('r', { multiplier: 0.85 }), false, 'a pace is not taken while the fallback is off');
  assert.equal(s.rhythmOf('r'), 1);
  // R27's hold in code units: ten emoji + "。" are 21 units → 250 + 21 × 70 = 1720 ms.
  const lead = '😀'.repeat(10) + '。';
  s.readoutContent('r', lead + '我……其实挺想你的。对了，明天记得带伞。'); s.finishReadout('r', () => {});
  time.advance(1719); assert.equal(last(), lead);
  time.advance(1); assert.equal(last(), lead + '我……其实挺想你的。', 'no "……" stop: the whole sentence at once');
  time.advance(250 + 10 * 70); assert.equal(last(), lead + '我……其实挺想你的。对了，明天记得带伞。', 'no extra wait before "对了"');
  // No 4 s budget: a long burst still shows every sentence one by one.
  const burst = readout({ multiplier: 0.85 }), raw = '句。'.repeat(20);
  burst.s.readoutContent('r', raw); burst.s.finishReadout('r', () => {});
  burst.time.advance(60_000);
  assert.equal(burst.last(), raw); assert.equal(burst.paints.length, 20);
  assert.equal(burst.paints.at(-1)!.at, 19 * 650);
});

for (const mode of modes) test(`${mode.name}: the first bubble has no artificial delay, even shy and slowest`, () => {
  for (const multiplier of [undefined, 0.85, 1, 1.15]) {
    const { s, paints, last } = readout({ multiplier, shy: true, fallback: mode.fallback });
    s.readoutContent('r', '我……');
    assert.equal(last(), '我……', 'the first sentence streams as it arrives (no "……" stop in it)');
    s.readoutContent('r', '我……其实挺想你的。');
    assert.equal(last(), '我……其实挺想你的。');
    assert.ok(paints.every(paint => paint.at === 0), `painted at ${paints.map(p => p.at)}`);
  }
});

for (const mode of modes) test(`${mode.name}: a bubble's hold starts once; time spent generating counts, so a slow reply never waits on top of it`, () => {
  const { time, s, last } = readout({ fallback: mode.fallback });
  s.readoutContent('r', '第一句。');
  time.advance(2_000); // the model is slow: the second sentence arrives after the hold has passed
  s.readoutContent('r', '第一句。第二句。');
  time.advance(0); // the next tick
  assert.equal(last(), '第一句。第二句。', 'shown the moment it arrives');
  // Partly passed: only the rest of the hold is waited, and more text arriving meanwhile does not restart it.
  const partly = readout({ fallback: mode.fallback });
  partly.s.readoutContent('r', '第一句。'); partly.time.advance(400);
  partly.s.readoutContent('r', '第一句。第二');
  partly.time.advance(100); partly.s.readoutContent('r', '第一句。第二句。'); partly.s.finishReadout('r', () => {});
  partly.time.advance(149); assert.equal(partly.last(), '第一句。');
  partly.time.advance(1); assert.equal(partly.last(), '第一句。第二句。');
});

for (const mode of modes) test(`${mode.name}: cancel, clear, a new reply or hiding: no old timer paints again`, () => {
  const raw = '第一句。我……其实挺想你的。对了，明天记得带伞。';
  for (const end of ['cancel', 'clear', 'new', 'hide'] as const) {
    const { time, s, paints } = readout({ multiplier: 1.15, shy: true, fallback: mode.fallback });
    s.readoutContent('r', raw); s.finishReadout('r', () => assert.fail('an ended readout never drains'));
    time.advance(800); // inside the first hold (default) or the "……" stop (fallback)
    const before = paints.length;
    if (end === 'cancel' || end === 'hide') s.cancelReadout();
    else if (end === 'clear') s.clear();
    else { s.begin('next'); s.startReadout('next', () => {}); }
    assert.equal(time.pending(), 0, `${end}: the old timer is cleared at once, not just ignored later`);
    time.advance(30_000);
    assert.equal(paints.length, before, end);
    assert.equal(time.pending(), 0, `${end}: no timer left`);
  }
});

for (const mode of modes) test(`${mode.name}: a feed pause freezes the reveal where it is and resumes from there, without catching up`, () => {
  const { time, s, last } = readout({ fallback: mode.fallback });
  const raw = '第一句。第二句。第三句。';
  s.readoutContent('r', raw); s.finishReadout('r', () => {});
  time.advance(300); s.pause();
  time.advance(20_000); // she eats for 20 s (longer than the fallback's 4 s budget)
  assert.equal(last(), '第一句。');
  s.resume();
  time.advance(349); assert.equal(last(), '第一句。', 'the rest of the first hold, not a new one');
  time.advance(1); assert.equal(last(), '第一句。第二句。');
  time.advance(649); assert.equal(last(), '第一句。第二句。', 'still paced: no catching up after the pause');
  time.advance(1); assert.equal(last(), raw);
});

for (const mode of modes) test(`${mode.name}: the shown pieces always add up to the original, byte for byte: emoji, code, links, decimals`, () => {
  const raw = '先说好消息🎉！我查了一下……价格是 3.14 元。代码是 `a……b`。链接 https://example.com/a……b 也在。👨‍👩‍👧 一家人' + '字'.repeat(60) + '。对了，记得看。';
  for (const multiplier of [0.85, 1, 1.15]) {
    const { time, s, paints, last } = readout({ multiplier, shy: true, fallback: mode.fallback });
    const points = Array.from(raw);
    for (let at = 7; at < points.length + 7; at += 7) { s.readoutContent('r', points.slice(0, at).join('')); time.advance(120); }
    s.finishReadout('r', () => {});
    time.advance(60_000);
    assert.equal(last(), raw);
    for (const paint of paints) {
      assert.ok(raw.startsWith(paint.text));
      assert.ok(!/[\uD800-\uDBFF]$/u.test(paint.text), 'never half a surrogate pair');
      assert.ok(!/‍$/u.test(paint.text), 'never inside a combined emoji');
      assert.ok(!paint.text.endsWith('`a……'), 'never stops inside code');
      assert.ok(!paint.text.endsWith('https://example.com/a……'), 'never stops inside a link');
    }
  }
});

// ---------------------------------------------------------------- 兜底（待定）: the mechanics only, none of the numbers is final

test('兜底（待定）: later holds follow the frozen multiplier; a second cue for the same reply is ignored', () => {
  const { time, s, last } = readout({ multiplier: 1.15, fallback: true });
  assert.equal(s.setRhythm('r', { multiplier: 0.85 }), false, 'frozen: a mood change mid-reply never changes it');
  s.readoutContent('r', '第一句。第二句。'); s.finishReadout('r', () => {});
  const slow = readout({ multiplier: 1, fallback: true });
  slow.s.readoutContent('r', '第一句。第二句。'); slow.s.finishReadout('r', () => {});
  let shownAt = -1, plainAt = -1;
  for (let ms = 0; ms < 2_000 && (shownAt < 0 || plainAt < 0); ms++) {
    time.advance(1); slow.time.advance(1);
    if (shownAt < 0 && last() === '第一句。第二句。') shownAt = time.now;
    if (plainAt < 0 && slow.last() === '第一句。第二句。') plainAt = slow.time.now;
  }
  assert.ok(shownAt > plainAt, `a slower pace waits longer (${shownAt} > ${plainAt})`);
  // A cue for another reply never touches this one.
  assert.equal(s.setRhythm('other', { multiplier: 0.85 }), true);
  assert.equal(s.rhythmOf('r'), 1.15);
});

test('兜底（待定）: all waits share one budget; then the rest appears as it is, every sentence still its own bubble, nothing skipped', () => {
  const raw = Array.from({ length: 12 }, (_, i) => `这是第${i + 1}句话，说得稍微长一点点。`).join('');
  const { time, s, paints, last } = readout({ multiplier: 1.15, fallback: true });
  let drained = 0;
  s.readoutContent('r', raw); s.finishReadout('r', () => drained++);
  time.advance(60_000);
  assert.equal(last(), raw); assert.equal(drained, 1);
  assert.ok(paints.at(-1)!.at <= REPLY_RHYTHM_BUDGET_MS, `all visible by ${paints.at(-1)!.at} ms`);
  assert.equal(paints.at(-1)!.ends.length, 12, 'every sentence keeps its own bubble');
  for (let i = 1; i < paints.length; i++) assert.ok(paints[i].text.startsWith(paints[i - 1].text), 'in order, only growing');
  // A feed pause inside it costs no budget.
  const paused = readout({ fallback: true });
  paused.s.readoutContent('r', raw); paused.s.finishReadout('r', () => {});
  paused.time.advance(100); paused.s.pause(); paused.time.advance(30_000); paused.s.resume();
  paused.time.advance(60_000);
  assert.ok(paused.paints.length >= 4, 'still paced after a long pause');
});

test('兜底（待定）: "……" in a later sentence stops there for a moment; her afterthought waits a little more, once', () => {
  const stop = readout({ fallback: true });
  stop.s.readoutContent('r', '第一句。我……其实挺想你的。'); stop.s.finishReadout('r', () => {});
  stop.time.advance(650); assert.equal(stop.last(), '第一句。我……');
  stop.time.advance(10_000); assert.equal(stop.last(), '第一句。我……其实挺想你的。');
  // Paused inside the stop: it resumes the stop, then the rest.
  const pausedStop = readout({ fallback: true });
  pausedStop.s.readoutContent('r', '第一句。我……其实挺想你的。'); pausedStop.s.finishReadout('r', () => {});
  pausedStop.time.advance(700); pausedStop.s.pause(); pausedStop.time.advance(5_000); pausedStop.s.resume();
  assert.equal(pausedStop.last(), '第一句。我……');
  pausedStop.time.advance(10_000); assert.equal(pausedStop.last(), '第一句。我……其实挺想你的。');
  const after = readout({ fallback: true });
  const raw = '第一句。第二句。对了，明天记得带伞。还有啊，别熬夜。';
  after.s.readoutContent('r', raw); after.s.finishReadout('r', () => {});
  after.time.advance(1_300); assert.equal(after.last(), '第一句。第二句。', 'the usual hold has passed, the afterthought waits more');
  after.time.advance(10_000); assert.equal(after.last(), raw);
  const gaps = after.paints.slice(1).map((paint, i) => paint.at - after.paints[i].at);
  assert.ok(gaps[1] > gaps[2], 'only the first afterthought gets the extra wait');
  assert.ok(after.paints.every(paint => raw.startsWith(paint.text)), 'only her original text, in order');
});
