/**
 * Test-only, read-only PMX 2.0/2.1 reader for the bundled Gene model.
 *
 * The sandbox lacks `three/examples` (MMDLoader/MMDParser), so profile tests
 * read just what the model profile needs: vertex positions and dominant skin
 * bone, bone names/parents/rest positions, and vertex (and group-of-vertex)
 * morph offsets. Coordinates follow Three's MMDLoader: PMX is left-handed, so
 * z is negated, exactly as the loader does for vertices, bones and morphs.
 * The bytes are never modified.
 */
export interface PmxLiteBone {
  name: string; parent: number; position: [number, number, number]; ik: boolean;
  /** 付与 (inherit rotation/position) source and ratio, as MMDLoader's `userData.MMD.grants` carry it. */
  grant?: { parent: number; ratio: number };
}
export interface PmxLiteMorph { name: string; type: number; indices: number[]; deltas: number[] }
export interface PmxLiteRigidBody { boneIndex: number; type: number }
export interface PmxLiteModel {
  positions: Float32Array;
  /** Dominant skin bone per vertex (highest weight). */
  skinBone: Int32Array;
  /** Four bone indices and weights per vertex, as MMDParser/MMDLoader give them (BDEF1 [i] [1], BDEF2/SDEF [a, b] [w, 1-w], BDEF4/QDEF as stored; unused slots 0/0). */
  skinIndices: Int32Array;
  skinWeights: Float32Array;
  /** PMX deform type per vertex (0 BDEF1, 1 BDEF2, 2 BDEF4, 3 SDEF, 4 QDEF). */
  deform: Uint8Array;
  /** Triangle vertex indices, three per face. */
  faces: Uint32Array;
  bones: PmxLiteBone[];
  morphs: PmxLiteMorph[];
  /** Rigid bodies: attached bone and physics mode (0 follows the bone, 1 dynamic, 2 dynamic aligned to the bone). */
  rigidBodies: PmxLiteRigidBody[];
}

