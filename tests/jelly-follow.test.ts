/**
 * I-147 全身果冻, layer 2 (src/stage/jelly/follow-through.ts; docs/claude/2026-11-17-whole-body-jelly.md), on a synthetic skeleton:
 * - bounded: the added rotation never exceeds the region's max angle, whatever the motion (soft limit);
 * - never a jump: switching on or off mid-motion, a hard reset with a cut in the pose, and the bound itself add no step;
 * - settles: after the motion stops the offset is gone in about 0.3–0.5 s; a held pose is left exactly as it is;
 * - off is exact: a disabled layer (or one that has faded out) writes nothing; remove() only undoes its own value.
 * The real frame loop (Gene, 60 and 30 fps) is in tests/jelly-follow-stage.test.ts.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Bone, Quaternion, Vector3, type SkinnedMesh } from 'three';
import { FollowThrough, followBones, FADE_SECONDS } from '../src/stage/jelly/follow-through';
import { defaultJellyTuning, normalizeJellyTuning, type FollowTuning } from '../shared/stage/jelly-tuning';

const DEG = 180 / Math.PI;

function body() {
  const make = (name: string, parent: Bone | null, y = 1) => { const bone = new Bone(); bone.name = name; bone.position.set(0, y, 0); parent?.add(bone); return bone; };
  const center = make('センター', null, 0), upper = make('上半身', center), upper2 = make('上半身2', upper), neck = make('首', upper2),
    head = make('頭', neck), shoulder = make('左肩', upper2), arm = make('左腕', shoulder), elbow = make('左ひじ', arm), hair = make('髪1', head);
  const bones = [center, upper, upper2, neck, head, shoulder, arm, elbow, hair];
  const mesh = { skeleton: { bones } } as unknown as SkinnedMesh;
  center.updateMatrixWorld(true);
  return { mesh, bones, center, upper, upper2, neck, head, shoulder, arm, elbow, hair };
}

function on(changes: (tuning: FollowTuning) => void = () => {}): FollowTuning {
  const tuning = defaultJellyTuning().follow; tuning.enabled = true; changes(tuning); return tuning;
}

/** A smooth start–stop turn about y: 0 until t0, eased to `amount` rad over `duration`, then held. */
function turn(t: number, t0 = 0.3, duration = 0.4, amount = 1.2): number {
  const u = Math.min(1, Math.max(0, (t - t0) / duration));
  return amount * u * u * (3 - 2 * u);
}

/** Runs frames: the animation writes the pose, then the layer applies, the "shown" local rotations are read, then removed. */
function run(layer: FollowThrough, bones: Bone[], fps: number, seconds: number, pose: (t: number, bones: Bone[]) => void, start = 0,
  during?: (t: number) => void) {
  const shown: Quaternion[][] = [], animated: Quaternion[][] = [];
  const frames = Math.round(seconds * fps);
  for (let i = 0; i < frames; i++) {
    const t = start + (i + 1) / fps;
    for (const bone of bones) bone.quaternion.identity();
    pose(t, bones);
    animated.push(bones.map(bone => bone.quaternion.clone()));
    during?.(t);
    layer.apply(1 / fps);
    shown.push(bones.map(bone => bone.quaternion.clone()));
    layer.remove();
  }
  return { shown, animated };
}

const headTurn = (t: number, bones: Bone[]) => { bones[4].quaternion.setFromAxisAngle(new Vector3(0, 1, 0), turn(t, 1.3)); };
const armLift = (t: number, bones: Bone[]) => { bones[6].quaternion.setFromAxisAngle(new Vector3(0, 0, 1), turn(t, 0.3, 0.35, 1.4)); };

/** Largest change of the per-frame step (degrees) of one bone's shown rotation: the R29b "surprise". */
function surprise(frames: Quaternion[][], index: number): number {
  let worst = 0;
  const step = new Quaternion(), last = new Quaternion();
  for (let i = 2; i < frames.length; i++) {
    step.copy(frames[i][index]).multiply(frames[i - 1][index].clone().invert());
    last.copy(frames[i - 1][index]).multiply(frames[i - 2][index].clone().invert());
    worst = Math.max(worst, step.angleTo(last) * DEG);
  }
  return worst;
}

test('the bones it moves: trunk, neck, head, shoulders, arms by name; never hair or a bone physics owns', () => {
  const { mesh } = body();
  assert.deepEqual(followBones(mesh).map(entry => `${entry.bone.name}:${entry.region}`),
    ['上半身:spine', '上半身2:spine', '首:neck', '頭:head', '左肩:shoulders', '左腕:arms', '左ひじ:arms']);
  assert.deepEqual(followBones(mesh, new Set([4])).map(entry => entry.bone.name), ['上半身', '上半身2', '首', '左肩', '左腕', '左ひじ']);
});

