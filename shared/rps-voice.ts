/**
 * G1 猜拳: what she says during a game, decided at the moment.
 *
 * - Whether she says anything at a moment: rpsVoiceChance, from her card's leanings, her mood and how big the moment is,
 *   pressed down smoothly by how much she has already said (a soft cap, I-013; strong moments can go over it). It is
 *   one function on purpose: I-010's interaction budget replaces it whole once the user confirms that plan.
 * - What she says: one short line from the small model (the inner loop's tier), asked as soon as the round is decided
 *   (both hands are in, before the reveal), answered as strict JSON so a working note can never reach the bubble.
 * - When the model cannot be asked: a line she herself said in an earlier game at the same kind of moment (never a
 *   table written in advance); none yet: she stays quiet and her face says it.
 * Pure: no timer, no I/O, no clock.
 */
import type { FatiguePhase } from './fatigue';
import type { MoodLabel, MoodParameters } from './mood';
import { MOOD_LABELS } from './mood-runtime';
import { RPS_HAND_WORDS, type RpsHand, type RpsIntent, type RpsOutcome } from './rps';
import type { RpsReactionKind } from './rps-personality';
import type { RpsRoundRecord } from './rps-memory';

const clamp = (value: number, low: number, high: number) => Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : low;

// ---------------------------------------------------------------- the moment

/** round: a round was decided and more follow; final: the round that decides (or ends) the match; the rest end it early. */
export type RpsMomentKind = 'round' | 'final' | 'timeout' | 'quit' | 'decline';
export interface RpsMoment {
  kind: RpsMomentKind;
  /** round / final: the round just decided (she knows her intent; the user never hears it). */
  round?: { her: RpsHand; user: RpsHand; outcome: RpsOutcome; intent: RpsIntent; reaction: RpsReactionKind; tease: RpsHand | null };
  /** Revealed rounds before this one, oldest first. */
  earlier: readonly RpsRoundRecord[];
  /** The score with this round counted. */
  score: { her: number; user: number };
  /** final: who took the match ('none': the throw limit came first). */
  result?: 'her' | 'user' | 'none';
  /** habit: the hand she expected from the user (shared/rps-memory.ts). */
  habit?: RpsHand | null;
}

/**
 * Lines she said before, kept per kind of moment for the days the model cannot be asked. Only lines that name no hand
 * are kept, so one fits any round of that kind. Pretend cheats need the hand on screen: never kept.
 */
export type RpsMomentClass = 'round-her' | 'round-user' | 'round-draw' | 'final-her' | 'final-user' | 'timeout' | 'quit' | 'decline';
export const RPS_MOMENT_CLASSES: readonly RpsMomentClass[] = ['round-her', 'round-user', 'round-draw', 'final-her', 'final-user', 'timeout', 'quit', 'decline'];
export function rpsMomentClass(moment: RpsMoment): RpsMomentClass | null {
  if (moment.kind === 'timeout' || moment.kind === 'quit' || moment.kind === 'decline') return moment.kind;
  const round = moment.round;
  if (!round || round.reaction === 'tease') return null;
  if (moment.kind === 'final') return moment.result === 'her' ? 'final-her' : moment.result === 'user' ? 'final-user' : null;
  return round.outcome === 'her' ? 'round-her' : round.outcome === 'user' ? 'round-user' : 'round-draw';
}
const HAND_WORD = /石头|剪刀|布/u;
/** A line worth keeping for another round of the same kind (it names no hand). */
export const rpsReusableLine = (text: string): boolean => !HAND_WORD.test(text);

// ---------------------------------------------------------------- whether she speaks (I-010: the budget's room replaces "lines today")

export interface RpsVoiceInput {
  moment: RpsMoment;
  parameters: Pick<MoodParameters, 'weights' | 'intensity'>;
  /** Her mood label now. */
  mood: MoodLabel | string;
  fatigue: FatiguePhase | null | undefined;
  /** Lines she already said in this match (live or remembered). */
  saidThisMatch: number;
  /** She said something at the previous round. */
  spokeLastRound: boolean;
  /** Lines she said in games today (only pressed on without the interaction budget). */
  saidToday: number;
  /**
   * I-010 互动余额: the budget's room for a game line now (0..1). Given, it replaces the "lines today" press; the in-match press (this match's lines, right after she spoke) stays. Absent or null: the old press.
   */
  room?: number | null;
}

/** How much a moment invites words, before her character and the soft cap (0–1). */
export function rpsMomentWeight(moment: RpsMoment): number {
  switch (moment.kind) {
    case 'decline': return 0.7;
    case 'quit': return 0.5;
    case 'timeout': return 0.5;
    case 'final': return moment.round?.reaction === 'tease' ? 1 : 0.9;
    default: break;
  }
  const round = moment.round;
  if (!round) return 0;
  if (round.reaction === 'tease') return 1; // A pretend cheat is nothing without her words.
  if (round.reaction === 'habit') return 0.8;
  if (round.outcome === 'draw') return moment.earlier.at(-1)?.outcome === 'draw' ? 0.45 : 0.15;
  // A comeback: whoever took this round was behind before it.
  const her = moment.score.her - (round.outcome === 'her' ? 1 : 0), user = moment.score.user - (round.outcome === 'user' ? 1 : 0);
  const comeback = (round.outcome === 'her' && her < user) || (round.outcome === 'user' && user < her);
  return (round.reaction === 'soft-lose' ? 0.35 : round.outcome === 'her' ? 0.28 : 0.3) + (comeback ? 0.2 : 0);
}

