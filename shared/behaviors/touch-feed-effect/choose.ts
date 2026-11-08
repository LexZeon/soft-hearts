/**
 * #21 的真实现：每一次摸头、捏脸、喂点心开始时，她来挑这一次受用不受用，再在范围里抽这一次的效果；"腻"的快慢按角色卡性格
 * （接口见 interface.ts，旋钮见 knobs.ts）。纯本地、零额度、不碰聊天提示词；只在内存里记最近几次。
 *
 * 安全线（touchFeedEffectSafe，不是旋钮）：
 *  - 一次互动最多加多少不变：效果倍数 scale 在 0～1，所以每一剂最多还是原来的那么多（摸头每 5 秒亲近 +10、舒适 +4，点心
 *    期待 +12、舒适 +6，再乘卡上的敏感度），腻了只会更少。心情模型自己的上限（头顶的饱和、尾注 ±20 的校验）照旧。
 *  - "腻"换进去的 retention、floor 都在 0～1，floor 不低于 min(卡上的 floor, 0.05)：腻到底也还有一点感觉；腻得多深
 *    （心情模型的剂数上限）不超过卡上的两倍，所以恢复新鲜最多是卡上的两倍久（默认旋钮下最多 1.25 倍）。
 *  - 抽出来的不过这一关，这一次就按卡上的值（= 原来的做法）。
 */
import { sheChooses, type SheChoosesCandidate, type SheChose } from '../../she-chooses';
import { MOOD_LABELS } from '../../mood-runtime';
import { MOOD_TENDENCY_MIN, tendencyNow } from '../../mood-tendency';
import type { MoodLabel, MoodSnapshot, MoodTendency } from '../../mood';
import type { FatiguePhase } from '../../fatigue';
import { TOUCH_FEED_EFFECT_KNOBS, TOUCH_FEED_KINDS, TOUCH_FEED_LANDING_IDS, type TouchFeedEffectKnobs, type TouchFeedKind,
  type TouchFeedKindKnobs, type TouchFeedLandingId, type TouchFeedLandingKnob, type TouchFeedMoment } from './knobs';
import type { TouchFeedContact, TouchFeedEffect, TouchFeedEffectHost, TouchFeedEvent, TouchFeedFreshness, TouchFeedNow, TouchFeedWhy } from './interface';

const TENDENCIES: readonly MoodTendency[] = ['playful', 'close', 'comfortable', 'cautious'];
/** "这会儿……"：心情快照里最强的那项倾向（和 #11、#8 同样的说法）。 */
const NOW_WORDS: Readonly<Record<MoodTendency | 'wistful', string>> = {
  playful: '这会儿有点调皮', close: '这会儿想黏着你', comfortable: '这会儿很放松', cautious: '这会儿有点拘谨', wistful: '还在想念的余韵里',
};
/** 角色卡性格：高于一般 / 低于一般（和 #11、#5 同样的说法）。 */
const PERSONALITY_WORDS: Readonly<Record<MoodTendency, readonly [string, string]>> = {
  playful: ['性格：爱玩', '性格：不太爱玩'], close: ['性格：黏人', '性格：不太黏人'],
  comfortable: ['性格：随和', '性格：不太随和'], cautious: ['性格：谨慎', '性格：大胆'],
};
export const TOUCH_FEED_CONTACT_WORDS: Readonly<Record<TouchFeedContact, string>> = { pat: '摸头', pinch: '捏脸', food: '喂点心' };
/** 腻到底至少还剩多少（安全线；旋钮 minFloor 只能比它高）。 */
const MIN_FLOOR = 0.05;
/** 心情模型的剂数上限（shared/mood.ts 的 MAX_DOSES）。 */
const MAX_DOSES = 64;
/** 前几次留几次（只在内存）。 */
const KEEP = 4;
/**
 * "这会儿……"至少要这么强才算（心情快照 tendencies 的同一把尺子：亲近比基线高约 2.5 点）。心情模型的 companion 只要大于 0
 * 就算，她的数值慢慢回到基线时永远略高一丝（例如隔了一天还高 1e-10），那不是"这会儿想黏着你"，不能写进"为什么"。
 * 各功能共用 shared/mood-tendency.ts 的同一个门槛（#8、#11 也用它），想改只改那里。
 */
export const TOUCH_FEED_TENDENCY_MIN = MOOD_TENDENCY_MIN;
const EPS = 1e-9;

