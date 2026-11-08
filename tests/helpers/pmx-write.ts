/**
 * Test-only PMX 2.0/2.1 writer for synthetic models (no private or third-party
 * data), so the model lab (scripts/model-lab/) and the UTF-8 text transcoder
 * (shared/pmx-text-encoding.ts) can be exercised from bytes through three's
 * MMDParser. Coordinates (vertex and bone positions, vertex morph deltas) are
 * given in MMDLoader model space and written left-handed (z negated), so
 * parsing with leftToRight gives them back; every other number is written as
 * given.
 *
 * Text is UTF-16LE by default (what MMDParser decodes); `encoding: 1` writes
 * the same strings as UTF-8, so a model written both ways differs only in its
 * text fields and the encoding byte. Without the optional sections (faces,
 * textures, materials, display frames, the extra bone/morph fields) the output
 * is byte-identical to the original minimal writer the model-lab tests use.
 */
import type { ModelData } from './model-fixtures';

export interface PmxSkin {
  /** 0 BDEF1, 1 BDEF2, 2 BDEF4, 3 SDEF, 4 QDEF (PMX 2.1; MMDParser refuses it). */
  deform: 0 | 1 | 2 | 3 | 4;
  bones: number[];
  weights: number[];
  /** SDEF C, R0, R1 (nine numbers, default zeros). */
  sdef?: readonly number[];
}
export interface PmxWriteBone {
  name: string;
  englishName?: string;
  parent: number;
  position: readonly number[];
  /** Tail as a bone index (flag 0x0001) instead of the default zero offset. */
  connect?: number;
  /** 付与. Rotation (0x0100) unless `rotation: false`; `position` adds 0x0200, `local` 0x0080. */
  grant?: { parent: number; ratio: number; rotation?: boolean; position?: boolean; local?: boolean };
  /** Fixed axis (0x0400). */
  fixAxis?: readonly number[];
  /** Local X and Z axes (0x0800). */
  localAxes?: { x: readonly number[]; z: readonly number[] };
  /** External parent key (0x2000). */
  externalKey?: number;
  /** IK (0x0020); a link given with `limits` writes its lower and upper angle limits. */
  ik?: { effector: number; links: (number | { index: number; limits: [readonly number[], readonly number[]] })[] };
}
interface MorphText { name: string; englishName?: string; panel?: number }
export type PmxWriteMorph =
  | MorphText & { type: 1; indices: readonly number[]; deltas: readonly number[] }
  | MorphText & { type: 0; group: [number, number][] }
  | MorphText & { type: 2; bones: { index: number; translation: readonly number[]; rotation: readonly number[] }[] }
  /** 3 UV, 4-7 additional UV 1-4 (MMDParser reads no data for 4-7 and loses its place). */
  | MorphText & { type: 3 | 4 | 5 | 6 | 7; uvs: { index: number; value: readonly number[] }[] }
  /** 28 numbers per element: diffuse 4, specular 3, specularity, ambient 3, edge colour 4, edge size, texture/sphere/toon tints 4 each. */
  | MorphText & { type: 8; materials: { index: number; operation: number; values?: readonly number[] }[] }
  /** PMX 2.1 flip morph. */
  | MorphText & { type: 9; flips: [number, number][] }
  /** PMX 2.1 impulse morph. */
  | MorphText & { type: 10; impulses: { body: number; local: boolean; velocity: readonly number[]; torque: readonly number[] }[] };
export interface PmxWriteMaterial {
  name: string;
  englishName?: string;
  /** Texture and sphere texture indices (default -1, none). */
  texture?: number;
  sphere?: number;
  /** Shared toon 0-9 (toon flag 1) or a texture index (toon flag 0). Default shared 0. */
  toon?: { shared: number } | { texture: number };
  memo?: string;
  /** Face indices this material draws (a multiple of 3). */
  surfaces: number;
}
export interface PmxWriteFrame {
  name: string;
  englishName?: string;
  special?: boolean;
  elements: { morph: boolean; index: number }[];
}
export interface PmxWriteSoftBody {
  name: string;
  englishName?: string;
  material: number;
  anchors: { body: number; vertex: number; near?: boolean }[];
  pins: number[];
}
type IndexSize = 1 | 2 | 4;
export interface PmxWriteModel {
  name?: string;
  englishName?: string;
  comment?: string;
  englishComment?: string;
  /** 2.0 (default) or 2.1 (writes the soft body section; MMDParser refuses the version). */
  version?: 2.0 | 2.1;
  /** Text encoding byte: 0 UTF-16LE (default), 1 UTF-8. */
  encoding?: 0 | 1;
  /** Additional UV vec4s per vertex (0-4), written with deterministic values. */
  additionalUv?: number;
  /** Index sizes (defaults: vertex 4, texture 1, material 1, bone 2 or 4 by count, morph 2, rigid body 2). */
  indexSizes?: Partial<Record<'vertex' | 'texture' | 'material' | 'bone' | 'morph' | 'rigidBody', IndexSize>>;
  positions: ArrayLike<number>;
  skin: PmxSkin[];
  /** Triangle vertex indices (a multiple of 3). */
  faces?: readonly number[];
  textures?: string[];
  materials?: PmxWriteMaterial[];
  bones: PmxWriteBone[];
  morphs: PmxWriteMorph[];
  frames?: PmxWriteFrame[];
  rigidBodies?: { boneIndex: number; type: number; name?: string; englishName?: string }[];
  joints?: { a: number; b: number; name?: string; englishName?: string }[];
  softBodies?: PmxWriteSoftBody[];
}

