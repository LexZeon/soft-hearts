/**
 * T-213 (docs/claude/2026-11-05-t213-adaptation-fixes.md): what the character page's 「这个模型能做什么」 and the agent channel
 * say about her actions on this model, from the same rules the stage uses before it plays one. Three layers, kept apart
 * (Codex's recommendation): the parts each action needs (herActionSupport: profileBoneState and the profile's finger joints),
 * fingers the profile left out and why, and body bones that hang elsewhere than in Gene's skeleton (the library's motions are
 * authored on Gene; the stage's fit check holds back the motions that would pull such a part off the body).
 * Pure data, no I/O; part names are the model's standard parts in the user's words, never the model's own bone names.
 */
import type { ModelProfile } from './model-profile';
import { FINGER_WORDS, STANDARD_PARENTS, structureDifferences, type Finger, type StandardBone, type StructureDifference } from './universal-skeleton';
import { HER_ACTIONS, HER_ACTION_PART_NAMES, HER_ACTION_SPECS, herActionSupport, type HerActionId, type HerActionSupport } from './her-actions';
import type { HaikuMatches } from './model-capability';

/** Gene's standard skeleton: each standard bone's nearest standard ancestor (the universal skeleton's STANDARD_PARENTS). */
export const GENE_STANDARD_PARENTS = STANDARD_PARENTS;

export interface ModelAdaptation {
  /** Every action: ok, or the parts it lacks (the same words the stage's skip note uses). */
  actions: Record<HerActionId, HerActionSupport>;
  /** Body bones hanging under another standard bone than in Gene's skeleton. */
  structure: StructureDifference[];
  /** Fingers the profile left out (another numbering, a shared name, not a chain under the wrist). */
  fingerIssues: ModelProfile['bones']['fingerIssues'];
}
/** `haiku`: bones haiku matched for this model (they count as there, as on the capability card). */
export function modelAdaptation(profile: ModelProfile | null | undefined, haiku: HaikuMatches = {}): ModelAdaptation {
  return { actions: herActionSupport(profile, haiku.bones ?? {}, haiku.morphs ?? {}), structure: profile ? structureDifferences(GENE_STANDARD_PARENTS, profile.bones.parents ?? {}) : [],
    fingerIssues: [...profile?.bones.fingerIssues ?? []] };
}

const FINGER_REASONS = Object.freeze({ numbering: '编号和标准不同', duplicate: '有重名骨骼', chain: '没接在手腕下' } as const);
/** "右手拇指" for thumbRight. */
export const fingerWords = (finger: ModelAdaptation['fingerIssues'][number]['finger']): string => {
  const side = finger.endsWith('Left') ? '左手' : '右手';
  return `${side}${FINGER_WORDS[finger.replace(/(Left|Right)$/, '') as Finger] ?? finger}`;
};
export const fingerReasonWords = (reason: ModelAdaptation['fingerIssues'][number]['reason']): string => FINGER_REASONS[reason] ?? reason;
export const partWords = (bone: StandardBone | null): string => bone === null ? '最上层' : HER_ACTION_PART_NAMES[bone] ?? bone;

/**
 * Skeleton step 2: the actions this model does as an approximation (a face shape it lacks, built from its own near ones), each
 * with the missing part and what stands in, in table order. They count as doable.
 */
export function approximateActions(adaptation: Pick<ModelAdaptation, 'actions'>): { action: string; part: string; using: string[]; lighter: boolean }[] {
  return HER_ACTIONS.flatMap(id => (adaptation.actions[id]?.ok ? adaptation.actions[id].approximate ?? [] : [])
    .map(row => ({ action: HER_ACTION_SPECS[id].name, part: row.part, using: [...row.using], lighter: row.lighter })));
}

/** The actions this model cannot do, grouped by what they lack: [[action names], [parts]] (stable order). */
export function missingActionGroups(adaptation: Pick<ModelAdaptation, 'actions'>): { actions: string[]; missing: string[] }[] {
  const groups = new Map<string, { actions: string[]; missing: string[] }>();
  for (const id of HER_ACTIONS) {
    const row = adaptation.actions[id];
    if (!row || row.ok) continue;
    const key = row.missing.join('|');
    const group = groups.get(key) ?? { actions: [], missing: [...row.missing] };
    group.actions.push(HER_ACTION_SPECS[id].name);
    groups.set(key, group);
  }
  return [...groups.values()];
}