for (const fps of [60, 30]) {
  test(`a head turn lags, overshoots a little, stays within its bound and settles (${fps} fps)`, () => {
    const { mesh, bones } = body();
    const layer = new FollowThrough(mesh); layer.configure(on());
    run(layer, bones, fps, 1, () => {}); // fade in on a still pose first
    const { shown, animated } = run(layer, bones, fps, 2, headTurn, 1);
    const offsets = shown.map((frame, i) => frame[4].angleTo(animated[i][4]) * DEG);
    const peak = Math.max(...offsets);
    assert.ok(peak > 0.5, `it visibly follows through (${peak.toFixed(2)}°)`);
    assert.ok(peak <= 3 + 1e-9, `never past the head's 3° (${peak.toFixed(3)}°)`);
    // After the turn ends (t = 1.7 s; it starts at 1.3 s), it is gone within half a second.
    const settled = offsets.filter((_, i) => 1 + (i + 1) / fps > 1.7 + 0.5);
    assert.ok(Math.max(...settled) < 0.05 * peak + 0.01, `settled half a second after the turn: ${Math.max(...settled).toFixed(3)}°`);
    // R29d's rule: the shown surprise stays within 1.25x the animation's own (the spring follows the pose like a low pass; near its
    // bound the soft limit bends a little more, never a step).
    const off = surprise(animated, 4), withLayer = surprise(shown, 4);
    assert.ok(withLayer <= off * 1.25 + 1e-6, `within the R29d rule (1.25x the animation's own): ${withLayer.toFixed(4)}° vs animation ${off.toFixed(4)}°`);
  });

  test(`switching on and off mid-motion fades in and out without a step (${fps} fps)`, () => {
    const { mesh, bones } = body();
    const layer = new FollowThrough(mesh);
    const swing = (t: number, list: Bone[]) => { list[6].quaternion.setFromAxisAngle(new Vector3(0, 0, 1), 0.8 * Math.sin(t * 5)); };
    const switched: { at: number; tuning: FollowTuning | null }[] = [{ at: 0.5, tuning: on() }, { at: 1.6, tuning: null }];
    const { shown, animated } = run(layer, bones, fps, 2.6, swing, 0, t => {
      while (switched.length && t >= switched[0].at) layer.configure(switched.shift()!.tuning);
    });
    const offsets = shown.map((frame, i) => frame[6].angleTo(animated[i][6]) * DEG);
    const steps = offsets.slice(1).map((value, i) => Math.abs(value - offsets[i]));
    assert.ok(Math.max(...offsets) > 0.5, 'it does follow through while on');
    // A fade over FADE_SECONDS: no frame changes the offset by more than a smooth ramp would.
    assert.ok(Math.max(...steps) < 5 / (FADE_SECONDS * fps) * 2, `largest per-frame change ${Math.max(...steps).toFixed(3)}°`);
    assert.equal(offsets[Math.round(0.45 * fps)], 0, 'before switching on: exactly the animation');
    const after = Math.round((1.6 + FADE_SECONDS + 0.05) * fps);
    for (let i = after; i < shown.length; i++) assert.ok(shown[i].every((q, b) => q.equals(animated[i][b])), `off again: exact at frame ${i}`);
    assert.equal(layer.idle, true);
  });

  test(`a hard reset with a cut in the pose gives no kick; the shown offset only eases back (${fps} fps)`, () => {
    // A moderate cut (8.6° in one frame: slow enough to pass for motion at 60 fps) at the moment the guard resets.
    const offsetsAfter = (withCut: boolean, reset: boolean) => {
      const fresh = body(), own = new FollowThrough(fresh.mesh); own.configure(on());
      let cut = false;
      const pose = (t: number, list: Bone[]) => { armLift(t, list); if (cut) list[6].quaternion.premultiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.15)); };
      run(own, fresh.bones, fps, 0.55, pose); // mid-lift: the spring is moving
      cut = withCut; if (reset) own.reset();
      const { shown, animated } = run(own, fresh.bones, fps, 1.2, pose, 0.55);
      return shown.map((frame, i) => frame[6].angleTo(animated[i][6]) * DEG);
    };
    const cut = offsetsAfter(true, true), plain = offsetsAfter(false, true), unannounced = offsetsAfter(true, false);
    assert.ok(Math.max(...plain) > 0.3, 'the spring is moving across the reset');
    // Right after the reset, what is shown is exactly what it would be without the cut: no kick; the spring eases on by itself.
    for (let i = 0; i < 2; i++) assert.ok(Math.abs(cut[i] - plain[i]) < 1e-6, `frame ${i}: ${cut[i].toFixed(4)}° with the cut vs ${plain[i].toFixed(4)}° without`);
    if (fps === 60) assert.ok(Math.max(unannounced[0], unannounced[1]) > Math.max(cut[0], cut[1]) + 1, 'without the reset the same cut would kick');
    assert.ok(Math.max(...cut) <= 5 + 1e-9);
  });

  test(`a teleport without a reset is ignored as a cut (too fast to be motion) (${fps} fps)`, () => {
    const { mesh, bones } = body();
    const layer = new FollowThrough(mesh); layer.configure(on());
    run(layer, bones, fps, 1, () => {});
    const { shown, animated } = run(layer, bones, fps, 1, (t, list) => { if (t > 1.5) list[4].quaternion.setFromAxisAngle(new Vector3(0, 1, 0), 2); }, 1);
    const offsets = shown.map((frame, i) => frame[4].angleTo(animated[i][4]) * DEG);
    assert.ok(Math.max(...offsets) < 0.01, `a 115° snap in one frame is not followed through: ${Math.max(...offsets).toFixed(4)}°`);
  });
}

