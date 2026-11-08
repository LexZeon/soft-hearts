/**
 * #8 的真实现：每一轮"你不理她"开始时，她来挑这一轮的节奏，再在角色卡的值附近抽宽限、涨速和三个门槛
 * （接口见 interface.ts，旋钮见 knobs.ts）。纯本地、零额度、不碰聊天提示词；只在内存里记最近几轮。
 *
 * 安全线（boredomRulesNoEarlier，不是旋钮）：
 *  - "动一下"和"开口"永远不早于卡上原来的时刻（主机真的发出的那一刻，不只是无聊到门槛的那一刻）。开口：用户要求不能比
 *    现在更早开口打扰；动一下：内心循环可能在"动一下"时问一次模型（electron/inner-loop/），早了就可能多问一次（额度 0）。
 *    "看你一眼"不说话、不问模型，可以早一点。
 *  - 做法（Codex T-207 之后，2026-11-04）：
 *    1. 宽限不短于卡上的、涨速不快于卡上的。这样同样的事（聊天、喂点心、在场、重新打开、中途改卡）发生在同样的时刻，
 *       她的无聊在任何时刻都不比卡上的多：涨得不比卡上早、不比卡上快，减掉的一样多。所以上一轮剩下的无聊不会比卡上的多
 *       （T-207 3B：原来涨得快的那一轮把多出来的无聊带进了下一轮），中途改卡、两条宽限都已经过了也不会涨得更快（3D）。
 *    2. 动一下、开口的门槛至少比卡上的高"卡上涨速 × 一次提示占多久（attentionMs）+ 1 秒"。卡上自己的"看你一眼"提示
 *       （和动一下的提示）会把卡上的动一下（和开口）压后最多一个提示的时长；她的看你一眼落在别的时刻时，就压不住她了（3A）。
 *       她的无聊不比卡上多、门槛又高出这么多，她到门槛时，卡上到门槛已经至少这么久，卡上那一次一定已经发出去了。
 *       上一轮剩下的无聊已经到了动一下的门槛时（下面的 shifting = false），这一轮整组照卡上的五个数，不用这一条。
 *  - 动一下和开口一起往后挪同样多（两者之间隔多久照卡上的）。为什么：内心循环在动一下时最多每 2 × 小动作间隔问一次模型、
 *    开口时每次都问，间隔一变，两者的先后就会错开，一轮里可能多问一次（第一版各抽各的，tests/inner-loop-day.test.ts 的
 *    90 分钟里从 6 次变成 7 次）。一起挪，动一下和开口的整串时机就是卡上那一串往后推，问模型的次数只会一样或更少。
 *    涨速不变的一轮里，在场减掉的无聊让动一下和开口一起再往后推同样多，间隔照旧（T-207 3C：原来在场后把涨得快的那一轮
 *    压回卡上的涨速、门槛不变，间隔被拉长到超过内心循环的 10 分钟，多问了一次）。
 *  - 主动开口的冷却（frequency.speechIntervalMs）、每小时上限（speechPerHour）、没人回就不再说（speechWithoutReply）、
 *    深夜和困了安静（shared/inner-loop.ts innerLoopQuiet）、你在打字或她在说话时不开口（electron/main.ts companionCanExpress）
 *    都在下游，这里一个也不碰：rules() 只换 boredom 那五个数。
 */
import { sheChooses, type SheChoosesCandidate, type SheChose } from '../../she-chooses';
import { MOOD_LABELS } from '../../mood-runtime';
import { tendencyNow } from '../../mood-tendency';
import type { MoodLabel, MoodSnapshot, MoodTendency } from '../../mood';
import type { FatiguePhase } from '../../fatigue';
import { BOREDOM_TEMPO_IDS, BOREDOM_TIMING_KNOBS, type BoredomMoment, type BoredomTempoId, type BoredomTempoKnob, type BoredomTimingKnobs } from './knobs';
import type { BoredomIdle, BoredomKind, BoredomRules, BoredomTimingHost, BoredomTimingNow, BoredomTimingWhy } from './interface';

