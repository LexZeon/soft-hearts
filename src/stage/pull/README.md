# 拉她（I-136 Unbound v1 第 5 步）

按住她身上某处拖，就是在拉她；松手她慢慢回来。方案 `docs/claude/2026-11-18-unbound-step5-plan.md`，记录 `docs/claude/2026-11-18-unbound-step5.md`。

| 文件 | 做什么 |
| --- | --- |
| `../../../shared/behaviors/pull/session.ts` | 一次拉是一个会话：按下 → 挪过 8 像素或按住超过 0.45 秒才算开始 → 拖 → 松手 / 取消 / 挣开；报给脑子的固定字段（部位、左右、力度、方向、按了多久、怎么结束） |
| `../../../shared/behaviors/pull/knobs.ts` | 起点数字和硬上限（`normalizePullKnobs`：任何数都过它） |
| `../../../shared/behaviors/pull/gates.ts` | 什么时候按她不算拉：睡着、凑到镜头前、她的手正在牵你（只挡手和胳膊） |
| `../../foundation/body-capsules.ts` | 每根骨一个胶囊（Unbound 和桌宠共用），`rayCapsuleHit` 用相机射线找按到的那块。量胶囊一律经 `measureBodyCapsules`：MMD 模型量自己的网格（和原来一样），VRM 的标准骨架量 VRM 自己的网格（I-164，`src/unbound/model/standard-capsules.ts`） |
| `stage-pull.ts` | 一个舞台的拉：认部位（胶囊 → 骨名 → `shared/mood/touch-part.ts`）、鼠标在她世界里的位置（过被抓那一点、朝向相机的平面）、身体层 |
| `pull-layer.ts` | 身体层：手、胳膊（上臂摆 + 手肘伸直，余下的力给上身）、身体（腰以上倾）、头（头和脖子小转）、腿脚（膝绕胯—脚踝线摆，脚踝保持原朝向）；两级临界阻尼，不跳 |
| `soft-touch.ts` | 哪些碰触交给果冻第 3 层的「碰了才软」（拉、捏脸），什么时候按、按住、松手 |
| `../mmd/pull.ts` | `MmdStage` 的方法：`pullHit`、`pullStart`、`pullTo`、`pullEnd`、`framePull`…… |
| `../../mood/pet-pull.ts` | 桌宠窗口的输入：`PetInteraction` 把不是脸颊的按下交给它，指针捕获，报告走预加载 `petTouch` |

帧里的位置：在牵手、递东西、猜拳这些叠加层之后，动作过渡桥和连续性守卫之前（`MmdStage.frameTick` 的 `framePull`）。拉着和松手后回来的这段时间（`pullEngaged()`），新的聊天手势、她的动作、自动身体动作不开始，正在做的平滑收住（"禁止"只是不开始新的）。

规矩：

- 桌宠里只动腰以上（和膝），脚不动：测试 `tests/pull-stage.test.ts` 量脚踝和脚尖的位移，目标 0。
- 交接（按下、松手、取消）的意外步长不超过不拉时自己最大值的 1.25 倍（下限 60 帧 0.15°、30 帧 0.6°）：同一个测试，60 和 30 帧都量。
- 上限永远不超：`normalizePullKnobs` 硬上限，`tests/pull-session.test.ts`；变异 `scripts/dev/mutations/stage.json` 的 PULL1–PULL6、`mood.json` 的 PULL7–PULL9。
- 报给主机的只有固定字段：主机 `electron/mood/touch/pet-touch.ts` 只认显示着的桌宠窗口，只取拉的那几样字段，`parseTouchEvent` 再查一遍。
- Unbound：同一个 `StagePull`（不带腿）由 `src/unbound/figure.ts` 持有，`src/unbound/pull-input.ts` 驱动（跟着走、站到另一只脚上）；宿主和仲裁见 `electron/unbound/README.md` 第 9 节。
- 她的态度（顺着、站稳、往回拽、挣开）：`shared/behaviors/pull/attitude.ts`，桌宠由 `src/mood/pet-pull.ts`、Unbound 由 `pull-input.ts` 每一拍套用；只改柔顺度和上限（≤ 1），挣开也是慢慢回来。
- 头顶和两侧的头发、额头算"头"（2026-11-24，`docs/claude/2026-11-24-head-pat-side.md`）：`StagePull.hit` 命中后量命中点高过眼线几个眼距，高过 0.6 个眼距、又在头骨上的头发或脸按"头"报（`shared/mood/touch-part.ts` 的 `headTopTouch`）；垂在头下面的头发、脸颊、手不变。原因是 Gene 只有右侧头发骨叫"头发"，同一个动作一半是头、一半是拉头发。测试 `tests/head-pat-side.test.ts`；变异 `head-pat-one-half`、`head-hair-stroke-pull`。
