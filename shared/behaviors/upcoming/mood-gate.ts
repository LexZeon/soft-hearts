/**
 * P-001「到时候主动问起」的心情门（心情第二批，docs/claude/2026-11-11-mood-batch2.md）：她压力大（C 高）或不舒服（E 低）时，不提你的计划，
 * 先留着，等她缓过来再说。读法相对角色卡的基线（moodLevel：50 = 在基线）。
 *
 * 现在还没有"问起"这一步（P-001 第 2、3 步没做，interface.ts），所以这里只是先做好、测好的一道门：哪一步开始问起，就先过它。
 * 读：C、E（相对基线）。写：不写（只决定现在提不提）。
 */
import { moodLevel, type MoodValues } from '../../foundation/mood';

/** C 的程度到这里算"压力大"，E 的程度到这里算"不舒服"（50 = 在基线；担心的门槛是 60，这里稍早一点就收着）。 */
export const PLAN_MOOD_HOLD = Object.freeze({ stressAt: 57, uneasyAt: 43 });

export type PlanMoodHold = 'stress' | 'uneasy';

/** null：现在可以提；否则为什么先留着。 */
export function planMoodHold(values: MoodValues, baseline: MoodValues, evidence = 1, knobs: { stressAt: number; uneasyAt: number } = PLAN_MOOD_HOLD): PlanMoodHold | null {
  if (moodLevel(values.C, baseline.C, evidence) >= knobs.stressAt) return 'stress';
  if (moodLevel(values.E, baseline.E, evidence) <= knobs.uneasyAt) return 'uneasy';
  return null;
}
