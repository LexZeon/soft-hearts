/**
 * 她来挑（I-020 最小版，第一个用它的是 #11 "动一动""看你一眼"，shared/behaviors/idle-gesture/）。
 *
 * 只管挑的办法，不管口味：
 *  - 每个候选按"此刻"算分量：基础分量 × 每条理由的倍数。理由是从此刻里来的事实（"心情：满足""不久前被摸过头"），
 *    倍数只是附带；分量 ≤ 0 = 此刻不在她的范围里（例如难过时不笑）。
 *  - 最近挑过的降低分量（最近第 1、2、3… 次 × recentFactors 里对应的数），但不完全排除：真人也会重复，只是不会每次都一样。
 *  - 按分量随机挑一个，并说出"为什么挑了这个"：挑中的那个真正被抬高的理由，加上最近挑过的调整。
 *
 * 候选有哪些、各自多重、和性格心情怎么挂钩，都写在每个功能自己的旋钮文件里。这里不放任何功能的数字。
 * 每次调用正好取一次 random()（没有候选时也取），所以一个功能里改一个旋钮，不会让它后面别的随机抽取错位。
 */

export interface SheChoosesReason {
  /** 此刻的一件事，用户看得懂的话（"心情：满足"）。 */
  readonly text: string;
  /** 这件事让这个候选的分量 × 多少（1 = 没影响）。 */
  readonly factor: number;
}

export interface SheChoosesCandidate<Id extends string, Now> {
  readonly id: Id;
  readonly label: string;
  /** 此刻的基础分量和理由。分量 = base × 各理由的 factor × 最近挑过的调整。 */
  weigh(now: Readonly<Now>): { readonly base: number; readonly reasons: readonly SheChoosesReason[] };
}

export interface SheChoosesInput<Id extends string, Now> {
  readonly candidates: readonly SheChoosesCandidate<Id, Now>[];
  readonly now: Readonly<Now>;
  /** [0, 1)。测试注入固定序列。 */
  readonly random: () => number;
  /** 最近挑过的，最新的在前。 */
  readonly recent: readonly Id[];
  /** 最近第 1、2、3… 次挑过的候选分量 × 这里的数；每个夹在 [0.05, 1]，所以从不完全排除。 */
  readonly recentFactors: readonly number[];
}

export interface SheChoseWeight<Id extends string> { readonly id: Id; readonly label: string; readonly weight: number }

export interface SheChose<Id extends string> {
  readonly id: Id;
  readonly label: string;
  /** 为什么挑了这个：真正抬高它的此刻理由（倍数 ≥ 1.05），加上真的做了的最近挑过的调整（倍数 < 1）。没有特别偏向时如实说"随性挑的"。 */
  readonly why: readonly string[];
  /** 附带：挑之前每个候选的分量（已含最近挑过的调整），保留两位小数。 */
  readonly weights: readonly SheChoseWeight<Id>[];
}

/** 没有一条理由抬高挑中的那个时，"为什么"里写这一句。 */
export const SHE_CHOOSES_NO_LEAN = '这会儿没有特别偏向哪个（随性挑的）';

const finite = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const round = (value: number): number => Math.round(value * 100) / 100;

export function sheChooses<Id extends string, Now>(input: SheChoosesInput<Id, Now>): SheChose<Id> | null {
  let roll = finite(input.random(), 0);
  roll = Math.min(1 - 1e-12, Math.max(0, roll));
  const factorFor = (id: Id): { factor: number; index: number } => {
    const index = input.recent.indexOf(id);
    if (index < 0 || index >= input.recentFactors.length) return { factor: 1, index: -1 };
    return { factor: Math.min(1, Math.max(0.05, finite(input.recentFactors[index], 1))), index };
  };
  const rows: { candidate: SheChoosesCandidate<Id, Now>; weight: number; reasons: readonly SheChoosesReason[]; recent: { factor: number; index: number } }[] = [];
  for (const candidate of input.candidates) {
    let weighed: { base: number; reasons: readonly SheChoosesReason[] };
    try { weighed = candidate.weigh(input.now); } catch { continue; }
    let weight = Math.max(0, finite(weighed.base, 0));
    const reasons = Array.isArray(weighed.reasons) ? weighed.reasons.filter(reason => reason && typeof reason.text === 'string' && Number.isFinite(reason.factor)) : [];
    for (const reason of reasons) weight *= Math.max(0, reason.factor);
    const recent = factorFor(candidate.id);
    weight *= recent.factor;
    rows.push({ candidate, weight: Number.isFinite(weight) ? weight : 0, reasons, recent });
  }
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  if (!(total > 0)) return null;
  let left = roll * total, chosen = rows.filter(row => row.weight > 0).at(-1)!;
  for (const row of rows) { if (row.weight <= 0) continue; left -= row.weight; if (left < 0) { chosen = row; break; } }
  const why: string[] = chosen.reasons.filter(reason => reason.factor >= 1.05).map(reason => reason.text);
  if (!why.length) why.push(SHE_CHOOSES_NO_LEAN);
  const last = input.recent[0];
  const lastRow = last === undefined ? undefined : rows.find(row => row.candidate.id === last);
  // Said only when it really was lowered (a recentFactors entry of 1 = repeats not lowered: nothing to say, T-207).
  const lowered = chosen.recent.factor < 1;
  if (lowered && chosen.recent.index === 0) why.push(`上次也是${chosen.candidate.label}（降低了，还是挑中了）`);
  else if (lowered && chosen.recent.index > 0) why.push(`最近挑过${chosen.candidate.label}（降低了一些，还是挑中了）`);
  if (lastRow && lastRow !== chosen && lastRow.recent.factor < 1) why.push(`上次是${lastRow.candidate.label}，这次降低它`);
  return {
    id: chosen.candidate.id, label: chosen.candidate.label, why,
    weights: rows.map(row => ({ id: row.candidate.id, label: row.candidate.label, weight: round(row.weight) })),
  };
}
