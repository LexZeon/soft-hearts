/**
 * The mapping: everything the converter decides about "what corresponds to what", as plain JSON data.
 *
 * - Without a user mapping the converter derives one from the VRM itself (defaultMapping): its humanoid, its expressions and
 *   the stage's names for them, its spring bones and colliders, the bundled Gene's A-pose angle.
 * - The report (conversion-report.json) writes the mapping that was actually used, in full; a person or a future Claude skill
 *   can edit it and convert again (`--mapping`).
 * - A user mapping is merged over the default (mergeMapping): record fields (humanoid, boneNames, morphs, sourceMorphPanels)
 *   per key, `null` deleting a key; arrays (physics chains and colliders, materialOrder) and scalars replace; `physics: null`
 *   turns physics off. Malformed input is refused with the path that is wrong, never half-applied.
 */
import { STANDARD_POSE } from '../../../../shared/foundation/universal-skeleton';
import { VrmImportError } from './glb';
import { HUMAN_BONES, type HumanBone, type Vec3, type VrmSource } from './vrm-read';

export const MAPPING_VERSION = 1;
export type MorphPanel = 'brow' | 'eye' | 'mouth' | 'other';
export const MORPH_PANELS: readonly MorphPanel[] = ['brow', 'eye', 'mouth', 'other'];
/** One source morph target (by its glTF target name) and how much of it. */
export interface MorphSourceRef { morph: string; weight: number }
/** A PMX morph made from source morph targets (a group morph over their vertex morphs). */
export interface MappedMorph { from: MorphSourceRef[]; panel: MorphPanel }
/** A spring chain: node names from the first simulated bone to the tail; settings in VRM units (metres). */
export interface PhysicsChainMapping { name: string; bones: string[]; hitRadius: number; stiffness: number; drag: number; gravity: number; colliders: string[] }
/** A collision shape on a node, offsets in that node's local space (metres). */
export interface ColliderMapping { name: string; bone: string; shape: 'sphere' | 'capsule'; offset: Vec3; radius: number; tail?: Vec3 }

export interface VrmPmxMapping {
  version: number;
  /** PMX units per metre (MMD's usual 12.5: 1 unit = 8 cm). */
  unitsPerMeter: number;
  /** VRM humanoid bone → source node name. The PMX gets the MMD standard name for each. */
  humanoid: Partial<Record<HumanBone, string>>;
  /** Other source nodes renamed in the PMX (node name → PMX bone name); everything else keeps its own name. */
  boneNames: Record<string, string>;
  /** PMX morph name (the stage's names) → the source morph targets it is made of. Every source morph target is also kept under its own name. */
  morphs: Record<string, MappedMorph>;
  /** Panel of a source morph target kept under its own name (default by name: BRW → brow, EYE → eye, MTH/HA → mouth). */
  sourceMorphPanels: Record<string, MorphPanel>;
  /** Spring bones as rigid bodies and joints; null: none. */
  physics: { chains: PhysicsChainMapping[]; colliders: ColliderMapping[] } | null;
  /** Arms lowered from the source's rest pose to this angle below horizontal (upper arm → elbow), baked into vertices and bones. */
  aPose: { armDownDeg: number };
  /** Source material names in draw order; materials not listed follow by the default rule. Empty: the default rule only. */
  materialOrder: string[];
}

/** The bundled Gene's upper arm angle below horizontal (左腕 → 左ひじ), from the shipped standard pose (read from gene.pmx). */
export function geneArmDownDeg(): number {
  const bone = (name: string) => STANDARD_POSE.bones.find(entry => entry.name === name)!.position;
  const arm = bone('左腕'), elbow = bone('左ひじ');
  return Math.atan2(arm[1] - elbow[1], Math.abs(elbow[0] - arm[0])) * 180 / Math.PI;
}

