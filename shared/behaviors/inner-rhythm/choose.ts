/**
 * 内心循环的节奏（I-013，L1）：纯函数，不碰时钟和随机源（调用方交进来），好单独测。
 * 把"两次问小模型之间最短隔多久"从固定的 2 × 动一下间隔，变成 ×【这一次的随机倍数】×【深夜】×【你不在】。
 * 三个倍数都 ≥ 1：永远不比原来的最短间隔早。旋钮见 knobs.ts。
 */
import { INNER_RHYTHM_KNOBS, type InnerRhythmKnobs, type ProactiveTalk } from './knobs';

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const finite = (n: unknown, fallback: number) => typeof n === 'number' && Number.isFinite(n) ? n : fallback;

/**
 * 下一次的随机倍数，范围 [1, 1 + spread]，偏短的一边。`previous` 是上一次的倍数（没有则 null）：太接近就再抽一次，取离上次更远的。
 * `playful`：角色卡的 playful 权重（1 = 一般）。
 */
export function innerRhythmDraw(random: () => number, playful: number, previous: number | null, knobs: InnerRhythmKnobs = INNER_RHYTHM_KNOBS): number {
  const [lo, hi] = knobs.spreadByPlayful;
  const spread = Math.max(0, knobs.spread) * clamp(1 / Math.max(0.01, finite(playful, 1)), lo, hi);
  const one = () => 1 + spread * Math.pow(clamp(finite(random(), 0.5), 0, 1), Math.max(0.01, knobs.shape));
  let value = one();
  if (previous !== null && Math.abs(value - previous) < knobs.differentBy * Math.max(spread, 0.01)) {
    const again = one();
    if (Math.abs(again - previous) > Math.abs(value - previous)) value = again;
  }
  return value;
}

export interface InnerRhythmStretchInput {
  night: boolean;
  drowsy: boolean;
  /** 距用户上次互动的分钟数；不知道为 null。 */
  awayMinutes: number | null;
  /** 系统读到用户人不在（电脑锁屏 / 很久没动键盘鼠标）。 */
  userAway: boolean;
}

/** 深夜 × 你不在，叠加后的倍数（≥ 1）。 */
export function innerRhythmStretch(input: InnerRhythmStretchInput, knobs: InnerRhythmKnobs = INNER_RHYTHM_KNOBS): number {
  const dark = input.night ? knobs.night : input.drowsy ? knobs.drowsy : 1;
  const minutes = input.awayMinutes === null ? 0 : Math.max(0, finite(input.awayMinutes, 0));
  const ramp = clamp(1 + (minutes - knobs.awayFromMinutes) / Math.max(1, knobs.awayRampMinutes), 1, Math.max(1, knobs.awayMax));
  const away = input.userAway ? Math.max(ramp, knobs.awayState) : ramp;
  return Math.max(1, dark) * away;
}

/** 设置「她主动找你说话」对应的倍数：少一点 > 1，适中 = 1（原样），多一点 < 1。 */
export function innerRhythmTalkScale(talk: ProactiveTalk | undefined, knobs: InnerRhythmKnobs = INNER_RHYTHM_KNOBS): number {
  return talk === 'less' ? Math.max(1, finite(knobs.talkLess, 2)) : talk === 'more' ? clamp(finite(knobs.talkMore, 0.6), 0.1, 1) : 1;
}
