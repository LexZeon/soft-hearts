# 窗口模式：桌宠窗口用 Unbound 的引擎（I-154）

记录和功能覆盖表：docs/claude/2026-11-19-unbound-in-window.md。

## 做什么

桌宠窗口里的她、控制窗口里的预览，都由 Unbound 的引擎画（身体、待机、嘴、个人感过滤），桌宠页面上别的东西（工具条、气泡、聊天、通话……）照旧。**I-176 第 3 步（2026-11-23）：老舞台（`src/stage/MmdStage.ts` 一族）和选引擎的开关「桌宠用 Unbound 引擎（实验）」已删，这是唯一的引擎**；开发者面板里只剩「个人感」滑块（`window-style-slider.ts`）。控制窗口的预览只拿 `preview-port.ts` 的两个窄口子。记录 docs/claude/2026-11-23-i176-delete.md。

**全屏 Unbound 用同一套（2026-11-20）**：这里的脸、触摸那几层（`window-face.ts`、`window-face-rig.ts`、`window-blush.ts`、`window-pinch.ts`、`window-tears.ts`、`window-life.ts`、`window-model.ts` 的量模型）全屏页面也在用，经 `../her/index.ts`（说明 `../her/README.md`）。它们不碰 DOM、不分模式；改它们时两个模式一起变，两边的测试都要跑（`tests/unbound-full-shares.test.ts`、`tests/unbound-full-face-gene.test.ts`）。以后挪进 `../her/` 是机械的一步（记录 `docs/claude/2026-11-20-unbound-full-shares.md`）。

## 文件

