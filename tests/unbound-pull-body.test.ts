// Unbound v1 step 5c「拉她」in Gene's real Unbound frame loop (the figure with its gait, contact owner and leg IK), driven by the page's
// own pull controller (src/unbound/pull-input.ts), at 60 and 30 fps. Pull her chest sideways, hold, let go:
//   - she follows by walking: the root moves at most her walking speed, never jolts, and ends where she was pulled to (inside her range);
//   - her root stays on the floor; planted feet do not slide; her centre of mass stays inside her feet while she stands;
//   - press and release: the upper body's unexpected step stays within 1.25× of the same run without the pull (floor 0.15° / 0.6°);
//   - a pulled foot: she stands on the other one and gets both back after, without leaving the floor.
// `PULL_REPORT=1` prints the numbers (docs/claude/2026-11-18-unbound-step5.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { geneFigure, TRACKED, max, plantedDrift, surpriseAngles, rootSurprises, type Shown } from './helpers/unbound-gene';
import { UNITS_PER_M } from '../src/unbound/figure';
import { UnboundPull } from '../src/unbound/pull-input';
import { clampFollowDepth, parsePullAnswer, type UnboundPullMessage } from '../shared/unbound/pull';

const REPORT = process.env.PULL_REPORT === '1';
const UPPER = TRACKED.map((name, i) => [name, i] as const).filter(([name]) => !/足|ひざ/.test(name)).map(([, i]) => i);
const WIDTH = 1600, HEIGHT = 1000;
const smooth = (x: number) => { const v = Math.min(1, Math.max(0, x)); return v * v * (3 - 2 * v); };

interface Frame extends Shown { pulling: boolean }

/** Runs her; with `pull`, presses the bone pair's point at `at`, drags by `drag` (her height on the window) and lets go at `until`. */
async function run(fps: number, seconds: number, pull: { a: string; b: string; at: number; until: number; drag: { x: number; y: number } } | null) {
  const { fixture, figure } = await geneFigure({ xM: 0.4, depthM: 8 });
  const U = UNITS_PER_M, camera = new PerspectiveCamera(30, WIDTH / HEIGHT, 0.05 * U, 100 * U);
  camera.position.set(0, 1.25 * U, 0.55 * U); camera.updateMatrixWorld(true);
  const messages: UnboundPullMessage[] = [];
  const pulls = new UnboundPull({
    figure: () => figure, view: () => ({ camera, width: WIDTH, height: HEIGHT }), eligible: () => true,
    send: async message => { messages.push(message); return message.phase === 'start' ? parsePullAnswer({ accepted: true, stance: { willing: 0.6, compliance: 1, pace: 1, hesitateMs: 0, resist: 0 }, sleepy: 0 }) : undefined; },
    clampX: xM => Math.min(1.5, Math.max(-1.5, xM)), clampDepth: clampFollowDepth, clock: () => clock,
  });
  const bones = TRACKED.map(name => fixture.mesh.skeleton.bones.find(b => b.name === name)!);
  const screenOf = (name: string) => {
    fixture.mesh.updateMatrixWorld(true);
    const p = fixture.mesh.skeleton.bones.find(b => b.name === name)!.getWorldPosition(new Vector3()).project(camera);
    return { x: (p.x + 1) / 2 * WIDTH, y: (1 - p.y) / 2 * HEIGHT };
  };
  let clock = 0, from = { x: 0, y: 0 }, heightPx = 0, pressed = false;
  const frames: Frame[] = [], m = 1 / U;
  let rootY = 0, floorY: number | null = null;
  try {
    for (let frame = 0; frame <= Math.round(fps * seconds); frame++) {
      const t = frame / fps; clock = t * 1000;
      if (pull && !pressed && t >= pull.at) {
        const a = screenOf(pull.a), b = screenOf(pull.b);
        from = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        assert.ok(pulls.down(from.x, from.y), 'the press lands on her');
        heightPx = Math.abs(screenOf('頭').y - screenOf('左足首').y) * 1.1;
        pressed = true;
      }
      if (pull && pressed && pulls.active) {
        if (t < pull.until) { const k = smooth((t - pull.at) / 0.6); pulls.move(from.x + pull.drag.x * heightPx * k, from.y + pull.drag.y * heightPx * k); }
        else pulls.up();
      }
      pulls.frame();
      await Promise.resolve(); await Promise.resolve(); // the host's answer arrives between frames, as over IPC
      figure.frame(frame ? 1 / fps : 0);
      const report = figure.report!;
      floorY ??= fixture.mesh.position.y * m;
      rootY = Math.max(rootY, Math.abs(fixture.mesh.position.y * m - floorY)); // her root's height never changes (the soles' offset is constant)
      frames.push({ t, rotations: bones.map(b => b.getWorldQuaternion(new Quaternion())), root: fixture.mesh.position.clone().multiplyScalar(m), heading: figure.heading,
        feet: report.feet.map(f => ({ planted: f.planted, pitch: f.pitch, ankle: f.ankle.clone().multiplyScalar(m), toe: f.toe?.clone().multiplyScalar(m) ?? null, target: f.target.clone().multiplyScalar(m), ik: f.ikWorld.clone().multiplyScalar(m) })),
        com: report.com, comMargin: report.comMargin, reachDrop: report.reachDrop, stance: report.stance, walking: figure.walking, steps: report.steps, pulling: pulls.pulling });
    }
    return { frames, messages, rootY, heightM: figure.heightM };
  } finally { figure.dispose(); fixture.close(); }
}

