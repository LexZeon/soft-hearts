/**
 * #26 的真实现：每次要红的那一刻，她来挑这一次红成什么样，深浅和三段时长在卡上的值附近浮动；红过以后隔多久才会再红也浮动；
 * 谨慎（容易害羞）的卡被摸头时更容易红（接口见 interface.ts，旋钮见 knobs.ts）。纯本地、零额度、不碰聊天提示词；只在内存。
 *
 * 安全线（blushProfileSafe，不是旋钮）：
 *  - 冷却永远不比卡上的短：红过以后下一次至少隔卡上的 cooldownMs（默认 1 分钟），只会更久。所以她不会比原来红得更频繁。
 *  - 开关、大小（size）照卡上的；强度在卡上的 0.5～1.5 倍、不超过 100；三段时长在心情模型校验的范围里
 *    （红起来 0.1～5 秒、停 0～20 秒、退 0.1～10 秒）。抽出来的不过这一关，这一次就按卡上的形状（= 原来的做法）。
 *  - 什么时候红还是心情模型的 maybeBlush 定，这里只换交给它的参数；"说了暖心的话"那一条门槛是模型里的固定数，不动。
 */
import { sheChooses, type SheChoosesCandidate, type SheChose } from '../../she-chooses';
import { MOOD_LABELS } from '../../mood-runtime';
import { MOOD_TENDENCY_MIN, tendencyNow } from '../../mood-tendency';
import type { MoodBlushParameters, MoodLabel, MoodSnapshot, MoodTendency } from '../../mood';
import type { FatiguePhase } from '../../fatigue';
import { BLUSH_KNOBS, BLUSH_LOOK_IDS, type BlushKnobs, type BlushLookId, type BlushLookKnob, type BlushMoment, type BlushTrigger } from './knobs';
import type { BlushChance, BlushContact, BlushHost, BlushNow, BlushOutcome, BlushPrepared, BlushWhy } from './interface';

const DAY = 24 * 60 * 60_000;
const TENDENCIES: readonly MoodTendency[] = ['playful', 'close', 'comfortable', 'cautious'];
/** "这会儿……"：心情快照里最强的那项倾向（和 #11、#8 同样的说法）。 */
const NOW_WORDS: Readonly<Record<MoodTendency | 'wistful', string>> = {
  playful: '这会儿有点调皮', close: '这会儿想黏着你', comfortable: '这会儿很放松', cautious: '这会儿有点拘谨', wistful: '还在想念的余韵里',
};
/** 角色卡性格：高于一般 / 低于一般（谨慎的那一项说清楚是"容易害羞"）。 */
const PERSONALITY_WORDS: Readonly<Record<MoodTendency, readonly [string, string]>> = {
  playful: ['性格：爱玩', '性格：不太爱玩'], close: ['性格：黏人', '性格：不太黏人'],
  comfortable: ['性格：随和', '性格：不太随和'], cautious: ['性格：谨慎（容易害羞）', '性格：大胆（不太害羞）'],
};
export const BLUSH_CONTACT_WORDS: Readonly<Record<BlushContact, string>> = { pat: '被摸头', pinch: '被捏脸', words: '你说了暖心的话' };
/** 前几次留几次（只在内存）。 */
const KEEP = 4;
/** "这会儿……"至少要这么强才算（回到基线时那一丝不算；各功能共用 shared/mood-tendency.ts 的同一个门槛，想改只改那里）。 */
export const BLUSH_TENDENCY_MIN = MOOD_TENDENCY_MIN;
const EPS = 1e-9;

const finite = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const unit = (value: unknown): number => Math.min(1 - 1e-12, Math.max(0, finite(value, 0)));
const lerp = ([low, high]: readonly [number, number], t: number): number => finite(low, 1) + (finite(high, 1) - finite(low, 1)) * t;
const round1 = (value: number): number => Math.round(value * 10) / 10;
const round2 = (value: number): number => Math.round(value * 100) / 100;
const seconds = (ms: number): string => String(round1(ms / 1000));

