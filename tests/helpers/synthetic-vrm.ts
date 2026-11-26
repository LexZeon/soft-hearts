/**
 * A tiny synthetic VRM (GLB bytes) for the VRM → PMX converter tests: a VRoid-like humanoid (J_Bip_* names, T pose,
 * eyes, index fingers and thumbs, toes), a three-joint hair chain with spring settings and two colliders, a body mesh,
 * a face mesh whose two primitives share their vertices (with three Fcl_* morph targets) and a hair mesh. Every triangle
 * faces the front. Built in VRM 1.0 layout (facing +Z) or VRM 0.x layout (the same model turned to face −Z, 0.x names).
 * Nothing here comes from a real model.
 */
type V3 = [number, number, number];
import { FULL_FACE, fullFace } from './synthetic-vrm-face';
import { fullBody } from './synthetic-vrm-body';

interface NodeSpec { name: string; parent: number | null; world: V3 }
const SIDE = (side: 1 | -1, name: string) => name.replace('_L_', side === 1 ? '_L_' : '_R_');

/**
 * I-152 step 3: a long skirt (a coat's hem): SKIRT_CHAINS chains round her hips, each SKIRT_LEVELS joints from the hips down to below
 * her knees (the last joint is the tail), flaring out; no colliders of its own (like the user's VRoid model's coat).
 */
export const SKIRT_CHAINS = 8;
export const SKIRT_LEVELS: readonly { y: number; r: number }[] = [{ y: 0.85, r: 0.19 }, { y: 0.7, r: 0.21 }, { y: 0.55, r: 0.23 }, { y: 0.4, r: 0.25 }, { y: 0.28, r: 0.26 }];
export const skirtNode = (chain: number, level: number) => `J_Sec_Skirt${chain}_0${level + 1}`;

/** The skeleton in VRM 1.0 world positions (metres): she faces +Z, her left at +X. */
function skeleton(eyeX = 0.03, skirt = false): NodeSpec[] {
  const nodes: NodeSpec[] = [];
  const add = (name: string, parent: string | null, world: V3) => { nodes.push({ name, parent: parent === null ? null : nodes.findIndex(n => n.name === parent), world }); };
  add('Root', null, [0, 0, 0]);
  add('J_Bip_C_Hips', 'Root', [0, 0.9, 0]);
  add('J_Bip_C_Spine', 'J_Bip_C_Hips', [0, 1.0, 0]);
  add('J_Bip_C_Chest', 'J_Bip_C_Spine', [0, 1.15, 0]);
  add('J_Bip_C_Neck', 'J_Bip_C_Chest', [0, 1.35, 0]);
  add('J_Bip_C_Head', 'J_Bip_C_Neck', [0, 1.45, 0]);
  add('J_Adj_L_FaceEye', 'J_Bip_C_Head', [eyeX, 1.51, 0.05]);
  add('J_Adj_R_FaceEye', 'J_Bip_C_Head', [-eyeX, 1.51, 0.05]);
  for (const side of [1, -1] as const) {
    const n = (name: string) => SIDE(side, name);
    add(n('J_Bip_L_Shoulder'), 'J_Bip_C_Chest', [0.02 * side, 1.3, 0]);
    add(n('J_Bip_L_UpperArm'), n('J_Bip_L_Shoulder'), [0.1 * side, 1.3, 0]);
    add(n('J_Bip_L_LowerArm'), n('J_Bip_L_UpperArm'), [0.32 * side, 1.3, 0]);
    add(n('J_Bip_L_Hand'), n('J_Bip_L_LowerArm'), [0.52 * side, 1.3, 0]);
    add(n('J_Bip_L_Index1'), n('J_Bip_L_Hand'), [0.57 * side, 1.3, 0.01]);
    add(n('J_Bip_L_Index2'), n('J_Bip_L_Index1'), [0.59 * side, 1.3, 0.01]);
    add(n('J_Bip_L_Index3'), n('J_Bip_L_Index2'), [0.61 * side, 1.3, 0.01]);
    add(n('J_Bip_L_Thumb1'), n('J_Bip_L_Hand'), [0.54 * side, 1.29, 0.02]);
    add(n('J_Bip_L_Thumb2'), n('J_Bip_L_Thumb1'), [0.56 * side, 1.29, 0.03]);
    add(n('J_Bip_L_Thumb3'), n('J_Bip_L_Thumb2'), [0.58 * side, 1.29, 0.04]);
    add(n('J_Bip_L_UpperLeg'), 'J_Bip_C_Hips', [0.08 * side, 0.85, 0]);
    add(n('J_Bip_L_LowerLeg'), n('J_Bip_L_UpperLeg'), [0.08 * side, 0.45, 0]);
    add(n('J_Bip_L_Foot'), n('J_Bip_L_LowerLeg'), [0.08 * side, 0.08, 0]);
    add(n('J_Bip_L_ToeBase'), n('J_Bip_L_Foot'), [0.08 * side, 0.02, 0.1]);
  }
  add('J_Sec_Hair1_01', 'J_Bip_C_Head', [0, 1.55, -0.08]);
  add('J_Sec_Hair2_01', 'J_Sec_Hair1_01', [0, 1.45, -0.1]);
  add('J_Sec_Hair3_01', 'J_Sec_Hair2_01', [0, 1.35, -0.12]);
  if (skirt) for (let chain = 0; chain < SKIRT_CHAINS; chain++) {
    const angle = chain / SKIRT_CHAINS * Math.PI * 2;
    SKIRT_LEVELS.forEach(({ y, r }, level) => add(skirtNode(chain, level), level ? skirtNode(chain, level - 1) : 'J_Bip_C_Hips', [Math.sin(angle) * r, y, Math.cos(angle) * r]));
  }
  return nodes;
}