const finite = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const unit = (value: unknown): number => Math.min(1 - 1e-12, Math.max(0, finite(value, 0)));
const lerp = ([low, high]: readonly [number, number], t: number): number => finite(low, 1) + (finite(high, 1) - finite(low, 1)) * t;
const round2 = (value: number): number => Math.round(value * 100) / 100;
const percent = (value: number): number => Math.round(clamp(value, 0, 1) * 100);

/** MoodHost 交给"此刻"的原料。 */
export interface TouchFeedNowInput {
  readonly snapshot: Pick<MoodSnapshot, 'primary' | 'companion'> & { readonly tendencies?: Partial<Record<MoodTendency, number>> };
  /** 角色卡性格（MoodParameters.weights）。 */
  readonly personality: Partial<Record<MoodTendency, number>> | null | undefined;
  readonly fatiguePhase: FatiguePhase | null | undefined;
}

/** 把主机手里的东西整理成"此刻"。 */
export function touchFeedNow(input: TouchFeedNowInput): TouchFeedNow {
  const s = input.snapshot;
  const mood = (Object.hasOwn(MOOD_LABELS, s.primary) ? s.primary : 'calm') as MoodLabel;
  const tendency = tendencyNow(s, TOUCH_FEED_TENDENCY_MIN);
  const personality = Object.fromEntries(TENDENCIES.map(t => [t, clamp(finite(input.personality?.[t], 1), 0, 4)])) as Record<MoodTendency, number>;
  const moments: TouchFeedMoment[] = [];
  if (input.fatiguePhase === 'light-drowsy') moments.push('tired');
  if (input.fatiguePhase === 'drowsy' || input.fatiguePhase === 'falling-asleep' || input.fatiguePhase === 'asleep' || input.fatiguePhase === 'micro-awake') moments.push('sleepy');
  return { mood, tendency, personality, moments };
}

/** 心情模型腻得多深（shared/mood.ts depthCap 的同一算法）：剂数最多攒到几，恢复新鲜的时间跟着它。 */
export function freshnessDepth(f: Readonly<Pick<TouchFeedFreshness, 'retention' | 'floor'>>): number {
  if (f.retention === 1 || f.floor === 1 || f.retention === 0) return 1;
  return Math.min(MAX_DOSES, f.floor === 0 ? MAX_DOSES : Math.ceil(Math.log(f.floor) / Math.log(f.retention)));
}

/** 已经攒下 `taken` 剂时，下一剂还剩原来的多少（心情模型里每一剂的同一算法）。 */
export function freshnessLeft(f: Readonly<Pick<TouchFeedFreshness, 'retention' | 'floor'>>, taken: number): number {
  return Math.max(f.floor, Math.pow(f.retention, Math.floor(Math.max(0, finite(taken, 0)) + 1e-10)));
}

/**
 * 安全线：`effect` 不会让一剂比原来更多（scale ≤ 1），"腻"是合法的参数、不比卡上的深两倍以上。
 * tests/touch-feed-effect.test.ts 拿随机的卡、心情、性格和连着的互动，用真的心情模型去量每一剂。
 */
export function touchFeedEffectSafe(card: Readonly<TouchFeedFreshness>, effect: Readonly<TouchFeedEffect> | null | undefined): boolean {
  const ok = (n: unknown, low: number, high: number) => typeof n === 'number' && Number.isFinite(n) && n >= low && n <= high;
  if (!effect || !ok(effect.scale, 0, 1) || !ok(effect.retention, 0, 1) || !ok(effect.floor, 0, 1)) return false;
  if (effect.floor < Math.min(card.floor, MIN_FLOOR) - EPS) return false;
  return freshnessDepth(effect) <= 2 * freshnessDepth(card);
}

/** 腻的程度（1 = 和卡上一样，小于 1 腻得慢）和它的理由。 */
export function tireFactor(knob: TouchFeedKindKnobs['tire'], personality: Readonly<Record<MoodTendency, number>>): { factor: number; reason: string | null } {
  const value = clamp(finite(personality[knob.trait], 1), 0, 4);
  const low = Math.min(knob.range[0], knob.range[1]), high = Math.max(knob.range[0], knob.range[1]);
  const factor = clamp(1 - finite(knob.strength, 0) * 2 * (value - 1), Math.max(0, low), Math.max(0, high));
  if (Math.abs(factor - 1) < 0.05) return { factor, reason: null };
  return { factor, reason: factor < 1 ? `腻得慢（${PERSONALITY_WORDS[knob.trait][0]}）` : `腻得快（${PERSONALITY_WORDS[knob.trait][1]}）` };
}

