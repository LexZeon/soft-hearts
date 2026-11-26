// I-164 interaction. A VRM in Unbound's engine is driven through the standard skeleton, whose
// mesh has no vertices: her body capsules measured from it were empty, so full-screen Unbound's hit test never found her (clicks fell to the
// desktop) and no pull started in either mode. Her capsules now come from the VRM's own meshes, placed by its own posed bones and named by the
// standard skeleton's. On a synthetic VRM with a body (tests/helpers/synthetic-vrm-body.ts, nothing from a real model):
//  - she has capsules, each on a VRM bone and named by the standard bone that drives it; the standard mesh alone still has none (the cause);
//  - they follow her posed bones (arms down after the first frame, not the T pose they rest in);
//  - full-screen: the page's hit test (src/unbound/body-hit.ts) finds torso, arms, hands, head and misses beside her; a click reports the part;
//  - a press-and-drag starts a pull in full-screen (src/unbound/pull-input.ts) and in the window (the companion's own input src/mood/pet-pull.ts (no-pet-ok: the file keeps its name)
//    on src/unbound/window-mode/window-pull.ts), at 60 and 30 fps, and the VRM's bones never jump (R29: within 1.25× of the same run without it);
//  - an MMD model measures exactly what it measured before.
// `VRM_INTERACTION_REPORT=1` prints the numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Quaternion, Vector3, type Bone } from 'three';
import { syntheticVrm } from './helpers/synthetic-vrm';
import { syntheticStandardBody, windowVrm, VRM_TRACKED, trackedBones } from './helpers/unbound-vrm';
import { capsuleEnds, measureBodyCapsules, measureBoneCapsules } from '../src/foundation/body-capsules';
import { standardName } from '../src/unbound/model/standard-skeleton';
import { BodyHit } from '../src/unbound/body-hit';
import { ClickReporter } from '../src/unbound/click-reporter';
import { UnboundPull } from '../src/unbound/pull-input';
import { WindowPull } from '../src/unbound/window-mode/window-pull';
import { PetPull } from '../src/mood/pet-pull'; // no-pet-ok: the input class and its file keep their names
import { clampFollowDepth, parsePullAnswer } from '../shared/unbound/pull';
import type { UnboundTouchReport } from '../shared/unbound/typing';
import type { StandardBone } from '../shared/foundation/universal-skeleton';
import { loadPublicGeneForTargets } from './public-gene-fixture';

const REPORT = process.env.VRM_INTERACTION_REPORT === '1';
const DEG = 180 / Math.PI;
const bodyVrm = () => syntheticVrm({ face: 'full', body: 'full' });
const smooth = (x: number) => { const v = Math.min(1, Math.max(0, x)); return v * v * (3 - 2 * v); };
const SLOTS: StandardBone[] = ['lowerBody', 'upperBody', 'upperBody2', 'neck', 'head', 'armLeft', 'elbowLeft', 'wristLeft', 'armRight', 'elbowRight', 'wristRight',
  'legLeft', 'kneeLeft', 'ankleLeft', 'legRight', 'kneeRight', 'ankleRight'];

test('a VRM has body capsules from its own meshes, each on a VRM bone and named by the standard bone that drives it (the standard mesh alone has none)', async () => {
  const standard = await syntheticStandardBody('1.0', bodyVrm());
  try {
    assert.equal(measureBoneCapsules(standard.mesh).length, 0, 'the cause: the standard skeleton mesh has no vertices');
    const capsules = measureBodyCapsules(standard.mesh), bones = standard.mesh.skeleton.bones;
    for (const slot of SLOTS) {
      const own = standard.model.bone(slot)!;
      const found = capsules.find(capsule => capsule.place === own);
      assert.ok(found, `a capsule on the VRM's ${slot}`);
      assert.equal(bones[found.bone].name, standardName(slot), `${slot} is named by the standard ${standardName(slot)}`);
      assert.ok(found.r > 0.05 && found.r < 0.2 * 12.5, `${slot}: radius ${found.r.toFixed(3)} model units`);
    }
    // Model units like an MMD model's: the forearm tube is 3 cm across its axis (12.5 units per metre).
    const forearm = capsules.find(capsule => capsule.place === standard.model.bone('elbowLeft'))!;
    assert.ok(Math.abs(forearm.r - 0.03 * 12.5) < 0.05, `forearm radius ${forearm.r.toFixed(3)} ≈ ${(0.03 * 12.5).toFixed(3)}`);
    assert.ok(measureBodyCapsules(standard.mesh) === capsules, 'measured once'); // a reference check: never print the capsules (they hold bones)
  } finally { standard.dispose(); }
  assert.equal(measureBodyCapsules(standard.mesh).length, 0, 'a disposed body leaves no source behind');
});

