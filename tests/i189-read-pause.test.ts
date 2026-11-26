/**
 * I-189 #1: her reading pauses where a sentence ends while you are turned away or gone (sure, held 2 s),
 * goes on when you face the screen, ends quietly if you stay away; never on one low-confidence frame; 'unsure' lets her go on; feeding and
 * the away pause share one pause. Plus the window-side attention store and the moments host taking pose facts through its gate.
 * Fake clocks, timers and targets; synthetic pose signals end to end through the host's tracker.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { EMPTY_POSE_SIGNAL, type PoseSignal } from '../shared/senses/pose-signals';
import { AttentionTracker, type UserAttention } from '../shared/behaviors/pose-uses/attention';
import { POSE_USES_KNOBS } from '../shared/behaviors/pose-uses/knobs';
import { AwayReadPause, type AwayReadEvent } from '../src/voice/away-read-pause';
import { SharedPause } from '../src/voice/shared-pause';
import { UserAttentionStore } from '../src/senses/user-attention';
import { MomentHost, type MomentJournalRow } from '../electron/initiative/moments/host';
import { MomentStateStore } from '../electron/initiative/moments/state-store';
import { eveningNightKey } from '../shared/behaviors/moments/bedtime';

const sig = (over: Partial<PoseSignal> = {}): PoseSignal => ({ ...EMPTY_POSE_SIGNAL, present: true, confidence: 0.9, facing: 'toward', facingConfidence: 0.8, posture: 'sitting', postureConfidence: 0.8, energy: 0.1, people: 1, ...over });

class Timers {
  now = 0; private next = 1; private due = new Map<number, { at: number; run: () => void }>();
  set = (run: () => void, ms: number): unknown => { const id = this.next++; this.due.set(id, { at: this.now + ms, run }); return id; };
  clear = (id: unknown): void => { this.due.delete(id as number); };
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const first = [...this.due.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) break;
      this.due.delete(first[0]); this.now = Math.max(this.now, first[1].at); first[1].run();
    }
    this.now = end;
  }
}

/** Her voice and her bubble as targets; the tracker fed by synthetic signals (5 per second) is the host's, read as the windows read it. */
function rig() {
  const timers = new Timers(), tracker = new AttentionTracker();
  const log: string[] = [], facts: { event: AwayReadEvent; seconds?: number }[] = [], ended: string[] = [];
  const voice = { pause: () => log.push('voice-pause'), resume: () => log.push('voice-resume') };
  const bubble = { pause: () => log.push('bubble-pause'), resume: () => log.push('bubble-resume') };
  const shared = new SharedPause([voice, bubble]);
  let reading: string | null = 'r1';
  const pause = new AwayReadPause({ pause: shared.as('away'), attention: () => tracker.read(timers.now), reading: () => reading,
    end: id => { ended.push(id); reading = null; }, now: () => timers.now, timers, fact: (event, seconds) => facts.push({ event, ...(seconds !== undefined ? { seconds } : {}) }) });
  const feed = (s: PoseSignal, ms: number) => { for (let t = 0; t < ms; t += 200) { tracker.note(s, timers.now); timers.advance(200); pause.check(); } };
  return { timers, tracker, log, facts, ended, shared, pause, feed, setReading: (id: string | null) => { reading = id; } };
}
const end = (id = 'r1', segmentIndex = 0) => ({ replyId: id, segmentIndex, phase: 'end' as const });

test('#1 turned away (sure, 2 s): her reading pauses at the next sentence end; facing the screen again, it goes on after a beat', () => {
  const r = rig();
  r.feed(sig(), 2_000);
  r.pause.segment(end());
  assert.deepEqual(r.log, [], 'facing her: nothing pauses');
  r.feed(sig({ facing: 'away', facingConfidence: 0.9 }), 1_000);
  r.pause.segment(end('r1', 1));
  assert.deepEqual(r.log, [], 'only 1 s turned: not yet');
  r.feed(sig({ facing: 'away', facingConfidence: 0.9 }), 1_400);
  assert.deepEqual(r.log, [], 'turned long enough, but mid-sentence: she finishes the sentence first');
  r.pause.segment(end('r1', 2));
  assert.deepEqual(r.log, ['voice-pause', 'bubble-pause'], 'at the sentence end: voice and bubble pause together (the bubble stays as it is)');
  r.feed(sig({ facing: 'away', facingConfidence: 0.9 }), 10_000);
  assert.equal(r.log.length, 2, 'still away: still paused');
  r.feed(sig(), 200);
  assert.equal(r.log.length, 2, 'not at once');
  r.feed(sig(), POSE_USES_KNOBS.readPause.resumeDelayMs + 200);
  assert.deepEqual(r.log.slice(2), ['voice-resume', 'bubble-resume']);
  assert.deepEqual(r.facts.map(f => f.event), ['paused', 'resumed']);
  assert.ok((r.facts[1].seconds ?? 0) >= 10);
});

