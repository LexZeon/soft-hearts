/**
 * I-152 step 3 (docs/claude/2026-11-21-vrm-physics.md): the synthetic VRM with a hair chain and a long skirt (tests/helpers/synthetic-vrm.ts
 * `skirt`, a body with volume so her leg capsules are measured from her mesh; nothing from a real model) on her real window frame loop
 * (WindowBody → figure → StandardBody.present(physicsDelta) → its springs), at a fixed fps. A script turns her, walks her, places her
 * somewhere else or pulls her head; every frame records what the springs drew.
 */
import { Quaternion, Vector3, type Bone } from 'three';
import { normalizeModelPhysicsSettings, type ModelPhysicsSettings } from '../../shared/stage/model-physics';
import { nearestOnSegment } from '../../src/stage/vrm-spring/spring-rig';
import type { VrmSpringPhysics } from '../../src/stage';
import { windowVrm } from './unbound-vrm';
import { syntheticVrm } from './synthetic-vrm';

const DEG = 180 / Math.PI;
export const PHYSICS_ON: ModelPhysicsSettings = normalizeModelPhysicsSettings({ hair: { enabled: true, strength: 1 }, chest: { enabled: true, strength: 1 }, quality: 'standard' });
export const PHYSICS_OFF: ModelPhysicsSettings = normalizeModelPhysicsSettings({ hair: { enabled: false, strength: 1 }, chest: { enabled: false, strength: 1 }, quality: 'standard' });

export interface SpringScriptContext { t: number; figure: Awaited<ReturnType<typeof windowVrm>>['figure']; pull(dx: number, dy: number): void; release(): void; springs: VrmSpringPhysics }
export interface SpringFrame {
  t: number;
  /** The hair's swing: its tip seen from its root, in the head's own frame, against the rest pose (degrees). */
  hairSwing: number;
  /** The skirt's largest swing at its hem (degrees, in the hips' frame). */
  skirtSwing: number;
  /** Nearest any skirt tail comes to a leg capsule's surface (metres; < 0: inside her leg). */
  legClearance: number;
  /** World rotations of every spring bone (for the unexpected step). */
  rotations: Quaternion[];
  /** Largest |tail − head| − length over the joints (metres): the chain kept its shape. */
  lengthError: number;
  finite: boolean;
  ms: number;
  /** Her hips' heading turned more than 0.3° since the last frame (scaled to 60 fps): she is still turning. */
  moving: boolean;
}