/** MoodHost 交给"此刻"的原料。 */
export interface BlushNowInput {
  readonly snapshot: Pick<MoodSnapshot, 'primary' | 'companion'> & { readonly tendencies?: Partial<Record<MoodTendency, number>> };
  /** 角色卡性格（MoodParameters.weights）。 */
  readonly personality: Partial<Record<MoodTendency, number>> | null | undefined;
  readonly fatiguePhase: FatiguePhase | null | undefined;
  readonly trigger: BlushTrigger;
}

/** 把主机手里的东西整理成"此刻"。 */
export function blushNow(input: BlushNowInput): BlushNow {
  const s = input.snapshot;
  const mood = (Object.hasOwn(MOOD_LABELS, s.primary) ? s.primary : 'calm') as MoodLabel;
  const tendency = tendencyNow(s, BLUSH_TENDENCY_MIN);
  const personality = Object.fromEntries(TENDENCIES.map(t => [t, clamp(finite(input.personality?.[t], 1), 0, 4)])) as Record<MoodTendency, number>;
  const moments: BlushMoment[] = [];
  if (input.fatiguePhase === 'drowsy' || input.fatiguePhase === 'falling-asleep' || input.fatiguePhase === 'asleep' || input.fatiguePhase === 'micro-awake') moments.push('sleepy');
  return { mood, tendency, personality, trigger: input.trigger === 'words' ? 'words' : 'touch', moments };
}

/**
 * 安全线：`profile` 不会让她比卡上的更频繁地红（冷却不短于卡上的），开关和大小照卡上的，强度和时长都在合法范围里。
 * tests/blush.test.ts 拿随机的卡、心情、性格去试，再在真的心情模型里连着摸头、说暖心的话数她红了几次。
 */
export function blushProfileSafe(card: Readonly<MoodBlushParameters>, profile: Readonly<MoodBlushParameters> | null | undefined): boolean {
  const ok = (n: unknown, low: number, high: number) => typeof n === 'number' && Number.isFinite(n) && n >= low && n <= high;
  if (!profile || profile.enabled !== card.enabled || profile.size !== card.size) return false;
  if (!ok(profile.intensity, 0, 100) || !ok(profile.riseMs, 100, 5_000) || !ok(profile.holdMs, 0, 20_000) || !ok(profile.fadeMs, 100, 10_000)
    || !ok(profile.cooldownMs, 0, DAY)) return false;
  if (profile.cooldownMs < card.cooldownMs - EPS) return false;
  if (!(card.intensity > 0)) return profile.intensity === card.intensity;
  return profile.intensity >= card.intensity * 0.5 - EPS && profile.intensity <= Math.min(100, card.intensity * 1.5) + EPS;
}

/** 性格倍数（1 + 这个数 × 2 ×（性格值 − 1），夹在 0.2～3）和抬高 / 压低它的那几项性格。 */
function personalityLean(spec: Partial<Record<MoodTendency, number>> | undefined, personality: Readonly<Record<MoodTendency, number>>) {
  let factor = 1;
  const up: string[] = [], down: string[] = [];
  for (const trait of TENDENCIES) {
    const strength = spec?.[trait];
    if (!strength) continue;
    const value = personality[trait], f = clamp(1 + strength * 2 * (value - 1), 0.2, 3);
    factor *= f;
    if (f >= 1.05) up.push(PERSONALITY_WORDS[trait][value > 1 ? 0 : 1]);
    else if (f <= 0.95) down.push(PERSONALITY_WORDS[trait][value > 1 ? 0 : 1]);
  }
  return { factor, up, down };
}

/** 被摸头时门槛 × 多少（谨慎的卡小于 1），和让它变小 / 变大的性格。 */
export function blushEase(knobs: BlushKnobs, personality: Readonly<Record<MoodTendency, number>>): { scale: number; easier: string[]; harder: string[] } {
  const lean = personalityLean(knobs.ease.personality, personality);
  const low = Math.min(knobs.ease.range[0], knobs.ease.range[1]), high = Math.max(knobs.ease.range[0], knobs.ease.range[1]);
  return { scale: clamp(lean.factor, Math.max(0.05, low), Math.max(0.05, high)), easier: lean.down, harder: lean.up };
}

