/**
 * G1 猜拳: her character through the whole game. How she picks (fair, letting the user win, playing against a known
 * habit), how she reacts (proud, sore, secretly pleased, a pretend cheat), when she may invite the user, and when she
 * puts a game off. Her words are no longer written in advance: shared/rps-voice.ts decides at each
 * moment whether she says something and asks for it then. Pure; randomness is passed in.
 */
import type { FatiguePhase } from './fatigue';
import type { HerLifeActivity } from './her-life';
import type { MoodLabel, MoodParameters, MoodValues } from './mood';
import { RPS_HANDS, rpsLoserAgainst, rpsWinnerAgainst, type RpsFace, type RpsHand, type RpsIntent, type RpsOutcome } from './rps';
import { rpsExpectedHand, type RpsHabits } from './rps-memory';
import type { RoutedModule } from './module-router/interface';

const clamp = (value: number, low: number, high: number) => Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : low;
const unit = (random: () => number) => clamp(random(), 0, 0.999999);

// ---------------------------------------------------------------- style

/** How often she lets the user win / pretends to cheat, 0 never … 3 often (the card's weights shape it further). */
export interface RpsStyle { soft: number; tease: number }
export const RPS_DEFAULT_STYLE: Readonly<RpsStyle> = Object.freeze({ soft: 1, tease: 1 });
/** The card's template and intensity (MoodParameters). */
export type RpsCharacter = Pick<MoodParameters, 'weights' | 'intensity'>;
export interface RpsResolvedStyle {
  /** Per round, while she has not let the user win yet this match. */
  softChance: number;
  /** Per lost round, while she has not pretended to cheat yet this match. */
  teaseChance: number;
  /** First round only, when the user has a habit. */
  readChance: number;
}
/** Hard caps (the tests run thousands of matches against them). Once per match each. */
export const RPS_LIMITS = Object.freeze({ softChance: 0.3, teaseChance: 0.45, readChance: 0.35, softPerMatch: 1, teasePerMatch: 1, readPerMatch: 1 });
const SOFT = [0, 0.1, 0.18, 0.26], TEASE = [0, 0.15, 0.28, 0.4];

export function readRpsStyle(value: unknown): RpsStyle | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 2 || ![v.soft, v.tease].every(n => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 3)) return null;
  return { soft: v.soft as number, tease: v.tease as number };
}

export function resolveRpsStyle(style: Readonly<RpsStyle> | null | undefined, character: RpsCharacter): RpsResolvedStyle {
  const s = style ?? RPS_DEFAULT_STYLE, w = character.weights;
  const level = (table: number[], value: number) => table[clamp(Math.round(value), 0, 3)];
  const playful = clamp(w.playful, 0, 3), close = clamp(w.close, 0, 3);
  // A close card lets the user win a little more often; a playful one teases and reads more.
  const softChance = Math.min(RPS_LIMITS.softChance, level(SOFT, s.soft) * clamp(0.55 + 0.45 * close, 0.5, 1.2));
  const teaseChance = Math.min(RPS_LIMITS.teaseChance, level(TEASE, s.tease) * clamp(0.5 + 0.5 * playful, 0.4, 1.2) * clamp(character.intensity.playful / 50, 0.5, 1.2));
  const readChance = Math.min(RPS_LIMITS.readChance, (s.soft >= 2 ? 0.1 : 0.25) * clamp(0.6 + 0.4 * playful, 0.5, 1.3));
  return { softChance, teaseChance, readChance };
}

// ---------------------------------------------------------------- her pick (before any input)

export interface RpsPickInput {
  random: () => number;
  style: RpsResolvedStyle;
  /** Earlier matches only (null while the user profile does not allow recording). */
  habits: RpsHabits | null;
  round: number;
  softUsed: boolean;
  readUsed: boolean;
}
/**
 * Her hand for one round. It reads only her style, earlier matches and this match's earlier rounds; it is called
 * before the round accepts any input, so the user's hand cannot reach it. Always draws three numbers, so the
 * sequence of picks does not depend on which branch ran.
 */
export function chooseRpsHand(input: RpsPickInput): { hand: RpsHand; intent: RpsIntent } {
  const soft = unit(input.random), read = unit(input.random), fair = unit(input.random);
  const expected = rpsExpectedHand(input.habits, input.round);
  if (!input.softUsed && soft < input.style.softChance) return { hand: rpsLoserAgainst(expected), intent: 'soft' };
  if (!input.readUsed && input.round === 1 && input.habits?.habit && read < input.style.readChance) return { hand: rpsWinnerAgainst(input.habits.habit.hand), intent: 'read' };
  return { hand: RPS_HANDS[Math.floor(fair * 3)], intent: 'fair' };
}