class Writer {
  private bytes = new Uint8Array(1 << 16);
  private view = new DataView(this.bytes.buffer);
  private readonly utf8 = new TextEncoder();
  length = 0;
  constructor(private readonly encoding: 0 | 1 = 0) {}
  private room(size: number) {
    if (this.length + size <= this.bytes.length) return;
    const next = new Uint8Array(Math.max(this.bytes.length * 2, this.length + size));
    next.set(this.bytes.subarray(0, this.length)); this.bytes = next; this.view = new DataView(next.buffer);
  }
  u8(value: number) { this.room(1); this.view.setUint8(this.length, value); this.length += 1; }
  u16(value: number) { this.room(2); this.view.setUint16(this.length, value, true); this.length += 2; }
  i32(value: number) { this.room(4); this.view.setInt32(this.length, value, true); this.length += 4; }
  f32(value: number) { this.room(4); this.view.setFloat32(this.length, value, true); this.length += 4; }
  floats(values: readonly number[]) { for (const value of values) this.f32(value); }
  /** Left-handed position: z negated. */
  vec(values: ArrayLike<number>) { this.f32(values[0]); this.f32(values[1]); this.f32(-values[2]); }
  text(value: string) {
    if (this.encoding === 1) {
      const bytes = this.utf8.encode(value);
      this.i32(bytes.length); this.room(bytes.length); this.bytes.set(bytes, this.length); this.length += bytes.length;
    } else { this.i32(value.length * 2); for (let k = 0; k < value.length; k++) this.u16(value.charCodeAt(k)); }
  }
  index(size: number, value: number) { if (size === 1) { this.room(1); this.view.setInt8(this.length, value); this.length += 1; } else if (size === 2) { this.room(2); this.view.setInt16(this.length, value, true); this.length += 2; } else this.i32(value); }
  /** Vertex indices are unsigned at sizes 1 and 2. */
  vertex(size: number, value: number) { if (size === 1) this.u8(value); else if (size === 2) this.u16(value); else this.i32(value); }
  result() { return this.bytes.slice(0, this.length); }
}

