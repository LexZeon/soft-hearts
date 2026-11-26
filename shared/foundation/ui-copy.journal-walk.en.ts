/** 体验记录: the fixed words of her walk rows (shared/stage/journal-entries.ts 'go-beat', 'place-moved'; 2026-11-23, I-193). Authored copy only. */
import { ENGLISH_JOURNAL_CLOSE_UI_COPY } from './ui-copy.journal-close.en'; // 2026-11-25 (the kiss / hug fate row)
export const ENGLISH_JOURNAL_WALK_UI_COPY: Readonly<Record<string, string>> = {
  ...ENGLISH_JOURNAL_CLOSE_UI_COPY,
  '她回复里写的走位词，她走过去了': 'A go-word in her reply: she walked there', '她回复里写的走位词，她没有走': 'A go-word in her reply: she did not walk',
  '她按回复里写的走到了新的位置': 'She walked to a new place as her reply said', '她自己换了个地方站': 'She moved to another place on her own',
  '去左边': 'go left', '去右边': 'go right', '到中间': 'go to the middle', '走近': 'come nearer', '走远': 'go farther', '去角落': 'go to a corner', '到你鼠标旁边': 'go beside your mouse',
  '她当时睡着了': 'she was asleep', '你们正在玩游戏': 'you were playing a game', '正在凑近看或亲亲抱抱': 'she was coming close or kissing or hugging', '她已经站在那儿了': 'she already stood there',
  '不知道你的鼠标在哪': 'she did not know where your mouse was', '那个位置会挡住你要用的窗口': 'that place would cover the window you use', '还不知道自己站在哪': 'she did not know where she stood yet',
  '上一个走位还没排完': 'the last walk was still being set up', '等了太久没能走成': 'waited too long and the walk never started',
  '屏幕偏左': 'left of the screen', '屏幕中间': 'middle of the screen', '屏幕偏右': 'right of the screen', '几乎贴着屏幕': 'almost against the screen',
  '离用户比较近': 'fairly close to you', '离用户不远不近': 'neither close nor far from you', '离用户比较远': 'fairly far from you',
  '她把站的地方记成了你给她定的出场位置': 'She kept where she stood as the place you set for her to appear at', '她清掉了你给她定的出场位置': 'She cleared the place you set for her to appear at',
  '记好了': 'done', '她当时不在全屏里，没有记': 'she was not in full screen, nothing kept', '那个位置太近或太远，没有记': 'that place was too near or too far, nothing kept',
  '{0}：{1}（{2} 米）': '{0}: {1} ({2} m)', '{0}：{1}，{2}（走了 {3} 米）': '{0}: {1}, {2} (moved {3} m)',
  '到指定位置': 'go to a set place', '横向 {0}%': '{0}% across', '离你约 {0} 米': 'about {0} m from you', // I-193 numbers (⟦go 30% 1.2m⟧)
};
