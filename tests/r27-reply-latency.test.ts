import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ReplyLatencyProbe, type ReplyLatencyRecord } from '../electron/reply-latency';

function fixture(enabled = true, file: string | null = null) {
  let now = 0, wall = 1_800_000_000_000;
  const timers = new Map<number, () => void>(); let next = 0;
  const lines: string[] = [], writes: Array<[string, string]> = [], observers: unknown[] = [];
  const surface = { setObserver: (observer: unknown) => observers.push(observer) };
  const probe = new ReplyLatencyProbe({ enabled: () => enabled, file: () => file, surface: () => surface, now: () => now, wallNow: () => wall,
    log: line => lines.push(line), write: async (target, line) => { writes.push([target, line]); }, settleMs: 15000,
    timers: { set: callback => { timers.set(++next, callback); return next; }, clear: handle => { timers.delete(handle as number); } } });
  return { probe, lines, writes, observers,
    at(ms: number) { now = ms; }, wall: () => wall,
    fireTimers() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } },
    records: () => lines.map(line => JSON.parse(line) as ReplyLatencyRecord) };
}

test('R27 latency: records send→first provider content and send→first visible text separately, without any text', () => {
  const f = fixture(true, '/profile/dev/reply-latency.jsonl');
  f.at(0); f.probe.begin('r1', 'claude', f.wall() - 40);
  assert.deepEqual(f.observers, [f.probe], 'the probe observes the current native bubble');
  f.at(1200); f.probe.delta('r1', '第一');
  f.at(1210); f.probe.rendered('第一'); f.at(1240); f.probe.painted('第一');
  f.at(1300); f.probe.delta('r1', '句。');
  f.at(1310); f.probe.rendered('第一句。'); f.at(1340); f.probe.painted('第一句。');
  f.probe.painted('主动视觉评论。'); // another surface text is never credited to this reply
  f.at(1400); f.probe.delta('r1', '第二句。');
  f.at(1500); f.probe.complete('r1'); f.probe.end('r1', false);
  assert.equal(f.lines.length, 0, 'still waiting for the paced readout to show everything');
  f.at(2200); f.probe.painted('第一句。第二句。');
  const [record] = f.records();
  assert.deepEqual({ ...record, at: undefined }, { at: undefined, provider: 'claude', status: 'complete', origin: 'renderer-send', sendToHostMs: 40,
    firstContentMs: 1240, firstSentenceContentMs: 1340, firstBubbleMs: 1250, firstVisibleMs: 1280, firstSentenceVisibleMs: 1380,
    streamEndMs: 1540, allVisibleMs: 2240, chars: 8, deltas: 3 });
  assert.doesNotMatch(f.lines[0], /第|句|r1/u, 'no reply text or request id is logged');
  assert.deepEqual(f.writes, [['/profile/dev/reply-latency.jsonl', f.lines[0] + '\n']]);
  assert.equal(f.probe.recent().length, 1);
});

test('R27 latency: off outside developer mode; stop, supersede and an unpainted reply still settle once', () => {
  const off = fixture(false);
  off.probe.begin('r', 'claude'); off.probe.delta('r', '你好。'); off.probe.complete('r'); off.probe.end('r', false); off.fireTimers();
  assert.equal(off.lines.length, 0); assert.equal(off.observers.length, 0);

  const f = fixture();
  f.at(0); f.probe.begin('a', 'claude');
  f.at(900); f.probe.delta('a', '旧回复');
  f.at(1000); f.probe.begin('b', 'claude');
  f.at(1500); f.probe.delta('b', '新回复没有句号');
  f.at(1600); f.probe.end('b', true);
  f.fireTimers(); f.fireTimers();
  const [superseded, stopped] = f.records();
  assert.equal(superseded.status, 'superseded'); assert.equal(superseded.origin, 'host-receipt'); assert.equal(superseded.firstContentMs, 900);
  assert.equal(stopped.status, 'stopped'); assert.equal(stopped.firstVisibleMs, null); assert.equal(stopped.allVisibleMs, null);
  assert.equal(stopped.firstSentenceContentMs, null, 'a stopped fragment never claims a complete sentence');
  f.probe.delta('b', 'late'); f.probe.painted('新回复没有句号'); f.fireTimers();
  assert.equal(f.records().length, 2, 'each reply is recorded exactly once');

  const whole = fixture();
  whole.at(0); whole.probe.begin('w', 'claude');
  whole.at(800); whole.probe.delta('w', 'Hello there');
  whole.at(900); whole.probe.complete('w'); whole.probe.end('w', false);
  whole.at(950); whole.probe.painted('Hello there');
  assert.equal(whole.records()[0].firstSentenceContentMs, 900, 'an unpunctuated reply completes its first sentence at the end');
  assert.equal(whole.records()[0].firstSentenceVisibleMs, 950);
});

test('R27 latency: the default writer keeps a bounded JSON-lines log in the given folder', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-latency-'));
  try {
    const file = path.join(directory, 'dev', 'reply-latency.jsonl');
    const probe = new ReplyLatencyProbe({ enabled: () => true, file: () => file, log: () => {} });
    probe.begin('x', 'claude'); probe.delta('x', '好。'); probe.complete('x'); probe.end('x', false); probe.painted('好。');
    for (let attempt = 0; attempt < 50; attempt++) { try { if ((await readFile(file, 'utf8')).trim()) break; } catch { /* not yet */ } await new Promise(resolve => setTimeout(resolve, 10)); }
    const [line] = (await readFile(file, 'utf8')).trim().split('\n');
    assert.equal(JSON.parse(line).status, 'complete');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
