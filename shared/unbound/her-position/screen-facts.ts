/**
 * I-193: the parts of her turn's position
 * line that say how big she is on the screen, the near-far table for this screen and her height, and how her last go-markers went.
 *
 * Information only (handbook「提示不是锁」): facts, never when or whether to do anything; no walking verb either (the tests hold these parts to the
 * same guard as the rest of the line: no instruction word, no 走 / 去 / 移, no go / move / walk). The metres are the told metres of the one screen
 * formula (shared/unbound/screen-terms toldDistanceM, the same as the line's own distance). Pure.
 */
import type { GoWord } from './ask';
import type { GoStayWhy } from './journal';
import type { GoOutcome } from './outcome';
import type { NearTable } from './reach';
import { SEEN_WORDS, type HerSeenView } from './seen';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** Told metres as written: one decimal under 2 m, else whole or one decimal (the screen formula already rounded them). */
export const metresText = (value: number): string => (value < 2 ? value.toFixed(1) : Number.isInteger(value) ? String(value) : value.toFixed(1));
const share = (size: number) => `${Math.max(5, Math.round(size * 20) * 5)}%`;
const times = (size: number) => (size >= 10 ? String(Math.round(size)) : size.toFixed(1));

/** The table's short band words (the line's own words for her spot stay SEEN_WORDS). */
const TABLE_WORDS = {
  zh: { whole: '全身', 'knees-up': '膝盖以上', 'waist-up': '腰以上', 'chest-up': '胸口以上', face: '只有脸', 'face-close': '脸贴得很近' },
  en: { whole: 'whole body', 'knees-up': 'knees up', 'waist-up': 'waist up', 'chest-up': 'chest up', face: 'only the face', 'face-close': 'face very close' },
} as const satisfies Record<'zh' | 'en', Record<keyof typeof SEEN_WORDS.zh, string>>;

/** How big she is and the table ('' without a table). `seen`: the framing at her spot (her feet below the picture when she is not whole). */
export function screenFactsLine(size: number, seen: HerSeenView | null, table: NearTable | null, en: boolean): string {
  if (!table || !finite(size) || size <= 0) return '';
  const feetBelow = seen ? seen.seen !== 'whole' : size > 1;
  const words = en ? TABLE_WORDS.en : TABLE_WORDS.zh;
  const rows = table.rows.map(row => (en ? `${metresText(row.distanceM)} m ${words[row.seen]}` : `${metresText(row.distanceM)} 米${words[row.seen]}`));
  const near = metresText(table.nearest.distanceM), far = metresText(table.farthest.distanceM);
  if (en) {
    const big = size > 1 ? `Your height is about ${times(size)} times the usable screen height` : `You take up about ${share(size)} of the usable screen height`;
    return ` ${big}${feetBelow ? ', your feet below the picture' : ''}. On this screen, about ${rows.join(', ')}${rows.length ? '; ' : ''}you can stand ${near}–${far} m away.`;
  }
  const big = size > 1 ? `你的身高约是屏幕可用高度的 ${times(size)} 倍` : `你约占屏幕可用高度的 ${share(size)}`;
  return `${big}${feetBelow ? '，脚在画面下面' : ''}。这块屏幕上约 ${rows.join('、')}${rows.length ? '；' : ''}你能站的远近是 ${near}～${far} 米。`;
}

const WORD = {
  zh: { 'go-left': '到左边', 'go-right': '到右边', 'go-middle': '到中间', 'come-near': '靠近', 'go-far': '离远一些', 'go-corner': '到角落', 'go-cursor': '到鼠标旁边', go: '到指定位置' },
  en: { 'go-left': 'to the left', 'go-right': 'to the right', 'go-middle': 'to the middle', 'come-near': 'nearer', 'go-far': 'farther', 'go-corner': 'to a corner', 'go-cursor': 'beside the pointer', go: 'to a set spot' },
} as const satisfies Record<'zh' | 'en', Record<GoWord, string>>;
const WHY = {
  zh: { 'not-shown': '你当时不在屏幕上', asleep: '你当时睡着了', pulled: '用户正拉着你', playing: '你们正在玩游戏', typing: '用户正在给你打字', 'close-moment': '正在亲亲抱抱或凑近看',
    'already-there': '你已经在那儿了', 'cursor-stale': '不知道用户的鼠标在哪', covered: '那个位置会挡住用户正在用的东西', 'no-place': '还不知道你站在哪', queued: '前一个位置记号还没做完', dropped: '等了太久，没做成' },
  en: { 'not-shown': 'you were not on the screen', asleep: 'you were asleep', pulled: 'the user was pulling you', playing: 'you two were playing a game', typing: 'the user was typing to you',
    'close-moment': 'a kiss, a hug or a close look was on', 'already-there': 'you were already there', 'cursor-stale': "the user's pointer was not known", covered: 'that spot would cover what the user is using',
    'no-place': 'where you stand was not known', queued: 'the marker before it was not done yet', dropped: 'it waited too long and did not happen' },
} as const satisfies Record<'zh' | 'en', Record<GoStayWhy, string>>;
/** "Already there" said for the two words that stop at a limit (come-near at the nearest, go-far at the farthest). */
const AT_LIMIT = {
  zh: { 'come-near': '你已经站在能站到的最近处了', 'go-far': '你已经站在能站到的最远处了' },
  en: { 'come-near': 'you were already at the nearest you can stand', 'go-far': 'you were already at the farthest you can stand' },
} as const;

/** How her go-markers since the last turn went ('' for none): went (where she is now is the line above) or stayed, with the reason in plain facts. */
export function goOutcomeLine(outcomes: readonly GoOutcome[] | null, en: boolean): string {
  if (!outcomes?.length) return '';
  const lang = en ? 'en' : 'zh';
  const parts = outcomes.map(o => {
    const what = WORD[lang][o.word];
    if (o.outcome === 'went') return en ? `${what}: you changed place (where you are now is above)` : `${what}——换了位置，现在就在上面说的地方`;
    const why = o.why === 'already-there' && (o.word === 'come-near' || o.word === 'go-far') ? AT_LIMIT[lang][o.word] : o.why ? WHY[lang][o.why] : '';
    return en ? `${what}: you stayed where you were${why ? `, ${why}` : ''}` : `${what}——没有动${why ? `，${why}` : ''}`;
  });
  return en ? ` Your place markers since last turn: ${parts.join('; ')}.` : `上一轮你写的位置记号：${parts.join('；')}。`;
}