/** How readily her mood puts things into words (1 = as usual). Labels for now; the raw channels after Codex T-106. */
const MOOD_TALK: Readonly<Partial<Record<MoodLabel, number>>> = Object.freeze({ excited: 1.25, happy: 1.15, close: 1.1, content: 1.05, relieved: 1, calm: 0.9,
  longing: 0.95, 'tense-expectation': 0.9, upset: 0.8, disappointed: 0.75, concerned: 0.75, sad: 0.6 });
const SLEEPY: readonly (FatiguePhase | null | undefined)[] = ['drowsy', 'falling-asleep', 'asleep', 'micro-awake'];
/** A moment at least this strong can go over the soft cap (strong feelings do, I-013 / how-we-work 13). */
const STRONG = 0.85;

/**
 * The chance she says something now (0–0.97). Her want = the moment × her leanings (playful and close talk more, cautious
 * less) × how expressive her words are × her mood × tiredness. The soft cap presses it down smoothly the more she has
 * said in this match (and right after she spoke) and, with the interaction budget wired, by its room (I-010; without it, by the
 * lines she said today); a strong moment keeps at least 60 % of its want.
 */
export function rpsVoiceChance(input: RpsVoiceInput): number {
  const weight = rpsMomentWeight(input.moment);
  if (!(weight > 0)) return 0;
  const w = input.parameters.weights;
  const lean = clamp(0.75 + 0.3 * (clamp(w.playful, 0, 3) - 1) + 0.15 * (clamp(w.close, 0, 3) - 1) - 0.25 * (clamp(w.cautious, 0, 3) - 1), 0.35, 1.4);
  const words = Math.sqrt(clamp(input.parameters.intensity.text / 50, 0.4, 1.8));
  const mood = MOOD_TALK[input.mood as MoodLabel] ?? 1;
  const tired = SLEEPY.includes(input.fatigue) ? 0.6 : input.fatigue === 'light-drowsy' ? 0.85 : 1;
  const want = clamp(weight * lean * words * mood * tired * 1.1, 0, 0.97);
  const room = typeof input.room === 'number' && Number.isFinite(input.room) ? clamp(input.room, 0, 1) : null;
  const day = room !== null ? room : 1 / (1 + Math.max(0, input.saidToday) / 30);
  const cap = (1 / (1 + 0.8 * Math.max(0, input.saidThisMatch))) * (input.spokeLastRound ? 0.5 : 1) * day;
  return clamp(want * (weight >= STRONG ? Math.max(0.6, cap) : cap), 0, 0.97);
}

/**
 * A protective ceiling on the small model's calls for game lines, far above normal play (a match asks about one or two
 * times): it only stops a fault from running up the user's allowance. Past it she uses her remembered lines.
 */
export const RPS_VOICE_SAFETY = Object.freeze({ callsPerDay: 60 });
/** The model's line must arrive this soon after the moment is shown, or it is dropped (she has moved on). */
export const RPS_VOICE_LATE_MS = 4_500;
/** At most this long a line may hold the game while the window reads it (a lost "said" never stalls it). */
export function rpsSayHoldMs(text: string): number {
  return Math.round(clamp(2_500 + 320 * Array.from(text).length, 2_500, 12_000));
}
/** Without the voice, the bubble alone: time to read it. */
export function rpsReadMs(text: string): number {
  return Math.round(clamp(900 + 140 * Array.from(text).length, 1_200, 4_500));
}

// ---------------------------------------------------------------- what she says

export const RPS_VOICE_SYSTEM_PROMPT =
  '你在一个桌面陪伴应用里，替用户消息中描述的角色在猜拳游戏的这一刻说一句话（或者不说）。你没有任何工具，也不能读写文件或执行命令。只输出用户消息要求的那一个 JSON 对象，不输出任何其他文字、解释或代码块；不要提及自己是 Claude 或编程助手。';
export const RPS_VOICE_MAX = 28;

const ORDINAL = '一二三四五六七';
const outcomeWords = (outcome: RpsOutcome) => outcome === 'draw' ? '平局' : outcome === 'her' ? '你赢' : '用户赢';
function roundWords(round: { her: RpsHand; user: RpsHand; outcome: RpsOutcome }, index: number): string {
  return `第${ORDINAL[index] ?? index + 1}次你出${RPS_HAND_WORDS[round.her]}、用户出${RPS_HAND_WORDS[round.user]}，${outcomeWords(round.outcome)}`;
}

