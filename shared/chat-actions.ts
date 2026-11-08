/**
 * 她自己用的小动作 (universal skeleton step 5, docs/claude/2026-11-06-skeleton-step5.md): five body actions and two face shapes
 * from her action table (shared/her-actions.ts) that she may pick in a chat reply's state tail, beside the four talking gestures.
 * Pure data and checks: no Electron, no Three, no I/O, nothing about Claude (the wording she reads is in electron/mood-chat.ts).
 *
 * - Offered only when this model can do it: the character page's own rule (herActionSupport: ok, approximations count), not
 *   held back by this model's stored fit score, and not switched off on the page (mouth / closing eyes / gestures). An action
 *   that is not offered is never listed, and picking it anyway does nothing (the tail keeps its mood).
 * - A pick is a suggestion, never an order: the host sends one cue, and the stage plays it only if it can right now (its own
 *   part, fit and owner checks); otherwise it is skipped quietly.
 */
import { HER_ACTION_SPECS, type HerActionId, type HerActionSupport } from './her-actions';
import type { MotionFitRecord } from './motion-fit-record';
import type { ModelCapabilityId } from './model-capability';
import { CAPABILITY_LABELS } from './model-capability-check';

/** The words in the tail (`gesture`), in the order she reads them. */
export const CHAT_ACTION_WORDS = ['wave', 'nod', 'tilt', 'heart', 'clap', 'wink', 'pout'] as const;
export type ChatActionWord = typeof CHAT_ACTION_WORDS[number];
/** The action each word plays. */
export const CHAT_ACTION_OF: Readonly<Record<ChatActionWord, HerActionId>> = Object.freeze({
  wave: 'hello-wave', nod: 'nod', tilt: 'tilt', heart: 'two-hand-heart', clap: 'clap', wink: 'wink', pout: 'pout',
});
export const isChatActionWord = (value: unknown): value is ChatActionWord =>
  typeof value === 'string' && (CHAT_ACTION_WORDS as readonly string[]).includes(value);

/**
 * The character page's switch that, when off, takes the action away: 有口型 for a mouth shape, 能闭眼 for the wink (the stage
 * refuses those too), 能做手势 for the arm actions. A head nod or tilt has no switch of its own.
 */
function pageSwitch(action: HerActionId): ModelCapabilityId | null {
  const spec = HER_ACTION_SPECS[action];
  return spec.face ? (spec.face.scope === 'mouth' ? 'mouth' : 'closeEyes') : spec.mode === 'arms' ? 'gesture' : null;
}

export interface ChatActionModel {
  /** herActionSupport for this model (shared/model-adaptation.ts modelAdaptation(...).actions); null: no profile yet (nothing offered). */
  support: Readonly<Record<HerActionId, HerActionSupport>> | null;
  /** This model's stored fit scores; used only when `stamp` matches (another conversion or check: not known, not used). */
  fits?: MotionFitRecord | null;
  stamp?: string;
  /** The user's on/off on the character page (absent: follows what was detected). */
  choices?: Partial<Record<ModelCapabilityId, 'on' | 'off'>>;
}

/**
 * Why this model cannot do the word right now, in the user's words, or null when it can. The one rule behind both the tail's
 * list (offeredChatActions) and the internal channel's answer (the missing parts are the character page's own words).
 */
export function chatActionRefusal(word: ChatActionWord, model: ChatActionModel | null | undefined): string | null {
  if (!model?.support) return '还没有这个模型的体检档案（先载入模型）';
  const action = CHAT_ACTION_OF[word], row = model.support[action];
  if (!row) return '这个模型的档案里没有这个动作';
  if (!row.ok) return `这个模型做不了，缺：${row.missing.length ? row.missing.join('、') : '所需的部位'}`;
  const page = pageSwitch(action);
  if (page && model.choices?.[page] === 'off') return `角色页「${CAPABILITY_LABELS[page]}」被关掉了`;
  const fits = model.fits && model.stamp && model.fits.stamp === model.stamp ? model.fits.motions : [];
  if (fits.some(fit => fit.sha256 === HER_ACTION_SPECS[action].sha256 && fit.status === 'hidden')) return '打分判这个动作放在这个模型上不合适，不播';
  return null;
}

/** The words this model can do now, in CHAT_ACTION_WORDS order. Anything unknown or missing counts as "cannot". */
export function offeredChatActions(model: ChatActionModel | null | undefined): ChatActionWord[] {
  if (!model?.support) return [];
  return CHAT_ACTION_WORDS.filter(word => chatActionRefusal(word, model) === null);
}

export interface ChatActionMoodView { expressions: boolean; snapshot: { phase: string; intensity: { posture: number; expression: number } } }

/** Why her mood view holds a picked action back right now (the user's words), or null when it may go. */
export function chatActionYield(word: ChatActionWord, view: ChatActionMoodView): string | null {
  if (!view.expressions) return '她的「自动表现」关着';
  if (view.snapshot.phase !== 'idle') return `她正在别的互动里（${view.snapshot.phase}），先让给它`;
  const spec = HER_ACTION_SPECS[CHAT_ACTION_OF[word]];
  const intensity = spec.face ? view.snapshot.intensity.expression : view.snapshot.intensity.posture;
  return Number.isFinite(intensity) && intensity > 0 ? null : '这张角色卡把这类表现的强度调成了 0';
}

/**
 * Whether her mood view lets a picked action through at all, the same gates the talking gesture has before the stage: her
 * expressions are on, she is not in the middle of another interaction, and the card's intensity for that kind is above zero
 * (posture for the body actions, expression for the face shapes). Nothing about which one she picked or how often.
 */
export function chatActionAllowed(word: ChatActionWord, view: ChatActionMoodView): boolean {
  return chatActionYield(word, view) === null;
}

/** A mouth shape (撅嘴) waits until she has finished speaking; the others go at once (a wave while talking is natural). */
export const chatActionWaitsForSpeech = (word: ChatActionWord): boolean => HER_ACTION_SPECS[CHAT_ACTION_OF[word]].face?.scope === 'mouth';
