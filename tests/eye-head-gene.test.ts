// E1 eye-head on the bundled Gene through the real frame loops (docs/claude/2026-11-14-eye-head-fix.md): in Unbound (figure,
// gait and contact owner, director, generator, intent layer) at 60 and 30 fps, her pupils stay off the edge of her eyes while she
// stands past the screen's edge looking at the lens, turns round and walks away, and comes home after a peek; the close-up still
// puts her eye on the lens axis; nothing jolts more than before. On the companion, the eye guard leaves the pointer gaze exactly as it
// was and catches an eye pushed past the limits. EYE_HEAD_REPORT=1 prints the numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { axisMm, backFrames, edgeScene, eyeStats, holdFrames, peekScene, walkBackScene } from './helpers/eye-head-scenes';
import { EYE_HEAD_DEFAULTS } from '../src/stage/eye-head';

const REPORT = !!process.env.EYE_HEAD_REPORT;
/**
 * Before E1 (d4e80efe + the read-only probe, measured 2026-11-14 with scripts/unbound/eye-head-measure.ts): the largest unexpected
 * step of her upper body (degrees) per scene and rate. The rule (R29): within 1.25× of it, floors 0.15° at 60 fps and 0.6° at 30.
 */
const BEFORE_UPPER = { 60: { edge: 0.025, walk: 0.125, peek: 0.126 }, 30: { edge: 0.098, walk: 0.483, peek: 0.495 } } as const;
/** Before E1, the close-up: the nearer eye off the lens axis, p50 (mm), in this scene. */
const BEFORE_AXIS_P50 = { 60: 3.89, 30: 3.50 } as const;
const allowed = (fps: 30 | 60, scene: keyof (typeof BEFORE_UPPER)[60]) => Math.max(1.25 * BEFORE_UPPER[fps][scene], fps === 60 ? 0.15 : 0.6);

function assertEyes(name: string, stats: ReturnType<typeof eyeStats>) {
  if (REPORT) console.log(`[eye-head] ${name}`, JSON.stringify(stats));
  assert.ok(stats.yawP95 <= 15, `${name}: eye yaw p95 ${stats.yawP95.toFixed(2)}° (≤ 15°)`);
  assert.ok(stats.yawMax <= EYE_HEAD_DEFAULTS.eyeHard.yaw + 0.5, `${name}: eye yaw max ${stats.yawMax.toFixed(2)}° (the hard limit)`);
  assert.equal(stats.pinnedFrames, 0, `${name}: no stretch longer than 100 ms at the edge (≥ 16° across or ≥ 14° up/down)`);
}

for (const fps of [60, 30] as const) {
  test(`${fps} fps, Gene in Unbound past the screen's edge looking at the lens: pupils off the edge, nothing jolts`, async () => {
    const frames = await edgeScene(fps);
    for (const phase of ['edge-laptop', 'edge-wide']) assertEyes(`edge ${phase} @${fps}`, eyeStats(frames.filter(f => f.phase === phase), fps));
    const all = eyeStats(frames, fps);
    assert.ok(all.upperSurpriseDeg <= allowed(fps, 'edge'), `upper body ${all.upperSurpriseDeg.toFixed(3)}° ≤ ${allowed(fps, 'edge').toFixed(3)}°`);
  });

  test(`${fps} fps, Gene turning round and walking away (U1, no director): she looks where she is going, pupils off the edge`, async () => {
    const frames = await walkBackScene(fps, 14);
    const stats = eyeStats(frames, fps);
    assertEyes(`walk away @${fps}`, stats);
    assert.ok(stats.upperSurpriseDeg <= allowed(fps, 'walk'), `upper body ${stats.upperSurpriseDeg.toFixed(3)}° ≤ ${allowed(fps, 'walk').toFixed(3)}°`);
  });

  test(`${fps} fps, a whole peek from 3 m: the close-up still on the axis, the way home with the lens behind her let go`, async () => {
    const { frames } = await peekScene(fps);
    assert.deepEqual([...new Set(frames.map(f => f.phase))].filter(Boolean), ['notice', 'walk', 'lean', 'hold', 'back', 'settle']);
    assertEyes(`peek whole @${fps}`, eyeStats(frames, fps));
    assertEyes(`peek way home @${fps}`, eyeStats(backFrames(frames), fps));
    const hold = holdFrames(frames, fps), axis = axisMm(hold), whole = eyeStats(frames, fps);
    if (REPORT) console.log(`[eye-head] peek close-up @${fps}`, JSON.stringify(axis));
    assert.ok(axis.p50 <= BEFORE_AXIS_P50[fps] + 0.5 && axis.max < 8, `eye on the lens axis: p50 ${axis.p50.toFixed(2)} mm (before ${BEFORE_AXIS_P50[fps]}), max ${axis.max.toFixed(2)} mm`);
    assert.ok(whole.upperSurpriseDeg <= allowed(fps, 'peek'), `upper body ${whole.upperSurpriseDeg.toFixed(3)}° ≤ ${allowed(fps, 'peek').toFixed(3)}°`);
    // Walking home with the lens behind her (more than 150° round), she lets it go: a glance over her shoulder while she turns,
    // then her head is back over her body within a second (not held twisted toward the lens behind her).
    const home = backFrames(frames), behindAt = home.find(f => Math.abs(f.lensBearing ?? 0) > 150)?.t ?? Infinity;
    const later = home.filter(f => f.t >= behindAt + 1), twist = Math.max(0, ...later.map(f => Math.abs(f.twist ?? 0)));
    const glance = Math.max(0, ...home.map(f => Math.abs(f.twist ?? 0)));
    if (REPORT) console.log(`[eye-head] way home, lens behind @${fps}`, JSON.stringify({ frames: later.length, glanceMaxDeg: glance, twistAfter1sDeg: twist }));
    assert.ok(later.length > fps, 'she does walk home with the lens behind her');
    assert.ok(twist < 5, `head against upper body a second after the lens went behind her: ${twist.toFixed(1)}°`);
    assert.ok(glance <= EYE_HEAD_DEFAULTS.headLimit.yaw + 1, `the glance back stays within the head's reach: ${glance.toFixed(1)}°`);
  });
}
