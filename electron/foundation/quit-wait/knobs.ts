/**
 * 功能：退出后马上再打开（I-182）：旧的还在收尾时，新开的先等它走完再启动
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 * 记录：docs/claude/2026-11-22-i182-wait-for-quit.md。电脑忙时 Electron 自己的收尾量到 10～90 秒，进程真正结束要 97～125 秒（docs/claude/2026-11-22-k7-quit-hang.md）。
 */
export const QUIT_WAIT = {
  // 用户可能怎么说：电脑不忙时退出再点开，也闪一下"她在收拾"的小提示
  // 怎么调：新开的先不出提示、悄悄等旧的这么久（毫秒）；旧的在这段时间里走完就直接启动。空闲时收尾约 0.2 秒
  graceMs: 1_500,
  // 用户可能怎么说：等太久了还没打开 / 刚等一会儿就说打不开
  // 怎么调：最多等旧的多久（毫秒，从点开算），过了就提示"还没收拾完"并放弃这次打开。40 个低优先级重活压着时，旧进程从窗口消失到真正结束量到 97～125 秒
  budgetMs: 180_000,
  // 用户可能怎么说：旧的早走了，新的还要愣一下才出来
  // 怎么调：等的时候多久看一次旧的走没走（毫秒）
  pollMs: 400,
  // 用户可能怎么说：很久以前退出过，现在点开却要等
  // 怎么调：旧的留下的"在收拾"标记过了这么久（毫秒）就不再当真（防进程号被别的程序重用）
  staleMs: 300_000,
  // 用户可能怎么说："还没收拾完"的提示一闪就没了 / 挂太久
  // 怎么调：放弃时那句提示留多久（毫秒）
  giveUpNoticeMs: 5_000,
} as const;

/** The notice the waiting launch shows (Chinese first, with its English twin; the old instance's UI language picks one). */
export const QUIT_WAIT_COPY = {
  'zh-CN': { waiting: '她在收拾，马上就好…', gaveUp: '她还没收拾完，等一下再点开吧。' },
  en: { waiting: 'She is tidying up, back in a moment…', gaveUp: 'She is still tidying up. Try again in a little while.' },
} as const;
