/**
 * Materials: one PMX material per glTF material actually drawn, in a draw order that suits MMDLoader.
 *
 * MMDLoader draws every material of the model in file order with alpha blending and depth writes (a material is only
 * "transparent" to Three when its diffuse alpha is below 1), and never alpha-tests. So the order is what decides how
 * see-through parts overlap:
 *   1. opaque, 2. alpha-masked body, clothes, face skin, eye whites and mouth, 3. the face's blended layers bottom to top
 *   (iris, highlight, eye line, lashes, brows) so they sit on the face before any hair covers them, 4. back hair, then hair,
 *   5. anything else blended.
 * Inside hair and blended materials the triangles are sorted back to front as seen from the front (she is mostly seen from
 * the front), so a strand behind is drawn before the strand in front of it and is not cut out by its transparent pixels.
 * A mapping's `materialOrder` overrides the rule for the materials it lists.
 */
import type { Glb, GltfMaterial } from './glb';
import { readImage } from './glb';
import type { MergedMesh } from './mesh';
import { MATERIAL_DOUBLE_SIDED, MATERIAL_EDGE, MATERIAL_SHADOWS, type PmxMaterial, type Vec3 } from './pmx-model';
import type { VrmSource } from './vrm-read';

export interface TextureFile { path: string; bytes: Uint8Array; mimeType: string }
export interface MaterialResult {
  materials: PmxMaterial[];
  indices: Uint32Array;
  textures: TextureFile[];
  /** PMX material order with the reason for each place. */
  order: { name: string; alphaMode: string; rank: string; triangles: number; sorted: boolean }[];
  dropped: string[];
}

const FACE_LAYERS = [/iris/i, /highlight/i, /eyeline/i, /eyelash|lash/i, /brow/i];
/** Sort rank and its label: lower is drawn first. */
export function materialRank(material: GltfMaterial | undefined): { rank: number; label: string } {
  const name = material?.name ?? '', alpha = material?.alphaMode ?? 'OPAQUE';
  if (/hair/i.test(name)) return { rank: /back/i.test(name) ? 40 : 41, label: 'hair' };
  if (alpha === 'OPAQUE') return { rank: 10, label: 'opaque' };
  if (alpha === 'MASK') return { rank: 20, label: 'mask' };
  const face = FACE_LAYERS.findIndex(pattern => pattern.test(name));
  if (face >= 0) return { rank: 30 + face, label: 'face layer' };
  return { rank: 50, label: 'blend' };
}

const toSrgb = (linear: number) => { const x = Math.min(1, Math.max(0, linear)); return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055; };
const cleanName = (name: string) => name.replace(/\s*\(Instance\)\s*$/u, '').trim();
const safeFile = (name: string) => name.normalize('NFKC').replace(/[^A-Za-z0-9_\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'texture';

export function buildMaterials(glb: Glb, source: VrmSource, merged: MergedMesh, materialOrder: readonly string[]): MaterialResult {
  const used = [...new Set(merged.primitives.map(primitive => primitive.material))];
  const listed = (index: number) => { const name = glb.json.materials?.[index]?.name; return name === undefined ? -1 : materialOrder.indexOf(name); };
  used.sort((a, b) => {
    const la = listed(a), lb = listed(b);
    if (la >= 0 || lb >= 0) return la < 0 ? 1 : lb < 0 ? -1 : la - lb;
    return materialRank(glb.json.materials?.[a]).rank - materialRank(glb.json.materials?.[b]).rank || a - b;
  });
  const textures: TextureFile[] = [], textureOfImage = new Map<number, number>(), dropped: string[] = [];
  const textureIndex = (material: GltfMaterial | undefined): number => {
    const info = material?.pbrMetallicRoughness?.baseColorTexture;
    if (!info) return -1;
    if ((info.texCoord ?? 0) !== 0) dropped.push(`${material?.name}: 贴图用第 ${info.texCoord} 套 UV，只认第 0 套`);
    const image = glb.json.textures?.[info.index]?.source;
    if (image === undefined) return -1;
    if (textureOfImage.has(image)) return textureOfImage.get(image)!;
    const { bytes, mimeType, name } = readImage(glb, image);
    const ext = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/png' ? 'png' : '';
    if (!ext) { dropped.push(`图片 #${image}（${mimeType || '未知格式'}）MMD 读不了`); return -1; }
    textures.push({ path: `tex/${String(image).padStart(2, '0')}_${safeFile(name)}.${ext}`, bytes, mimeType });
    textureOfImage.set(image, textures.length - 1);
    return textures.length - 1;
  };
  const materials: PmxMaterial[] = [], indices: number[] = [], order: MaterialResult['order'] = [];
  for (const index of used) {
    const material = glb.json.materials?.[index];
    const rank = materialRank(material);
    const parts = merged.primitives.filter(primitive => primitive.material === index);
    const triangles: Uint32Array[] = parts.map(primitive => primitive.indices);
    let all = concat(triangles);
    const sorted = rank.label === 'hair' || rank.label === 'blend' || rank.label === 'face layer';
    if (sorted) all = sortBackToFront(all, merged.positions);
    for (let k = 0; k < all.length; k++) indices.push(all[k]);
    const factor = material?.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1];
    const color: Vec3 = [toSrgb(factor[0] ?? 1), toSrgb(factor[1] ?? 1), toSrgb(factor[2] ?? 1)];
    const outline = source.outlines.get(index);
    const edge = outline && outline.mode !== 'none' && outline.width > 0;
    // MToon world-space outline width (m) → PMX edge size (Gene draws 0.45 for about 2 mm); an approximation, MMDLoader's own
    // outline (OutlineEffect) is not used by the stage.
    const edgeSize = edge ? Math.min(4, outline!.width * 250) : 0;
    materials.push({
      name: cleanName(material?.name ?? `material${index}`), nameEn: material?.name ?? '',
      diffuse: [color[0], color[1], color[2], Math.min(1, Math.max(0, factor[3] ?? 1))], specular: [0, 0, 0], shininess: 5,
      ambient: [color[0] * 0.753, color[1] * 0.753, color[2] * 0.753],
      flags: (material?.doubleSided ? MATERIAL_DOUBLE_SIDED : 0) | MATERIAL_SHADOWS | (edge ? MATERIAL_EDGE : 0),
      edgeColor: edge ? [outline!.color[0], outline!.color[1], outline!.color[2], 1] : [0, 0, 0, 1], edgeSize,
      texture: textureIndex(material), indexCount: all.length,
    });
    order.push({ name: cleanName(material?.name ?? `material${index}`), alphaMode: material?.alphaMode ?? 'OPAQUE', rank: rank.label, triangles: all.length / 3, sorted });
  }
  return { materials, indices: Uint32Array.from(indices), textures, order, dropped };
}

function concat(parts: Uint32Array[]): Uint32Array {
  const out = new Uint32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** Triangles ordered by their centroid's depth, farthest from a viewer in front (she faces +Z) first. Stable for ties. */
export function sortBackToFront(indices: Uint32Array, positions: Float32Array): Uint32Array {
  const count = indices.length / 3, order = Array.from({ length: count }, (_, k) => k), depth = new Float64Array(count);
  for (let t = 0; t < count; t++) depth[t] = positions[indices[t * 3] * 3 + 2] + positions[indices[t * 3 + 1] * 3 + 2] + positions[indices[t * 3 + 2] * 3 + 2];
  order.sort((a, b) => depth[a] - depth[b] || a - b);
  const out = new Uint32Array(indices.length);
  order.forEach((triangle, k) => out.set(indices.subarray(triangle * 3, triangle * 3 + 3), k * 3));
  return out;
}
