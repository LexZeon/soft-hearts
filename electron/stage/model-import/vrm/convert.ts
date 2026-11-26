/**
 * VRM → PMX, the whole conversion: bytes in, PMX bytes + texture files + a report out (no I/O). See README.md.
 */
import { parseGlb, VrmImportError } from './glb';
import { defaultMapping, mergeMapping, type VrmPmxMapping } from './mapping';
import { buildMaterials, type TextureFile } from './materials';
import { mergeMeshes, targetNamesOf } from './mesh';
import { buildFrames, buildMorphs } from './morphs';
import { buildPhysics, physicsNodes } from './physics';
import type { PmxModel } from './pmx-model';
import { writePmx } from './pmx-writer';
import { sceneNodes } from './scene';
import { buildSkeleton } from './skeleton';
import { readVrm } from './vrm-read';

export const CONVERTER_VERSION = 1;

export interface ConversionReport {
  converter: { name: 'soft-hearts vrm-to-pmx'; version: number };
  source: { vrmVersion: string; generator: string; name: string; authors: string[]; license: string };
  counts: { vertices: number; triangles: number; bones: number; morphs: number; vertexMorphs: number; groupMorphs: number; materials: number; textures: number; rigidBodies: number; joints: number };
  scale: { unitsPerMeter: number; height: number; heightMeters: number };
  aPose: { targetDeg: number; beforeDeg: [number, number]; afterDeg: [number, number] } | null;
  bones: { humanoid: Record<string, string>; synthetic: string[]; foldedIntoRoot: string[]; missingHumanoid: string[] };
  morphs: { mapped: Record<string, string>; unmapped: Record<string, string> };
  materials: { name: string; alphaMode: string; rank: string; triangles: number; sorted: boolean }[];
  physics: { chains: number; bodies: number; joints: number; colliders: number; skipped: string[] } | null;
  dropped: string[];
  /** The mapping actually used, in full: edit it and pass it back with --mapping to convert again. */
  mapping: VrmPmxMapping;
}

export interface ConversionResult { pmx: Uint8Array; textures: TextureFile[]; report: ConversionReport; model: PmxModel }

export interface ConvertOptions {
  /** A mapping (or a previous report) merged over the one derived from the file (mapping.ts mergeMapping). */
  mapping?: unknown;
  /** false: no rigid bodies or joints even when the mapping has physics. */
  physics?: boolean;
}

