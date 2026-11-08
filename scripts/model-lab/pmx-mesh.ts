/**
 * Model lab (docs/claude/2026-11-02-model-lab.md): a PMX parsed in Node by the
 * same parser the app's MMDLoader uses (three's MMDParser), turned into the
 * part of an MMDLoader mesh that the stage adapters read
 * (src/stage/model-profile.ts `modelProfileInput`, src/stage/motion-retarget.ts
 * `meshRigBones`/`meshMorphNames`). Those adapters then run unchanged, so the
 * lab computes the profile, the collision proxy and the retarget rig exactly as
 * the app does after loading the model.
 *
 * What is mirrored from three r170's MMDLoader (GeometryBuilder + initBones):
 * - position (Float32), skinIndex (Uint16: BDEF1 [i], BDEF2/SDEF [a, b], BDEF4
 *   as stored, unused slots 0) and skinWeight (Float32: [1], [w, 1-w], four);
 *   the parser already reads SDEF as its two weights;
 * - bones as Three `Bone`s holding the rest offset from their parent, attached
 *   the same way (an invalid parent puts the bone under the mesh);
 * - morph targets as absolute Float32 positions with vertex morphs and group
 *   morphs of vertex morphs added in the loader's order (other morph types stay
 *   at rest), so the adapter sees the same float32-rounded offsets;
 * - `userData.MMD`: IK targets, 付与 grants, rigid bodies (with the loader's
 *   constraint rule for type 2 bodies).
 * Not built: normals, UVs, faces, materials, textures. Morph targets are only
 * materialized when the adapter reads one (its alias candidates), so a large
 * model does not hold a full copy per morph as the loader does.
 *
 * No file or network access here: bytes in, mesh out. The bytes are not changed
 * (a UTF-8 or PMX 2.1 file, or one with additional-UV morph offsets, is
 * converted on a copy, as the app's asset protocol does).
 */
import { Bone, BufferGeometry, Float32BufferAttribute, Skeleton, SkinnedMesh, Uint16BufferAttribute, type BufferAttribute } from 'three';
// Three.js r170 does not publish declarations for its bundled MMD parser.
// @ts-expect-error Bundled parser has no TypeScript declaration; PmxData below scopes its use.
import { MMDParser } from 'three/examples/jsm/libs/mmdparser.module.js';
import { describePmxPreparation, preparePmxForMmdParser, type PmxDowngrade } from '../../shared/pmx-text-encoding';

/** The fields of MMDParser.parsePmx(buffer, true) that the lab reads. */
export interface PmxData {
  metadata: { format: 'pmx'; version: number; modelName: string; englishModelName: string; vertexCount: number; boneCount: number; morphCount: number;
    rigidBodyCount: number; constraintCount: number; faceCount: number; materialCount: number };
  vertices: { position: number[]; skinIndices: number[]; skinWeights: number[]; type: number }[];
  bones: { name: string; parentIndex: number; position: number[]; transformationClass: number;
    grant?: { parentIndex: number; ratio: number; isLocal: boolean; affectRotation: boolean; affectPosition: boolean };
    ik?: { effector: number; iteration: number; maxAngle: number; links: { index: number }[] } }[];
  morphs: { name: string; type: number; elementCount: number; elements: { index: number; position?: number[]; ratio?: number }[] }[];
  rigidBodies: { boneIndex: number; type: number }[];
  constraints: { rigidBodyIndex1: number; rigidBodyIndex2: number }[];
}
interface ParserModule { Parser: new () => { parsePmx(buffer: ArrayBuffer, leftToRight: boolean): PmxData } }

/**
 * What was changed in memory before parsing (UTF-8 text, a 2.1 downgrade, additional-UV morph offsets left out), as the app's mmd-asset
 * protocol does; null when nothing was.
 */
export interface PmxConversion {
  fromUtf8: boolean; textFields: number; replacedTextFields: number; downgrade: PmxDowngrade | null;
  additionalUvMorphs: { morphs: number; elements: number } | null;
}

/**
 * Parses like the app's MMDLoader (left-to-right conversion on). Parser failures name the cause; the app cannot load such a model either.
 * The file is first converted in memory where needed (UTF-16LE text, 2.1 → 2.0, empty additional-UV morphs), exactly as the app's
 * mmd-asset protocol serves it (electron/asset-protocol.ts, shared/pmx-text-encoding.ts `preparePmxForMmdParser`).
 */
