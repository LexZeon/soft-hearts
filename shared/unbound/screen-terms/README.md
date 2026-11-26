# 屏幕上的样子 ↔ 米（I-212 / I-211）

记录：docs/claude/2026-11-24-i212-screen-terms.md。

她的世界里面用米（走路、相机、物理、脚踩地）；所有"她站哪、走多远"的决定用两个数说：

- **横向** `across`：她的中心占屏幕宽度的比例。
- **多大** `size`：她整个人的高度占**可用高度**的比例（从脚下那条线——工作区底边往上 `HOME_FEET_MARGIN_DIP`——到工作区顶）。1 = 正好从任务栏站到屏幕顶；比 1 大就放不下全身，交给 `framing/floor.ts` 的那几段。

`size = H·d / ((d + 深度)·可用高度)`，`深度 = H·d / (size·可用高度) − d`（d 看屏幕的距离，H 她这个模型的身高）。**只有这里换算**；别处要米就调这里（变异 `I212-convert-in-one-place` 守着）。

| 文件 | 做什么 |
|---|---|
| `convert.ts` | `sizeAtDepth`、`depthForSize`、`placementOfLook`、`lookOfPlacement`、`usableHeightM`；`REFERENCE` / `referenceSize`（旧米数旋钮换算的锚点：8 米 = 0.5）；`FALLBACK_HEIGHT_M`（页面还没报身高时的猜测，只用于不画出来的那一刻） |
| `distance.ts` | 告诉她"离用户约几米"：可用屏幕当成固定竖直视角（旋钮 45°）的取景框，`H / (size·2·tan(角/2))`；2 米内一位小数，更远按 0.5 米。`sizeForToldM`（I-193，2026-11-24）：同一条公式倒过来，她写的 `⟦go 1.2m⟧` 换成大小（下一轮告诉她的正好是 1.2 米） |
| `knobs.ts` | 第一次出场多大（0.5）、告诉她米数时的视角（45°） |

谁在用：`electron/unbound/her-place.ts`（她的位置、出场、走近、每轮那句、`go` 的米数）、`shared/unbound/her-position/reach.ts`（远近对照、最近）、`electron/unbound/place-keeper.ts`（存样子、旧文件换算）、`shared/unbound/pull.ts`（拉她的远近边界）、`shared/unbound/her-position/near.ts`、`src/unbound/her-spot.ts`（页面放第一帧、拉她的夹紧）。
