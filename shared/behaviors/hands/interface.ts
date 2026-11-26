/**
 * I-087 牵手、拉钩、击掌：主机和桌宠窗口之间的话（窄的 IPC，主机这边逐字段检查）。
 *
 *  主机 → 桌宠窗口（desk:hands）：
 *   - offer：她现在伸手（用途、为什么、等多久、按心情的样子）。舞台上她的手伸向你的鼠标；点她的手就是点上了。
 *   - cancel：这次不伸了（换角色、她被藏起来、睡着了、开关关了）：舞台悄悄收回。
 *  桌宠窗口 → 主机：
 *   - handsAnswer { id, outcome }：点上了（taken）/ 没点，她自己收回（not-taken）/ 牵着时松开了（let-go）/ 被打断（interrupted）。
 *     牵手点上以后还会再来一次：松开或被打断时。拉钩、击掌点上就结束。
 *   - handsRequest { use: 'hold' }：你的鼠标在她够得着的地方停了一会儿；要不要伸手由主机按心情决定（窗口从不自己开始）。
 *
 * 互动只认两样抽象的东西（src/senses/hand-input.ts）："你的手在哪儿"和"碰了一下"。现在来自鼠标的位置和点击；以后姿势识别的身体点
 * 也可以给同样的两样东西，这里的话一个字不用改。
 */
import { HAND_OUTCOMES, HAND_USES, HAND_WHYS, type HandOutcome, type HandStyle, type HandUse, type HandWhy } from './knobs';

export interface HandsOfferEvent {
  readonly type: 'offer';
  readonly id: string;
  readonly use: HandUse;
  readonly why: readonly HandWhy[];
  /** 伸到位以后等你多久（毫秒）。 */
  readonly waitMs: number;
  readonly style: HandStyle;
}
export interface HandsCancelEvent { readonly type: 'cancel'; readonly id: string }
export type HandsEvent = HandsOfferEvent | HandsCancelEvent;

export interface HandsAnswer { readonly id: string; readonly outcome: HandOutcome }
export interface HandsRequest { readonly use: 'hold' }

const ID = /^hands-[A-Za-z0-9_-]{1,40}$/u;
export const isHandsOfferId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);

/** Exactly { id, outcome } with a known id shape and a closed outcome. */
export function readHandsAnswer(value: unknown): HandsAnswer | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 2 || !isHandsOfferId(v.id) || !(HAND_OUTCOMES as readonly unknown[]).includes(v.outcome)) return null;
  return { id: v.id, outcome: v.outcome as HandOutcome };
}

/** Exactly { use: 'hold' } (the only thing the window may ask about). */
export function readHandsRequest(value: unknown): HandsRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 1 && v.use === 'hold' ? { use: 'hold' } : null;
}

const unit = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
/** The companion window's check of the host's event (the preload hands it through unchanged): anything off is no event. */
export function readHandsEvent(value: unknown): HandsEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.type === 'cancel') return isHandsOfferId(v.id) ? { type: 'cancel', id: v.id } : null;
  if (v.type !== 'offer' || !isHandsOfferId(v.id) || !(HAND_USES as readonly unknown[]).includes(v.use)) return null;
  if (!Array.isArray(v.why) || v.why.length > HAND_WHYS.length || !v.why.every(w => (HAND_WHYS as readonly unknown[]).includes(w))) return null;
  if (typeof v.waitMs !== 'number' || !Number.isFinite(v.waitMs) || v.waitMs < 1000 || v.waitMs > 60_000) return null;
  const s = v.style as Record<string, unknown> | null;
  if (!s || typeof s !== 'object' || typeof s.hesitant !== 'boolean' || !unit(s.grip) || !unit(s.swing) || !unit(s.lively)
    || typeof s.squeezeBack !== 'boolean' || typeof s.sleepy !== 'boolean') return null;
  return { type: 'offer', id: v.id, use: v.use as HandUse, why: [...new Set(v.why as HandWhy[])], waitMs: v.waitMs,
    style: { hesitant: s.hesitant, grip: s.grip as number, swing: s.swing as number, lively: s.lively as number, squeezeBack: s.squeezeBack, sleepy: s.sleepy } };
}
