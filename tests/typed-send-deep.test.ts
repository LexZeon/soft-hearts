// 2026-11-23.
// The world (tests/helpers/typed-send-world.ts) runs the real box, ledger, gate, control-window send and sendChat on one fake clock, with the
// hidden control window throttled as measured, voice capture streaming into a busy main process. `fixed: false` is the same world without
// today's three changes (no lifting, no line number in the request, a save every time): the way it was this morning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { typedSendWorld, type LineRecord } from './helpers/typed-send-world';
import { HANDED_LINE_REFUSED, SEND_DROP_HINT, SEND_DROP_KNOBS } from '../shared/brain';
import { admitHandedLine, setHandedLineGate } from '../electron/brain/handed-line-gate';
import { UnboundSayAcks } from '../electron/unbound/say-ack';
import { createControlAwake, lineAwake } from '../electron/unbound/control-awake';
import { validateChatRequest } from '../electron/settings/validation';
import { sameValue } from '../src/brain/send-guard';
import { chatWorld, settle, tick } from './helpers/chat-world';

const startMs = (line: LineRecord) => line.accepted.length ? line.accepted[0] - line.enter : null;
const report = (lines: LineRecord[]) => lines.map(l => `${l.text}: start ${startMs(l)} ms, sent ${l.accepted.length}x, answered ${l.answers}x, back in box ${l.refilled}x, said ${l.said}x`).join(' | ');

test('full-screen box, voice capture on, busy main, control window hidden: three lines in a row each start within 1 s, once, answered once, never "没发出去"', async t => {
  for (const gap of [6_000, 2_000]) { // after her answer, and while she is still answering (the stop path)
    const w = typedSendWorld({ fixed: true });
    const lines = [w.typeInBox('第一句')];
    await w.clock.runUntil(gap); lines.push(w.typeInBox('第二句'));
    await w.clock.runUntil(2 * gap); lines.push(w.typeInBox('第三句'));
    await w.clock.runUntil(2 * gap + 60_000);
    t.diagnostic(`fixed, gap ${gap}: ${report(lines)}`);
    for (const line of lines) {
      assert.equal(line.accepted.length, 1, `${line.text}: sent exactly once`);
      assert.ok(startMs(line)! <= 1_000, `${line.text}: the request starts within 1 s (${startMs(line)} ms)`);
      assert.equal(line.refilled, 0, `${line.text}: never put back`); assert.deepEqual(line.hints, [], `${line.text}: never "没发出去"`);
      assert.equal(line.said, 1, `${line.text}: shown near her once`);
    }
    assert.equal(lines[2].answers, 1, 'the last line answered once');
    if (gap > 4_000) for (const line of lines) assert.equal(line.answers, 1, `${line.text}: answered once`);
    assert.deepEqual(w.journal, [], 'no drop journaled: nothing was dropped');
    assert.ok(w.chunks() > 100, 'the capture streamed the whole time');
    assert.deepEqual(w.throttleCalls.filter((v, i, a) => i === 0 || v !== a[i - 1]), w.throttleCalls, 'lifted and put back, never twice in a row');
    assert.equal(w.throttleCalls.at(-1), true, 'the control window is throttled again once no line is open');
    assert.equal(w.acks.pending, 0);
    w.done();
  }
});

test('before the fix, the same morning: lines wait 20 s and more, the box says "没发出去" and the line goes out afterwards', async t => {
  const w = typedSendWorld({ fixed: false });
  const first = w.typeInBox('8点43这句');
  await w.clock.runUntil(SEND_DROP_KNOBS.unboundAckGiveUpMs + 1_000);
  const second = w.typeInBox('8点43这句'); // the box gave it back: she presses Enter again
  await w.clock.runUntil(120_000);
  t.diagnostic(`before: ${report([first, second])}; journal ${JSON.stringify(w.journal)}`);
  assert.ok(first.refilled === 1, 'the box gave the line back with "没发出去"');
  const went = [first, second].filter(l => l.accepted.length);
  assert.ok(went.length >= 1 && went.every(l => startMs(l)! > SEND_DROP_KNOBS.unboundAckGiveUpMs), 'the text went out, more than 20 s after its Enter');
  assert.ok(went.some(l => l.refilled === 1), 'a line that went out was also given back as "没发出去" (the morning\'s false failure)');
  w.done();
});

