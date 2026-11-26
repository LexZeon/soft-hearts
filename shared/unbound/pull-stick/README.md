# 摇杆式拉她和"按住不动才算碰"（I-196、I-194）

记录：docs/claude/2026-11-22-i196-joystick-pull.md、docs/claude/2026-11-22-i194-click-not-touch.md。

全屏 Unbound 里按住她的身体或头（含头发）：按下点是摇杆的中心，鼠标相对它往下 = 拉近、往上 = 推远、左右 = 横走，越偏越快（有上限），中间一小圈不动（死区），松手就停；鼠标在她身上滚轮 = 同样的走法，一格一格。偏移都用**屏幕像素**，和她在屏幕上多大无关。纯规则：不碰 Electron、Three.js、时钟和 DOM（调用的人给时间和位置）。

## 文件

| 文件 | 做什么 |
|---|---|
| `knobs.ts` | 旋钮：死区、最快偏移、曲线、拉近速度、横走速度和上限、向前看几秒、按住多久算碰、滚轮一格、滚停多久结束 |
| `stick.ts` | `stickReading`（偏移 → 左右、前后两个读数，死区内为 0、边缘不跳变、有上限）、`stickGoal`（读数 → 她该去的位置，按"显得多大"的比例算，近处远处一样）、`wheelDepth`、`wheelNotches` |
| `press.ts` | `PressJudge`：一次按下是点、碰（死区里按住不动够久）还是拉（出了死区），三者互斥；碰过之后不会变成拉，拉过之后不会变成碰 |
| `index.ts` | 公开页 |

## 谁在用

- 页面：`src/unbound/pull-input.ts`（`UnboundPull`：判断一次按下、问主机、结束报告）、`src/unbound/pull-stick.ts`（`StickDrive`：每帧把读数交给步态；限位用页面给的 `clampDepth`——最近是"眼睛"那一档，带 I-192 的不穿模护栏，最远 12.5 米）、`src/unbound/pointer-router.ts`、`pull-dot.ts`（按下点的小圆点）、`click-reporter.ts`（`hold()`：按住不动报一次碰）。
- 共享：`shared/unbound/pull.ts`（拉的报告带 `stick` 标记）、`typing.ts`（点击报告的 `hold`）。
- 主机：`electron/unbound/host.ts`（带 `stick` 的拉不告诉触碰脑，位置照记）、`electron/unbound/typing.ts`（点她开框不是碰；框已开着再点、或 `hold` 才是碰）。

## 守着的（变异 `scripts/dev/mutations/unbound.json` 的 `I196-*`、`I194-*`）

- 拉从不是碰：`I196-pull-never-touch`（页面的报告带标记）、`I196-pull-never-touch-host`（主机不转给触碰脑）、`I196-pull-hold-is-not-touch`（碰过的按住不会再变成拉）；
- 死区里不动、方向、速度有上限：`I196-dead-zone-nothing-moves`、`I196-stick-down-is-closer`、`I196-stick-speed-capped`；
- 近端限位和护栏：`I196-stick-near-limit`、`I196-near-station-keeps-clear`、`NEAR5-up-reaches-eyes`；
- 点开框不是碰、按住不动够久才是碰：`I194-click-opening-box-is-not-touch`、`I194-press-held-still-is-touch`。