/** 一种样子此刻的理由：心情、这会儿的倾向、角色卡性格、什么让她红的、此刻发生的事。 */
function leanReasons(knob: BlushLookKnob, now: Readonly<BlushNow>, knobs: BlushKnobs) {
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
  const trigger = knob.triggers?.[now.trigger];
  if (trigger !== undefined) reasons.push({ text: now.trigger === 'words' ? '是你说的话让她红的' : '是被你碰到让她红的', factor: trigger });
  for (const moment of now.moments) {
    const factor = knob.moments?.[moment];
    if (factor !== undefined) reasons.push({ text: knobs.moments[moment].label, factor });
  }
  return reasons;
}

function lookCandidates(knobs: BlushKnobs): SheChoosesCandidate<BlushLookId, BlushNow>[] {
  return BLUSH_LOOK_IDS.map(id => ({ id, label: knobs.looks[id].label, weigh: now => ({ base: knobs.looks[id].base, reasons: leanReasons(knobs.looks[id], now, knobs) }) }));
}
const weightLine = (chose: SheChose<string> | null) => chose ? chose.weights.map(w => `${w.label} ${w.weight}`).join(' · ') : '';

/** 这一次的形状（换进 parameters.blush）。 */
export type BlushShape = Pick<MoodBlushParameters, 'intensity' | 'riseMs' | 'holdMs' | 'fadeMs'>;
export interface BlushDraw {
  readonly look: BlushLookId;
  readonly label: string;
  readonly shape: BlushShape;
  /** 红过以后，下一次至少隔多少毫秒（≥ 卡上的）。 */
  readonly cooldownMs: number;
  readonly cooldownWhy: readonly string[];
  readonly why: readonly string[];
  readonly weights: string;
}

/** 形状给人看："深浅 ×1.08 · 红起来 0.5 秒 · 停 1.9 秒 · 退 2.3 秒（一共 4.7 秒）"。 */
export function blushShapeText(card: Readonly<MoodBlushParameters>, shape: Readonly<BlushShape>): string {
  const depth = card.intensity > 0 ? round2(shape.intensity / card.intensity) : 1;
  return `深浅 ×${depth} · 红起来 ${seconds(shape.riseMs)} 秒 · 停 ${seconds(shape.holdMs)} 秒 · 退 ${seconds(shape.fadeMs)} 秒（一共 ${seconds(shape.riseMs + shape.holdMs + shape.fadeMs)} 秒）`;
}

/**
 * 挑一次：样子（她来挑），再在它的范围里抽深浅、红起来、停、退，和红过以后的冷却。每次正好取 6 个随机数，顺序固定
 * （样子、深浅、红起来、停、退、冷却），所以改一个旋钮只影响它管的那一处（tests/blush.test.ts 的"一个旋钮"测试）。
 */
export function drawBlush(card: Readonly<MoodBlushParameters>, now: Readonly<BlushNow> | null, recent: readonly BlushLookId[], random: () => number,
  knobs: BlushKnobs = BLUSH_KNOBS): BlushDraw {
  const chose = now ? sheChooses({ candidates: lookCandidates(knobs), now, random, recent, recentFactors: knobs.recent }) : (random(), null);
  const uDepth = unit(random()), uRise = unit(random()), uHold = unit(random()), uFade = unit(random()), uCool = unit(random());
  const look: BlushLookId = chose?.id ?? 'usual', k = knobs.looks[look];
  const shape: BlushShape = {
    intensity: round1(clamp(card.intensity * lerp(k.depth, uDepth), 0, 100)),
    riseMs: Math.round(clamp(card.riseMs * lerp(k.rise, uRise), 100, 5_000)),
    holdMs: Math.round(clamp(card.holdMs * lerp(k.hold, uHold), 0, 20_000)),
    fadeMs: Math.round(clamp(card.fadeMs * lerp(k.fade, uFade), 100, 10_000)),
  };
  const lean = now ? personalityLean(knobs.cooldown.personality, now.personality) : { factor: 1, up: [], down: [] };
  const factor = Math.max(1, lerp(knobs.cooldown.range, uCool) * lean.factor);
  const cooldownMs = Math.max(card.cooldownMs, Math.min(DAY, Math.round(card.cooldownMs * factor)));
  const cooldownWhy = lean.factor >= 1.05 && cooldownMs > card.cooldownMs ? lean.up.map(text => `${text}，红过以后隔得久一点`) : [];
  const why = [chose ? `${k.label}——${chose.why.join('；')}`
    : now ? `${k.label}——几种样子的分量都是 0（看旋钮），按红一下` : `${k.label}——没读到此刻的心情，按红一下`];
  return { look, label: k.label, shape, cooldownMs, cooldownWhy, why, weights: weightLine(chose) };
}

