/**
 * GLB container and glTF accessor reading for the VRM → PMX converter (pure: bytes in, typed arrays out; no I/O, no Three).
 *
 * Only what a VRM needs: one JSON chunk, one BIN chunk, buffer views, accessors (every component type, normalized integers,
 * sparse substitution), embedded images by buffer view. External URIs and data URIs are refused: a .vrm is self-contained.
 */

export { VrmImportError } from '../../../../shared/stage/vrm/gltf-json';
export type { GltfAccessor, GltfJson, GltfMaterial, GltfMesh, GltfNode, GltfPrimitive, GltfTextureInfo } from '../../../../shared/stage/vrm/gltf-json';
import { VrmImportError, type GltfJson } from '../../../../shared/stage/vrm/gltf-json';

export interface Glb { json: GltfJson; bin: Uint8Array }

const GLB_MAGIC = 0x46546c67, CHUNK_JSON = 0x4e4f534a, CHUNK_BIN = 0x004e4942;
/** A .vrm larger than this is not a model we should hold in memory twice. */
export const MAX_VRM_BYTES = 1024 * 1024 * 1024;

export function parseGlb(bytes: Uint8Array): Glb {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 20) throw new VrmImportError('不是 GLB/VRM 文件（太短）');
  if (bytes.byteLength > MAX_VRM_BYTES) throw new VrmImportError('文件太大');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new VrmImportError('不是 GLB/VRM 文件（文件头不对）');
  if (view.getUint32(4, true) !== 2) throw new VrmImportError('只支持 glTF 2.0 的 GLB');
  const total = Math.min(view.getUint32(8, true), bytes.byteLength);
  let offset = 12, json: GltfJson | null = null, bin: Uint8Array = new Uint8Array(0);
  while (offset + 8 <= total) {
    const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true);
    const start = offset + 8, end = start + length;
    if (end > total) throw new VrmImportError('GLB 数据块越界');
    if (type === CHUNK_JSON && !json) {
      try { json = JSON.parse(new TextDecoder('utf-8').decode(bytes.subarray(start, end))) as GltfJson; }
      catch { throw new VrmImportError('GLB 里的 JSON 读不出来'); }
    } else if (type === CHUNK_BIN && bin.byteLength === 0) bin = bytes.subarray(start, end);
    offset = end + ((4 - (length % 4)) % 4);
  }
  if (!json || typeof json !== 'object') throw new VrmImportError('GLB 没有 JSON 数据块');
  for (const buffer of json.buffers ?? []) if (buffer.uri !== undefined) throw new VrmImportError('不支持引用外部文件的 glTF');
  return { json, bin };
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

function readComponent(view: DataView, at: number, componentType: number, normalized: boolean): number {
  switch (componentType) {
    case 5126: return view.getFloat32(at, true);
    case 5121: { const v = view.getUint8(at); return normalized ? v / 255 : v; }
    case 5123: { const v = view.getUint16(at, true); return normalized ? v / 65535 : v; }
    case 5125: return view.getUint32(at, true);
    case 5120: { const v = view.getInt8(at); return normalized ? Math.max(v / 127, -1) : v; }
    case 5122: { const v = view.getInt16(at, true); return normalized ? Math.max(v / 32767, -1) : v; }
    default: throw new VrmImportError(`不认识的数据类型 ${componentType}`);
  }
}

/** One accessor as a flat Float64Array (count × components), sparse values substituted; zeros when it has no buffer view. */
export function readAccessor(glb: Glb, index: number): { data: Float64Array; count: number; size: number } {
  const accessor = glb.json.accessors?.[index];
  if (!accessor) throw new VrmImportError(`缺少数据 accessor #${index}`);
  const size = COMPONENTS[accessor.type], bytes = COMPONENT_BYTES[accessor.componentType];
  if (!size || !bytes || !Number.isSafeInteger(accessor.count) || accessor.count < 0) throw new VrmImportError(`accessor #${index} 的格式不对`);
  const data = new Float64Array(accessor.count * size);
  const normalized = accessor.normalized === true;
  const viewOf = (viewIndex: number, extra: number, elementBytes: number, count: number, stride?: number) => {
    const bufferView = glb.json.bufferViews?.[viewIndex];
    if (!bufferView || bufferView.buffer !== 0) throw new VrmImportError(`accessor #${index} 的 bufferView 不对`);
    const start = (bufferView.byteOffset ?? 0) + extra, step = stride && stride > 0 ? stride : elementBytes;
    if (count > 0 && start + step * (count - 1) + elementBytes > glb.bin.byteLength) throw new VrmImportError(`accessor #${index} 越界`);
    return { view: new DataView(glb.bin.buffer, glb.bin.byteOffset, glb.bin.byteLength), start, step };
  };
  if (accessor.bufferView !== undefined) {
    const stride = glb.json.bufferViews?.[accessor.bufferView]?.byteStride;
    const { view, start, step } = viewOf(accessor.bufferView, accessor.byteOffset ?? 0, size * bytes, accessor.count, stride);
    for (let item = 0; item < accessor.count; item++)
      for (let k = 0; k < size; k++) data[item * size + k] = readComponent(view, start + item * step + k * bytes, accessor.componentType, normalized);
  }
  if (accessor.sparse && accessor.sparse.count > 0) {
    const sparse = accessor.sparse, indexBytes = COMPONENT_BYTES[sparse.indices.componentType];
    if (!indexBytes) throw new VrmImportError(`accessor #${index} 的稀疏索引格式不对`);
    const indices = viewOf(sparse.indices.bufferView, sparse.indices.byteOffset ?? 0, indexBytes, sparse.count);
    const values = viewOf(sparse.values.bufferView, sparse.values.byteOffset ?? 0, size * bytes, sparse.count);
    for (let item = 0; item < sparse.count; item++) {
      const target = readComponent(indices.view, indices.start + item * indexBytes, sparse.indices.componentType, false);
      if (!(target >= 0 && target < accessor.count)) throw new VrmImportError(`accessor #${index} 的稀疏索引越界`);
      for (let k = 0; k < size; k++) data[target * size + k] = readComponent(values.view, values.start + item * size * bytes + k * bytes, accessor.componentType, normalized);
    }
  }
  return { data, count: accessor.count, size };
}

/** An embedded image's bytes and its MIME type. */
export function readImage(glb: Glb, index: number): { bytes: Uint8Array; mimeType: string; name: string } {
  const image = glb.json.images?.[index];
  if (!image || image.bufferView === undefined) throw new VrmImportError(`图片 #${index} 不在文件里`);
  const view = glb.json.bufferViews?.[image.bufferView];
  if (!view || (view.byteOffset ?? 0) + view.byteLength > glb.bin.byteLength) throw new VrmImportError(`图片 #${index} 越界`);
  const start = view.byteOffset ?? 0;
  return { bytes: glb.bin.subarray(start, start + view.byteLength), mimeType: image.mimeType ?? '', name: image.name ?? '' };
}