const HUMANOID: Record<string, string> = {
  hips: 'J_Bip_C_Hips', spine: 'J_Bip_C_Spine', chest: 'J_Bip_C_Chest', neck: 'J_Bip_C_Neck', head: 'J_Bip_C_Head',
  leftEye: 'J_Adj_L_FaceEye', rightEye: 'J_Adj_R_FaceEye',
  ...Object.fromEntries((['left', 'right'] as const).flatMap(side => {
    const s = side === 'left' ? 'L' : 'R';
    return [['Shoulder', 'Shoulder'], ['UpperArm', 'UpperArm'], ['LowerArm', 'LowerArm'], ['Hand', 'Hand'], ['UpperLeg', 'UpperLeg'], ['LowerLeg', 'LowerLeg'],
      ['Foot', 'Foot'], ['Toes', 'ToeBase'], ['IndexProximal', 'Index1'], ['IndexIntermediate', 'Index2'], ['IndexDistal', 'Index3'],
      ['ThumbMetacarpal', 'Thumb1'], ['ThumbProximal', 'Thumb2'], ['ThumbDistal', 'Thumb3']].map(([bone, node]) => [`${side}${bone}`, `J_Bip_${s}_${node}`]);
  })),
};

/** A vertex: position (VRM 1.0 world, metres), up to four joints by node name with weights. */
interface VertexSpec { at: V3; joints: [string, number][] }
/** Front-facing triangle (counter-clockwise seen from +Z) around a point, skinned as given. */
const tri = (at: V3, joints: [string, number][], size = 0.01): VertexSpec[] =>
  [[at[0] - size, at[1] - size, at[2]], [at[0] + size, at[1] - size, at[2]], [at[0], at[1] + size, at[2]]].map(p => ({ at: p as V3, joints }));

export const SYNTHETIC_MORPHS = ['Fcl_EYE_Close', 'Fcl_MTH_A', 'Fcl_EYE_Joy'] as const;

export interface SyntheticVrmOptions {
  version?: '1.0' | '0.x';
  /** I-164: a VRoid-like full face (synthetic-vrm-face.ts) instead of the few triangles: face skin with an outline, irises, part shapes. 1.0 only. */
  face?: 'full';
  /** With the full face: the upper lid's edge just under the iris's top (the iris fills the socket). */
  irisFill?: boolean;
  /** With the full face: VRoid-like lips (synthetic-vrm-face.ts LIPS_MORPHS: an ih preset and a closed-lip smile part shape). */
  lips?: boolean;
  /** VRM 1.0 lookAt to write (absent: none, the reader's defaults). */
  lookAt?: Record<string, unknown>;
  /** I-164 interaction: a body with volume (synthetic-vrm-body.ts: a tube of vertices along each body bone) instead of one triangle per part. */
  body?: 'full';
  /** I-152 step 3: a long skirt of spring chains with no colliders (SKIRT_CHAINS, SKIRT_LEVELS). */
  skirt?: boolean;
  /** With the skirt (1.0): the skirt names a collider group with the file's own capsule on her left thigh. */
  skirtThighCollider?: boolean;
}

