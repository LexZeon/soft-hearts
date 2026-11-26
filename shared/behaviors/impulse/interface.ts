/**
 * 松绑 的接口。方案 docs/claude/2026-11-11-loosen-plan.md，
 * 做了什么 docs/claude/2026-11-12-loosen.md。心情一圈（docs/claude/2026-11-03-mood-loop-design.md）：冲动 → 调控 → 表现 → 回到心情。
 *
 *  1. 冲动（choose.ts impulseNow）：从激素 O、D、N（相对角色卡基线）和心情数值 B（无聊）、M（想念）推，C（压力）、A（困）、刚被晾过收，
 *     再乘角色卡性格。五种想做的事（说话、邀你玩、给你留东西、哼歌、看你一眼）各有一个冲动，都从同一组数里算。只读，不改心情。
 *  2. 调控（choose.ts initiativeFloor / regulateInitiative）：硬底线不动（深夜和困了安静、睡着不说、开会或不在、在打字或藏起来不打扰、
 *     上一句你没回就不追着说）；其余是软的：互动余额（I-010）按比例往下压，强烈的心情可以越过；她自己也可以选这次不说。
 *     一次只挑一件。
 *  3. 表现（topic.ts、slip.ts）：内心循环的提示词里给一个真实的话头（她刚在做的事、刚经历的小事、你提过的事、她的日记、此刻的时间、
 *     她自己的心情：只从此刻真有的里挑），偶尔一点活人的小毛病（改口、走神、嘴硬），有冷却，不连着同一种。
 *  4. 回到心情（electron/initiative/impulse/host.ts）：她先开口你接了 → O、D 涨；没接 → D 降一点、C 涨一点，那类话头短期不再提；
 *     邀你玩你说下次 → D 小降，短期不再邀。走心情第二批的小时刻（shared/foundation/mood-moments.ts），有冷却和每天次数。
 *
 * 谁调用：electron/initiative/impulse/host.ts 的 ImpulseHost（electron/main.ts 每秒一下里 tick()；内心循环的提示词读 expression()；
 * 开口时挑哪件读 leans()）。体验记录一行 'initiative'：冲动档位、挑了哪件（或没有）、为什么没有（底线 / 余额 / 冷却 / 她选了不说），只有封闭的类别。
 */
import type { MoodTendency, MoodValues } from '../../foundation/mood';
import type { UrgeKind } from './knobs';

export type { UrgeKind } from './knobs';

/** What one reach (she thought of you) may start: talk (a speech opportunity: the opening choice then picks what), a glance, humming. */
export const INITIATIVE_KINDS = ['talk', 'glance', 'hum'] as const;
export type InitiativeKind = (typeof INITIATIVE_KINDS)[number];
export const URGE_BUCKETS = ['low', 'mid', 'high'] as const;
export type UrgeBucket = (typeof URGE_BUCKETS)[number];
/** Why a reach ended with nothing: a hard floor, the soft interaction balance, a cooldown (the mood clock's speech interval and hourly cap), or her own choice. */
export const INITIATIVE_WHYS = ['floor', 'balance', 'cooldown', 'chose-not'] as const;
export type InitiativeWhy = (typeof INITIATIVE_WHYS)[number];
/** The hard floor's closed reasons (the first one that holds). */
export const INITIATIVE_FLOORS = ['night', 'meeting', 'away', 'not-now', 'unanswered'] as const;
export type InitiativeFloor = (typeof INITIATIVE_FLOORS)[number];

/** Her mood as the impulse reads it. All numbers; never a word of any chat. */
export interface ImpulseInput {
  readonly values: MoodValues;
  readonly baseline: MoodValues;
  /** The card's evidence.level (moodLevel's third argument). */
  readonly evidence?: number;
  /** B, 0–100 (MoodSnapshot.boredom). */
  readonly boredom: number;
  /** M, 0–100 (MoodSnapshot.longing). */
  readonly longing: number;
  /** A, her sleep pressure 0–1 (FatigueView.A); null when not known. */
  readonly A: number | null;
  /** The card's personality (MoodParameters.weights, 1 = usual). */
  readonly personality?: Partial<Record<MoodTendency, number>> | null;
  /** Recently ignored: her unanswered lines plus an invitation turned down a little while ago (counted up to 2). */
  readonly ignored: number;
}

export interface Impulse {
  /** The overall urge to reach out, 0–1. */
  readonly urge: number;
  readonly bucket: UrgeBucket;
  /** Each kind's urge, 0–1, from the same numbers. */
  readonly kinds: Readonly<Record<UrgeKind, number>>;
  /** The push (after personality) and the hold, for the developer and tests. */
  readonly push: number;
  readonly hold: number;
}

/** What the floor reads (the host fills it from what already exists: the quiet rules, I-066 presence, the expression gate, I-039). */
export interface FloorInput {
  readonly asleep: boolean;
  /** The night window or drowsy (the inner loop's quiet rules). */
  readonly quiet: boolean;
  /** I-066: 'meeting' while a meeting or call; 'no' for away, locked or not known; null when the judgment is not running yet. */
  readonly presence: 'meeting' | 'no' | 'ok' | null;
  /** The expression gate: visible, no typing, no chat or speech running, not dragged, inner loop and 自动表现 on. */
  readonly canExpress: boolean;
  /** Her own lines the user has not answered yet (MoodState.unansweredSpeech). */
  readonly unanswered: number;
}

/** One reach's result: what she does, or nothing and why. One journal row (closed values only). */
export interface InitiativeDecision {
  readonly bucket: UrgeBucket;
  readonly kind: InitiativeKind | 'none';
  readonly why?: InitiativeWhy;
  readonly floor?: InitiativeFloor;
}

/** The journal row (shared/memory/journal.ts 'initiative'). */
export interface InitiativeRow extends InitiativeDecision { readonly characterId: string }

/** The journal's plain words (shared/foundation/ui-copy.journal.en.ts has the English). */
export const INITIATIVE_KIND_WORDS: Readonly<Record<InitiativeKind | 'none', string>> = Object.freeze({
  talk: '她想起你，想找你说说话', glance: '她想起你，看了你一眼', hum: '她想起你，自己哼起了歌', none: '她想起你，这次没做什么',
});
export const URGE_BUCKET_WORDS: Readonly<Record<UrgeBucket, string>> = Object.freeze({ low: '冲动弱', mid: '冲动中等', high: '冲动强' });
export const INITIATIVE_WHY_WORDS: Readonly<Record<InitiativeWhy, string>> = Object.freeze({
  floor: '底线拦下', balance: '最近互动少，收着了', cooldown: '刚说过不久', 'chose-not': '她自己选了这次不说',
});
export const INITIATIVE_FLOOR_WORDS: Readonly<Record<InitiativeFloor, string>> = Object.freeze({
  night: '深夜或她困了', meeting: '你在开会', away: '你不在', 'not-now': '这会儿不是时候（你在打字、她被藏起来或正忙着）', unanswered: '她上一句你还没回',
});
