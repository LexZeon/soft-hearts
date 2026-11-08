/**
 * "这会儿……"（心情快照的 companion：调皮、想黏着你、很放松、有点拘谨、想念的余韵）在各功能的挑选和"为什么"里算不算数。
 * I-020 各功能共用这一处（#8 shared/behaviors/boredom-timing/、#11 idle-gesture/、#21 touch-feed-effect/、#26 blush/、#5 reply-linger/），
 * 想改门槛只改这里。
 *
 * 为什么要门槛：心情模型（shared/mood.ts getMoodSnapshot）的 companion 只要最强的那项倾向大于 0 就算。她的数值回到基线时
 * 永远略高一丝（例如隔了一天还高 1e-10），于是平静时也总有一项"最强"的倾向，"为什么"里就会写出"这会儿想黏着你"这种
 * 不真实的理由。用户要求"为什么"只写从此刻状态来的真实理由，所以倾向至少要这么强才算：
 * 心情快照 tendencies 的同一把尺子，0.25 ≈ 亲近比基线高约 2.5 点（level 每高 10 = 1）。
 * 想念的余韵（wistful）来自一次真的重逢，不看强度。
 */
import type { MoodSnapshot, MoodTendency } from './mood';

export const MOOD_TENDENCY_MIN = 0.25;

const TENDENCIES: readonly MoodTendency[] = ['playful', 'close', 'comfortable', 'cautious'];

export interface MoodTendencyInput {
  readonly companion: MoodSnapshot['companion'];
  /** 心情快照的 tendencies。没给（只拿标签的旧调用、测试）时，companion 照原样算。 */
  readonly tendencies?: Partial<Record<MoodTendency, number>> | null;
}

/** 此刻真的有的那项倾向；不够强、没有或认不得 = null。 */
export function tendencyNow(snapshot: MoodTendencyInput, min = MOOD_TENDENCY_MIN): MoodTendency | 'wistful' | null {
  const companion = snapshot?.companion;
  if (companion === 'wistful') return 'wistful';
  if (!(TENDENCIES as readonly unknown[]).includes(companion)) return null;
  const tendencies = snapshot.tendencies;
  if (!tendencies) return companion as MoodTendency;
  const value = tendencies[companion as MoodTendency];
  return typeof value === 'number' && Number.isFinite(value) && value >= min ? companion as MoodTendency : null;
}
