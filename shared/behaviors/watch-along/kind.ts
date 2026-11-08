/**
 * I-006 第 3 步：扫一眼的类别 → 她要不要跟着看。只有"看视频"和"玩游戏"两类（别的类别——写代码、聊天、听歌、上网、写东西、其他——她忙自己的）。
 * 这里只有类别，没有任何画面内容。
 */
import type { ScreenActivity } from '../../screen-activity';
import type { HerLifeWatchKind } from '../../her-life';

export function watchKindOf(activity: ScreenActivity | null | undefined): HerLifeWatchKind | null {
  return activity === 'video' ? 'video' : activity === 'game' ? 'game' : null;
}
