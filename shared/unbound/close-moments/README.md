# 亲近的一下：凑近看、亲亲、抱抱（I-184）

记录：docs/claude/2026-11-22-i184-unbound-kiss.md。

只在全屏 Unbound（桌宠窗口不走动，不做）。纯规则：不碰 Electron、Three.js、时钟和随机数（调用的人给），不叫 Claude。

## 文件

| 文件 | 做什么 |
|---|---|
| `chooser.ts` | 一个选择器：`chooseCloseMoment` / `closeChances`。两条路：她自己（凑镜头的那个位子，这次是亲亲或抱抱还是只看）和你拉近（看、亲、抱、害羞退一步、什么都不做）。读心情（相对角色卡基线）、标签、角色卡心情模板（权重、强度）；不读熟悉度阶段（规矩清单第 15 条：程序不再替她把刚认识时的亲抱调低、调害羞）；门：不在全屏、睡着、通话、她在说、你在打字、你在拉她 → 都不；抱抱另外在游戏、递东西、牵手占着手臂时不 |
| `after-beat.ts` | 亲完抱完之后那一下（"按性格定"）：害羞（红脸别开眼）、笑、眨眼、满足、装作没事，按卡的权重和强度加心情 |
| `plan.ts` | 一次的计划（`planCloseMoment`）和过 IPC 的检查（`parseCloseMomentPlan`）。I-203：节奏照分镜（走近到位约 1.7 秒 `approachS`、退回约 1.2 秒 `backS`），抱抱的脸总是朝外（画面右边）转、头往她左边靠 |
| `extras.ts` | I-203：她自己的选择，叠在主线上：`pucker`（撅嘴，只亲亲）、`tuck`（退开时撩头发到耳后）、`blush`（凑近时脸红）。封闭词；她的话点了名就用（`planCloseMoment({ extras })`），没点就按心情、性格随机（`chooseCloseExtras`）。害羞（脸红、移开视线）是 `after-beat.ts` 的"之后那一下"，同样按性格选 |
| `timeline.ts` | 每一段的曲线（五次缓动，取消时带着当时的速度转回来）、`PuckerGate`（嘟嘴只在停顿里开始，开口就收回）。I-203：撅嘴、脸红只在她选了时出现；撩头发是退开时的一段（`tuckAt`、`tuckTiming`，被你拉开时不做）；退开时先下脚尖再迈步（`REACH_OUT_SHARE`） |
| `frames.ts` | I-203 分帧：`HoldFrames`（她的 `let-go` 在那个位置结束停留，走过来的路上写的就停够下限再松；`pause` 让她一直抱着；都没写就照原来的规则：话说完、也过了她定的时长，上限照旧）、`parseFrameBeatAsk`（页面说到 pause / let-go 时的报告，只认这几个键和词）、`pauseSeconds`（旋钮 `knobs.ts` 的 `CLOSE_FRAME_KNOBS`：约 2 / 4 秒）、`closeCutLine`（她回复里的亲抱被拉开或够不到时，她马上那一轮拿到的事实，中英文：哪一下、哪一帧、为什么、说过的、正在说的、还没说的；不给说法、不说怎么反应） |
| `words.ts` | 她下一句能看到的事实句（"你刚才自己凑过去亲了用户一下，然后笑了笑。"），不带指令词、不带数字 |
| `knobs.ts` | 旋钮：每天几次、冷却、拉近停多久算数、她自己来时最多占几成、（回复里亲抱的冷却 2026-11-23 删了）。亲和抱停多久、脸贴多近在 `../arrival/knobs.ts`（I-192） |
| `director-plan.ts` | 页面读命令里的计划：凑镜头的或这个 |
| `chat.ts` | I-185：她回复里写了 ⟦kiss⟧ / ⟦hug⟧，全屏页面说到那里时问主机（`parseCloseBeatAsk`）；`chatCloseBlock` 判能不能走过来：同一家的门（不在全屏、睡着、通话（只对 `CHAT_CLOSE_CALL_BLOCKS` 里的词；2026-11-22 起是空表，通话里亲抱放行）、你正在打字（最近 2 秒在框里按过键，不是框开着；发出去的那句不算）、你在拉她、另一个已经在演），**不含"她在说"**（嘴的门在页面上：`PuckerGate`）；手被占着时不抱；**没有冷却**。不过 → 页面演轻一点的，主机记一行 `close-beat-skipped`（封闭词 `CHAT_CLOSE_BLOCKS`），下一轮告诉她（`words.ts closeMissedLine`）；I-203 起亲抱本身不再留她后面的话（她走过来的路上话照常说），只有她放的帧留字（`electron/unbound/close-sequence.ts`，见 `frames.ts`） |
| `in-place.ts` | I-185：不走动的亲、抱（`InPlaceClose`，同一份计划和曲线去掉走路）：小窗里原地亲（闭眼、小前倾、嘴只在停顿里嘟）、原地抱（手臂往前合拢）；轻一点的抱抱（凑近一点、手臂张开一点，手被占着时不张）哪个舞台都用 |
| `index.ts` | 公开页 |

## I-192：脸贴过来、她定的停留

亲亲、抱抱在全屏里是"脸贴过来"（记录，规则在 `../arrival/`）：计划带 `yawRad`（抱抱脸颊侧过来、亲亲小转头），曲线多了 `reach`（脸到达的进度）和 `turn`（转头）两个通道；`holdS` 由 `arrivalHoldS` 按心情、性格定，停留时她在说话就停到说完再一会儿（`holdGoesOn`，`in-place.ts` 一样）。

## I-203：照分镜大修

