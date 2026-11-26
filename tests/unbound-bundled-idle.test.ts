// Unbound's idle from the shipped StayStill model:
// the files and their licence match the manifest; the page finds them from the built page and the dev server only; a changed or
// missing file gives the procedural idle, never an error; the layer lays the idle under the director and her acts by priority and
// never in one frame; the soft limits bend without a kink; and in Gene's real Unbound frame loop at 60 and 30 fps her feet stay
// planted with no step, the centre of mass stays inside her feet, the head stays inside its bounds, nothing jolts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNBOUND_IDLE_MODEL, bundledRootFor, createBundledIdle, loadBundledIdle } from '../src/unbound/motion/bundled-idle';
import { UnboundIdleLayer, idleWanted, type IdleBody } from '../src/unbound/motion/unbound-idle';
import { boundIdle, softKnee, type LearnedIdle } from '../src/unbound/motion/learned-idle';
import { REST_TARGETS, ZERO_ROT, type PoseTargets } from '../src/unbound/motion/generator';
import { BUILT_PAGE, readLocal, runIdleStream, shippedIdle } from './helpers/unbound-idle-stream';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLED = path.join(ROOT, 'assets', 'bundled');

test('the shipped files are the ones the manifest names (size, SHA-256), with the MIT licence and the citation, and the variant the user chose', () => {
  const m = UNBOUND_IDLE_MODEL;
  for (const file of [m.weights, m.eventsMeta, m.eventsData]) {
    const bytes = readFileSync(path.join(BUNDLED, ...file.relativePath.split('/')));
    assert.equal(bytes.length, file.bytes, file.relativePath);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.relativePath);
  }
  // The right-hand group of side-by-side-a0.5.webm: StayStill model without the calibration gains, its own quick moves at ×1, knob 0.5.
  assert.equal(m.variant, 'ss-model-raw+events');
  assert.equal(m.settings.activation, 0.5);
  assert.equal(m.settings.calibrated, false);
  assert.equal(m.settings.eventRate, 1);
  const licence = readFileSync(path.join(BUNDLED, 'unbound', 'idle', 'LICENSE'), 'utf8');
  assert.match(licence, /^MIT License/);
  assert.match(licence, /Permission is hereby granted, free of charge/);
  const readme = readFileSync(path.join(BUNDLED, 'unbound', 'idle', 'README.md'), 'utf8');
  for (const cite of ['Atxa Landa', 'Rodriguez', 'Lazkano', 'Kucherenko', 'StayStill', 'arXiv 2605.13693', 'zenodo.org/records/18741736']) assert.ok(readme.includes(cite), cite);
  for (const notice of ['ACKNOWLEDGEMENTS.md', 'THIRD_PARTY_NOTICES.md']) {
    const text = readFileSync(path.join(ROOT, notice), 'utf8');
    assert.ok(text.includes('StayStill') && text.includes('2605.13693') && text.includes('zenodo.org/records/18741736'), notice);
  }
  assert.ok(readFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8').includes('Permission is hereby granted, free of charge'), 'the MIT text in the notices');
});

test('the page finds assets/bundled/ from the built page and the local dev server, and from nowhere else', () => {
  assert.equal(bundledRootFor('file:///C:/Apps/soft%20hearts/resources/app.asar/dist/src/unbound/index.html?x=1'), 'file:///C:/Apps/soft%20hearts/resources/app.asar/assets/bundled/');
  assert.equal(bundledRootFor('http://127.0.0.1:5173/src/unbound/index.html'), 'http://127.0.0.1:5173/assets/bundled/');
  assert.equal(bundledRootFor('http://localhost:5173/src/unbound/index.html'), 'http://localhost:5173/assets/bundled/');
  for (const other of ['https://example.com/src/unbound/index.html', 'http://192.168.1.2:5173/src/unbound/index.html', 'file:///C:/x/src/unbound/index.html',
    'file://server/share/dist/src/unbound/index.html', 'file:///C:/app/dist/index.html', 'mmd-asset://abc/dist/src/unbound/index.html', 'not a url'])
    assert.equal(bundledRootFor(other), null, other);
});

