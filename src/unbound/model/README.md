# 标准身体：让 Unbound 的引擎不挑模型（I-152 原样载入 第 2 步）

记录：docs/claude/2026-11-19-vrm-motion-step2.md。方案：docs/claude/2026-11-19-native-models-plan.md「新的动作系统」。

## 一句话

Unbound 的引擎（`figure.ts` 和它下面的一切：动作层、腿 IK、步态、弹簧、视线、嘴、待机）照旧驱动一副"MMD 样子"的骨架。对 MMD 模型，这副骨架就是模型自己的；对 VRM，我们现造一副**标准骨架**（Gene 的骨骼名、Gene 的层级，关节放在 VRM 自己的关节位置），引擎驱动它，每帧最后再按对应表把姿势和表情写到 VRM 自己的骨头和表情上。模型文件一个字节都不改。

## 文件

| 文件 | 做什么 |
|---|---|
| `standard-skeleton.ts` | 从"已载入的模型"（`LoadedModel` 的 `bone(slot)`、`finger(slot)`）造标准骨架：每根骨头的名字、父骨、静止位置、它驱动模型的哪根骨头；腿 IK 和眼睛付与照 Gene；表情位用 Gene 的名字（あ、まばたき、笑い…）。T 字的手臂整条绕肩关节转到 Gene 的角度（34°）再放进去 |
| `body-transfer.ts` | 每帧的对应表（I-164：表情位之外，脸的动作用的命名形状 cheekPuff、tongueOut… 也在标准脸上；眼骨的转角取 rangeMap 和眼皮余地里较小的）：骨头按世界里的方向写（`W = P · K · R`，模型骨头自己的静止朝向不影响结果），hips 的位置跟着标准的下半身；眼睛按 VRM 的 lookAt（转眼骨或 lookUp/Down/Left/Right 表情，都按它自己的 rangeMap）；表情按比例（权重 × 表情自己的绑定权重，不放大） |
| `standard-retarget.ts` | 动作库的 VMD 经动作换算到标准骨架（手臂按方向对齐、手和手指按静止框架、位移按腿长缩放；表情位对表情位、比例 1）；手碰手的动作照样做接触校正 |
| `standard-body.ts` | 上面三样合在一起：`StandardBody.of(loaded)`；`mesh` 交给 `UnboundFigure`；`transform` 给 `loadClip`；每帧 `present(physicsDelta)`；`measureShown()` 量放下手臂后的包围盒。I-152 第 3 步（2026-11-21，记录）：`springs` 是 VRM 自己的弹簧骨骼（`src/stage/vrm-spring/`），`present` 换完姿势后算它；`configurePhysics`、`hidePhysics` 收开关和"藏起来"；`StandardBody.ofMesh(mesh)` 让全屏凭她的网格找到它 |
| `standard-capsules.ts` | I-164 摸她、拉她（记录）：她的身体胶囊。标准骨架的网格没有顶点，量它什么都没有；改在 VRM 自己的所有网格上量（每个顶点归权重最大的 VRM 骨头，在那根骨头自己的空间里拟合），每帧按 VRM 自己摆好的骨头放，每个胶囊记着驱动它那根骨头的标准骨（没有就往上找最近的被驱动的祖先），所以部位名、拉她的骨架都照 MMD 模型那样用。`StandardBody` 造好时登记（`setBodyCapsuleSource`），谁量她的胶囊（`measureBodyCapsules`）都拿到这些 |
| `standard-contact.ts` | 摸头的落点：桌宠的头部接触探针，用 VRM 自己的头和眼睛，在它每个网格上量，取最高的（头发网格） |
| `eye-turn-gain.ts` | 眼骨转多少（11-20，记录）：从模型自己的眨眼量出上眼皮的边、从眼骨自己的顶点量出眼珠，看向一处时眼骨只转到"上眼皮盖住的眼珠不比 Gene 在软上限时多"；Gene 和余地一样多的模型照旧（1），眼珠填满眼眶的（VRoid 转来的）转得少。`figure.ts` 的视线最后一步乘上它。VRM 的在 `vrm-eye-room.ts` 量（I-164），由 `body-transfer.ts` 用 |
| `standard-face.ts` | I-164（记录）：VRM 上那几层读的东西：脸的动作用的"脸的视图"（`standardFaceMesh`，每个标准表情的顶点就是 VRM 自己的，脸的动作据此找冲突的表情）、VRM 自己的体检卡（`standardCapabilities`）、睡着的身体找骨头（`standardSleepBones`）、嘴在哪（`standardMouth`，aa 动的地方） |
| `vrm-eye-room.ts` | I-164：VRM 的眼骨最多转多少，和 `eye-turn-gain.ts` 同一条规则，在 VRM 自己的眨眼表情和眼骨（或虹膜）上量；`body-transfer.ts` 取它和 rangeMap 里较小的那个（`roomTurn`） |
| `figure-bones.ts` | MMD 模型上找骨头：先按原来的精确名字（Gene、艾琳等一切原来能找到的模型结果完全一样），找不到再按别名表找同一个标准部位（改了骨骼名的 PMX 也有呼吸、视线、脚） |

## 接在哪里

- 窗口模式：`src/unbound/window-mode/window-stage.ts` 的 `loadModel` 遇到 `.vrm` 走 `StandardBody`（VRM 用舞台公开页的 `loadVrmForEngine` 载入，手臂不在载入时放下）；`window-body.ts` 每帧最后 `present(physicsDelta)`；物理开关经 `window-physics.ts` 交给它的 `springs`。
- 全屏 Unbound：`src/unbound/main.ts` 经 `figure-body.ts` 同样走 `StandardBody`，每帧 `present(raw)`；物理开关和档位经 `../figure-physics.ts`；她的轮廓（点穿透、点她报部位、最近点）在 `../body-hit.ts`，胶囊经 `measureBodyCapsules` 拿到 `standard-capsules.ts` 的。

## 守的规矩

- **MMD 模型一点不变**：MMD 模型不经过这里的标准骨架；`figure-bones.ts` 先按精确名字找，测试断言 Gene 上没有一次是靠别名表找到的（`tests/unbound-vrm-body.test.ts`）。
- **不瞬移**：引擎本来的弹簧、过渡都在标准骨架上照常起作用；`present()` 只是换算，不加不减。60 / 30 fps 真实帧循环的步长和"意外步长"见测试。
- **动作覆盖表**：`tests/motion-coverage.test.ts` 把动作库每个动作在 Gene、改了骨骼名的 PMX、合成 VRM 上跑一遍，没有静默跳过、没有 NaN、不比 Gene 快；做不到的（模型没有的手指）会说出来。新加动作自动进表。
- 不读写文件、不联网：模型和动作的字节由舞台的资源地址提供。
