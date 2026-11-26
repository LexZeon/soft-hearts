# 同一套"她"：两个模式共用（I-154 后续）

记录：docs/claude/2026-11-20-unbound-full-shares.md。

- **窗口模式**（`../window-mode/`）= 这一套 + 站位固定在原点 + 桌宠窗口的取景和输入 + 桌宠窗口自己的权限。
- **全屏 Unbound**（`../main.ts`）= 这一套 + 走动、世界相机、凑镜头、权限包 + Unbound 自己的输入。

对外只经 `index.ts`。新的、两个模式都要的层放这里，不放进任何一个模式。

## 文件

| 文件 | 做什么 |
|---|---|
| `index.ts` | 公开页：下面这些，加上窗口批次做的那几层（`../window-mode/window-face.ts` 等，暂时还在那里，见记录里的"挪文件"一步） |
| `face-goals.ts` | `layFace`：她的脸的目标叠在"现在驱动她身体的那个"上（头、上身、脖子、髋相加；表情位取大的；手：脸有就用脸的）。窗口的 `window-body.ts` 和全屏都用它 |
| `head-region.ts` | `headRegion`：头顶、嘴、脸颊在屏幕上的区域（摸头、喂食、捏脸读它），哪个相机都行（像素大小由调用者给）。窗口的 `window-view.ts` 和全屏都用它 |
| `out-face.ts` | 全屏的脸：`HerOutFace`，窗口同一个 `WindowFace` + 眨眼和眼皮（`WindowLife`）+ 眼泪的时间线，每帧叠在驱动者（凑镜头、她自己的生活、边说边演、小动作，或没有）最后给的目标上；`faceLook` 决定她的脸能不能定视线 |
| `drop-zone.ts` | 全屏时拖进的图片只有在她身体（加 28 像素边）上才算零食，别处页面不接、松手不发生任何事；范围由页面的 `bodyDistance` 给（`out-page.ts` → `out-touch.ts` → 触摸输入的 `acceptsDrop`），桌宠窗口不设范围 |
| `out-touch.ts` | 全屏的触摸：桌宠窗口同一个触摸输入（`TouchInput`）挂在 Unbound 页面上，心情输入经 `src/mood/touch-session.ts`（两边同一份）交给主机 |
| `out-page.ts` | 全屏页面要接的都在这一处（`HerOut`）：上面三样、她的头区域、页面的提示（你发了一句话：她想；第一个字：不想了；气泡的字：说话的小表情）、`herTouchable`（能不能碰，和点她同一条规则）、`pagePress`（按在脸颊上是捏脸，页面的点击和拉她不接） |
| `vrm-blush.ts` | I-164（记录）：VRM 的程序红晕和泪痕：脸那一组网格拼成一块只用来量的网格（描边副本不算、名字去掉 " (Instance)"），量法和 MMD 一样；画在两边脸颊所在的那一块上，换上的副本占原来的绘制位置；量不到脸时，捏脸的脸颊用她自己的眼睛和嘴估。两个模式都经 `window-model.ts` 的 `measureWindowModel` 拿到 |
| `model-card.ts` | 全屏的体检卡：主机的体检记录（只读）加这一次载入的名字，和桌宠窗口同一个算法；你在角色页关掉的在全屏里也关着；从不问 haiku |
| `out-motions.ts` | 全屏的聊天手势、她的动作、自动身体动作（C 批，记录）：窗口同一个 `WindowMotions` / `WindowClips`；混合器那一层一个写入者（`WindowUnderLayer`，片段在上面），外面包走路只用上身；主机口子 `herMotionHost` 只拼窗口要的七样，页面状态翻成窗口的动作环境 `fullMotionEnv`（走路时不开始新的自动身体动作）。让开时的交还桥带着动作当时的速度出发（`WindowClips`，2026-11-21，记录）：手势在手腕正快时让开不再急停 |
| `walk-mask.ts` | 走路时她的片段只用上身（C 批）：髋和腿按片段之下原来的样子放回，权重 0.35 秒平滑进出，不切；VRM 的标准骨架用同样的名字 |

`out-face.ts` 里还有 H 批的程序生命（窗口的 `WindowProceduralLife`，目标加到脸上再叠到驱动者上；`lifeGates` 是它让开的门），`out-page.ts` 里有 A 批的红晕校准和她声音的事实（声音一开口气泡就不再定小表情的节奏，`bubbleTimesAccents`）。

