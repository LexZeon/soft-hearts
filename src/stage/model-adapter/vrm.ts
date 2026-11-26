// A VRM loaded as it is (I-152 原样载入 step 1, docs/claude/2026-11-19-model-adapter-and-vrm-display.md). three's own glTF loader
// reads the file; its MToon materials go to @pixiv/three-vrm-materials-mtoon (MIT, pixiv; the user agreed to this one package on
// 2026-11-19); the VRM extensions (humanoid, expressions, spring bones, lookAt) are read by our own reader (shared/stage/vrm/).
// VRM 0.x materials are translated to the 1.0 MToon extension first (vrm0-mtoon.ts). The file's bytes are never changed.
//
// Shown standing, as it is (Unbound's engine moves it, step 2; its spring bones move in src/stage/vrm-spring/, step 3, read from the
// chains and colliders this hands on). The one change to its pose is TEMPORARY: a T-posed
// model's upper arms are lowered at load (relaxArms) so she does not stand with her arms straight out; step 2's motion system
// takes the pose over.
import { Bone, FileLoader, Group, Quaternion, Vector3, type Loader, type LoadingManager, type Object3D, type SkinnedMesh, type Texture } from 'three';
import { GLTFLoader, type GLTF, type GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MToonMaterialLoaderPlugin } from '@pixiv/three-vrm-materials-mtoon';
import { uiText } from '../../foundation/ui-language';
import { glbWithJson, readGlbJson } from '../../../shared/foundation/glb-json';
import type { GltfJson } from '../../../shared/stage/vrm/gltf-json';
import { readVrm, type HumanBone, type VrmSource } from '../../../shared/stage/vrm/vrm-read';
import { STANDARD_FROM_VRM, VRM_EXPRESSION_SLOTS, VRM_FINGER_BONES } from '../../../shared/stage/vrm/humanoid';
import { VRM_SHAPE_MIXES, VRM_SLOT_MIXES, type VrmFaceMix } from '../../../shared/stage/vrm/face-shapes';
import { translateVrm0Materials } from '../../../shared/stage/vrm/vrm0-mtoon';
import { MORPH_ALIASES, NAMED_FACE_SHAPES, normalizeProfileName, type FingerSlot, type MorphSlot, type NamedFaceShape, type StandardBone } from '../../../shared/foundation/universal-skeleton';
import { CappedTextureLoader } from '../textures';
import { disposeObjectTree } from './dispose';
import { measureObjectBounds, restArmPose } from './rest-data';
import type { LoadedModel, ModelBounds, MorphBind, SpringChain, SpringCollider } from './types';

/** Stage units per metre: the MMD convention (one unit = 8 cm), so a VRM stands as tall as an MMD model of the same height. */
export const VRM_UNITS_PER_METER = 12.5;
/** TEMPORARY (step 1, until the motion system poses her): how far below level a T-posed model's upper arms rest. */
export const DISPLAY_ARM_DOWN_DEG = 65;

export interface VrmLoadOptions {
  /** The stage's loading manager (status and errors); also used for the file request. */
  manager?: LoadingManager;
  /** Texture loader factory (tests pass an inert one). Default: the stage's capped texture loader (an <img> per texture: the page's
   * content policy lets images come from blob: URLs, not fetch()). */
  textureLoader?: (manager: LoadingManager | undefined) => Loader<Texture> & { load: TextureLoad };
  /**
   * Lower a T pose's arms at load (default true: the old stage, which only shows her). Unbound's engine passes false: its standard
   * body (src/unbound/model/) lowers them itself, eased, as part of her idle (I-152 step 2), and needs the file's own rest pose.
   */
  relaxArms?: boolean;
}
type TextureLoad = (url: string, onLoad?: (texture: Texture) => void, onProgress?: (event: ProgressEvent) => void, onError?: (error: unknown) => void) => Texture | void;

/**
 * Slots whose VRM preset is the right binding: a vowel or a blink moves only the mouth or the lids. The other presets are often a
 * whole face (VRoid's happy is Fcl_ALL_Joy: arched eyes, brows AND an open mouth), so a pat's 笑眼 opened her mouth and left her
 * eyes half arched. Those slots look for the face's own part shape first (MORPH_ALIASES, the
 * names the MMD side uses: fcl_eye_joy, fcl_mth_fun, fcl_brw_sorrow ...) and fall back to the preset.
 */