test('her capsules follow the VRM\'s posed bones (arms down after the first frame), not the T pose nor the standard skeleton\'s rest', async () => {
  const v = await windowVrm(bodyVrm());
  try {
    const { standard } = v, capsules = measureBodyCapsules(standard.mesh);
    standard.mesh.updateMatrixWorld(true);
    const ends = capsuleEnds(standard.mesh, capsules, []);
    const at = (slot: StandardBone) => standard.model.bone(slot)!.getWorldPosition(new Vector3());
    const index = capsules.findIndex(capsule => capsule.place === standard.model.bone('elbowLeft'));
    const elbow = at('elbowLeft'), wrist = at('wristLeft');
    assert.ok(elbow.y - wrist.y > 0.1 * 12.5, `her forearm hangs down (elbow ${elbow.y.toFixed(2)}, wrist ${wrist.y.toFixed(2)})`);
    assert.ok(ends[2 * index].distanceTo(elbow) < 1e-3, `the forearm capsule starts at the VRM elbow (${ends[2 * index].distanceTo(elbow).toFixed(4)})`);
    assert.ok(ends[2 * index + 1].distanceTo(wrist) < 1e-3, `and ends at the VRM wrist (${ends[2 * index + 1].distanceTo(wrist).toFixed(4)})`);
  } finally { v.close(); v.standard.dispose(); }
});

/** A full-screen page camera (looking straight down −z, as projectCapsules wants) in front of her. */
function pageView(width = 1600, height = 1000) {
  const U = 12.5, camera = new PerspectiveCamera(30, width / height, 0.05 * U, 100 * U);
  camera.position.set(0, 1.0 * U, 3.2 * U); camera.updateMatrixWorld(true); camera.updateProjectionMatrix();
  const ppu = (ahead: number) => height / (2 * Math.tan(camera.fov * Math.PI / 360) * ahead);
  const screen = (p: Vector3) => { const q = p.clone().project(camera); return { x: (q.x + 1) / 2 * width, y: (1 - q.y) / 2 * height }; };
  return { camera, width, height, ppu, screen };
}

test('full-screen: the page\'s hit test finds a VRM\'s torso, arms, hands and head, misses beside her, and a click reports the part', async () => {
  const v = await windowVrm(bodyVrm());
  try {
    const { standard } = v, view = pageView(), hit = new BodyHit();
    hit.measure(standard.mesh);
    standard.mesh.updateMatrixWorld(true);
    hit.update(standard.mesh, view.camera, view.width, view.height, view.ppu);
    const bone = (slot: StandardBone) => standard.model.bone(slot)!.getWorldPosition(new Vector3());
    const mid = (a: StandardBone, b: StandardBone, k = 0.5) => view.screen(bone(a).lerp(bone(b), k));
    const spots: [string, { x: number; y: number }, string, string | null][] = [
      ['chest', mid('upperBody', 'neck', 0.4), 'torso', null], ['upper arm', mid('armLeft', 'elbowLeft'), 'arm', 'left'],
      ['forearm', mid('elbowLeft', 'wristLeft'), 'arm', 'left'], ['hand', view.screen(bone('wristLeft').add(new Vector3(0, -0.04 * 12.5, 0))), 'hand', 'left'],
      ['right hand', view.screen(bone('wristRight').add(new Vector3(0, -0.04 * 12.5, 0))), 'hand', 'right'], ['head', mid('head', 'head', 0), 'head', null],
    ];
    const reports: UnboundTouchReport[] = [];
    let clock = 0;
    const clicks = new ClickReporter({ nearest: (x, y) => hit.nearest(x, y), names: index => hit.names(index), head: () => null, eligible: () => true,
      send: report => { reports.push(report); }, clock: () => clock });
    for (const [name, p, part, side] of spots) {
      assert.ok(hit.distance(p.x, p.y) <= 0, `${name} is on her (${hit.distance(p.x, p.y).toFixed(1)} px)`);
      reports.length = 0; clock += 1000;
      clicks.down(p.x, p.y); clock += 80; assert.equal(clicks.up(p.x, p.y), true, `a click on her ${name} is reported`);
      assert.equal(reports[0].part, part, `${name}: part`); assert.equal(reports[0].side, side, `${name}: side`);
    }
    const hand = view.screen(bone('wristLeft')), head = view.screen(bone('head'));
    for (const [name, p] of [['beside her hand', { x: hand.x + 120, y: hand.y }], ['above her head', { x: head.x, y: head.y - 200 }], ['the corner', { x: 5, y: 5 }]] as const) {
      assert.ok(hit.distance(p.x, p.y) > 4, `${name} is not on her (${hit.distance(p.x, p.y).toFixed(1)} px)`);
      reports.length = 0; clock += 1000; clicks.down(p.x, p.y); clock += 80;
      assert.equal(clicks.up(p.x, p.y), false, `a click ${name} is not a touch`);
    }
  } finally { v.close(); v.standard.dispose(); }
});

