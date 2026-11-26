/**
 * Spring bones → PMX rigid bodies and joints, in the shape the stage's physics (src/stage/physics-rig.ts: Ammo and the
 * spring-bone solver) recognises: each chain segment a dynamic capsule on its bone (mode 2, like Gene's hair), the chain
 * hung from a kinematic anchor on the bone it grows from by a spring joint, consecutive segments jointed; VRM colliders
 * as kinematic spheres/capsules on their bones.
 *
 * Collision groups: colliders by body region (0 head, 1 torso, 2 arms, 3 legs, 4 other), 14 anchors (collide with nothing),
 * 15 dynamic bodies (never each other). A dynamic body collides only with the regions of its chain's colliders that it
 * does not already overlap at rest: hair roots start inside the head sphere in VRM (where colliders only push the tail
 * points), and an overlapping rigid capsule would be thrown out on the first step.
 *
 * Parameters are a first mapping from VRM's springs, not a match: drag → damping, stiffness → joint angle limits and a
 * rotation spring, hitRadius → capsule radius; gravity power is left to the physics world. The physics lab tunes from here.
 */
import { Euler, Quaternion, Vector3 } from 'three';
import type { VrmPmxMapping } from './mapping';
import type { PmxJoint, PmxRigidBody, Vec3 } from './pmx-model';
import { originOf, type SceneNodes } from './scene';
import type { Skeleton } from './skeleton';

const GROUP = { head: 0, torso: 1, arm: 2, leg: 3, other: 4, anchor: 14, dynamic: 15 } as const;
const ALL = 0xffff;

/** Node indices the physics mapping needs as bones (chain bones and collider bones). */
export function physicsNodes(physics: VrmPmxMapping['physics'], nodeNames: readonly string[]): Set<number> {
  const out = new Set<number>();
  if (!physics) return out;
  const index = (name: string) => nodeNames.indexOf(name);
  for (const chain of physics.chains) for (const bone of chain.bones) if (index(bone) >= 0) out.add(index(bone));
  for (const collider of physics.colliders) if (index(collider.bone) >= 0) out.add(index(collider.bone));
  return out;
}

function regionOf(boneName: string): number {
  if (/^(頭|首|両目|左目|右目)$/.test(boneName)) return GROUP.head;
  if (/^(上半身\d?|下半身|[左右]肩)$/.test(boneName)) return GROUP.torso;
  if (/^[左右](腕|腕捩|ひじ|手捩|手首|親指|人指|中指|薬指|小指)/.test(boneName)) return GROUP.arm;
  if (/^[左右](足|ひざ|足首|つま先)$/.test(boneName)) return GROUP.leg;
  return GROUP.other;
}

const tuple = (v: Vector3): Vec3 => [v.x, v.y, v.z];
/** Euler XYZ (Three) of the rotation taking +Y to `direction`. */
function alongY(direction: Vector3): Vec3 {
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction.clone().normalize());
  const e = new Euler().setFromQuaternion(q, 'XYZ');
  return [e.x, e.y, e.z];
}

