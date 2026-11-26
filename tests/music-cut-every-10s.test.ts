/**
 * 2026-11-22 (docs/claude/2026-11-22-music-cut-every-10s.md). The dev journal had her music verdict go
 * false with why "capture-stopped" every ~10.1 s, 3-7 s after it went true, and the dance tier to none with it. The capture never
 * stopped: the receiver (AudioReadingClient.refreshDance) calls the dance off when no frame came for 250 ms, a host busy for longer (the
 * 一起看 screen frame every 10 s) or a capture-state revision (a pause flip of the reading) did that, and the stage's setMusicEnabled(false)
 * reset the recognizer. MusicHearing (src/senses/music-hearing.ts) keeps her hearing through such a stall while the capture is on.
 *
 * The end-to-end scene runs the actual receiver class, the actual capture host and the actual WindowMusic with the real music code, on
 * program-made song PCM through the capture's analysers (no real song), at 60 and 30 fps.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MUSIC_STALL_GRACE_MS, MusicHearing, hearingReceiver } from '../src/senses/music-hearing';
import { WindowMusic, type WindowMusicEnv } from '../src/unbound/window-mode/window-music';
import { loadMusicForEngine, type MusicVerdictFlip } from '../src/stage';
import type { MusicEnergySample } from '../src/stage/music-dance';
import { analyserSamples, drumSong } from './helpers/listen-audio';
import { actualReceiver } from './helpers/actual-audio-reading-client';

function clocked() {
  let now = 1_000;
  const timers: { at: number; run: () => void; id: number }[] = [];
  let serial = 0;
  return {
    now: () => now,
    schedule: (run: () => void, ms: number) => { timers.push({ at: now + ms, run, id: ++serial }); return serial; },
    cancel: (id: unknown) => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift(); now = next.at; next.run();
      }
      now = end;
    },
  };
}

test('MusicHearing: a stall shorter than the grace keeps her hearing; the grace out, a stop, or a lapse without consent end it', () => {
  const clock = clocked(), seen: boolean[] = [];
  let consented = true;
  const hearing = new MusicHearing({ ...clock, consented: () => consented, enabled: on => seen.push(on) });
  hearing.frame();
  assert.deepEqual(seen, [true], 'a frame: she hears');
  hearing.lapse(); clock.advance(MUSIC_STALL_GRACE_MS - 100); hearing.frame();
  assert.deepEqual(seen, [true], 'a lapse of 1.9 s while the capture is on: still hearing, nothing told');
  hearing.lapse(); clock.advance(MUSIC_STALL_GRACE_MS + 5);
  assert.deepEqual(seen, [true, false], 'silent past the grace: off (the timer looks again)');
  hearing.frame(); consented = false; hearing.lapse();
  assert.deepEqual(seen, [true, false, true, false], 'a lapse when 「和她一起听」 is off or the capture is gone: off at once');
  consented = true; hearing.frame(); hearing.stop();
  assert.deepEqual(seen.slice(-2), [true, false], 'the host says the dance is off: off at once');
  hearing.frame(); hearing.dispose();
  assert.equal(seen.at(-1), false, 'disposed: off');
  hearing.frame(); assert.equal(hearing.hearing, false, 'nothing after dispose');
});

test('MusicHearing without a timer (the full-screen page) looks again on tick', () => {
  let now = 0;
  const seen: boolean[] = [], hearing = new MusicHearing({ now: () => now, enabled: on => seen.push(on) });
  hearing.frame(); now += 1500; hearing.tick();
  assert.deepEqual(seen, [true]);
  now += 600; hearing.tick();
  assert.deepEqual(seen, [true, false]);
});

const env: WindowMusicEnv = { view: null, shown: true, speaking: false, adjusting: false, behaviorBlocked: false, touched: false, manualHead: false, asleep: false };

interface SceneResult {
  flips: MusicVerdictFlip[]; stops: number; longestMusicS: number; finalMusic: boolean;
  /** Seconds of the minute in which her dance visibly moved (the largest pose offset that second over 0.005 rad), the largest frame-to-frame pose step (rad), the share of frames from recognition on with the dance tier on. */
  visibleS: number; largestStep: number; tierHeld: number;
  afterStop?: { hearing: boolean; stopFlip: boolean };
}
interface SceneOptions { fps: number; latch: boolean; stallMs?: number; touches?: boolean; stopAfter?: boolean }

/**
 * 60 s of a song at `fps`, the host busy for `stallMs` every 10.1 s (the 一起看 frame: the companion window's samples do not come back) and,
 * with `touches`, the capture state's revision bumped every 10.1 s half a period later (a pause flip of the reading). She is set to
 * "让她一直跟着跳" (her choice exists, so the dance is held back while the sound is not recognized as music, as with her own choice, but the
 * tier is not random). `latch` false: the receiver's callbacks go straight to the stage, as before the fix. `stopAfter`: then 「和她一起听」 off.
 */
