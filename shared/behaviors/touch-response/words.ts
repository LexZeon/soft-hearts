/**
 * I-136 定稿 7: what she is told about touches a moment ago, so what she says matches her face. One short sentence of facts:
 * "用户刚才点了你两下（肩膀），你抿嘴笑了一下；捏了捏你的脸，你眯着眼笑了、脸红了一下。" Never an instruction, never a number.
 * The same words go into the next chat turn (shared/brain/perception-rule.ts) and into the proactive turn she decides to start (the inner
 * loop's 'touch' focus).
 */
import { contactVerb, type HerContact } from '../../mood/her-state';
import { TOUCH_PART_WORDS, type PullEnd, type PullResponse, type TouchPart } from '../../mood/touch';
import type { TouchEpisodeKind, TouchFaceId } from './interface';
import { TOUCH_FACES, TOUCH_RESPONSE_KNOBS, type TouchResponseKnobs } from './knobs';

/** "你当时……" for the I-037 reactions she can show on a touch (ids of shared/behaviors/reactions/knobs.ts REACTION_TABLE). */
export const REACTION_SHOWN_WORDS: Readonly<Record<string, string>> = Object.freeze({
  blush: '脸红了一下', shy: '害羞地低下了头', happy: '一下子开心起来', nod: '点了点头', tilt: '歪了歪头', heart: '比了个心',
  clap: '鼓了鼓掌', wink: '眨了一只眼', pout: '撅了撅嘴', wave: '挥了挥手',
});

/** One touch to tell (a merged episode or a pat / pinch / snack). */
export interface TouchTell {
  readonly kind: TouchEpisodeKind;
  readonly part?: TouchPart | null;
  readonly count?: number;
  readonly strength?: number;
  readonly heldMs?: number;
  readonly ended?: PullEnd | null;
  readonly face?: TouchFaceId | null;
  /** I-037 reactions she really showed (done), in order. */
  readonly reactions?: readonly string[];
  /** Pull only (I-136 step 5c/5e): what her body did, and the steps she walked along. */
  readonly response?: PullResponse | null;
  readonly steps?: number;
}

const PULL_PART: Readonly<Record<TouchPart, string>> = { head: '你的头', hair: '你的头发', face: '你的脸', shoulder: '你的肩膀', arm: '你的胳膊',
  hand: '你的手', torso: '你', leg: '你的腿', foot: '你的脚', other: '你' };
const COUNT_WORDS = ['', '一下', '两下'];
const CONTACT_KINDS: Readonly<Record<string, HerContact>> = { pat: 'pat', pinch: 'pinch', food: 'food' };

/** What the user did, in a few words (no "用户刚才"). */
export function touchVerb(item: TouchTell, food?: string, knobs: Pick<TouchResponseKnobs, 'lift'> = TOUCH_RESPONSE_KNOBS): string {
  const count = Math.max(1, Math.floor(Number.isFinite(item.count) ? item.count! : 1));
  const part = item.part && item.part !== 'other' ? item.part : null;
  if (item.kind === 'click') {
    const verb = count >= 3 ? '连着点了你好几下' : `点了你${COUNT_WORDS[count]}`;
    return part ? `${verb}（${TOUCH_PART_WORDS[part]}）` : verb;
  }
  if (item.kind === 'pull') {
    const what = PULL_PART[item.part ?? 'other'] ?? '你';
    const hard = (item.strength ?? 0) >= knobs.lift.hardAt;
    if (item.ended === 'holding' || (item.heldMs ?? 0) >= knobs.lift.longMs) return `${hard ? '用力' : ''}拉着${what}不放`;
    return count >= 2 ? `拉了${what}好几次` : `${hard ? '用力' : '轻轻'}拉了拉${what}`;
  }
  const contact = CONTACT_KINDS[item.kind];
  return contact ? contactVerb(contact, food) : '';
}

/**
 * What she showed: on a pull, what her body did first (I-136 step 5c/5e: "跟着走了几步", "往回拽了一下"), then the face, then "挣开了", then the
 * reactions she did (at most three, no repeats). Facts only.
 */
export function shownWords(item: TouchTell): string[] {
  const out: string[] = [], pull = item.kind === 'pull';
  if (pull && ((item.steps ?? 0) > 0 || item.response === 'followed')) out.push('跟着走了几步');
  if (pull && item.response === 'pulled-back') out.push('往回拽了一下');
  if (item.face && TOUCH_FACES[item.face]) out.push(TOUCH_FACES[item.face].words);
  if (pull && item.ended === 'broke-free') out.push('挣开了');
  for (const id of item.reactions ?? []) { const words = REACTION_SHOWN_WORDS[id]; if (words && !out.includes(words)) out.push(words); }
  return out.slice(0, 3);
}

const segment = (item: TouchTell, food: string | undefined, shown: number) => {
  const verb = touchVerb(item, food), words = shownWords(item).slice(0, shown);
  return verb ? verb + (words.length ? `，你${words.join('、')}` : '') : '';
};

/**
 * The whole sentence ('' for none), newest first, within knobs.wordsMax characters: older touches drop first, then what she showed
 * is shortened. `food` is I-019's recognized snack name (only used for a snack).
 */
export function touchWords(items: readonly TouchTell[], food?: string, knobs: Pick<TouchResponseKnobs, 'wordsMax' | 'lift'> = TOUCH_RESPONSE_KNOBS): string {
  const list = items.filter(item => !!touchVerb(item, food, knobs)).slice(0, 4);
  for (let count = list.length; count > 0; count--) {
    for (let shown = 3; shown >= 0; shown--) {
      const parts = list.slice(0, count).map(item => segment(item, food, shown)).filter(Boolean);
      const line = parts.length ? `用户刚才${parts.join('；')}。` : '';
      if (line.length <= knobs.wordsMax) return line;
    }
  }
  return '';
}