| 文件 | 做什么 |
|---|---|
| `index.ts` | 对外只经这里：`createWindowStage`（桌宠窗口给引擎的口子，控制窗口给预览的口子和授权；个人感强度从页面存储读）、`followWindowStyle`（强度一变就地用上）、`UnboundWindowStage` |
| `window-style.ts` | "个人感"强度（0..1），存在这个配置的页面存储里（`localStorage` 键 `soft-hearts.window-style.v1`）；读不到就是 0。已删的开关存在 `soft-hearts.window-engine.v1`（`{on, style}`），新键没值时读它的 `style` 一次，其余忽略；`watchWindowStyle`（别的页面改了就地用上）、`announceWindowStyle`（写的那一页自己听不到 `storage` 事件，写完告诉这一页） |
| `preview-port.ts` | **安全线（第 7 批）**：控制窗口的预览能问主机的：引擎的口子（旧舞台在控制窗口本来就调的几个读；她的动作的回报留在这里不出去，自动身体动作的计划拒绝）和预览授权（个性化眉眼 / 表情 / 姿势的回执和授权、动作库的预览文件、模型档案和动作适配分数）。没有感知，没有 Unbound |
| `host-ports.ts` | **安全线**：引擎能问主机的只有这里挑出来的方法：是不是审过的 Gene；第 5 批加了旧舞台在同一个窗口本来就调的几个：聊天手势、她的动作、行为表情、自动身体动作的资源和计划（读），以及她的动作的回报（`reportHerAction`，唯一一个写，告诉主机做了没有）；第 6 批加了她自己的生活里托腮、趴着的授权（`resolveHerLifeMotion`，读）。音乐不经这里：样本只在你开着「和她一起听」时由接线送来 |
| `window-stage.ts` | 舞台接口（`src/stage/stage-surface.ts`）的 Unbound 实现：画布、载入模型、每一帧、点击穿透的像素探针；只做接线。载入、换模型时淡入淡出的时长读 `shared/stage/presence-times.ts`（入 420 ms、出 320 ms，旧舞台同一对数，I-176 prep） |
| `window-readouts.ts` | **I-176**：画布上的诊断读数。老舞台往画布 `dataset` 里写约 40 个字段，给开发者模式、预试用和真应用冒烟脚本读；窗口只写了两个，删老舞台时补上脚本读的那些（旧名字、旧键）：`presence` 一直写，其余只在开发者模式写——`frameClock`、`poseContinuity`（可见骨头的跳变监视，窗口没有显示守卫，数的是守卫本会接住的）、`moodFeedback`、`cheekPinch`、`chatGesture`、`behaviorMotion`、`bodyMotion`、`motionTransition`（交还的桥）、`modelPhysics`、`crying`、`music`（2026-11-26：听没听到、是不是音乐、她选的档、舞让给了谁、身上显示了多少、写了几帧，`window-music.ts` 的 `readout()`）。只写画布，不读不写别的 |
| `window-view.ts` | （头的区域用共用的 `../her/head-region.ts`）桌宠自己的相机和取景（跟着 Unbound 的地面抬高）、眼睛在窗口上的位置、脸的位置（气泡）、头的区域（摸头、喂食的嘴、捏脸的脸颊） |
| `window-model.ts` | 模型一载入（她还没动）就量的：包围盒、动作换算（和它的合身检查）、画像、程序红晕；第 5 批起载入模型本身（`loadWindowModel`）和"是不是审过的默认站姿"的检查也在这里 |
| `window-pose-layers.ts` | 2026-11-21：设置里的动作层变成引擎播放的片段；没选姿势层时放默认站姿（主机的 `getRestStand`，规则在 `shared/actions/rest-stand.ts`，和全屏一样），它载不进来就不放（记录） |
| `window-liveliness.ts` | 第 3 批：一帧里程序生命 → 脸 → 睡姿和睡着的身体 → 看谁 → 身体，合在一处；舞台和 Gene 测试跑的都是它 |
| `window-pinch.ts` | 捏脸（第 3 批）：旧舞台的 `CheekPinchMotion`，输出变成头、脖子、上身、髋的目标 |
| `window-sleep.ts` | 睡姿、睡着的身体、梦话（第 3 批）：`SleepPose` 给目标，`SleepBody` 作为 figure 的覆盖层（脚落地后、物理前）写全身；睡相。全屏也用它（第 G 批，`../her/out-sleep.ts`）：全屏传 `space`（她的模型在世界里的位置和朝向），睡着的身体从她自己的空间看世界相机、道具挂在她身边；窗口只传抬高，和以前一样 |
| `window-proc-life.ts` | 程序生命（第 3 批）：旧舞台的 `ProceduralLife`，输出加到目标上；开关「程序化小动作与表情」。全屏 Unbound 的程序生命也是这一层（`../her/out-face.ts`，H 批），开关只在两个桌宠窗口里 |
| `window-gaze.ts` | 姿势识别里看向你（第 3 批）：旧舞台的 `StageGazeAttention`；读数只在你开着姿势识别时有，内存里 3 秒 |
| `window-body.ts` | 她的身体：Unbound 的 figure + 待机层 + 嘴 + 个人感；她的脸的目标叠到窗口自己的生活上用共用的 `../her/face-goals.ts`（全屏叠在凑镜头、她自己的生活上用同一条）；不碰 DOM 和 WebGL，测试里用真实帧循环跑 |
| （I-170） | 聊天时头别乱晃：`window-liveliness.ts` 把你打字（舞台的 typing）、她想、她准备开口、她说合成"在沟通"，交给 `window-body.ts`（给待机层的目标 `talking`）和程序生命；只收待机层自己给头和脖子的晃动（旋钮 `shared/behaviors/talk-calm/knobs.ts`），看向你、跟鼠标、点头歪头都不变（记录） |
| `window-life.ts` | 窗口里驱动她的东西（纯函数）：看鼠标、眨眼、摸头 |
| `window-camera.ts` | 拖动调镜头：桌宠的 CameraController 挂在引擎画布上 |
| `window-pull.ts` | 拉她（第 1 批）：桌宠的拉她输入（`src/mood/` 里的拉她会话）调的 7 个成员，由 figure 的拉她层回答；腿交给步态，不走动 |
| `window-physics.ts` | 头发 / 胸物理和果冻（第 1 批）：`setPhysicsSettings` 送来的开关和调参台数值，照旧舞台的做法用在 figure 上。VRM（I-152 第 3 步，2026-11-21）：`attach(figure, springs)` 收它自己的弹簧骨骼（`StandardBody.springs`），同一份开关给它、藏起来暂停、预览里不算、表单显示它的支持情况、帧节奏看它的骨头（`springBones()`），不为标准骨架载入 Ammo |
| `window-pace.ts` | 你不在时少画（第 1 批）：旧舞台的帧时钟和节奏（`acceptStageFrame`、`StagePaceTracker`） |
| `window-face.ts` | 她的脸（第 2 批）：旧舞台的心情的脸和摸头（`MoodFeedback`）、说话时的小表情（`SpeechFaceStage`）、等回复时思考（`ReplyThinking`）、脸红（`BlushFollow`）、困了（`FatiguePresentation`、`DrowsyExpression`），同样的输入和让位；只给目标（表情位、头、眼皮、视线），引擎的弹簧缓进缓出。**体验记录 `blush-stage`（I-176 prep，2026-11-22）**：每个脸红线索第一次到这里时，用旧舞台同一个 `BlushSeen`（`src/stage/blush-seen.ts`）判断脸红显示出来没有（shown / no-cheek / face-busy / off / size-zero），经 `onBlushCue` 交给舞台的 `options.onBlushCue`（接线 `src/wiring/stage-wiring.ts`）；全屏页面不设，行为不变 |
| `window-face-rig.ts` | 这个模型的表情位（画像核过的、校准比例；VRM 按通用名字），绑到引擎的表情位弹簧；手选动作挡脸、挡嘴、挡头的规则 |
| `window-blush.ts` | 程序红晕画到 Unbound 网格上（载入时记下静止姿势，量脸颊时临时放回；校准、预览） |
| `window-expression.ts` | **「现在把表情 X 缓缓做出来」**：舞台的 `showExpression(name, {intensity, onset, holdS})`，展示的表情名和起落；睡着、藏着、手选表情时不开始；说话时表情里张着的嘴和鼓腮让给口型，嘴形（撅、笑）留着当底形，口型在上面开合（I-175，`shared/behaviors/part-mix/`） |
| `window-beats.ts` | 边说边演：舞台的 `speechBeat(word, span)`，每个词经展示的演员演，翻成窗口的目标（不走动；`blink-slow` 第 4 批由窗口自己演：一下慢眨眼加挂着的软眼皮）。表情、看向、眼神的拍子 `span` 为真时挂着（`../speech-beat-hold.ts`），到下一拍接手、`speechBeatsRelease()`（她说完、停止、新回复；睡着时自己放手）或 12 秒上限，再按演员平常的缓出落下去；身体的词不挂。I-185：kiss、hug 原地做（`shared/unbound/close-moments/in-place.ts`，同全屏的曲线去掉走路）：亲是闭眼、小前倾、嘴只在停顿里嘟（`frame` 的 `speaking`）；抱是手臂往前合拢、小前倾；手被占着或模型没有手臂（体检卡的"能做手势"）时只凑近一点、不张手；一个还在演时再来一个演轻一点的词 **2026-11-24：旋钮 `SPEECH_BEAT_WINDOW.windowCloseMoments`（默认关）关着时，`kiss`、`hug` 和 `hug-held`、`pause`、`let-go` 在这里一律不演，连轻一点的也不演。** |
| `window-games.ts` | 第 4 批：猜拳、递东西、牵手拉钩击掌（全屏第 B 批用同一个：`../her/out-games.ts`）。旧舞台的三个演员原样跑（`src/initiative/`），手臂读成设计（`armAim`，`src/initiative/arm-aim.ts`）交给引擎的 `ArmReach`（`'aim'`）；同一只手被两个占着时按旧舞台的写入顺序一层叠一层；表情给程序生命，牵手时身体的转向给上半身；道具在她这一帧之后放到手上 |
| `window-stage-games.ts` | 第 4 批这三件事的舞台成员（`setRps`、`startGive`…`handsNear`、`captureGivePicture`），夹在 `not-yet.ts` 和舞台之间，让 `window-stage.ts` 保持小 |
| `window-clips.ts` | 第 5 批：figure 混合器那一层的一次性片段（`figure.setMotionLayer`）：聊天手势（`ChatGesturePlayer`）、她的身体动作（`HerActionPlayer`，不带付与表，付与由 figure 之后解）、自动身体动作（`BodyMotionController` + `BehaviorBodyPlayer`，在 figure 自己的混合器里）、行为表情（`BehaviorMotionPlayer`）；要让开时从上一帧显示的姿势经一座桥（旧舞台的 `MotionTransition`）交还给平常的姿势，不切；桥带着动作当时的速度出发（`ShownRates` 记最后两帧显示的姿势，2026-11-21，记录），手腕正快时让开不急停 |
| `window-motions.ts` | 第 5 批：聊天手势、她的动作（身体的走 `window-clips.ts`，脸的走 `FaceExclusive`，写在所有脸的写入之后）、自动身体动作和行为表情的门和资源（旧舞台 `mmd/gesture.ts`、`body.ts`、`face.ts` 的规则）；每个"她的动作"都回报主机。全屏 Unbound 用的是同一个（`../her/out-motions.ts`，C 批）：动作环境多一个可选的 `walking`（她走路时不开始新的自动身体动作），窗口从来不设，行为不变。I-175：她念的时候撅嘴边说边做（交给她的脸当底形），鼓腮、吐舌排到停顿或念完（`window-mouth-actions.ts`） |
| `window-mouth-actions.ts` | I-175（记录）：她念的时候嘴上的动作：撅嘴经 `talkingFace`（舞台给的 `showExpression`）做成表情，口型照样开合；鼓腮、吐舌、亲排队（`shared/behaviors/part-mix/closed-mouth.ts`），带保持的"在说话"开着从不开始，停下来 3 秒没轮到就丢，停止和新的回复丢掉（舞台的 `speechBeatsRelease('cancelled' / 'new')`，全屏是 `speech-beat-player.ts` 的回调）。窗口和全屏共用 |
| `window-reactions.ts` | 第 5 批：对你打哈欠、伸懒腰、挥手的反应（旧舞台的 `PoseReactionStage`，只用你自己开着的姿势识别的读数；她自己的哈欠、伸懒腰和哈欠捂嘴的哈欠叠在上面），惊喜 / 害羞的表演（`ShowClock`，经程序生命的预览通道）和反应（`playReactionCue`） |
| `window-stage-motions.ts` | 第 5 批的舞台成员（`setTyping`、`setBehaviorBlocked`、`setBodyInputBlocked`、`playHerAction`、`expressionSupport`、`playExpression`、`playReaction`） |
| `window-stage-face.ts` | 她的脸的舞台成员（第 2 批的说话、思考、体检卡、红晕和校准、边说边演入口），第 5 批从 `window-stage.ts` 原样搬出 |
| `window-her-life.ts` | 第 6 批：她自己的生活（旧舞台的 `HerLifeStage`）：活动是猜拳等表情的底、再到程序生命；托腮、趴着写在混合器那一层；门 `windowHerLifeGates`、托腮的加载器 `windowHerLifeLoader`（授权经口子） |
| `window-music.ts` | 第 6 批：跟音乐（旧舞台 `mmd/music.ts` 的一套：是不是音乐、想不想跳、舞、点头和侧头、歌的反应）；舞让开的顺序 `musicYieldReason`、样本只在开关开着时算 `musicSampleHeard`。全屏也用它（第 F 批，`../her/out-senses.ts`）：环境多一个只有全屏设的 `walking`（她走路时不跳），窗口从来不设。"她在不在听"由接线经 `MusicHearing`（`src/senses/music-hearing.ts`，2026-11-22）给：帧晚到不满 2 秒、采集状态换版本都不算停，开关关了、采集没了马上停；旧舞台走同一条。**点头（2026-11-24）**：和舞一样写在混合层（不再经程序生命），下巴在鼓点上最低（`src/stage/music-nod-beat.ts` 把相位拉到鼓点上），深度按音乐律动强度，让位对象和舞一样；告诉主机的听歌状态（`presence`）只写身上显示出来的（不到 35% 就是"没跟着动"）（记录）。**2026-11-26**："手选头部动作"按她动作的同一条规则：选的姿势或手势动了头才算；她的默认站姿也动头，以前被当成手选的，舞和点头一直让开（记录，`window-own-life.ts` 的 `musicEnvOf`）。让开时各留多少走 `musicKeeps` 和 `music-yield/knobs.ts`（现在全是 0，就是原来的行为；0.2.1 的 I-227 改这些数） |
| `music-yield/knobs.ts` | 2026-11-26：舞和点头遇到每个让开的原因各留多少（I-227 的接缝）。现在全是 0（完全让开，原来的行为）；只认 0 和 1，中间的份额要等舞和点头的 presence 能停在一个份额上 |
| `window-tears.ts` | 第 6 批：眼泪：哭的时间线（`CryingTimeline`）和"能流泪"的门（`windowTearsGate`）；泪痕本身由 `window-blush.ts` 画（它管脸的材质，先拆泪痕再红晕再泪痕） |
| `window-under-layer.ts` | 第 6 批：figure 混合器那一层的底（托腮、舞），第 5 批的片段写在它上面；每帧后写先还原。全屏 Unbound 也用它当混合器那一层唯一的写入者（`../her/out-motions.ts`，C 批，暂时没有底） |
| `window-arbiter.ts` | I-174 第 1 条：她自己的小动作（待机停顿、重心换脚、看你一眼）走全屏同一个排程和仲裁（`shared/unbound/life/host.ts`、`arbiter.ts`）和同一个播放器（`../life/player.ts`）；窗口里“换个地方站”和“凑过来”永远不满足；你在互动时先收住。目标叠在窗口自己的目标上（`window-body.ts`），停顿给待机的时钟（记录） |
| `window-own-life.ts` | 第 6 批：一帧里音乐 → 她自己的生活 → 交给猜拳等，脸之后哭和泪痕；舞台和 Gene 测试跑的都是它 |
| `window-stage-music.ts` | 第 6 批的音乐舞台成员（`setMusicEnabled`、`setMusicSample`、`setMusicSettings`、`getMusicPresence`、`getMusicChoiceLine`、`setListenKindLine`、`rejudgeMusicNow`），夹在 `not-yet.ts` 和游戏成员之间 |
| `window-stage-inputs.ts` | 第 7 批先拆的：接线告诉她的（光标、说话、摸她、显示、心情、你不在、物理开关）和拉她的 7 个成员，连同它们的状态 |
| `window-stage-env.ts` | 第 7 批拆的：舞台读自己的（动作环境 `motionEnv`、反应那一帧）和第 7 批的钩子（"试一下"的状态、预览看到的舞台、截图的零件） |
| `window-stage-previews.ts` | 第 7 批的舞台成员：`previewCapability`、`previewVisual` / `cancelVisualPreview`、`previewBody` / `cancelBodyPreview`、`cancelSurprisePreview`（这个引擎没有 Gene 专用的惊喜片段，空；预览卡的状态行本来就是舞台的 `expressionSupport` 给的，`tests/unbound-window-preview-status.test.ts` 钉住）、`captureCharacterAvatar`、`captureCharacterStickerReference` |
| `window-stage-tools.ts` | 第 7 批的工具放一处：试一下、预览模式、诊断；每帧在身体之前、覆盖层、画完之后各接一次 |
| `window-capability.ts` | 体检卡「试一下」（第 42 行）：旧舞台的包络（`CapabilityPreviews`）交给窗口自己的写入者（眼皮、红晕、嘴、打盹、挥手、困的脸、眼泪）；门 `windowCapabilityPossible` |
| `window-previews.ts` | 控制窗口的个性化预览（第 43 行）：姿势（`WindowBodyPreview`，figure 的覆盖层）和眉眼 / 表情（`WindowVisualPreview`，经 `window-motions.ts` 的行为表情播放器），旧舞台同样的回执和检查；`EasedWeight` 用最小加加速度曲线缓进缓出（0.8 秒） |
| `window-preview-mode.ts` | 当控制窗口的预览时多的：网格、两个预览和它们的门、藏起来时暂停、物理只报支持情况、动作适配扫描 |
| `window-capture.ts` | 头像和贴纸参考（第 44 行）：旧舞台的取景和拒绝条件，截时藏网格 |
| `window-diagnostics.ts` | 诊断（第 45 行）：动作跳变记录（物理骨头；看得见的骨头一帧突变 ≥ 10° 记 `guard`，这个引擎没有显示守卫）、色块哨兵（伸手范围按睡觉道具放宽）；只有数字和名字 |
| `not-yet.ts` | **待办清单**：还没搬过来的舞台成员，每个一个不动、不报错的空实现。第 7 批起是空的（类留着当最底下一层） |

