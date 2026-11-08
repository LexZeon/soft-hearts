// R29 micro-benchmark: per-frame cost of the display-continuity guard on a
// Gene-sized rig (224 bones, 184 morphs; real three Bones so quaternion.set
// pays its Euler sync). Run (the tsx CLI would not pass --expose-gc on):
//   node --expose-gc --import ./node_modules/tsx/dist/esm/index.mjs scripts/bench-pose-continuity.ts
import { Bone, Euler, Quaternion } from 'three';
import { BaseSourceWatch, PoseContinuity } from '../src/stage/pose-continuity';

const BONES = 224, MORPHS = 184, FRAMES = 20_000;
const bones = Array.from({ length: BONES }, (_, i) => Object.assign(new Bone(), { name: `b${i}` }));
const mesh = { skeleton: { bones }, morphTargetInfluences: new Array<number>(MORPHS).fill(0.5) };
const guard = new PoseContinuity(mesh, { height: 20, excludedBones: [100, 101, 102, 103], excludedMorphs: [88, 123] });
const watch = new BaseSourceWatch();
const euler = new Euler(), local = new Quaternion();
const clip = { duration: 8 };
const action = { enabled: true, paused: false, time: 0, loop: 2201, getClip: () => clip, getEffectiveWeight: () => 1, getEffectiveTimeScale: () => 1 };
const mixer = { _actions: [action], _nActiveActions: 1, timeScale: 1 };
const gc = (globalThis as { gc?: () => void }).gc;
const times = new Float64Array(FRAMES);
const dt = 1 / 30;

/** All bones move every frame (worst case for detection); `jumpEvery` hands every property off at once. */
function frame(f: number, jumpEvery: number, timed: boolean): void {
  const t = f * dt;
  for (let i = 0; i < BONES; i++) bones[i].quaternion.setFromEuler(euler.set(Math.sin(t * 2 + i) * 0.4, Math.cos(t * 1.3 + i) * 0.3, i * 0.01));
  action.time = (action.time + dt) % clip.duration;
  const hop = jumpEvery > 0 && f % jumpEvery === 0 ? 0.4 : 0;
  const start = timed ? performance.now() : 0;
  guard.captureBase(watch.observe(mixer, dt));
  const captured = timed ? performance.now() - start : 0;
  for (let i = 0; i < BONES; i++) bones[i].quaternion.multiply(local.setFromEuler(euler.set(0.05 * Math.sin(t * 3) + hop, 0, 0)));
  if (hop) for (let i = 0; i < MORPHS; i++) mesh.morphTargetInfluences[i] = 1 - mesh.morphTargetInfluences[i];
  const applyStart = timed ? performance.now() : 0;
  guard.apply(dt);
  guard.remove();
  if (timed) times[f] = captured + performance.now() - applyStart;
}

function run(label: string, jumpEvery: number, report = true): void {
  for (let f = 0; f < FRAMES; f++) frame(f, jumpEvery, true);
  // Untimed pass: heap growth before any collection is garbage made per frame
  // (the harness itself allocates nothing; performance.now() would box).
  gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  for (let f = 0; f < FRAMES; f++) frame(f, jumpEvery, false);
  const allocated = (process.memoryUsage().heapUsed - heapBefore) / FRAMES;
  if (!report) return;
  const sorted = Float64Array.from(times).sort();
  const us = (q: number) => (sorted[Math.floor(q * (FRAMES - 1))] * 1000).toFixed(1);
  console.log(`${label}: guard p50 ${us(0.5)} us, p99 ${us(0.99)} us per frame; allocated ${allocated.toFixed(1)} B/frame${gc ? '' : ' (run with --expose-gc for a clean figure)'}`);
}

run('warm-up', 10, false);
run('steady (all bones moving, no hand-off)', 0);
run('hand-off storm (every property every 10 frames)', 10);