test('loading: the real files give the learned idle; a changed byte, a missing file or another page give null and the procedural idle', async () => {
  const shipped = await loadBundledIdle(BUILT_PAGE, readLocal);
  assert.ok(shipped, 'the shipped files load');
  assert.equal(shipped!.events.frames, 36);
  assert.equal(createBundledIdle(1.6, shipped, 1).id, 'model+events');
  // Same size, one byte different (a different model dropped in without its manifest): refused by the SHA-256.
  const flipped = await loadBundledIdle(BUILT_PAGE, async url => {
    const bytes = await readLocal(url);
    if (url.endsWith('events.f32')) new Uint8Array(bytes)[1000] ^= 1;
    return bytes;
  });
  assert.equal(flipped, null);
  assert.equal(await loadBundledIdle(BUILT_PAGE, async url => { if (url.endsWith('idle-vae.json')) throw new Error('missing'); return readLocal(url); }), null);
  assert.equal(await loadBundledIdle('https://example.com/src/unbound/index.html', readLocal), null);
  const fallback = createBundledIdle(1.6, null, 1);
  assert.equal(fallback.id, 'procedural');
  assert.equal(fallback.learned, false);
});

test('softKnee: untouched below the knee, same slope at the knee, never past the most; boundIdle keeps the head chain shares', () => {
  for (const x of [0, 0.1, -0.29, 0.3]) assert.equal(softKnee(x, 0.3, 0.5), x);
  const e = 1e-6;
  assert.ok(Math.abs((softKnee(0.3 + e, 0.3, 0.5) - softKnee(0.3, 0.3, 0.5)) / e - 1) < 1e-3, 'slope 1 at the knee');
  assert.ok(softKnee(10, 0.3, 0.5) <= 0.5 && softKnee(10, 0.3, 0.5) > 0.49 && softKnee(0.45, 0.3, 0.5) < 0.45, "bends, never past the most");
  assert.equal(softKnee(-10, 0.3, 0.5), -softKnee(10, 0.3, 0.5));
  assert.equal(softKnee(Number.NaN, 0.3, 0.5), 0);
  const D = Math.PI / 180;
  const t: PoseTargets = { ...REST_TARGETS, torso: { ...ZERO_ROT, yaw: 20 * D }, neck: { ...ZERO_ROT, yaw: 20 * D }, head: { ...ZERO_ROT, yaw: 20 * D, pitch: 0.1 },
    pelvis: { lateral: 0.06, forward: 0.08, vertical: 0.01 } };
  const b = boundIdle(t, { headYawKneeDeg: 30, headYawMaxDeg: 45, hipShiftKnee: 0.016, hipShiftMax: 0.025 }, 1.6);
  const chain = (b.torso.yaw + b.neck.yaw + b.head.yaw) / D;
  assert.ok(chain > 30 && chain < 45, `head chain ${chain}°`);
  assert.ok(Math.abs(b.torso.yaw / b.head.yaw - 1) < 1e-12, 'shares kept');
  assert.equal(b.head.pitch, 0.1);
  const shift = Math.hypot(b.pelvis.lateral, b.pelvis.forward);
  assert.ok(shift > 0.016 * 1.6 && shift < 0.025 * 1.6, `hip shift ${shift}`);
  assert.ok(Math.abs(b.pelvis.lateral / b.pelvis.forward - 0.75) < 1e-12, 'direction kept');
  assert.equal(b.pelvis.vertical, 0.01);
  const small: PoseTargets = { ...REST_TARGETS, torso: { ...ZERO_ROT, yaw: 0.1 } };
  assert.equal(boundIdle(small, { headYawKneeDeg: 30, headYawMaxDeg: 45, hipShiftKnee: 0.016, hipShiftMax: 0.025 }, 1.6), small, 'inside: the same object');
});

