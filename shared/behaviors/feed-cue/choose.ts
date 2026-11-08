/**
 * #32 的真实现：每一份点心，她来挑张嘴前那一声、吃到后那一声（各五种声音，或者不出声），和这一份怎么吃
 * （接口见 interface.ts，旋钮见 knobs.ts）。纯本地、零额度：语气词是从固定的几种里挑的，不让模型写，不调用任何模型。
 * 只在内存里记最近几份。
 *
 * 写死的（不是旋钮）：
 *  - 上一次刚出过的那一声，这一次不出（张嘴前、吃到后各记各的）；只有一种合适的时候才允许和上次一样。
 *  - "好吃～"这类一句话（knobs 里 word: true）在认图这一口之后会说一句时不出现：不和她抢话。
 *  - 安全线 feedCuePlanSafe（范围在 perform.ts 的 FEED_CUE_LIMITS）：张嘴、嚼只会比原来慢、比原来小，不会更快更大；摇头最多约 3 度、
 *    1.5 秒以内；声音只从对的那一组里来。
 *    抽出来的不过这一关，这一份就按原来的（"啊～""嗯～"、照常吃）。
 */
import { sheChooses, type SheChoosesCandidate, type SheChoosesReason, type SheChose } from '../../she-chooses';
import { MOOD_LABELS } from '../../mood-runtime';
import { MOOD_TENDENCY_MIN, tendencyNow } from '../../mood-tendency';
import type { MoodLabel, MoodParameters, MoodSnapshot, MoodTendency } from '../../mood';
import type { FatiguePhase } from '../../fatigue';
import { FEED_EAT_SOUND_IDS, FEED_OPEN_SOUND_IDS, type FeedEatSoundId, type FeedOpenSoundId } from '../../feed-cue';
import { freshnessLeft, tireFactor, tiredFreshness } from '../touch-feed-effect/choose';
import { TOUCH_FEED_EFFECT_KNOBS, type TouchFeedLandingId } from '../touch-feed-effect/knobs';
import { FEED_CUE_KNOBS, type FeedCueKnobs, type FeedCueMoment, type FeedQuietKnob, type FeedSoundKnob, type FeedTaste } from './knobs';
import type { FeedCueHost, FeedCueNow, FeedCueView, FeedCueWhy, FeedEatPlan, FeedOpenPlan } from './interface';
import { readFeedCueView } from './perform';

export { FEED_CUE_LIMITS } from './perform';

export type FeedOpenChoice = FeedOpenSoundId | 'quiet';
export type FeedEatChoice = FeedEatSoundId | 'quiet';
export const FEED_OPEN_CHOICES: readonly FeedOpenChoice[] = Object.freeze([...FEED_OPEN_SOUND_IDS, 'quiet']);
export const FEED_EAT_CHOICES: readonly FeedEatChoice[] = Object.freeze([...FEED_EAT_SOUND_IDS, 'quiet']);