const MINUTE = 60_000;
/** 和 shared/mood.ts validateMoodParameters 的范围一样：抽出来的永远是一组合法的参数。 */
const MAX_GRACE_MS = 120 * MINUTE;
const MAX_PER_MINUTE = 20;
const EPS = 1e-9;
/** 主机一秒一拍（electron/main.ts 的 mood tick）：一次提示占多久之外再留一拍，免得卡在拍子边上。 */
const TICK_MINUTES = 1 / 60;
/** 一次看你 / 动一下 / 开口的提示占多久（MoodParameters.interaction.attentionMs），加一拍，换成分钟（安全线第 2 条）。 */
export const boredomHoldMinutes = (attentionMs: unknown): number => Math.max(0, finite(attentionMs, 0)) / MINUTE + TICK_MINUTES;
export const BOREDOM_KINDS: readonly BoredomKind[] = ['look', 'motion', 'speech'];
const KEY: Readonly<Record<BoredomKind, 'lookAt' | 'motionAt' | 'speechAt'>> = { look: 'lookAt', motion: 'motionAt', speech: 'speechAt' };
const KIND_WORDS: Readonly<Record<BoredomKind, string>> = { look: '看你', motion: '动一下', speech: '开口' };
const TENDENCIES: readonly MoodTendency[] = ['playful', 'close', 'comfortable', 'cautious'];
/** "这会儿……"：心情快照里最强的那项倾向（和 #11 同样的说法）。 */
const NOW_WORDS: Readonly<Record<MoodTendency | 'wistful', string>> = {
  playful: '这会儿有点调皮', close: '这会儿想黏着你', comfortable: '这会儿很放松', cautious: '这会儿有点拘谨', wistful: '还在想念的余韵里',
};
/** 角色卡性格：高于一般 / 低于一般。 */
const PERSONALITY_WORDS: Readonly<Record<MoodTendency, readonly [string, string]>> = {
  playful: ['性格：爱玩', '性格：不太爱玩'], close: ['性格：黏人', '性格：不太黏人'],
  comfortable: ['性格：随和', '性格：不太随和'], cautious: ['性格：慢热', '性格：不怕生'],
};
/**
 * 动一下比"和开口一起挪"再晚 1 秒。卡上默认的开口正好落在第二个"会叫醒内心循环的动一下"那一刻，两者同一拍时开口优先、
 * 那次动一下就不再问模型；一起挪之后两者有时会恰好卡在拍子边上，浮点误差能让动一下抢先一拍，多叫醒一次（测试抓到过）。
 * 晚 1 秒，开口就总在那一拍或之前。只会更晚，安全线不受影响。
 */
const MOTION_LAG_MINUTES = 1 / 60;
/** 前几轮留几轮（只在内存）。 */
const KEEP_ROUNDS = 3;
/** 每种时机记最近几次真的发生的分钟数。 */
const KEEP_MINUTES = 3;

const finite = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const unit = (value: unknown): number => Math.min(1 - 1e-12, Math.max(0, finite(value, 0)));
const lerp = ([low, high]: readonly [number, number], t: number): number => finite(low, 1) + (finite(high, 1) - finite(low, 1)) * t;
/** 一位小数，给人看。 */
export const minuteText = (minutes: number): string => String(Math.round(minutes * 10) / 10);
const round1 = (value: number): number => Math.round(value * 10) / 10;

/** MoodHost 交给"此刻"的原料。 */
export interface BoredomTimingNowInput {
  /** tendencies：倾向够不够强才算"这会儿……"（shared/mood-tendency.ts）；没给时 companion 照原样算。 */
  readonly snapshot: Pick<MoodSnapshot, 'primary' | 'companion'> & { readonly tendencies?: Partial<Record<MoodTendency, number>> };
  /** 角色卡性格（MoodParameters.weights）。 */
  readonly personality: Partial<Record<MoodTendency, number>> | null | undefined;
  readonly fatiguePhase: FatiguePhase | null | undefined;
}

