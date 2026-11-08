import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { ReplyPresentationState, type ReadoutClock } from '../src/ui/reply-presentation';

function fakeClock() {
  let now = 0, next = 0; const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: ReadoutClock = { now: () => now, set: (fn, delay) => { const id = ++next; timers.set(id, { at: now + delay, fn }); return id as unknown as ReturnType<typeof setTimeout>; }, clear: id => { timers.delete(id as unknown as number); } };
  return { clock, advance(ms: number) { const end = now + ms; for (;;) { const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; timers.delete(due[0]); now = due[1].at; due[1].fn(); } now = end; } };
}

test('R27: a long first sentence is visible as it streams instead of stalling on a 48-character page', () => {
  const time = fakeClock(), s = new ReplyPresentationState(time.clock), paint: string[] = [];
  s.begin('a'); s.startReadout('a', p => paint.push(p));
  const first = '今天下班路上看到晚霞的时候我突然想到你，就想问问你最近是不是也一直在加班到很晚，晚饭和夜宵有没有好好吃呀？';
  assert.ok(first.length > 48);
  let raw = '';
  for (const chunk of first.match(/.{1,6}/gu)!) { raw += chunk; s.readoutContent('a', raw); }
  // Every streamed chunk of the first sentence is painted at once, with no clock advance.
  assert.equal(paint.at(-1), first);
  s.readoutContent('a', first + '第二句。');
  assert.equal(paint.at(-1), first, 'later sentences keep their readable hold');
  time.advance(4000); assert.equal(paint.at(-1), first + '第二句。');
});

test('R27: each paint reports the stable sentence ends inside the visible prefix', () => {
  const time = fakeClock(), s = new ReplyPresentationState(time.clock), seen: Array<[string, readonly number[]]> = [];
  s.begin('a'); s.startReadout('a', (prefix, _raw, ends) => seen.push([prefix, [...ends]]));
  s.readoutContent('a', '第一'); s.readoutContent('a', '第一句。'); s.readoutContent('a', '第一句。第二句。');
  s.finishReadout('a', () => {}); time.advance(4000);
  assert.deepEqual(seen, [['第一', []], ['第一句。', [4]], ['第一句。第二句。', [4, 8]]]);
  for (const [prefix, ends] of seen) assert.ok(ends.every(end => end > 0 && end <= prefix.length));
});

test('R27: a whitespace-only tail joins the last sentence instead of waiting its own hold', () => {
  const time = fakeClock(), s = new ReplyPresentationState(time.clock), paint: string[] = [];
  let drained = 0;
  s.begin('a'); s.startReadout('a', p => paint.push(p));
  s.readoutContent('a', '第一句。'); s.readoutContent('a', '第一句。第二句。'); s.readoutContent('a', '第一句。第二句。\n');
  s.finishReadout('a', () => drained++);
  time.advance(650); // only the first sentence's own readable hold
  assert.equal(paint.at(-1), '第一句。第二句。\n');
  assert.equal(drained, 1, 'the readout completes without an extra hold for the trailing newline');
});
