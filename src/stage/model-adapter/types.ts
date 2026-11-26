// The loaded model (I-152 原样载入 step 0, docs/claude/2026-11-19-model-adapter-and-vrm-display.md): what the stage knows about the
// model on stage, whatever file format it came from. Each format's loader (mmd.ts, vrm.ts) produces one; the stage reads the parts
// below from it instead of reaching into MMD data. README.md lists which stage parts read it so far.
import type { Bone, Object3D, SkinnedMesh } from 'three';
import type { ModelProfileInput } from '../../../shared/stage/model-profile';
import type { FingerSlot, MorphSlot, NamedFaceShape, StandardBone } from '../../../shared/foundation/universal-skeleton';
import type { RigBone } from '../../../shared/actions';
import type { VrmLookAt } from '../../../shared/stage/vrm/vrm-read';

export type LoadedModelFormat = 'mmd' | 'vrm';

/** Rest-pose extent in stage space (MMD units, +y up), as the camera framing reads it. */
export interface ModelBounds { readonly height: number; readonly width: number; readonly centerX: number; readonly baseY: number }

/** One morph a table entry writes: which mesh, which morph target, how much at full weight. */
export interface MorphBind { readonly mesh: SkinnedMesh; readonly index: number; readonly weight: number }

/**
 * One spring chain (VRM spring bone): bones root to tip and its settings, simulated by src/stage/vrm-spring/ (I-152 step 3).
 * `gravityDir` is in the stage's world (she faces +Z): VRM 0.x's Unity-space direction is turned at load (vrm.ts).
 */
export interface SpringChain {
  readonly name: string;
  readonly joints: readonly { readonly bone: Bone; readonly hitRadius: number; readonly stiffness: number; readonly gravityPower: number;
    readonly gravityDir: readonly [number, number, number]; readonly dragForce: number }[];
  readonly colliderGroups: readonly number[];
  /** VRM 0.x: the last joint swings too, its tail 7 cm along its own bone (UniVRM's rule). VRM 1.0: the last joint is only the tail. */
  readonly leafTail?: boolean;
}

/** One spring collider on its node: offset (and a capsule's tail) in the node's own space, radius, both in the file's metres. */
export interface SpringCollider {
  readonly bone: Object3D;
  readonly shape: 'sphere' | 'capsule';
  readonly offset: readonly [number, number, number];
  readonly tail?: readonly [number, number, number];
  readonly radius: number;
}

/** How the model's own file describes its physics. The stage's MMD physics reads the mesh itself; this is the format-neutral view. */
export type ModelPhysicsDescription =
  | { readonly kind: 'mmd-rigid'; readonly rigidBodies: number; readonly joints: number }
  | {
    readonly kind: 'vrm-spring'; readonly chains: readonly SpringChain[]; readonly colliders: number;
    /** The colliders by the file's index (null: one whose node is missing) and the groups a chain names by index. */
    readonly shapes?: readonly (SpringCollider | null)[]; readonly groups?: readonly (readonly number[])[];
  }
  | { readonly kind: 'none' };

export interface ModelRest {
  /** Upper arms at rest: about level (T), clearly lowered (A), or not measurable. */
  readonly pose: 'T' | 'A' | 'unknown';
  /** Where the file's model faced before loading; the loaded model always faces the stage's +Z. */
  readonly sourceFacing: '+z' | '-z';
  /** Stage units per metre (MMD convention: 12.5, one unit = 8 cm). */
  readonly unitsPerMeter: number;
  /** Uniform scale the loader applied to reach stage units (MMD: 1; VRM: 12.5, the file is in metres). */
  readonly scale: number;
}

/** The format-neutral rest data the stage's model profile is built from (src/stage/model-profile.ts). */
export interface ProfileSource {
  /** Rest positions, skin, bones and morph offsets in model space. */
  input(): ModelProfileInput;
  /** Bones in the order the profile's indices refer to. */
  readonly bones: readonly Bone[];
  /** The object whose local space is "model space" (the profile's points are in it). */
  readonly root: Object3D;
  /** Morph name → index (the old name-only fallback reads it). */
  readonly morphDictionary: Readonly<Record<string, number>> | undefined;
}

export interface LoadedModel {
  readonly format: LoadedModelFormat;
  /** What goes into the scene. */
  readonly object: Object3D;
  /**
   * The one MMD mesh the stage's MMD machinery (animation helper, physics, morph writers) drives; null for a format that machinery
   * does not drive (VRM until step 2): the stage then shows the model as it is and every MMD-only feature stays off.
   */
  readonly mesh: SkinnedMesh | null;
  /** Every skinned mesh of the model. */
  readonly meshes: readonly SkinnedMesh[];
  /** Every bone of the model, once each. */
  readonly bones: readonly Bone[];
  /**
   * Standard bone → this model's bone (undefined when the model has none). MMD: the stage's own exact names (see mmd.ts STAGE_NAMES);
   * VRM: its humanoid map.
   */
  bone(slot: StandardBone): Bone | undefined;
  /** A finger joint (MMD numbering, thumb 0–2, the others 1–3) → this model's bone. MMD: by its name; VRM: its humanoid fingers. */
  finger(slot: FingerSlot): Bone | undefined;
  /** Expression slot → the morphs it writes (empty when the model has none). */
  expression(slot: MorphSlot): readonly MorphBind[];
  /** An expression by the model's own name (VRM: lookUp, relaxed, a custom one); empty when the model has none by that name. */
  expressionNamed(name: string): readonly MorphBind[];
  /**
   * I-164: one of her face actions' named shapes (cheekPuff, tongueOut …, shared/foundation/universal-skeleton.ts NAMED_FACE_SHAPES) on this
   * model; empty when it has none. VRM only (shared/stage/vrm/face-shapes.ts says the order); MMD models find them through their profile.
   */
  faceShape?(shape: NamedFaceShape): readonly MorphBind[];
  /** How the model's eyes look around (VRM lookAt: eye bones or look expressions, and how far); null for MMD (its eye bones as they are). */
  readonly lookAt: VrmLookAt | null;
  readonly physics: ModelPhysicsDescription;
  readonly rest: ModelRest;
  /** Rest-pose extent; measured when called (the stage calls it once, right after adding the model to the scene). */
  measureBounds(): ModelBounds;
  /** Rest data for the model profile; null when this format has no profile yet. */
  profileSource(): ProfileSource | null;
  /** Rest hierarchy and morph names for motion retargeting (I-038); null when this format is not retargeted yet. */
  rig(): { bones: RigBone[]; morphNames: string[] } | null;
  /** Releases geometry, materials, textures and skeletons. */
  dispose(): void;
}