/** 把主机手里的东西整理成"此刻"。 */
export function boredomTimingNow(input: BoredomTimingNowInput): BoredomTimingNow {
  const s = input.snapshot;
  const mood = (Object.hasOwn(MOOD_LABELS, s.primary) ? s.primary : 'calm') as MoodLabel;
  // Only a tendency that is really there (回到基线时那一丝不算): the why says only what comes from her state now.
  const tendency = tendencyNow(s);
  const personality = Object.fromEntries(TENDENCIES.map(t => [t, clamp(finite(input.personality?.[t], 1), 0, 4)])) as Record<MoodTendency, number>;
  const moments: BoredomMoment[] = [];
  if (input.fatiguePhase === 'light-drowsy') moments.push('tired');
  if (input.fatiguePhase === 'drowsy' || input.fatiguePhase === 'falling-asleep' || input.fatiguePhase === 'asleep' || input.fatiguePhase === 'micro-awake') moments.push('sleepy');
  return { mood, tendency, personality, moments };
}

/**
 * 从这一轮开始算第几分钟无聊到 `threshold`：这一轮已经过了 `idleMinutes` 分钟、此刻无聊 `boredom`（新的一轮：0 分钟、
 * 上一轮剩下的无聊）。已经到了 = idleMinutes；null = 永远不会（卡上无聊不涨）。和 shared/mood.ts advanceMood 的算法一样。
 */
export function boredomMinute(rules: Pick<BoredomRules, 'graceMs' | 'perMinute'>, threshold: number, boredom = 0, idleMinutes = 0): number | null {
  if (boredom >= threshold) return idleMinutes;
  if (!(rules.perMinute > 0)) return null;
  return idleMinutes + Math.max(0, rules.graceMs / MINUTE - idleMinutes) + (threshold - boredom) / rules.perMinute;
}
/** 反过来：要在第 `minute` 分钟无聊到门槛，门槛是多少（不夹）。 */
function thresholdAt(rules: Pick<BoredomRules, 'graceMs' | 'perMinute'>, minute: number, boredom: number, idleMinutes: number): number {
  return boredom + rules.perMinute * (minute - idleMinutes - Math.max(0, rules.graceMs / MINUTE - idleMinutes));
}

/**
 * 安全线：`drawn` 不会让"动一下"和"开口"比 `card` 更早（主机真的发出的时刻），而且是一组合法的参数
 * （和 validateMoodParameters 同样的范围，三个门槛从低到高）。
 *  1. 宽限不短于卡上的、涨速不快于卡上的：她的无聊在任何时刻都不比卡上的多（不管上一轮剩下多少、中途在场、改卡）。
 *  2. 动一下、开口的门槛比卡上的至少高 卡上涨速 × `holdMinutes`（boredomHoldMinutes(attentionMs)：卡上自己的提示会把它们
 *     压后这么久）。只有五个数全都和卡上的一模一样时（这一轮就是卡上的那一串）才可以不高出。
 * 推理见文件头；tests/boredom-timing.test.ts 和 tests/boredom-timing-t207.test.ts 拿随机的卡、心情、剩下的无聊、中途在场、
 * 聊天和改卡去试，并在真的主机上和卡上的值比真的发出的时刻、问模型的次数。
 */