const TENDENCIES: readonly MoodTendency[] = ['playful', 'close', 'comfortable', 'cautious'];
/** "这会儿……"（和 #11、#21 同样的说法）。 */
const NOW_WORDS: Readonly<Record<MoodTendency | 'wistful', string>> = {
  playful: '这会儿有点调皮', close: '这会儿想黏着你', comfortable: '这会儿很放松', cautious: '这会儿有点拘谨', wistful: '还在想念的余韵里',
};
/** 角色卡性格：高于一般 / 低于一般（和 #11、#21 同样的说法）。 */
const PERSONALITY_WORDS: Readonly<Record<MoodTendency, readonly [string, string]>> = {
  playful: ['性格：爱玩', '性格：不太爱玩'], close: ['性格：黏人', '性格：不太黏人'],
  comfortable: ['性格：随和', '性格：不太随和'], cautious: ['性格：谨慎', '性格：大胆'],
};
export const FEED_TASTE_WORDS: Readonly<Record<FeedTaste, string>> = {
  loved: '不久前认出过她爱吃的', disliked: '不久前喂过不太合她口味的', notFood: '不久前喂过不是吃的，这次有点怀疑',
};
export const FEED_LANDING_WORDS: Readonly<Record<TouchFeedLandingId, string>> = {
  full: '这一块吃得很香', usual: '这一块照常好吃', light: '这一块没什么胃口',
};
/** 认图会接着说一句时，"好吃～"这类话不出（写进"为什么"）。 */
export const FEED_LINE_FOLLOWS_WORDS = '认图会接着说一句，这一声只出声、不说话';
/** 前几份留几份（只在内存）。 */
const KEEP = 3;
/** 咬下去以后这么久，视图里不再给这一份的打算；开始了这么久还没咬，也不再给。 */
export const FEED_CUE_VIEW_AFTER_BITE_MS = 60_000;
export const FEED_CUE_VIEW_BEFORE_BITE_MS = 120_000;
/** "这会儿……"至少要这么强才算（各功能共用 shared/mood-tendency.ts 的同一个门槛）。 */
export const FEED_CUE_TENDENCY_MIN = MOOD_TENDENCY_MIN;

const finite = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const unit = (value: unknown): number => Math.min(1 - 1e-12, Math.max(0, finite(value, 0)));
const lerp = (range: readonly [number, number], t: number): number => finite(range[0], 1) + (finite(range[1], 1) - finite(range[0], 1)) * t;
const round2 = (value: number): number => Math.round(value * 100) / 100;
const percent = (value: number): number => Math.round(clamp(value, 0, 1) * 100);
const within = (value: unknown, [low, high]: readonly [number, number]): boolean => typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;

// ------------------------------------------------------------------------------------------------ "此刻"

/** MoodHost 交给"此刻"的原料。 */
export interface FeedCueNowInput {
  readonly snapshot: Pick<MoodSnapshot, 'primary' | 'companion'> & { readonly tendencies?: Partial<Record<MoodTendency, number>> };
  /** 角色卡性格（MoodParameters.weights）。 */
  readonly personality: Partial<Record<MoodTendency, number>> | null | undefined;
  readonly fatiguePhase: FatiguePhase | null | undefined;
  /** 卡上的"腻"和这一口之前已经攒下的点心剂数（心情模型的新鲜感记录，恢复到这一刻）。 */
  readonly freshness: { readonly card: Readonly<Pick<MoodParameters['freshness'], 'retention' | 'floor'>>; readonly taken: number };
  readonly taste: FeedTaste | null | undefined;
  readonly lineFollows: boolean;
}

/**
 * 吃腻了多少（0 不腻 … 1 腻到底）和新鲜感还剩多少：新鲜感是 #21 喂点心的"腻"同一个算法、同一个"腻得快慢"（卡上的随和），
 * 所以 #21 面板上写"新鲜感还剩 36%"的那一块，这里也是 36%。腻的程度量的是新鲜感掉了多少，用卡上的最低值做尺子
 * （默认卡：100% → 0，掉到卡上的最低 20% → 1）：随和的卡同样吃三块，新鲜感掉得少，就没那么腻；不随和的掉得多，更早腻到底。
 */
export function feedSatiety(card: Readonly<Pick<MoodParameters['freshness'], 'retention' | 'floor'>>, personality: Readonly<Record<MoodTendency, number>>, taken: number): { satiety: number; fresh: number } {
  const knob = TOUCH_FEED_EFFECT_KNOBS.food.tire;
  const tired = tiredFreshness({ ...card } as MoodParameters['freshness'], tireFactor(knob, personality).factor, knob.minFloor);
  const fresh = clamp(freshnessLeft(tired, Math.max(0, finite(taken, 0))), 0, 1);
  const floor = clamp(finite(card.floor, 1), 0, 1);
  const satiety = floor >= 1 ? 0 : clamp((1 - fresh) / (1 - floor), 0, 1);
  return { satiety, fresh };
}

