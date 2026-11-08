import type { SkinnedMesh } from "three";
import type { ModelPhysicsPart, ModelPhysicsPartSupport, ModelPhysicsSupport } from "../../shared/model-physics";

type Triple = [number, number, number];

/** Copies of the loader's physics parameters, never the user's model bytes. */
export interface PhysicsRigidBody {
  boneIndex: number;
  type: number;
  shapeType: number;
  width: number;
  height: number;
  depth: number;
  weight: number;
  position: Triple;
  rotation: Triple;
  friction: number;
  restitution: number;
  positionDamping: number;
  rotationDamping: number;
  groupIndex: number;
  groupTarget: number;
}

export interface PhysicsConstraint {
  rigidBodyIndex1: number;
  rigidBodyIndex2: number;
  position: Triple;
  rotation: Triple;
  translationLimitation1: Triple;
  translationLimitation2: Triple;
  rotationLimitation1: Triple;
  rotationLimitation2: Triple;
  springPosition: Triple;
  springRotation: Triple;
}

export interface PhysicsPartRig {
  readonly part: ModelPhysicsPart;
  readonly support: ModelPhysicsPartSupport;
  readonly rigidBodies: readonly PhysicsRigidBody[];
  readonly constraints: readonly PhysicsConstraint[];
  readonly sourceBodyIndices: readonly number[];
  /** Every dynamic bone the backend can write, including simulation helpers. */
  readonly dynamicBoneIndices: readonly number[];
  /** Dynamic bones with direct skin weights or weighted descendants. */
  readonly outputBoneIndices: readonly number[];
  readonly anchorBoneIndices: readonly number[];
  readonly dynamicBodyCount: number;
  readonly springConstraintCount: number;
}

export interface PhysicsRigPlan {
  readonly support: ModelPhysicsSupport;
  readonly hair: PhysicsPartRig;
  readonly chest: PhysicsPartRig;
}

const HAIR = /髪|髮|头发|頭髮|发尾|发梢|前发|後发|后发|hair|bang|ponytail|twintail|もみあげ|アホ毛|あほ毛|前毛|後毛/iu;
const CHEST = /乳|胸|breast|bust|boob|oppai/iu;
const HEAD = /^(頭|頭部|head|j[_ -]?bip[_ -]?c[_ -]?head)$/iu;
const TORSO = /^(上半身\d*|下半身|腰|spine[\d._ -]*|chest|upperchest|hips|j[_ -]?bip[_ -]?c[_ -]?(?:chest|spine))$/iu;
/**
 * The arm from the upper arm down (twist bones, hands, fingers). Its author ships a
 * "no hand–chest collision" variant. A talking gesture sweeps these collision bodies past the bust: they are left out of the chest's
 * physics world (no contact pushes, and their fast motion is never read as the world's anchor jumping).
 */
const LIMB = /腕|ひじ|肘|手|指|upperarm|lowerarm|forearm|arm|elbow|wrist|hand|finger|thumb|twist/iu;
// These bones always remain animation/input owned, even if their body is dynamic.
const PROTECTED = /^(頭|頭部|首|首根元|上半身\d*|下半身|腰|胸|センター|グルーブ|全ての親|head|neck|root|center|hips|chest|upperchest|spine[\d._ -]*)$|目|眼|まぶた|瞼|眉|口|舌|顎|あご|eye|brow|mouth|jaw|tongue|睫|肩|腕|ひじ|肘|手首|指|足|脚|ひざ|膝|shoulder|upperarm|forearm|wrist|finger|thigh|knee|ankle/iu;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function number(value: unknown, min = -10_000, max = 10_000): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function integer(value: unknown, min: number, max: number): value is number {
  return number(value, min, max) && Number.isInteger(value);
}

function triple(value: unknown, min = -10_000, max = 10_000): Triple | undefined {
  return Array.isArray(value) && value.length === 3 && value.every(v => number(v, min, max))
    ? [value[0], value[1], value[2]] : undefined;
}