interface Shape { kind: 'sphere' | 'capsule'; a: Vector3; b: Vector3; radius: number }
/** Closest distance between two segments (a sphere is a zero-length segment). */
function segmentDistance(p1: Vector3, q1: Vector3, p2: Vector3, q2: Vector3): number {
  const d1 = q1.clone().sub(p1), d2 = q2.clone().sub(p2), r = p1.clone().sub(p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
  let s = 0, t = 0;
  if (a <= 1e-12 && e <= 1e-12) return p1.distanceTo(p2);
  if (a <= 1e-12) t = Math.min(1, Math.max(0, f / e));
  else {
    const c = d1.dot(r);
    if (e <= 1e-12) s = Math.min(1, Math.max(0, -c / a));
    else {
      const b = d1.dot(d2), denom = a * e - b * b;
      s = denom > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); } else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  return p1.clone().addScaledVector(d1, s).distanceTo(p2.clone().addScaledVector(d2, t));
}
const overlaps = (x: Shape, y: Shape) => segmentDistance(x.a, x.b, y.a, y.b) < x.radius + y.radius;

export interface PhysicsResult { bodies: PmxRigidBody[]; joints: PmxJoint[]; chains: number; colliders: number; skipped: string[] }

export function buildPhysics(physics: NonNullable<VrmPmxMapping['physics']>, scene: SceneNodes, skeleton: Skeleton, nodeNames: readonly string[], unitsPerMeter: number): PhysicsResult {
  const bodies: PmxRigidBody[] = [], joints: PmxJoint[] = [], skipped: string[] = [];
  const nodeIndex = (name: string) => nodeNames.indexOf(name);
  const posed = (node: number) => originOf(scene.model[node]).applyMatrix4(skeleton.pose[skeleton.nodeBone[node]]);
  const boneName = (bone: number) => skeleton.bones[bone]?.name ?? '';
  const names = new Set<string>();
  const unique = (name: string) => { let out = name, k = 2; while (names.has(out)) out = `${name}_${k++}`; names.add(out); return out; };

  // Colliders: kinematic bodies on their bones.
  const colliderShapes = new Map<string, { shape: Shape; group: number }>();
  for (const collider of physics.colliders) {
    const node = nodeIndex(collider.bone);
    if (node < 0 || skeleton.nodeBone[node] < 0) { skipped.push(`碰撞体 ${collider.name}：找不到骨骼 ${collider.bone}`); continue; }
    const bone = skeleton.nodeBone[node], matrix = skeleton.pose[bone].clone().multiply(scene.model[node]);
    const a = new Vector3(...collider.offset).applyMatrix4(matrix);
    const b = collider.shape === 'capsule' && collider.tail ? new Vector3(...collider.tail).applyMatrix4(matrix) : a.clone();
    const radius = collider.radius * unitsPerMeter, group = regionOf(boneName(bone));
    if (!(radius > 0)) continue;
    const length = a.distanceTo(b);
    bodies.push({
      name: unique(collider.name), nameEn: collider.name, bone, group, mask: ALL, shape: length > 1e-6 ? 2 : 0, size: [radius, length, 0],
      position: tuple(a.clone().lerp(b, 0.5)), rotation: length > 1e-6 ? alongY(b.clone().sub(a)) : [0, 0, 0],
      mass: 1, linearDamping: 0.5, angularDamping: 0.5, restitution: 0, friction: 0.5, mode: 0,
    });
    colliderShapes.set(collider.name, { shape: { kind: length > 1e-6 ? 'capsule' : 'sphere', a, b, radius }, group });
  }
  const colliderCount = bodies.length;

  // Chain segments: a dynamic capsule from each bone to the next.
  interface Segment { body: number; head: Vector3; stiffness: number; chain: number }
  const segmentOfBone = new Map<number, Segment>();
  const chainSegments: Segment[][] = [];
  const anchors: (number | null)[] = [];
  physics.chains.forEach((chain, chainIndex) => {
    const nodes = chain.bones.map(nodeIndex);
    const missing = chain.bones.filter((_, k) => nodes[k] < 0 || skeleton.nodeBone[nodes[k]] < 0);
    if (missing.length) { skipped.push(`链 ${chain.name}：找不到骨骼 ${missing.join('、')}`); chainSegments.push([]); anchors.push(null); return; }
    const segments: Segment[] = [];
    const allowed = new Set(chain.colliders.map(name => colliderShapes.get(name)?.group).filter((group): group is number => group !== undefined));
    for (let k = 0; k + 1 < nodes.length; k++) {
      const bone = skeleton.nodeBone[nodes[k]];
      if (segmentOfBone.has(bone)) { skipped.push(`链 ${chain.name}：骨骼 ${boneName(bone)} 已经在别的链里`); break; }
      const head = posed(nodes[k]), tail = posed(nodes[k + 1]), length = head.distanceTo(tail);
      if (!(length > 1e-4)) { skipped.push(`链 ${chain.name}：${boneName(bone)} 太短`); break; }
      const radius = Math.max(0.05, Math.min(chain.hitRadius * unitsPerMeter, length * 0.5));
      const shape: Shape = { kind: 'capsule', a: head, b: tail, radius };
      let mask = 0;
      for (const group of allowed) {
        const touching = [...colliderShapes.values()].some(entry => entry.group === group && overlaps(shape, entry.shape));
        if (!touching) mask |= 1 << group;
      }
      // Gene's hair: roots damped about 0.6–1, tips 0.999. Drag sets the root; damping rises toward the tip so a chain settles after a stop.
      const root = Math.min(0.97, 0.85 + 0.15 * chain.drag), damping = root + (0.99 - root) * (nodes.length > 2 ? k / (nodes.length - 2) : 0);
      bodies.push({
        name: unique(boneName(bone)), nameEn: chain.name, bone, group: GROUP.dynamic, mask, shape: 2, size: [radius, length, 0],
        position: tuple(head.clone().lerp(tail, 0.5)), rotation: alongY(tail.clone().sub(head)),
        mass: Math.max(0.2, 2 * Math.pow(0.7, k)), linearDamping: damping, angularDamping: damping, restitution: 0, friction: 0, mode: 2,
      });
      const segment = { body: bodies.length - 1, head, stiffness: chain.stiffness, chain: chainIndex };
      segments.push(segment); segmentOfBone.set(bone, segment);
    }
    chainSegments.push(segments);
    anchors.push(segments.length ? skeleton.bones[skeleton.nodeBone[nodes[0]]].parent : null);
  });

  // Joints: anchor (a kinematic body on the parent bone, or the parent's own segment) → first segment, then segment → segment.
  const anchorBody = new Map<number, number>();
  const joint = (name: string, a: number, b: number, at: Vector3, stiffness: number) => {
    const limit = Math.min(Math.PI / 3, Math.max(Math.PI / 18, (Math.PI * 7 / 18) / (1 + stiffness)));
    const spring = Math.max(0, 50 * stiffness);
    joints.push({ name: unique(name), nameEn: name, bodyA: a, bodyB: b, position: tuple(at), rotation: [0, 0, 0],
      translationLimit: [0, 0, 0], rotationLimit: [limit, limit * 0.3, limit], springTranslation: [0, 0, 0], springRotation: [spring, spring, spring] });
  };
  chainSegments.forEach((segments, chainIndex) => {
    if (!segments.length) return;
    const parentBone = anchors[chainIndex]!;
    let from = segmentOfBone.get(parentBone)?.body;
    if (from === undefined) {
      from = anchorBody.get(parentBone);
      if (from === undefined) {
        bodies.push({
          name: unique(`${boneName(parentBone)}_anchor`), nameEn: 'anchor', bone: parentBone, group: GROUP.anchor, mask: 0, shape: 0, size: [0.1, 0, 0],
          position: tuple(segments[0].head), rotation: [0, 0, 0], mass: 1, linearDamping: 0.5, angularDamping: 0.5, restitution: 0, friction: 0.5, mode: 0,
        });
        from = bodies.length - 1;
        anchorBody.set(parentBone, from);
      }
    }
    segments.forEach((segment, k) => {
      joint(bodies[segment.body].name, k === 0 ? from! : segments[k - 1].body, segment.body, segment.head, segment.stiffness);
    });
  });
  return { bodies, joints, chains: chainSegments.filter(segments => segments.length).length, colliders: colliderCount, skipped };
}
