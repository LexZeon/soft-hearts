# 按部位分层混合（I-175）

方案 docs/claude/2026-11-22-i175-mixer-plan.md（1～4 按推荐；老舞台不接，I-176 删），记录 docs/claude/2026-11-22-i175-part-mixer.md。

属于 Unbound 部分（`scripts/dev/structure-parts.mjs` 的 BEHAVIOUR_PARTS），只给 Unbound 引擎（桌宠窗口和全屏共用的 figure）用；Unbound 的文件直接 import 这里的文件。纯规则：不碰 three.js、不碰时钟，测试用假时钟。

## 文件

| 文件 | 做什么 |
|---|---|
| `interface.ts` | 部位表 `PARTS`（眼皮、眉毛、嘴形、嘴的开合、脸颊、头、脖子、身体、手臂、手）、来源声明的类型（部位上是底形 / 叠加 / 独占、能不能边说边做、缓多久） |
| `sources.ts` | 每个来源的声明（待机、看向、口型、边说边演、点和摸的反应、脸红吃惊害羞、小动作、闭嘴类、递东西猜拳牵手、睡觉、聊天时头稳） |
| `knobs.ts` | 旋钮：`mouthTalkThrough`（0.6，口型在表情上的幅度）、`smileTalkThrough`（0.9，只是笑时的幅度）、`smileVowelMax`（0.2，笑时最多几成换成い）、`puckerVowelMax`、`flapFloor`（0.35，说话时嘴最少张开平时的几成）、`flapPeakGap`（0.24，每个模型校准到的张开）、`flapGapCeiling`（0.3，上限）、底形多强算满、元音偏到多少、张嘴让给口型的快慢、闭嘴类念完后等几秒（3）、朗读关着时句子多久算说完、眼皮上限、点头歪头多大算占着头、占着时待机晃动留几成 |
| `mouth.ts` | 嘴：每个形态算嘴形（底形，边说边做）/ 开合（口型拥有）/ 闭嘴类；`mouthBaseOf` 读底形；`talkThroughMouth` 给口型的幅度（说话时永远 ≥ 0.6，从不为 0）和元音（撅 → う/お，笑 → 最多两成い/え、其余あ，别的 → あ，缺口型回到 あ），再按这个模型每个元音张多大托住最小张开（2026-11-22）；`flapCalibration` 每个模型的放大和上限；`TalkEase` 缓动；`composeFeedMouth`（喂食和口型，从老舞台抄来，I-176 删老舞台后照用） |
| `mouth-gap.ts` | 2026-11-22（记录）：在模型自己的顶点上量上下唇分开多少（眼睛到嘴的距离算 1）；`mouthGapProfile` 给每个元音比あ张多大、あ满开多大。从模型取数据在 `src/unbound/mouth-geometry.ts` |
| `closed-mouth.ts` | 鼓腮、吐舌、亲：`closedMouthMayStart`（带保持的"在说话"开着从不开始）、`closedMouthMustWait`（嘴空闲但朗读关着、句子没完，直接请求也先排队；T-258 C01，记录）、`ClosedMouthQueue`（排到停顿或念完，停下来 3 秒没轮到就丢，取消的回复全丢，不补演）；撅嘴算边说边做 |
| `lids-head.ts` | 第 4 步：眼皮一个上限 `lidsUnderCeiling`（笑眼、半眯眼和眨眼共用眼皮的模型上，眨眼只拿形状留下的那份，加起来不过闭上；形状本身照常缓动；不共用的模型不压）；头的顺序 `HEAD_ORDER`（看向 → 点头 → 拍子的歪头 → 聊天时头稳 → 待机晃动），`headHeld` / `idleHeadScale`：点头、歪头占着头时待机自己的晃动收到三成 |
| （`../speech-beats/how-long.ts`） | "做多久"（第 1 步写在这里，第 3 步挪到边说边演的文件夹：读它的是边说边演的两处，经 `shared/brain` 的公开页）：`beatHold`（不写 = 照现在；once = 不挂；line = 挂到这句的停顿）、`sentenceEndAfter`、`LineHolds`（朗读到下一段 / 气泡出下一句时放手） |

## 谁在用

- `src/unbound/intent-layer.ts`：表情的形态写到模型上时，按 `talkFade` 让开开合和闭嘴类，嘴形留着；读 `mouthBaseOf` 给口型；眼皮过 `lidsUnderCeiling`（几何上量一次共不共用顶点）。
- `src/unbound/her/face-goals.ts`（两个模式铺脸的目标）写 `headHeld`，`src/unbound/motion/unbound-idle.ts` 按 `idleHeadScale` 收待机的头。
- `src/unbound/mouth.ts`：口型按 `talkThroughMouth` 开合、挑元音；喂食用 `composeFeedMouth`；载入时量一次嘴（`mouth-geometry.ts`），按 `flapCalibration` 校准；`lastReading` 给嘴型记录（`src/unbound/window-mode/mouth-reading-log.ts`，体验记录 `mouth-reading`）。
- `src/unbound/window-mode/window-motions.ts`（窗口和全屏共用）：撅嘴边说边做；闭嘴类经 `ClosedMouthQueue` 排到停顿。
- `src/unbound/director/close-moment.ts`（I-184 亲亲）：嘟嘴经 `closedMouthMayStart` 等停顿（`shared/unbound/close-moments/timeline.ts` 的 `PuckerGate`），她开口就收回。
- 边说边演的"做多久"：`src/brain/speech-beats-view.ts`（桌宠窗口）、`src/unbound/speech-beat-player.ts`（全屏），由舞台的 `HeldBeats` 挂和放。

## 守着的（变异检查 `scripts/dev/mutations/unbound.json`，`PM*`）

- 闭嘴类在带保持的"在说话"开着时从不开始；
- 说话时口型幅度从不为 0（嘴一直在动）；
- 取消的回复排着的形态从不补演（窗口 `PM4`、全屏 `PM5`）；
- 撅嘴边说边做、表情的嘴形说话时不让开（`PM6`、`PM7`）；眼皮不闭过头（`PM12`）；
- 2026-11-22：说话时嘴不会被表情压成闭着动（`MS1` 最小张开）、笑的元音是混合（`MS2`）、上限（`MS3`）、每个模型的校准（`MS4`）；嘴型记录只写白名单字段（`scripts/dev/mutations/stage.json` 的 `MR1`）；
- 标记的后缀从不漏进字里（`scripts/dev/mutations/brain.json` 的 `PM8`、`PM9`、`PM11`）。
