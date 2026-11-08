import { BEHAVIOR_SEMANTICS, isBehaviorFaceBindingId, isBehaviorSemantic,
  type BehaviorFaceBindingId, type BehaviorSemantic, type BehaviorMotionCue } from './behavior-motion';
import { BEHAVIOR_RECIPES } from './behavior-recipes';
import { authoringText } from './personalize-authoring';

export const VISUAL_PURPOSE = 'selected-image-authoring-v1' as const;
export const VISUAL_MASK = 'gene-eyebrow-eye-v1' as const;
export const VISUAL_GENE_SHA = '0ef63a75a7699f58399ae655357f91542fc5209355aac925a589aac42669df37';
export const VISUAL_FEEDBACK_LIMIT = 2_000, VISUAL_OUTPUT_LIMIT = 10_000, VISUAL_MATERIAL_TTL = 300_000;
export interface VisualStudy {
  observations: { region: 'eyebrow' | 'eye'; visibility: 'visible' | 'occluded' | 'outside_frame' | 'ambiguous'; description: string }[];
  inferences: { label: string; rationale: string; unknown: string }[];
  questions: string[]; insufficient: string;
}
export interface VisualBehaviorProfile {
  enabled: boolean; targetModelSha: string | null; semantic: BehaviorSemantic | null;
  bindingId: BehaviorFaceBindingId | null; label: string; strength: number;
}
export interface VisualBehaviorState {
  characterId: string; revision: number; profile: VisualBehaviorProfile;
  previous?: { revision: number; profile: VisualBehaviorProfile }; storageError?: string;
}
export interface VisualMaterialView {
  id: string; source: 'selected-image'; mime: 'image/jpeg'; width: number; height: number;
  previewDataUrl: string; expiresAt: number; transformed: true;
}
export interface VisualAuthoringState {
  /** Transient text recipe; never part of the saved VisualBehaviorProfile. */
  expression?: import('./expression-composition').ExpressionDraftView;
  id: string; characterId: string; revision: number; savedRevision: number; purpose: typeof VISUAL_PURPOSE;
  connectionLabel: string; imageSupported: boolean; targetSupported: boolean; targetModelSha: string | null;
  material: VisualMaterialView | null; submitNonce: string | null; study: VisualStudy | null;
  saved: VisualBehaviorState; choices: VisualBindingChoice[];
}
export interface VisualBindingChoice { semantic: BehaviorSemantic; bindingId: BehaviorFaceBindingId; label: string }
export interface VisualResearchRequest { sessionId: string; revision: number; materialId: string; submitNonce: string; purpose: typeof VISUAL_PURPOSE; refinement: string }
export interface VisualSelection { semantic: BehaviorSemantic; bindingId: BehaviorFaceBindingId; label: string; strength: number }
export interface VisualPreviewReceipt { phase:'bind'|'ready'|'stop'; id:string; token:string; stageGeneration:number }
export interface VisualSaveRequest { sessionId:string; revision:number; savedRevision:number; previewId:string; previewToken:string }
export interface VisualChangeRequest { sessionId:string; revision:number; kind:'disable'|'undo' }
export interface VisualPreview {
  id: string; token: string; scope: 'personalize-visual-controls'; sessionId: string; revision: number; materialId: string;
  characterId: string; targetModelSha: typeof VISUAL_GENE_SHA; modelUrl: string;
  mask: typeof VISUAL_MASK; cue: BehaviorMotionCue; selection: VisualSelection;
}
export function visualRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('图像制作数据格式不正确。');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) throw Error('图像制作数据缺少字段或包含未知字段。');
  return row;
}
export function visualText(value: unknown, max: number, required = false): string {
  const text = authoringText(value, max, required);
  if (/<\/?[a-z!][^>]*>/i.test(text) || /```|https?:\/\/|file:\/\/|[A-Za-z]:[\\/]/i.test(text)) throw Error('图像制作只接受有界纯文本。');
  return text;
}
export function visualPair(semantic: unknown, bindingId: unknown): semantic is BehaviorSemantic {
  return isBehaviorSemantic(semantic) && isBehaviorFaceBindingId(bindingId)
    && BEHAVIOR_SEMANTICS[semantic].bindingIds.includes(bindingId as never)
    && BEHAVIOR_RECIPES[bindingId].review === 'existing-use-verified' && BEHAVIOR_RECIPES[bindingId].mask === VISUAL_MASK;
}
export function visualChoices(): VisualBindingChoice[] {
  return Object.entries(BEHAVIOR_SEMANTICS).flatMap(([semantic, row]) => row.bindingIds
    .filter(binding => visualPair(semantic, binding))
    .map(bindingId => ({ semantic: semantic as BehaviorSemantic, bindingId, label: `${semantic} · ${bindingId}` })));
}
export function validateVisualSelection(value: unknown): VisualSelection {
  const row = visualRecord(value, ['semantic', 'bindingId', 'label', 'strength']);
  if (!visualPair(row.semantic, row.bindingId) || typeof row.strength !== 'number' || !Number.isFinite(row.strength) || row.strength < 0.05 || row.strength > 0.7) throw Error('表情绑定、情境或强度未通过现有准入。');
  return { semantic: row.semantic, bindingId: row.bindingId as BehaviorFaceBindingId, label: visualText(row.label, 80, true), strength: row.strength };
}
export function emptyVisualBehavior(): VisualBehaviorProfile { return { enabled:false, targetModelSha:null, semantic:null, bindingId:null, label:'', strength:0.34 }; }
export function validateVisualBehavior(value: unknown): VisualBehaviorProfile {
  const row = visualRecord(value, ['enabled','targetModelSha','semantic','bindingId','label','strength']);
  if (typeof row.enabled !== 'boolean') throw Error('行为启用状态不正确。');
  if (row.targetModelSha === null && row.semantic === null && row.bindingId === null && row.enabled === false && row.label === '' && row.strength === 0.34) return emptyVisualBehavior();
  if (row.targetModelSha !== VISUAL_GENE_SHA) throw Error('该模型尚未通过眉眼适配。');
  return { ...validateVisualSelection({ semantic:row.semantic,bindingId:row.bindingId,label:row.label,strength:row.strength }), enabled:row.enabled,targetModelSha:VISUAL_GENE_SHA };
}
export function parseVisualStudy(raw: string): VisualStudy {
  if (raw.length > VISUAL_OUTPUT_LIMIT) throw Error('图像研究结果过长，已忽略。');
  let input: unknown; try { input = JSON.parse(raw); } catch { throw Error('图像研究结果格式不合格，草稿已保留。'); }
  const row = visualRecord(input, ['observations','inferences','questions','insufficient']);
  if (!Array.isArray(row.observations) || row.observations.length > 5 || !Array.isArray(row.inferences) || row.inferences.length > 3 || !Array.isArray(row.questions) || row.questions.length > 3) throw Error('图像研究结果条数不正确。');
  const observations = row.observations.map(value => {
    const item = visualRecord(value, ['region','visibility','description']);
    if (!['eyebrow','eye'].includes(item.region as string) || !['visible','occluded','outside_frame','ambiguous'].includes(item.visibility as string)) throw Error('眉眼可见性数据不正确。');
    return { region:item.region as 'eyebrow'|'eye', visibility:item.visibility as VisualStudy['observations'][number]['visibility'], description:visualText(item.description, 200, true) };
  });
  const inferences = row.inferences.map(value => { const item=visualRecord(value,['label','rationale','unknown']); return { label:visualText(item.label,80,true),rationale:visualText(item.rationale,200,true),unknown:visualText(item.unknown,200) }; });
  return { observations, inferences, questions:row.questions.map(value=>visualText(value,200,true)), insufficient:visualText(row.insufficient,400) };
}