interface Pending {
  readonly characterId: string;
  readonly cardKey: string;
  readonly card: MoodBlushParameters;
  readonly chance: BlushChance;
  readonly draw: BlushDraw;
  readonly ease: { scale: number; easier: string[]; harder: string[] };
  readonly fallback: boolean;
}
interface Locked { cueId: string; cardKey: string; shape: BlushShape; cooldownMs: number }

export const blushCardKey = (card: Readonly<MoodBlushParameters>): string =>
  [card.enabled, card.intensity, card.size, card.riseMs, card.holdMs, card.fadeMs, card.cooldownMs].join('|');
const shapeOf = (card: Readonly<MoodBlushParameters>): BlushShape => ({ intensity: card.intensity, riseMs: card.riseMs, holdMs: card.holdMs, fadeMs: card.fadeMs });

/** 真实现（接口见 interface.ts BlushHost）。 */
export class BlushDirector implements BlushHost {
  private readonly locked = new Map<string, Locked>();
  private readonly pending = new Map<number, Pending>();
  private readonly history = new Map<string, BlushLookId[]>();
  private readonly log: (BlushWhy & { characterId: string })[] = [];
  private readonly knobs: BlushKnobs;
  private readonly random: () => number;
  private nextDraw = 1;

  constructor(options: { knobs?: BlushKnobs; random?: () => number } = {}) {
    this.knobs = options.knobs ?? BLUSH_KNOBS;
    this.random = options.random ?? Math.random;
  }

  profile(characterId: string, card: Readonly<MoodBlushParameters>, cue: { readonly id: string } | null): MoodBlushParameters {
    if (!card.enabled || !(card.intensity > 0)) return card as MoodBlushParameters;
    const last = this.locked.get(characterId);
    if (!last || last.cardKey !== blushCardKey(card)) return card as MoodBlushParameters;
    if (cue && cue.id === last.cueId) return { ...card, ...last.shape, cooldownMs: last.cooldownMs };
    return last.cooldownMs === card.cooldownMs ? card as MoodBlushParameters : { ...card, cooldownMs: last.cooldownMs };
  }

