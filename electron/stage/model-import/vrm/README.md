# VRM → PMX 转换器（舞台部分 · 模型导入）

把 VRM（VRoid Studio 等做的 `.vrm`，glTF 2.0 的 GLB 文件）转成 soft hearts 舞台能载入、能动的 PMX。思路是"载入时先转换"：每种格式一个转换器，转成软件内部用的 PMX，舞台、动作、表情、物理全走现有的一条路。VRM 是第一个。记录：docs/claude/2026-11-18-vrm-to-pmx.md。

**现在只是开发工具**：2026-11-19 起应用直接原样载入 `.vrm`（I-152，不经过这个转换器，见 `src/stage/model-adapter/`）。这里留着，读 VRM 的部分当对应表的来源，写 PMX 的部分先不用、不删。

## 怎么用

```powershell
# 转换（写 model.pmx、tex/*、conversion-report.json；拒绝写进仓库和 OneDrive）
node node_modules/tsx/dist/cli.mjs scripts/model-lab/vrm-to-pmx.mts <in.vrm> <out-dir> [--mapping <file>] [--no-physics]
# 看舞台会怎么认它：模型档案（标准骨骼、表情槽、A 姿势）、头发/胸物理、程序红晕、和 Gene 同一段动作的手臂方向
node node_modules/tsx/dist/cli.mjs scripts/model-lab/pmx-check.mts <out-dir>/model.pmx [--motion pose/stand] [--at 1]
```

代码里：`convertVrmToPmx(bytes, { mapping?, physics? })` → `{ pmx, textures, report, model }`，纯函数，不读写文件。

## 映射（"怎么对应"是数据）

`conversion-report.json` 的 `mapping` 是这次实际用的完整映射；改完用 `--mapping` 传回去重跑（直接传整份报告也行）。以后"让 Claude 看懂不标准模型"的内置技能就是改这份映射。

| 字段 | 意思 | 默认从哪来 |
|---|---|---|
| `unitsPerMeter` | 每米多少 PMX 单位 | 12.5（MMD 惯例，1 单位 = 8 cm；和 Gene 同一量级） |
| `humanoid` | VRM 人形骨骼名 → 源文件节点名；转出后用 MMD 标准日文名 | VRM 的 humanoid |
| `boneNames` | 其他节点改名（节点名 → PMX 名），不写的保留原名（J_Sec_*、J_Adj_*） | 空 |
| `morphs` | 舞台要的名字（まばたき、あ、笑い…）→ 由哪些源变形目标、各多少组成；`panel` 是面板 | 先用 VRM 表情（blink、aa…），没有的按 VRoid 的 Fcl_* 名字找 |
| `sourceMorphPanels` | 源变形目标（Fcl_*）自己的面板 | 按名字：BRW 眉、EYE 目、MTH/HA 口、其他 |
| `physics` | `chains`（骨骼链，根到尾，hitRadius/stiffness/drag/gravity，用哪些碰撞体）和 `colliders`；`null` 不要物理 | VRMC_springBone / 0.x 的 secondaryAnimation |
| `aPose.armDownDeg` | 上臂（腕→ひじ）压到水平线下多少度 | Gene 的角度（随包的标准姿势，读自 gene.pmx，约 34°） |
| `materialOrder` | 材质绘制顺序（源材质名），没列的按默认规则排在后面 | 空 |

合并规则：记录类字段（humanoid、boneNames、morphs、sourceMorphPanels）按键覆盖，值写 `null` 删掉这一项；数组（physics 的 chains/colliders、materialOrder）和数值整个替换；`physics: null` 关物理。格式不对时整份拒绝，报出错的路径（如 `$.morphs.笑い`），不会半套用。

## 转换做了什么（文件）

