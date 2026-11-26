/**
 * I-175 嘴：表情定底形，口型在底形上开合（interface.ts 头注；方案 docs/claude/2026-11-22-i175-mixer-plan.md「嘴（这次的核心）」）。
 *
 * 改前：她说话（或快要说话）时，表情里所有嘴上的形状一起让开（窗口 window-expression.ts 的 mouthFree），所以边念边撅嘴看不到撅嘴。
 * 改后，嘴上的每个形态分三类（mouthRoleOfSlot / mouthRoleOfName）：
 *  - 嘴形（撅、嘟、笑、嘴角、收窄）：底形，说话时照样挂着；
 *  - 开合（あいうえお、张嘴、下巴）：说话时让给口型（缓缓，knobs.talkEaseOmega），口型在底形上开合；
 *  - 闭嘴类（鼓腮、吐舌、亲）：说话时让开，排到停顿（closed-mouth.ts）。
 * 口型的幅度按底形打折：底形满（knobs.mouthBaseFull）时留 knobs.mouthTalkThrough（0.6），没有底形时和平时一样；中间连续，嘴从不停住。
 * 口型的元音跟着底形偏：撅 → う（没有就 お），笑 → い（没有就 え），别的 → あ；模型缺那个口型时那一份回到 あ。中间连续，不跳。
 * 纯的：不碰 three.js，不碰时钟。
 */
import { PART_MIX_KNOBS, type PartMixKnobs } from './knobs';
import { VOWELS, type MouthBase, type MouthRole, type TalkThroughMouth, type Vowel, type VowelWeights } from './interface';

const clamp01 = (value: number) => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
const smoothstep = (value: number) => { const t = clamp01(value); return t * t * (3 - 2 * t); };

/** The universal expression slots that are mouth parts (shared/foundation/universal-skeleton.ts MORPH_SLOTS); others are not the mouth's. */
const SLOT_ROLES: Readonly<Record<string, MouthRole>> = Object.freeze({ a: 'opening', i: 'opening', u: 'opening', e: 'opening', o: 'opening', mouthPucker: 'shape', mouthSmile: 'shape' });
export function mouthRoleOfSlot(slot: string): MouthRole | null { return Object.hasOwn(SLOT_ROLES, slot) ? SLOT_ROLES[slot] : null; }

const CLOSED = /cheek|頬|ぷく|tongue|舌|kiss|ちゅ/iu;
const OPENING = /jaw|open|^(?:[あいうえおアイウエオ]|aa|ih|ou|ee|oh)$/iu;
const SHAPE = /mouth|口|lip|pucker|funnel|smile|frown/iu;
/**
 * A named face shape (one key of the face's named shapes: alternatives joined by '|', first found on the model wins) by its first name:
 * a cheek puff, a tongue or a kiss is closed-mouth; a jaw, an open mouth or a vowel is the opening; any other mouth or lip shape is the
 * base shape; anything else (eyes, brows, a whole-face surprise) is not the mouth's (null).
 */
export function mouthRoleOfName(names: string): MouthRole | null {
  const first = String(names ?? '').split('|')[0].trim();
  if (!first) return null;
  if (CLOSED.test(first)) return 'closed';
  if (OPENING.test(first)) return 'opening';
  if (SHAPE.test(first)) return 'shape';
  return null;
}

/** How much of a mouth part shows while lip-sync owns the opening by `talk` (0..1, eased): a shape stays, the opening and a closed shape give way. */
export const talkFade = (role: MouthRole | null, talk: number): number => role === 'opening' || role === 'closed' ? 1 - clamp01(talk) : 1;

const PUCKER_NAME = /pucker|funnel|口横狭め|すぼめ/iu;
const SMILE_NAME = /smile|口角上げ|にっこり|にやり/iu;
/**
 * The mouth's base shape from this frame's expression (slot values and named shapes, BEFORE talking fades anything): how puckered, how
 * smiling, how strong. The vowels count too (a pout's う is its pout on a model without a pucker; a smile's い its smile), so the base reads
 * the same on every model. Values are clamped; nothing allocated besides the result.
 */