/** What just happened, in plain words (no instructions). */
export function rpsMomentWords(moment: RpsMoment): string {
  const lines: string[] = [];
  if (moment.earlier.length) lines.push(`前面：${moment.earlier.map(roundWords).join('；')}。`);
  const round = moment.round;
  if (round) {
    const now = `刚刚揭晓：${roundWords(round, moment.earlier.length)}。`;
    lines.push(now);
    if (round.outcome === 'draw' && moment.earlier.at(-1)?.outcome === 'draw') lines.push('已经连着平了两次。');
    if (round.reaction === 'soft-lose') lines.push('这一手其实是你故意让着用户的，你不打算说破。');
    if (round.reaction === 'habit' && moment.habit) lines.push(`你早就看出用户爱出${RPS_HAND_WORDS[moment.habit]}，这次被你猜中了。`);
    if (round.reaction === 'tease' && round.tease)
      lines.push(`你输了这一局，但想逗逗用户：先一本正经地说自己其实出的是${RPS_HAND_WORDS[round.tease]}，紧接着笑着承认是骗人的、用户赢了，两句连成一句话说。`);
  }
  if (moment.kind === 'final')
    lines.push(moment.result === 'her' ? `这一场你赢了（${moment.score.her} 比 ${moment.score.user}）。` : moment.result === 'user'
      ? `这一场用户赢了（${moment.score.user} 比 ${moment.score.her}）。` : '出了好多次还没分出胜负，这一场就到这里。');
  else if (round) lines.push(`现在比分：你 ${moment.score.her}，用户 ${moment.score.user}，三局两胜，还没比完。`);
  if (moment.kind === 'timeout') lines.push('你喊完"石头剪刀布"，用户好一会儿都没出拳，这一场就先到这里。');
  if (moment.kind === 'quit') lines.push('用户点了"不玩了"，这一场到这里。');
  if (moment.kind === 'decline') lines.push('你刚才邀请用户玩猜拳，用户说下次吧。');
  return lines.join('\n');
}

export interface RpsVoicePromptInput {
  /** compileCharacterPersona(card). */
  persona: string;
  /** Her language habits for this card, if any (personalize-language context). */
  language?: string;
  mood: MoodLabel | string;
  fatigue: FatiguePhase | null | undefined;
  moment: RpsMoment;
}
/** The one short call for a moment: who she is, how she feels, what just happened, and the answer's shape. */
export function rpsVoicePrompt(input: RpsVoicePromptInput): string {
  const feeling = MOOD_LABELS[input.mood as MoodLabel] ?? '平静';
  const tired = SLEEPY.includes(input.fatigue) ? '，有点困' : input.fatigue === 'light-drowsy' ? '，有一点点困' : '';
  const playing = input.moment.kind === 'decline' ? '你正和用户待在桌面上' : '你正和用户在桌面上玩猜拳（三局两胜）';
  return [
    input.persona.trim(),
    (input.language ?? '').trim(),
    `【这一刻】这不是用户在打字和你说话：${playing}，你此刻的心情：${feeling}${tired}。\n${rpsMomentWords(input.moment)}`,
    `你会对用户说什么？像平时和用户说话那样，用你自己的口吻，一句很短的话（${RPS_VOICE_MAX} 字以内），称呼用户用"你"；`
      + '可以得意、嘴硬、不服气或逗用户，忠于你的性格，但不让用户内疚，也不催用户一直玩下去。也可以什么都不说。\n'
      + '只输出一个 JSON 对象：{"text":"你要说的话"}；不想说就输出 {"text":""}。text 只有一行，不用括号、动作描写或表情符号说明。',
  ].filter(Boolean).join('\n\n');
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/u;
const PROTOCOL = /[<>{}\[\]【】`\\|（）()]|^(?:用户|角色|系统|助手|旁白|user|assistant|system|human)\s*[:：]/iu;
const TECHNICAL = /claude|anthropic|\bapi\b|https?:|www\.|token|server|json|服务器|错误码|报错|命令行|终端|\bcli\b|模型|程序/iu;
const graphemes = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('zh', { granularity: 'grapheme' }) : null;
function visible(text: string): number {
  if (!graphemes) return Array.from(text).length;
  let count = 0; for (const _ of graphemes.segment(text)) count++;
  return count;
}

/**
 * Her line from the model's answer: the text ('' = she says nothing this time), or null when the answer is not exactly
 * the asked JSON with one plain line. Talk about "用户" in the third person is a working note, not her words: null.
 */
export function parseRpsVoice(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2000) return null;
  let data: unknown;
  try { data = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 1) return null;
  const text = (data as Record<string, unknown>).text;
  if (typeof text !== 'string') return null;
  const line = text.trim();
  if (!line) return '';
  if (visible(line) > RPS_VOICE_MAX + 4 || CONTROL.test(line) || PROTOCOL.test(line) || TECHNICAL.test(line) || /用户/u.test(line)) return null;
  return line;
}