test('idleWanted: only while she just stands on both feet', () => {
  const quiet = { performing: false, walking: false, moving: false, stance: 'both' };
  assert.equal(idleWanted(quiet), true);
  assert.equal(idleWanted({ ...quiet, stance: 'holding' }), true);
  for (const busy of [{ performing: true }, { walking: true }, { moving: true }, { stance: 'left' }, { stance: 'lifting' }]) assert.equal(idleWanted({ ...quiet, ...busy }), false, JSON.stringify(busy));
});

/** A body that records what it is handed. */
function fakeBody() {
  const handed: PoseTargets[] = [];
  const body: IdleBody = { sense: null, intentIdle: true, setPoseTargets: t => { handed.push(t); } };
  return { body, handed };
}
/** An idle that always turns the head 0.4 rad. */
const TURN: LearnedIdle = (() => {
  const frame = { ...REST_TARGETS, head: { pitch: 0, yaw: 0.4, roll: 0 } };
  return { id: 'turn', learned: true, activation: 0.5, frame: () => frame, generator: { last: new Float32Array(27) } as never, reset() {} };
})();
const tick = () => new Promise(resolve => setImmediate(resolve));

test('without an idle the director\'s targets pass through exactly as before (same object, only when it writes)', async () => {
  const { body, handed } = fakeBody();
  const layer = new UnboundIdleLayer(async () => null);
  layer.attach(body, 1.6);
  await tick();
  const director = layer.wrap(body);
  layer.frame(1 / 60, true);
  assert.equal(handed.length, 0, 'nothing written, nothing handed');
  const t = { ...REST_TARGETS, head: { pitch: 0.2, yaw: 0, roll: 0 } };
  director.setPoseTargets(t);
  layer.frame(1 / 60, true);
  assert.equal(handed.length, 1);
  assert.equal(handed[0], t);
  layer.frame(1 / 60, true);
  assert.equal(handed.length, 1);
  const other = fakeBody().body;
  assert.equal(layer.wrap(other), other, 'a figure it was not attached to is not wrapped');
});

for (const fps of [60, 30]) {
  test(`the idle's weight eases in and out by priority, with no jump and no kink, a reversal half way included (${fps} fps)`, async () => {
    const { body, handed } = fakeBody();
    const layer = new UnboundIdleLayer(async () => TURN);
    layer.attach(body, 1.6);
    await tick();
    const yaws: number[] = [];
    const run = (seconds: number, wanted: boolean) => { for (let i = 0; i < seconds * fps; i++) { layer.frame(1 / fps, wanted); yaws.push(handed.at(-1)?.head.yaw ?? 0); } };
    run(1, false); assert.equal(layer.weight, 0, 'nothing before it is wanted');
    run(6, true);
    assert.ok(layer.weight > 0.98, `in after 6 s (${layer.weight})`);
    const at = (s: number) => yaws[Math.round((1 + s) * fps) - 1] / 0.4;
    assert.ok(at(1) < 0.6 && at(2.5) > 0.6, `about 2.5 s to come in (${at(1).toFixed(2)} at 1 s, ${at(2.5).toFixed(2)} at 2.5 s)`);
    const before = yaws.length;
    run(1.2, false);
    assert.ok(layer.weight < 0.06, `mostly out 1.2 s after something takes over (${layer.weight})`);
    run(0.4, true); run(0.3, false); run(3, false); // a reversal half way, then out
    assert.equal(layer.weight, 0, 'all the way out (snapped below 1e-4)');
    assert.equal(handed.at(-1)!.head.yaw, 0);
    // No frame jumps: the per-frame change stays under what the fastest spring allows, and the change of the change (a kink) is small.
    const d1 = yaws.slice(1).map((v, i) => v - yaws[i]), d2 = d1.slice(1).map((v, i) => Math.abs(v - d1[i]));
    const dt = 1 / fps, omegaOut = 3.36 / 0.6;
    assert.ok(Math.max(...d1.map(Math.abs)) < 0.4 * omegaOut / Math.E * dt * 1.05, `largest step ${Math.max(...d1.map(Math.abs))}`);
    assert.ok(Math.max(...d2) < 0.4 * omegaOut ** 2 * dt * dt * 1.05, `largest kink ${Math.max(...d2)} (no switch in one frame)`);
    void before;
  });
}