// ---------------------------------------------------------------- her reaction

/** How she takes a revealed round (her face; her words, if any, come from shared/rps-voice.ts at that moment). */
export const RPS_REACTION_KINDS = ['win-round', 'lose-round', 'draw', 'win-game', 'lose-game', 'soft-lose', 'tease', 'habit'] as const;
export type RpsReactionKind = typeof RPS_REACTION_KINDS[number];
/** A match's moments: the reactions plus the rest of the match (none has a fixed line any more). */
export type RpsCueKind = RpsReactionKind | 'ready' | 'next' | 'wait' | 'bye' | 'timeout';
export interface RpsReaction { kind: RpsReactionKind; face: RpsFace; tease: RpsHand | null }

export function chooseRpsReaction(input: { outcome: RpsOutcome; intent: RpsIntent; userHand: RpsHand; final: 'her' | 'user' | null;
  teaseUsed: boolean; style: RpsResolvedStyle; random: () => number }): RpsReaction {
  const roll = unit(input.random);
  if (input.outcome === 'draw') return { kind: 'draw', face: 'surprised', tease: null };
  if (input.outcome === 'her') {
    // She read the habit and it worked: "我就知道你会出石头".
    if (input.intent === 'read') return { kind: 'habit', face: 'smug', tease: null };
    return { kind: input.final === 'her' ? 'win-game' : 'win-round', face: 'smug', tease: null };
  }
  // She lost. Letting the user win shows only as a small, pleased face (偷偷让着), never in words that give it away.
  if (input.intent === 'soft') return { kind: 'soft-lose', face: 'gentle', tease: null };
  if (!input.teaseUsed && roll < input.style.teaseChance) return { kind: 'tease', face: 'tease', tease: rpsWinnerAgainst(input.userHand) };
  return rpsPlainLoss(input.final);
}
/** A plain loss: also what a pretend cheat becomes when she will not say it this time (it needs her words). */
export function rpsPlainLoss(final: 'her' | 'user' | null): RpsReaction {
  return { kind: final === 'user' ? 'lose-game' : 'lose-round', face: 'pout', tease: null };
}

// ---------------------------------------------------------------- when she invites

/** How much her current mood leans toward play (1 = as usual). Labels now; the raw channels after Codex T-106 (handbook/codex-research.md). */
const MOOD_PLAY: Readonly<Partial<Record<MoodLabel, number>>> = Object.freeze({ excited: 1.35, happy: 1.3, content: 1.15, close: 1.1, calm: 1, relieved: 1,
  longing: 0.9, 'tense-expectation': 0.6, concerned: 0.3, disappointed: 0.3, upset: 0.2, sad: 0.2 });
export function rpsPlayfulness(snapshot: { primary: MoodLabel | string; values?: Partial<MoodValues> | null },
  parameters: Pick<MoodParameters, 'weights' | 'intensity' | 'baseline'>): number {
  const label = MOOD_PLAY[snapshot.primary as MoodLabel] ?? 1;
  // Pleasure (D) above its resting value adds a little, below takes a little: a first step toward channel-driven behaviour.
  const d = Number(snapshot.values?.D), base = Number(parameters.baseline?.D);
  const lift = Number.isFinite(d) && Number.isFinite(base) ? clamp((d - base) / 50, -0.3, 0.3) : 0;
  return clamp(parameters.weights.playful, 0, 3) * Math.sqrt(clamp(parameters.intensity.playful / 50, 0, 2)) * label * (1 + lift);
}
export const RPS_INVITE_RULES = Object.freeze({ playfulness: 0.85, gapMs: 2 * 3_600_000, afterGameMs: 3_600_000, perDay: 2 });
export interface RpsInviteInput {
  now: number;
  /** Today's local date key. */
  today: string;
  playfulness: number;
  /** Night, drowsy or asleep (the inner loop's quiet rules). */
  quiet: boolean;
  herLife: HerLifeActivity | null | undefined;
  gameActive: boolean;
  /** Invitation times (ms) and their local dates. */
  invites: readonly { at: number; date: string }[];
  lastGameAt: number | null;
  /**
   * I-010 互动余额: the user's interactions since her last invitation and since the last
   * game, and how many she waits for (by her card). Given, they replace the fixed 2 hours, 1 hour after a game and 2 a day; how often
   * overall is the budget's business at the opening choice. Absent: the old fixed rules.
   */
  interactions?: { sinceInvite: number | null; sinceGame: number | null; needed: number };
}
export type RpsInviteVerdict = 'ok' | 'quiet' | 'busy' | 'mood' | 'active' | 'gap' | 'after-game' | 'day';
/** Whether the inner loop may offer "邀请玩猜拳" on this speech opportunity. Boredom is already part of the opportunity. */
export function rpsInviteVerdict(input: RpsInviteInput): RpsInviteVerdict {
  if (input.gameActive) return 'active';
  if (input.quiet) return 'quiet';
  if (input.herLife === 'thinking' || input.herLife === 'drowsy') return 'busy';
  if (!(input.playfulness >= RPS_INVITE_RULES.playfulness)) return 'mood';
  const counted = input.interactions;
  if (counted) {
    const needed = Number.isFinite(counted.needed) ? Math.max(0, counted.needed) : 0;
    if (input.lastGameAt !== null && counted.sinceGame !== null && counted.sinceGame < needed) return 'after-game';
    if (input.invites.length && counted.sinceInvite !== null && counted.sinceInvite < needed) return 'gap';
    return 'ok';
  }
  if (input.lastGameAt !== null && input.now - input.lastGameAt >= 0 && input.now - input.lastGameAt < RPS_INVITE_RULES.afterGameMs) return 'after-game';
  if (input.invites.some(invite => input.now - invite.at >= 0 && input.now - invite.at < RPS_INVITE_RULES.gapMs)) return 'gap';
  if (input.invites.filter(invite => invite.date === input.today).length >= RPS_INVITE_RULES.perDay) return 'day';
  return 'ok';
}