/** 把主机手里的东西整理成"此刻"。 */
export function feedCueNow(input: FeedCueNowInput): FeedCueNow {
  const s = input.snapshot;
  const mood = (Object.hasOwn(MOOD_LABELS, s.primary) ? s.primary : 'calm') as MoodLabel;
  const tendency = tendencyNow(s, FEED_CUE_TENDENCY_MIN);
  const personality = Object.fromEntries(TENDENCIES.map(t => [t, clamp(finite(input.personality?.[t], 1), 0, 4)])) as Record<MoodTendency, number>;
  const moments: FeedCueMoment[] = [];
  if (input.fatiguePhase === 'light-drowsy') moments.push('tired');
  if (input.fatiguePhase === 'drowsy' || input.fatiguePhase === 'falling-asleep' || input.fatiguePhase === 'asleep' || input.fatiguePhase === 'micro-awake') moments.push('sleepy');
  const card = input.freshness?.card;
  const { satiety, fresh } = card && within(card.retention, [0, 1]) && within(card.floor, [0, 1])
    ? feedSatiety(card, personality, input.freshness.taken) : { satiety: 0, fresh: 1 };
  const taste = input.taste === 'loved' || input.taste === 'disliked' || input.taste === 'notFood' ? input.taste : null;
  return { mood, tendency, personality, moments, satiety, fresh, taste, lineFollows: input.lineFollows === true };
}

// ------------------------------------------------------------------------------------------------ the two sounds

type ChoiceKnob = FeedSoundKnob | FeedQuietKnob;
const labelOf = (knob: ChoiceKnob): string => 'text' in knob ? knob.text : knob.label;

/** 一种声音此刻的理由：心情、倾向、性格、累不累、吃腻了、不久前的口味、这一块受不受用、认图会不会说话。 */
function leanReasons(knob: ChoiceKnob, now: Readonly<FeedCueNow>, landing: TouchFeedLandingId | null, knobs: FeedCueKnobs): SheChoosesReason[] {
  const reasons: SheChoosesReason[] = [];
  const mood = knob.mood?.[now.mood];
  if (mood !== undefined) reasons.push({ text: `心情：${MOOD_LABELS[now.mood]}`, factor: mood });
  if (now.tendency) { const lean = knob.now?.[now.tendency]; if (lean !== undefined) reasons.push({ text: NOW_WORDS[now.tendency], factor: lean }); }
  for (const trait of TENDENCIES) {
    const strength = knob.personality?.[trait];
    if (!strength) continue;
    const value = now.personality[trait], factor = clamp(1 + strength * 2 * (value - 1), 0.2, 3);
    if (Math.abs(factor - 1) >= 0.05) reasons.push({ text: PERSONALITY_WORDS[trait][value > 1 ? 0 : 1], factor });
  }
  for (const moment of now.moments) {
    const factor = knob.moments?.[moment];
    if (factor !== undefined) reasons.push({ text: knobs.moments[moment].label, factor });
  }
  if (knob.full !== undefined && now.satiety > 0) {
    const factor = Math.max(0, 1 + (knob.full - 1) * now.satiety);
    if (Math.abs(factor - 1) >= 0.05) reasons.push({ text: `吃了好几块，有点腻了（新鲜感还剩 ${percent(now.fresh)}%）`, factor });
  }
  if (now.taste) { const factor = knob.taste?.[now.taste]; if (factor !== undefined) reasons.push({ text: FEED_TASTE_WORDS[now.taste], factor }); }
  if (landing) { const factor = knob.landing?.[landing]; if (factor !== undefined) reasons.push({ text: FEED_LANDING_WORDS[landing], factor }); }
  if ('word' in knob && knob.word && now.lineFollows) reasons.push({ text: FEED_LINE_FOLLOWS_WORDS, factor: 0 });
  return reasons;
}