export function mouthBaseOf(slots: Readonly<Partial<Record<string, number>>> | null | undefined, named?: Readonly<Record<string, number>> | null): MouthBase {
  let pucker = Math.max(clamp01(slots?.mouthPucker ?? 0), clamp01(slots?.u ?? 0), 0.8 * clamp01(slots?.o ?? 0));
  let smile = Math.max(clamp01(slots?.mouthSmile ?? 0), clamp01(slots?.i ?? 0), 0.8 * clamp01(slots?.e ?? 0));
  let strength = Math.max(pucker, smile, clamp01(slots?.a ?? 0));
  if (named) for (const key of Object.keys(named)) {
    const value = clamp01(named[key]), role = mouthRoleOfName(key);
    if (!(value > 0) || role !== 'shape') continue;
    const first = key.split('|')[0];
    if (PUCKER_NAME.test(first)) pucker = Math.max(pucker, value);
    else if (SMILE_NAME.test(first)) smile = Math.max(smile, value);
    strength = Math.max(strength, value);
  }
  return { pucker, smile, strength: Math.max(strength, pucker, smile) };
}

export const NO_MOUTH_BASE: MouthBase = Object.freeze({ pucker: 0, smile: 0, strength: 0 });

/** Which vowel each lean prefers, then its fallback, then あ (the model lacks a morph: that share goes to the next, finally to あ). */
const LEANS: Readonly<Record<'pucker' | 'smile', readonly Vowel[]>> = Object.freeze({ pucker: ['u', 'o'], smile: ['i', 'e'] });

/**
 * How far each vowel parts the lips against あ when a model's own lips could not be measured (mouth-gap.ts): about what Gene, the converted
 * VRoid and One measure (い and え barely part the lips on all three: い 0.00–0.10, え 0.13–0.44, う 0.35–0.79, お 1.15–1.21 of あ).
 */
export const DEFAULT_OPENNESS: Readonly<Record<Vowel, number>> = Object.freeze({ a: 1, i: 0.1, u: 0.5, e: 0.25, o: 1 });

/**
 * This frame's lip-sync on top of the base: the amplitude scale, the vowel shares (sum 1), and how open that really is.
 *  - scale = 1 − the largest cut its parts ask: a pucker (or any other mouth shape) up to (1 − mouthTalkThrough), a smile up to
 *    (1 − smileTalkThrough), each by smoothstep(part / mouthBaseFull): 1 with no base, exactly mouthTalkThrough under a full pout, continuous
 *    between; never below the smaller talk-through (the mouth keeps moving while she speaks).
 *  - vowels: lean = smoothstep((pucker + smile) / vowelLeanFull); of the pucker's part up to puckerVowelMax goes to う (else お), of the smile's
 *    up to smileVowelMax to い (else え), the rest stays on あ (a blend, not a switch: い alone barely parts the lips). `has(v)`: the model has
 *    that vowel's morph (default all); a missing one's share falls back down the chain to あ.
 *  - the floor: `openness` is how far each vowel parts THIS model's lips against あ (mouth-gap.ts;
 *    null: DEFAULT_OPENNESS). open = scale × Σ share × openness; when it is under flapFloor, shares move back to あ (continuously) until it is
 *    not. So whatever the expression, her lips part at least flapFloor of an ordinary flap's.
 */
export function talkThroughMouth(base: MouthBase | null | undefined, has: (vowel: Vowel) => boolean = () => true, knobs: PartMixKnobs = PART_MIX_KNOBS,
  openness: Readonly<Record<Vowel, number>> | null = null): TalkThroughMouth {
  const pout = clamp01(knobs.mouthTalkThrough), smiling = clamp01(knobs.smileTalkThrough), full = knobs.mouthBaseFull > 0 ? knobs.mouthBaseFull : 1;
  const strength = clamp01(base?.strength ?? 0), pucker = clamp01(base?.pucker ?? 0), smile = clamp01(base?.smile ?? 0);
  const other = strength > Math.max(pucker, smile) + 1e-9 ? strength : 0; // a shape that is neither (corners down, a one-corner smirk)
  const cut = Math.max((1 - pout) * smoothstep(Math.max(pucker, other) / full), (1 - smiling) * smoothstep(smile / full));
  const scale = Math.max(Math.min(pout, smiling), 1 - cut);
  const vowels: VowelWeights = { a: 0, i: 0, u: 0, e: 0, o: 0 };
  const leanFull = knobs.vowelLeanFull > 0 ? knobs.vowelLeanFull : 1, total = pucker + smile;
  const lean = total > 0 ? smoothstep(total / leanFull) : 0;
  const give = (chain: readonly Vowel[], share: number) => { const vowel = chain.find(v => has(v)) ?? 'a'; vowels[vowel] += share; };
  let leaned = 0;
  if (lean > 0) {
    const p = lean * (pucker / total) * clamp01(knobs.puckerVowelMax), s = lean * (smile / total) * clamp01(knobs.smileVowelMax);
    give(LEANS.pucker, p); give(LEANS.smile, s); leaned = p + s;
  }
  vowels.a += 1 - leaned;
  const opens = openness ?? DEFAULT_OPENNESS;
  let mixed = 0;
  for (const vowel of VOWELS) mixed += vowels[vowel] * (vowel === 'a' ? 1 : Math.max(0, opens[vowel] ?? 1));
  const floor = clamp01(knobs.flapFloor);
  const floored = scale * mixed < floor && mixed < 1;
  if (floored) {
    const back = clamp01((floor / scale - mixed) / (1 - mixed));
    for (const vowel of VOWELS) vowels[vowel] *= 1 - back;
    vowels.a += back;
    mixed = mixed * (1 - back) + back;
  }
  return { scale, vowels, open: scale * mixed, floored };
}