test('#1 a single low-confidence frame (or one sure frame) never pauses her reading', () => {
  const r = rig();
  r.feed(sig(), 2_000);
  r.feed(sig({ facing: 'away', facingConfidence: 0.15 }), 200);
  r.pause.segment(end());
  r.feed(sig({ facing: 'side', facingConfidence: 0.3 }), 3_000); // blurry for 3 s: still not sure
  r.pause.segment(end('r1', 1));
  r.feed(sig(), 400);
  r.feed(sig({ facing: 'away', facingConfidence: 0.95 }), 200);
  r.pause.segment(end('r1', 2));
  assert.deepEqual(r.log, [], 'nothing paused');
  assert.equal(r.pause.counts.paused, 0);
});

test('#1 walked out of the frame: pauses the same way; staying away ends the reading quietly, the rest unread', () => {
  const r = rig();
  r.feed(sig(), 1_000);
  for (let t = 0; t < 4_000; t += 2_000) { r.tracker.note(sig({ present: false, facing: 'unknown', facingConfidence: 0 }), r.timers.now); r.timers.advance(2_000); }
  r.pause.segment(end());
  assert.deepEqual(r.log, ['voice-pause', 'bubble-pause']);
  for (let t = 0; t < (POSE_USES_KNOBS.readPause.endAfterSeconds + 2) * 1000; t += 2_000) { r.tracker.note(sig({ present: false, facing: 'unknown', facingConfidence: 0 }), r.timers.now); r.timers.advance(2_000); r.pause.check(); }
  assert.deepEqual(r.ended, ['r1'], 'ended (the window stops the voice, shows the rest of her bubble)');
  assert.deepEqual(r.log.slice(2), ['voice-resume', 'bubble-resume'], 'and lets go of the pause, so the next reading is not held');
  assert.deepEqual(r.facts.map(f => f.event), ['paused', 'ended']);
  assert.equal(r.facts[1].seconds, POSE_USES_KNOBS.readPause.endAfterSeconds);
});

test('#1 not knowing never keeps her quiet: sensing off (unsure) or nothing left to read lets go; a stop cancels', () => {
  const off = rig();
  off.feed(sig({ facing: 'away', facingConfidence: 0.9 }), 2_400);
  off.pause.segment(end());
  assert.equal(off.pause.active, true);
  off.timers.advance(4_000); off.pause.check(); // no signal for 4 s
  off.timers.advance(POSE_USES_KNOBS.readPause.resumeDelayMs + 10);
  assert.equal(off.pause.active, false);
  assert.deepEqual(off.log.slice(2), ['voice-resume', 'bubble-resume']);

  const done = rig();
  done.feed(sig({ facing: 'away', facingConfidence: 0.9 }), 2_400);
  done.pause.segment(end());
  done.setReading(null); // that was her last sentence: the queue ended
  done.feed(sig({ facing: 'away', facingConfidence: 0.9 }), 400);
  assert.equal(done.pause.active, false);
  assert.deepEqual(done.facts.map(f => f.event), ['paused'], 'nothing unheard: no "ended"');

  const stop = rig();
  stop.feed(sig({ facing: 'away', facingConfidence: 0.9 }), 2_400);
  stop.pause.segment(end());
  stop.pause.cancel();
  assert.equal(stop.pause.active, false);
  assert.deepEqual(stop.log.slice(2), ['voice-resume', 'bubble-resume']);
  stop.timers.advance(200_000);
  assert.deepEqual(stop.ended, [], 'a cancelled pause never ends anything later');

  const other = rig();
  other.feed(sig({ facing: 'away', facingConfidence: 0.9 }), 2_400);
  other.pause.segment(end('older'));
  assert.equal(other.pause.active, false, 'a sentence of a reply no longer read here');
});

