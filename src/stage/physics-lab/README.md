# 物理调参台（R01，2026-11-17）

开发者用的独立窗口：在当前角色的模型上，用和桌宠完全相同的物理代码（`../model-physics.ts`、`../physics-rig.ts`、Ammo），配固定测试动作，分组调参数，看实时数字，按模型保存。记录：`docs/claude/2026-11-17-physics-lab.md`。

| 文件 | 做什么 |
| --- | --- |
| `index.html`、`lab-main.ts` | 页面：Three.js 场景、载入模型（桌宠同一个 `mmd-asset://` 地址，不碰路径）、每帧顺序 restore → 测试动作 → 物理 → 测量 |
| `lab-panel.ts` | 右边的面板（纯 DOM、只用 textContent）：保存 / 恢复原样、A/B、全局、分组、实时数字 |
| `groups.ts` | 物理分组：每个连通的动态刚体集合一组，id 是 `部位:最小刚体序号`（不含骨名）；`rigComponents`、`groupId` 也给 `../physics-tuning-apply.ts` 用 |
| `test-motions.ts` | 固定测试动作（静止、转头、点头、挥手、走几步、拖动后停下），循环处处平滑 |
| `meter.ts` | 实时数字（测试也用）：抖动、意外步长、下垂、摆幅、拉伸、穿进、停稳 |
| `open-button.ts` | 控制窗口开发者面板里的按钮 |
| `jelly-panel.ts` | 「全身果冻（实验）」一节：第 2 层跟随晃动、第 3 层顶点果冻的开关和旋钮（I-147，代码在 `../jelly/`），「碰了才软」（I-136 第 5d 步：跟着版本 / 开 / 关、碰的力度），实时数字里有每层每帧用时 |

相关的别处：

- `shared/stage/physics-tuning.ts`：调参的格式和限幅（文件、页面、主机三处都过它）。
- `../physics-tuning-apply.ts`：把调参用到一个部位的刚体计划上（没有调参时原样返回）。
- `../spring-bone.ts`：实验的弹簧骨骼求解器。
- 主机：`electron/stage/physics-tuning-store.ts`（侧车 `physics-tuning.json`）、`physics-lab-window.ts`、`physics-lab-guard.ts`、`physics-lab-preload-api.ts`；接线 `electron/wiring/physics-lab-wiring.ts`。

画面上的「60 帧 / 30 帧」限制帧率，「量帧时间」每帧等显卡做完，帧时间里就算上了顶点着色器（会稍慢，只用来量）。量果冻的用时：`node scripts/dev/jelly-look.mjs`（同样的临时配置）。

试一下：`node scripts/dev/physics-lab-look.mjs`（先 `pnpm build`）在临时配置里打开它、存一次、恢复一次，截图和报告在 `.local/physics-lab-look/`。离线量一个模型：`tests/helpers/physics-lab-run.ts` 的 `runScenario`。

加新的调节项：在 `shared/stage/physics-tuning.ts` 加字段和上下限（`TUNING_BOUNDS`），在 `../physics-tuning-apply.ts` 或 `../spring-bone.ts` 用它，在 `lab-panel.ts` 加滑块，`tests/physics-tuning.test.ts` 加限幅的断言。