**VRM（I-152 第 2 步）**：`window-stage.ts` 遇到 `.vrm` 用 `../model/` 的标准身体（`StandardBody`）：引擎照旧驱动一副 MMD 样子的骨架，`window-body.ts` 每帧最后 `present()` 写到 VRM 上。VRM 上能做哪些，见记录里的「在 VRM 上」表。I-164 起（记录）VRM 也有脸的动作（`window-motions.ts` 的 `standardFace`：脸的动作写标准表情，再 `present()` 送到 VRM 上）、程序红晕和泪痕（`../her/vrm-blush.ts`）、睡着的身体（`window-sleep.ts` 收标准骨架的骨头）、捏脸的脸颊（按 VRM 自己的头投影）和它自己的体检卡（`window-face-rig.ts` 的 `card`）。

## 守的规矩

- **拉她只从她身上点中的那一下开始**：只有这个窗口为现在这个模型点中的才算；藏起来、睡着、手被牵着时不拉（`tests/unbound-window-pull.test.ts`，变异 `window-pull-*`）。
- **物理只照你存的开关**：关着不载入；关掉时物理自己淡出不拆；「碰了才软」完全照主机定的（`tests/unbound-window-physics.test.ts`，变异 `window-physics-*`）。
- **你不在时少画但不停**：不低于 min(设置, 24) 帧，她在动时照常全速（`tests/unbound-window-pace.test.ts`，变异 `window-pace-*`）。
- **她的脸照旧舞台的门**：体检卡（能脸红关了就不红；别的模型开了才有疲倦眼皮和困的脸）、手选表情时让开、摸她时说话的小表情和思考让开、说话的小表情不写嘴的形状、要说话时表情的嘴让开、换对话不带上一段的表情、睡着和藏着时表情和边说边演不开始、拉她或牵手时手的词不开始（`tests/unbound-window-face.test.ts`，变异 `window-face-*`、`window-expression-*`、`window-beats-*`、`window-life-mood-owns-pat`）；Gene 真实帧循环 60 / 30 fps 量不跳（`tests/unbound-window-face-gene.test.ts`）。
- **第 3 批的门**：捏脸没有心情视图不回应、手选表情时捏脸的脸让开、手选头部动作时不转头；审过的 Gene 且校准默认才用避开眼鼻嘴的脸颊；零食在嘴边时口型按权重让开；姿势识别的读数先检查、只用 3 秒、藏起来就忘、睡着不看；程序生命关掉慢慢收、说话吃东西时嘴的形状让开；体检卡关了"能做睡姿"就不打盹不躺下，头被占时睡姿让开（`tests/unbound-window-touch.test.ts`、`tests/unbound-window-lively.test.ts`，变异 `window-pinch-*`、`window-cheeks-*`、`window-mouth-*`、`window-gaze-*`、`window-look-*`、`window-life-*`、`window-sleep-*`）。窗口引擎自己不感知、不问主机"你在哪"：用的是桌宠窗口本来就在问的读数。
- **第 4 批的门（照旧舞台）**：猜拳或递东西占着她的手时不伸手牵你、鼠标在手边也不算"可以牵手"；这三件事占着她的手时边说边演的手势不开始（`WindowGames.armsHeld`）、睡着的身体让开、猜拳时打盹的头让开；窗口藏起来时不拍"送你一张图"；你拉她的手优先（`figure.ts` 里拉她写在手臂够取之后）；一只手正做别的手势时游戏的手臂等它放下、再按平常的速度抬起（`arm-reach.ts` 的 `tracking`）。测试 `tests/unbound-window-games.test.ts`（两个引擎在 60 / 30 fps 下都量），变异 `window-games-*`、`window-give-picture-hidden`、`window-aim-catches-up-first`、`window-pull-after-reach`。三个演员的手臂**不在这里写骨头**：要改猜拳、递东西、牵手的样子，改 `src/initiative/` 里的演员（两个引擎一起变）。
- **第 5 批的门（照旧舞台）**：打字、挪窗口、调镜头、摸她、喂她、指着她、拉她、递东西、牵手、手选手势、睡着的身体时聊天手势让开；摸她、调整窗口或镜头、猜拳、手选动作、正在表演时她的动作不开始并回报原因，正在播的平滑让开；说话时嘴的表情动作不开始（I-175 起：撅嘴边说边做，鼓腮、吐舌等停顿或念完），闭着眼时眼皮的不开始；打字、输入框激活、挪窗口、摸她时自动身体动作不开始，正在播的交还；睡着、你在（打字、说话、等回复、摸她……）时不对你的姿势反应；藏起来（没在画）时手势、动作、自动身体动作马上停，不留着接着演。维护者的 QA 站姿是旧舞台的开发检查，这里没有。测试 `tests/unbound-window-motions.test.ts`（Gene 真实帧循环 60 / 30 fps，和旧舞台同样的动作对比），变异 `window-chat-typing-yields`、`window-action-contact-busy`、`window-face-action-speech-busy`、`window-her-action-reports`、`window-clips-hand-back`、`window-reaction-asleep`、`window-hidden-stops`。
- **第 6 批的门**：她自己的生活照旧舞台的门（你在、更高的身体占有者、睡着；跟音乐跳算你在），加两条：伸懒腰或挥手的反应占肩膀、猜拳 / 递东西 / 牵手占手臂时托腮让开；托腮的授权只在同一个模型、同一段对话里有效。**跟音乐只经你自己的「和她一起听」**：开关关着时来的样本一律不算（不动、不判断、不查也不记歌）；说话、摸她喂她捏脸指着她拉她、挪窗口、调镜头、手选头部动作、睡着的身体时舞自己淡出让开，藏起来马上清掉；跳的时候她自己的生活和自动身体动作让开。眼泪：审过的 Gene 除非角色页关了"能流泪"，别的模型要体检卡开了；挪窗口、调镜头、手选表情时不哭。测试 `tests/unbound-window-life.test.ts`（Gene 真实帧循环 60 / 30 fps，旧舞台对照），变异 `window-music-*`、`window-life-music-engaged`、`window-herlife-arms-yield`、`window-tears-*`、`window-under-restore`。
- **figure 只接一个混合器层**：是 `window-under-layer.ts`（托腮、舞），第 5 批的片段经 `over()` 写在它上面。新的混合器那一层的东西加成它的一个写入者（`UnderWriter`），不要再调 `figure.setMotionLayer`。
- **这一层没有显示守卫**：旧舞台每帧最后有连续性守卫兜住一下子的跳，窗口引擎没有。所以 `window-clips.ts` 里任何一个要停的片段都经 `handOff` 交还（没有这座桥时：聊天手势被打字打断一帧跳 50°，自动身体动作 15°）。新加片段照这样做，不直接 `cancel({ immediate: true })`，除非窗口没在画。交还时桥从那一刻的速度出发、像临界阻尼的弹簧慢下来再回去（旧舞台从显示守卫读速度，这里从 `remember` 每帧记下的显示姿势算，`src/stage/shown-rates.ts`）；以前从静止出发，手势在手腕每帧转 3° 时让开，手腕的意外步长 3.3°（60 fps）/ 6.6°（30 fps），现在 0.38° / 1.51°。新加要交还的轨道，记得让 `remember` 记下它（`bodyTracks`、聊天手势的轨道已在里面），否则交还时没有速度。测试 `tests/motion-handback-velocity.test.ts`，变异 `window-clips-hand-back-speed`、`window-clips-hand-back-speed-forgotten`。
- **程序生命和睡着的身体按需载入**（`src/stage/index.ts` 的 `loadLivelinessForEngine`）：它们引用心情、主动性的公开页，静态导出会形成运行时循环引用。不要改成静态导出。
- **给「边说边演」和以后的调用者**：`showExpression(name, options)` 和 `speechBeat(word, span)`（和放手的 `speechBeatsRelease()`）是窗口引擎上演表情的入口；不要另写表情的写法，都经 `window-face.ts` 合成。

