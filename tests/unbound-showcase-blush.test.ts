// Round 15: the showcase blush popped in: it rose with the shy expression's own quick onset and a
// 2x gain, 0.1 → 0.6 in 0.2–0.33 s. A real blush rises over 1–2 s and fades slower still, so it now has its own envelope
// (src/unbound/showcase/blush-envelope.ts). The glitch scan missed it (no single frame stepped past 0.25), so it also checks
// how fast a morph rises (blush: never from under 0.1 to over 0.6 within 0.3 s).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion } from 'three';
import { BLUSH_RISE, morphsOf, scanShowcase, type ScanFrame } from '../scripts/unbound/showcase-glitch-scan';
import { blushEpisodes } from '../scripts/unbound/showcase-blush-measure';
import { validateBeats } from '../shared/unbound/showcase';
import { MORPH_ALIASES } from '../shared/foundation/universal-skeleton';
import { beatBlush, blushAt } from '../src/unbound/showcase/blush-envelope';
import { runShowcase, SHOWCASE_TRACKED } from './helpers/unbound-showcase';

/** Frames with one blush morph following `blush(t)` and one smile following `smile(t)`; nothing else moves. */
function frames(seconds: number, fps: number, blush: (t: number) => number, smile: (t: number) => number = () => 0): ScanFrame[] {
  return Array.from({ length: Math.round(seconds * fps) + 1 }, (_, i) => {
    const t = i / fps;
    return { t, beats: ['hold-gaze'], rotations: [new Quaternion()], eyeInHead: [{ yaw: 0, pitch: 0 }], clearance: null, morphs: { '照れ': blush(t), 'にっこり': smile(t) } };
  });
}
const ramp = (start: number, len: number) => (t: number) => Math.min(1, Math.max(0, (t - start) / len));

test('round 15, the scan: a blush rising from under 0.1 to over 0.6 within 0.3 s is found, even spread over many frames', () => {
  for (const fps of [60, 30]) {
    const opts = { fps, boneNames: ['x'] };
    // 0 → 1 over 0.4 s: 0.1 → 0.6 takes 0.2 s, and no frame steps past 0.25 (the old per-frame check stays quiet).
    const fast = scanShowcase(frames(3, fps, ramp(1, 0.4)), opts);
    assert.deepEqual(fast.map(h => h.kind), ['rise'], JSON.stringify(fast));
    assert.equal(fast[0].name, '照れ');
    assert.ok(fast[0].worst <= 0.3 && Math.abs(fast[0].from - 1.24) < 2 / fps, JSON.stringify(fast));
    // 0 → 1 over 1.5 s: 0.1 → 0.6 takes 0.75 s. Clean.
    assert.deepEqual(scanShowcase(frames(3, fps, ramp(1, 1.5)), opts), []);
    // A smile may rise that fast (only the blush has the rule by default)…
    assert.deepEqual(scanShowcase(frames(3, fps, () => 0, ramp(1, 0.4)), opts), []);
    // …and the rule is configurable per morph.
    const smileRule = { label: 'smile', match: (n: string) => n === 'にっこり', low: 0.1, high: 0.6, withinS: 0.3 };
    assert.deepEqual(scanShowcase(frames(3, fps, () => 0, ramp(1, 0.4)), { ...opts, rise: [smileRule] }).map(h => [h.kind, h.name]), [['rise', 'にっこり']]);
  }
  assert.ok(MORPH_ALIASES.shy.every(a => BLUSH_RISE.match(a)), 'the default rule covers every blush alias');
});

/** One shy moment in a quiet look, then a laugh and a content (neither brings a blush), long enough to see the fade end. */
const BEATS = validateBeats([
  { at: 0, dur: 1.2, kind: 'notice', intensity: 0.5, feel: '—' }, { at: 1.2, dur: 10, kind: 'hold-gaze', intensity: 0.5, feel: '—' },
  { at: 1.5, dur: 2.5, kind: 'expression', name: 'shy', intensity: 0.8, onset: 'quick', feel: '—' },
  { at: 8, dur: 2, kind: 'expression', name: 'laugh', intensity: 0.8, feel: '—' },
], { from: 0, to: 30 })!.beats;
const isBlush = (n: string) => MORPH_ALIASES.shy.some(a => a.toLowerCase() === n.toLowerCase());

