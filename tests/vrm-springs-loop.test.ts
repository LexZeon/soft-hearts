// I-152 step 3 (docs/claude/2026-11-21-vrm-physics.md): a VRM's hair and coat hem move with her, on her real window frame loop at 60 and
// 30 fps (tests/helpers/vrm-spring-harness.ts: the synthetic VRM with a hair chain and a long skirt that has no colliders of its own; nothing
// from a real model). Before = the switches off (what every VRM did until now: stiff), after = on. R29: a smooth start, the same swing at
// 30 and 60 fps, settles, no jump when she is placed somewhere else, nothing explodes over a long run, the skirt never inside her legs.
// R29_REPORT=1 prints the numbers the record quotes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PHYSICS_OFF, peak, settleTime, span, springRun, springSurprise, type SpringFrame, type SpringScriptContext } from './helpers/vrm-spring-harness';

const REPORT = process.env.R29_REPORT === '1';
const round = (value: number, digits = 3) => +value.toFixed(digits);
const at = (ctx: SpringScriptContext, t: number) => Math.abs(ctx.t - t) < 1e-9;
/** Turn to face away and back. */
const turn = (ctx: SpringScriptContext) => { if (at(ctx, 1)) ctx.figure.faceToward({ x: 0, z: -3 }); if (at(ctx, 2.5)) ctx.figure.faceToward({ x: 0, z: 3 }); };
/** Walk to the side and back (her legs step through where the hem hangs), then stand. */
const walk = (ctx: SpringScriptContext) => { if (at(ctx, 1)) ctx.figure.followTo({ x: 0.9, z: 0 }); if (at(ctx, 3)) ctx.figure.followTo({ x: 0, z: 0 }); };
/** Her head pulled sideways and held, then let go. */
const pull = (ctx: SpringScriptContext) => { if (ctx.t >= 1.5 && ctx.t < 3) ctx.pull(Math.min(1, (ctx.t - 1.5) / 0.4) * 160, -40); else ctx.release(); };
const clearance = (frames: readonly SpringFrame[]) => Math.min(...frames.map(f => f.legClearance));
const ms = (frames: readonly SpringFrame[]) => { const sorted = frames.slice(2).map(f => f.ms).sort((a, b) => a - b); return { p50: sorted[sorted.length >> 1], p95: sorted[Math.floor(sorted.length * 0.95)] }; };
const results = new Map<number, Record<string, number>>();

for (const fps of [60, 30]) {
  test(`VRM springs (${fps} fps): turning swings her hair and hem (stiff before); they settle; a smooth start`, async () => {
    const on = await springRun(fps, 7, { script: turn }), off = await springRun(fps, 7, { script: turn, settings: PHYSICS_OFF });
    const numbers = { hairPeak: round(peak(on.frames, 'hairSwing'), 2), skirtPeak: round(peak(on.frames, 'skirtSwing'), 2), stiffHair: round(peak(off.frames, 'hairSwing'), 3),
      stiffSkirt: round(peak(off.frames, 'skirtSwing'), 3), settleAfterTurnS: round(settleTime(on.frames)), turnEndsS: round(Math.max(...on.frames.filter(f => f.moving).map(f => f.t)), 2), startSurprise: round(springSurprise(on.frames, 0, 0.9)),
      turnSurprise: round(springSurprise(on.frames, 0.9, 7)), stiffTurnSurprise: round(springSurprise(off.frames, 0.9, 7)), msP50: round(ms(on.frames).p50, 3), msP95: round(ms(on.frames).p95, 3) };
    results.set(fps, { ...results.get(fps), ...numbers });
    if (REPORT) console.log(`[vrm springs turn ${fps}] ${JSON.stringify({ ...numbers, rig: on.springs })}`);
    assert.ok(numbers.stiffHair < 0.01 && numbers.stiffSkirt < 0.01, 'switched off, nothing swings (as every VRM did until now)');
    assert.ok(numbers.hairPeak > 3 && numbers.skirtPeak > 8, `on: the hair (${numbers.hairPeak}°) and the hem (${numbers.skirtPeak}°) swing when she turns`);
    assert.ok(numbers.settleAfterTurnS < 2, `settled ${numbers.settleAfterTurnS} s after she stops turning`);
    // A smooth start: the springs ease in from the rest pose (settled unseen first), within R29's floor at this frame rate.
    assert.ok(numbers.startSurprise <= 0.15 * (60 / fps) ** 2, `the start eases in (unexpected step ${numbers.startSurprise}°)`);
    assert.ok(on.frames.every(f => f.finite && f.lengthError < 1e-4), 'every bone keeps its length, no NaN');
  });

  test(`VRM springs (${fps} fps): walking, the skirt keeps out of her legs (body colliders the file does not have)`, async () => {
    const on = await springRun(fps, 5, { script: walk }), off = await springRun(fps, 5, { script: walk, settings: PHYSICS_OFF });
    const numbers = { clearanceOnCm: round(clearance(on.frames) * 100, 2), clearanceOffCm: round(clearance(off.frames) * 100, 2), walkSkirtPeak: round(peak(on.frames, 'skirtSwing'), 1),
      walkSurprise: round(springSurprise(on.frames)), stiffWalkSurprise: round(springSurprise(off.frames)) };
    results.set(fps, { ...results.get(fps), ...numbers });
    if (REPORT) console.log(`[vrm springs walk ${fps}] ${JSON.stringify(numbers)}`);
    assert.ok(numbers.clearanceOffCm < 0, `before: her legs pass into the stiff hem (${numbers.clearanceOffCm} cm)`);
    assert.ok(numbers.clearanceOnCm >= 0, `after: the hem never inside her legs (nearest ${numbers.clearanceOnCm} cm from their surface)`);
    assert.ok(on.frames.every(f => f.finite && f.lengthError < 1e-4), 'every bone keeps its length, no NaN');
  });

  test(`VRM springs (${fps} fps): placed somewhere else she is carried (no whip); pulled by the head, the hair answers`, async () => {
    const placed = await springRun(fps, 4, { script: ctx => { if (at(ctx, 2)) ctx.figure.place({ xM: 2, depthM: 0.5 }); } });
    const pulled = await springRun(fps, 5, { script: pull }), pulledStiff = await springRun(fps, 5, { script: pull, settings: PHYSICS_OFF });
    const floor = 0.15 * (60 / fps) ** 2, rest = springSurprise(placed.frames, 1, 1.95), jump = springSurprise(placed.frames, 1.95, 2.6);
    const numbers = { placedSurprise: round(jump), standingSurprise: round(rest), pullHairPeak: round(peak(span(pulled.frames, 1.5, 5), 'hairSwing'), 2),
      pullStiffHair: round(peak(span(pulledStiff.frames, 1.5, 5), 'hairSwing'), 3), pullSurprise: round(springSurprise(pulled.frames)), stiffPullSurprise: round(springSurprise(pulledStiff.frames)) };
    results.set(fps, { ...results.get(fps), ...numbers });
    if (REPORT) console.log(`[vrm springs place/pull ${fps}] ${JSON.stringify(numbers)}`);
    assert.ok(jump <= Math.max(rest * 1.25, floor), `placed: no whip (unexpected step ${numbers.placedSurprise}° vs ${numbers.standingSurprise}° standing, floor ${floor}°)`);
    assert.ok(numbers.pullHairPeak > numbers.pullStiffHair + 0.5, 'pulled: her hair answers the pull');
    assert.ok(pulled.frames.every(f => f.finite && f.lengthError < 1e-4), 'pulled: no NaN, lengths kept');
  });
}

