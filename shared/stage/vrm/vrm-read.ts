/**
 * Reads the VRM-specific parts of a GLB into one version-neutral shape (VRM 1.0 vocabulary): humanoid bones, expressions,
 * spring bones and colliders, MToon outline data, meta. VRM 0.x is translated here (bone names, expression presets, spring
 * groups expanded into chains, collider offsets' z flipped, facing −Z), so nothing downstream knows which version it was.
 */
import { VrmImportError, type GltfJson } from './gltf-json';

/** What the reader needs of a GLB: its JSON chunk (the converter passes its parsed GLB; the stage passes GLTFLoader's parser.json). */
export interface GltfDocument { json: GltfJson }

export type Vec3 = [number, number, number];

/** VRM 1.0 humanoid bone names (VRM 0.x thumbs are renamed into these). */
export const HUMAN_BONES = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftEye', 'rightEye', 'jaw',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
  ...(['left', 'right'] as const).flatMap(side => [
    `${side}ThumbMetacarpal`, `${side}ThumbProximal`, `${side}ThumbDistal`,
    ...(['Index', 'Middle', 'Ring', 'Little'] as const).flatMap(finger => [`${side}${finger}Proximal`, `${side}${finger}Intermediate`, `${side}${finger}Distal`]),
  ]),
] as const;
export type HumanBone = typeof HUMAN_BONES[number];
const isHumanBone = (value: string): value is HumanBone => (HUMAN_BONES as readonly string[]).includes(value);

export interface ExpressionBind { mesh: number; index: number; weight: number }
export interface VrmExpression { name: string; preset: boolean; binds: ExpressionBind[]; binary: boolean }
export interface SpringJoint { node: number; hitRadius: number; stiffness: number; gravityPower: number; gravityDir: Vec3; dragForce: number }
export interface VrmSpring { name: string; joints: SpringJoint[]; colliderGroups: number[] }
export interface VrmCollider { node: number; shape: 'sphere' | 'capsule'; offset: Vec3; radius: number; tail?: Vec3 }
export interface VrmOutline { mode: 'none' | 'world' | 'screen'; width: number; color: Vec3 }

export interface VrmSource {
  version: '1.0' | '0.x';
  /** Model facing in glTF space: VRM 1.0 faces +Z, VRM 0.x −Z. */
  facing: 1 | -1;
  name: string;
  authors: string[];
  license: string;
  humanoid: Partial<Record<HumanBone, number>>;
  expressions: VrmExpression[];
  springs: VrmSpring[];
  colliders: VrmCollider[];
  colliderGroups: { name: string; colliders: number[] }[];
  /** glTF material index → outline (MToon); absent when the material has none. */
  outlines: Map<number, VrmOutline>;
  /** How the eyes look around (I-152: read for the stage, not used yet): turning the eye bones, or expressions; the eye point from the head. */
  lookAt: VrmLookAt | null;
}
export interface VrmLookAt {
  type: 'bone' | 'expression'; offsetFromHeadBone: Vec3;
  /**
   * I-152 step 2: how far the eyes turn (bone type, degrees) or how strong the look expression is (expression type, 0..1) for a
   * look this many degrees off centre: output = outputScale × min(1, angle / inputMaxValue). VRM 1.0 rangeMap*, 0.x lookAt* curves
   * (xRange / yRange); a map the file leaves out gets the spec's default (90°, 10° for bones or 1 for expressions).
   */
  ranges: VrmLookAtRanges;
}
export interface VrmLookAtRange { inputMaxValue: number; outputScale: number }
export interface VrmLookAtRanges { horizontalInner: VrmLookAtRange; horizontalOuter: VrmLookAtRange; verticalDown: VrmLookAtRange; verticalUp: VrmLookAtRange }

/** One range map, or the default for this look type; a non-positive input range would divide by zero, so it falls back too. */
function lookAtRange(value: unknown, type: VrmLookAt['type'], input: string, output: string): VrmLookAtRange {
  const map = obj(value), inputMax = num(map?.[input], 90), scale = num(map?.[output], type === 'bone' ? 10 : 1);
  return { inputMaxValue: inputMax > 0 ? inputMax : 90, outputScale: Math.max(0, scale) };
}
function lookAtRanges(source: Obj, type: VrmLookAt['type'], names: [string, string, string, string], input: string, output: string): VrmLookAtRanges {
  const [inner, outer, down, up] = names.map(name => lookAtRange(source[name], type, input, output));
  return { horizontalInner: inner, horizontalOuter: outer, verticalDown: down, verticalUp: up };
}

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : null;
const num = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const vec = (value: unknown, fallback: Vec3): Vec3 => Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every(v => Number.isFinite(v))
  ? [value[0], value[1], value[2]] : obj(value) ? [num(obj(value)!.x, fallback[0]), num(obj(value)!.y, fallback[1]), num(obj(value)!.z, fallback[2])] : fallback;