for (const fps of [60, 30]) {
  test(`round 15, the real frame loop at ${fps} fps: the blush rises over about 1.2–1.8 s and fades over about 2–3 s, never popping`, async () => {
    const t: number[] = [], blush: number[] = [], morphs: Record<string, number>[] = [];
    const run = await runShowcase(fps, 11.5, BEATS, { seed: 0.42, onFrame: (mesh, at) => {
      const m = morphsOf(mesh); morphs.push(m);
      t.push(at); blush.push(Math.max(0, ...Object.entries(m).filter(([n]) => isBlush(n)).map(([, v]) => v)));
    } });
    const episodes = blushEpisodes(t, blush);
    assert.equal(episodes.length, 1, `one blush, from the shy moment only: ${JSON.stringify(episodes)}`);
    const e = episodes[0];
    assert.ok(e.peak > 0.85, `it still reaches a full blush: ${JSON.stringify(e)}`);
    assert.ok(e.lowToHighS !== null && e.lowToHighS >= 0.4, `0.1 → 0.6 is not a pop: ${JSON.stringify(e)}`);
    assert.ok(e.rise10to90S !== null && e.rise10to90S >= 0.6 && e.rise10to90S <= 1.1, `10 → 90% over most of a second (S5 over 1.2–1.8 s): ${JSON.stringify(e)}`);
    assert.ok(e.fade90to10S !== null && e.fade90to10S >= 1.1 && e.fade90to10S <= 2.2, `90 → 10% fades slower than it rose: ${JSON.stringify(e)}`);
    assert.ok(e.fade90to10S! > e.rise10to90S!, `the fade is slower than the rise: ${JSON.stringify(e)}`);
    const hits = scanShowcase(run.frames.map((f, i) => ({ ...f, morphs: morphs[i] ?? {} })).slice(fps / 2), { fps, boneNames: SHOWCASE_TRACKED });
    assert.deepEqual(hits.filter(h => h.kind === 'rise' || h.kind === 'morph'), []);
  });
}

test('round 15, the envelope itself: up over 1.2–1.8 s, away over 2–3 s, full even for a short shy, highest of several, none from other expressions', () => {
  const shy = (speed: number, roll: number, dur = 2.5, playedAt = 1) => ({ kind: 'expression', name: 'shy' as const, playedAt, dur, intensity: 0.8, vary: { amp: 0, speed, roll } });
  const timeTo = (b: ReturnType<typeof shy>, pred: (v: number, t: number) => boolean) => { for (let t = b.playedAt; t < b.playedAt + 12; t += 0.005) if (pred(beatBlush(b, t), t)) return t - b.playedAt; return Infinity; };
  for (const speed of [-1.3, 0, 1.3]) for (const roll of [-1.3, 0, 1.3]) {
    const b = shy(speed, roll), peak = beatBlush(b, b.playedAt + 2.4);
    const up = timeTo(b, v => v >= 0.99999 * peak);
    assert.ok(up >= 1.2 - 0.05 && up <= 1.8 + 0.01, `rise ${up}`);
    const gone = timeTo(b, (v, t) => t > b.playedAt + b.dur && v <= 0.00001 * peak) - b.dur;
    assert.ok(gone >= 2 - 0.1 && gone <= 3 + 0.01, `fade ${gone}`);
  }
  const short = shy(0, 0, 0.5);
  assert.ok(beatBlush(short, short.playedAt + 1.5) > 0.95 * beatBlush(shy(0, 0), 2.5), 'a short shy still blushes fully');
  assert.equal(beatBlush({ ...shy(0, 0), name: 'laugh' as never }, 2.5), 0);
  const a = shy(0, 0, 2.5, 1), b2 = shy(0, 0, 2.5, 4);
  for (let t = 0; t < 10; t += 0.01) assert.equal(blushAt([a, b2], t), Math.max(beatBlush(a, t), beatBlush(b2, t)));
});