const weightLine = (chose: SheChose<string> | null) => chose ? chose.weights.map(w => `${w.label} ${w.weight}`).join(' · ') : '';

interface SoundDraw<Id extends string> { readonly id: Id; readonly label: string; readonly why: readonly string[]; readonly weights: string }

/**
 * 从一组里挑一声：分量 = base × 此刻理由的倍数（shared/she-chooses.ts），上一次的那一声这次不出（只有它合适时除外），
 * 上上次的分量 × recentBefore。正好取 1 个随机数。
 */
function drawSound<Id extends string>(choices: readonly Id[], family: Readonly<Record<Id, ChoiceKnob>>, now: Readonly<FeedCueNow>,
  landing: TouchFeedLandingId | null, recent: readonly Id[], random: () => number, knobs: FeedCueKnobs, plain: Id): SoundDraw<Id> {
  const u = unit(random());
  const last = recent[0];
  const candidates = (exclude: boolean): SheChoosesCandidate<Id, FeedCueNow>[] => choices.map(id => ({
    id, label: labelOf(family[id]),
    weigh: moment => ({ base: exclude && id === last ? 0 : family[id].base, reasons: leanReasons(family[id], moment, landing, knobs) }),
  }));
  const pick = (exclude: boolean) => sheChooses({ candidates: candidates(exclude), now, random: () => u,
    recent: [last ?? ('' as Id), ...recent.slice(1)], recentFactors: [1, clamp(finite(knobs.recentBefore, 1), 0.05, 1)] });
  let chose = pick(true), repeated = false;
  if (!chose && last !== undefined) { chose = pick(false); repeated = !!chose; }
  if (!chose) return { id: plain, label: labelOf(family[plain]), why: ['几种的分量都是 0（看旋钮），按原来的'], weights: '' };
  const why = [...chose.why];
  if (repeated) why.push('只有这一种合适，和上次一样');
  else if (last !== undefined && last !== chose.id) why.push(`上次是${labelOf(family[last])}，这次不重复`);
  return { id: chose.id, label: chose.label, why, weights: weightLine(chose) };
}

// ------------------------------------------------------------------------------------------------ the manner

/** 吃腻了以后慢下来的程度（0 照旧 … 1 腻到底），按旋钮 manner.start。 */
export function feedSlowness(satiety: number, knobs: FeedCueKnobs = FEED_CUE_KNOBS): number {
  const start = clamp(finite(knobs.manner.start, 1), 0, 1);
  if (start >= 1) return 0;
  return clamp((finite(satiety, 0) - start) / (1 - start), 0, 1);
}

export interface FeedOpenDraw {
  readonly sound: SoundDraw<FeedOpenChoice>;
  readonly mouth: { readonly rate: number; readonly size: number };
  readonly shake: FeedOpenPlan['shake'];
  readonly slowness: number;
  readonly wary: boolean;
}

/**
 * 张嘴前：挑那一声，再定这一份的张嘴快慢、张多大、要不要摇头。每次正好取 6 个随机数，顺序固定
 * （声音、张嘴快慢、张多大、摇不摇、摇多大、摇多久），所以改一个旋钮只影响它管的那一处。
 */