/** The skirt's spring settings (a loose coat hem). */
export const SKIRT_SPRING = { hitRadius: 0.02, stiffness: 0.8, gravityPower: 0.2, dragForce: 0.3 } as const;

export function syntheticVrm(options: SyntheticVrmOptions = {}): Uint8Array {
  const vrm0 = options.version === '0.x';
  // VRM 0.x faces −Z: the same model turned 180° about Y.
  const place = (p: V3): V3 => vrm0 ? [-p[0], p[1], -p[2]] : p;
  const full = options.face === 'full' && !vrm0 ? fullFace(options.irisFill === true, options.lips === true) : null;
  const nodes = skeleton(full ? FULL_FACE.eyeBoneX : 0.03, options.skirt === true);
  const index = (name: string) => nodes.findIndex(node => node.name === name);
  const bin: number[] = [];
  const views: { byteOffset: number; byteLength: number }[] = [], accessors: Record<string, unknown>[] = [];
  const pushFloats = (values: number[], type: string, count: number, extra: Record<string, unknown> = {}) => {
    while (bin.length % 4) bin.push(0);
    const offset = bin.length, bytes = new Uint8Array(new Float32Array(values).buffer);
    bin.push(...bytes);
    views.push({ byteOffset: offset, byteLength: bytes.length });
    accessors.push({ bufferView: views.length - 1, componentType: 5126, count, type, ...extra });
    return accessors.length - 1;
  };
  const pushShorts = (values: number[], type: string, count: number) => {
    while (bin.length % 4) bin.push(0);
    const offset = bin.length, bytes = new Uint8Array(new Uint16Array(values).buffer);
    bin.push(...bytes);
    views.push({ byteOffset: offset, byteLength: bytes.length });
    accessors.push({ bufferView: views.length - 1, componentType: 5123, count, type });
    return accessors.length - 1;
  };
  const joints = nodes.map((node, k) => k).filter(k => nodes[k].name.startsWith('J_'));
  const jointSlot = new Map(joints.map((node, k) => [node, k]));
  const ibm = joints.flatMap(node => { const p = place(nodes[node].world); return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -p[0], -p[1], -p[2], 1]; });
  const ibmAccessor = pushFloats(ibm, 'MAT4', joints.length);

  /** One primitive's vertex accessors from vertex specs (normals face the model's front). */
  const vertexAttributes = (vertices: VertexSpec[]) => {
    const positions = vertices.flatMap(v => place(v.at)), normals = vertices.flatMap(() => vrm0 ? [0, 0, -1] : [0, 0, 1]);
    const uvs = vertices.flatMap((_, k) => [(k % 3) / 2, k % 2]);
    const j: number[] = [], w: number[] = [];
    for (const v of vertices) for (let k = 0; k < 4; k++) { const entry = v.joints[k]; j.push(entry ? jointSlot.get(index(entry[0]))! : 0); w.push(entry ? entry[1] : 0); }
    const min = [0, 1, 2].map(k => Math.min(...positions.filter((_, i) => i % 3 === k))), max = [0, 1, 2].map(k => Math.max(...positions.filter((_, i) => i % 3 === k)));
    return {
      POSITION: pushFloats(positions, 'VEC3', vertices.length, { min, max }), NORMAL: pushFloats(normals, 'VEC3', vertices.length),
      TEXCOORD_0: pushFloats(uvs, 'VEC2', vertices.length), JOINTS_0: pushShorts(j, 'VEC4', vertices.length), WEIGHTS_0: pushFloats(w, 'VEC4', vertices.length),
    };
  };
  const indicesOf = (from: number, count: number) => pushShorts(Array.from({ length: count }, (_, k) => from + k), 'SCALAR', count);

  // Body: one triangle per body part, an upper-arm triangle near the elbow (twist share), an elbow vertex split 50/50,
  // a vertex over four joints with one tiny weight (dropped).
  const body: VertexSpec[] = options.body === 'full' ? fullBody() : [
    ...tri([0, 1.1, 0.1], [['J_Bip_C_Spine', 1]]),
    ...tri([0, 0.88, 0.1], [['J_Bip_C_Hips', 1]]),
    ...tri([0.29, 1.3, 0.04], [['J_Bip_L_UpperArm', 1]]),
    ...tri([-0.29, 1.3, 0.04], [['J_Bip_R_UpperArm', 1]]),
    ...tri([0.32, 1.3, 0.04], [['J_Bip_L_UpperArm', 0.5], ['J_Bip_L_LowerArm', 0.5]]),
    ...tri([0.55, 1.3, 0.03], [['J_Bip_L_Hand', 0.6], ['J_Bip_L_LowerArm', 0.3], ['J_Bip_L_Index1', 0.098], ['J_Bip_L_Thumb1', 0.002]]),
    ...tri([0.08, 0.6, 0.06], [['J_Bip_L_UpperLeg', 1]]),
    ...tri([-0.08, 0.6, 0.06], [['J_Bip_R_UpperLeg', 1]]),
    ...tri([0.08, 0.03, 0.12], [['J_Bip_L_ToeBase', 1]]),
  ];
  const bodyAttributes = vertexAttributes(body);
  // Face: two primitives sharing one vertex block, three morph targets.
  // Vertices 0–2 the mouth, 3–5 her left eye, 6–8 her right eye, 9–11 the forehead, 12–14 the cheeks (the model profile
  // measures a head from at least 12 vertices skinned to it).
  const head = (at: V3, size: number) => tri(at, [['J_Bip_C_Head', 1]], size);
  const face: VertexSpec[] = full ? full.vertices : [...head([0, 1.47, 0.09], 0.01), ...head([0.03, 1.51, 0.1], 0.005), ...head([-0.03, 1.51, 0.1], 0.005), ...head([0, 1.56, 0.08], 0.02), ...head([0, 1.49, 0.085], 0.03)];
  const faceAttributes = vertexAttributes(face);
  const delta = (vertices: number[], d: V3) => pushFloats(face.flatMap((_, k) => vertices.includes(k) ? place(d) : [0, 0, 0]), 'VEC3', face.length);
  // Fcl_EYE_Close: both eyes down; Fcl_MTH_A: the mouth down; Fcl_EYE_Joy: both eyes a little.
  const targets = full ? full.names.map(name => ({ POSITION: pushFloats(full.targets[name].flat(), 'VEC3', face.length, { min: [0, 1, 2].map(k => Math.min(...full.targets[name].map(d => d[k]))), max: [0, 1, 2].map(k => Math.max(...full.targets[name].map(d => d[k]))) }) }))
    : [{ POSITION: delta([3, 4, 5, 6, 7, 8], [0, -0.008, 0]) }, { POSITION: delta([0, 1, 2], [0, -0.01, 0]) }, { POSITION: delta([3, 4, 5, 6, 7, 8], [0, -0.004, 0]) }];
  const hair: VertexSpec[] = [...tri([0, 1.5, -0.13], [['J_Sec_Hair1_01', 1]]), ...tri([0, 1.4, -0.145], [['J_Sec_Hair2_01', 1]])];
  const hairAttributes = vertexAttributes(hair);

  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
  while (bin.length % 4) bin.push(0);
  views.push({ byteOffset: bin.length, byteLength: png.length }); bin.push(...png);
  const imageView = views.length - 1;

  const meshNodes = [{ name: 'Body', mesh: 0 }, { name: 'Face', mesh: 1 }, { name: 'Hair', mesh: 2 }];
  const gltfNodes: Record<string, unknown>[] = nodes.map((node, k) => {
    const parentWorld = node.parent === null ? [0, 0, 0] : place(nodes[node.parent].world), own = place(node.world);
    const children = nodes.map((n, c) => n.parent === k ? c : -1).filter(c => c >= 0);
    if (k === 0) children.push(...meshNodes.map((_, m) => nodes.length + m));
    return { name: node.name, translation: [own[0] - parentWorld[0], own[1] - parentWorld[1], own[2] - parentWorld[2]], ...(children.length ? { children } : {}) };
  });
  meshNodes.forEach(mesh => gltfNodes.push({ name: mesh.name, mesh: mesh.mesh, skin: 0 }));
  const faceNode = nodes.length + 1;
  const mtoon = (outline: boolean) => ({ VRMC_materials_mtoon: { specVersion: '1.0', outlineWidthMode: outline ? 'worldCoordinates' : 'none', outlineWidthFactor: outline ? 0.002 : 0, outlineColorFactor: [0.1, 0.2, 0.3] } });
  const textureInfo = (transform = false) => ({ index: 0, ...(transform ? { extensions: { KHR_texture_transform: { offset: [0.5, 0.25], scale: [0.5, 0.5] } } } : {}) });
  const materials = [
    { name: 'Body_00_SKIN (Instance)', alphaMode: 'OPAQUE', doubleSided: false, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], baseColorTexture: textureInfo() }, extensions: mtoon(true) },
    { name: 'Face_00_SKIN (Instance)', alphaMode: 'MASK', alphaCutoff: 0.5, doubleSided: true, pbrMetallicRoughness: { baseColorTexture: textureInfo() }, extensions: mtoon(!!full) },
    { name: 'EyeIris_00_EYE (Instance)', alphaMode: 'BLEND', doubleSided: false, pbrMetallicRoughness: { baseColorTexture: textureInfo() }, extensions: mtoon(false) },
    { name: 'Hair_00_HAIR (Instance)', alphaMode: 'MASK', doubleSided: true, pbrMetallicRoughness: { baseColorTexture: textureInfo(true) }, extensions: mtoon(false) },
  ];
  const meshes = [
    { name: 'Body', primitives: [{ attributes: bodyAttributes, indices: indicesOf(0, body.length), material: 0 }] },
    full ? { name: 'Face', extras: { targetNames: [...full.names] }, primitives: [
      { attributes: faceAttributes, indices: pushShorts(full.skin, 'SCALAR', full.skin.length), material: 1, targets },
      { attributes: faceAttributes, indices: pushShorts(full.iris, 'SCALAR', full.iris.length), material: 2, targets },
    ] } : { name: 'Face', extras: { targetNames: [...SYNTHETIC_MORPHS] }, primitives: [
      { attributes: faceAttributes, indices: pushShorts([0, 1, 2, 6, 7, 8, 9, 10, 11, 12, 13, 14], 'SCALAR', 12), material: 1, targets },
      { attributes: faceAttributes, indices: indicesOf(3, 3), material: 2, targets },
    ] },
    { name: 'Hair', primitives: [{ attributes: hairAttributes, indices: indicesOf(0, hair.length), material: 3 }] },
  ];
  const json: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'soft-hearts synthetic test VRM' },
    extensionsUsed: vrm0 ? ['VRM'] : ['VRMC_vrm', 'VRMC_springBone', 'VRMC_materials_mtoon', 'KHR_texture_transform'],
    scene: 0, scenes: [{ nodes: [0] }], nodes: gltfNodes, meshes, materials,
    skins: [{ joints, inverseBindMatrices: ibmAccessor }], accessors, bufferViews: views.map(view => ({ buffer: 0, ...view })),
    buffers: [{ byteLength: bin.length }], textures: [{ source: 0 }], images: [{ bufferView: imageView, mimeType: 'image/png', name: 'skin tex' }],
  };
  const humanoidNodes = Object.entries(HUMANOID).map(([bone, name]) => [bone, index(name)] as const);
  const hairJoints = ['J_Sec_Hair1_01', 'J_Sec_Hair2_01', 'J_Sec_Hair3_01'].map(index);
  const skirtChains = options.skirt ? Array.from({ length: SKIRT_CHAINS }, (_, chain) => SKIRT_LEVELS.map((_, level) => index(skirtNode(chain, level)))) : [];
  const { hitRadius, stiffness, gravityPower, dragForce } = SKIRT_SPRING;
  if (!vrm0) {
    json.extensions = {
      VRMC_vrm: {
        specVersion: '1.0', meta: { name: 'Synthetic', authors: ['test'], licenseUrl: 'https://vrm.dev/licenses/1.0/' },
        humanoid: { humanBones: Object.fromEntries(humanoidNodes.map(([bone, node]) => [bone, { node }])) },
        expressions: { preset: {
          blink: { morphTargetBinds: [{ node: faceNode, index: 0, weight: 1 }] },
          aa: { morphTargetBinds: [{ node: faceNode, index: 1, weight: 1 }] },
          happy: { morphTargetBinds: [{ node: faceNode, index: 2, weight: 1 }] },
          ...(full ? { blinkLeft: { morphTargetBinds: [{ node: faceNode, index: 3, weight: 1 }] }, blinkRight: { morphTargetBinds: [{ node: faceNode, index: 4, weight: 1 }] },
            ou: { morphTargetBinds: [{ node: faceNode, index: 5, weight: 1 }] } } : {}),
          ...(full && options.lips ? { ih: { morphTargetBinds: [{ node: faceNode, index: full.names.indexOf('Fcl_MTH_I'), weight: 1 }] } } : {}),
        }, ...(full ? { custom: { cheekPuff: { morphTargetBinds: [{ node: faceNode, index: 8, weight: 1 }] } } } : {}) },
        ...(options.lookAt ? { lookAt: options.lookAt } : {}),
      },
      VRMC_springBone: {
        specVersion: '1.0',
        colliders: [
          { node: index('J_Bip_C_Head'), shape: { sphere: { offset: [0, 0.06, 0], radius: 0.09 } } },
          { node: index('J_Bip_C_Chest'), shape: { capsule: { offset: [0, 0, -0.05], radius: 0.05, tail: [0, 0.15, -0.05] } } },
          ...(options.skirtThighCollider ? [{ node: index('J_Bip_L_UpperLeg'), shape: { capsule: { offset: [0, 0, 0], radius: 0.06, tail: [0, -0.4, 0] } } }] : []),
        ],
        colliderGroups: [{ name: 'body', colliders: [0, 1] }, ...(options.skirtThighCollider ? [{ name: 'thigh', colliders: [2] }] : [])],
        springs: [{ name: 'Hair', colliderGroups: [0], joints: hairJoints.map(node => ({ node, hitRadius: 0.02, stiffness: 1, gravityPower: 0, gravityDir: [0, -1, 0], dragForce: 0.4 })) },
          ...skirtChains.map((chain, k) => ({ name: `Skirt${k}`, ...(options.skirtThighCollider ? { colliderGroups: [1] } : {}),
            joints: chain.map(node => ({ node, hitRadius, stiffness, gravityPower, gravityDir: [0, -1, 0], dragForce })) }))],
      },
    };
  } else {
    const vrm0Name = (bone: string) => bone.replace(/Thumb(Metacarpal|Proximal|Distal)$/, (_, joint: string) => `Thumb${joint === 'Metacarpal' ? 'Proximal' : joint === 'Proximal' ? 'Intermediate' : 'Distal'}`);
    json.extensions = {
      VRM: {
        exporterVersion: 'synthetic', specVersion: '0.0', meta: { title: 'Synthetic', author: 'test' },
        humanoid: { humanBones: humanoidNodes.map(([bone, node]) => ({ bone: vrm0Name(bone), node })) },
        blendShapeMaster: { blendShapeGroups: [
          { name: 'Blink', presetName: 'blink', binds: [{ mesh: 1, index: 0, weight: 100 }] },
          { name: 'A', presetName: 'a', binds: [{ mesh: 1, index: 1, weight: 100 }] },
        ] },
        secondaryAnimation: {
          boneGroups: [{ comment: 'Hair', stiffiness: 1, gravityPower: 0, gravityDir: { x: 0, y: -1, z: 0 }, dragForce: 0.4, hitRadius: 0.02, bones: [hairJoints[0]], colliderGroups: [0] },
            ...(skirtChains.length ? [{ comment: 'Skirt', stiffiness: stiffness, gravityPower, gravityDir: { x: 0, y: -1, z: 0 }, dragForce, hitRadius, bones: skirtChains.map(chain => chain[0]), colliderGroups: [] }] : [])],
          // 0.x offsets are written z-mirrored.
          colliderGroups: [{ node: index('J_Bip_C_Head'), colliders: [{ offset: { x: 0, y: 0.06, z: 0 }, radius: 0.09 }] }],
        },
        materialProperties: materials.map((material, k) => ({ name: material.name, shader: 'VRM/MToon', floatProperties: { _OutlineWidthMode: k === 0 ? 1 : 0, _OutlineWidth: k === 0 ? 0.2 : 0 }, vectorProperties: { _OutlineColor: [0.1, 0.2, 0.3, 1] } })),
      },
    };
    for (const material of materials) delete (material as { extensions?: unknown }).extensions;
  }
  return glb(json, Uint8Array.from(bin));
}

function glb(json: Record<string, unknown>, bin: Uint8Array): Uint8Array {
  let text = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (text.length % 4)) % 4;
  if (pad) text = Uint8Array.from([...text, ...new Array(pad).fill(0x20)]);
  const binPad = (4 - (bin.length % 4)) % 4, binBytes = Uint8Array.from([...bin, ...new Array(binPad).fill(0)]);
  const out = new Uint8Array(12 + 8 + text.length + 8 + binBytes.length), view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, out.length, true);
  view.setUint32(12, text.length, true); view.setUint32(16, 0x4e4f534a, true); out.set(text, 20);
  const at = 20 + text.length;
  view.setUint32(at, binBytes.length, true); view.setUint32(at + 4, 0x004e4942, true); out.set(binBytes, at + 8);
  return out;
}
