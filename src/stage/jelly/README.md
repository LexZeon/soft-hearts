# 全身果冻（I-147，实验，默认关）

绝区零那样的"全身果冻"的第 2、3 层（第 1 层是物理调参台里的弹簧骨骼）。记录：`docs/claude/2026-11-17-whole-body-jelly.md`。

| 文件 | 做什么 |
| --- | --- |
| `stage-jelly.ts` | 两层合在一个对象里，桌宠（`../mmd/physics.ts`）、Unbound（`src/unbound/figure.ts`）、调参台（`../physics-lab/lab-main.ts`）都用它。只认给当前模型做的调参（`rig` 签名） |
| `follow-through.ts` | 第 2 层：脊柱、脖子、头、肩、手臂的跟随晃动。每根骨一个阻尼弹簧，驱动是"显示出来的角速度的变化"；软上限（tanh）；渲染后撤掉 |
| `soft-regions.ts` | 第 3 层的区域：腹部、臀部、大腿、上臂、脸颊（模型没有胸部物理骨时加胸部）。用模型自己的蒙皮权重和骨骼比例认，不画遮罩、不改 PMX |
| `soft-jelly.ts` | 第 3 层：每个区域一个三维弹簧（CPU），驱动是变形骨带着的那一点的加速度；给着色器送偏移 |
| `soft-shader.ts` | 第 3 层的顶点着色器补丁（`onBeforeCompile`，接在 `skinning_vertex` 后面）；关掉时把材质原来的钩子和缓存键放回去 |

帧里的顺序（R29）：最终姿势 → 连续性守卫 → `StageJelly.frame`（第 2 层改骨头，第 3 层按改过的姿势算偏移）→ 局部物理 → 渲染 → `remove()`（撤掉第 2 层）→ 守卫撤桥。

规矩：

- 关着时和今天一模一样：调参里没打开任何一层，桌宠根本不建这个对象；打开过再关掉，淡出后材质、几何、骨头都还原（测试 `tests/jelly-*.test.ts`，变异 `scripts/dev/mutations/stage.json` 的 J1–J15）。
- 不瞬移：开关淡入淡出 0.3 秒；守卫重置、太快的一步（硬切）只清速度历史、不给冲量；隐藏时清零。
- 上限：每段最大角度、每个区域最大位移都是软上限，接近但不超过；限幅在 `shared/stage/jelly-tuning.ts`（主机、页面、文件都过它）。
- 碰了才软（I-136 第 5d 步，2026-11-18）：`SoftJelly.press`（按下：沿视线给被按区域的弹簧一次冲量）、`hold`（按住：挪静止点，最多上限的 0.6）、`hold(null)`（松手：从显示值回来）；`StageJelly.touchPress / touchPressKind / touchHold`。开关和力度在调参台（`touch`，没动过时跟着版本：开发版和源码运行开、稳定版关，主机 `physics-lab-wiring.ts` 定）。开着但没碰时不建第 3 层、不打补丁、不加顶点数据；碰过、回稳后再拿掉。谁来碰：`../pull/soft-touch.ts`（拉她、捏脸）。测试 `tests/jelly-touch.test.ts`，变异 PULL6。
- 加新区域：在 `shared/stage/jelly-tuning.ts` 的 `SOFT_REGIONS` 和默认值里加，在 `soft-regions.ts` 的 `findSoftRegions` 里认出来，`../physics-lab/jelly-panel.ts` 加名字，`tests/jelly-soft.test.ts` 的合成身体里加一块验证它只选中该选的地方。