test('VRM springs: the swing is the same at 30 and 60 fps (fixed substeps)', () => {
  const a = results.get(60), b = results.get(30);
  assert.ok(a && b, 'both frame rates ran');
  for (const key of ['hairPeak', 'skirtPeak'] as const) {
    const ratio = b[key] / a[key];
    assert.ok(ratio > 0.85 && ratio < 1.15, `${key}: 30 fps ${b[key]}° vs 60 fps ${a[key]}°`);
  }
});

test('VRM springs (30 fps, 60 s): a long run of turns, walks, a pull, a placement and a hidden spell: nothing explodes', async () => {
  const run = await springRun(30, 60, { script: ctx => {
    const t = ctx.t, phase = t % 12;
    if (Math.abs(phase - 1) < 1e-9) ctx.figure.followTo({ x: 0.8 * Math.sin(t), z: 0.3 * Math.cos(t) });
    if (Math.abs(phase - 4) < 1e-9) ctx.figure.faceToward({ x: Math.cos(t) * 3, z: Math.sin(t) * 3 });
    if (phase >= 6 && phase < 7.5) ctx.pull(120 * Math.sin(t * 3), -30); else ctx.release();
    if (at(ctx, 30)) ctx.figure.place({ xM: -1, depthM: 0.4 });
    if (at(ctx, 45)) ctx.springs.setVisible(false); // shown again by the next frame's present()
  } });
  const numbers = { maxHair: round(peak(run.frames, 'hairSwing'), 1), maxSkirt: round(peak(run.frames, 'skirtSwing'), 1), clearanceCm: round(clearance(run.frames) * 100, 2),
    lengthError: Math.max(...run.frames.map(f => f.lengthError)), msP50: round(ms(run.frames).p50, 3), msP95: round(ms(run.frames).p95, 3) };
  if (REPORT) console.log(`[vrm springs long 30] ${JSON.stringify(numbers)}`);
  assert.ok(run.frames.every(f => f.finite), 'no NaN');
  assert.ok(numbers.lengthError < 1e-4, 'every bone keeps its length');
  assert.ok(numbers.maxHair < 90 && numbers.maxSkirt < 90, `bounded swings (hair ${numbers.maxHair}°, hem ${numbers.maxSkirt}°)`);
  assert.ok(numbers.clearanceCm >= 0, `the hem never inside her legs (${numbers.clearanceCm} cm)`);
});

test('VRM springs: a VRM 0.x (its spring groups, virtual leaf tails, Unity gravity) swings like the 1.0 one', async () => {
  const run = await springRun(60, 5, { version: '0.x', script: turn });
  const hair = peak(run.frames, 'hairSwing'), skirt = peak(run.frames, 'skirtSwing');
  if (REPORT) console.log(`[vrm springs 0.x 60] ${JSON.stringify({ hair: round(hair, 2), skirt: round(skirt, 2), rig: run.springs })}`);
  assert.ok(hair > 3 && skirt > 8, `0.x swings too (hair ${hair.toFixed(1)}°, hem ${skirt.toFixed(1)}°)`);
  assert.ok(run.frames.every(f => f.finite && f.lengthError < 1e-4));
});