export function readPmx(bytes: Uint8Array): { data: PmxData; conversion: PmxConversion | null } {
  const prepared = preparePmxForMmdParser(bytes), source = prepared.bytes;
  const conversion = prepared.changed
    ? { fromUtf8: prepared.fromUtf8, textFields: prepared.textFields, replacedTextFields: prepared.replacedTextFields, downgrade: prepared.downgrade,
      additionalUvMorphs: prepared.additionalUvMorphs }
    : null;
  const buffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer;
  try {
    return { data: new (MMDParser as ParserModule).Parser().parsePmx(buffer, true), conversion };
  } catch (error) {
    // MMDParser throws plain strings ("unsupport bone type 4 exception." for QDEF, "PMX file magic is not PMX ...").
    const reason = typeof error === 'string' ? error : error instanceof Error ? error.message : String(error);
    const converted = prepared.changed ? ` (after the in-memory conversion: ${describePmxPreparation(prepared)})` : '';
    throw new Error(`PMX parse failed (three's MMDParser, the app's own loader would fail too): ${reason}${converted}`);
  }
}

/** `readPmx` without the conversion note. */
export function parsePmx(bytes: Uint8Array): PmxData {
  return readPmx(bytes).data;
}

/** A morph target that builds its absolute Float32 positions on first read, the way MMDLoader fills its attribute. */
class LazyMorphTarget {
  readonly itemSize = 3;
  private data: Float32Array | null = null;
  constructor(readonly name: string, readonly count: number, private readonly build: () => Float32Array) {}
  private get array(): Float32Array { return this.data ??= this.build(); }
  getX(index: number): number { return this.array[index * 3]; }
  getY(index: number): number { return this.array[index * 3 + 1]; }
  getZ(index: number): number { return this.array[index * 3 + 2]; }
}

export interface LabMesh {
  mesh: SkinnedMesh;
  counts: { vertices: number; bones: number; morphs: number; rigidBodies: number; dynamicBodies: number; grants: number; iks: number;
    deform: { bdef1: number; bdef2: number; bdef4: number } };
  name: { japanese: string; english: string };
  dispose(): void;
}

/** References MMDLoader dereferences without a check: any of these makes the app's model load throw. */
export function loaderFailure(data: PmxData): string | null {
  const bones = data.bones.length;
  const bone = data.bones.findIndex(entry => entry.parentIndex !== -1 && !data.bones[entry.parentIndex]);
  if (bone >= 0) return `bone ${bone} has parent index ${data.bones[bone].parentIndex}, outside the ${bones} bones`;
  const body = data.rigidBodies.findIndex(entry => entry.boneIndex !== -1 && !data.bones[entry.boneIndex]);
  if (body >= 0) return `rigid body ${body} is attached to bone ${data.rigidBodies[body].boneIndex}, outside the ${bones} bones`;
  const joint = data.constraints.findIndex(entry => !data.rigidBodies[entry.rigidBodyIndex1] || !data.rigidBodies[entry.rigidBodyIndex2]);
  if (joint >= 0) return `joint ${joint} links a rigid body that does not exist`;
  const group = data.morphs.findIndex(morph => morph.type === 0 && morph.elements.some(element => !data.morphs[element.index]));
  if (group >= 0) return `group morph ${group} (${data.morphs[group].name}) refers to a morph that does not exist`;
  return null;
}