async function scene(options: SceneOptions): Promise<SceneResult> {
  const { fps, latch, stallMs = 400, touches = true, stopAfter = false } = options;
  let now = 1_000;
  const timers: { at: number; run: () => void }[] = [];
  const flips: MusicVerdictFlip[] = [];
  const music = new WindowMusic({ face: () => ({ performPick: () => null, setTint: () => {} }) as never, hasFace: () => false,
    verdict: flip => flips.push(flip), now: () => now, wall: () => now });
  music.load(await loadMusicForEngine());
  music.setSettings({}); music.setSettings({ alwaysDance: true });
  const stage = { setMusicEnabled: (on: boolean) => music.setEnabled(on), setMusicSample: (sample: MusicEnergySample) => music.setSample(sample) };
  let receiver: Awaited<ReturnType<typeof actualReceiver>>;
  const heard = hearingReceiver(stage, () => receiver.client.listening === true,
    { now: () => now, schedule: (run, ms) => { timers.push({ at: now + ms, run }); return timers.length; }, cancel: () => {} });
  receiver = await actualReceiver(latch ? { onMusicEnabled: on => heard.enabled(on), onMusicSample: sample => heard.sample(sample) }
    : { onMusicEnabled: on => stage.setMusicEnabled(on), onMusicSample: sample => stage.setMusicSample(sample) }, () => now);
  await receiver.listen();
  const samples = analyserSamples(drumSong(62, { bpm: 112, seed: 3 }), { refreshHz: fps, offset: 0 });
  const startedAt = now, frameMs = 1000 / fps, period = 10_100, buckets = new Float64Array(60);
  let next = 0, musicSince: number | null = null, longest = 0, seen = 0, largestStep = 0, last: number[] | null = null, tierFrames = 0, frames = 0, recognized = false;
  for (let t = 0; t < 60_000; t += frameMs) {
    now = startedAt + t;
    for (const timer of timers.splice(0).filter(x => { if (x.at <= now) return true; timers.push(x); return false; })) timer.run();
    const busy = (t + 3_000) % period < stallMs; // the host's busy moment (the 一起看 frame)
    if (touches && (t + 3_000 + period / 2) % period < frameMs) receiver.host.touch('system-audio'); // the capture state's revision
    while (next < samples.length && samples[next]!.time * 1000 <= t) {
      const sample = samples[next++]!;
      if (!busy) receiver.send({ ...sample, time: now / 1000 });
    }
    receiver.frame();
    music.frame(1 / fps, env);
    const pose = music.getState().pose, values = [pose.sway, pose.chestRoll, pose.headRoll, pose.headPitch], second = Math.min(59, Math.floor(t / 1000));
    buckets[second] = Math.max(buckets[second]!, ...values.map(Math.abs));
    if (last) largestStep = Math.max(largestStep, values.reduce((sum, value, i) => sum + Math.abs(value - last![i]!), 0));
    last = values;
    const fresh = flips.slice(seen); seen = flips.length;
    if (fresh.some(f => !f.music)) musicSince = null;
    if (flips.at(-1)?.music === true) { musicSince ??= now; recognized = true; }
    if (musicSince !== null) longest = Math.max(longest, now - musicSince);
    if (recognized) { frames++; if (music.getState().tier === 'dance' && music.getState().danceOn) tierFrames++; }
  }
  const result: SceneResult = { flips, stops: flips.filter(f => !f.music && f.reason === 'capture-stopped').length, longestMusicS: longest / 1000,
    finalMusic: flips.at(-1)?.music === true, visibleS: [...buckets].filter(value => value > 0.005).length, largestStep, tierHeld: frames ? tierFrames / frames : 0 };
  if (stopAfter) {
    const before = flips.length;
    receiver.host.setDance(false, 'system-audio');
    result.afterStop = { hearing: music.getState().hearing, stopFlip: flips.slice(before).some(f => !f.music && f.reason === 'capture-stopped') };
  }
  return result;
}

const line = (r: SceneResult) => `resets ${r.stops}, longest verdict ${r.longestMusicS.toFixed(1)} s, visibly dancing ${r.visibleS}/60 s, dance tier held ${(r.tierHeld * 100).toFixed(1)} %, largest step ${r.largestStep.toFixed(4)} rad`;

for (const fps of [60, 30]) {
  test(`the real pattern at ${fps} fps: before, the recognizer starts over every ~10 s; through MusicHearing one verdict holds 60 s and so does the dance`, async () => {
    const journal = await scene({ fps, latch: false, touches: false }); // the journal's pattern: the 一起看 frame only
    const before = await scene({ fps, latch: false });
    assert.ok(journal.stops >= 4, `before (stalls only): ${journal.stops} "capture-stopped" resets in 60 s with the capture never stopped`);
    assert.ok(before.stops >= journal.stops, `before (stalls and revisions): ${before.stops}`);
    const after = await scene({ fps, latch: true, stopAfter: true });
    const trues = after.flips.filter(f => f.music).length;
    assert.equal(after.stops, 0, `after: no "capture-stopped" while the capture runs (${JSON.stringify(after.flips)})`);
    assert.equal(trues, 1, 'after: recognized once, kept');
    assert.ok(after.finalMusic, 'still music at the end');
    assert.ok(after.longestMusicS > 50, `one verdict for the rest of the song (${after.longestMusicS.toFixed(1)} s)`);
    assert.ok(after.tierHeld > 0.99, `the dance tier held from recognition to the end (${(after.tierHeld * 100).toFixed(1)} %)`);
    assert.ok(after.visibleS > journal.visibleS && after.visibleS >= 55, `she visibly dances nearly the whole minute (${after.visibleS} s; before ${journal.visibleS} s)`);
    assert.deepEqual(after.afterStop, { hearing: false, stopFlip: true }, '「和她一起听」 off (the host\'s dance off): she stops hearing at once and the verdict resets');
    console.log(`[music-cut ${fps} fps] before, stalls only: ${line(journal)}\n[music-cut ${fps} fps] before, stalls and revisions: ${line(before)}\n[music-cut ${fps} fps] after: ${line(after)}`);
  });
}

test('a stall longer than the grace is a stop: she heard nothing for over 2 s, the recognizer starts over (by its own gap rule too)', async () => {
  const long = await scene({ fps: 60, latch: true, stallMs: MUSIC_STALL_GRACE_MS + 300 });
  assert.ok(long.stops >= 3, `stalls of 2.3 s every 10 s still reset (${long.stops})`);
});
