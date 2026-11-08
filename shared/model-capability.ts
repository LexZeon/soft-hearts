import { profileBoneState, type ModelProfile } from './model-profile';
import { STANDARD_PART_WORDS, type MorphSlot, type StandardBone } from './universal-skeleton';

/**
 * I-024 模型体检卡 (docs/claude/2026-11-04-i024-model-check-plan.md): what this model can do, from its profile (A1,
 * shared/model-profile.ts: names matched, then checked by real vertex movement), names haiku matched for slots the
 * profile missed, and the user's own choice on the character page. The stage turns a feature on only from this card,
 * not from "is this the reviewed Gene" (the reviewed Gene keeps its own reviewed amounts). Never changes PMX bytes.
 */
export const MODEL_CAPABILITY_IDS = ['closeEyes', 'blush', 'mouth', 'sleepPose', 'gesture', 'drowsyFace', 'tears'] as const;
export type ModelCapabilityId = typeof MODEL_CAPABILITY_IDS[number];

/** name: the profile matched a standard name; haiku: haiku matched one of the model's own names (then checked the same way). */
export type CapabilitySource = 'name' | 'haiku' | 'none';
/** The user's choice on the character page; null: follow what was detected. */
export type CapabilityChoice = 'on' | 'off' | null;

export interface ModelCapabilityEntry {
  id: ModelCapabilityId;
  /** The model has what this needs (a checked morph, or the bones). */
  detected: boolean;
  source: CapabilitySource;
  choice: CapabilityChoice;
  /** What the stage uses: detected, unless the user turned it off. "On" without what it needs stays off. */
  enabled: boolean;
  /**
   * T-213: what this model lacks for it, in the user's words (empty when detected): a missing part ("右手腕"), or a part a
   * motion track cannot reach because another bone shares its name ("右手腕（有重名骨骼）").
   */
  missing: readonly string[];
}
export type ModelCapabilities = Readonly<Record<ModelCapabilityId, ModelCapabilityEntry>>;

/**
 * What each capability needs: any one of the morph groups (every slot in the group), and every listed bone. `tracks`: the
 * bones are moved by motion clips, which bind by bone name, so a bone whose name another bone shares does not count (the
 * same rule as the action checks and the stage's clip players, shared/model-profile.ts profileBoneState). The others move
 * the bone object itself and do not care about names.
 */
export const CAPABILITY_NEEDS: Readonly<Record<ModelCapabilityId, { morphs?: readonly (readonly MorphSlot[])[]; bones?: readonly StandardBone[];
  tracks?: true; morphWords?: string }>> = Object.freeze({
  closeEyes: { morphs: [['blink'], ['blinkLeft', 'blinkRight']], morphWords: '眨眼表情' },
  blush: { morphs: [['shy']], morphWords: '脸红表情' },
  mouth: { morphs: [['a'], ['o']], morphWords: '口型表情（“啊”或“哦”）' },
  sleepPose: { bones: ['neck', 'head'] },
  gesture: { bones: ['armLeft', 'armRight', 'elbowLeft', 'elbowRight', 'wristLeft', 'wristRight'], tracks: true },
  /** 困的脸 (drowsy-expression.ts): half-lowered lids (じと目) or troubled brows, and a head for the small droop. */
  drowsyFace: { morphs: [['jitome'], ['sad']], bones: ['head'], morphWords: '半闭眼或皱眉表情' },
  /** 流泪 (procedural-tears.ts): two eye bones and a head; the stage still needs the face surface it measures at load, else it stays off. */
  tears: { bones: ['head', 'eyeLeft', 'eyeRight'] },
});

/** Slots and bones haiku matched for this model (names only; each candidate passed the same vertex check). */
export interface HaikuMatches { morphs?: Partial<Record<MorphSlot, number>>; bones?: Partial<Record<StandardBone, number>> }

export function deriveModelCapabilities(profile: ModelProfile | null, choices: Partial<Record<ModelCapabilityId, CapabilityChoice>> = {},
  haiku: HaikuMatches = {}): ModelCapabilities {
  const morphFound = (slot: MorphSlot): CapabilitySource => (profile?.morphs[slot]?.index ?? -1) >= 0 ? 'name'
    : Number.isInteger(haiku.morphs?.[slot]) && (haiku.morphs![slot]! >= 0) ? 'haiku' : 'none';
  const boneFound = (bone: StandardBone, tracks: boolean): CapabilitySource | 'duplicate' => {
    const state = profileBoneState(profile, bone);
    if (state === true || (state === 'duplicate' && !tracks)) return 'name';
    if (state === 'duplicate') return 'duplicate';
    return Number.isInteger(haiku.bones?.[bone]) && (haiku.bones![bone]! >= 0) ? 'haiku' : 'none';
  };
  const part = (bone: StandardBone) => STANDARD_PART_WORDS[bone] ?? bone;
  const entries = {} as Record<ModelCapabilityId, ModelCapabilityEntry>;
  for (const id of MODEL_CAPABILITY_IDS) {
    const needs = CAPABILITY_NEEDS[id];
    const sources: CapabilitySource[] = [], missing: string[] = [];
    if (needs.morphs) {
      const group = needs.morphs.find(slots => slots.every(slot => morphFound(slot) !== 'none'));
      if (group) sources.push(...group.map(morphFound)); else missing.push(needs.morphWords ?? needs.morphs.flat().join('/'));
    }
    if (needs.bones) for (const bone of needs.bones) {
      const found = boneFound(bone, needs.tracks === true);
      if (found === 'none') missing.push(part(bone));
      else if (found === 'duplicate') missing.push(`${part(bone)}（有重名骨骼）`);
      else sources.push(found);
    }
    const ok = missing.length === 0;
    const source: CapabilitySource = !ok ? 'none' : sources.includes('haiku') ? 'haiku' : 'name';
    const raw = choices[id];
    const choice: CapabilityChoice = raw === 'on' || raw === 'off' ? raw : null;
    entries[id] = Object.freeze({ id, detected: ok, source, choice, enabled: ok && choice !== 'off', missing: Object.freeze(missing) });
  }
  return Object.freeze(entries);
}

export const capabilityEnabled = (capabilities: ModelCapabilities | null | undefined, id: ModelCapabilityId): boolean =>
  capabilities?.[id]?.enabled === true;
