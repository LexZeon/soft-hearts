/**
 * I-211: what of her the user sees on the screen, from the real framing (not from her size
 * alone): the floor framing's eye height for where she stands (shared/unbound/framing/floor.ts framedEyeHeight, the page's own camera), her feet
 * and crown projected onto the work area, and which part of her height falls inside it.
 *   whole      her feet are in the picture (and so is her crown, or `crownCut` says it is not);
 *   knees-up / waist-up / chest-up / face   the work area's bottom edge cuts her at that height (knobs seen*From);
 *   face-close less than a face's worth of her is in the picture (her face against the glass).
 * Pure: the host gives the world, her height (and her face's, when known) and how far behind the screen she stands.
 */
import { framedEyeHeight, framingGeometry, type FramedBody, type FramingWorld } from '../framing/floor';
import { HER_POSITION_KNOBS, type HerPositionKnobs } from './knobs';

export type HerSeen = 'whole' | 'knees-up' | 'waist-up' | 'chest-up' | 'face' | 'face-close';
export interface HerSeenView { seen: HerSeen; crownCut: boolean; feetOnFloor: boolean }
/** How the turn's line says each band (words.ts, screen-facts.ts). */
export const SEEN_WORDS: Readonly<{ zh: Readonly<Record<HerSeen, string>>; en: Readonly<Record<HerSeen, string>> }> = Object.freeze({
  zh: Object.freeze({ whole: '全身', 'knees-up': '膝盖以上', 'waist-up': '半身（腰以上）', 'chest-up': '胸口以上', face: '只有脸', 'face-close': '脸贴得很近' }),
  en: Object.freeze({ whole: 'your whole body', 'knees-up': 'you from the knees up', 'waist-up': 'half of you (from the waist up)', 'chest-up': 'you from the chest up',
    face: 'only your face', 'face-close': 'your face very close' }),
});

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** What of her shows on the work area when she stands `depthM` behind the screen; null when it cannot be worked out. */
export function herSeen(world: FramingWorld | null | undefined, body: { heightM: number; faceM?: number | null } | null | undefined, depthM: number,
  knobs: HerPositionKnobs = HER_POSITION_KNOBS): HerSeenView | null {
  if (!world || !body || !finite(body.heightM) || body.heightM <= 0 || !finite(depthM)) return null;
  const g = framingGeometry(world);
  if (!g) return null;
  const d = world.viewerDistanceM, ahead = d + depthM;
  if (!(ahead > 1e-6)) return null;
  const framed: FramedBody = { heightM: body.heightM, faceM: finite(body.faceM) ? body.faceM : Number.NaN };
  const eye = framedEyeHeight(g, depthM, framed), t = d / ahead, my = world.screen.heightM / world.display.height, centreY = world.display.y + world.display.height / 2;
  const bodyAt = (dipY: number) => eye - (dipY - centreY) * my / t; // her height (m above her floor) at this line of the screen
  const low = clamp01(bodyAt(world.workArea.y + world.workArea.height) / body.heightM), top = clamp01(bodyAt(world.workArea.y) / body.heightM);
  const crownCut = top < 0.985;
  const seen: HerSeen = top - low < knobs.seenFaceCloseBelow ? 'face-close' : low < knobs.seenKneesFrom ? 'whole' : low < knobs.seenWaistFrom ? 'knees-up'
    : low < knobs.seenChestFrom ? 'waist-up' : low < knobs.seenFaceFrom ? 'chest-up' : 'face';
  return { seen, crownCut: crownCut && seen !== 'face-close', feetOnFloor: low <= 0 && seen === 'whole' };
}
