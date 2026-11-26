/**
 * The glTF JSON of a VRM as far as our VRM readers read it (I-152): the VRM → PMX converter (electron/stage/model-import/vrm/) and
 * the stage's native VRM loading (src/stage/model-adapter/vrm.ts) share these types and the error. Pure types, no I/O, no Three.
 */

export class VrmImportError extends Error {
  constructor(message: string) { super(message); this.name = 'VrmImportError'; }
}

/** The glTF JSON as far as the converter reads it (everything optional: a malformed file is rejected where it is read). */
export interface GltfJson {
  asset?: { version?: string; generator?: string };
  extensionsUsed?: string[];
  extensions?: Record<string, unknown>;
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GltfNode[];
  meshes?: GltfMesh[];
  skins?: { joints: number[]; inverseBindMatrices?: number; skeleton?: number; name?: string }[];
  accessors?: GltfAccessor[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  buffers?: { byteLength: number; uri?: string }[];
  materials?: GltfMaterial[];
  textures?: { source?: number; sampler?: number; extensions?: Record<string, unknown> }[];
  images?: { bufferView?: number; mimeType?: string; name?: string; uri?: string }[];
}
export interface GltfNode {
  name?: string; children?: number[]; mesh?: number; skin?: number;
  translation?: number[]; rotation?: number[]; scale?: number[]; matrix?: number[];
  extensions?: Record<string, unknown>;
}
export interface GltfPrimitive {
  attributes: Record<string, number>; indices?: number; material?: number; mode?: number;
  targets?: Record<string, number>[]; extras?: { targetNames?: string[] };
}
export interface GltfMesh { name?: string; primitives: GltfPrimitive[]; extras?: { targetNames?: string[] }; weights?: number[] }
export interface GltfAccessor {
  bufferView?: number; byteOffset?: number; componentType: number; normalized?: boolean; count: number; type: string;
  sparse?: { count: number; indices: { bufferView: number; byteOffset?: number; componentType: number }; values: { bufferView: number; byteOffset?: number } };
}
export interface GltfTextureInfo { index: number; texCoord?: number; extensions?: Record<string, unknown> }
export interface GltfMaterial {
  name?: string; alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND'; alphaCutoff?: number; doubleSided?: boolean;
  pbrMetallicRoughness?: { baseColorFactor?: number[]; baseColorTexture?: GltfTextureInfo };
  emissiveFactor?: number[];
  extensions?: Record<string, unknown>;
}