嘴（I-175，记录，规则 `shared/behaviors/part-mix/`）：两个模式同一条。表情的嘴形（撅、笑）在她念的时候留着当底形，口型在上面开合，幅度打六折、元音跟着底形偏（`../intent-layer.ts` 让开张嘴和鼓腮、读底形，`../mouth.ts` 开合；全屏在 `../main.ts` 把 figure 交给 `mouth.apply`）。她念的时候撅嘴边说边做，鼓腮、吐舌排到停顿或念完（`../window-mode/window-mouth-actions.ts`）；全屏的停顿看 `out-page.ts` 记的气泡句子（`ShownSentence`），新的回复或出错时 `../speech-beat-player.ts` 的回调丢掉排着的（`dropWaitingMouth`）。
眼皮和头（I-175 第 4 步，同一份记录）：两个模式同一条。笑眼、半眯眼和眨眼共用眼皮时加起来不过闭上（`../intent-layer.ts` 的 `capLids`，规则 `shared/behaviors/part-mix/lids-head.ts`）；谁占着头按一个顺序：看向 → 点头 → 拍子的歪头 → 聊天时头稳 → 待机晃动，点头歪头占着头时待机自己的晃动收到三成（`face-goals.ts` 写 `headHeld`，`../motion/unbound-idle.ts` 读）。

聊天时头别乱晃（I-170，`docs/claude/2026-11-21-i170-calm-head-talking.md`）：`out-page.ts` 把"你发了一句、她在想、她的回复在来"交给 `out-face.ts`，它和"她在说"合成一个"在沟通"信号，放进给待机层的目标（`talking`）和程序生命的门；待机层（`../motion/unbound-idle.ts`）和程序生命各自按 `shared/behaviors/talk-calm` 收自己给头的晃动，她看哪里一点不变。
| `out-games.ts` | 第 B 批（记录）：猜拳、递东西、牵手在全屏，窗口同一个 `WindowGames`（三个演员、手臂经引擎的 `ArmReach`），世界相机下的「舞台」成员（给小窗的覆盖层用）；`withOutGames` 把游戏的手臂和前倾叠到她脸的目标上（游戏占着的那只手用游戏的，空着的手照旧演她的拍子）；每次开局 `onStart`（她自己的生活让开）；不拍她的图 |
| `out-play.ts` | 第 B 批：小窗的 `RpsOverlay`、`GiveOverlay`、`HandsOverlay` 原样挂在全屏页面上；命中测试多算这些控件（`distance`）；按在控件上是控件的（`owns`、`covers`）；猜拳台词由主进程放进她的气泡并交给桌宠窗口朗读（2026-11-25，页面自己不画气泡、不朗读，只按台词的阅读时间等；`outSayPorts`）；她的气泡不盖住按钮和比分（`avoid`，`rps-layout.ts`）；摸头喂食时收回东西、松手（`interrupt`） |
| `out-gaze.ts` | 第 D 批（记录）：看你。桌宠同一个选择器（`GazeAttention`），读数只在姿势识别开着时由主机送来、内存里 3 秒、空读数马上忘；"你"是观看者的眼睛（世界相机的位置），按读数挪到你的头所在的地方（I-167：屏幕平面上的点左右、上下都用，离屏幕多远按读数的距离；每个新读数当关键帧，和桌宠跟鼠标一样；`fullAim` 旋钮，默认 1；你的头朝着她才算对视，`looking.ts`）；她看你的方向是从头到这个点的完整方向（`lookToward`），叠在她自己的视线上（`composeLook`），驱动者要看哪里时照驱动者的；记录经 `herFact` 交给主机 |
| `gaze-debug.ts` | I-169（记录）：开发者层显示时画"她在看哪里"的标签和小点（视线与屏幕平面的交点，`sightOnScreenM`）；只读，开发者层收起时由 `overlay.ts` 拿掉。标签、小点和缓动在 `src/senses/gaze-debug-view.ts`。 |
| `out-senses.ts` | 第 D、F 批：窗口的 `WindowReactions`（对你动作的反应、惊喜 / 害羞）和 `WindowMusic`（跟音乐），门是窗口的门在全屏状态上算；反应的胸口、肩膀、挥手经 figure 覆盖层（上身），惊喜经程序生命的预览通道；舞写在混合器那一层（`out-motions.ts` 的唯一写入者，在片段下面），走路和拉她时让开（`outMusicEnv`）；音乐样本按桌宠的办法融合（`AudioDanceFusion`），主机的空马上停；帧停超过 2 秒才算停，短的停顿（主机忙一下）不算，她的音乐判断不重来（`MusicHearing`，`src/senses/music-hearing.ts`，2026-11-22）。2026-11-24：音乐设置（强度、"一直跟着跳"）从主机来（`onMusicSettings`），身上的听歌状态每秒检查、变了就经 `herFact('stage-state')` 报回主机，她在全屏时告诉她的话以这个为准（记录） |
| （`out-page.ts` 的 `closeMouth`、`armsFree`） | I-184 亲亲抱抱读的两个门：嘟嘴能不能开始（I-175 同一条规则：带保持的"在说话"、句子中间、捏脸占着嘴）和游戏占没占着手臂（`../director/close-moment.ts`） |
| `out-sleep.ts` | 第 G 批：窗口同一个 `WindowSleep`，按她在世界里的位置和世界相机选睡姿、放桌子枕头（`window-sleep.ts` 的 `space`）；睡着时步态目标钉住；离屏幕近、放不下睡姿时往后走到第一个放得下的地方（`SLEEP_SPOT`）；起身后走回原位 |