export function boredomRulesNoEarlier(card: Readonly<BoredomRules>, drawn: Readonly<BoredomRules>, holdMinutes = 0): boolean {
  const ok = (n: unknown, low: number, high: number) => typeof n === 'number' && Number.isFinite(n) && n >= low && n <= high;
  if (!drawn || !ok(drawn.graceMs, 0, MAX_GRACE_MS) || !ok(drawn.perMinute, 0, MAX_PER_MINUTE)
    || !ok(drawn.lookAt, 0, 100) || !ok(drawn.motionAt, 0, 100) || !ok(drawn.speechAt, 0, 100)) return false;
  if (drawn.lookAt > drawn.motionAt + EPS || drawn.motionAt > drawn.speechAt + EPS) return false;
  if (drawn.graceMs < card.graceMs - EPS || drawn.perMinute > card.perMinute + EPS) return false;
  // Exactly the card: the same moments as the card.
  if (drawn.graceMs === card.graceMs && drawn.perMinute === card.perMinute && drawn.lookAt === card.lookAt
    && drawn.motionAt === card.motionAt && drawn.speechAt === card.speechAt) return true;
  const margin = card.perMinute * Math.max(0, finite(holdMinutes, 0));
  return drawn.motionAt >= card.motionAt + margin - EPS && drawn.speechAt >= card.speechAt + margin - EPS;
}