// ---------------------------------------------------------------- the user asks in chat

const GAME_WORDS = '(?:猜拳|猜个拳|划拳|石头剪刀布|剪刀石头布|石头剪子布)';
/**
 * A request form only, so a story ("我今天和朋友玩猜拳输了") or a refusal ("不想玩猜拳") is not one:
 * [我们/你] [要不要/想不想/再…] [和我/陪我/一起] [来/玩/比] [一局/两把/一会儿] GAME [吗/吧/好不好/来/啦/一下].
 * 2026-11-04: the user's "来玩一把猜拳来" was missed (a trailing 来), so she only pretended to play in words; spoken
 * endings (来、啦、咯、哦、一下) and counts like 两把、几局、一会儿 now count, at most two endings.
 */
const REQUEST = new RegExp(`^(?:(?:那|好|嘿|喂|诶|哎)[，,]?)?(?:我们|咱们|你|我)?(?:要不要|想不想|玩不玩|来不来|可以|能不能|想|要|再|快)?(?:和我|跟我|陪我|和你|跟你|一起)?`
  + `(?:来来|来玩|再玩|再来|来|玩|比|划|比划)?(?:一?[局把盘次场轮下]|[两几三][局把盘次场轮]|一?会儿?)?(?:个)?${GAME_WORDS}`
  + `(?:吗|么|不|呀|吧|呗|嘛|来|啦|咯|喽|哦|噢|好不好|好吗|怎么样|如何|一下|一会儿?|一把|一局){0,2}$`, 'u');
