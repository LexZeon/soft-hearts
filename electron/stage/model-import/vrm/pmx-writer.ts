/**
 * PMX 2.0 bytes from a PmxModel (pmx-model.ts). Text is UTF-16LE (the only encoding three's MMDParser reads, so the asset
 * protocol serves the file untouched), no additional UVs, index sizes chosen from the counts.
 *
 * Space: the model is in Three's space; the file is MMD's left-handed space. MMDParser's leftToRight negates z, reverses each
 * triangle and negates rigid-body/joint Euler x and y, so this writer does exactly the inverse. IK limits are written as given.
 */
import type { PmxModel, Vec3 } from './pmx-model';

class ByteWriter {
  private buffer = new Uint8Array(1 << 20);
  private view = new DataView(this.buffer.buffer);
  length = 0;
  private reserve(bytes: number) {
    if (this.length + bytes <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < this.length + bytes) size *= 2;
    const next = new Uint8Array(size); next.set(this.buffer.subarray(0, this.length));
    this.buffer = next; this.view = new DataView(next.buffer);
  }
  u8(value: number) { this.reserve(1); this.view.setUint8(this.length, value); this.length += 1; }
  i8(value: number) { this.reserve(1); this.view.setInt8(this.length, value); this.length += 1; }
  u16(value: number) { this.reserve(2); this.view.setUint16(this.length, value, true); this.length += 2; }
  i16(value: number) { this.reserve(2); this.view.setInt16(this.length, value, true); this.length += 2; }
  i32(value: number) { this.reserve(4); this.view.setInt32(this.length, value, true); this.length += 4; }
  u32(value: number) { this.reserve(4); this.view.setUint32(this.length, value, true); this.length += 4; }
  f32(value: number) { this.reserve(4); this.view.setFloat32(this.length, Number.isFinite(value) ? value : 0, true); this.length += 4; }
  bytes(data: Uint8Array) { this.reserve(data.length); this.buffer.set(data, this.length); this.length += data.length; }
  text(value: string) {
    const units = new Uint8Array(value.length * 2);
    for (let k = 0; k < value.length; k++) { const code = value.charCodeAt(k); units[k * 2] = code & 0xff; units[k * 2 + 1] = code >> 8; }
    this.i32(units.length); this.bytes(units);
  }
  result(): Uint8Array { return this.buffer.slice(0, this.length); }
}

/** Signed index size for bones, textures, materials, morphs, bodies (-1 must fit). */
const signedSize = (count: number) => count < 128 ? 1 : count < 32768 ? 2 : 4;
/** Vertex indices are unsigned for sizes 1 and 2 (MMDParser reads them unsigned). */
const vertexSize = (count: number) => count < 256 ? 1 : count < 65536 ? 2 : 4;

const file = (v: ArrayLike<number>, at = 0): Vec3 => [v[at], v[at + 1], -v[at + 2]];
const fileEuler = (r: Vec3): Vec3 => [-r[0], -r[1], r[2]];