## 守的规矩

- **只认她自己的身体、这个页面自己的事件**：区域是她的头；能不能碰和点她同一条（显示一半以上、不在凑镜头的整窗穿透、页面没藏）；主机只收她显示着的窗口发的触摸输入（`electron/unbound/mood-bridge.ts`）。测试 `tests/unbound-full-shares.test.ts`，变异 `full-*`（`scripts/dev/mutations/unbound.json`）。
- **她的脸从不接管身体**：只给目标，叠在驱动者上；她走着也能摸、能捏，走法不变（`tests/unbound-full-face-gene.test.ts`，60 / 30 fps，每段意外步长不比不加脸大）。
- **视线**：驱动者要看哪里照它的；走路时看路；都没有时只有她的脸自己的一瞥能定视线（变异 `full-look-owner-walk`）。
- **她的游戏只经 Unbound 自己的口子**：主机只收她显示着的窗口的回答，你自己的动作还要她能被碰，收尾的回答永远收（`electron/unbound/games-bridge.ts`）；不交出她的图片。测试 `tests/unbound-full-games.test.ts`，变异 `full-games-*`。
- **睡下时不滑**：睡着的身体占着她时步态目标钉住（变异 `full-sleep-hold-place`）；她在走、在玩、被拉时睡着的身体先等；起身后走回原位。测试 `tests/unbound-full-sleep-gene.test.ts`（60 / 30 fps，近处和远处）、`tests/unbound-full-bg-vrm.test.ts`。
- **不加感知、不加权限**：只用桌宠窗口本来就用的心情视图、心情输入、体检记录，A、C 批加的红晕校准（只读）、她自己声音的事实（只读）、她的动作的资源和回答（主机只认正显示她的窗口，`electron/unbound/motion-bridge.ts`）。D、F 批（11-21）按用户的话接上了姿势识别和音乐的读数（见下一条）。
- **感知读数只经 Unbound 自己的只读事件**（D、F 批）：你在哪（姿势识别）、音乐样本只在来源开着时、只发给显示她的窗口、来源一关马上发空（`electron/unbound/sense-bridge.ts`）；她的记录（看你、听歌）经 `herFact`，只收那几种、只收她的窗口，她在外面时桌宠窗口的同类不收（一条只记一次）。测试 `tests/unbound-full-senses.test.ts`、`tests/unbound-full-senses-gene.test.ts`，变异 `full-senses-*`、`full-music-walking-yields`。
- **新层按声明的门叠加或让开**（D、F 批）：看你叠在她自己的视线上（走路时也叠，只是眼睛和头）；惊喜、"听一下"、跳舞经程序生命的 `show`、`beat`、`gates.music`（点头 2026-11-24 起和舞一样写在混合层）；舞让开窗口让开的，加走路；不为某个活动写特例（她自己的生活以后可能加带位置、要走过去的活动，按同样的门接）。
- **混合器那一层一个写入者，走路时只用上身**（C 批）：测试 `tests/unbound-full-ach-gene.test.ts`（走路时髋和腿和不加时差 0.000°），变异 `full-walk-mask`、`full-walking-body-gate`。

## 加一个两边共用的层

1. 层本身不碰 DOM、不分模式（只给目标），放进这里（或先在 `../window-mode/` 做好、再经 `index.ts` 导出）。
2. 窗口经 `../window-mode/window-stage*.ts` 接；全屏经 `out-page.ts` 接，`../main.ts` 只多一两行。
3. 两个模式都加 60 / 30 fps 的真实帧循环测试；全屏的要包括她在走的时候。