/** The flap's peak (mouthTarget at the top of its swing, full hold): src/unbound/mouth.ts reads its own value from here. */
export const FLAP_PEAK = 0.68;

/**
 * Per-model calibration: `fullGap` is how far this model's あ at weight 1
 * parts its lips (face units, mouth-gap.ts). The flap is scaled so its peak parts them flapPeakGap (gain, between 0.5 and 1.6, and never so much
 * that the peak would sit at the top of the morph), and the shown opening never parts them more than flapGapCeiling (`gapCap`: the largest
 * gap, in face units, the caller keeps under). Unmeasured (null): gain 1, no cap (the flap as before).
 */
export function flapCalibration(fullGap: number | null | undefined, knobs: PartMixKnobs = PART_MIX_KNOBS): { gain: number; gapCap: number } {
  if (!(typeof fullGap === 'number' && Number.isFinite(fullGap) && fullGap > 1e-4)) return { gain: 1, gapCap: Infinity };
  const wanted = knobs.flapPeakGap > 0 ? knobs.flapPeakGap / (fullGap * FLAP_PEAK) : 1;
  const gain = Math.min(1.6, 0.95 / FLAP_PEAK, Math.max(0.5, wanted));
  return { gain, gapCap: knobs.flapGapCeiling > 0 ? knobs.flapGapCeiling : Infinity };
}

/** The shares as the mouth writes them: each vowel's share of `open` (a share under 0.002 of a full opening is nothing). */
export function vowelOpenings(open: number, mouth: TalkThroughMouth, out: VowelWeights = { a: 0, i: 0, u: 0, e: 0, o: 0 }): VowelWeights {
  const value = clamp01(open);
  for (const vowel of VOWELS) { const v = value * (mouth.vowels[vowel] ?? 0); out[vowel] = v < 0.002 ? 0 : v; }
  return out;
}

/**
 * Feeding vs lip-sync (the companion's rule, copied from src/stage/channel-compositors.ts composeMouth so the Unbound engine keeps it when the
 * old stage goes, I-176): the shown opening cross-fades from speech to the feeding opening by feeding's eased weight, never below the
 * feeding opening itself.
 */
export function composeFeedMouth(lipSync: number, feeding: number, feedWeight: number): number {
  const lip = clamp01(lipSync), feed = clamp01(feeding), mix = smoothstep(feedWeight);
  return Math.max(feed, lip * (1 - mix) + feed * mix);
}

/**
 * The eased "lip-sync owns the opening" weight (0..1): critically damped toward 1 while she speaks, 0 otherwise, so the expression's open
 * mouth hands over to the flap and back without a jump at any frame rate. Allocation-free.
 */
export class TalkEase {
  private value = 0;
  private velocity = 0;
  constructor(private readonly knobs: PartMixKnobs = PART_MIX_KNOBS) {}
  get talk(): number { return this.value; }
  frame(dt: number, talking: boolean): number {
    const step = Number.isFinite(dt) ? Math.min(0.25, Math.max(0, dt)) : 0;
    if (step <= 0) return this.value;
    const goal = talking ? 1 : 0, omega = this.knobs.talkEaseOmega > 0 ? this.knobs.talkEaseOmega : 14;
    const x0 = this.value - goal, j = this.velocity + omega * x0, e = Math.exp(-omega * step);
    this.value = clamp01(goal + (x0 + j * step) * e);
    this.velocity = (this.velocity - omega * j * step) * e;
    if (!talking && this.value < 1e-4) { this.value = 0; this.velocity = 0; }
    return this.value;
  }
  reset(): void { this.value = 0; this.velocity = 0; }
}