export function drawFeedOpen(now: Readonly<FeedCueNow> | null, recent: readonly FeedOpenChoice[], random: () => number,
  knobs: FeedCueKnobs = FEED_CUE_KNOBS): FeedOpenDraw {
  const sound: SoundDraw<FeedOpenChoice> = now ? drawSound(FEED_OPEN_CHOICES, knobs.open, now, null, recent, random, knobs, 'ah')
    : (random(), { id: 'ah', label: labelOf(knobs.open.ah), why: ['没读到此刻的心情，按原来的'], weights: '' });
  const u = [random(), random(), random(), random(), random()].map(unit);
  const k = now ? feedSlowness(now.satiety, knobs) : 0, wary = now?.taste === 'notFood';
  const m = knobs.manner;
  const rate = (1 - k * (1 - lerp(m.open.rate, u[0]))) * (wary ? finite(m.wary.rate, 1) : 1);
  const size = (1 - k * (1 - lerp(m.open.size, u[1]))) * (wary ? finite(m.wary.size, 1) : 1);
  const moodLean = now ? finite(m.shake.mood[now.mood], 1) : 1;
  const chance = clamp(finite(m.shake.chance, 0) * k * moodLean, 0, 0.95);
  const shake = chance > 0 && u[2] < chance
    ? { amplitude: Math.round(lerp(m.shake.amplitude, u[3]) * 1000) / 1000, ms: Math.round(lerp(m.shake.ms, u[4])), swings: Math.round(clamp(finite(m.shake.swings, 2), 1, 3)) }
    : null;
  return { sound, mouth: { rate: round2(rate), size: round2(size) }, shake, slowness: k, wary };
}

export interface FeedEatDraw {
  readonly sound: SoundDraw<FeedEatChoice>;
  readonly chew: { readonly rate: number; readonly size: number };
}

/** 吃到后：挑那一声，再定嚼的快慢、幅度。每次正好取 3 个随机数（声音、嚼的快慢、嚼的幅度）。 */
export function drawFeedEat(now: Readonly<FeedCueNow> | null, landing: TouchFeedLandingId | null, recent: readonly FeedEatChoice[], random: () => number,
  knobs: FeedCueKnobs = FEED_CUE_KNOBS): FeedEatDraw {
  const sound: SoundDraw<FeedEatChoice> = now ? drawSound(FEED_EAT_CHOICES, knobs.eat, now, landing, recent, random, knobs, 'mm')
    : (random(), { id: 'mm', label: labelOf(knobs.eat.mm), why: ['没读到此刻的心情，按原来的'], weights: '' });
  const u = [random(), random()].map(unit);
  const k = now ? feedSlowness(now.satiety, knobs) : 0, m = knobs.manner;
  const why = [...sound.why];
  if (now?.lineFollows && !why.includes(FEED_LINE_FOLLOWS_WORDS)) why.push(FEED_LINE_FOLLOWS_WORDS);
  return { sound: { ...sound, why }, chew: { rate: round2(1 - k * (1 - lerp(m.chew.rate, u[0]))), size: round2(1 - k * (1 - lerp(m.chew.size, u[1]))) } };
}

// ------------------------------------------------------------------------------------------------ the safety line

/**
 * 安全线：张嘴、嚼不比原来快、不比原来大（倍数 ≤ 1），也不会慢到像卡住；摇头很轻、很短；声音只来自对的那一组；
 * `lineFollows` 时吃到后那一声不是一句话。tests/feed-cue.test.ts 拿随机的心情、性格、腻和旋钮去量。
 */
export function feedCuePlanSafe(plan: Readonly<FeedCueView> | null | undefined, lineFollows = false, knobs: FeedCueKnobs = FEED_CUE_KNOBS): boolean {
  const read = readFeedCueView(plan);
  if (!read) return false;
  return !(read.eat?.sound && lineFollows && knobs.eat[read.eat.sound].word);
}

// ------------------------------------------------------------------------------------------------ the host side

const PLAIN_OPEN = (id: string): FeedOpenPlan => ({ id, sound: 'ah', mouth: { rate: 1, size: 1 }, shake: null });
const PLAIN_EAT = (id: string): FeedEatPlan => ({ id, sound: 'mm', chew: { rate: 1, size: 1 } });

interface Session {
  sessionId: string;
  at: number;
  biteAt: number | null;
  now: FeedCueNow | null;
  open: FeedOpenPlan;
  openWhy: { sound: string; why: string[]; weights: string };
  manner: { label: string; why: string[] };
  slowness: number;
  eat?: FeedEatPlan;
  eatWhy?: { sound: string; why: string[]; weights: string };
}