const str = (value: unknown) => typeof value === 'string' ? value : '';

/** VRM 0.x preset → VRM 1.0 preset name. */
const VRM0_PRESETS: Record<string, string> = {
  a: 'aa', i: 'ih', u: 'ou', e: 'ee', o: 'oh', blink: 'blink', blink_l: 'blinkLeft', blink_r: 'blinkRight',
  joy: 'happy', angry: 'angry', sorrow: 'sad', fun: 'relaxed', surprised: 'surprised', neutral: 'neutral',
  lookup: 'lookUp', lookdown: 'lookDown', lookleft: 'lookLeft', lookright: 'lookRight',
};
/** VRM 0.x thumbs: Proximal/Intermediate/Distal are VRM 1.0's Metacarpal/Proximal/Distal. */
function vrm0BoneName(name: string): string {
  const thumb = /^(left|right)Thumb(Proximal|Intermediate|Distal)$/.exec(name);
  if (!thumb) return name;
  return `${thumb[1]}Thumb${thumb[2] === 'Proximal' ? 'Metacarpal' : thumb[2] === 'Intermediate' ? 'Proximal' : 'Distal'}`;
}

export function readVrm(glb: GltfDocument): VrmSource {
  const extensions = obj(glb.json.extensions) ?? {};
  const vrm1 = obj(extensions.VRMC_vrm), vrm0 = obj(extensions.VRM);
  if (vrm1) return readVrm1(glb, vrm1, obj(extensions.VRMC_springBone));
  if (vrm0) return readVrm0(glb, vrm0);
  throw new VrmImportError('这个 glTF 没有 VRM 扩展（VRMC_vrm 或 VRM）');
}

const nodeCount = (glb: GltfDocument) => glb.json.nodes?.length ?? 0;
const validNode = (glb: GltfDocument, value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) < nodeCount(glb);

function readVrm1(glb: GltfDocument, vrm: Obj, springExtension: Obj | null): VrmSource {
  const meta = obj(vrm.meta) ?? {};
  const humanoid: Partial<Record<HumanBone, number>> = {};
  for (const [name, value] of Object.entries(obj(obj(vrm.humanoid)?.humanBones) ?? {}))
    if (isHumanBone(name) && validNode(glb, obj(value)?.node)) humanoid[name] = obj(value)!.node as number;
  const expressions: VrmExpression[] = [];
  const readExpressions = (group: Obj | null, preset: boolean) => {
    for (const [name, value] of Object.entries(group ?? {})) {
      const expression = obj(value);
      if (!expression) continue;
      const binds: ExpressionBind[] = [];
      for (const bind of Array.isArray(expression.morphTargetBinds) ? expression.morphTargetBinds : []) {
        const entry = obj(bind);
        if (!entry || !validNode(glb, entry.node)) continue;
        const mesh = glb.json.nodes![entry.node as number].mesh;
        if (mesh === undefined || !Number.isInteger(entry.index)) continue;
        binds.push({ mesh, index: entry.index as number, weight: num(entry.weight, 1) });
      }
      expressions.push({ name, preset, binds, binary: expression.isBinary === true });
    }
  };
  readExpressions(obj(obj(vrm.expressions)?.preset), true);
  readExpressions(obj(obj(vrm.expressions)?.custom), false);

  const colliders: VrmCollider[] = [];
  for (const value of Array.isArray(springExtension?.colliders) ? springExtension!.colliders as unknown[] : []) {
    const collider = obj(value), shape = obj(collider?.shape);
    if (!collider || !validNode(glb, collider.node) || !shape) { colliders.push({ node: -1, shape: 'sphere', offset: [0, 0, 0], radius: 0 }); continue; }
    const sphere = obj(shape.sphere), capsule = obj(shape.capsule);
    if (capsule) colliders.push({ node: collider.node as number, shape: 'capsule', offset: vec(capsule.offset, [0, 0, 0]), radius: num(capsule.radius, 0), tail: vec(capsule.tail, [0, 0, 0]) });
    else colliders.push({ node: collider.node as number, shape: 'sphere', offset: vec(sphere?.offset, [0, 0, 0]), radius: num(sphere?.radius, 0) });
  }
  const colliderGroups = (Array.isArray(springExtension?.colliderGroups) ? springExtension!.colliderGroups as unknown[] : []).map((value, index) => {
    const group = obj(value);
    return { name: str(group?.name) || `colliderGroup${index}`, colliders: (Array.isArray(group?.colliders) ? group!.colliders as unknown[] : []).filter((c): c is number => Number.isInteger(c)) };
  });
  const springs: VrmSpring[] = [];
  (Array.isArray(springExtension?.springs) ? springExtension!.springs as unknown[] : []).forEach((value, index) => {
    const spring = obj(value);
    if (!spring) return;
    const joints: SpringJoint[] = [];
    for (const jointValue of Array.isArray(spring.joints) ? spring.joints : []) {
      const joint = obj(jointValue);
      if (!joint || !validNode(glb, joint.node)) continue;
      joints.push({ node: joint.node as number, hitRadius: num(joint.hitRadius, 0), stiffness: num(joint.stiffness, 1), gravityPower: num(joint.gravityPower, 0),
        gravityDir: vec(joint.gravityDir, [0, -1, 0]), dragForce: num(joint.dragForce, 0.5) });
    }
    springs.push({ name: str(spring.name) || `spring${index}`, joints, colliderGroups: (Array.isArray(spring.colliderGroups) ? spring.colliderGroups : []).filter((g): g is number => Number.isInteger(g)) });
  });

  const outlines = new Map<number, VrmOutline>();
  (glb.json.materials ?? []).forEach((material, index) => {
    const mtoon = obj(material.extensions?.VRMC_materials_mtoon);
    if (!mtoon) return;
    const mode = str(mtoon.outlineWidthMode);
    outlines.set(index, { mode: mode === 'worldCoordinates' ? 'world' : mode === 'screenCoordinates' ? 'screen' : 'none',
      width: num(mtoon.outlineWidthFactor, 0), color: vec(mtoon.outlineColorFactor, [0, 0, 0]) });
  });
  return {
    version: '1.0', facing: 1, name: str(meta.name), authors: (Array.isArray(meta.authors) ? meta.authors : []).map(str).filter(Boolean),
    license: str(meta.licenseUrl), humanoid, expressions, springs, colliders, colliderGroups, outlines,
    lookAt: readLookAt1(obj(vrm.lookAt)),
  };
}