function readBody(value: unknown, boneCount: number): PhysicsRigidBody | undefined {
  const p = record(value);
  if (!p || !integer(p.boneIndex, -1, boneCount - 1) || !integer(p.type, 0, 2)
    || !integer(p.shapeType, 0, 2) || !integer(p.groupIndex, 0, 15) || !integer(p.groupTarget, 0, 65535)
    || !number(p.width, 0.000001) || !number(p.height, 0) || !number(p.depth, 0)
    || !number(p.weight, 0) || (p.type !== 0 && p.weight <= 0)
    || (p.shapeType === 1 && (p.height <= 0 || p.depth <= 0))
    || !number(p.friction, 0, 10) || !number(p.restitution, 0, 1)
    || !number(p.positionDamping, 0, 1) || !number(p.rotationDamping, 0, 1)) return undefined;
  const position = triple(p.position);
  const rotation = triple(p.rotation);
  if (!position || !rotation) return undefined;
  return {
    boneIndex: p.boneIndex, type: p.type, shapeType: p.shapeType,
    width: p.width, height: p.height, depth: p.depth, weight: p.weight,
    position, rotation, friction: p.friction, restitution: p.restitution,
    positionDamping: p.positionDamping, rotationDamping: p.rotationDamping,
    groupIndex: p.groupIndex, groupTarget: p.groupTarget,
  };
}

function readConstraint(value: unknown, bodyCount: number): PhysicsConstraint | undefined {
  const p = record(value);
  if (!p || !integer(p.rigidBodyIndex1, 0, bodyCount - 1)
    || !integer(p.rigidBodyIndex2, 0, bodyCount - 1) || p.rigidBodyIndex1 === p.rigidBodyIndex2) return undefined;
  const position = triple(p.position), rotation = triple(p.rotation);
  const translationLimitation1 = triple(p.translationLimitation1), translationLimitation2 = triple(p.translationLimitation2);
  const rotationLimitation1 = triple(p.rotationLimitation1), rotationLimitation2 = triple(p.rotationLimitation2);
  const springPosition = triple(p.springPosition, 0, 1_000_000), springRotation = triple(p.springRotation, 0, 1_000_000);
  if (!position || !rotation || !translationLimitation1 || !translationLimitation2
    || !rotationLimitation1 || !rotationLimitation2 || !springPosition || !springRotation) return undefined;
  return {
    rigidBodyIndex1: p.rigidBodyIndex1, rigidBodyIndex2: p.rigidBodyIndex2,
    position, rotation, translationLimitation1, translationLimitation2,
    rotationLimitation1, rotationLimitation2, springPosition, springRotation,
  };
}

function parents(mesh: SkinnedMesh): number[] {
  const index = new Map(mesh.skeleton.bones.map((bone, i) => [bone, i]));
  return mesh.skeleton.bones.map(bone => index.get(bone.parent as typeof bone) ?? -1);
}

function ancestry(index: number, parentIndices: readonly number[]): number[] {
  const result: number[] = [];
  const seen = new Set<number>();
  while (index >= 0 && !seen.has(index) && result.length <= parentIndices.length) {
    seen.add(index);
    result.push(index);
    index = parentIndices[index] ?? -1;
  }
  return result;
}

function weightedBones(mesh: SkinnedMesh): Set<number> {
  const indices = mesh.geometry.getAttribute("skinIndex");
  const weights = mesh.geometry.getAttribute("skinWeight");
  const result = new Set<number>();
  if (!indices || !weights || indices.count !== weights.count || indices.itemSize !== 4 || weights.itemSize !== 4) return result;
  for (let vertex = 0; vertex < indices.count; vertex++) {
    for (let component = 0; component < 4; component++) {
      const index = indices.getComponent(vertex, component);
      const weight = weights.getComponent(vertex, component);
      if (integer(index, 0, mesh.skeleton.bones.length - 1) && number(weight, 0.000001, 1)) result.add(index);
    }
  }
  return result;
}

function unsupported(part: ModelPhysicsPart, reason: string): PhysicsPartRig {
  return { part, support: { supported: false, bones: 0, bodies: 0, reason }, rigidBodies: [], constraints: [],
    sourceBodyIndices: [], dynamicBoneIndices: [], outputBoneIndices: [], anchorBoneIndices: [], dynamicBodyCount: 0, springConstraintCount: 0 };
}

