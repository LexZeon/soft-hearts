import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Bone, Euler, Quaternion } from 'three';
import { BaseSourceWatch, PoseContinuity } from '../src/stage/pose-continuity';

// The bundled CC BY dance is baked at every frame, with authored wrist changes up
// to ~60 degrees per VMD frame. Read-only: original bytes are never modified.
const DANCE = new URL('../assets/bundled/fnoji/fnoji-dances/10b9af30fcc7b0b060138b459ad891f9453ecd23/motions/dance/split-dance.vmd', import.meta.url);

function boneTracks(bytes: Buffer) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), names = new TextDecoder('shift_jis');
  let offset = 30 + (bytes.toString('latin1', 0, 25) === 'Vocaloid Motion Data 0002' ? 20 : 10);
  const count = view.getUint32(offset, true); offset += 4;
  const tracks = new Map<string, { frame: number; q: number[] }[]>();
  for (let i = 0; i < count; i++, offset += 111) {
    const raw = bytes.subarray(offset, offset + 15), end = raw.indexOf(0);
    const name = names.decode(raw.subarray(0, end < 0 ? 15 : end));
    const frame = view.getUint32(offset + 15, true), q = [0, 1, 2, 3].map(k => view.getFloat32(offset + 31 + k * 4, true));
    if (!tracks.has(name)) tracks.set(name, []);
    tracks.get(name)!.push({ frame, q });
  }
  for (const list of tracks.values()) list.sort((a, b) => a.frame - b.frame);
  return tracks;
}
function sample(keys: { frame: number; q: number[] }[], frame: number, out: Quaternion) {
  let i = 1; while (i < keys.length && keys[i].frame < frame) i++;
  if (i >= keys.length || frame <= keys[0].frame) { out.fromArray((frame <= keys[0].frame ? keys[0] : keys.at(-1)!).q); return; }
  const a = keys[i - 1], b = keys[i];
  out.fromArray(a.q).slerp(new Quaternion().fromArray(b.q), (frame - a.frame) / (b.frame - a.frame));
}

for (const fps of [30, 60]) {
  test(`a real baked dance under breathing, gaze and a music nod passes untouched (${fps} FPS)`, () => {
    const tracks = boneTracks(readFileSync(DANCE));
    const names = [...tracks.keys()];
    const bones = names.map(name => Object.assign(new Bone(), { name }));
    const mesh = { skeleton: { bones }, morphTargetInfluences: [] as number[] };
    const guard = new PoseContinuity(mesh, { height: 20 });
    const last = Math.max(...[...tracks.values()].map(list => list.at(-1)!.frame));
    const local = new Quaternion(), euler = new Euler();
    let frames = 0;
    for (let f = 0; f <= Math.ceil(last / 30 * fps); f++, frames++) {
      const t = f / fps;
      names.forEach((name, i) => sample(tracks.get(name)!, f * 30 / fps, bones[i].quaternion));
      guard.captureBase(true); // unchanged mixer playback: authored base
      bones.forEach((bone, i) => {
        // Procedural local layers (rotateBone order): breath, damped gaze-like sway, 8 deg 2 Hz music nod.
        euler.set(Math.sin(t * 1.5 + i) * 0.012 + (i % 3 ? 0 : Math.sin(t * 4 * Math.PI) * 0.14), Math.sin(t * 0.7 + i) * 0.2, Math.sin(t * 2 + i) * 0.03, 'YXZ');
        bone.quaternion.multiply(local.setFromEuler(euler));
      });
      const targets = bones.map(bone => bone.quaternion.toArray());
      guard.apply(1 / fps);
      // Displayed (what the renderer would draw) is bit-identical to the composed target.
      bones.forEach((bone, i) => assert.deepEqual(bone.quaternion.toArray(), targets[i]));
      guard.remove();
    }
    assert.ok(frames > fps * 10, 'a real multi-second performance');
    assert.equal(guard.getState().jumps, 0, 'no authored key or procedural layer is mistaken for a teleport');
  });
}