function readLookAt1(lookAt: Obj | null): VrmLookAt | null {
  if (!lookAt) return null;
  const type = str(lookAt.type) === 'expression' ? 'expression' : 'bone';
  return { type, offsetFromHeadBone: vec(lookAt.offsetFromHeadBone, [0, 0, 0]),
    ranges: lookAtRanges(lookAt, type, ['rangeMapHorizontalInner', 'rangeMapHorizontalOuter', 'rangeMapVerticalDown', 'rangeMapVerticalUp'], 'inputMaxValue', 'outputScale') };
}

function readVrm0(glb: GltfDocument, vrm: Obj): VrmSource {
  const meta = obj(vrm.meta) ?? {};
  const humanoid: Partial<Record<HumanBone, number>> = {};
  for (const value of Array.isArray(obj(vrm.humanoid)?.humanBones) ? obj(vrm.humanoid)!.humanBones as unknown[] : []) {
    const bone = obj(value), name = vrm0BoneName(str(bone?.bone));
    if (bone && isHumanBone(name) && validNode(glb, bone.node)) humanoid[name] = bone.node as number;
  }
  const expressions: VrmExpression[] = [];
  for (const value of Array.isArray(obj(vrm.blendShapeMaster)?.blendShapeGroups) ? obj(vrm.blendShapeMaster)!.blendShapeGroups as unknown[] : []) {
    const group = obj(value);
    if (!group) continue;
    const presetName = str(group.presetName).toLowerCase();
    const preset = presetName !== '' && presetName !== 'unknown' && VRM0_PRESETS[presetName] !== undefined;
    const binds: ExpressionBind[] = [];
    for (const bindValue of Array.isArray(group.binds) ? group.binds : []) {
      const bind = obj(bindValue);
      if (!bind || !Number.isInteger(bind.mesh) || !Number.isInteger(bind.index)) continue;
      // 0.x weights are 0–100.
      binds.push({ mesh: bind.mesh as number, index: bind.index as number, weight: num(bind.weight, 100) / 100 });
    }
    expressions.push({ name: preset ? VRM0_PRESETS[presetName] : str(group.name) || `expression${expressions.length}`, preset, binds, binary: group.isBinary === true });
  }
  const secondary = obj(vrm.secondaryAnimation) ?? {};
  const colliders: VrmCollider[] = [];
  const colliderGroups = (Array.isArray(secondary.colliderGroups) ? secondary.colliderGroups as unknown[] : []).map((value, index) => {
    const group = obj(value), members: number[] = [];
    for (const colliderValue of Array.isArray(group?.colliders) ? group!.colliders as unknown[] : []) {
      const collider = obj(colliderValue);
      if (!group || !validNode(glb, group.node) || !collider) continue;
      // UniVRM 0.x writes collider offsets with z mirrored (Unity's left-handed space).
      const offset = vec(collider.offset, [0, 0, 0]);
      members.push(colliders.length);
      colliders.push({ node: group.node as number, shape: 'sphere', offset: [offset[0], offset[1], -offset[2]], radius: num(collider.radius, 0) });
    }
    return { name: `colliderGroup${index}`, colliders: members };
  });
  const springs: VrmSpring[] = [];
  const nodes = glb.json.nodes ?? [];
  (Array.isArray(secondary.boneGroups) ? secondary.boneGroups as unknown[] : []).forEach((value, groupIndex) => {
    const group = obj(value);
    if (!group) return;
    const settings = { hitRadius: num(group.hitRadius, 0.02), stiffness: num(group.stiffiness ?? group.stiffness, 1), gravityPower: num(group.gravityPower, 0),
      gravityDir: vec(group.gravityDir, [0, -1, 0]), dragForce: num(group.dragForce, 0.4) };
    const groups = (Array.isArray(group.colliderGroups) ? group.colliderGroups : []).filter((g): g is number => Number.isInteger(g));
    const name = str(group.comment) || `boneGroup${groupIndex}`;
    // Every root's subtree is simulated: one chain per path; a branch starts a new chain hanging from the branch node.
    const walk = (start: number, chain: number[]) => {
      let at = start;
      for (let guard = 0; guard < nodes.length; guard++) {
        chain.push(at);
        const children = (nodes[at]?.children ?? []).filter(child => validNode(glb, child));
        if (!children.length) break;
        for (const branch of children.slice(1)) {
          const sub: number[] = [];
          walk(branch, sub);
          springs.push({ name: `${name}/${springs.length}`, joints: sub.map(node => ({ node, ...settings })), colliderGroups: groups });
        }
        at = children[0];
      }
    };
    for (const root of Array.isArray(group.bones) ? group.bones : []) {
      if (!validNode(glb, root)) continue;
      const chain: number[] = [];
      walk(root as number, chain);
      springs.push({ name: `${name}/${springs.length}`, joints: chain.map(node => ({ node, ...settings })), colliderGroups: groups });
    }
  });
  const outlines = new Map<number, VrmOutline>();
  (Array.isArray(vrm.materialProperties) ? vrm.materialProperties as unknown[] : []).forEach(value => {
    const properties = obj(value);
    if (!properties) return;
    const index = (glb.json.materials ?? []).findIndex(material => material.name === properties.name);
    if (index < 0) return;
    const floats = obj(properties.floatProperties) ?? {}, vectors = obj(properties.vectorProperties) ?? {};
    const mode = num(floats._OutlineWidthMode, 0);
    // MToon 0.x outline width is in centimetres in world mode.
    outlines.set(index, { mode: mode === 1 ? 'world' : mode === 2 ? 'screen' : 'none', width: num(floats._OutlineWidth, 0) * 0.01,
      color: vec(vectors._OutlineColor, [0, 0, 0]) });
  });
  return {
    version: '0.x', facing: -1, name: str(meta.title), authors: str(meta.author) ? [str(meta.author)] : [], license: str(meta.otherLicenseUrl) || str(meta.licenseName),
    humanoid, expressions, springs, colliders, colliderGroups, outlines,
    // 0.x: firstPerson.lookAtTypeName (Bone / BlendShape); its offset is in Unity's space, z mirrored like the collider offsets.
    lookAt: readLookAt0(obj(vrm.firstPerson)),
  };
}

/** 0.x: firstPerson.lookAtTypeName (Bone / BlendShape); its offset is in Unity's space, z mirrored like the collider offsets. */
function readLookAt0(firstPerson: Obj | null): VrmLookAt | null {
  if (!firstPerson) return null;
  const type = str(firstPerson.lookAtTypeName) === 'BlendShape' ? 'expression' : 'bone';
  const offset = vec(firstPerson.firstPersonBoneOffset, [0, 0, 0]);
  return { type, offsetFromHeadBone: [offset[0], offset[1], -offset[2]],
    ranges: lookAtRanges(firstPerson, type, ['lookAtHorizontalInner', 'lookAtHorizontalOuter', 'lookAtVerticalDown', 'lookAtVerticalUp'], 'xRange', 'yRange') };
}
