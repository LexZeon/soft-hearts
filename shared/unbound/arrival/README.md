# 到达位置：贴过来的那一下（I-192）

记录：docs/claude/2026-11-22-i192-arrival-targets.md。

动作不再写"前倾几度、走几步"，而是写"身体哪个部位要到看的人眼前哪个位置、停多久"；走过去、前倾、最后几厘米由这里的规则算，换模型、换身高、换屏幕都一样近。纯规则：不碰 Electron、Three.js、时钟和随机数（调用的人给）。

## 文件

| 文件 | 做什么 |
|---|---|
| `face.ts` | 脸作为到达目标：瞄准点在眼睛和嘴之间；停多远 = 让"眼睛上沿到嘴下面"占满屏幕高度的 `faceFill`（`fit`），但鼻尖、刘海、头发（加上甩动的余量）离镜头至少 `minClearM`，会穿就提前停（`clip`），也不近于 `minFaceM`。脸的样子由页面从模型自己的顶点量（`src/unbound/model/face-measure.ts`），量不到时按身高估（`fallbackFace`）。凑近看的眼睛用同一条护栏（`eyeClearDistance`） |
| `solve.ts` | 站哪、前倾多少：头上的点随上半身绕骨盆上方转，头往回仰保持朝你；前倾受限（`ARRIVAL_LIMITS`），镜头比她高时少倾一点；站点让这个点正好落到镜头轴上的到达位置（横向、深度精确，剩下的高度交给踮脚或微屈）。凑近看的 `lens-align.ts` 也走这里 |
| `loop.ts` | 闭环：每帧量那个部位真实在哪，用骨盆挪动和踮脚补最后几厘米（凑近看原来的那个，搬来共用），有速度上限、有行程上限、不积分 |
| `frame.ts` | 2026-11-22 晚（Codex T-263）：脸是不是真的到了。`inWindow` / `frameWorst` 看两眼和嘴在不在画面里；`alongToFit` 算这些点还要沿镜头轴退多远才放得进画面（留 `frameInset`）；`headNow` 按两只眼睛现在的位置把头上量过的点转过去（防穿模按真实转头算）；`settledShift` 算闭环还能把她送多远（踮脚到顶就不再往上）。页面的 `FaceArrivalCheck`（`src/unbound/motion/arrive.ts`）用它们：踮脚也够不着镜头高度时把停的距离往外推一点（有速度上限、最多 12 厘米），两眼和嘴都进画面、头上没有一处近过护栏才开始停留，最多等 `arriveWaitS` |
| `hold.ts` | 停多久：她自己定（心情暖、熟、大胆更久，紧张更短），至少 `holdMinS`、最多 `holdCapS`；她在说话就一直停着（到上限），说完再停 `afterSpeechS`（嘟嘴只在不说话时出来） |
| （`release.ts` 2026-11-23 删了） | 什么让她提前退开，现在统一在 `shared/unbound/action-ends/`：动鼠标、打字、键盘、点她都不让亲抱看退开，只有大幅拉她和游戏（她的新动作）。（11-23 上午的"抱抱脸往一侧偏一点"`hugSide` / `besideAxis` / `hugSideShare` 已被 I-203 取代、删掉） |
| `screen-frame.ts` | I-203（记录）：终点写成"脸在屏幕上的位置"，照用户的分镜和图。亲亲 `kissFrame`：两眼在上部（`kissEyesV`）、嘴在下部（`kissMouthV`），由此定停多远；抱抱 `hugFrame`：镜头看到的那只耳朵（脸朝外转，看到右耳）在画面右侧（`hugEarU`、`hugEarV`），头宽占屏宽 `hugHeadShare`；开始前站在头宽占 `normalHeadShare` 的地方。头宽按脸宽算（两眼间距 × 2.2，头发不算：发型差太多）。`headAxes` / `headPointNow` 从两只眼睛还原头的朝向，`faceTurnSeen` 是镜头看到的脸朝哪边（+ 是画面右边）。`solve.ts windowPoint` 把一个点放到画面里的某个位置 |
| `knobs.ts` | 旋钮（脸占屏几成、最近多少、亲和抱侧脸几度、离镜头至少多少、头发余量、停多久、上限、说完再停多久、松手宽限；2026-11-22 晚加：眼睛和嘴离画面边留几成 `frameInset`、最多等几秒到位 `arriveWaitS`、凑近看放几只眼睛 `peekEyes`；I-203 加：亲亲眼和嘴的高度 `kissEyesV` / `kissMouthV`，抱抱耳朵位置 `hugEarU` / `hugEarV`、头宽 `hugHeadShare`，起点头宽 `normalHeadShare`，亲抱最少停 `closeHoldMinS`、亲亲时镜头最多往下迎她多少 `kissDipMaxM`；抱抱脸朝外转 `hugYawDeg` 改成 75°） |
| `index.ts` | 公开页 |