test('feeding and the away pause share one pause: neither owner\'s resume talks over the other\'s', () => {
  const log: string[] = [];
  const shared = new SharedPause([{ pause: release => log.push(`pause${release ? '+release' : ''}`), resume: () => log.push('resume') }]);
  const feed = shared.as('feed'), away = shared.as('away');
  away.pause();
  feed.pause(true);
  feed.resume();
  assert.deepEqual(log, ['pause'], 'feeding is over but you are still away: she stays paused');
  away.resume();
  assert.deepEqual(log, ['pause', 'resume']);
  feed.pause(true); feed.pause(true);
  assert.deepEqual(log.slice(2), ['pause+release'], 'one hold per owner');
});

test('the window store: the companion window posts changes (and about once a second); the control window counts on; stale is nothing', () => {
  let now = 0;
  const posts: unknown[] = [];
  const companion = new UserAttentionStore(() => now, message => posts.push(message));
  const controls = new UserAttentionStore(() => now);
  const reading = (attention?: UserAttention) => ({ present: true, facing: 'side', energy: 0, point: null, screen: null, ...(attention ? { attention } : {}) });
  companion.fromGaze(reading({ state: 'turned', forMs: 700 }));
  assert.equal(posts.length, 1);
  controls.receive(posts[0]);
  now += 300;
  companion.fromGaze(reading({ state: 'turned', forMs: 1000 }));
  assert.equal(posts.length, 1, 'no change: no post');
  assert.deepEqual(controls.current(), { state: 'turned', forMs: 1000 });
  assert.equal(controls.turned(), true);
  now += 1_000;
  companion.fromGaze(reading({ state: 'turned', forMs: 2000 }));
  assert.equal(posts.length, 2, 'a heartbeat');
  companion.fromGaze(reading());
  assert.deepEqual(posts.at(-1), { attention: null }, 'not known any more');
  controls.receive(posts.at(-1));
  assert.equal(controls.current(), null);
  companion.fromGaze(reading({ state: 'gone', forMs: 5000 }));
  now += 4_000;
  assert.equal(companion.current(), null, 'stale');
  controls.receive({ attention: { state: 'turned', forMs: 1, picture: 'x' } });
  assert.equal(controls.current(), null, 'a malformed message is nothing');
});

test('the moments host takes a pose fact only when no other moment is waiting, through the same gate', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sh-i189-'));
  try {
    let now = new Date(2026, 10, 22, 15, 0).getTime(), typing = true, serial = 0;
    const journal: MomentJournalRow[] = [], asks: string[] = [];
    let fact: { kind: 'sitting'; facts: { minutes: number } } | null = { kind: 'sitting', facts: { minutes: 95 } };
    const state = new MomentStateStore(() => path.join(dir, 'moments-state.json'));
    await state.load();
    const minute = (ms: number) => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); };
    const host: MomentHost = new MomentHost({ clock: () => now, random: () => 0.99, createId: () => `m${++serial}`, characterId: () => 'gene', localMinute: minute, enabled: () => true,
      typing: () => typing, call: () => false, asleep: () => false, visible: () => true, presence: () => null, idleSeconds: () => 5, lastInteractionAt: () => now - 3_600_000,
      nightKey: n => eveningNightKey(n, minute(n)), restUsed: () => false, state,
      askSpeech: () => { asks.push('ask'); const cue = { id: `cue${asks.length}`, kind: 'speech' }; host.claims(cue)?.put('inner'); return true; },
      pose: () => { const f = fact; fact = null; return f; }, journal: row => { journal.push(row); } });
    state.remember('first-today', '2026-11-22'); // today's first meeting already happened
    host.tick();
    assert.equal(host.view()?.kind, 'sitting');
    assert.deepEqual(asks, [], 'typing: the gate holds it');
    assert.equal(host.view()?.why, 'typing');
    typing = false; now += 16_000;
    host.tick();
    assert.deepEqual(asks, ['ask']);
    assert.equal(host.promptLine('gene'), '摄像头本机看到：用户已经连续坐了约 95 分钟没起身。');
    host.done('cue1', true);
    assert.deepEqual(journal.at(-1), { characterId: 'gene', kind: 'sitting', outcome: 'spoke' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