/** 卡上的"腻" × 腻的程度：retention 和 floor 离 1 的距离都乘它。 */
export function tiredFreshness(card: Readonly<TouchFeedFreshness>, factor: number, minFloor: number): { retention: number; floor: number } {
  // r + (1 − k)(1 − r) = 1 − k(1 − r), written so that k = 1 gives the card's numbers exactly.
  const retention = clamp(card.retention + (1 - factor) * (1 - card.retention), 0, 1);
  const floor = clamp(Math.max(card.floor + (1 - factor) * (1 - card.floor), Math.min(card.floor, Math.max(MIN_FLOOR, finite(minFloor, MIN_FLOOR)))), 0, 1);
  return { retention, floor };
}

/** 一种受用不受用此刻的理由：心情、这会儿的倾向、角色卡性格、此刻发生的事。 */
function leanReasons(knob: TouchFeedLandingKnob, now: Readonly<TouchFeedNow>, knobs: TouchFeedEffectKnobs) {
  const reasons: { text: string; factor: number }[] = [];
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
  return reasons;
}

function landingCandidates(kind: TouchFeedKind, knobs: TouchFeedEffectKnobs): SheChoosesCandidate<TouchFeedLandingId, TouchFeedNow>[] {
  const own = knobs[kind].landings;
  return TOUCH_FEED_LANDING_IDS.map(id => ({ id, label: own[id].label, weigh: now => ({ base: own[id].base, reasons: leanReasons(own[id], now, knobs) }) }));
}
const weightLine = (chose: SheChose<string> | null) => chose ? chose.weights.map(w => `${w.label} ${w.weight}`).join(' · ') : '';

/** 一次互动挑出来的。 */
export interface TouchFeedDraw {
  readonly landing: TouchFeedLandingId;
  readonly label: string;
  readonly scale: number;
  readonly why: readonly string[];
  readonly weights: string;
}

/**
 * 挑一次：受用不受用（她来挑），再在它的 range 里抽这一次的倍数（上限夹到 1）。每次正好取 2 个随机数，顺序固定
 * （受用不受用、倍数），所以改一个旋钮只影响它管的那一处（tests/touch-feed-effect.test.ts 的"一个旋钮"测试）。
 * `recent`：这种互动最近用过的（最新的在前）。
 */
export function drawTouchFeed(kind: TouchFeedKind, now: Readonly<TouchFeedNow> | null, recent: readonly TouchFeedLandingId[], random: () => number,
  knobs: TouchFeedEffectKnobs = TOUCH_FEED_EFFECT_KNOBS): TouchFeedDraw {
  const chose = now ? sheChooses({ candidates: landingCandidates(kind, knobs), now, random, recent, recentFactors: knobs.recent }) : (random(), null);
  const u = unit(random());
  const landing: TouchFeedLandingId = chose?.id ?? 'usual', knob = knobs[kind].landings[landing];
  const low = clamp(Math.min(knob.range[0], knob.range[1]), 0, 1), high = clamp(Math.max(knob.range[0], knob.range[1]), 0, 1);
  const scale = round2(clamp(lerp([low, high], u), 0, 1));
  const why = [chose ? `${knob.label}——${chose.why.join('；')}`
    : now ? `${knob.label}——几种的分量都是 0（看旋钮），按照常` : `${knob.label}——没读到此刻的心情，按照常`];
  return { landing, label: knob.label, scale, why, weights: weightLine(chose) };
}

interface Session {
  sessionId: string;
  kind: TouchFeedKind;
  contact: TouchFeedContact;
  at: number;
  draw: TouchFeedDraw;
  tire: { factor: number; reason: string | null };
  cardKey: string;
  fresh: { first: number; last: number };
  doses: number;
}
const cardKey = (card: Readonly<TouchFeedFreshness>): string => [card.retention, card.floor].join('|');

/** 真实现（接口见 interface.ts TouchFeedEffectHost）。 */
export class TouchFeedEffectDirector implements TouchFeedEffectHost {
  private readonly sessions = new Map<string, Session>();
  private readonly history = new Map<string, Record<TouchFeedKind, TouchFeedLandingId[]>>();
  private readonly log: (TouchFeedWhy & { characterId: string })[] = [];
  private readonly knobs: TouchFeedEffectKnobs;
  private readonly random: () => number;

  constructor(options: { knobs?: TouchFeedEffectKnobs; random?: () => number } = {}) {
    this.knobs = options.knobs ?? TOUCH_FEED_EFFECT_KNOBS;
    this.random = options.random ?? Math.random;
  }