export function writePmx(model: PmxModel): Uint8Array {
  const w = new ByteWriter();
  const vertexCount = model.positions.length / 3;
  const sizes = {
    vertex: vertexSize(vertexCount), texture: signedSize(model.textures.length), material: signedSize(model.materials.length),
    bone: signedSize(model.bones.length), morph: signedSize(model.morphs.length), body: signedSize(model.bodies.length),
  };
  const index = (size: number, value: number) => size === 1 ? w.i8(value) : size === 2 ? w.i16(value) : w.i32(value);
  const vertexIndex = (value: number) => sizes.vertex === 1 ? w.u8(value) : sizes.vertex === 2 ? w.u16(value) : w.i32(value);
  const vec = (value: ArrayLike<number>) => { w.f32(value[0]); w.f32(value[1]); w.f32(value[2]); };

  w.bytes(new Uint8Array([0x50, 0x4d, 0x58, 0x20])); w.f32(2.0);
  w.u8(8); w.u8(0); w.u8(0); w.u8(sizes.vertex); w.u8(sizes.texture); w.u8(sizes.material); w.u8(sizes.bone); w.u8(sizes.morph); w.u8(sizes.body);
  w.text(model.name); w.text(model.nameEn); w.text(model.comment); w.text(model.commentEn);

  w.i32(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    vec(file(model.positions, v * 3)); vec(file(model.normals, v * 3));
    w.f32(model.uvs[v * 2]); w.f32(model.uvs[v * 2 + 1]);
    const bones: number[] = [], weights: number[] = [];
    for (let k = 0; k < 4; k++) { const bone = model.skinIndices[v * 4 + k], weight = model.skinWeights[v * 4 + k]; if (bone >= 0 && weight > 0) { bones.push(bone); weights.push(weight); } }
    if (bones.length <= 1) { w.u8(0); index(sizes.bone, bones[0] ?? 0); }
    else if (bones.length === 2) { w.u8(1); index(sizes.bone, bones[0]); index(sizes.bone, bones[1]); w.f32(weights[0] / (weights[0] + weights[1])); }
    else { w.u8(2); for (let k = 0; k < 4; k++) index(sizes.bone, bones[k] ?? 0); for (let k = 0; k < 4; k++) w.f32(weights[k] ?? 0); }
    w.f32(1); // edge ratio
  }

  w.i32(model.indices.length);
  for (let t = 0; t < model.indices.length; t += 3) { vertexIndex(model.indices[t + 2]); vertexIndex(model.indices[t + 1]); vertexIndex(model.indices[t]); }

  w.i32(model.textures.length);
  for (const texture of model.textures) w.text(texture);

  w.i32(model.materials.length);
  for (const material of model.materials) {
    w.text(material.name); w.text(material.nameEn);
    for (const value of material.diffuse) w.f32(value);
    vec(material.specular); w.f32(material.shininess); vec(material.ambient);
    w.u8(material.flags);
    for (const value of material.edgeColor) w.f32(value);
    w.f32(material.edgeSize);
    index(sizes.texture, material.texture); index(sizes.texture, -1); w.u8(0); // no sphere map
    w.u8(0); index(sizes.texture, -1); // individual toon: none (MMDLoader then uses its default toon00)
    w.text('');
    w.i32(material.indexCount);
  }

  w.i32(model.bones.length);
  for (const bone of model.bones) {
    w.text(bone.name); w.text(bone.nameEn); vec(file(bone.position)); index(sizes.bone, bone.parent); w.i32(bone.layer);
    const connect = typeof bone.tail === 'number';
    const flags = (bone.flags & ~0x0001 & ~0x0100 & ~0x0400 & ~0x0020) | (connect ? 0x0001 : 0) | (bone.grant ? 0x0100 : 0) | (bone.fixAxis ? 0x0400 : 0) | (bone.ik ? 0x0020 : 0);
    w.u16(flags);
    if (connect) index(sizes.bone, bone.tail as number); else vec(file(bone.tail as Vec3));
    if (bone.grant) { index(sizes.bone, bone.grant.parent); w.f32(bone.grant.ratio); }
    if (bone.fixAxis) vec(file(bone.fixAxis));
    if (bone.ik) {
      index(sizes.bone, bone.ik.target); w.i32(bone.ik.loop); w.f32(bone.ik.limitRad); w.i32(bone.ik.links.length);
      for (const link of bone.ik.links) {
        index(sizes.bone, link.bone);
        if (link.limits) { w.u8(1); vec(link.limits.min); vec(link.limits.max); } else w.u8(0);
      }
    }
  }

  w.i32(model.morphs.length);
  for (const morph of model.morphs) {
    w.text(morph.name); w.text(morph.nameEn); w.u8(morph.panel);
    if (morph.kind === 'group') {
      w.u8(0); w.i32(morph.members.length);
      for (const member of morph.members) { index(sizes.morph, member.morph); w.f32(member.ratio); }
    } else {
      w.u8(1); w.i32(morph.indices.length);
      for (let k = 0; k < morph.indices.length; k++) { vertexIndex(morph.indices[k]); vec(file(morph.offsets, k * 3)); }
    }
  }

  w.i32(model.frames.length);
  for (const frame of model.frames) {
    w.text(frame.name); w.text(frame.nameEn); w.u8(frame.special ? 1 : 0); w.i32(frame.items.length);
    for (const item of frame.items) { w.u8(item.kind === 'bone' ? 0 : 1); index(item.kind === 'bone' ? sizes.bone : sizes.morph, item.index); }
  }

  w.i32(model.bodies.length);
  for (const body of model.bodies) {
    w.text(body.name); w.text(body.nameEn); index(sizes.bone, body.bone); w.u8(body.group); w.u16(body.mask); w.u8(body.shape);
    vec(body.size); vec(file(body.position)); vec(fileEuler(body.rotation));
    w.f32(body.mass); w.f32(body.linearDamping); w.f32(body.angularDamping); w.f32(body.restitution); w.f32(body.friction); w.u8(body.mode);
  }

  w.i32(model.joints.length);
  for (const joint of model.joints) {
    w.text(joint.name); w.text(joint.nameEn); w.u8(0); index(sizes.body, joint.bodyA); index(sizes.body, joint.bodyB);
    vec(file(joint.position)); vec(fileEuler(joint.rotation));
    const t = joint.translationLimit, r = joint.rotationLimit;
    vec([-t[0], -t[1], -t[2]]); vec(t); vec([-r[0], -r[1], -r[2]]); vec(r);
    vec(joint.springTranslation); vec(joint.springRotation);
  }
  return w.result();
}