test('an MMD model measures exactly the capsules it measured before (nothing registered for its mesh)', async () => {
  const fixture = await loadPublicGeneForTargets();
  try {
    const before = measureBoneCapsules(fixture.mesh), now = measureBodyCapsules(fixture.mesh);
    assert.ok(before.length > 20, `Gene has capsules (${before.length})`);
    assert.equal(now.length, before.length);
    const numbers = (list: typeof before) => list.flatMap(c => [c.bone, c.a.x, c.a.y, c.a.z, c.b.x, c.b.y, c.b.z, c.r, c.place === undefined ? 0 : 1]);
    const a = numbers(before), b = numbers(now);
    assert.equal(a.length, b.length);
    for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i], `number ${i}`);
    fixture.mesh.updateMatrixWorld(true);
    const ends = capsuleEnds(fixture.mesh, now, []), bones = fixture.mesh.skeleton.bones;
    now.forEach((capsule, i) => assert.ok(ends[2 * i].distanceTo(capsule.a.clone().applyMatrix4(bones[capsule.bone].matrixWorld)) === 0, `capsule ${i} placed by its own bone`));
  } finally { fixture.close(); }
});

// ---- the pull, in both modes, on the real frame loop ------------------------------------------------------------------------------

type Mode = 'full-screen' | 'window';
interface Frame { t: number; rotations: Quaternion[]; wrist: Vector3; pulling: boolean }
const T0 = 2, HOLD = 1.8, AFTER = 3;
/** The forearm pulled up and out by `drag` × her height on the window, held, let go; null: the same run untouched. */
async function pullRun(fps: number, mode: Mode, pull: { x: number; y: number } | null) {
  const v = await windowVrm(bodyVrm());
  const { standard, figure, body } = v, page = pageView();
  const view = mode === 'full-screen' ? { camera: page.camera, width: page.width, height: page.height } : { camera: v.camera, width: v.window.width, height: v.window.height };
  const screen = (p: Vector3) => { const q = p.clone().project(view.camera); return { x: (q.x + 1) / 2 * view.width, y: (1 - q.y) / 2 * view.height }; };
  let clock = 0;
  const full = new UnboundPull({ figure: () => figure, view: () => view, eligible: () => true,
    send: async message => message.phase === 'start' ? parsePullAnswer({ accepted: true, stance: { willing: 0.6, compliance: 1, pace: 1, hesitateMs: 0, resist: 0 }, sleepy: 0 }) : undefined,
    clampX: xM => Math.min(1.5, Math.max(-1.5, xM)), clampDepth: clampFollowDepth, clock: () => clock });
  const windowPull = new WindowPull({ figure: () => figure, view: () => view, shown: () => true, mood: () => null, handBusy: () => false });
  const captured = new Set<number>();
  const surface = { setPointerCapture: (id: number) => { captured.add(id); }, hasPointerCapture: (id: number) => captured.has(id), releasePointerCapture: (id: number) => { captured.delete(id); } };
  const companion = new PetPull(surface as never, { stage: { pullHit: (x, y) => windowPull.hit(x, y), pullStart: hit => windowPull.start(hit as never), pullTo: (x, y) => windowPull.to(x, y), // no-pet-ok: the input class keeps its name
    pullEnd: () => windowPull.end(), pullStillAllowed: group => windowPull.stillAllowed(group), pullMood: () => null, setPullStance: stance => windowPull.setStance(stance) }, send: () => {} }, () => clock);
  const bones = trackedBones(standard), wristBone = standard.model.bone('wristLeft') as Bone;
  const frames: Frame[] = [];
  let from = { x: 0, y: 0 }, heightPx = 0, pressed = false, released = false, partOf = '';
  try {
    for (let frame = 0; frame <= Math.round(fps * (T0 + HOLD + AFTER)); frame++) {
      const t = frame / fps; clock = t * 1000;
      if (pull && !pressed && t >= T0 - 1e-9) {
        standard.mesh.updateMatrixWorld(true);
        from = screen(standard.model.bone('elbowLeft')!.getWorldPosition(new Vector3()).lerp(wristBone.getWorldPosition(new Vector3()), 0.6));
        if (mode === 'full-screen') {
          assert.ok(full.down(from.x, from.y), 'full-screen: the press lands on her');
          heightPx = (full as unknown as { hit: { heightPx: number; part: string } }).hit.heightPx; partOf = (full as unknown as { hit: { part: string } }).hit.part;
        } else {
          const hit = windowPull.hit(from.x, from.y);
          assert.ok(hit, 'window: the press lands on her'); heightPx = hit.heightPx; partOf = hit.part;
          assert.equal(companion.press(1, from), true, 'window: the companion\'s input takes the press as hers');
        }
        pressed = true;
      }
      if (pull && pressed && !released) {
        if (t < T0 + HOLD - 1e-9) {
          const k = smooth((t - T0) / 0.5), x = from.x + pull.x * heightPx * k, y = from.y + pull.y * heightPx * k;
          if (mode === 'full-screen') full.move(x, y); else { companion.move({ x, y }); companion.tick(); }
        } else { if (mode === 'full-screen') full.up(); else companion.release(); released = true; }
      }
      if (mode === 'full-screen') full.frame();
      await Promise.resolve(); await Promise.resolve(); // the host's answer arrives between frames, as over IPC
      body.frame(frame ? 1 / fps : 0, { pointer: { x: 0, y: 0 }, eyes: { x: 0, y: 0.3 }, follow: false, pat: false });
      standard.mesh.updateMatrixWorld(true);
      frames.push({ t, rotations: bones.map(b => b.getWorldQuaternion(new Quaternion())), wrist: wristBone.getWorldPosition(new Vector3()), pulling: mode === 'full-screen' ? full.pulling : companion.active });
    }
    return { frames, part: partOf, heightPx };
  } finally { v.close(); standard.dispose(); }
}

