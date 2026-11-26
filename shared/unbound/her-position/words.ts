/**
 * I-193 → I-211: where she stands, as one line for her turn.
 *
 * I-193 gave words only. I-211 adds facts with numbers, all from the user's screen:
 *   - how far from the user, by ONE screen formula (shared/unbound/screen-terms/distance.ts: the usable screen as a 45° camera frame), so the
 *     same look is the same number on every computer; never the world's metres behind the glass;
 *   - what the user sees of her (whole body, knees up, waist up, chest up, only the face, the face very close; the crown out of the picture),
 *     from the real framing (seen.ts);
 *   - left / middle / right and the share across (about 70%);
 *   - the user's default place in the same terms, when one is set;
 *   - the edge she is close to, and the taskbar when the display has one and her feet are on its line (as before).
 * I-193 numbers, when the host gives the
 * table (screen-facts.ts): how big she is on the screen, the near-far table for this screen and her height, and how her last go-markers went.
 * The line is information only: it never tells her to do anything (the tests check the instruction words), and it says nothing about the window
 * you are using (the app has no reading of it). Pure: the host gives her spot (across, size), the told distances (electron/unbound/her-place.ts works
 * them out with shared/unbound/screen-terms/distance.ts, the one screen formula), the framing view and the default place.
 */
import type { LookSpot } from '../screen-terms';
import { HER_POSITION_KNOBS, type HerPositionKnobs } from './knobs';
import { SEEN_WORDS, type HerSeenView } from './seen';
import type { NearTable } from './reach';
import type { GoOutcome } from './outcome';
import { goOutcomeLine, metresText, screenFactsLine } from './screen-facts';

export type HerSide = 'left' | 'middle' | 'right';
export type HerRange = 'very-near' | 'near' | 'middle' | 'far';
/** Her place in closed words (the journal keeps these; the turn's line says numbers too). */
export interface HerPosition { side: HerSide; range: HerRange; edge: 'left' | 'right' | null; floor: boolean }
export type HerPositionLanguage = 'zh-CN' | 'en';
/** What the turn's line may say beyond her spot. */
export interface HerPositionFacts {
  /** The display has a taskbar (work area smaller than the display): only then is it named. */
  taskbar?: boolean;
  language?: HerPositionLanguage | string | null;
  /** How far from the user, as told (m, already rounded by the screen formula: screen-terms toldDistanceM); absent: no distance. */
  distanceM?: number | null;
  /** What the user sees of her (seen.ts); absent: the size alone says whether her feet are on the line, nothing about the framing. */
  seen?: HerSeenView | null;
  /** The user's default place, with its told distance (absent or null: none set, nothing said). */
  defaultPlace?: (LookSpot & { distanceM?: number | null }) | null;
  /** I-193: the near-far table for this screen and her height (reach.ts nearTable); given: the line also says how big she is and the table. */
  table?: NearTable | null;
  /** I-193: how her go-markers since the last turn went (outcome.ts GoOutcomes.take); absent or empty: nothing said. */
  lastGo?: readonly GoOutcome[] | null;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const usable = (spot: { across: number; size: number } | null | undefined): spot is LookSpot => !!spot && finite(spot.across) && finite(spot.size) && spot.size > 0;

/** Her place in rough terms; null when the spot is not usable. */
export function herPosition(spot: LookSpot | null | undefined, knobs: HerPositionKnobs = HER_POSITION_KNOBS): HerPosition | null {
  if (!usable(spot)) return null;
  const across = spot.across, size = spot.size;
  const range: HerRange = size >= knobs.veryNearSize ? 'very-near' : size >= knobs.nearSize ? 'near' : size <= knobs.farSize ? 'far' : 'middle';
  return { side: sideOf(across, knobs), range, edge: across <= knobs.edgeShare ? 'left' : across >= 1 - knobs.edgeShare ? 'right' : null, floor: size <= knobs.floorSize };
}
const sideOf = (across: number, knobs: HerPositionKnobs): HerSide => (across < knobs.leftUntil ? 'left' : across > knobs.rightFrom ? 'right' : 'middle');
/** The share across as said: the nearest 5%. */
const percent = (across: number) => Math.round(Math.min(1, Math.max(0, across)) * 20) * 5;
const told = (value: unknown): number | null => (finite(value) && value > 0 ? value : null);
const metres = metresText;

const ZH = {
  side: { left: '屏幕偏左', middle: '屏幕中间', right: '屏幕偏右' },
  seen: SEEN_WORDS.zh,
  crown: '头顶出画了',
  edge: { left: '靠着左边缘', right: '靠着右边缘' },
  floor: '脚边是任务栏',
} as const;
const EN = {
  side: { left: 'the left of the screen', middle: 'the middle of the screen', right: 'the right of the screen' },
  seen: SEEN_WORDS.en,
  crown: 'the top of your head is out of the picture',
  edge: { left: 'close to the left edge', right: 'close to the right edge' },
  floor: 'the taskbar is by your feet',
} as const;

/**
 * "你现在离用户约 3.9 米，站在屏幕偏右（横向约 75% 处）；用户看到的你：全身，靠着右边缘，脚边是任务栏。用户给你定的出场位置：屏幕偏右（横向约 80% 处），离用户约 4 米。"
 * ('' when her place is not known). English when the chat is in English.
 */
export function herPositionLine(spot: LookSpot | null | undefined, facts: HerPositionFacts = {}, knobs: HerPositionKnobs = HER_POSITION_KNOBS): string {
  const p = herPosition(spot, knobs);
  if (!p || !spot) return '';
  const en = facts.language === 'en', w = en ? EN : ZH;
  const far = told(facts.distanceM), seen = facts.seen ?? null;
  const onFloor = seen ? seen.feetOnFloor : p.floor;
  const where = en ? `${w.side[p.side]} (about ${percent(spot.across)}% across)` : `${w.side[p.side]}（横向约 ${percent(spot.across)}% 处）`;
  const view: string[] = [];
  if (seen) { view.push(w.seen[seen.seen]); if (seen.crownCut) view.push(w.crown); }
  if (p.edge) view.push(w.edge[p.edge]);
  if (facts.taskbar === true && onFloor) view.push(w.floor);
  let line: string;
  if (en) {
    line = `You are ${far !== null ? `about ${metres(far)} m from the user, ` : ''}at ${where}`;
    if (view.length) line += seen ? `; the user sees ${view.join(', ')}` : `, ${view.join(', ')}`;
    line += '.';
  } else {
    line = `你现在${far !== null ? `离用户约 ${metres(far)} 米，` : ''}站在${where}`;
    if (view.length) line += seen ? `；用户看到的你：${view.join('，')}` : `，${view.join('，')}`;
    line += '。';
  }
  return line + screenFactsLine(spot.size, seen, facts.table ?? null, en) + defaultPlaceLine(facts, en, knobs) + goOutcomeLine(facts.lastGo ?? null, en);
}

/** The user's default place in the same terms ('' when none is set). */
function defaultPlaceLine(facts: HerPositionFacts, en: boolean, knobs: HerPositionKnobs): string {
  const place = facts.defaultPlace;
  if (!usable(place)) return '';
  const side = sideOf(place.across, knobs), far = told(place.distanceM);
  if (en) return ` The place the user set for you to appear at: ${EN.side[side]} (about ${percent(place.across)}% across)${far !== null ? `, about ${metres(far)} m from the user` : ''}.`;
  return `用户给你定的出场位置：${ZH.side[side]}（横向约 ${percent(place.across)}% 处）${far !== null ? `，离用户约 ${metres(far)} 米` : ''}。`;
}