export const VRM_PRESET_FIRST: ReadonlySet<MorphSlot> = new Set<MorphSlot>(['a', 'i', 'u', 'e', 'o', 'blink', 'blinkLeft', 'blinkRight']);

/** Fetches the model file through the stage's loading manager (the mmd-asset: protocol) and loads it. */
export async function loadVrmModel(url: string, options: VrmLoadOptions = {}): Promise<LoadedModel> {
  const loader = new FileLoader(options.manager).setResponseType('arraybuffer');
  const bytes = await loader.loadAsync(url) as ArrayBuffer;
  return parseVrmModel(new Uint8Array(bytes), options);
}

/** A VRM's bytes → the loaded model. Throws (in Chinese, for the status line) when the bytes are not a VRM. */
export async function parseVrmModel(bytes: Uint8Array, options: VrmLoadOptions = {}): Promise<LoadedModel> {
  const json = readGlbJson(bytes) as GltfJson | null;
  if (!json) throw new Error(uiText('这个 .vrm 读不出来（不是 GLB 文件）'));
  const source = readVrm({ json });
  let glb = bytes;
  if (source.version === '0.x' && translateVrm0Materials(json as Record<string, unknown>).translated) glb = glbWithJson(bytes, json);
  const loader = new GLTFLoader(options.manager);
  const makeTextureLoader = options.textureLoader ?? (manager => new CappedTextureLoader(manager));
  loader.register(parser => {
    // Replaces the parser's ImageBitmapLoader (which fetch()es blob: URLs) before any texture is read.
    (parser as unknown as { textureLoader: unknown }).textureLoader = makeTextureLoader(options.manager);
    return { name: 'soft_hearts_texture_loader' };
  });
  loader.register(parser => new MToonMaterialLoaderPlugin(parser));
  const buffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer;
  const gltf = await new Promise<GLTF>((resolve, reject) => loader.parse(buffer, '', resolve, reject));
  return vrmLoadedModel(gltf, source, { relaxArms: options.relaxArms !== false });
}

/**
 * I-152 step 3 (src/stage/vrm-spring/): a spring joint's gravityDir in the stage's world (she faces +Z, her left at +X). VRM 1.0 writes it
 * that way; 0.x in Unity's space (she faces +Z there too, but her right is +X): ours is (−x, y, z).
 */
export function springWorldDir(version: VrmSource['version'], dir: readonly [number, number, number]): [number, number, number] {
  return version === '0.x' ? [-dir[0], dir[1], dir[2]] : [dir[0], dir[1], dir[2]];
}

/** Node index → the object the glTF loader made for it, from the parser's own record. */
function nodeObjects(parser: GLTFParser, root: Object3D): Map<number, Object3D> {
  const out = new Map<number, Object3D>();
  root.traverse(object => {
    const nodes = (parser.associations.get(object) as { nodes?: number } | undefined)?.nodes;
    if (Number.isInteger(nodes) && !out.has(nodes!)) out.set(nodes!, object);
  });
  return out;
}