function collides(a: PhysicsRigidBody, b: PhysicsRigidBody): boolean {
  return Boolean((a.groupTarget & (1 << b.groupIndex)) && (b.groupTarget & (1 << a.groupIndex)));
}

/**
 * Names seed a semantic region; skin weights, ancestry, valid dynamics and an
 * anchored joint component must also agree before a bone can be written.
 * Hair's connected dynamic helpers stay dynamic even when they have no direct
 * skin weights; their component must still contain a weighted hair seed.
 * Nonselected boundary bodies are kinematic copies, never additional outputs.
 */
export function buildPhysicsRigPlan(mesh: SkinnedMesh): PhysicsRigPlan {
  const metadata = record(mesh.geometry.userData.MMD);
  const rawBodies = metadata?.rigidBodies;
  const rawConstraints = metadata?.constraints;
  const absent = (part: ModelPhysicsPart) => unsupported(part, "模型没有可验证的 MMD 刚体与关节结构");
  if (!Array.isArray(rawBodies) || !Array.isArray(rawConstraints) || !mesh.skeleton?.bones.length
    || rawBodies.length > 4096 || rawConstraints.length > 16384) {
    const hair = absent("hair"), chest = absent("chest");
    return { hair, chest, support: { hair: hair.support, chest: chest.support } };
  }
  const bodies = rawBodies.map(value => readBody(value, mesh.skeleton.bones.length));
  const constraints = rawConstraints.map(value => readConstraint(value, bodies.length))
    .filter((value): value is PhysicsConstraint => Boolean(value && bodies[value.rigidBodyIndex1] && bodies[value.rigidBodyIndex2]));
  const parentIndices = parents(mesh);
  const paths = mesh.skeleton.bones.map((_, index) => ancestry(index, parentIndices));
  const weighted = weightedBones(mesh);
  const names = mesh.skeleton.bones.map(bone => bone.name.normalize("NFKC"));

  function plan(part: ModelPhysicsPart): PhysicsPartRig {
    const named = part === "hair" ? HAIR : CHEST;
    const regionAnchor = part === "hair" ? HEAD : TORSO;
    const candidates = new Set<number>();
    const weightedSeeds = new Set<number>();
    for (let index = 0; index < bodies.length; index++) {
      const body = bodies[index];
      if (!body || body.type === 0 || body.boneIndex < 0 || PROTECTED.test(names[body.boneIndex])) continue;
      const path = paths[body.boneIndex];
      const anchorAt = path.findIndex(bone => regionAnchor.test(names[bone]));
      // A semantic seed must sit below a separately identified head/torso anchor.
      if (anchorAt < 1 || !path.slice(0, anchorAt).some(bone => named.test(names[bone]))) continue;
      if (part === "chest" && path.slice(0, anchorAt).some(bone => HEAD.test(names[bone]) || HAIR.test(names[bone]))) continue;
      // An unweighted ancestor may directly drive weighted descendants. Hair
      // also uses unweighted dynamic support bodies connected by joints rather
      // than by the skeleton hierarchy. Excluding those before traversing the
      // component would incorrectly pin them as kinematic boundary bodies.
      const drivesWeights = weighted.has(body.boneIndex)
        || paths.some((other, bone) => weighted.has(bone) && other.includes(body.boneIndex));
      if (!drivesWeights && part !== "hair") continue;
      candidates.add(index);
      if (drivesWeights) weightedSeeds.add(index);
    }

    // Keep only components with both a weighted seed and an external anchor.
    // A disconnected hair-named ornament/helper alone cannot grant support.
    const dynamic = new Set<number>();
    const pending = new Set(candidates);
    while (pending.size) {
      const component = new Set<number>();
      const first = pending.values().next().value as number;
      const queue = [first];
      let anchored = false;
      let weightedComponent = false;
      while (queue.length) {
        const index = queue.pop()!;
        if (component.has(index)) continue;
        component.add(index);
        pending.delete(index);
        if (weightedSeeds.has(index)) weightedComponent = true;
        for (const joint of constraints) {
          const other = joint.rigidBodyIndex1 === index ? joint.rigidBodyIndex2
            : joint.rigidBodyIndex2 === index ? joint.rigidBodyIndex1 : -1;
          if (other < 0) continue;
          if (candidates.has(other)) queue.push(other);
          else {
            const anchor = bodies[other]!;
            const body = bodies[index]!;
            if (anchor.type === 0 || (anchor.boneIndex >= 0 && paths[body.boneIndex].slice(1).includes(anchor.boneIndex))) anchored = true;
          }
        }
      }
      if (anchored && weightedComponent) for (const index of component) dynamic.add(index);
    }
    if (!dynamic.size) return unsupported(part, part === "hair"
      ? "模型缺少带权重和有效锚点连接的头发物理结构"
      : "模型缺少带权重和有效锚点连接的胸部物理结构");

    const included = new Set(dynamic);
    // Every retained joint has both ends. Boundary bodies follow animation.
    const selectedConstraints = constraints.filter(joint => dynamic.has(joint.rigidBodyIndex1) || dynamic.has(joint.rigidBodyIndex2));
    for (const joint of selectedConstraints) {
      included.add(joint.rigidBodyIndex1);
      included.add(joint.rigidBodyIndex2);
    }
    // Preserve original kinematic collision shapes with compatible masks.
    // Disconnected dynamic clothing is deliberately never activated as collateral.
    bodies.forEach((body, index) => {
      if (body?.type !== 0 || (part === "chest" && body.boneIndex >= 0 && LIMB.test(names[body.boneIndex]))) return;
      if ([...dynamic].some(other => collides(body, bodies[other]!))) included.add(index);
    });
    const sourceBodyIndices = [...included].sort((a, b) => a - b);
    const remap = new Map(sourceBodyIndices.map((index, i) => [index, i]));
    const dynamicBoneIndices = [...new Set([...dynamic].map(index => bodies[index]!.boneIndex))].sort((a, b) => a - b);
    const outputBoneIndices = [...new Set([...dynamic].filter(index => weightedSeeds.has(index))
      .map(index => bodies[index]!.boneIndex))].sort((a, b) => a - b);
    // Anchors are the bodies a dynamic body hangs from (a selected joint), not collision-only shapes: a hand sweeping fast past
    // the hair or the bust is not the world's anchor jumping (that reset the world and kicked the output, 14.8° in one frame).
    const jointed = new Set(selectedConstraints.flatMap(joint => [joint.rigidBodyIndex1, joint.rigidBodyIndex2]).filter(index => !dynamic.has(index)));
    const anchorBoneIndices = [...new Set([...jointed].sort((a, b) => a - b)
      .map(index => bodies[index]!.boneIndex).filter(index => index >= 0))];
    const rigidBodies = sourceBodyIndices.map(index => {
      const body = bodies[index]!;
      return { ...body, position: [...body.position] as Triple, rotation: [...body.rotation] as Triple,
        type: dynamic.has(index) ? body.type : 0, weight: dynamic.has(index) ? body.weight : 0 };
    });
    const selected = selectedConstraints.map(joint => ({ ...joint,
      rigidBodyIndex1: remap.get(joint.rigidBodyIndex1)!, rigidBodyIndex2: remap.get(joint.rigidBodyIndex2)! }));
    const support: ModelPhysicsPartSupport = { supported: true, bones: outputBoneIndices.length, bodies: dynamic.size, reason: null };
    return { part, support, rigidBodies, constraints: selected, sourceBodyIndices, dynamicBoneIndices, outputBoneIndices, anchorBoneIndices,
      dynamicBodyCount: dynamic.size, springConstraintCount: selected.filter(joint => [...joint.springPosition, ...joint.springRotation].some(value => value > 0)).length };
  }

  const hair = plan("hair"), chest = plan("chest");
  return { hair, chest, support: { hair: hair.support, chest: chest.support } };
}

/** Safe to call before an Ammo download/initialization or any world allocation. */
export function probeModelPhysicsSupport(mesh: SkinnedMesh): ModelPhysicsSupport {
  return buildPhysicsRigPlan(mesh).support;
}
