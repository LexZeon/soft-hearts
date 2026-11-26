// I-115 A: her mood told as a situation she is in,
// not as labels and numbers. Pure text building from what the mood host already knows; no model call, no new state beyond the
// "last phrase" memory that keeps her from hearing the same words twice in a row. The numbers keep driving expression, voice, body,
// initiative and sleep exactly as before: they are only no longer shown to her. The text has no ASCII letters or digits.
import type { MoodContext, MoodLabel } from '../../shared/foundation/mood';
import { MOOD_LABELS } from '../../shared/mood/mood-runtime';
import type { MoodLightSince } from '../../shared/brain';

/** Her own words for each main feeling: a few ways to say it, one picked per turn (a little different each time, never the same twice running). */
const FEELING_WORDS: Record<MoodLabel, readonly string[]> = {
  calm: ['心里挺平静的', '心里安安静静的', '没什么波澜，挺平和'],
  close: ['觉得和用户挺亲近', '心里软软的，想靠近用户一点', '和用户之间暖暖的'],
  content: ['心里很满足', '觉得日子挺踏实、挺满足', '心里暖洋洋的'],
  happy: ['心情不错', '有点开心', '心里亮亮的'],
  excited: ['有点兴奋，静不下来', '心里雀跃', '精神头很足，有点按捺不住'],
  concerned: ['有点担心', '心里悬着一点', '放不下心'],
  disappointed: ['有点失落', '心里空了一小块', '有点蔫'],
  upset: ['有点不高兴', '心里堵着一点', '有些闷闷的不满'],
  longing: ['有点想用户', '心里惦记着用户', '想用户了'],
  sad: ['有点难过', '心里发沉', '情绪低低的'],
  relieved: ['松了一口气', '心里一块石头落了地', '总算放松下来了'],
  'tense-expectation': ['有点紧张，又有点期待', '心里悬悬的，等着什么', '紧张里带着盼头'],
  afraid: ['有点害怕', '心里发慌', '被吓得有点不安'],
};

/** The "伴随" shade, in her own words (companion keys as in electron/mood/mood.ts). */
const COMPANION_WORDS: Record<string, string> = {
  playful: '又带着一点想玩闹的劲儿', close: '又有些想靠近用户', comfortable: '身边的感觉很舒适',
  cautious: '但还留着一点小心', wistful: '还有一点没散的想念',
};

/** What the last exchange left, by topic context. Neutral says nothing. */
const CONTEXT_WORDS: Record<MoodContext, string> = {
  neutral: '', positive: '你们刚才聊得挺顺', support: '你刚才被用户支持了一下', concern: '你正在为用户担心',
  disappointment: '你刚才有点失望', offense: '你刚才被冒犯了一下', fright: '你刚才被吓了一跳',
};

const HAS_ASCII = /[A-Za-z0-9]/u;
const cut = (text: string, max: number) => { const chars = [...text.trim().replace(/\s+/gu, ' ')]; return chars.length > max ? chars.slice(0, max).join('') : chars.join(''); };

/** How long since the user was last here, as a feeling of waiting. '' when it was only a moment ago. */
export function sinceWords(lastInteractionAt: number | null, now: number): string {
  if (lastInteractionAt === null || !Number.isFinite(lastInteractionAt) || now < lastInteractionAt) return '';
  const minutes = (now - lastInteractionAt) / 60_000;
  if (minutes < 10) return '';
  if (minutes < 60) return '用户离开了一小会儿，你等着';
  if (minutes < 4 * 60) return '你等了用户一阵子';
  if (minutes < 12 * 60) return '你等了用户大半天';
  if (minutes < 36 * 60) return '用户隔了一整天才来';
  return '用户好些天没来了';
}

/** I-139's light mood line (shared/foundation/i139-texts.ts moodLightLine): the same steps as sinceWords, as a key. null when it was only a moment ago. */
export function sinceKey(lastInteractionAt: number | null, now: number): MoodLightSince | null {
  if (lastInteractionAt === null || !Number.isFinite(lastInteractionAt) || now < lastInteractionAt) return null;
  const minutes = (now - lastInteractionAt) / 60_000;
  if (minutes < 10) return null;
  if (minutes < 60) return 'minutes';
  if (minutes < 4 * 60) return 'hours';
  if (minutes < 12 * 60) return 'half-day';
  if (minutes < 36 * 60) return 'day';
  return 'days';
}