export async function springRun(fps: number, seconds: number, options: { settings?: ModelPhysicsSettings; version?: '1.0' | '0.x'; script?: (ctx: SpringScriptContext) => void } = {}) {
  const v = await windowVrm(syntheticVrm({ body: 'full', skirt: true, ...(options.version ? { version: options.version } : {}) }));
  const { standard, figure, body } = v;
  const springs = standard.springs!;
  standard.configurePhysics(options.settings ?? PHYSICS_ON);
  const view = { camera: v.camera, width: v.window.width, height: v.window.height };
  const screen = (p: Vector3) => { const q = p.clone().project(view.camera); return { x: (q.x + 1) / 2 * view.width, y: (1 - q.y) / 2 * view.height }; };
  let pulling: { x: number; y: number } | null = null;
  const head = standard.model.bone('head')!, hips = standard.model.bone('lowerBody')!;
  const chains = springs.rig.chains, hair = chains.find(chain => chain.name.startsWith('Hair'))!, skirt = chains.filter(chain => chain.name.startsWith('Skirt'));
  const legs = springs.rig.colliders.filter(collider => collider.added && collider.bone !== hips);
  const bones = chains.flatMap(chain => chain.joints.map(joint => joint.bone));
  const tipOf = (chain: typeof hair) => { const last = chain.joints[chain.joints.length - 1]; return last.axis.clone().multiplyScalar(last.length).applyMatrix4(last.bone.matrixWorld); };
  const inFrame = (frame: Bone, p: Vector3) => frame.worldToLocal(p.clone());
  standard.mesh.updateMatrixWorld(true);
  const restOf = (chain: typeof hair, frame: Bone) => inFrame(frame, tipOf(chain)).sub(inFrame(frame, chain.joints[0].bone.getWorldPosition(new Vector3())));
  // The rest pose (springs not yet run: present() at settle with dt 0 wrote the rest rotations).
  const hairRest = restOf(hair, head), skirtRest = skirt.map(chain => restOf(chain, hips));
  const swing = (chain: typeof hair, frame: Bone, rest: Vector3) => restOf(chain, frame).angleTo(rest) * DEG;
  const frames: SpringFrame[] = [];
  const ctx: SpringScriptContext = { t: 0, figure, springs,
    pull(dx, dy) {
      standard.mesh.updateMatrixWorld(true);
      if (!pulling) {
        const from = screen(head.getWorldPosition(new Vector3()));
        const hit = figure.pullHit(view, from.x, from.y);
        if (!hit || !figure.pullStart(hit, view)) throw new Error('the press did not land on her head');
        pulling = from;
      }
      figure.pullTo(view, pulling.x + dx, pulling.y + dy);
    },
    release() { if (pulling) { figure.pullEnd(); pulling = null; } } };
  const scale = () => standard.model.object.matrixWorld.getMaxScaleOnAxis();
  let lastHips: Quaternion | null = null;
  try {
    for (let frame = 0; frame <= Math.round(fps * seconds); frame++) {
      ctx.t = frame / fps;
      options.script?.(ctx);
      body.frame(frame ? 1 / fps : 0, { pointer: { x: 0, y: 0 }, eyes: { x: 0, y: 0.3 }, follow: false, pat: false });
      standard.mesh.updateMatrixWorld(true);
      const s = scale();
      let clearance = Infinity, lengthError = 0, finite = true;
      const a = new Vector3(), b = new Vector3(), w = new Vector3();
      for (const chain of skirt) for (const joint of chain.joints) {
        const tail = joint.axis.clone().multiplyScalar(joint.length).applyMatrix4(joint.bone.matrixWorld);
        for (const leg of legs) {
          a.copy(leg.offset).applyMatrix4(leg.bone.matrixWorld); b.copy(leg.tail ?? leg.offset).applyMatrix4(leg.bone.matrixWorld);
          clearance = Math.min(clearance, (tail.distanceTo(nearestOnSegment(tail, a, b, w)) - leg.radiusM * s) / s);
        }
      }
      for (const chain of chains) for (const joint of chain.joints) {
        const head = joint.bone.getWorldPosition(new Vector3()), tail = joint.axis.clone().multiplyScalar(joint.length).applyMatrix4(joint.bone.matrixWorld);
        lengthError = Math.max(lengthError, Math.abs(head.distanceTo(tail) / s - joint.length));
        if (![tail.x, tail.y, tail.z].every(Number.isFinite)) finite = false;
      }
      frames.push({ t: ctx.t, hairSwing: swing(hair, head, hairRest), skirtSwing: Math.max(...skirt.map((chain, k) => swing(chain, hips, skirtRest[k]))), legClearance: clearance,
        rotations: bones.map(bone => bone.getWorldQuaternion(new Quaternion())), lengthError, finite, ms: springs.lastMs,
        moving: lastHips !== null && hips.getWorldQuaternion(new Quaternion()).angleTo(lastHips) * DEG * (fps / 60) > 0.3 });
      lastHips = hips.getWorldQuaternion(new Quaternion());
    }
  } finally { v.close(); }
  return { frames, springs: { chains: chains.length, joints: bones.length, colliders: springs.rig.colliders.length, bodyColliders: springs.rig.bodyColliders } };
}

/** R29c's unexpected step on the spring bones, largest over frames in [from, to] (degrees). */
export function springSurprise(frames: readonly SpringFrame[], from = 0, to = Infinity): number {
  let out = 0;
  const s = new Quaternion(), l = new Quaternion(), inv = new Quaternion();
  for (let i = 2; i < frames.length; i++) {
    if (frames[i].t < from - 1e-9 || frames[i].t > to + 1e-9) continue;
    for (let b = 0; b < frames[i].rotations.length; b++) {
      s.copy(frames[i].rotations[b]).multiply(inv.copy(frames[i - 1].rotations[b]).invert());
      l.copy(frames[i - 1].rotations[b]).multiply(inv.copy(frames[i - 2].rotations[b]).invert());
      out = Math.max(out, s.angleTo(l) * DEG);
    }
  }
  return out;
}
export const span = (frames: readonly SpringFrame[], from: number, to: number) => frames.filter(f => f.t >= from - 1e-9 && f.t <= to + 1e-9);
export const peak = (frames: readonly SpringFrame[], key: 'hairSwing' | 'skirtSwing') => Math.max(0, ...frames.map(f => f[key]));
/** Seconds from `from` (default: the last frame her body moved) until the hair and skirt stay within `band` degrees of where they end. */
export function settleTime(frames: readonly SpringFrame[], from = Math.max(0, ...frames.filter(f => f.moving).map(f => f.t)), band = 0.5): number {
  const tail = frames[frames.length - 1];
  let last = from;
  for (const f of frames) if (f.t >= from && (Math.abs(f.hairSwing - tail.hairSwing) > band || Math.abs(f.skirtSwing - tail.skirtSwing) > band)) last = f.t;
  return last - from;
}