/** The stage's face names and where each comes from by default: a VRM expression first, else a VRoid Fcl_* target. */
const STAGE_MORPHS: readonly { name: string; panel: MorphPanel; expression?: string; targets?: string[]; mix?: MorphSourceRef[] }[] = [
  { name: 'あ', panel: 'mouth', expression: 'aa', targets: ['Fcl_MTH_A'] },
  { name: 'い', panel: 'mouth', expression: 'ih', targets: ['Fcl_MTH_I'] },
  { name: 'う', panel: 'mouth', expression: 'ou', targets: ['Fcl_MTH_U'] },
  { name: 'え', panel: 'mouth', expression: 'ee', targets: ['Fcl_MTH_E'] },
  { name: 'お', panel: 'mouth', expression: 'oh', targets: ['Fcl_MTH_O'] },
  { name: 'まばたき', panel: 'eye', expression: 'blink', targets: ['Fcl_EYE_Close'] },
  { name: 'ウィンク', panel: 'eye', expression: 'blinkLeft', targets: ['Fcl_EYE_Close_L'] },
  { name: 'ウィンク右', panel: 'eye', expression: 'blinkRight', targets: ['Fcl_EYE_Close_R'] },
  { name: '笑い', panel: 'eye', targets: ['Fcl_EYE_Joy'] },
  { name: 'びっくり', panel: 'eye', targets: ['Fcl_EYE_Surprised'] },
  { name: '驚き', panel: 'eye', targets: ['Fcl_EYE_Surprised'] },
  { name: '見開き', panel: 'eye', targets: ['Fcl_EYE_Spread'] },
  { name: '困る', panel: 'brow', targets: ['Fcl_BRW_Sorrow'] },
  { name: '怒り', panel: 'brow', targets: ['Fcl_BRW_Angry'] },
  { name: 'にこり', panel: 'brow', targets: ['Fcl_BRW_Fun'] },
  { name: '上', panel: 'brow', targets: ['Fcl_BRW_Surprised'] },
  { name: 'にっこり', panel: 'mouth', targets: ['Fcl_MTH_Fun'] },
  { name: '口角上げ', panel: 'mouth', targets: ['Fcl_MTH_Up'] },
  { name: '口角下げ', panel: 'mouth', targets: ['Fcl_MTH_Down'] },
  // VRoid has no half-lidded eye or pout of its own, so these two are mixes (docs/claude/2026-11-19-mumi-pmx-face.md, weights picked by
  // looking at the face). じと目: the eyelids half down, flat and a little cold; closing further reads as drowsy. mouthPucker (Gene's own
  // name for it): the う shape with a touch of the small mouth; more Fcl_MTH_Small makes the mouth vanish.
  { name: 'じと目', panel: 'eye', mix: [{ morph: 'Fcl_EYE_Close', weight: 0.5 }] },
  { name: 'mouthPucker', panel: 'mouth', mix: [{ morph: 'Fcl_MTH_U', weight: 1 }, { morph: 'Fcl_MTH_Small', weight: 0.1 }] },
];
export const STAGE_MORPH_NAMES: readonly string[] = STAGE_MORPHS.map(entry => entry.name);

/** Default panel of a source morph target by its name (VRoid's Fcl_<part>_ convention, then common words). */
export function defaultSourcePanel(name: string): MorphPanel {
  const text = name.toLowerCase();
  if (/(^|_)brw(_|$)|brow/.test(text)) return 'brow';
  if (/(^|_)eye(_|$)|blink|eye/.test(text)) return 'eye';
  if (/(^|_)(mth|ha)(_|$)|mouth|jaw|tongue|teeth/.test(text)) return 'mouth';
  return 'other';
}

export interface MappingContext {
  source: VrmSource;
  /** Node index → node name ('' when unnamed). */
  nodeNames: readonly string[];
  /** Mesh index → its morph target names by target index. */
  targetNames: readonly (readonly string[])[];
  /** Every merged source morph target name. */
  morphTargets: ReadonlySet<string>;
}