test('the same dance without trust (a base hand-off frame) would be thresholded; the watch trusts only unchanged playback', () => {
  const watch = new BaseSourceWatch();
  const clip = { duration: 2 };
  const action = { enabled: true, paused: false, time: 0, loop: 2201, getClip: () => clip, getEffectiveWeight: () => 1, getEffectiveTimeScale: () => 1 };
  const mixer = { _actions: [action], _nActiveActions: 1, timeScale: 1 };
  assert.equal(watch.observe(mixer, 1 / 30), false, 'first sight has no history');
  action.time += 1 / 30;
  assert.equal(watch.observe(mixer, 1 / 30), true, 'clock advanced by the frame: authored playback');
  // X-089: going back to 0.01 s from 1/30 s is no loop of a 2 s clip (it would land at 2/30 s): it is a seek.
  action.time = 0.01;
  assert.equal(watch.observe(mixer, 1 / 30), false, 'a backward seek is a hand-off, not a wrap');
  action.time = 1.98;
  assert.equal(watch.observe(mixer, 1 / 30), false, 'a forward seek is a hand-off');
  action.time = 1.98 + 1 / 30 - 2;
  assert.equal(watch.observe(mixer, 1 / 30), true, 'own loop wrap (the frame delta, wrapped by the duration) is still authored');
  action.time += 0.5;
  assert.equal(watch.observe(mixer, 1 / 30), false, 'a seek is a hand-off');
  const otherClip = { duration: 1 }, other = { ...action, getClip: () => otherClip };
  mixer._actions = [action, other]; mixer._nActiveActions = 2; action.time += 1 / 30;
  assert.equal(watch.observe(mixer, 1 / 30), false, 'an action joining is a hand-off');
  action.time += 1 / 30; other.time += 1 / 30;
  assert.equal(watch.observe(mixer, 1 / 30), true);
  const weighted = { ...action, getEffectiveWeight: () => 0.4 };
  mixer._actions = [weighted, other]; weighted.time = action.time + 1 / 30; other.time += 1 / 30;
  assert.equal(watch.observe(mixer, 1 / 30), false, 'a re-weighted (fading/stopped) action is a hand-off');
  assert.equal(watch.observe(null, 1 / 30), false);
});

test('X-089: a wrap is only the action\'s own loop (either direction, ping-pong too); any other jump back is a seek', () => {
  // The clock three r170 AnimationAction._updateTime keeps for repeating and ping-pong loops, at 60 fps.
  for (const loop of [2201, 2202]) for (const timeScale of [1, -1]) {
    const watch = new BaseSourceWatch(), clip = { duration: 1.5 };
    const action = { enabled: true, paused: false, time: 0.4, loop, getClip: () => clip, getEffectiveWeight: () => 1, getEffectiveTimeScale: () => timeScale };
    const mixer = { _actions: [action], _nActiveActions: 1, timeScale: 1 };
    watch.observe(mixer, 1 / 60);
    let wraps = 0;
    for (let frame = 0; frame < 400; frame++) {
      const next = action.time + timeScale / 60, wrapped = next - clip.duration * Math.floor(next / clip.duration);
      if (wrapped !== next) wraps++;
      action.time = wrapped;
      assert.equal(watch.observe(mixer, 1 / 60), true, `loop ${loop} x${timeScale} frame ${frame}`);
    }
    assert.ok(wraps >= 4, 'the loop wrapped several times');
    action.time = Math.min(clip.duration - 0.01, Math.max(0, action.time - 0.3 * timeScale));
    assert.equal(watch.observe(mixer, 1 / 60), false, `loop ${loop} x${timeScale}: a seek against the play direction is a hand-off`);
  }
  // A one-shot action never wraps.
  const watch = new BaseSourceWatch(), clip = { duration: 1 };
  const once = { enabled: true, paused: false, time: 0.99, loop: 2200, getClip: () => clip, getEffectiveWeight: () => 1, getEffectiveTimeScale: () => 1 };
  const mixer = { _actions: [once], _nActiveActions: 1, timeScale: 1 };
  watch.observe(mixer, 1 / 60);
  once.time = 0.99 + 1 / 60 - 1;
  assert.equal(watch.observe(mixer, 1 / 60), false, 'a one-shot action jumping back is a hand-off');
});