function mannerNumbers(session: Session): string {
  const o = session.open, e = session.eat;
  if (o.mouth.rate === 1 && o.mouth.size === 1 && !o.shake && (!e || (e.chew.rate === 1 && e.chew.size === 1))) return '和原来一样';
  const parts = [`张嘴 ×${o.mouth.rate.toFixed(2)}`, `张开 ×${o.mouth.size.toFixed(2)}`];
  if (e) parts.push(`嚼 ×${e.chew.rate.toFixed(2)}`, `嚼的幅度 ×${e.chew.size.toFixed(2)}`);
  if (o.shake) parts.push('轻轻摇了下头');
  return parts.join(' · ');
}

/** 真实现（接口见 interface.ts FeedCueHost）。 */
export class FeedCueDirector implements FeedCueHost {
  private readonly sessions = new Map<string, Session>();
  private readonly history = new Map<string, { open: FeedOpenChoice[]; eat: FeedEatChoice[] }>();
  private readonly log: (FeedCueWhy & { characterId: string })[] = [];
  private readonly knobs: FeedCueKnobs;
  private readonly random: () => number;

  constructor(options: { knobs?: FeedCueKnobs; random?: () => number } = {}) {
    this.knobs = options.knobs ?? FEED_CUE_KNOBS;
    this.random = options.random ?? Math.random;
  }

  open(characterId: string, sessionId: string, at: number, now: () => FeedCueNow | null): void {
    if (typeof characterId !== 'string' || !characterId || typeof sessionId !== 'string' || !sessionId) return;
    if (this.sessions.get(characterId)?.sessionId === sessionId) return;
    this.start(characterId, sessionId, at, now);
  }

  bite(characterId: string, sessionId: string, at: number, landing: TouchFeedLandingId | null, now: () => FeedCueNow | null): void {
    if (typeof characterId !== 'string' || !characterId || typeof sessionId !== 'string' || !sessionId) return;
    let session = this.sessions.get(characterId);
    if (!session || session.sessionId !== sessionId) session = this.start(characterId, sessionId, at, now);
    if (session.eat) return;
    const history = this.historyOf(characterId);
    const id = `${sessionId}:eat`;
    let draw: FeedEatDraw;
    try { draw = drawFeedEat(session.now, landing === 'full' || landing === 'usual' || landing === 'light' ? landing : null, history.eat, this.random, this.knobs); }
    catch { draw = { sound: { id: 'mm', label: labelOf(this.knobs.eat.mm), why: ['（出错兜底：按原来的）'], weights: '' }, chew: { rate: 1, size: 1 } }; }
    let eat: FeedEatPlan = { id, sound: draw.sound.id === 'quiet' ? null : draw.sound.id, chew: { ...draw.chew } };
    let why = [...draw.sound.why];
    if (!feedCuePlanSafe({ sessionId, open: session.open, eat }, session.now?.lineFollows === true, this.knobs)) {
      eat = PLAIN_EAT(id);
      why = [...why, '（兜底：这一次按原来的）'];
    }
    session.eat = eat; session.biteAt = finite(at, session.at);
    session.eatWhy = { sound: eat.sound ? labelOf(this.knobs.eat[eat.sound]) : labelOf(this.knobs.eat.quiet), why, weights: draw.sound.weights };
    history.eat = [eat.sound ?? 'quiet' as FeedEatChoice, ...history.eat].slice(0, 2);
  }

  view(characterId: string, at: number): FeedCueView | null {
    const s = this.sessions.get(characterId);
    if (!s) return null;
    const age = finite(at, 0) - (s.biteAt ?? s.at);
    if (age > (s.biteAt === null ? FEED_CUE_VIEW_BEFORE_BITE_MS : FEED_CUE_VIEW_AFTER_BITE_MS)) return null;
    return { sessionId: s.sessionId,
      open: { id: s.open.id, sound: s.open.sound, mouth: { ...s.open.mouth }, shake: s.open.shake ? { ...s.open.shake } : null },
      ...(s.eat ? { eat: { id: s.eat.id, sound: s.eat.sound, chew: { ...s.eat.chew } } } : {}) };
  }

