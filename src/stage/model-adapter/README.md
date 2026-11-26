# 已载入的模型（舞台部分 · 模型适配层）

I-152「原样载入」的第 0 步（2026-11-19）。舞台载入一个模型后，先把它整理成一份统一的"已载入的模型"（`LoadedModel`，`types.ts`），舞台其余部分从这一份读，不再直接摸某一种格式的数据。模型文件一个字节都不改。记录：docs/claude/2026-11-19-model-adapter-and-vrm-display.md。

## 一份"已载入的模型"里有什么

| 字段 | 意思 | MMD（`mmd.ts`） | VRM（`vrm.ts`，第 1 步） |
|---|---|---|---|
| `format` | 格式标记 | `'mmd'` | `'vrm'` |
| `object` | 放进场景的三维对象 | 那个 SkinnedMesh | 一个 Group（0.x 在里面转 180°，整体放大到舞台单位） |
| `mesh` | 舞台的 MMD 机器（动作助手、物理、表情写入）驱动的那个网格 | 同 `object` | `null`：MMD 机器不碰它，舞台只原样显示 |
| `meshes` / `bones` | 所有蒙皮网格、所有骨骼 | 一个网格、它的骨架 | 所有网格、所有关节（去重） |
| `bone(slot)` | 标准骨骼 → 本模型骨骼 | 舞台原来的精确名字表 `MMD_STAGE_BONE_NAMES`（`upperBody2` 就是舞台的"胸"，照旧也收 上半身）；表外的交给模型画像 | VRM 自己的 humanoid 映射（`shared/stage/vrm/humanoid.ts`） |
| `expression(slot)` | 表情位 → 本模型的变形 | 按画像的别名表找名字（舞台的表情仍按画像校准写，这里还没人读） | VRM 自己的表情（happy、blink、aa…） |
| `finger(slot)` | 手指关节（MMD 编号）→ 本模型骨骼（第 2 步） | 按名字（`fingerSlotOfName`） | VRM 的人形手指（`VRM_FINGER_BONES`） |
| `expressionNamed(name)` | 按模型自己的名字找表情（第 2 步） | 同名变形 | 同名表情（lookUp、relaxed、自定义） |
| `faceShape(shape)` | I-164：她的脸的动作用的命名形状（cheekPuff、tongueOut、mouthCornersDown…） | 不提供（MMD 经模型画像找） | 先找同名或别名的表情（自定义表情），再找网格上同名的形状，最后用 VRoid 零件的拼法（`shared/stage/vrm/face-shapes.ts`）；`expression(slot)` 没有预设的じと目、嘟嘴也按那份拼法 |
| `lookAt` | 眼睛怎么看（第 2 步） | `null` | 转眼骨或用 look 表情，和它的 rangeMap（读不到用规范默认值） |
| `physics` | 物理描述 | `mmd-rigid`（刚体、关节个数） | `vrm-spring`：弹簧链（0.x 带 `leafTail`，重力方向已换到舞台的世界）、碰撞体（`shapes`，挂在哪根骨、偏移、半径）和碰撞组（`groups`）；第 3 步起由 `../vrm-spring/` 算（2026-11-21） |
| `rest` | 静止姿势（T/A）、原来的朝向、单位、缩放 | 量上臂；`+z`；12.5；1 | T；1.0 `+z` / 0.x `-z`；12.5；12.5 |
| `measureBounds()` | 包围盒（相机取景读它） | `Box3.setFromObject`，和原来一样 | 同，放下手臂后量 |
| `profileSource()` | 模型画像的输入 | `modelProfileInput(mesh)` | `null`（第 2 步） |
| `rig()` | 动作换算的骨架 | 和 `meshRigBones`/`meshMorphNames` 一样 | `null`（第 2 步） |
| `dispose()` | 释放 | `dispose.ts` | 每个网格都释放 |

## 舞台哪些地方已经从这里读

`src/stage/mmd/model.ts` 的 `loadModel`：相机取景的四个数（高、宽、中心、脚底）、找头、眼睛、两眼、胸、中心、两臂、模型画像的输入（`StageModelProfile` 收 `ProfileSource`）、动作换算的骨架（`StageMotionRetarget` 的 `rig`）、释放网格。还没接的（照旧直接读 MMD 网格）列在记录的「还没接上的」一节。

第 1 步起：`.vrm` 由 `mmd/model.ts` 的 `showVrmModel` 载入（动态 import `vrm.ts`，只有载 VRM 时才加载 glTF 读取和 MToon）。`mesh` 为空，MMD 机器（动作、表情、视线、物理、红晕、摸头）都不碰她；取景、淡入淡出读 `loaded`。T 字手臂在载入时临时放到水平线下 65°（`relaxArms`、`DISPLAY_ARM_DOWN_DEG`）；旧舞台照旧这样。第 2 步起 Unbound 的引擎经舞台公开页的 `loadVrmForEngine` 载入（`relaxArms: false`，原样的 T 字），手臂由它的标准身体和待机放下（`src/unbound/model/`）。贴图走 `CappedTextureLoader`（`<img>`），因为页面的内容安全策略不许 `fetch()` blob 地址。

## 守的规矩

- **MMD 模型的样子和行为一点不变**：`tests/model-adapter.test.ts` 在 Gene 和几种玩具模型上逐项比对（原来的找骨头写法照抄在测试里）；改前改后用 `scripts/stage/still-look.mjs` 截图，逐像素一致。
- 只用 Three 本体（加载器在 `vrm.ts` 里），`mmd.ts`、`rest-data.ts`、`dispose.ts` 能在 node 测试里跑。
- 不读写文件、不联网：模型字节由舞台的资源地址（`mmd-asset:`）提供，这里只解析。