export function convertVrmToPmx(bytes: Uint8Array, options: ConvertOptions = {}): ConversionResult {
  const glb = parseGlb(bytes);
  const source = readVrm(glb);
  const targetNames = targetNamesOf(glb);
  const nodeNames = (glb.json.nodes ?? []).map(node => node.name ?? '');
  const morphTargets = new Set(targetNames.flat());
  const mapping = mergeMapping(defaultMapping({ source, nodeNames, targetNames, morphTargets }), options.mapping);
  const physicsMapping = options.physics === false ? null : mapping.physics;

  const scene = sceneNodes(glb, source.facing, mapping.unitsPerMeter);
  const joints = new Set((glb.json.skins ?? []).flatMap(skin => skin.joints));
  const skeleton = buildSkeleton(glb, scene, mapping, { joints, extra: physicsNodes(physicsMapping, nodeNames) });
  const merged = mergeMeshes(glb, scene, skeleton);
  if (!merged.positions.length) throw new VrmImportError('模型里没有能转换的三角形网格');
  const materials = buildMaterials(glb, source, merged, mapping.materialOrder);
  const morphs = buildMorphs(merged, mapping);
  const physics = physicsMapping ? buildPhysics(physicsMapping, scene, skeleton, nodeNames, mapping.unitsPerMeter) : null;

  let minY = Infinity, maxY = -Infinity;
  for (let k = 1; k < merged.positions.length; k += 3) { minY = Math.min(minY, merged.positions[k]); maxY = Math.max(maxY, merged.positions[k]); }
  const comment = [source.name, source.authors.length ? `作者: ${source.authors.join(', ')}` : '', source.license ? `许可: ${source.license}` : '',
    `由 soft hearts 的 VRM 转换器从 VRM ${source.version} 转成（第 ${CONVERTER_VERSION} 版）`].filter(Boolean).join('\r\n');
  const model: PmxModel = {
    name: source.name || 'VRM model', nameEn: source.name || 'VRM model', comment, commentEn: comment,
    positions: merged.positions, normals: merged.normals, uvs: merged.uvs, skinIndices: merged.skinIndices, skinWeights: merged.skinWeights,
    indices: materials.indices, textures: materials.textures.map(texture => texture.path), materials: materials.materials,
    bones: skeleton.bones, morphs: morphs.morphs, frames: buildFrames(skeleton.bones, morphs.morphs),
    bodies: physics?.bodies ?? [], joints: physics?.joints ?? [],
  };
  const humanoid: Record<string, string> = {};
  for (const [bone, node] of Object.entries(mapping.humanoid)) {
    const index = nodeNames.indexOf(node!);
    if (index >= 0 && skeleton.nodeBone[index] >= 0) humanoid[bone] = `${node} → ${skeleton.bones[skeleton.nodeBone[index]].name}`;
  }
  const report: ConversionReport = {
    converter: { name: 'soft-hearts vrm-to-pmx', version: CONVERTER_VERSION },
    source: { vrmVersion: source.version, generator: glb.json.asset?.generator ?? '', name: source.name, authors: source.authors, license: source.license },
    counts: {
      vertices: model.positions.length / 3, triangles: model.indices.length / 3, bones: model.bones.length, morphs: model.morphs.length,
      vertexMorphs: model.morphs.filter(morph => morph.kind === 'vertex').length, groupMorphs: model.morphs.filter(morph => morph.kind === 'group').length,
      materials: model.materials.length, textures: model.textures.length, rigidBodies: model.bodies.length, joints: model.joints.length,
    },
    scale: { unitsPerMeter: mapping.unitsPerMeter, height: round(maxY - minY), heightMeters: round((maxY - minY) / mapping.unitsPerMeter) },
    aPose: skeleton.armDownDeg ? { targetDeg: mapping.aPose.armDownDeg, beforeDeg: skeleton.armDownDeg.before.map(round) as [number, number], afterDeg: skeleton.armDownDeg.after.map(round) as [number, number] } : null,
    bones: { humanoid, synthetic: skeleton.synthetic, foldedIntoRoot: skeleton.foldedIntoRoot, missingHumanoid: skeleton.missingHumanoid },
    morphs: { mapped: morphs.mapped, unmapped: morphs.unmapped },
    materials: materials.order,
    physics: physics ? { chains: physics.chains, bodies: physics.bodies.length, joints: physics.joints.length, colliders: physics.colliders, skipped: physics.skipped } : null,
    dropped: [
      ...merged.skipped, ...materials.dropped,
      ...(merged.uvTransforms.length ? [`KHR_texture_transform 已烘进 UV：${merged.uvTransforms.length} 处`] : []),
      ...source.expressions.filter(expression => !expression.preset).map(expression => `自定义表情 ${expression.name}（没有对应的舞台名字，变形目标本身保留）`),
      'MToon 的阴影色、边缘光、法线贴图、MatCap、自发光：PMX/MMDLoader 没有对应，只保留基础色贴图',
      'VRM 的视线（lookAt）、第一人称设置、表情的 isBinary/override：舞台自己管眼睛和表情',
      ...(source.springs.some(spring => spring.joints.some(joint => joint.gravityPower !== 0)) ? ['弹簧骨骼的重力强度：PMX 刚体用物理世界的重力'] : []),
    ],
    mapping,
  };
  return { pmx: writePmx(model), textures: materials.textures, report, model };
}

const round = (value: number) => Math.round(value * 1000) / 1000 + 0; // + 0: no −0 in the report