test('the director writing mid-idle: its targets with the idle on top, the idle fading out from there', async () => {
  const { body, handed } = fakeBody();
  const layer = new UnboundIdleLayer(async () => TURN);
  layer.attach(body, 1.6);
  await tick();
  for (let i = 0; i < 600; i++) layer.frame(1 / 60, true);
  const look = { ...REST_TARGETS, eyes: { yaw: 0.3, pitch: 0 }, head: { pitch: 0.1, yaw: 0, roll: 0 } };
  layer.wrap(body).setPoseTargets(look);
  layer.frame(1 / 60, false);
  const first = handed.at(-1)!;
  assert.equal(first.eyes, look.eyes, 'where the director looks is the director\'s');
  assert.ok(Math.abs(first.head.pitch - 0.1) < 1e-12 && first.head.yaw > 0.39, 'its pose with the idle still on top in the first frame');
  for (let i = 0; i < 180; i++) layer.frame(1 / 60, false);
  assert.equal(handed.at(-1), look, 'then the director\'s own targets, unchanged');
});

test('30 simulated minutes of the shipped idle alone: no NaN, the head chain inside its bound, no slow drift away', async () => {
  const bundled = await shippedIdle();
  assert.ok(bundled);
  const idle = createBundledIdle(1.6, bundled, 7), D = 180 / Math.PI, bounds = bundled!.settings.bounds!;
  const fps = 60, frames = 30 * 60 * fps, chain = new Float32Array(frames);
  let bad = 0, shiftMax = 0;
  const heap0 = process.memoryUsage().heapUsed;
  for (let i = 0; i < frames; i++) {
    const t = idle.frame(1 / fps);
    const yaw = (t.torso.yaw + t.neck.yaw + t.head.yaw) * D;
    for (const v of [yaw, t.pelvis.lateral, t.pelvis.forward, t.head.pitch, t.head.roll]) if (!Number.isFinite(v)) bad++;
    chain[i] = yaw;
    shiftMax = Math.max(shiftMax, Math.hypot(t.pelvis.lateral, t.pelvis.forward));
  }
  const heapGrowthMb = (process.memoryUsage().heapUsed - heap0) / 2 ** 20;
  assert.equal(bad, 0, 'no NaN');
  const abs = Array.from(chain, Math.abs).sort((a, b) => a - b), p95 = abs[Math.floor(0.95 * abs.length)];
  assert.ok(abs.at(-1)! <= bounds.headYawMaxDeg + 1e-6, `head chain at most ${abs.at(-1)!.toFixed(1)}°`);
  // The StayStill people, held out of training, turned their head 30.7° from where it started at the 95th percentile.
  assert.ok(p95 < 30.7, `head chain p95 ${p95.toFixed(1)}°`);
  assert.ok(shiftMax <= bounds.hipShiftMax * 1.6 + 1e-9, `hip shift at most ${(shiftMax * 100).toFixed(2)} cm`);
  // No accumulation: each 5-minute block's mean turn stays near the middle (a model that wandered off would sit far to one side).
  for (let b = 0; b < 6; b++) {
    let s = 0;
    for (let i = b * frames / 6; i < (b + 1) * frames / 6; i++) s += chain[i];
    assert.ok(Math.abs(s / (frames / 6)) < 10, `5-minute block ${b}: mean head chain ${(s / (frames / 6)).toFixed(1)}°`);
  }
  assert.ok(heapGrowthMb < 64, `heap grew ${heapGrowthMb.toFixed(1)} MB`);
});