export function defaultMapping(context: MappingContext): VrmPmxMapping {
  const { source, nodeNames, targetNames, morphTargets } = context;
  const humanoid: Partial<Record<HumanBone, string>> = {};
  for (const bone of HUMAN_BONES) { const node = source.humanoid[bone]; if (node !== undefined && nodeNames[node]) humanoid[bone] = nodeNames[node]; }
  const morphs: Record<string, MappedMorph> = {};
  for (const entry of STAGE_MORPHS) {
    if (morphTargets.has(entry.name)) continue; // the model already has a morph by this name
    const expression = entry.expression ? source.expressions.find(item => item.preset && item.name === entry.expression) : undefined;
    let from: MorphSourceRef[] = (expression?.binds ?? []).map(bind => ({ morph: targetNames[bind.mesh]?.[bind.index] ?? '', weight: bind.weight }))
      .filter(ref => ref.morph && morphTargets.has(ref.morph) && ref.weight !== 0);
    if (!from.length) from = (entry.targets ?? []).filter(name => morphTargets.has(name)).slice(0, 1).map(morph => ({ morph, weight: 1 }));
    if (!from.length && entry.mix) from = entry.mix.filter(ref => morphTargets.has(ref.morph)).map(ref => ({ ...ref }));
    if (from.length) morphs[entry.name] = { from: mergeRefs(from), panel: entry.panel };
  }
  const colliders: ColliderMapping[] = [];
  const colliderName = new Map<number, string>();
  source.colliders.forEach((collider, index) => {
    if (collider.node < 0 || !nodeNames[collider.node] || !(collider.radius > 0)) return;
    const name = `${nodeNames[collider.node]}#${index}`;
    colliderName.set(index, name);
    colliders.push({ name, bone: nodeNames[collider.node], shape: collider.shape, offset: [...collider.offset], radius: collider.radius, ...(collider.tail ? { tail: [...collider.tail] as Vec3 } : {}) });
  });
  const chains: PhysicsChainMapping[] = [];
  for (const spring of source.springs) {
    const bones = spring.joints.map(joint => nodeNames[joint.node]).filter(Boolean);
    if (bones.length < 2) continue;
    const first = spring.joints[0];
    const groupColliders = spring.colliderGroups.flatMap(group => source.colliderGroups[group]?.colliders ?? []).map(index => colliderName.get(index)).filter((name): name is string => !!name);
    chains.push({ name: spring.name, bones, hitRadius: first.hitRadius, stiffness: first.stiffness, drag: first.dragForce, gravity: first.gravityPower, colliders: [...new Set(groupColliders)] });
  }
  return {
    version: MAPPING_VERSION, unitsPerMeter: 12.5, humanoid, boneNames: {}, morphs, sourceMorphPanels: {},
    physics: chains.length ? { chains, colliders } : null, aPose: { armDownDeg: round(geneArmDownDeg(), 3) }, materialOrder: [],
  };
}

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;
function mergeRefs(refs: MorphSourceRef[]): MorphSourceRef[] {
  const out = new Map<string, number>();
  for (const ref of refs) out.set(ref.morph, (out.get(ref.morph) ?? 0) + ref.weight);
  return [...out].map(([morph, weight]) => ({ morph, weight }));
}

// ---------------------------------------------------------------- user mapping (JSON) merged over the default

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = (path: string, what: string): never => { throw new VrmImportError(`映射文件 ${path}：${what}`); };
const finite = (value: unknown, path: string, min = -Infinity, max = Infinity): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fail(path, `要一个 ${min}～${max} 之间的数`);
const text = (value: unknown, path: string): string => typeof value === 'string' && value.trim() !== '' ? value : fail(path, '要一个非空字符串');
const vec3 = (value: unknown, path: string): Vec3 => Array.isArray(value) && value.length === 3 ? value.map((v, k) => finite(v, `${path}[${k}]`)) as Vec3 : fail(path, '要 [x, y, z]');
const panel = (value: unknown, path: string): MorphPanel => MORPH_PANELS.includes(value as MorphPanel) ? value as MorphPanel : fail(path, `要 ${MORPH_PANELS.join(' / ')} 之一`);

function mergeRecord<T>(base: Record<string, T>, patch: unknown, path: string, read: (value: unknown, path: string) => T): Record<string, T> {
  if (patch === undefined) return { ...base };
  if (!isObj(patch)) return fail(path, '要一个对象');
  const out: Record<string, T> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = read(value, `${path}.${key}`);
  }
  return out;
}
const readMorph = (value: unknown, path: string): MappedMorph => {
  if (!isObj(value) || !Array.isArray(value.from) || !value.from.length) return fail(path, '要 { "from": [{ "morph": 名字, "weight": 数 }], "panel": … }');
  return {
    from: (value.from as unknown[]).map((ref, k) => isObj(ref) ? { morph: text(ref.morph, `${path}.from[${k}].morph`), weight: finite(ref.weight ?? 1, `${path}.from[${k}].weight`, -10, 10) } : fail(`${path}.from[${k}]`, '要一个对象')),
    panel: value.panel === undefined ? 'other' : panel(value.panel, `${path}.panel`),
  };
};
const readChain = (value: unknown, path: string): PhysicsChainMapping => {
  if (!isObj(value) || !Array.isArray(value.bones) || value.bones.length < 2) return fail(path, '要 { "name", "bones": [至少两个骨骼名], … }');
  return {
    name: text(value.name, `${path}.name`), bones: (value.bones as unknown[]).map((bone, k) => text(bone, `${path}.bones[${k}]`)),
    hitRadius: finite(value.hitRadius ?? 0.02, `${path}.hitRadius`, 0, 10), stiffness: finite(value.stiffness ?? 1, `${path}.stiffness`, 0, 100),
    drag: finite(value.drag ?? 0.4, `${path}.drag`, 0, 1), gravity: finite(value.gravity ?? 0, `${path}.gravity`, -100, 100),
    colliders: Array.isArray(value.colliders) ? (value.colliders as unknown[]).map((name, k) => text(name, `${path}.colliders[${k}]`)) : [],
  };
};
const readCollider = (value: unknown, path: string): ColliderMapping => {
  if (!isObj(value)) return fail(path, '要一个对象');
  const shape = value.shape === 'capsule' ? 'capsule' : value.shape === 'sphere' || value.shape === undefined ? 'sphere' : fail(`${path}.shape`, '要 sphere 或 capsule');
  return { name: text(value.name, `${path}.name`), bone: text(value.bone, `${path}.bone`), shape, offset: value.offset === undefined ? [0, 0, 0] : vec3(value.offset, `${path}.offset`),
    radius: finite(value.radius, `${path}.radius`, 0, 10), ...(shape === 'capsule' ? { tail: value.tail === undefined ? [0, 0, 0] as Vec3 : vec3(value.tail, `${path}.tail`) } : {}) };
};

