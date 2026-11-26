/**
 * I-086 她也照顾你：主机和桌宠窗口之间的话（窄的 IPC，主机这边逐字段检查）。
 *
 *  主机 → 桌宠窗口（desk:give）：
 *   - offer：她那句话已经说出来了，现在把东西递过来（舞台上：手里一块点心或你喂过的那张点心图；或把靠垫推到窗口边上）。
 *     `capture`：这次是特别的时候，手伸到位以后在本机渲染一张她自己的图（不碰摄像头和屏幕）。
 *   - cancel：这次不递了（换角色、她被藏起来、开关关了）：舞台悄悄收回。
 *   - card：她留给你的一张图，配她那句话，桌宠旁边出现一张小卡片，可以存下来。
 *  桌宠窗口 → 主机：
 *   - giveAnswer { id, outcome }：接住了 / 没接（到时间她自己收回）/ 被打断（摸头、喂食、拖窗口、隐藏）。
 *   - givePicture { id, png }：她这次的图（PNG data URL，大小有上限）。
 *   - saveGivePicture { id }：用户点了"存下来"：主机弹系统的另存为对话框（窗口从不发路径）。
 */
import type { GiveItemId, GiveProp, GiveStage } from './knobs';

export interface GiveOfferEvent {
  readonly type: 'offer';
  readonly id: string;
  readonly item: GiveItemId;
  readonly stage: GiveStage;
  readonly prop: GiveProp;
  /** D 高：递得俏皮些（先往自己嘴边送一下再递过来）。 */
  readonly playful: boolean;
  /** 递回给你的那张点心图（JPEG data URL，最长边 256）；没有就是 null。 */
  readonly picture: string | null;
  /** 手伸到位以后等你多久（毫秒）。 */
  readonly waitMs: number;
  readonly capture: boolean;
}
export interface GiveCancelEvent { readonly type: 'cancel'; readonly id: string }
export interface GiveCardEvent { readonly type: 'card'; readonly id: string; readonly line: string; readonly picture: string }
export type GiveEvent = GiveOfferEvent | GiveCancelEvent | GiveCardEvent;

export const GIVE_OUTCOMES = ['taken', 'not-taken', 'interrupted'] as const;
export type GiveOutcome = (typeof GIVE_OUTCOMES)[number];
export interface GiveAnswer { readonly id: string; readonly outcome: GiveOutcome }

const ID = /^give-[A-Za-z0-9_-]{1,40}$/u;
export const isGiveOfferId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);

/** Exactly { id, outcome } with a known offer id shape and a closed outcome. */
export function readGiveAnswer(value: unknown): GiveAnswer | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 2 || !isGiveOfferId(v.id) || !(GIVE_OUTCOMES as readonly unknown[]).includes(v.outcome)) return null;
  return { id: v.id, outcome: v.outcome as GiveOutcome };
}

/** The largest picture data URL the narrow IPC takes (a 384 px PNG of her stage is far below it). */
export const GIVE_PICTURE_IPC_MAX_CHARS = 700_000;
/** Exactly { id, png } where png is a PNG data URL within the cap; returns the decoded bytes. */
export function readGivePicture(value: unknown): { id: string; png: Uint8Array } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 2 || !isGiveOfferId(v.id) || typeof v.png !== 'string' || v.png.length > GIVE_PICTURE_IPC_MAX_CHARS) return null;
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/u.exec(v.png);
  if (!match) return null;
  const bytes = Uint8Array.from(atob(match[1]), char => char.charCodeAt(0));
  const png = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  return png ? { id: v.id, png: bytes } : null;
}