  recent(characterId: string): readonly FeedCueWhy[] {
    const out: FeedCueWhy[] = [];
    const s = this.sessions.get(characterId);
    if (s) out.push(this.entry(s));
    for (const entry of this.log) {
      if (out.length >= KEEP) break;
      if (entry.characterId !== characterId) continue;
      const { characterId: _, ...rest } = entry;
      out.push(structuredClone(rest));
    }
    return out;
  }

  private start(characterId: string, sessionId: string, at: number, now: () => FeedCueNow | null): Session {
    const previous = this.sessions.get(characterId);
    if (previous) { this.log.unshift({ characterId, ...this.entry(previous) }); this.log.splice(KEEP * 8); }
    let moment: FeedCueNow | null = null;
    try { moment = now(); } catch { moment = null; }
    const history = this.historyOf(characterId);
    const id = `${sessionId}:open`;
    let draw: FeedOpenDraw;
    try { draw = drawFeedOpen(moment, history.open, this.random, this.knobs); }
    catch { draw = { sound: { id: 'ah', label: labelOf(this.knobs.open.ah), why: ['（出错兜底：按原来的）'], weights: '' }, mouth: { rate: 1, size: 1 }, shake: null, slowness: 0, wary: false }; }
    let open: FeedOpenPlan = { id, sound: draw.sound.id === 'quiet' ? null : draw.sound.id, mouth: { ...draw.mouth }, shake: draw.shake ? { ...draw.shake } : null };
    let why = [...draw.sound.why];
    const manner = { label: draw.wary ? '小心地' : draw.slowness > 0 ? '慢慢吃' : '照常', why: [] as string[] };
    if (draw.slowness > 0 && moment) manner.why.push(`吃了好几块，有点腻了（新鲜感还剩 ${percent(moment.fresh)}%）`);
    if (draw.wary) manner.why.push('不久前喂过不是吃的，这次张嘴小心');
    if (!manner.why.length) manner.why.push(moment && moment.fresh < 0.995 ? `新鲜感还剩 ${percent(moment.fresh)}%，还没吃腻` : '还没吃腻');
    if (draw.shake && moment && this.knobs.manner.shake.mood[moment.mood] !== undefined && this.knobs.manner.shake.mood[moment.mood]! >= 1.05)
      manner.why.push(`摇头：心情：${MOOD_LABELS[moment.mood]}`);
    if (!feedCuePlanSafe({ sessionId, open }, false, this.knobs)) {
      open = PLAIN_OPEN(id);
      why = [...why, '（兜底：这一次按原来的）'];
      manner.label = '照常'; manner.why = ['（兜底：这一次按原来的）'];
    }
    const session: Session = { sessionId, at: finite(at, 0), biteAt: null, now: moment, open, slowness: draw.slowness,
      openWhy: { sound: open.sound ? labelOf(this.knobs.open[open.sound]) : labelOf(this.knobs.open.quiet), why, weights: draw.sound.weights }, manner };
    this.sessions.set(characterId, session);
    history.open = [open.sound ?? 'quiet' as FeedOpenChoice, ...history.open].slice(0, 2);
    return session;
  }

  private entry(s: Session): FeedCueWhy {
    return { at: s.at, open: { ...s.openWhy, why: [...s.openWhy.why] },
      ...(s.eatWhy ? { eat: { ...s.eatWhy, why: [...s.eatWhy.why] } } : {}),
      manner: { label: s.manner.label, why: [...s.manner.why], numbers: mannerNumbers(s) } };
  }

  private historyOf(characterId: string): { open: FeedOpenChoice[]; eat: FeedEatChoice[] } {
    let history = this.history.get(characterId);
    if (!history) { history = { open: [], eat: [] }; this.history.set(characterId, history); }
    return history;
  }
}