export function vrmLoadedModel(gltf: GLTF, source: VrmSource, options: { relaxArms?: boolean } = {}): LoadedModel {
  const scene = gltf.scene;
  const facing = new Group(); facing.name = 'vrm-facing';
  // VRM 0.x faces −Z; the stage (and VRM 1.0) faces +Z.
  if (source.facing === -1) facing.rotation.y = Math.PI;
  facing.add(scene);
  const root = new Group(); root.name = 'vrm';
  root.scale.setScalar(VRM_UNITS_PER_METER);
  root.add(facing);
  root.updateMatrixWorld(true);

  const nodes = nodeObjects(gltf.parser, scene);
  const human = (bone: HumanBone): Bone | undefined => {
    const node = source.humanoid[bone];
    const object = node === undefined ? undefined : nodes.get(node);
    return (object as Bone | undefined)?.isBone ? object as Bone : undefined;
  };
  const meshes: SkinnedMesh[] = [];
  scene.traverse(object => { if ((object as SkinnedMesh).isSkinnedMesh) meshes.push(object as SkinnedMesh); });
  for (const mesh of meshes) mesh.frustumCulled = false; // skinned bounds do not follow the pose, as for MMD meshes
  const bones = [...new Set(meshes.flatMap(mesh => mesh.skeleton?.bones ?? []))];

  // glTF mesh index → the skinned meshes made from it (one per primitive; every primitive carries the mesh's morph targets).
  const byMesh = new Map<number, SkinnedMesh[]>();
  for (const mesh of meshes) {
    const index = (gltf.parser.associations.get(mesh) as { meshes?: number } | undefined)?.meshes;
    if (Number.isInteger(index)) byMesh.set(index!, [...byMesh.get(index!) ?? [], mesh]);
  }
  const expressions = new Map<string, MorphBind[]>();
  for (const expression of source.expressions) {
    const binds = expression.binds.flatMap(bind => (byMesh.get(bind.mesh) ?? [])
      .filter(mesh => (mesh.morphTargetInfluences?.length ?? 0) > bind.index).map(mesh => ({ mesh, index: bind.index, weight: bind.weight })));
    if (binds.length && !expressions.has(expression.name)) expressions.set(expression.name, binds);
  }
  // The meshes' own morph targets by normalized name (every primitive of a mesh carries them), for the part shapes above.
  const parts = new Map<string, MorphBind[]>();
  for (const mesh of meshes) {
    for (const [name, index] of Object.entries(mesh.morphTargetDictionary ?? {})) {
      const key = normalizeProfileName(name);
      parts.set(key, [...parts.get(key) ?? [], { mesh, index, weight: 1 }]);
    }
  }
  const partShape = (slot: MorphSlot): readonly MorphBind[] => {
    for (const alias of MORPH_ALIASES[slot] ?? []) { const binds = parts.get(normalizeProfileName(alias)); if (binds) return binds; }
    return [];
  };
  const preset = (slot: MorphSlot): readonly MorphBind[] => {
    for (const name of VRM_EXPRESSION_SLOTS[slot] ?? []) { const binds = expressions.get(name); if (binds) return binds; }
    return [];
  };
  // I-164 (docs/claude/2026-11-20-vrm-gaps.md): a VRoid stand-in (face-shapes.ts), only when every part shape in it is on the model.
  const mixOf = (mix: readonly VrmFaceMix[] | undefined): readonly MorphBind[] => {
    if (!mix?.length) return [];
    const found = mix.map(entry => ({ entry, binds: parts.get(normalizeProfileName(entry.target)) }));
    if (found.some(part => !part.binds)) return [];
    return found.flatMap(({ entry, binds }) => binds!.map(bind => ({ ...bind, weight: bind.weight * entry.weight })));
  };
  // Custom expressions by normalized name (a model's own "cheekPuff", "Tongue_Out" …).
  const customs = new Map<string, MorphBind[]>();
  for (const [name, binds] of expressions) { const key = normalizeProfileName(name); if (!customs.has(key)) customs.set(key, binds); }
  /** A named face shape of her face actions: an expression by that name, else a morph target by it, else a VRoid stand-in. */
  const faceShape = (shape: NamedFaceShape): readonly MorphBind[] => {
    const names = [shape, ...NAMED_FACE_SHAPES[shape]].map(normalizeProfileName);
    for (const name of names) { const binds = customs.get(name); if (binds) return binds; }
    for (const name of names) { const binds = parts.get(name); if (binds) return binds; }
    return mixOf(VRM_SHAPE_MIXES[shape]);
  };
  const worldDir = (dir: readonly [number, number, number]) => springWorldDir(source.version, dir);
  const chains: SpringChain[] = source.springs.map(spring => ({
    name: spring.name, colliderGroups: [...spring.colliderGroups], leafTail: source.version === '0.x',
    joints: spring.joints.flatMap(joint => {
      const bone = nodes.get(joint.node);
      return (bone as Bone | undefined)?.isBone ? [{ bone: bone as Bone, hitRadius: joint.hitRadius, stiffness: joint.stiffness, gravityPower: joint.gravityPower,
        gravityDir: worldDir(joint.gravityDir), dragForce: joint.dragForce }] : [];
    }),
  })).filter(chain => chain.joints.length > 0);
  const shapes: (SpringCollider | null)[] = source.colliders.map(collider => {
    const bone = nodes.get(collider.node);
    return bone ? { bone, shape: collider.shape, offset: [...collider.offset] as [number, number, number], radius: collider.radius,
      ...(collider.tail ? { tail: [...collider.tail] as [number, number, number] } : {}) } : null;
  });

  const arms = (['left', 'right'] as const).map(side => ({ upper: human(`${side}UpperArm`), lower: human(`${side}LowerArm`) }));
  const restPose = restArmPose(arms);
  if (options.relaxArms !== false) relaxArms(arms, DISPLAY_ARM_DOWN_DEG);

  return {
    format: 'vrm',
    object: root,
    mesh: null,
    meshes,
    bones,
    bone(slot: StandardBone) {
      for (const candidate of STANDARD_FROM_VRM[slot] ?? []) { const bone = human(candidate); if (bone) return bone; }
      return undefined;
    },
    finger: (slot: FingerSlot) => human(VRM_FINGER_BONES[slot]),
    expression(slot: MorphSlot) {
      if (VRM_PRESET_FIRST.has(slot)) { const own = preset(slot); return own.length ? own : partShape(slot); }
      const own = partShape(slot);
      if (own.length) return own;
      const named = preset(slot);
      return named.length ? named : mixOf(VRM_SLOT_MIXES[slot]); // I-164: じと目, 嘟嘴 from VRoid part shapes
    },
    expressionNamed: (name: string) => expressions.get(name) ?? [],
    faceShape,
    lookAt: source.lookAt,
    physics: chains.length ? { kind: 'vrm-spring', chains, colliders: source.colliders.length, shapes, groups: source.colliderGroups.map(group => [...group.colliders]) } : { kind: 'none' },
    rest: { pose: restPose, sourceFacing: source.facing === 1 ? '+z' : '-z', unitsPerMeter: VRM_UNITS_PER_METER, scale: VRM_UNITS_PER_METER },
    measureBounds(): ModelBounds {
      root.updateMatrixWorld(true);
      // A skinned mesh's box is measured from its posed vertices once and kept: measure it again at the pose shown now.
      for (const mesh of meshes) { mesh.skeleton?.update(); mesh.computeBoundingBox(); }
      return measureObjectBounds(root);
    },
    profileSource: () => null,
    rig: () => null,
    dispose: () => disposeObjectTree(root),
  };
}