/** Picks one of a list, never the one given as `avoid` when there is another. `random` in [0, 1). */
export function pickDifferent(options: readonly string[], avoid: string | undefined, random: () => number): string {
  const pool = options.length > 1 && avoid !== undefined ? options.filter(option => option !== avoid) : options;
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));
  return pool[index] ?? '';
}

export interface SituationInput {
  primary: MoodLabel;
  companion: string | null;
  /** The topic context of her state and of the latest event (null: none). */
  context: MoodContext;
  eventContext: MoodContext | null;
  /** The short reason her state carries (the tail's or the judge's words); dropped when empty, the default, or not plain Chinese. */
  reason: string;
  /** welcomeBackLine's text when she has been missing the user or just saw the user again; replaces the feeling, as today. */
  welcome: string;
  lastInteractionAt: number | null;
  reunion: boolean;
  /** electron/mood/mood.ts's tiredness sentence (starts with a space, '' when awake). */
  fatigue: string;
  /** One or two things from today's chat notes (the notebook's own words). */
  today: readonly string[];
  now: number;
  random: () => number;
  /** The phrase picked last time, to avoid (and the one picked now is returned in `picked`). */
  lastPhrase?: string;
}

export interface SituationResult { text: string; picked: string }

/** The tiredness sentence of the numeric mood context (electron/mood/mood.ts chatContext): what she feels; how she shows it is hers (rules removal 2026-11-25: no "not every time" wording). */
export function fatigueContextText(feeling: string): string {
  return ` 当前疲倦感受：${feeling}。保留当前角色性格，让措辞和节奏自然反映这一感受；完整回应用户，不假装没收到输入。`;
}

export const SITUATION_FOLLOW_SENTENCE ='这只是你此刻的心情从哪里来。如果这一轮发生的事让你的心情变了，就跟着变，不用维持原样。';

/** The situation as two or three short sentences plus the follow-the-change sentence. */
export function moodSituation(input: SituationInput): SituationResult {
  const since = sinceWords(input.lastInteractionAt, input.now);
  let picked = '';
  let feeling: string;
  if (input.welcome) feeling = input.welcome;
  else {
    picked = pickDifferent(FEELING_WORDS[input.primary] ?? [MOOD_LABELS[input.primary]], input.lastPhrase, input.random);
    const shade = input.companion ? COMPANION_WORDS[input.companion] : '';
    feeling = `你${picked}${shade ? `，${shade}` : ''}`;
  }
  const reason = input.reason && input.reason !== '自然陪伴' && !HAS_ASCII.test(input.reason) ? `起因是${cut(input.reason, 60)}` : '';
  const topic = CONTEXT_WORDS[input.context] || (input.eventContext ? CONTEXT_WORDS[input.eventContext] : '');
  const recent = [topic, reason].filter(Boolean).join('，');
  const reunion = input.reunion && !input.welcome ? '用户刚回来' : '';
  const together = [reunion, since].filter(Boolean).join('，');
  const notes = input.today.map(note => cut(note, 40)).filter(note => note && !HAS_ASCII.test(note)).slice(0, 2);
  const lines = [
    together ? `${together}。` : '',
    `${feeling}。`,
    recent ? `${recent}。` : '',
    notes.length ? `今天你们之间：${notes.join('；')}。` : '',
    input.fatigue.trim() ? `${input.fatigue.trim()}` : '',
  ].filter(Boolean);
  return { text: `你现在的状态：${lines.join('')}${SITUATION_FOLLOW_SENTENCE}`, picked };
}

/**
 * Today's chat notes as a couple of lines for the situation: up to two, chosen at random from the day's notes (a different pair
 * when there is a choice), each "title" or "title，summary" cut short, plain Chinese only (a line with a letter or a digit is left out).
 */
export function todayLines(notes: readonly { title: string; summary: string }[], random: () => number, avoid: readonly string[] = []): string[] {
  const lines = notes.map(note => cut(note.title || note.summary, 40)).filter(line => line && !HAS_ASCII.test(line));
  const fresh = lines.filter(line => !avoid.includes(line));
  const pool = [...(fresh.length ? fresh : lines)];
  const out: string[] = [];
  while (pool.length && out.length < 2) out.push(pool.splice(Math.min(pool.length - 1, Math.floor(random() * pool.length)), 1)[0]!);
  return out;
}