for (const fps of [60, 30]) {
  const k = 60 / fps, floor = 0.15 * k * k;
  test(`Unbound (${fps} fps): pulled sideways by the chest she walks along, on the floor, feet planted, never faster than her walk, and stays there`, async t => {
    const pull = { a: '上半身', b: '上半身2', at: 2, until: 6, drag: { x: 0.9, y: 0 } };
    const [control, pulled] = [await run(fps, 10, null), await run(fps, 10, pull)];
    const f = pulled.frames, warm = 2 * fps, press = Math.round(pull.at * fps), release = Math.round(pull.until * fps);
    const window = (frames: Frame[], i: number) => frames.slice(Math.max(0, i - 2), i + Math.round(0.8 * fps));
    const own = max(surpriseAngles(control.frames, warm, UPPER));
    const atPress = max(surpriseAngles(window(f, press), 0, UPPER)), atRelease = max(surpriseAngles(window(f, release), 0, UPPER));
    const rootStep = max(f.slice(warm + 1).map((x, i) => Math.hypot(x.root.x - f[warm + i].root.x, x.root.z - f[warm + i].root.z) * 100));
    const rootJolt = max(rootSurprises(f.slice(warm)));
    const drift = plantedDrift(f.slice(warm), f[0].feet[0].ankle.y);
    const standing = f.slice(release + 3 * fps).filter(x => !x.walking);
    const comMin = Math.min(...standing.map(x => x.comMargin ?? Infinity)) * 100;
    const moved = f.at(-1)!.root.x - f[press].root.x;
    const end = pulled.messages.filter(x => x.phase === 'report').at(-1) as Extract<UnboundPullMessage, { phase: 'report' }> | undefined;
    const numbers = { ownDeg: +own.toFixed(3), pressDeg: +atPress.toFixed(3), releaseDeg: +atRelease.toFixed(3), rootStepCm: +rootStep.toFixed(3), walkCapCm: +(0.7 * 100 / fps).toFixed(3),
      rootJoltCm: +rootJolt.toFixed(4), rootYcm: +(pulled.rootY * 100).toFixed(5), toeDriftCm: +drift.toeDrift.toFixed(4), ankleDriftCm: +drift.drift.toFixed(4), comMinCm: +comMin.toFixed(2),
      movedM: +moved.toFixed(3), steps: end?.report.steps, place: end?.place };
    if (REPORT) console.log(`[unbound pull ${fps}] ${JSON.stringify(numbers)}`);
    t.diagnostic(JSON.stringify(numbers));
    assert.deepEqual(pulled.messages[0], { phase: 'start' });
    assert.ok(moved > 0.3, `she walked along to the right (${moved.toFixed(3)} m)`);
    assert.ok((end?.report.steps as number) > 0 && end?.report.ended === 'released' && end.place, 'the end says she walked along and where she stands');
    assert.ok(Math.abs(end!.place!.xM - f.at(-1)!.root.x) < 0.08, 'and she stays there');
    assert.ok(rootStep <= 0.7 * 100 / fps * 1.25 + 0.05, `root at most her walking speed a frame (${rootStep} cm)`);
    assert.ok(rootJolt < 0.1 * k * k, `root: no jolt (${rootJolt} cm)`);
    assert.ok(pulled.rootY < 1e-6, `her root stays on the floor (${pulled.rootY} m)`);
    assert.ok(drift.toeDrift < 0.05 && drift.drift < 0.05, `planted feet do not slide (${drift.toeDrift} / ${drift.drift} cm)`);
    assert.ok(comMin > 3, `centre of mass ${comMin.toFixed(2)} cm inside her feet once she stands`);
    assert.ok(atPress <= Math.max(floor, 1.25 * own), `press: upper body ${atPress}° (own ${own}°)`);
    assert.ok(atRelease <= Math.max(floor, 1.25 * own), `release: upper body ${atRelease}° (own ${own}°)`);
  });

  // I-155 then I-196 (the joystick: down = closer, up = farther): the pointer held below the press point walks her toward you, above it walks her back; never faster than her walk, inside her depth range.
  for (const [name, y, sign] of [['up: away from you', -0.9, 1], ['down: toward you', 0.9, -1]] as const) {
    test(`Unbound (${fps} fps): the chest pulled ${name}, she walks that way on the floor, never faster than her walk, and stays there`, async t => {
      const pull = { a: '上半身', b: '上半身2', at: 2, until: 6, drag: { x: 0, y } };
      const f = (await run(fps, 10, pull)).frames, press = Math.round(pull.at * fps);
      const depth = (i: number) => -f[i].root.z, moved = (depth(f.length - 1) - depth(press)) * sign;
      const step = max(f.slice(2 * fps + 1).map((x, i) => Math.hypot(x.root.x - f[2 * fps + i].root.x, x.root.z - f[2 * fps + i].root.z) * 100));
      t.diagnostic(JSON.stringify({ depthFrom: +depth(press).toFixed(3), depthTo: +depth(f.length - 1).toFixed(3), sideM: +(f.at(-1)!.root.x - f[press].root.x).toFixed(3), stepCm: +step.toFixed(3) }));
      assert.ok(moved > 0.3, `she walked ${name} (${moved.toFixed(3)} m of depth)`);
      assert.ok(Math.abs(f.at(-1)!.root.x - f[press].root.x) < 0.25, 'not much sideways when pulled straight');
      assert.ok(step <= 0.7 * 100 / fps * 1.25 + 0.05, `at most her walking speed a frame (${step} cm)`);
      assert.ok(depth(f.length - 1) >= 5 - 0.1 && depth(f.length - 1) <= 12.5 + 0.1, 'inside her depth range');
      assert.ok(Math.abs(depth(f.length - 1) - depth(f.length - 1 - fps)) < 0.05, 'she stays where she was let go');
    });
  }

  test(`Unbound (${fps} fps): a pulled foot: she stands on the other one, both back after, never off the floor`, async () => {
    const pull = { a: '左ひざ', b: '左足首', at: 2, until: 4.5, drag: { x: 0.3, y: 0 } };
    const r = await run(fps, 8, pull);
    const during = r.frames.filter(x => x.t > 3 && x.t < 4.4), after = r.frames.at(-1)!;
    if (REPORT) console.log(`[unbound pull ${fps}] foot: stances during ${[...new Set(during.map(x => x.stance))].join(',')}, right planted ${during.every(x => x.feet[1].planted)}, after ${after.stance}, rootY ${r.rootY}`);
    assert.ok(during.some(x => x.stance === 'holding'), 'on one foot (the other lifted) while it is pulled');
    assert.ok(during.every(x => x.feet[1].planted), 'the right foot carries her');
    assert.equal(after.stance, 'both');
    assert.ok(r.rootY < 1e-6, 'never off the floor');
  });
}
