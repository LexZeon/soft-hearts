/**
 * The PMX model the converter builds, in Three's space (what MMDLoader hands the stage after its left-to-right flip:
 * right-handed, +Y up, the model facing +Z, her left at +X, PMX units). pmx-writer.ts turns it into file space (z mirrored,
 * Euler x/y negated, triangle order reversed) and bytes. IK angle limits are the one exception: they are kept in file
 * convention, because MMDLoader converts those itself.
 */
export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];

export interface PmxIk {
  /** The effector bone (the bone that should reach the IK bone). */
  target: number;
  loop: number;
  limitRad: number;
  /** min/max Euler limits in PMX file convention (as Gene and the MMD standard models store them). */
  links: { bone: number; limits?: { min: Vec3; max: Vec3 } }[];
}
export interface PmxBone {
  name: string;
  nameEn: string;
  position: Vec3;
  parent: number;
  layer: number;
  /** PMX bone flags without the tail bit (0x0001), which the writer sets from `tail`. */
  flags: number;
  /** Tail: a bone index (connect) or an offset. */
  tail: number | Vec3;
  grant?: { parent: number; ratio: number };
  fixAxis?: Vec3;
  ik?: PmxIk;
}
export const BONE_ROTATE = 0x0002, BONE_MOVE = 0x0004, BONE_VISIBLE = 0x0008, BONE_OPERABLE = 0x0010, BONE_IK = 0x0020,
  BONE_GRANT_ROTATION = 0x0100, BONE_FIXED_AXIS = 0x0400;

export interface PmxMaterial {
  name: string;
  nameEn: string;
  diffuse: Vec4;
  specular: Vec3;
  shininess: number;
  ambient: Vec3;
  /** 0x01 no culling, 0x02 ground shadow, 0x04 self-shadow map, 0x08 self-shadow, 0x10 edge. */
  flags: number;
  edgeColor: Vec4;
  edgeSize: number;
  texture: number;
  /** Indices (three per triangle) drawn with this material. */
  indexCount: number;
}
export const MATERIAL_DOUBLE_SIDED = 0x01, MATERIAL_SHADOWS = 0x02 | 0x04 | 0x08, MATERIAL_EDGE = 0x10;

/** Morph panel: 1 brow, 2 eye, 3 mouth, 4 other. */
export type PmxPanel = 1 | 2 | 3 | 4;
export type PmxMorph =
  | { name: string; nameEn: string; panel: PmxPanel; kind: 'vertex'; indices: Int32Array; offsets: Float32Array }
  | { name: string; nameEn: string; panel: PmxPanel; kind: 'group'; members: { morph: number; ratio: number }[] };

export interface PmxFrame { name: string; nameEn: string; special: boolean; items: { kind: 'bone' | 'morph'; index: number }[] }

export interface PmxRigidBody {
  name: string;
  nameEn: string;
  bone: number;
  group: number;
  /** Ammo collision mask as MMDPhysics uses it: bit g set = collides with group g. */
  mask: number;
  /** 0 sphere (size[0] radius), 1 box (half extents), 2 capsule (size[0] radius, size[1] height). */
  shape: 0 | 1 | 2;
  size: Vec3;
  position: Vec3;
  /** Euler XYZ (Three's default order) in Three space. */
  rotation: Vec3;
  mass: number;
  linearDamping: number;
  angularDamping: number;
  restitution: number;
  friction: number;
  /** 0 follows its bone (kinematic), 1 physics, 2 physics with the bone's position kept. */
  mode: 0 | 1 | 2;
}
export interface PmxJoint {
  name: string;
  nameEn: string;
  bodyA: number;
  bodyB: number;
  position: Vec3;
  rotation: Vec3;
  /** Symmetric limits only (min = −max), so the file-space flip leaves them as they are. */
  translationLimit: Vec3;
  rotationLimit: Vec3;
  springTranslation: Vec3;
  springRotation: Vec3;
}

export interface PmxModel {
  name: string;
  nameEn: string;
  comment: string;
  commentEn: string;
  /** Per vertex: xyz. */
  positions: Float32Array;
  normals: Float32Array;
  /** Per vertex: uv (glTF/PMX convention: v down). */
  uvs: Float32Array;
  /** Per vertex: up to four bone indices and weights (unused slots -1 / 0), already normalised. */
  skinIndices: Int32Array;
  skinWeights: Float32Array;
  /** Triangles, counter-clockwise front faces in Three space, grouped by material in material order. */
  indices: Uint32Array;
  textures: string[];
  materials: PmxMaterial[];
  bones: PmxBone[];
  morphs: PmxMorph[];
  frames: PmxFrame[];
  bodies: PmxRigidBody[];
  joints: PmxJoint[];
}