  effect(characterId: string, event: Readonly<TouchFeedEvent>, card: Readonly<TouchFeedFreshness>, now: () => TouchFeedNow | null): TouchFeedEffect {
    const plain: TouchFeedEffect = { scale: 1, retention: card.retention, floor: card.floor };
    if (typeof characterId !== 'string' || !characterId || !event || !TOUCH_FEED_KINDS.includes(event.kind)) return plain;
    const key = `${characterId}\u0000${event.kind}`;
    let session = this.sessions.get(key);
    const ck = cardKey(card);
    if (!session || session.sessionId !== event.sessionId || session.cardKey !== ck) {
      if (session) this.finish(characterId, session);
      let moment: TouchFeedNow | null = null;
      try { moment = now(); } catch { moment = null; }
      let draw: TouchFeedDraw;
      try { draw = drawTouchFeed(event.kind, moment, this.historyOf(characterId)[event.kind], this.random, this.knobs); }
      catch { draw = { landing: 'usual', label: this.knobs[event.kind].landings.usual.label, scale: 1, why: ['（出错兜底：这一次按卡上的值）'], weights: '' }; }
      const tire = moment ? tireFactor(this.knobs[event.kind].tire, moment.personality) : { factor: 1, reason: null };
      session = { sessionId: event.sessionId, kind: event.kind, contact: event.contact, at: finite(event.at, 0), draw, tire, cardKey: ck,
        fresh: { first: 1, last: 1 }, doses: 0 };
      const history = this.historyOf(characterId);
      history[event.kind] = [draw.landing, ...history[event.kind]].slice(0, Math.max(1, this.knobs.recent.length));
      this.sessions.set(key, session);
      const tired = tiredFreshness(card, tire.factor, this.knobs[event.kind].tire.minFloor);
      session.fresh.first = freshnessLeft(tired, event.taken);
    }
    const tired = tiredFreshness(card, session.tire.factor, this.knobs[event.kind].tire.minFloor);
    let effect: TouchFeedEffect = { scale: session.draw.scale, ...tired };
    // Whatever was drawn, the safety line holds.
    if (!touchFeedEffectSafe(card, effect)) {
      effect = plain;
      if (!session.draw.why.includes('（兜底：这一次按卡上的值）')) session.draw = { ...session.draw, scale: 1, why: [...session.draw.why, '（兜底：这一次按卡上的值）'] };
    }
    session.fresh.last = freshnessLeft(effect, event.taken);
    session.doses += Math.max(0, finite(event.doses, 0));
    return effect;
  }

  recent(characterId: string): readonly TouchFeedWhy[] {
    const out: TouchFeedWhy[] = [];
    const current = [...this.sessions.entries()].filter(([key]) => key.startsWith(`${characterId}\u0000`)).map(([, session]) => session)
      .sort((a, b) => b.at - a.at);
    for (const session of current) out.push(this.entry(session));
    for (const entry of this.log) {
      if (out.length >= KEEP) break;
      if (entry.characterId !== characterId) continue;
      const { characterId: _, ...rest } = entry;
      out.push({ ...rest, why: [...rest.why], fresh: { ...rest.fresh } });
    }
    return out.sort((a, b) => b.at - a.at).slice(0, KEEP);
  }

  /** #32: this interaction's landing (the snack being eaten now), or null when `sessionId` is not the current one of this kind. */
  landing(characterId: string, kind: TouchFeedKind, sessionId: string): TouchFeedLandingId | null {
    const session = this.sessions.get(`${characterId}\u0000${kind}`);
    return session && session.sessionId === sessionId ? session.draw.landing : null;
  }

  private entry(session: Session): TouchFeedWhy {
    const why = [...session.draw.why];
    if (session.tire.reason) why.push(session.tire.reason);
    if (session.fresh.first < 0.995) why.push(`${session.kind === 'food' ? '刚吃过点心' : '刚被摸过头或捏过脸'}，这一次开始时新鲜感还剩 ${percent(session.fresh.first)}%`);
    return { at: session.at, kind: session.kind, contact: session.contact, landing: session.draw.label, scale: session.draw.scale, why,
      fresh: { first: percent(session.fresh.first), last: percent(session.fresh.last) }, doses: round2(session.doses), weights: session.draw.weights };
  }

  private finish(characterId: string, session: Session): void {
    this.log.unshift({ characterId, ...this.entry(session) });
    this.log.splice(KEEP * 8);
  }

  private historyOf(characterId: string): Record<TouchFeedKind, TouchFeedLandingId[]> {
    let history = this.history.get(characterId);
    if (!history) { history = { touch: [], food: [] }; this.history.set(characterId, history); }
    return history;
  }
}