/** MMDLoader-equivalent SkinnedMesh for the stage adapters (see the file comment for what is mirrored). */
export function labMesh(data: PmxData): LabMesh {
  const failure = loaderFailure(data);
  if (failure) throw new Error(`${failure} (three's MMDLoader fails on this model too)`);
  const vertexCount = data.metadata.vertexCount, boneCount = data.metadata.boneCount;
  const positions = new Float32Array(vertexCount * 3), skinIndices = new Uint16Array(vertexCount * 4), skinWeights = new Float32Array(vertexCount * 4);
  const deform = { bdef1: 0, bdef2: 0, bdef4: 0 };
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const v = data.vertices[vertex];
    positions[vertex * 3] = v.position[0]; positions[vertex * 3 + 1] = v.position[1]; positions[vertex * 3 + 2] = v.position[2];
    for (let k = 0; k < 4; k++) {
      // Same conversions as `new Uint16BufferAttribute(list)` / `new Float32BufferAttribute(list)` on the loader's padded lists.
      skinIndices[vertex * 4 + k] = v.skinIndices.length - 1 >= k ? v.skinIndices[k] : 0;
      skinWeights[vertex * 4 + k] = v.skinWeights.length - 1 >= k ? v.skinWeights[k] : 0;
    }
    if (v.type === 0) deform.bdef1++; else if (v.type === 2) deform.bdef4++; else deform.bdef2++; // the parser reports SDEF as BDEF2 (type 1)
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(skinWeights, 4));

  // Morph targets: rest positions plus vertex morphs (ratio 1) or a group's vertex children (their ratios), accumulated in Float32 as the loader does.
  const addMorph = (target: Float32Array, morph: PmxData['morphs'][number], ratio: number) => {
    for (let k = 0; k < morph.elementCount; k++) {
      const element = morph.elements[k], index = element.index, offset = element.position!;
      target[index * 3] += offset[0] * ratio; target[index * 3 + 1] += offset[1] * ratio; target[index * 3 + 2] += offset[2] * ratio;
    }
  };
  geometry.morphAttributes.position = data.morphs.map(morph => new LazyMorphTarget(morph.name, vertexCount, () => {
    const target = Float32Array.from(positions);
    if (morph.type === 1) addMorph(target, morph, 1);
    else if (morph.type === 0) for (let k = 0; k < morph.elementCount; k++) {
      const child = data.morphs[morph.elements[k].index];
      if (child.type === 1) addMorph(target, child, morph.elements[k].ratio!);
    }
    return target;
  })) as unknown as BufferAttribute[];
  geometry.morphTargetsRelative = false;

  // userData.MMD as the loader fills it, for the fields the adapters read.
  const iks = data.bones.flatMap((bone, index) => bone.ik ? [{ target: index, effector: bone.ik.effector, iteration: bone.ik.iteration, maxAngle: bone.ik.maxAngle,
    links: bone.ik.links.map(link => ({ index: link.index, enabled: true })) }] : []);
  const grants = data.bones.flatMap((bone, index) => bone.grant ? [{ index, parentIndex: bone.grant.parentIndex, ratio: bone.grant.ratio, isLocal: bone.grant.isLocal,
    affectRotation: bone.grant.affectRotation, affectPosition: bone.grant.affectPosition, transformationClass: bone.transformationClass }] : []);
  const rigidBodies = data.rigidBodies.map(body => ({ boneIndex: body.boneIndex, type: body.type }));
  for (const constraint of data.constraints) {
    const a = rigidBodies[constraint.rigidBodyIndex1], b = rigidBodies[constraint.rigidBodyIndex2];
    if (a && b && a.type !== 0 && b.type === 2 && a.boneIndex !== -1 && b.boneIndex !== -1 && data.bones[b.boneIndex]?.parentIndex === a.boneIndex) b.type = 1;
  }
  geometry.userData.MMD = { iks, grants, rigidBodies, format: 'pmx' };

  // Bones: the rest offset from the parent's rest position, then attached as initBones does.
  const mesh = new SkinnedMesh(geometry);
  const bones = data.bones.map(source => {
    const bone = new Bone();
    bone.name = source.name;
    const offset = source.position.slice(0, 3);
    if (source.parentIndex !== -1) {
      const parent = data.bones[source.parentIndex].position;
      offset[0] -= parent[0]; offset[1] -= parent[1]; offset[2] -= parent[2];
    }
    bone.position.fromArray(offset);
    return bone;
  });
  data.bones.forEach((source, index) => {
    const parent = source.parentIndex;
    if (parent !== -1 && parent !== null && bones[parent] !== undefined) bones[parent].add(bones[index]);
    else mesh.add(bones[index]);
  });
  mesh.updateMatrixWorld(true);
  mesh.bind(new Skeleton(bones));
  return {
    mesh,
    counts: { vertices: vertexCount, bones: boneCount, morphs: data.metadata.morphCount, rigidBodies: data.rigidBodies.length,
      dynamicBodies: rigidBodies.filter(body => body.type === 1 || body.type === 2).length, grants: grants.length, iks: iks.length, deform },
    name: { japanese: data.metadata.modelName, english: data.metadata.englishModelName },
    dispose() { geometry.dispose(); mesh.skeleton.dispose(); (mesh.material as { dispose?: () => void }).dispose?.(); },
  };
}