export function readPmxLite(input: Uint8Array): PmxLiteModel {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let at = 0;
  const u8 = () => view.getUint8(at++);
  const i32 = () => { const value = view.getInt32(at, true); at += 4; return value; };
  const f32 = () => { const value = view.getFloat32(at, true); at += 4; return value; };
  const skip = (bytes: number) => { at += bytes; };
  if (String.fromCharCode(u8(), u8(), u8(), u8()) !== 'PMX ') throw new Error('Not a PMX file');
  f32();
  const globals = Array.from({ length: u8() }, () => u8());
  const [encoding, extraUv, vertexSize, textureSize, materialSize, boneSize, morphSize] = globals;
  const decoder = new TextDecoder(encoding === 0 ? 'utf-16le' : 'utf-8');
  const text = () => { const length = i32(); const value = decoder.decode(input.subarray(at, at + length)); at += length; return value; };
  const index = (size: number) => {
    const value = size === 1 ? view.getInt8(at) : size === 2 ? view.getInt16(at, true) : view.getInt32(at, true);
    at += size; return value;
  };
  const vertexIndex = (size: number) => {
    const value = size === 1 ? view.getUint8(at) : size === 2 ? view.getUint16(at, true) : view.getInt32(at, true);
    at += size; return value;
  };
  text(); text(); text(); text();
  const vertexCount = i32();
  const positions = new Float32Array(vertexCount * 3);
  const skinBone = new Int32Array(vertexCount);
  const skinIndices = new Int32Array(vertexCount * 4), skinWeights = new Float32Array(vertexCount * 4), deformTypes = new Uint8Array(vertexCount);
  const setSkin = (vertex: number, indices: number[], weights: number[]) => {
    for (let k = 0; k < indices.length; k++) { skinIndices[vertex * 4 + k] = indices[k]; skinWeights[vertex * 4 + k] = weights[k]; }
  };
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    positions[vertex * 3] = f32(); positions[vertex * 3 + 1] = f32(); positions[vertex * 3 + 2] = -f32();
    skip(12 + 8 + 16 * extraUv);
    const deform = u8();
    deformTypes[vertex] = deform;
    if (deform === 0) { skinBone[vertex] = index(boneSize); setSkin(vertex, [skinBone[vertex]], [1]); }
    else if (deform === 1 || deform === 3) {
      const a = index(boneSize), b = index(boneSize), weight = f32();
      skinBone[vertex] = weight >= 0.5 ? a : b;
      setSkin(vertex, [a, b], [weight, 1 - weight]);
      if (deform === 3) skip(36);
    } else if (deform === 2 || deform === 4) {
      const bones = [index(boneSize), index(boneSize), index(boneSize), index(boneSize)];
      const weights = [f32(), f32(), f32(), f32()];
      let best = 0; for (let k = 1; k < 4; k++) if (weights[k] > weights[best]) best = k;
      skinBone[vertex] = bones[best];
      setSkin(vertex, bones, weights);
    } else throw new Error(`Unknown deform ${deform}`);
    f32();
  }
  const surfaces = i32(), faces = new Uint32Array(surfaces);
  for (let k = 0; k < surfaces; k++) faces[k] = vertexIndex(vertexSize);
  const textures = i32(); for (let n = 0; n < textures; n++) text();
  const materials = i32();
  for (let n = 0; n < materials; n++) {
    text(); text(); skip(16 + 12 + 4 + 12 + 1 + 16 + 4); index(textureSize); index(textureSize); skip(1);
    if (u8() === 0) index(textureSize); else skip(1);
    text(); i32();
  }
  const bones: PmxLiteBone[] = [];
  const boneCount = i32();
  for (let n = 0; n < boneCount; n++) {
    const name = text(); text();
    const position: [number, number, number] = [f32(), f32(), -f32()];
    const parent = index(boneSize); i32();
    const flags = view.getUint16(at, true); at += 2;
    if (flags & 0x0001) index(boneSize); else skip(12);
    let grant: PmxLiteBone['grant'];
    if (flags & 0x0300) { const source = index(boneSize); grant = { parent: source, ratio: f32() }; }
    if (flags & 0x0400) skip(12);
    if (flags & 0x0800) skip(24);
    if (flags & 0x2000) i32();
    if (flags & 0x0020) {
      index(boneSize); i32(); f32();
      const links = i32();
      for (let link = 0; link < links; link++) { index(boneSize); if (u8()) skip(24); }
    }
    bones.push({ name, parent, position, ik: (flags & 0x0020) !== 0, ...(grant ? { grant } : {}) });
  }
  const raw: { name: string; type: number; vertices: Map<number, [number, number, number]>; groups: [number, number][] }[] = [];
  const morphCount = i32();
  for (let n = 0; n < morphCount; n++) {
    const name = text(); text(); u8();
    const type = u8(), count = i32();
    const vertices = new Map<number, [number, number, number]>(), groups: [number, number][] = [];
    for (let k = 0; k < count; k++) {
      if (type === 0) groups.push([index(morphSize), f32()]);
      else if (type === 1) { const vertex = vertexIndex(vertexSize); vertices.set(vertex, [f32(), f32(), -f32()]); }
      else if (type === 2) { index(boneSize); skip(28); }
      else if (type >= 3 && type <= 7) { vertexIndex(vertexSize); skip(16); }
      else if (type === 8) { index(materialSize); skip(1 + 16 + 12 + 4 + 12 + 16 + 4 + 16 + 16 + 16); }
      else if (type === 9) { index(morphSize); f32(); }
      else if (type === 10) { index(globals[7]); skip(1 + 24); }
      else throw new Error(`Unknown morph type ${type}`);
    }
    raw.push({ name, type, vertices, groups });
  }
  const frames = i32();
  for (let n = 0; n < frames; n++) {
    text(); text(); u8();
    const elements = i32();
    for (let k = 0; k < elements; k++) { if (u8() === 0) index(boneSize); else index(morphSize); }
  }
  const rigidBodies: PmxLiteRigidBody[] = [];
  const bodyCount = i32();
  for (let n = 0; n < bodyCount; n++) {
    text(); text();
    const boneIndex = index(boneSize);
    skip(1 + 2 + 1 + 12 + 12 + 12 + 4 * 5);
    rigidBodies.push({ boneIndex, type: u8() });
  }
  // Group morphs of vertex morphs, as Three's MMDLoader builds them.
  const morphs = raw.map(morph => {
    const total = new Map<number, [number, number, number]>();
    const add = (source: Map<number, [number, number, number]>, ratio: number) => {
      for (const [vertex, delta] of source) {
        const value = total.get(vertex) ?? [0, 0, 0];
        value[0] += delta[0] * ratio; value[1] += delta[1] * ratio; value[2] += delta[2] * ratio;
        total.set(vertex, value);
      }
    };
    if (morph.type === 1) add(morph.vertices, 1);
    else if (morph.type === 0) for (const [child, ratio] of morph.groups) if (raw[child]?.type === 1) add(raw[child].vertices, ratio);
    const indices = [...total.keys()];
    return { name: morph.name, type: morph.type, indices, deltas: indices.flatMap(vertex => total.get(vertex)!) };
  });
  return { positions, skinBone, skinIndices, skinWeights, deform: deformTypes, faces, bones, morphs, rigidBodies };
}