export function writePmx(model: PmxWriteModel): Uint8Array {
  const version = model.version ?? 2.0, w = new Writer(model.encoding ?? 0), count = model.positions.length / 3, sizes = model.indexSizes ?? {};
  const boneSize = sizes.bone ?? (model.bones.length < 32_768 ? 2 : 4), morphSize = sizes.morph ?? 2, bodySize = sizes.rigidBody ?? 2, vertexSize = sizes.vertex ?? 4;
  const textureSize = sizes.texture ?? 1, materialSize = sizes.material ?? 1, extraUv = model.additionalUv ?? 0;
  for (const char of 'PMX ') w.u8(char.charCodeAt(0));
  w.f32(version);
  w.u8(8); for (const value of [model.encoding ?? 0, extraUv, vertexSize, textureSize, materialSize, boneSize, morphSize, bodySize]) w.u8(value);
  w.text(model.name ?? 'synthetic'); w.text(model.englishName ?? model.name ?? 'synthetic');
  w.text(model.comment ?? 'test fixture'); w.text(model.englishComment ?? model.comment ?? 'test fixture');
  w.i32(count);
  for (let vertex = 0; vertex < count; vertex++) {
    w.vec([model.positions[vertex * 3], model.positions[vertex * 3 + 1], model.positions[vertex * 3 + 2]]);
    w.floats([0, 1, 0, 0, 0]); // normal, uv
    for (let k = 0; k < extraUv; k++) w.floats([k + vertex / 1000, 0.25, 0.5, 0.75]);
    const skin = model.skin[vertex];
    w.u8(skin.deform);
    if (skin.deform === 0) w.index(boneSize, skin.bones[0]);
    else if (skin.deform === 1 || skin.deform === 3) {
      w.index(boneSize, skin.bones[0]); w.index(boneSize, skin.bones[1]); w.f32(skin.weights[0]);
      if (skin.deform === 3) w.floats(skin.sdef ?? [0, 0, 0, 0, 0, 0, 0, 0, 0]); // SDEF C, R0, R1
    } else { for (let k = 0; k < 4; k++) w.index(boneSize, skin.bones[k] ?? -1); for (let k = 0; k < 4; k++) w.f32(skin.weights[k] ?? 0); }
    w.f32(1); // edge
  }
  const faces = model.faces ?? [];
  w.i32(faces.length); for (const vertex of faces) w.vertex(vertexSize, vertex);
  const textures = model.textures ?? [];
  w.i32(textures.length); for (const texture of textures) w.text(texture);
  const materials = model.materials ?? [];
  w.i32(materials.length);
  for (const material of materials) {
    w.text(material.name); w.text(material.englishName ?? material.name);
    w.floats([0.8, 0.8, 0.8, 1, 0.1, 0.1, 0.1, 5, 0.4, 0.4, 0.4]); w.u8(0x1f); w.floats([0, 0, 0, 1, 1]);
    w.index(textureSize, material.texture ?? -1); w.index(textureSize, material.sphere ?? -1); w.u8(material.sphere === undefined ? 0 : 1);
    const toon = material.toon ?? { shared: 0 };
    if ('shared' in toon) { w.u8(1); w.u8(toon.shared); } else { w.u8(0); w.index(textureSize, toon.texture); }
    w.text(material.memo ?? ''); w.i32(material.surfaces);
  }
  w.i32(model.bones.length);
  for (const bone of model.bones) {
    w.text(bone.name); w.text(bone.englishName ?? bone.name); w.vec(bone.position); w.index(boneSize, bone.parent); w.i32(0);
    const grant = bone.grant;
    w.u16(0x001e | (bone.connect !== undefined ? 0x0001 : 0) | (bone.ik ? 0x0020 : 0) | (grant?.local ? 0x0080 : 0) | (grant && grant.rotation !== false ? 0x0100 : 0)
      | (grant?.position ? 0x0200 : 0) | (bone.fixAxis ? 0x0400 : 0) | (bone.localAxes ? 0x0800 : 0) | (bone.externalKey !== undefined ? 0x2000 : 0));
    if (bone.connect !== undefined) w.index(boneSize, bone.connect); else w.floats([0, 0, 0]); // tail
    if (grant) { w.index(boneSize, grant.parent); w.f32(grant.ratio); }
    if (bone.fixAxis) w.floats(bone.fixAxis);
    if (bone.localAxes) { w.floats(bone.localAxes.x); w.floats(bone.localAxes.z); }
    if (bone.externalKey !== undefined) w.i32(bone.externalKey);
    if (bone.ik) {
      w.index(boneSize, bone.ik.effector); w.i32(40); w.f32(2);
      w.i32(bone.ik.links.length);
      for (const link of bone.ik.links) {
        if (typeof link === 'number') { w.index(boneSize, link); w.u8(0); }
        else { w.index(boneSize, link.index); w.u8(1); w.floats(link.limits[0]); w.floats(link.limits[1]); }
      }
    }
  }
  w.i32(model.morphs.length);
  for (const morph of model.morphs) {
    w.text(morph.name); w.text(morph.englishName ?? morph.name); w.u8(morph.panel ?? 1); w.u8(morph.type);
    if (morph.type === 1) {
      w.i32(morph.indices.length);
      morph.indices.forEach((vertex, k) => { w.vertex(vertexSize, vertex); w.vec([morph.deltas[k * 3], morph.deltas[k * 3 + 1], morph.deltas[k * 3 + 2]]); });
    } else if (morph.type === 0) { w.i32(morph.group.length); for (const [index, ratio] of morph.group) { w.index(morphSize, index); w.f32(ratio); } }
    else if (morph.type === 2) { w.i32(morph.bones.length); for (const bone of morph.bones) { w.index(boneSize, bone.index); w.floats(bone.translation); w.floats(bone.rotation); } }
    else if (morph.type === 8) {
      w.i32(morph.materials.length);
      for (const material of morph.materials) {
        w.index(materialSize, material.index); w.u8(material.operation);
        w.floats(material.values ?? Array.from({ length: 28 }, (_, k) => k / 28));
      }
    } else if (morph.type === 9) { w.i32(morph.flips.length); for (const [index, ratio] of morph.flips) { w.index(morphSize, index); w.f32(ratio); } }
    else if (morph.type === 10) {
      w.i32(morph.impulses.length);
      for (const impulse of morph.impulses) { w.index(bodySize, impulse.body); w.u8(impulse.local ? 1 : 0); w.floats(impulse.velocity); w.floats(impulse.torque); }
    } else { w.i32(morph.uvs.length); for (const uv of morph.uvs) { w.vertex(vertexSize, uv.index); w.floats(uv.value); } }
  }
  const frames = model.frames ?? [];
  w.i32(frames.length);
  for (const frame of frames) {
    w.text(frame.name); w.text(frame.englishName ?? frame.name); w.u8(frame.special ? 1 : 0);
    w.i32(frame.elements.length);
    for (const element of frame.elements) { w.u8(element.morph ? 1 : 0); w.index(element.morph ? morphSize : boneSize, element.index); }
  }
  const bodies = model.rigidBodies ?? [];
  w.i32(bodies.length);
  bodies.forEach((body, k) => {
    w.text(body.name ?? `body${k}`); w.text(body.englishName ?? body.name ?? `body${k}`); w.index(boneSize, body.boneIndex); w.u8(0); w.u16(0xffff); w.u8(0);
    w.floats([0.2, 0.2, 0.2]); w.vec(body.boneIndex >= 0 ? model.bones[body.boneIndex].position : [0, 0, 0]); w.floats([0, 0, 0]);
    w.floats([1, 0.5, 0.5, 0, 0.5]); w.u8(body.type);
  });
  const joints = model.joints ?? [];
  w.i32(joints.length);
  joints.forEach((joint, k) => {
    w.text(joint.name ?? `joint${k}`); w.text(joint.englishName ?? joint.name ?? `joint${k}`); w.u8(0); w.index(bodySize, joint.a); w.index(bodySize, joint.b);
    w.floats(Array.from({ length: 24 }, () => 0));
  });
  if (version === 2.1) {
    const softBodies = model.softBodies ?? [];
    w.i32(softBodies.length);
    softBodies.forEach((soft, k) => {
      w.text(soft.name); w.text(soft.englishName ?? soft.name);
      w.u8(k % 2); w.index(materialSize, soft.material); w.u8(3); w.u16(0xfffe); w.u8(0x03); // shape, material, group, no-collision mask, flags
      w.i32(2); w.i32(4); w.f32(1.5); w.f32(0.05); w.i32(1); // B-link distance, clusters, total mass, margin, aero model
      w.floats(Array.from({ length: 12 }, (_, n) => n / 10)); // config
      w.floats(Array.from({ length: 6 }, (_, n) => n / 20)); // cluster
      for (let n = 0; n < 4; n++) w.i32(n + 1); // iterations
      w.floats([1, 0.5, 0.25]); // material
      w.i32(soft.anchors.length);
      for (const anchor of soft.anchors) { w.index(bodySize, anchor.body); w.vertex(vertexSize, anchor.vertex); w.u8(anchor.near ? 1 : 0); }
      w.i32(soft.pins.length); for (const pin of soft.pins) w.vertex(vertexSize, pin);
    });
  }
  return w.result();
}