test('a control window that cannot be woken: the host takes the line back at the give-up (truly: refused when it comes), says so once, and a second Enter sends it once', async t => {
  // The second Enter comes before the first reaches the window (both arrive together), or after it reached the host and was refused.
  for (const again of [21_000, 30_000]) {
    const w = typedSendWorld({ fixed: true, stallUntil: 25_000 });
    const first = w.typeInBox('还在吗');
    await w.clock.runUntil(SEND_DROP_KNOBS.unboundAckGiveUpMs + 500);
    assert.equal(first.refilled, 1, 'given back once, with the hint'); assert.deepEqual(w.opened.at(-1), { text: '还在吗', hint: SEND_DROP_HINT });
    assert.deepEqual(w.journal.map(f => f.why), ['no-ack']);
    await w.clock.runUntil(again);
    const second = w.typeInBox('还在吗');
    await w.clock.runUntil(120_000);
    t.diagnostic(`stalled, Enter again at ${again}: ${report([first, second])}; journal ${JSON.stringify(w.journal)}`);
    assert.equal(first.accepted.length, 0, 'the taken-back line never went out');
    assert.equal(second.accepted.length, 1, 'the second Enter went, once'); assert.ok(startMs(second)! <= Math.max(0, 25_000 - again) + 1_000, 'as soon as the window can take it');
    if (again > 25_000) {
      assert.deepEqual(w.journal.map(f => f.why), ['no-ack', 'late'], 'the first reached the host after it was taken back: refused, one line');
      assert.ok(w.journal[1].waitMs >= 25_000);
    } else assert.deepEqual(w.journal.map(f => f.why), ['no-ack'], 'the first never reached the host (the second stopped it in the window)');
    assert.equal(first.refilled, 1, 'never given back twice'); assert.equal(first.said, 0, 'never shown as said');
    assert.equal(second.said, 1); assert.equal(second.answers, 1);
    w.done();
  }
});

test('her small window, voice capture on, busy main: the line starts within 1 s (no save that changes nothing, the typing note not awaited)', async t => {
  for (const fixed of [true, false]) {
    const w = typedSendWorld({ fixed });
    const line = w.typeInSmall('小窗里打的');
    await w.clock.runUntil(30_000);
    t.diagnostic(`${fixed ? 'fixed' : 'before'}: ${report([line])}`);
    assert.equal(line.accepted.length, 1); assert.equal(line.answers, 1);
    if (fixed) assert.ok(startMs(line)! <= 1_000, `${startMs(line)} ms`);
    else assert.ok(startMs(line)! >= SEND_DROP_KNOBS.saveWaitMs, 'before: the save behind the capture held it to the cap');
    w.done();
  }
});

test('the gate: a numbered request goes only while its line is open; taken back, unknown or without a ledger it is refused; a malformed number is refused', () => {
  let now = 0; const timers = new Map<number, () => void>(); let n = 0; const journal: string[] = [];
  const acks = new UnboundSayAcks({ now: () => now, setTimer: run => { timers.set(++n, run); return n; }, clearTimer: id => { timers.delete(id as number); }, journal: f => { journal.push(f.why); } });
  setHandedLineGate(acks);
  try {
    const ended: string[] = [];
    const a = acks.start(h => { ended.push(h === 'sent' ? 'sent' : h.dropped); });
    const sent = admitHandedLine(a.line); assert.ok(sent); sent!();
    assert.deepEqual(ended, ['sent'], 'accepted: sent, once');
    assert.throws(() => admitHandedLine(a.line), new RegExp(HANDED_LINE_REFUSED), 'never twice');
    const b = acks.start(h => { ended.push(h === 'sent' ? 'sent' : h.dropped); });
    now = 20_000; [...timers.values()].at(-1)!();
    assert.deepEqual(ended, ['sent', 'no-ack']);
    assert.throws(() => admitHandedLine(b.line), new RegExp(HANDED_LINE_REFUSED), 'taken back: refused');
    assert.deepEqual(journal, ['no-ack', 'late']);
    assert.throws(() => admitHandedLine(b.line), new RegExp(HANDED_LINE_REFUSED)); assert.deepEqual(journal, ['no-ack', 'late'], 'late is written once');
    assert.throws(() => admitHandedLine(999), new RegExp(HANDED_LINE_REFUSED), 'a number nobody handed out');
    assert.equal(admitHandedLine(undefined), null, 'an ordinary chat box line is not touched');
    setHandedLineGate(null);
    const c = acks.start(() => {});
    assert.throws(() => admitHandedLine(c.line), new RegExp(HANDED_LINE_REFUSED), 'no ledger: refused');
  } finally { setHandedLineGate(null); }
  const base = { id: 'r1', messages: [{ role: 'user', content: '你好' }], attachments: [] };
  assert.equal(validateChatRequest({ ...base, line: 3 }).line, 3);
  assert.equal(validateChatRequest(base).line, undefined);
  for (const bad of [0, -1, 1.5, '3', null, Number.MAX_SAFE_INTEGER + 2]) assert.throws(() => validateChatRequest({ ...base, line: bad }), /消息编号不正确/);
});