/**
 * TEMPORARY (step 1): lowers each upper arm that rests less than `downDeg` below level to `downDeg`, turning it about the axis
 * across its own direction and straight down (so it swings down at the side, not forwards). Rest pose only; nothing animates it.
 */
export function relaxArms(arms: readonly { upper: Bone | undefined; lower: Bone | undefined }[], downDeg: number): void {
  for (const { upper, lower } of arms) {
    if (!upper || !lower) continue;
    upper.updateWorldMatrix(true, true);
    const start = upper.getWorldPosition(new Vector3()), direction = lower.getWorldPosition(new Vector3()).sub(start);
    const length = direction.length();
    if (!(length > 1e-6)) continue;
    direction.divideScalar(length);
    const below = Math.asin(Math.max(-1, Math.min(1, -direction.y)));
    const turn = downDeg * Math.PI / 180 - below;
    if (turn <= 1e-4) continue;
    const axis = new Vector3().crossVectors(direction, new Vector3(0, -1, 0));
    if (axis.lengthSq() < 1e-10) continue;
    axis.normalize();
    // World rotation → the arm's local rotation: q_local' = parent⁻¹ · turn · parent · q_local.
    const parentWorld = upper.parent ? upper.parent.getWorldQuaternion(new Quaternion()) : new Quaternion();
    const world = new Quaternion().setFromAxisAngle(axis, turn);
    upper.quaternion.premultiply(parentWorld.clone().invert().multiply(world).multiply(parentWorld));
    upper.updateWorldMatrix(false, true);
  }
}
