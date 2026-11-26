/**
 * I-187 陪看深度修: the system-audio blocks keep their audio-clock time (src/senses/audio-frame-clock.ts), so a busy companion window that
 * delivers them late no longer makes the clip cutter (src/senses/ambient-audio-segments.ts) throw away the dialogue it was building.
 * Synthetic: 48 kHz, 4096-sample blocks (the ScriptProcessor's), a continuous sound (dialogue over a score: no 0.55 s silence), and
 * main-thread stalls that hold the callbacks and then deliver the queued blocks back to back. Counts the clips that reach the host,
 * stamped the old way (delivery time) and the new way (the clock), over 60 s.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AmbientAudioSegments } from '../src/senses/ambient-audio-segments';
import { AudioFrameClock } from '../src/senses/audio-frame-clock';

const RATE = 48_000, BLOCK = 4096, BLOCK_MS = BLOCK / RATE * 1000;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

/** When each block is delivered: on time (a block after it ends, plus `jitter`), or held until the stall it falls in ends. */
function deliveries(seconds: number, stall: { everyMs: number; forMs: number } | null): number[] {
  const out: number[] = [];
  let last = 0;
  for (let i = 0; (i + 1) * BLOCK_MS <= seconds * 1000; i++) {
    let at = (i + 1) * BLOCK_MS + 2;
    if (stall) { const phase = at % stall.everyMs; if (phase < stall.forMs) at += stall.forMs - phase; }
    at = Math.max(at, last + 0.05); // back to back after a stall
    out.push(at); last = at;
  }
  return out;
}

async function clips(seconds: number, stall: { everyMs: number; forMs: number } | null, stamp: 'delivery' | 'clock'): Promise<number> {
  let now = 0, sent = 0;
  const segments = new AmbientAudioSegments({ onSegment: async () => { sent++; return true; }, now: () => now });
  segments.start('watch', 'movie', 0);
  const clock = new AudioFrameClock();
  const block = new Float32Array(BLOCK).map((_, i) => 0.08 * Math.sin(i / 7)); // steady sound, well over the 0.008 threshold
  const times = deliveries(seconds, stall);
  for (let i = 0; i < times.length; i++) {
    now = times[i]!;
    const playbackTime = (i * BLOCK_MS + 120) / 1000; // the audio clock: one block per block, an output latency ahead
    segments.push(block, RATE, stamp === 'delivery' ? now : clock.frameEnd(playbackTime, BLOCK, RATE, now));
    await flush();
  }
  segments.dispose();
  return sent;
}

test('a busy window no longer throws away the dialogue clip it was building (60 s, measured before and after)', async () => {
  const cases = [
    { name: 'no stalls', stall: null },
    { name: '400 ms stall every 3 s', stall: { everyMs: 3000, forMs: 400 } },
    { name: '350 ms stall every 8 s', stall: { everyMs: 8000, forMs: 350 } },
    { name: '600 ms stall every 5 s', stall: { everyMs: 5000, forMs: 600 } },
  ];
  const results: Record<string, { before: number; after: number }> = {};
  for (const item of cases) results[item.name] = { before: await clips(60, item.stall, 'delivery'), after: await clips(60, item.stall, 'clock') };
  console.log('I-187 clips reaching the host in 60 s (before → after):', JSON.stringify(results));
  // A 12 s clip at most: 60 s of continuous sound is 4 full clips (the fifth is still being built at the end).
  assert.equal(results['no stalls']!.before, results['no stalls']!.after, 'without stalls nothing changes');
  assert.ok(results['no stalls']!.after >= 4);
  for (const name of ['400 ms stall every 3 s', '350 ms stall every 8 s', '600 ms stall every 5 s']) {
    assert.ok(results[name]!.before < results['no stalls']!.after, `${name}: the old stamps lost clips (${results[name]!.before})`);
    assert.equal(results[name]!.after, results['no stalls']!.after, `${name}: the clock keeps every clip`);
  }
});

test('the clock still shows a real hole, falls back to delivery time without an audio clock, and only moves forward', () => {
  const clock = new AudioFrameClock();
  const first = clock.frameEnd(0, BLOCK, RATE, 100);
  const second = clock.frameEnd(BLOCK / RATE, BLOCK, RATE, 600); // delivered 500 ms late: keeps its audio time
  assert.ok(Math.abs(second - first - BLOCK_MS) < 0.01, `continuous blocks stay one block apart (${second - first})`);
  // Lost blocks: the audio clock jumps 1 s; the gap shows.
  const third = clock.frameEnd(BLOCK / RATE * 2 + 1, BLOCK, RATE, 1700);
  assert.ok(third - second > 900, 'a hole in the audio stays a hole');
  // Delivery more than 2 s behind the mapped time re-anchors to the delivery (the cutter sees a gap and starts over).
  const fourth = clock.frameEnd(BLOCK / RATE * 3 + 1, BLOCK, RATE, 5000);
  assert.equal(fourth, 5000);
  // No audio clock: the delivery time, as before; never backwards.
  const plain = new AudioFrameClock();
  assert.equal(plain.frameEnd(undefined, BLOCK, RATE, 50), 50);
  assert.equal(plain.frameEnd(Number.NaN, BLOCK, RATE, 40), 50.001);
});