test('the wiring\'s own chat handler asks the gate first: an open line reaches her and is sent; a taken-back one never reaches her', async () => {
  let now = 0; const timers = new Map<number, () => void>(); let n = 0;
  const acks = new UnboundSayAcks({ now: () => now, setTimer: run => { timers.set(++n, run); return n; }, clearTimer: id => { timers.delete(id as number); }, journal: () => {} });
  setHandedLineGate(acks);
  try {
    const w = chatWorld();
    const ended: string[] = [];
    const open = acks.start(h => { ended.push(h === 'sent' ? 'sent' : h.dropped); });
    w.chat(1, { id: 'r1', messages: [{ role: 'user', content: '开着的这句' }], sentAt: 1, line: open.line });
    await settle(() => w.settled('r1'), 'the turn ran');
    assert.deepEqual(w.begins, ['开着的这句']); assert.deepEqual(ended, ['sent'], 'accepted: the line is sent');
    const late = acks.start(h => { ended.push(h === 'sent' ? 'sent' : h.dropped); });
    now = 20_000; [...timers.values()].at(-1)!();
    assert.throws(() => w.chat(1, { id: 'r2', messages: [{ role: 'user', content: '收回的这句' }], sentAt: 1, line: late.line }), new RegExp(HANDED_LINE_REFUSED));
    await tick();
    assert.deepEqual(w.begins, ['开着的这句'], 'the taken-back line never reached her'); assert.equal(w.pending.size, 0, 'no task left behind');
    w.send('r3', '普通的一句'); await settle(() => w.settled('r3'), 'an ordinary line');
    assert.deepEqual(w.begins, ['开着的这句', '普通的一句'], 'a line without a number is not touched');
  } finally { setHandedLineGate(null); }
});

test('the control window is woken only while a line is open (and put back after); a destroyed window is left alone', () => {
  const calls: boolean[] = []; let destroyed = false;
  const awake = lineAwake(createControlAwake(() => ({ isDestroyed: () => destroyed, webContents: { setBackgroundThrottling: (allowed: boolean) => { calls.push(allowed); } } })));
  let n = 0; const timers = new Map<number, () => void>();
  const acks = new UnboundSayAcks({ now: () => 0, setTimer: run => { timers.set(++n, run); return n; }, clearTimer: id => { timers.delete(id as number); }, journal: () => {}, awake });
  const a = acks.start(() => {}), b = acks.start(() => {});
  assert.deepEqual(calls, [false], 'lifted once for the first open line');
  acks.sent(a.line); assert.deepEqual(calls, [false], 'still one open');
  acks.ack({ line: b.line, result: 'dropped', why: 'busy' }); assert.deepEqual(calls, [false, true], 'put back when none is open');
  const c = acks.start(() => {}); acks.forget(c.line); assert.deepEqual(calls, [false, true, false, true]);
  destroyed = true; acks.start(() => {}); assert.equal(calls.length, 4);
});

test('a save that would change nothing is skipped: settings compared whatever the key order', () => {
  assert.ok(sameValue({ a: 1, b: { c: [1, 2, { d: 'x' }] } }, { b: { c: [1, 2, { d: 'x' }] }, a: 1 }));
  assert.ok(sameValue({ a: 1, gone: undefined }, { a: 1 }));
  assert.ok(!sameValue({ a: 1 }, { a: 2 })); assert.ok(!sameValue([1, 2], [2, 1])); assert.ok(!sameValue({ a: [] }, { a: {} }));
  assert.ok(!sameValue({ a: 1 }, { a: 1, b: 2 })); assert.ok(!sameValue(null, {})); assert.ok(sameValue(NaN, NaN));
});