/** A synthetic fixture (tests/helpers/model-fixtures.ts, body-fixtures.ts) as PMX: full four-weight skin when present, else BDEF1 on the dominant bone. */
export function pmxFromModelData(data: ModelData, options: { name?: string } = {}): PmxWriteModel {
  const count = data.positions.length / 3;
  const skin: PmxSkin[] = Array.from({ length: count }, (_, vertex) => {
    if (!data.skinIndices || !data.skinWeights) return { deform: 0, bones: [data.skinBone[vertex]], weights: [1] };
    const slots = [0, 1, 2, 3].map(k => [data.skinIndices![vertex * 4 + k], data.skinWeights![vertex * 4 + k]] as const).filter(([, weight]) => weight > 0);
    if (slots.length <= 1) return { deform: 0, bones: [slots[0]?.[0] ?? data.skinBone[vertex]], weights: [1] };
    if (slots.length === 2) return { deform: 1, bones: [slots[0][0], slots[1][0]], weights: [slots[0][1]] };
    return { deform: 2, bones: slots.map(([bone]) => bone), weights: slots.map(([, weight]) => weight) };
  });
  // IK bones drive the nearest non-IK bone (the ankle they sit on) through its two parents.
  const bones: PmxWriteBone[] = data.bones.map(bone => ({ name: bone.name, parent: bone.parent, position: bone.position, ...(bone.grant ? { grant: bone.grant } : {}) }));
  data.bones.forEach((bone, index) => {
    if (!bone.ik) return;
    let effector = -1, best = Infinity;
    data.bones.forEach((other, k) => {
      if (other.ik || k === index) return;
      const d = Math.hypot(other.position[0] - bone.position[0], other.position[1] - bone.position[1], other.position[2] - bone.position[2]);
      if (d < best) { best = d; effector = k; }
    });
    const knee = data.bones[effector].parent, leg = knee >= 0 ? data.bones[knee].parent : -1;
    bones[index].ik = { effector, links: [knee, leg].filter(link => link >= 0) };
  });
  return { name: options.name, positions: data.positions, skin, bones,
    morphs: data.morphs.map(morph => ({ name: morph.name, type: 1 as const, indices: morph.indices, deltas: morph.deltas })), rigidBodies: data.rigidBodies ?? [] };
}