const span = (frames: readonly Frame[], from: number, to: number) => frames.filter(f => f.t >= from - 1e-9 && f.t <= to + 1e-9);
/** Per tracked bone: the largest unexpected step (R29c) over the frames. */
function surprise(frames: readonly Frame[]): number[] {
  const out = VRM_TRACKED.map(() => 0), s = new Quaternion(), l = new Quaternion(), inv = new Quaternion();
  for (let i = 2; i < frames.length; i++) for (let b = 0; b < out.length; b++) {
    s.copy(frames[i].rotations[b]).multiply(inv.copy(frames[i - 1].rotations[b]).invert());
    l.copy(frames[i - 1].rotations[b]).multiply(inv.copy(frames[i - 2].rotations[b]).invert());
    out[b] = Math.max(out[b], s.angleTo(l) * DEG);
  }
  return out;
}
const step = (frames: readonly Frame[]) => Math.max(0, ...frames.slice(1).map((f, i) => Math.max(...f.rotations.map((q, b) => q.angleTo(frames[i].rotations[b]) * DEG))));

for (const mode of ['full-screen', 'window'] as const) {
  for (const fps of [60, 30]) {
    test(`${mode} (${fps} fps): a press-and-drag on a VRM's forearm starts a pull, her own arm follows and comes back, no bone jumps`, async t => {
      const drag = { x: 0.06, y: -0.12 };
      const [control, pulled] = [await pullRun(fps, mode, null), await pullRun(fps, mode, drag)];
      const c = control.frames, e = pulled.frames, edge = 2 / fps, floor = 0.15 * (60 / fps) ** 2;
      assert.ok(['arm', 'hand'].includes(pulled.part), `the part is her arm (${pulled.part})`);
      assert.ok(e.some(f => f.pulling), 'the pull runs');
      const held = e.findIndex(f => f.t >= T0 + HOLD - 0.05), moved = e[held].wrist.distanceTo(c[held].wrist) / 12.5 * 100;
      const end = e.at(-1)!.wrist.distanceTo(c.at(-1)!.wrist) / 12.5 * 100;
      const own = surprise(span(c, T0 - 1, T0 + HOLD + AFTER)), press = surprise(span(e, T0 - edge, T0 + 0.7)), release = surprise(span(e, T0 + HOLD - edge, T0 + HOLD + 0.9));
      const numbers = { part: pulled.part, heightPx: Math.round(pulled.heightPx), wristMovedCm: +moved.toFixed(2), wristEndCm: +end.toFixed(2),
        stepDeg: +step(span(e, T0 - edge, T0 + HOLD + 1.5)).toFixed(3), ownStepDeg: +step(span(c, T0 - edge, T0 + HOLD + 1.5)).toFixed(3),
        pressDeg: +Math.max(...press).toFixed(3), releaseDeg: +Math.max(...release).toFixed(3), ownDeg: +Math.max(...own).toFixed(3) };
      if (REPORT) console.log(`[vrm pull ${mode} ${fps}] ${JSON.stringify(numbers)}`);
      t.diagnostic(JSON.stringify(numbers));
      assert.ok(moved > 3, `her own wrist follows the pull (${moved.toFixed(2)} cm from the untouched run while held)`);
      assert.ok(end < 1, `and comes back after the release (${end.toFixed(2)} cm)`);
      const limit = (b: number) => Math.max(floor, 1.25 * own[b]);
      press.forEach((value, b) => assert.ok(value <= limit(b), `press, ${VRM_TRACKED[b]}: ${value.toFixed(3)}° (own ${own[b].toFixed(3)}°)`));
      release.forEach((value, b) => assert.ok(value <= limit(b), `release, ${VRM_TRACKED[b]}: ${value.toFixed(3)}° (own ${own[b].toFixed(3)}°)`));
    });
  }
}