## 谁在用

- 页面：`src/unbound/director/close-moment.ts`（亲亲、抱抱：先走到"头占 1/5"的起点，迈近一步、前倾，`ShowcaseIntent.arrive` 交给 `src/unbound/motion/arrive.ts` 的闭环把脸送到；I-203 起终点由 `src/unbound/director/close-target.ts` 按 `screen-frame.ts` 算；闭环只在她脚站定后才踮脚（`arrive.toes`），从不在迈步时踮脚；抱抱脸朝外、手臂从两边往前绕过你、不进画面；亲亲时镜头（看的人的眼睛）往下迎她几厘米 `cameraDipM`，经 `src/unbound/floor-framing.ts` 平滑地降下、升回，最多 `kissDipMaxM`；从起点迈进来的那一步是一步快步 `walkBrisk`，只这一步），`peek-lens.ts`（凑近看：眼睛目标照旧，加防穿模），`director.ts`（`PoseRelease`），`speech-beat-hold.ts`（回复里的"凑近一点"停住）。
- 共享：`shared/unbound/close-moments/plan.ts`（亲抱的停留、侧脸角度）、`in-place.ts`（小窗和轻一点的抱抱同样停到她说完）、`shared/unbound/director.ts`（凑近看的停留）、`shared/unbound/life/host.ts`（只有通话、拉她、游戏、点她让凑近退开）。
- 主机：`electron/unbound/peek.ts`（`KeysRelease`；她的回复和朗读不再让她退开）。

## 守着的（变异 `scripts/dev/mutations/unbound.json` 的 `I192-*`）

- 脸、鼻尖、刘海、头发从不穿进摄像头（`I192-face-never-through-lens`、`I192-peek-never-through-lens`），抱抱的手臂不往镜头伸（`I192-hug-arms-to-sides`）；
- 每个预装模型上脸都到达到达位置（`I192-arrival-reached`、`I192-arrival-loop`）；
- 亲亲停住时嘟嘴出得来：她在说话就等她说完（`I192-pucker-shows-in-hold`、`I192-hold-after-speech`）；
- 2026-11-22 晚（`I192b-*`）：前倾计时到了不等于到了，两眼和嘴进画面才停住（`I192b-hold-waits-for-face`），等不到也不定住（`I192b-hold-wait-bounded`），够不着镜头高度时往外让一点（`I192b-face-push`），凑近看照旧一只眼睛（I-104 用户定的，`I192b-peek-one-eye`；两只眼是 `peekEyes` 里的备选）；
- I-203（`I203-*`）：抱抱脸朝外（`I203-hug-faces-outward`）、头在右侧（`I203-hug-ear-right`）、亲亲眼在上嘴在下（`I203-kiss-eyes-up-mouth-down`）、停留至少约 1.5 秒（`I203-hold-floor`）、抱抱不要求两眼和嘴进画面（`I203-hug-check-sees-ear`）、迈步时不踮脚（`I203-no-toes-while-stepping`）、抱抱手臂不穿镜头（`I203-hug-arms-stay-out`）；撅嘴是她选的（`I203-pucker-her-choice`，在 `../close-moments/`）；
- 打字、鼠标、键盘都不让她退开（2026-11-23 起；原来的 `I192-typing-never-snaps` 等四条变异随 `release.ts` 删掉，换成 `AE1`～`AE5`），回复里的"凑近一点"停住（`I192-lean-in-holds`）。

## 以后接

- I-193（她读自己的坐标、自己决定走到哪）：同一个"到达位置"，部位换成脚下的站点。
- 手到屏幕上某一点（递东西、点屏幕）：`solve.ts` 已经是"头上任意一点"，手要加手臂的那一段。