/** 一个节奏此刻的理由：心情、这会儿的倾向、角色卡性格、此刻发生的事。 */
function leanReasons(knob: BoredomTempoKnob, now: Readonly<BoredomTimingNow>, knobs: BoredomTimingKnobs) {
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

function tempoCandidates(knobs: BoredomTimingKnobs): SheChoosesCandidate<BoredomTempoId, BoredomTimingNow>[] {
  return BOREDOM_TEMPO_IDS.map(id => ({ id, label: knobs.tempos[id].label,
    weigh: now => ({ base: knobs.tempos[id].base, reasons: leanReasons(knobs.tempos[id], now, knobs) }) }));
}

/** 最近几轮真的发生过的（最新的在前）：节奏，和每种时机的分钟数。 */
export interface BoredomHistory {
  readonly tempos: readonly BoredomTempoId[];
  readonly minutes: Readonly<Record<BoredomKind, readonly number[]>>;
}
export const EMPTY_BOREDOM_HISTORY: BoredomHistory = Object.freeze({ tempos: [], minutes: { look: [], motion: [], speech: [] } });

/** 一轮抽出来的东西。 */
export interface BoredomRound {
  readonly rules: BoredomRules;
  readonly tempo: BoredomTempoId;
  readonly tempoLabel: string;
  readonly plan: Readonly<Record<BoredomKind, number | null>>;
  readonly why: readonly string[];
  readonly weights: string;
}

export function boredomPlan(rules: Readonly<BoredomRules>, boredom: number, idleMinutes: number): Record<BoredomKind, number | null> {
  const at = (kind: BoredomKind) => { const m = boredomMinute(rules, rules[KEY[kind]], boredom, idleMinutes); return m === null ? null : round1(m); };
  return { look: at('look'), motion: at('motion'), speech: at('speech') };
}
export function boredomRulesText(rules: Readonly<BoredomRules>): string {
  return `宽限 ${minuteText(rules.graceMs / MINUTE)} 分 · 每分钟 +${Math.round(rules.perMinute * 100) / 100} · 门槛 看你 ${minuteText(rules.lookAt)} / 动一下 ${minuteText(rules.motionAt)} / 开口 ${minuteText(rules.speechAt)}`;
}
const weightLine = (chose: SheChose<string> | null) => chose ? chose.weights.map(w => `${w.label} ${w.weight}`).join(' · ') : '';

/**
 * 抽一轮：节奏一次（她来挑），再在节奏的范围里定宽限、涨速、看你的门槛，和"动一下、开口比卡上晚多少"——两个一起晚同样多，
 * 两者之间隔多久照卡上的（内心循环被叫醒的次数跟着这个间隔，见文件头）；然后和上一次真的发生的那次挪开、守住安全线。
 * 每次正好取 5 个随机数，顺序固定（节奏、宽限、涨速、看你、晚多少），所以改一个旋钮只影响它管的那一处
 * （tests/boredom-timing.test.ts 的"一个旋钮"测试）。
 * `idle`：这一轮此刻的无聊和已经过了几分钟（新的一轮 = 上一轮剩下的无聊、0 分钟）；`holdMinutes` = boredomHoldMinutes(卡上的
 * attentionMs)，没给时只留一拍（安全线第 2 条）。
 */
export function drawBoredomRound(card: Readonly<BoredomRules>, now: Readonly<BoredomTimingNow> | null,
  idle: { readonly boredom: number; readonly idleMinutes: number; readonly holdMinutes?: number },
  history: BoredomHistory, random: () => number, knobs: BoredomTimingKnobs = BOREDOM_TIMING_KNOBS): BoredomRound {
  const chose = now ? sheChooses({ candidates: tempoCandidates(knobs), now, random, recent: history.tempos, recentFactors: knobs.recent }) : (random(), null);
  const uGrace = unit(random()), uPace = unit(random()), uLook = unit(random()), uLater = unit(random());
  const tempo: BoredomTempoId = chose?.id ?? 'usual', t = knobs.tempos[tempo];
  const why: string[] = [chose ? `${chose.label}——${chose.why.join('；')}`
    : now ? `${t.label}——几种节奏的分量都是 0（看旋钮），按照常` : `${t.label}——没读到此刻的心情，按照常`];
  const b0 = clamp(finite(idle.boredom, 0), 0, 100), i0 = Math.max(0, finite(idle.idleMinutes, 0));
  const hold = Math.max(TICK_MINUTES, finite(idle.holdMinutes, TICK_MINUTES));
  if (b0 >= 0.5) why.push(`上一轮剩下的无聊还有 ${Math.round(b0)}，这一轮从这里开始涨`);
  const done = (rules: BoredomRules): BoredomRound => ({ rules, tempo, tempoLabel: t.label, plan: boredomPlan(rules, b0, i0), why, weights: weightLine(chose) });
  if (!(card.perMinute > 0)) { why.push('这张卡的无聊不涨（每分钟 +0），她不会因为无聊来找你'); return done({ ...card }); }

  // 上一轮剩下的无聊已经到了动一下的门槛（卡上这时马上就会动一下）：这一轮照卡上的五个数。
  // 不然动一下照样马上来、开口却挪了，两者之间的间隔一变，内心循环就可能多醒一次（tests/inner-loop-day.test.ts 抓到过）。
  // 看你一眼这时也已经到了（门槛不高于动一下的），浮动它看不出来，却会让卡上的提示和她的提示落在不同的时刻（T-207 3A 那一类），
  // 所以也照卡上的。卡上门槛为 0 的那一项本来就"随时"，同样照原样。
  const shifting = card.motionAt > 0 && b0 < card.motionAt;
  if (!shifting) {
    why.push(card.motionAt > 0 ? '剩下的无聊已经到了动一下的门槛：这一轮照卡上的值' : '卡上动一下的门槛是 0（随时）：这一轮照卡上的值');
    return done({ ...card });
  }
  // 宽限和涨速：宽限不短于卡上的，涨速不快于卡上的（安全线第 1 条：她的无聊在任何时刻都不比卡上的多）。
  const graceMs = Math.min(MAX_GRACE_MS, Math.max(card.graceMs, card.graceMs * lerp(t.grace, uGrace)));
  const g = graceMs / MINUTE, apart = Math.max(0, finite(knobs.apartMinutes, 0));
  // 旋钮 pace 超过 1 的部分不让无聊涨得更快，只让"看你一眼"早同样的比例（门槛 ÷ pace，下面 lookWanted）：从零开始时看你的时刻
  // 和原来"涨得快的那轮"一样，动一下、开口照安全线。
  const pace = Math.max(0.05, lerp(t.pace, uPace));
  const perMinute = card.perMinute * Math.min(1, pace);
  // 其余的动一下、开口一起往后挪。
  const tM = boredomMinute(card, card.motionAt)!, tS = boredomMinute(card, card.speechAt)!;
  const base = { graceMs, perMinute };
  // 晚多少：门槛至少比卡上的高 卡上涨速 × hold（lo；安全线第 2 条），开口门槛不能超过 100（hi）。
  const margin = card.perMinute * hold;
  const floorShift = (extra: number) => Math.max(0, (card.motionAt + extra) / perMinute + g - tM, (card.speechAt + extra) / perMinute + g - tS);
  const slow = floorShift(0), lo = floorShift(margin);
  const hi = Math.max(lo, 100 / perMinute + g - tS);
  const wanted = tS * Math.max(0, lerp(t.later, uLater));
  let later = clamp(wanted, lo, hi);
  if (wanted < slow - 0.05) why.push(`这一轮涨得慢：动一下、开口的门槛不能低于卡上的，所以都晚 ${minuteText(later)} 分钟`);
  else if (wanted < lo - 0.05) why.push(`卡上看你一眼、动一下的提示各占 ${Math.round((hold - TICK_MINUTES) * 600) / 10} 秒，所以动一下、开口至少比卡上晚这么久（再多一拍）`);
  else if (wanted > hi + 0.05) why.push(`开口门槛最多到 100，所以只晚 ${minuteText(later)} 分钟`);
  const lookWanted = clamp(card.lookAt * lerp(knobs.look, uLook) / Math.max(1, pace), 0, 100);
  const make = (shift: number, lookAt = lookWanted): BoredomRules => {
    const motionAt = clamp(thresholdAt(base, tM + shift + MOTION_LAG_MINUTES, 0, 0), card.motionAt + margin, 100);
    const speechAt = clamp(Math.max(thresholdAt(base, tS + shift, 0, 0), motionAt), card.speechAt + margin, 100);
    return { graceMs, perMinute, lookAt: Math.min(lookAt, motionAt), motionAt, speechAt };
  };
  let rules = make(later);

  // 和上一次真的发生的那次挪开：动一下和开口一起挪（间隔不变），看你一眼单独挪。
  const minuteOf = (r: BoredomRules, kind: BoredomKind) => boredomMinute(r, r[KEY[kind]], b0, i0);
  const tooClose = (r: BoredomRules, kinds: readonly BoredomKind[]) => kinds.filter(kind => {
    const last = history.minutes[kind]?.[0], m = minuteOf(r, kind);
    return last !== undefined && Number.isFinite(last) && m !== null && m > i0 + EPS && Math.abs(m - last) < apart - 1e-6;
  });
  const pair = ['motion', 'speech'] as const;
  const near = tooClose(rules, pair);
  if (near.length) {
    const options = [later];
    for (const kind of pair) {
      const last = history.minutes[kind]?.[0], m = minuteOf(rules, kind);
      if (last !== undefined && Number.isFinite(last) && m !== null) options.push(later + last + apart - m, later + last - apart - m);
    }
    const fits = options.filter(x => x >= lo - 1e-9 && x <= hi + 1e-9).map(x => ({ x, r: make(x) }))
      .filter(o => !tooClose(o.r, pair).length && boredomRulesNoEarlier(card, o.r, hold)).sort((a, b) => Math.abs(a.x - later) - Math.abs(b.x - later));
    if (fits.length) { later = fits[0].x; rules = fits[0].r; }
    for (const kind of near) why.push(fits.length
      ? `上次${KIND_WORDS[kind]}在第 ${minuteText(history.minutes[kind][0])} 分钟，这次避开（第 ${minuteText(minuteOf(rules, kind)!)} 分钟）`
      : `上次${KIND_WORDS[kind]}在第 ${minuteText(history.minutes[kind][0])} 分钟，这次范围太窄，没能避开`);
  }
  const lastLook = history.minutes.look?.[0];
  if (tooClose(rules, ['look']).length && lastLook !== undefined) {
    const m = minuteOf(rules, 'look')!, graceEnd = i0 + Math.max(0, g - i0);
    let moved = false;
    for (const target of m >= lastLook ? [lastLook + apart, lastLook - apart] : [lastLook - apart, lastLook + apart]) {
      if (target <= graceEnd + 0.05) continue;
      const k = clamp(thresholdAt(rules, target, b0, i0), 0, 100);
      if (k > rules.motionAt) continue;
      const trial = { ...rules, lookAt: k }, landed = minuteOf(trial, 'look');
      if (landed === null || Math.abs(landed - lastLook) < apart - 1e-6) continue;
      rules = trial; moved = true;
      why.push(`上次看你在第 ${minuteText(lastLook)} 分钟，这次避开（第 ${minuteText(landed)} 分钟）`);
      break;
    }
    if (!moved) why.push(`上次看你在第 ${minuteText(lastLook)} 分钟，这次范围太窄，没能避开`);
  }
  if (!boredomRulesNoEarlier(card, rules, hold)) { why.push('（兜底：这一轮按卡上的值）'); return done({ ...card }); }
  return done(rules);
}

interface Round {
  cardKey: string;
  card: BoredomRules;
  startedAt: number;
  lastIdleMs: number;
  tempo: BoredomTempoId;
  tempoLabel: string;
  weights: string;
  rules: BoredomRules;
  plan: Record<BoredomKind, number | null>;
  happened: Partial<Record<BoredomKind, number>>;
  why: string[];
  recorded: boolean;
  replan: boolean;
  relievedNoted?: boolean;
}
interface History { tempos: BoredomTempoId[]; minutes: Record<BoredomKind, number[]> }

export const boredomCardKey = (card: Readonly<BoredomRules>): string => [card.graceMs, card.perMinute, card.lookAt, card.motionAt, card.speechAt].join('|');

/** 真实现（接口见 interface.ts BoredomTimingHost）。 */
export class BoredomTimingDirector implements BoredomTimingHost {
  private readonly rounds = new Map<string, Round>();
  private readonly history = new Map<string, History>();
  private readonly log: (BoredomTimingWhy & { characterId: string })[] = [];
  private readonly knobs: BoredomTimingKnobs;
  private readonly random: () => number;

  constructor(options: { knobs?: BoredomTimingKnobs; random?: () => number } = {}) {
    this.knobs = options.knobs ?? BOREDOM_TIMING_KNOBS;
    this.random = options.random ?? Math.random;
  }

  rules(characterId: string, card: Readonly<BoredomRules>, idle: Readonly<BoredomIdle>, now: () => BoredomTimingNow | null): Readonly<BoredomRules> {
    if (typeof characterId !== 'string' || !characterId) return { ...card };
    // How long one prompt holds the next back is part of the card (a changed attentionMs starts a new round, like the five numbers).
    const hold = boredomHoldMinutes(idle.holdMs);
    const key = `${boredomCardKey(card)}|${hold}`, idleMs = Math.max(0, finite(idle.idleMs, 0)), current = this.rounds.get(characterId);
    if (current && current.cardKey === key && idleMs >= current.lastIdleMs) {
      current.lastIdleMs = idleMs;
      if (current.replan) { current.plan = boredomPlan(current.rules, finite(idle.boredom, 0), idleMs / MINUTE); current.replan = false; }
      return current.rules;
    }
    if (current) this.finish(characterId, current);
    let moment: BoredomTimingNow | null = null;
    try { moment = now(); } catch { moment = null; }
    let drawn: BoredomRound;
    try { drawn = drawBoredomRound(card, moment, { boredom: idle.boredom, idleMinutes: idleMs / MINUTE, holdMinutes: hold }, this.historyOf(characterId), this.random, this.knobs); }
    catch { drawn = { rules: { ...card }, tempo: 'usual', tempoLabel: this.knobs.tempos.usual.label, plan: boredomPlan(card, finite(idle.boredom, 0), idleMs / MINUTE), why: ['（出错兜底：这一轮按卡上的值）'], weights: '' }; }
    // Whatever was drawn, the safety line holds.
    const rules = boredomRulesNoEarlier(card, drawn.rules, hold) ? drawn.rules : { ...card };
    const why = [...drawn.why];
    if (rules !== drawn.rules) why.push('（兜底：这一轮按卡上的值）');
    if (current && current.cardKey !== key) why.push('卡上的无聊参数变了，从这里重新抽');
    else if (!current && idleMs > 0) why.push(`刚见到这个角色，这一轮已经过了 ${minuteText(idleMs / MINUTE)} 分钟`);
    this.rounds.set(characterId, { cardKey: key, card: { ...card }, startedAt: finite(idle.at, 0) - idleMs, lastIdleMs: idleMs, tempo: drawn.tempo, tempoLabel: drawn.tempoLabel, weights: drawn.weights,
      rules: Object.freeze({ ...rules }), plan: rules === drawn.rules ? { ...drawn.plan } : boredomPlan(rules, finite(idle.boredom, 0), idleMs / MINUTE),
      happened: {}, why, recorded: false, replan: false });
    return this.rounds.get(characterId)!.rules;
  }

  happened(characterId: string, kind: BoredomKind, at: number): void {
    const round = this.rounds.get(characterId);
    if (!round || !BOREDOM_KINDS.includes(kind) || !Number.isFinite(at) || round.happened[kind] !== undefined) return;
    const minute = Math.max(0, (at - round.startedAt) / MINUTE);
    round.happened[kind] = round1(minute);
    const history = this.historyOf(characterId);
    history.minutes[kind] = [minute, ...history.minutes[kind]].slice(0, KEEP_MINUTES);
    if (!round.recorded) {
      round.recorded = true;
      history.tempos = [round.tempo, ...history.tempos].slice(0, Math.max(1, this.knobs.recent.length));
    }
  }

  relieved(characterId: string): void {
    const round = this.rounds.get(characterId);
    if (!round) return;
    // The rate is never above the card's (safety line 1), so a relief changes no number: what is still ahead moves later
    // together, by the same amount, and the gap between motion and speech stays the card's (T-207 3C).
    round.replan = true;
    if (round.relievedNoted) return;
    round.relievedNoted = true;
    round.why.push('你回到电脑前，她没那么无聊了：还没到的动一下、开口一起往后推（间隔照旧）');
  }

  recent(characterId: string): readonly BoredomTimingWhy[] {
    const out: BoredomTimingWhy[] = [];
    const round = this.rounds.get(characterId);
    if (round) out.push(this.entry(round, true));
    for (const entry of this.log) {
      if (out.length > KEEP_ROUNDS) break;
      if (entry.characterId !== characterId) continue;
      const { characterId: _, ...rest } = entry;
      out.push({ ...rest, plan: { ...rest.plan }, happened: { ...rest.happened }, why: [...rest.why] });
    }
    return out;
  }

  private entry(round: Round, current: boolean): BoredomTimingWhy {
    return { startedAt: round.startedAt, current, tempo: round.tempoLabel, plan: { ...round.plan }, happened: { ...round.happened },
      why: [...round.why], rules: boredomRulesText(round.rules), weights: round.weights };
  }

  /** A round that ended: kept for the panel only when something in it really happened. */
  private finish(characterId: string, round: Round): void {
    if (!Object.keys(round.happened).length) return;
    this.log.unshift({ characterId, ...this.entry(round, false) });
    this.log.splice(KEEP_ROUNDS * 8);
  }

  private historyOf(characterId: string): History {
    let history = this.history.get(characterId);
    if (!history) { history = { tempos: [], minutes: { look: [], motion: [], speech: [] } }; this.history.set(characterId, history); }
    return history;
  }
}