记录。全屏：先走到头占屏宽约 1/5 的起点（居中），站一下，迈近一步同时前倾，脚站定后踮脚把脸送到终点（亲亲：两眼在上部、嘴在下部、上边缘切过刘海；抱抱：头在右侧约 2/5、耳朵约在 3/4 处、脸朝外被右边缘切掉、头顶出画），停多久她定（至少约 1.5 秒），退回起点再走回原处。撅嘴、撩头发、脸红是她的选择（`extras.ts`），害羞是之后那一下（`after-beat.ts`）。亲亲时镜头往下迎她几厘米（近景镜头比她踮脚够得着的高度高；只亲亲，抱抱和小窗不动）；从起点迈进来是一步快步（步态只在这一步起得快、刹得快）。小窗原地版照旧（共用曲线，所以节奏也变成约 1.7 秒到位、撅嘴同样是她选的）。

## 谁在用

- 主机：`electron/unbound/close-moments.ts`（`CloseMomentsHost`：选、计划、记录），`electron/unbound/peek.ts` 从凑镜头的同一个通道发（整窗穿透、一动鼠标就退开、超时）；页面报到 `hold` 才算亲到：心情时刻 `kiss` / `hug`（体验记录 `moment-kiss` / `moment-hug`）、计数、下一句的事实句（`electron/unbound/history-host.ts`）。
- 页面：`src/unbound/director/close-moment.ts`（导演的一个动作，走到前面、靠近、回去），嘴的门是 `shared/behaviors/part-mix` 的 `closedMouthMayStart`，手臂经引擎的 `ArmReach`（'aim'）；脸、手臂、看向的换算在 `src/unbound/director/close-pose.ts`（三处共用）。
- I-185 边说边演（记录）：全屏 `src/unbound/speech-beat-player.ts` 说到 kiss / hug 时问主机（`peek.ts` 的 `chatBeat`，经 `peekReport` 带回答），`play` 就从同一个通道演这一家（`via: 'chat'`，不计入她自己的次数，报到 `hold` 才记）；`lighter` 页面原地演轻一点的（亲 → 害羞地笑，抱 → `InPlaceClose` 小抱抱）。小窗 `src/unbound/window-mode/window-beats.ts` 原地演。旧舞台不演。

## 守着的（变异 `scripts/dev/mutations/unbound.json` 的 `I184-*`）

- 不在全屏、睡着、她在说时从不亲亲抱抱；她自己来的每天有上限；刚亲过拉近不再亲；
- 嘟嘴从不在她说话或一句没说完时开始，开口就收；
- 游戏、递东西、牵手占着手臂时不抱（主机不选，页面手臂让开）；
- 一次只记一次，没亲到（中途动了鼠标）不记。
- I-185：回复里的 ⟦hug⟧ 在手被占着时从不走过来抱（`I185-hug-arms-held-host`），小窗和轻一点的抱抱也不张手（`I185-hug-arms-held-page`）。
- 2026-11-22 晚（Codex T-261）：只记真的演了的。引擎动不了她手臂的模型（VRM 的标准身体没有自己的网格，`ArmReach` 量不到头，今天写不了手臂）上，抱抱照样是整套"脸贴过来"，只是手不动；页面每份报告带 `arms`，主机照样在停留时记一次抱抱，记录多一个封闭词 `arms: 'still'`，没有任何地方说手臂动了（`I192b-hug-arms-still-recorded`、`I192b-page-reports-arms`）。"轻一点的"只在手被占着、冷却等原来的门。

## 2026-11-25：16:26 的两件事

记录。

- **她自己伸出去的手不再吞掉她写的抱抱**：`chat.ts` 的 `closeArmsOf` 分清谁占着手臂（`game`：猜拳、递东西；`hand`：只是她自己伸手等牵手或正牵着）。`hand` 时 `chatCloseBlock` 不挡抱抱；走过来那一刻（`CloseMomentsHost.started`，亲亲也一样）手先收回（`dropHand`，舞台经伸手自己的收回动作回去，不跳），走过来、贴着的时候不再开始新的伸手（`electron/initiative/hands/host.ts` 的 `closeOn`）。猜拳、递东西照旧挡抱抱（轻一点的）。
- **一行记录**：她写的每一个亲抱，结局定了写一行 `close-beat`（亲到了 / 抱到了，或没做成和原因：挡下的封闭词、被拉开 `pulled-away`、脸够不到 `unreached`、开始玩游戏 `game`、超时、中途结束 `left`）。原来挡下时写的 `close-beat-skipped` 改由这一行代替（`waited` 和凑镜头的 `unreached` 照旧）。
- **话不抢在动作前面**：全屏里她写了 ⟦kiss⟧ / ⟦hug⟧，那一句照常边走边说，下一句起等真的亲上、抱住（`shared/behaviors/speech-beats/contact-hold.ts` 找位置，`electron/unbound/close-sequence.ts` 的 `contact` 等待）；亲亲贴着时照旧不说话，退开再说；抱住后照常说，⟦let-go⟧ 因此只会在抱住以后才到。没走过来、被拉开就马上放；页面没了消息最多等 `contactMs`（20 秒）。朗读开关开着关着一样（留的是回复的字流本身）。旋钮 `SPEECH_BEAT_CONTACT.wordsWaitForContact`（false 退回 11-23 的"后面的话不等"）。

## 以后接

- 出声（先不出声，不花 Drama 3 额度）：在页面 `hold` 时加一个声音来源。
- 小窗原地亲抱现在不记心情时刻（只有全屏走过来那一下记，见 I-185 记录「没做的」）。