const REQUEST_EN = /^(?:(?:let'?s|wanna|want to|do you want to|shall we|can we|come on)\s+)?(?:play\s+)?(?:a\s+(?:round|game)\s+of\s+)?rock[\s,-]*paper[\s,-]*scissors(?:\s+with me)?$/iu;
/** The user's literal chat text asks her to play. Narrow on purpose: a missed request is only a normal chat reply. */
export function scanRpsRequest(text: unknown): boolean {
  if (typeof text !== 'string' || text.length > 60) return false;
  const value = text.normalize('NFKC').trim().replace(/[\s~～…。.!！?？,，]+$/gu, '').replace(/^[\s,，]+/gu, '');
  const compact = value.replace(/\s+/gu, '').replace(/[，,]/gu, '');
  return REQUEST.test(compact) || REQUEST_EN.test(value);
}

/** "要不要 / 来不来 / 玩不玩" are questions, not refusals: taken out before looking for one. */
const ASKING = /要不要|想不想|玩不玩|来不来|好不好|行不行|可不可以|能不能|会不会/gu;
/** A refusal word, not followed by some other object ("别玩手机了" is not about the game). */
const REFUSAL = new RegExp('(?:不想|不要|不用|不|别|懒得|没空|没心情|没兴趣)再?(?:玩|来|比划|划|猜)(?=$|[了啦吧啊呀嘛哦喔，,。.!！?？~～\\s]|猜拳|划拳|石头|剪刀|剪子|这个|那个|游戏|一?[把局盘])'
  + '|算了|下次(?:吧|再)|改天|以后再|不感兴趣|玩够了|玩腻了|不来了', 'u');
/**
 * The user's literal text turns a game down ("别玩了""不想玩猜拳""改天吧"). I-023: when the local words and the small
 * model disagree, a refusal recognised here wins (no game opens); anything else follows the small model.
 */
export function scanRpsRefusal(text: unknown): boolean {
  if (typeof text !== 'string' || !text.trim() || text.length > 400) return false;
  return REFUSAL.test(text.normalize('NFKC').replace(/\s+/gu, '').replace(ASKING, '问'));
}

/**
 * I-023 调度台上猜拳的登记（shared/module-router/modules.ts 收进清单）：haiku 从这几句知道猜拳管什么、什么话算叫它。
 * 本机规则（scanRpsRequest、scanRpsRefusal）认得出时不问 haiku；粗筛 hints 宽一点，宁可多问几次，也不漏"剪子包袱锤"这类说法。
 */
export const RPS_ROUTE: RoutedModule = Object.freeze<RoutedModule>({
  id: 'rps',
  name: '猜拳',
  handles: '和用户玩一局猜拳（石头剪刀布，三局两胜）：角色回完这句话后，应用在她身边浮出石头、剪刀、布三个按钮，由用户点着出拳。',
  calledWhen: '用户这条消息是在邀请或要求她现在就和自己玩猜拳，怎么说都算，比如"来一把石头剪刀布""剪子包袱锤！""我们比划比划，输的请喝奶茶""猜丁壳来不来""用猜拳决定谁洗碗"。',
  notCalled: '讲以前玩过的事、问规则或问她会不会、说不想玩或不玩了、只是提到石头、剪刀或布（比如"踢到石头了""剪刀找不到了"）、邀请她玩别的游戏。',
  hints: /猜拳|猜个拳|划拳|猜丁壳|丁壳|石头|剪刀|剪子|包袱|锤|拳|布|出手|比划|手势|[玩来比]一?[把局盘轮场]|游戏|胜负|一决高下|rock|paper|scissors|\brps\b|janken|じゃんけん|가위바위보/iu,
  local: text => scanRpsRequest(text) ? 'called' : scanRpsRefusal(text) ? 'refused' : null,
});

export type RpsAnswer = 'accept' | 'sleepy' | 'busy';
const SLEEPY: readonly (FatiguePhase | null | undefined)[] = ['drowsy', 'falling-asleep', 'asleep', 'micro-awake'];
/**
 * She answers the user's request: plays, or puts it off by her character (drowsy, or absorbed in her own thing).
 * A playful card plays through some sleepiness; a cautious one finishes her own thought first.
 */
export function rpsAnswer(input: { fatigue: FatiguePhase | null | undefined; herLife: HerLifeActivity | null | undefined;
  weights: MoodParameters['weights']; random: () => number }): RpsAnswer {
  const roll = unit(input.random), w = input.weights;
  const playful = clamp(w.playful, 0, 3), cautious = clamp(w.cautious, 0, 3), comfortable = clamp(w.comfortable, 0, 3);
  if (SLEEPY.includes(input.fatigue)) return roll < clamp(0.8 - 0.25 * (playful - 1) + 0.1 * (comfortable - 1), 0.5, 0.95) ? 'sleepy' : 'accept';
  if (input.fatigue === 'light-drowsy' && roll < clamp(0.2 - 0.1 * (playful - 1), 0.05, 0.4)) return 'sleepy';
  const busy = input.herLife === 'thinking' ? clamp(0.45 * cautious - 0.15 * (playful - 1), 0.1, 0.7)
    : input.herLife === 'humming' ? 0.15 : input.herLife === 'daydream' ? 0.05 : 0;
  return roll < busy ? 'busy' : 'accept';
}

/**
 * This one turn's private context (appended after the composed persona, like her-life's line). It says what is going on,
 * not what to do (draft-leak record 2026-11-03: a list of "简短地答应 / 不要替你们出拳 / 不要宣布结果" came back as her
 * visible notes when she answered without thinking first, and "由你来喊" made her call the count herself mid-session).
 */
export function rpsChatContext(answer: RpsAnswer, herLifeChat?: string | null): string {
  if (answer === 'accept')
    return '【猜拳】用户想和你玩猜拳，你正好也想玩。你这句话说完后，你身边会出现石头、剪刀、布三个按钮，口令、出拳和输赢都在那之后，三局两胜。';
  if (answer === 'sleepy')
    return '【猜拳】用户想和你玩猜拳，可你这会儿困得不行，想改天再玩。这一轮不会开始游戏。';
  return `【猜拳】用户想和你玩猜拳，可你正专心在做自己的事${herLifeChat ? `（${herLifeChat}）` : ''}，想等一会儿或下次再玩。这一轮不会开始游戏。`;
}