test('window: the companion\'s input takes a press on a VRM\'s body as a pull and leaves a press beside her alone (the window drag is the toolbar button\'s)', async () => {
  const v = await windowVrm(bodyVrm());
  try {
    const { standard, figure, camera } = v, view = { camera, width: v.window.width, height: v.window.height };
    const windowPull = new WindowPull({ figure: () => figure, view: () => view, shown: () => true, mood: () => null, handBusy: () => false });
    const captured = new Set<number>();
    const surface = { setPointerCapture: (id: number) => { captured.add(id); }, hasPointerCapture: (id: number) => captured.has(id), releasePointerCapture: (id: number) => { captured.delete(id); } };
    const companion = new PetPull(surface as never, { stage: { pullHit: (x, y) => windowPull.hit(x, y), pullStart: hit => windowPull.start(hit as never), pullTo: (x, y) => windowPull.to(x, y), // no-pet-ok: the input class keeps its name
      pullEnd: () => windowPull.end(), pullStillAllowed: group => windowPull.stillAllowed(group) }, send: () => {} }, () => 0);
    standard.mesh.updateMatrixWorld(true);
    const screen = (slot: StandardBone) => { const q = standard.model.bone(slot)!.getWorldPosition(new Vector3()).project(camera); return { x: (q.x + 1) / 2 * view.width, y: (1 - q.y) / 2 * view.height }; };
    assert.equal(companion.press(1, { x: 4, y: 4 }), false, 'beside her: not hers, nothing captured');
    assert.equal(captured.size, 0);
    const chest = screen('upperBody2');
    assert.equal(windowPull.hit(chest.x, chest.y)?.group, 'torso', 'her chest is her torso');
    for (const slot of ['head', 'wristRight', 'kneeLeft'] as const) {
      const p = screen(slot); assert.ok(windowPull.hit(p.x, p.y), `a press on her ${slot} lands on her`);
    }
    assert.equal(companion.press(2, chest), true, 'on her body: the pull takes the pointer');
    companion.cancel();
  } finally { v.close(); v.standard.dispose(); }
});