  prepare(characterId: string, card: Readonly<MoodBlushParameters>, chance: Readonly<BlushChance>, now: () => BlushNow | null): BlushPrepared {
    const base = this.profile(characterId, card, chance.cue);
    const none: BlushPrepared = { profile: base, thresholdScale: 1, draw: null };
    if (typeof characterId !== 'string' || !characterId || !card.enabled || !(card.intensity > 0)) return none;
    // The same two "not now" checks the mood model makes (showing one, or still cooling down): nothing to pick.
    if (chance.cue && chance.cue.until > chance.at) return none;
    if (chance.lastBlushAt !== null && chance.at - chance.lastBlushAt < base.cooldownMs) return none;
    let moment: BlushNow | null = null;
    try { moment = now(); } catch { moment = null; }
    let draw: BlushDraw, fallback = false;
    try { draw = drawBlush(card, moment, this.history.get(characterId) ?? [], this.random, this.knobs); }
    catch { draw = { look: 'usual', label: this.knobs.looks.usual.label, shape: shapeOf(card), cooldownMs: card.cooldownMs, cooldownWhy: [], why: ['（出错兜底：这一次按卡上的形状）'], weights: '' }; fallback = true; }
    const ease = moment && chance.contact !== 'words' ? blushEase(this.knobs, moment.personality) : { scale: 1, easier: [], harder: [] };
    let profile: MoodBlushParameters = { ...card, ...draw.shape, cooldownMs: base.cooldownMs };
    // Whatever was drawn, the safety line holds (and the cooldown after it is never shorter than the card's).
    if (!blushProfileSafe(card, profile) || !(draw.cooldownMs >= card.cooldownMs)) {
      profile = { ...card, cooldownMs: base.cooldownMs };
      draw = { ...draw, shape: shapeOf(card), cooldownMs: Math.max(card.cooldownMs, finite(draw.cooldownMs, card.cooldownMs)), why: [...draw.why, '（兜底：这一次按卡上的形状）'] };
      fallback = true;
    }
    const token = this.nextDraw++;
    this.pending.clear();
    this.pending.set(token, { characterId, cardKey: blushCardKey(card), card: { ...card }, chance: { ...chance }, draw, ease, fallback });
    return { profile, thresholdScale: Number.isFinite(ease.scale) && ease.scale > 0 ? ease.scale : 1, draw: token };
  }

  settle(characterId: string, prepared: BlushPrepared, outcome: Readonly<BlushOutcome>): void {
    if (!prepared || prepared.draw === null) return;
    const pending = this.pending.get(prepared.draw);
    this.pending.delete(prepared.draw);
    if (!pending || pending.characterId !== characterId || !outcome?.cue) return;
    const { draw, chance, ease, card } = pending;
    this.locked.set(characterId, { cueId: outcome.cue.id, cardKey: pending.cardKey, shape: { ...draw.shape }, cooldownMs: draw.cooldownMs });
    this.history.set(characterId, [draw.look, ...(this.history.get(characterId) ?? [])].slice(0, Math.max(1, this.knobs.recent.length)));
    const why = [...draw.why];
    const total = round1(finite(outcome.total, 0)), rise = round1(finite(outcome.rise, 0));
    if (chance.contact === 'words') why.push(`${BLUSH_CONTACT_WORDS.words}，亲近涨了 ${rise}`);
    else {
      why.push(`${BLUSH_CONTACT_WORDS[chance.contact]}，亲近一下子涨了 ${total}`);
      const threshold = finite(chance.threshold, 0);
      // Only when it mattered: the card's own threshold would not have been reached yet.
      if (ease.scale < 1 - EPS && outcome.total < threshold - EPS && ease.easier.length)
        why.push(`${ease.easier.join('、')}：涨够 ${round1(threshold * ease.scale)} 就红了（卡上要涨够 ${round1(threshold)}）`);
    }
    why.push(...draw.cooldownWhy);
    this.log.unshift({ characterId, at: finite(chance.at, 0), contact: chance.contact, look: draw.label, why,
      shape: blushShapeText(card, draw.shape), cooldownMs: draw.cooldownMs, weights: draw.weights });
    this.log.splice(KEEP * 8);
  }

  recent(characterId: string): readonly BlushWhy[] {
    return this.log.filter(entry => entry.characterId === characterId).slice(0, KEEP)
      .map(({ characterId: _, ...entry }) => ({ ...entry, why: [...entry.why] }));
  }
}

/**
 * How deep the procedural blush (painted on the cheeks, for models without their own blush morph, like Gene) is drawn for a
 * blush amount (0–1). A pale face with a short, light blush showed almost nothing, so the light end is
 * lifted: 1 − (1 − amount)^boost. The order and the ends stay (0 → 0, 1 → 1); boost 1 is the amount unchanged.
 */
export function proceduralBlushDepth(amount: number, boost: number = BLUSH_KNOBS.procedural.boost): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const a = Math.min(1, amount), b = Number.isFinite(boost) ? Math.max(1, boost) : 1;
  return b === 1 ? a : 1 - Math.pow(1 - a, b);
}
