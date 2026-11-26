/**
 * Morphs and display frames. Every source morph target becomes a PMX vertex morph under its own name (Fcl_* on VRoid
 * models), on its panel; each mapped stage name (まばたき, あ, 笑い, …) becomes a group morph over those vertex morphs.
 * MMDLoader bakes a group morph into a morph target of its own, so the stage, the model profile and the bundled VMDs see an
 * ordinary morph by that name.
 */
import { defaultSourcePanel, type MorphPanel, type VrmPmxMapping } from './mapping';
import type { MergedMesh } from './mesh';
import type { PmxBone, PmxFrame, PmxMorph, PmxPanel } from './pmx-model';

const PANEL: Record<MorphPanel, PmxPanel> = { brow: 1, eye: 2, mouth: 3, other: 4 };

export interface MorphResult {
  morphs: PmxMorph[];
  /** Stage name → what it was made of (morph names and weights); names the mapping asked for but could not make, with why. */
  mapped: Record<string, string>;
  unmapped: Record<string, string>;
}

export function buildMorphs(merged: MergedMesh, mapping: VrmPmxMapping): MorphResult {
  const morphs: PmxMorph[] = [], byName = new Map<string, number>();
  for (const [name, entry] of merged.morphs) {
    if (!entry.indices.length) continue;
    byName.set(name, morphs.length);
    morphs.push({ name, nameEn: name, panel: PANEL[mapping.sourceMorphPanels[name] ?? defaultSourcePanel(name)], kind: 'vertex',
      indices: Int32Array.from(entry.indices), offsets: Float32Array.from(entry.offsets) });
  }
  const mapped: Record<string, string> = {}, unmapped: Record<string, string> = {};
  for (const [name, entry] of Object.entries(mapping.morphs)) {
    if (byName.has(name)) { unmapped[name] = '模型里已经有同名变形，保留原来的'; continue; }
    const members = entry.from.map(ref => ({ morph: byName.get(ref.morph) ?? -1, ratio: ref.weight, source: ref.morph }));
    const missing = members.filter(member => member.morph < 0).map(member => member.source);
    if (missing.length) { unmapped[name] = `找不到 ${missing.join('、')}`; continue; }
    morphs.push({ name, nameEn: name, panel: PANEL[entry.panel], kind: 'group', members: members.map(({ morph, ratio }) => ({ morph, ratio })) });
    mapped[name] = members.map(member => member.ratio === 1 ? member.source : `${member.source}×${member.ratio}`).join(' + ');
  }
  return { morphs, mapped, unmapped };
}

/** Display frames: Root and 表情 (both special), then body groups by name. Every bone except 全ての親 appears once. */
export function buildFrames(bones: readonly PmxBone[], morphs: readonly PmxMorph[]): PmxFrame[] {
  const groups: { name: string; nameEn: string; test: (bone: PmxBone) => boolean }[] = [
    { name: 'センター', nameEn: 'Center', test: bone => ['センター', 'グルーブ'].includes(bone.name) },
    { name: 'ＩＫ', nameEn: 'IK', test: bone => /ＩＫ|IK親/.test(bone.name) },
    { name: '体(上)', nameEn: 'Upper body', test: bone => /^(上半身\d?|首|頭|両目|左目|右目)$/.test(bone.name) },
    { name: '腕', nameEn: 'Arms', test: bone => /^[左右](肩|腕|腕捩|ひじ|手捩|手首)$/.test(bone.name) },
    { name: '指', nameEn: 'Fingers', test: bone => /^[左右](親指|人指|中指|薬指|小指)/.test(bone.name) },
    { name: '体(下)', nameEn: 'Lower body', test: bone => bone.name === '下半身' },
    { name: '足', nameEn: 'Legs', test: bone => /^[左右](足|ひざ|足首|つま先)$/.test(bone.name) },
    { name: 'その他', nameEn: 'Others', test: () => true },
  ];
  const frames: PmxFrame[] = [
    { name: 'Root', nameEn: 'Root', special: true, items: [{ kind: 'bone', index: 0 }] },
    { name: '表情', nameEn: 'Exp', special: true, items: morphs.map((_, index) => ({ kind: 'morph' as const, index })) },
  ];
  const placed = new Set<number>([0]);
  for (const group of groups) {
    const items = bones.map((bone, index) => ({ bone, index })).filter(({ bone, index }) => !placed.has(index) && group.test(bone));
    for (const { index } of items) placed.add(index);
    if (items.length) frames.push({ name: group.name, nameEn: group.nameEn, special: false, items: items.map(({ index }) => ({ kind: 'bone', index })) });
  }
  return frames;
}
