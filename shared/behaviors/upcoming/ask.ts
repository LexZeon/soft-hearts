// P-001 steps 2 and 3: when a remembered plan's time has come, the pure rules for "may she ask, and what does she get to read". Plan:
// docs/claude/2026-11-05-p001-plans-plan.md section 3; record: docs/claude/2026-11-12-p001-steps-2-3.md. No clock, no I/O.
//
//  - step 2 (the user comes to her): ONE private line in that turn's context (askLine); she decides whether and how to ask;
//  - step 3 (she speaks first): the same plan becomes one of the loosen plan's topics (topicText), through the impulse -> regulation path.
// Never a guilt lever (principle 6 and its supplement): the lines never say the user did not tell her, never ask for results as a duty, and
// a plan that sounds tender (loss, hospital, court, a layoff...) gets a gentler line in step 2 and no opening at all in step 3.

import type { UpcomingKnobs } from './knobs';
import { UPCOMING_KNOBS } from './knobs';

/** Plans that may be heavy to be asked about (the profile's own sensitive-word list already keeps health, ids and secrets out of the list). Closed list. */
export const TENDER_PLAN = /分手|离婚|葬礼|追悼|告别|去世|复查|体检|手术|医院|看病|门诊|治疗|心理|开庭|官司|调解|裁员|辞退|被开|谈崩|挂科|补考|重考|成绩|结果出来|宣判|\b(?:funeral|surgery|hospital|clinic|court|layoff|breakup|divorce)\b/iu;

export const isTenderPlan = (what: string, said = ''): boolean => TENDER_PLAN.test(`${what} ${said}`);

/** Why she does not ask right now (null: she may). Closed values. */
export type AskHold = 'night' | 'asleep' | 'user-low';

export interface AskFloorInput {
  /** The user's local hour, 0-23. */
  readonly hour: number;
  readonly asleep: boolean;
  /** The user's state she read (shared/senses/user-state.ts), or null. */
  readonly userState: string | null;
}

/**
 * The floor for asking about a plan (both steps): the dead of night, her being asleep, the user low or irritated. Not knobs: the user's
 * well-being and her sleep. The late-night range is the plan's "凌晨 0 点到 6 点" (knobs.ask.nightFrom / nightTo, so it can be moved).
 */
export function askFloor(input: AskFloorInput, knobs: UpcomingKnobs = UPCOMING_KNOBS): AskHold | null {
  if (input.asleep) return 'asleep';
  const { nightFrom, nightTo } = knobs.ask;
  const hour = Number.isFinite(input.hour) ? input.hour : 12;
  if (nightFrom < nightTo ? hour >= nightFrom && hour < nightTo : hour >= nightFrom || hour < nightTo) return 'night';
  if (input.userState === 'low' || input.userState === 'annoyed') return 'user-low';
  return null;
}

// What the user says counts as bringing the plan up first when it shares a distinctive pair of characters with the plan's short form.
const TIME_WORDS = /大后天|后天|明天|今天|今晚|昨天|早上|上午|中午|下午|晚上|傍晚|下周[一二三四五六日天]?|这周[一二三四五六日天]?|周[一二三四五六日天末]|下个月|[0-9零一二两三四五六七八九十]+\s*[点号日月天周]半?|几点|几号|\d{1,2}:\d{2}/gu;
const FILLER = new Set(Array.from('去要的了在和是有个我你他她它这那把给让就也还想会能吗呢吧啊跟与及或先再'));
const grams = (text: string): Set<string> => {
  const out = new Set<string>();
  const clean = text.normalize('NFKC').toLocaleLowerCase().replace(TIME_WORDS, ' ');
  for (const piece of clean.split(/[\s\p{P}\p{S}]+/u)) {
    const chars = Array.from(piece);
    if (/^[a-z0-9]+$/u.test(piece)) { if (chars.length >= 3) out.add(piece); continue; }
    for (let i = 0; i + 1 < chars.length; i++) if (!FILLER.has(chars[i]) && !FILLER.has(chars[i + 1])) out.add(chars[i] + chars[i + 1]);
  }
  return out;
};

/** The user's message touches this plan (so she does not ask: they already brought it up). Leans toward "yes": a missed ask is the safe side. */
export function mentionsPlan(userText: string, what: string): boolean {
  const mine = grams(userText);
  if (!mine.size) return false;
  for (const gram of grams(what)) if (mine.has(gram)) return true;
  return false;
}

/** "别问了" and the like: the user does not want to be asked. Closes every plan due now. */
export const STOP_ASKING = /别问|不用问|不要问|别再问|不必问|别提这|不想提/u;
export const wantsNoAsk = (userText: string): boolean => STOP_ASKING.test(userText.normalize('NFKC'));

/** A plan's words as she may read them in a private line: no quotes, line breaks or tags, bounded. */
const plain = (value: string, max: number): string => Array.from(value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>`「」"]/gu, ' ').replace(/\s+/gu, ' ').trim()).slice(0, max).join('');

export interface PlanWords { readonly what: string; readonly said: string }

/**
 * Step 2: the one line in the turn's private context. Says what she remembers and that the time has passed; she decides whether to ask and
 * how, by her own character. No sample sentence. No complaint that the user did not tell her. Tender plans: only a gentle, optional care.
 */
export function askLine(plan: PlanWords): string {
  const what = plain(plan.what, 24), said = plain(plan.said, 16);
  const head = `你记得用户说过${said}有「${what}」这件事，那个时间已经过去了，他这轮还没提。`;
  if (isTenderPlan(plan.what, plan.said))
    return `${head}这件事可能让他心里不轻松：只在气氛合适时轻轻关心一下，不追问、不要他交代结果，他不接就算了；不提"记录""提醒"，不带一点责怪。`;
  return `${head}合适的话，按你的性格自然问一句他怎么样；他不想说或心情不好就别追问；不提"记录""提醒"，不带一点责怪。`;
}

/** Step 3: the text a "plan" topic carries (never offered for a tender plan: nothing is pushed out of the blue about those). */
export function topicText(plan: PlanWords): string {
  return `他说过${plain(plan.said, 16)}有「${plain(plan.what, 24)}」，时间已经过去了，他还没提。自然问一句他怎么样，不追问、不带一点责怪，不提"记录""提醒"`;
}