const R = (v: number, d = 3) => +v.toFixed(d);
for (const fps of [60, 30]) {
  test(`in Gene's real Unbound frame loop at ${fps} fps, 2 minutes, two seeds: feet planted, no step, balanced, head in bounds, no jolt`, async t => {
    for (const seed of [1, 7]) {
      const r = await runIdleStream({ fps, seconds: 120, seed });
      t.diagnostic(`${fps} fps seed ${seed}: ${JSON.stringify({ source: r.source, jolt: r.jolt.max, joltP95: r.jolt.p95, rootSurpriseCm: R(r.rootSurpriseMaxCm, 6), ankleSurpriseCm: R(r.ankleSurpriseMaxCm, 6),
        driftCm: [R(r.footDriftCm.ankle, 6), R(r.footDriftCm.toe, 6)], steps: r.steps, comMinCm: R(r.comMinMarginCm, 2), headP95: r.head.p95, headMax: r.head.max, msPerFrame: R(r.msPerFrame) })}`);
      assert.equal(r.source, 'model+events');
      assert.equal(r.nonFinite, 0);
      assert.equal(r.steps, 0, 'no step');
      assert.ok(r.rootSurpriseMaxCm < 1e-6 && r.rootFromStartCm < 1e-6, `the root does not move (${r.rootSurpriseMaxCm} cm)`);
      assert.ok(r.ankleSurpriseMaxCm < 1e-3, `ankles still (${r.ankleSurpriseMaxCm} cm)`);
      assert.ok(r.footDriftCm.ankle < 0.01 && r.footDriftCm.toe < 0.01, `feet planted (${r.footDriftCm.ankle} / ${r.footDriftCm.toe} cm)`);
      // Standing on one foot keeps 3.1 cm (U1 part 2); with both feet down and the idle shifting her weight, at least 3 cm.
      assert.ok(r.comMinMarginCm > 3, `centre of mass ${r.comMinMarginCm.toFixed(2)} cm inside her feet`);
      assert.ok(r.head.max < 50, `head at most ${r.head.max}° from where it stood`);
      // People's quick head moves (the events) are real accelerations: allowed more than the procedural idle's 0.1°, still smooth (∝ dt²).
      assert.ok(r.jolt.max < 0.35 * (60 / fps) ** 2, `largest unexpected step ${r.jolt.max}°`);
    }
  });

  test(`a director taking over mid-idle and letting go again at ${fps} fps: handed over in steps, never in one frame`, async t => {
    const D = Math.PI / 180;
    // A look and a lean (a peek's first beat) from 20 s to 26 s; the idle goes out under it and comes back after.
    const lean: PoseTargets = { ...REST_TARGETS, torso: { pitch: 0.12, yaw: 10 * D, roll: 0 }, head: { pitch: -0.1, yaw: 8 * D, roll: 0 }, eyes: { yaw: 0.1, pitch: 0 } };
    let wrote = false;
    const r = await runIdleStream({ fps, seconds: 40, seed: 7, script: time => {
      if (time >= 20 && time < 26) { wrote = true; return { wanted: false, owner: lean }; }
      if (time >= 26 && wrote) { wrote = false; return { wanted: true, owner: { ...REST_TARGETS } }; }
      return { wanted: true };
    } });
    t.diagnostic(`${fps} fps takeover: jolt ${r.jolt.max}° (p95 ${r.jolt.p95}), weight ${r.weight.min}..${R(r.weight.max)}, steps ${r.steps}, COM ≥ ${R(r.comMinMarginCm, 2)} cm`);
    assert.equal(r.steps, 0);
    assert.ok(r.footDriftCm.ankle < 0.01 && r.footDriftCm.toe < 0.01);
    assert.ok(r.jolt.max < 0.35 * (60 / fps) ** 2, `largest unexpected step ${r.jolt.max}°`);
  });
}