| 文件 | 做什么 |
|---|---|
| `glb.ts` | GLB 容器、accessor（各种类型、归一化、稀疏）、内嵌图片 |
| `vrm-read.ts`（2026-11-19 搬到 `shared/stage/vrm/vrm-read.ts`，这里转出；舞台原样载入也用它，并多读了 lookAt） | VRM 1.0 / 0.x 读成同一个样子：人形骨骼、表情、弹簧骨骼和碰撞体、MToon 描边；0.x 的拇指改名、表情预设改名、碰撞体偏移 z 翻转、朝 −Z |
| `mapping.ts` | 映射的类型、默认映射、用户映射的合并和校验、Gene 的 A 姿势角度 |
| `scene.ts` | 节点的世界矩阵；0.x 转 180°、缩放到 PMX 单位 |
| `skeleton.ts` | PMX 骨骼：标准日文名、全ての親/センター/グルーブ、上半身和下半身都挂在グルーブ下、腕捩/手捩、両目（按 Gene 的 0.15 带动左右眼）、足ＩＫ/つま先ＩＫ（膝只向前弯，-180°～-0.5°）、A 姿势 |
| `mesh.ts` | 合并网格（共用顶点的图元共用顶点）、按原样蒙皮到 VRM 静止姿势再按骨骼的 A 姿势烘进顶点/法线/变形偏移、KHR_texture_transform 烘进 UV、权重（合并、腕捩/手捩沿骨分担、去掉 0.5% 以下、最多四个、归一） |
| `materials.ts` | 材质顺序（不透明 → 遮罩 → 脸上的半透明层：虹膜、高光、眼线、睫毛、眉 → 后发、头发 → 其他半透明）、头发和半透明的三角形从后往前排、双面、描边、贴图文件 |
| `morphs.ts` | 每个源变形目标一个顶点变形；舞台名字做成组变形；表示枠 |
| `physics.ts` | 弹簧骨骼 → 刚体（链的每段一个动态胶囊、挂在父骨的运动学锚上）和关节；碰撞体 → 运动学刚体；按身体部位分组，静止时已经重叠的碰撞组不碰 |
| `pmx-writer.ts` | PMX 2.0、UTF-16LE、无附加 UV；Three 空间 → MMD 文件空间（z 镜像、三角形反序、刚体欧拉角 x/y 取负） |
| `convert.ts` | 串起来，出报告 |

## 守的规矩

- **不读写文件、不联网**：纯函数；命令行只读输入和映射、只写输出文件夹，用模型实验台的路径守卫（`scripts/model-lab/guard.ts`）拒绝写进仓库和 OneDrive（转出的模型是私人的），并挡住联网。
- **转出的名字要让舞台直接认出来**：标准日文名照 Gene 的写法（全角数字、`左足ＩＫ`），舞台、模型档案、自带 VMD 都按名字找。
- **方向和绕序**：MMDLoader 载入后她面朝 +Z、左手在 +X，每个三角形的绕序和法线一致（测试钉着）。
- **MMDLoader 不做 alpha 测试**：所有材质按文件顺序混合绘制并写深度，所以顺序就是叠放；不把材质的漫反射 alpha 改小（会被挪到透明队列最后画）。

## 测试

- `tests/vrm-to-pmx.test.ts`（11 项）：在测试里现造的小 VRM（`tests/helpers/synthetic-vrm.ts`，1.0 和 0.x 两种），用 MMDParser 读回、用 MMDLoader 建网格，查骨骼名和父子、IK 链和膝盖限制、权重、表情映射和面板、A 姿势（和 gene.pmx 量出来的角度比，模型档案认成 A 姿势）、朝向和绕序、材质顺序和贴图、物理（舞台的物理装配认出头发）、改映射输出跟着变、报告里的映射重跑得到同样的字节、坏映射被拒。
- 绝不用用户的模型做测试。

## 还没做的

见记录的「留下的事」：应用里直接载入 `.vrm`、MToon 的阴影色和边缘光、兜帽/裙摆在舞台里动（舞台的物理现在只认头发和胸）、脸红变形（靠程序红晕）。`じと目`（Fcl_EYE_Close×0.5）和 `mouthPucker`（Fcl_MTH_U + Fcl_MTH_Small×0.1）从 2026-11-19 起由转换器按"混合"做（`mapping.ts` 的 `mix`），见 记录；鼓腮、吐舌 VRoid 脸上没有，不做。