/** Accepts a mapping file, or a conversion report (its `mapping`). */
export function mergeMapping(base: VrmPmxMapping, input: unknown): VrmPmxMapping {
  if (input === undefined || input === null) return structuredClone(base);
  let patch: unknown = input;
  if (isObj(patch) && isObj(patch.mapping) && patch.converter !== undefined) patch = patch.mapping; // a whole report
  if (!isObj(patch)) return fail('$', '要一个 JSON 对象');
  if (patch.version !== undefined && patch.version !== MAPPING_VERSION) fail('$.version', `只认第 ${MAPPING_VERSION} 版`);
  const humanoid = mergeRecord(base.humanoid as Record<string, string>, patch.humanoid, '$.humanoid', text);
  for (const key of Object.keys(humanoid)) if (!(HUMAN_BONES as readonly string[]).includes(key)) fail(`$.humanoid.${key}`, '不是 VRM 的人形骨骼名');
  let physics = base.physics ? structuredClone(base.physics) : null;
  if (patch.physics === null) physics = null;
  else if (patch.physics !== undefined) {
    if (!isObj(patch.physics)) fail('$.physics', '要 { "chains": [...], "colliders": [...] } 或 null');
    const value = patch.physics as Obj;
    physics = {
      chains: value.chains === undefined ? physics?.chains ?? [] : Array.isArray(value.chains) ? value.chains.map((chain, k) => readChain(chain, `$.physics.chains[${k}]`)) : fail('$.physics.chains', '要一个数组'),
      colliders: value.colliders === undefined ? physics?.colliders ?? [] : Array.isArray(value.colliders) ? value.colliders.map((c, k) => readCollider(c, `$.physics.colliders[${k}]`)) : fail('$.physics.colliders', '要一个数组'),
    };
  }
  const aPose = patch.aPose === undefined ? { ...base.aPose } : isObj(patch.aPose)
    ? { armDownDeg: patch.aPose.armDownDeg === undefined ? base.aPose.armDownDeg : finite(patch.aPose.armDownDeg, '$.aPose.armDownDeg', -10, 89) } : fail('$.aPose', '要 { "armDownDeg": 数 }');
  return {
    version: MAPPING_VERSION,
    unitsPerMeter: patch.unitsPerMeter === undefined ? base.unitsPerMeter : finite(patch.unitsPerMeter, '$.unitsPerMeter', 0.01, 1000),
    humanoid: humanoid as Partial<Record<HumanBone, string>>,
    boneNames: mergeRecord(base.boneNames, patch.boneNames, '$.boneNames', text),
    morphs: mergeRecord(base.morphs, patch.morphs, '$.morphs', readMorph),
    sourceMorphPanels: mergeRecord(base.sourceMorphPanels, patch.sourceMorphPanels, '$.sourceMorphPanels', panel),
    physics, aPose,
    materialOrder: patch.materialOrder === undefined ? [...base.materialOrder] : Array.isArray(patch.materialOrder)
      ? patch.materialOrder.map((name, k) => text(name, `$.materialOrder[${k}]`)) : fail('$.materialOrder', '要一个数组'),
  };
}