test('a held pose (her pose not moving) is left exactly as it is', () => {
  const { mesh, bones } = body();
  const layer = new FollowThrough(mesh); layer.configure(on());
  const hold = (_: number, list: Bone[]) => { list[4].quaternion.setFromAxisAngle(new Vector3(1, 0, 0), 0.4); list[6].quaternion.setFromAxisAngle(new Vector3(0, 0, 1), 1); };
  const { shown, animated } = run(layer, bones, 60, 2, hold);
  for (let i = 0; i < shown.length; i++) assert.ok(shown[i].every((q, b) => q.angleTo(animated[i][b]) < 1e-9), `frame ${i}`);
});

test('the bound holds under any motion, for every region and its own max angle', () => {
  const { mesh, bones } = body();
  const layer = new FollowThrough(mesh); layer.configure(on(tuning => { tuning.regions.arms.maxDeg = 2; tuning.regions.arms.damping = 0.05; tuning.regions.arms.hz = 0.5; }));
  const violent = (t: number, list: Bone[]) => {
    list[1].quaternion.setFromAxisAngle(new Vector3(0, 1, 0), 0.9 * Math.sin(t * 9));
    list[6].quaternion.setFromAxisAngle(new Vector3(0, 0, 1), 1.4 * Math.sign(Math.sin(t * 4)) * Math.min(1, Math.abs(Math.sin(t * 4)) * 3));
  };
  const { shown, animated } = run(layer, bones, 60, 4, violent);
  const max = [0, 3, 3, 3, 3, 3, 2, 2, 0];
  for (let i = 0; i < shown.length; i++) for (let b = 0; b < bones.length; b++) {
    assert.ok(shown[i][b].angleTo(animated[i][b]) * DEG <= max[b] + 1e-9, `bone ${bones[b].name} frame ${i}: ${(shown[i][b].angleTo(animated[i][b]) * DEG).toFixed(3)}°`);
  }
  assert.equal(shown.every((frame, i) => frame[8].equals(animated[i][8])), true, 'hair is never touched');
});

test('remove() undoes only its own value; a value someone wrote since is kept', () => {
  const { mesh, bones } = body();
  const layer = new FollowThrough(mesh); layer.configure(on());
  run(layer, bones, 60, 0.5, armLift);
  for (const bone of bones) bone.quaternion.identity();
  armLift(0.5 + 1 / 60, bones);
  const animated = bones[6].quaternion.clone();
  layer.apply(1 / 60);
  assert.ok(bones[6].quaternion.angleTo(animated) > 0, 'an offset is on');
  layer.remove();
  assert.ok(bones[6].quaternion.equals(animated), 'its own value comes off exactly');
  layer.apply(1 / 60);
  const replaced = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.7);
  bones[6].quaternion.copy(replaced);
  layer.remove();
  assert.ok(bones[6].quaternion.equals(replaced), 'a value written since is kept');
});

test('hidden: everything clears; shown again it starts from the plain pose and fades in', () => {
  const { mesh, bones } = body();
  const layer = new FollowThrough(mesh); layer.configure(on());
  run(layer, bones, 60, 0.55, armLift);
  assert.ok(layer.getState().maxShownDeg > 0.1);
  layer.hide();
  assert.equal(layer.getState().gain, 0);
  const { shown, animated } = run(layer, bones, 60, 0.2, armLift, 0.55);
  assert.ok(shown[0][6].angleTo(animated[0][6]) * DEG < 0.05, 'the first shown frame is (almost) the plain pose');
});

test('a disabled tuning never touches a bone', () => {
  const { mesh, bones } = body();
  const layer = new FollowThrough(mesh); layer.configure(normalizeJellyTuning({ follow: { enabled: 'yes' } }).follow);
  const { shown, animated } = run(layer, bones, 60, 1, armLift);
  assert.ok(shown.every((frame, i) => frame.every((q, b) => q.equals(animated[i][b]))));
  assert.equal(layer.idle, true);
});