- **第 7 批的门**：控制窗口的预览只拿 `preview-port.ts` 的两个口子（名单查名字，没有感知、没有 Unbound；她的动作的回报不出去；桌宠窗口拿不到预览授权）。个性化姿势预览照旧舞台的门（藏着、手选姿势或手势、动态姿势、挪窗口调镜头、输入框、摸她、跟音乐、聊天手势时结束并告诉主机"停"），绑定要和预览对得上；到期自己结束不发回执；换模型、藏起来时马上丢。眉眼 / 表情预览在脸被占、摸她、挪窗口、调镜头、自动表现关时结束；结束都从当前缓出。"试一下"照体检卡（关着的那一项不演），那一处被占着时不演。预览里不跑物理。测试 `tests/unbound-window-preview.test.ts`（Gene 真实帧循环 60 / 30 fps，和"一下子摆上去"对照），变异 `window-preview-*`、`window-capability-*`、`window-body-preview-*`。
- **窗口模式碰不到感知和权限包**：引擎拿不到 `window.desktop`，只拿 `windowStageHost(desktop)` 挑出来的口子（名单里没有感知、没有 Unbound，测试也查名字）；不调用任何 Unbound 的主机通道。测试 `tests/unbound-window-engine.test.ts`（safety 两条），变异 `scripts/dev/mutations/unbound.json` 的 `window-engine-narrow-port`。
- **材质按文件顺序画**：渲染器用 `fileOrderRenderer` 装上排序（`src/foundation/draw-order.ts`），程序红晕、泪水换上的脸皮副本占原来的位置；不然脸皮排到眉毛、眼线、头发后面，眉眼上方漏洞、闭眼看得见眼珠（记录 `docs/claude/2026-11-20-mumi-brow-clip.md`，测试 `tests/draw-order.test.ts`，变异 `draw-order-*`）。新的渲染器、新的换材质都照这样做。
- **个人感强度**：存的不是 0..1 的数就当 0，写进去也夹在 0..1 里。变异 `window-style-unclamped`。
- **她不走动**：站位固定在原点（测试量根点一直为 0）。
- **不瞬移**：只给目标（`PoseTargets`），由引擎的弹簧带过去；摸头时眼皮的半闭自己做了临界阻尼。测试在 60 / 30 fps 下量每帧步长和"意外步长"。

## 搬一个功能过来

1. （第 7 批起 `not-yet.ts` 是空的：舞台接口新加的成员先在那里放一个空实现，再照下面搬。）在 `not-yet.ts` 里找到它的成员，挪到一层舞台成员文件（`window-stage-games.ts`、`window-stage-motions.ts`、`window-stage-face.ts` 那样）或 `window-stage.ts` 实现（要新的输入就加进 `window-life.ts` 或 `window-body.ts`，只给目标）；`window-stage.ts` 只做接线，别往里堆。
2. 要问主机新东西：在 `host-ports.ts` 加一个有名字的只读方法，并加进 `WINDOW_STAGE_HOST_METHODS`；不要传整个 preload。
3. 加 60 / 30 fps 的真实帧循环测试（`runWindowBody`），改记录里的覆盖表那一行。
4. 接线用到新的舞台成员时，先加进 `src/stage/stage-surface.ts` 的名单，两个引擎都要答得上。
