# 她主动做的事（initiative）

给别的 agent 看的部分说明。总入口见 handbook/for-other-agents.md。

## 1. 这部分做什么

她自己开口、自己找你的那些事。包括：内心循环（后台定期判断她要不要说话或做个小动作）、冲动（她"想找你"的劲儿）、看一眼和听一下（需要时看一眼摄像头或屏幕，给一句话）、她自己看一眼、猜拳、喂食后的那句话、带我去（打开控制窗口的一页）、她的文件夹和留给你的东西、牵手、拉钩、击掌、递东西、我们的小东西、特别的日子（日子的判断在记忆部分，她的台词在这里），以及 R20 代办提议（默认关），和 I-188 她认出的时刻（深夜还在用电脑、一起看时屏幕上出了事、约好的提醒到点、从全屏程序出来、今天第一次见、离开座位回来、她困得快睡着：本机认出，再作为信息告诉她；I-203：她回复里的亲抱被拉开或够不到时马上那一轮，`close-cut`，不算她的自主行为、没有冷却、每次打断最多一轮）。

用户感觉到的是：她有时候自己开口。她开口前要先过同一个关口（见第 4 节）：你在打字、在聊天、她在说话或睡着时，她不开口。

## 2. 文件在哪

- 三个文件夹：`electron/initiative/`、`shared/initiative/`、`src/initiative/`。
- 公开页（别的部分只能从这里 import）：
  - `electron/initiative/index.ts`（导出 `createInnerLoopHost`、`ProactiveSpeechGate`、`HerFolderHost`、`RpsHost`、`TakeMeThere`、`R20ProactiveOffers` 等）
  - `shared/initiative/index.ts`（导出词表和类型，如 `RPS_HANDS`、`HER_FOLDER_ACTIONS`、`INNER_LOOP_ACTIONS`、`TAKE_ME_THERE`）
  - `src/initiative/index.ts`（导出 `RpsOverlay`、`GiveOverlay`、`HandsOverlay`、`HerFolderPanel`、`InnerLoopSection` 等）
- 接线：`electron/wiring/initiative-wiring.ts`，入口 `wireInitiative(given)`。它返回 `early()`（启动时开始她自己看的计时）、`register(ipc)`（处理函数）和 `provides`（三个函数）。按功能拆成四个文件（2026-11-17，`docs/claude/2026-11-17-split-initiative-memory-wiring.md`），改一个功能只读一个：
  - `initiative-wiring.ts`：`InitiativeNeeds`、主动发言的那一道关、数据地图登记、认领链 `CUE_CHAIN`、取消和确认她的主动句、全部处理函数（`register`）；
  - `initiative-look-wiring.ts`：I-040 看一眼听一下（`senseRouter`）、I-085 她想看才看（`selfLook`）；
  - `initiative-together-wiring.ts`：猜拳、喂食那句话、带我去、她的文件夹和留给你的、特别的日子、递东西、牵手（2026-11-25：全屏里她正凑近、亲抱时不开始新的伸手，`hands/host.ts` 的 `closeOn`；她写的亲抱走过来时她伸出的手先收回，`armsOn` / `dropHand` 交给 Unbound，`docs/claude/2026-11-25-close-moments-1626.md`；带我去的去处在 `shared/initiative/take-me-there*.ts`；新页面、新开关要登记，测试 `tests/take-me-there-coverage.test.ts` 会拦；I-173：手册里每一项要么通道能改、要么你的 Claude（`open_control_page {"item"}`）和她两边都带得到，`shared/initiative/take-me-there-items.ts` 给出那一页和要闪的元素，`tests/i173-reachable-options.test.ts` 会拦；见 handbook/how-we-work.md）；
  - `initiative-inner-loop-wiring.ts`：内心循环、松绑她的冲动、R20 提议（关着）；
  - `initiative-moments-wiring.ts`（I-188）：她认出的时刻读什么、往哪报；时钟里 `moments?.tick()` 排在开场选择的 tick 前面；聊天这一轮把你的话交给 `momentsChatTurn`（提醒；I-189 起也带本机姿势给的资料：点头回答的说明、画面里好像还有一个人、你问时的久坐数字）。I-189 的瘫坐、盯屏、久坐经主机的 `pose` 接口进来（`electron/wiring/senses-pose-uses-wiring.ts` 的 `poseUses.moment`），排在别的时刻后面，过同一道总闸。逻辑在 `electron/initiative/moments/`（主机、两个小存储）和 `shared/behaviors/moments/`（认出、作息、时间解析、给她的那句事实、旋钮）。
- 别的部分读的状态是模块级活绑定（`proactiveSpeechGate`、`moodCueOwner`、`innerLoopHost`、`impulse`、`rps`、`herFolder`、`keepsake`、`give`、`hands` 等）。功能文件里造的由 `initiative-wiring.ts` 原样转出，main.ts 和别的部分只从这一个文件拿，名字不变。
- 不在这里的：`companionCanExpress` 和心情发布本身在心情的接线 `electron/wiring/mood-wiring.ts`（第 4f 步搬走；主动经 needs 读前者，只接手后者的认领）。留在 `electron/main.ts` 的：聊天一轮的处理、ready 链 / 时钟 / 退出三个顺序表。体验记录和应用会话归记忆，不归主动。

## 3. 从哪进、谁调用它

- main.ts 在感知的 `cameraLookJournal` 之后调用 `wireInitiative(...)`，随后调用 `early()`（启动她自己看的计时）。
- 带我去（`take-me-there.ts`）：选项 `characterName()` 每一轮读当前角色的名字（去掉语言标记），「让<她的名字>看屏幕」和「让你/让她」一样算请求；名字不写在源码里，传进 `matchTakeMeThere(text, name)`。
- `initiative.register(partIpc('initiative'))` 放在录制器里，原来 `herFolder.register` 的位置。注册的有：带我去、她的文件夹、牵手、我们的小东西、内心循环开关、R20 三个、猜拳三个、喂食、看一眼那句、确认看一眼的那句。
- `provides` 交回三个函数：`initR20ProactiveOffers`（ready 链里 startMemory 的一步）、`claimMoodCue`（每次心情发布时问一次）、`cancelProactiveVision`（聊天一轮时取消外面还没说的主动句）。
- 1 秒时钟读 `innerLoopHost`、`impulse`、`rps`、`moodCueOwner`；退出时停掉十个东西（`selfLook` 例外，见第 6 节）。

## 4. 它守着的规矩

- **内心循环自己想说的（含被摸、递东西、提醒休息）提示词里带最近的聊天和"只写说出口的话"（I-178，2026-11-22）**：只在她这次可以开口时带；读取在 `inner-loop/context.ts` 的 `recentChat`，块来自大脑部分的 `proactiveChatReader`；猜拳和代办提议只加那一句。测试：`tests/i178-proactive-context.test.ts`。
- **她认出的时刻只给信息，不替她设计反应**（I-188）：每个时刻先过一道总闸 `momentGate`（开关、打字、通话或开会、睡着、没露面、不在），再要一次说话机会（说话间隔和每小时次数照旧；约好的提醒只看硬状态），开场选择交给内心循环（focus `moment`，掷互动余额，提醒除外），同一道主动开口的关。一条提醒只说一次（说出口才记成已提醒，重启也不复活）；屏幕上的事只在一起看开着时读。测试：`tests/i188-moments.test.ts`、`tests/i188-reminder-parse.test.ts`、`tests/i188-screen-events.test.ts`；变异 `i188-*`。
- **主动说话都过同一个关口**（`ProactiveSpeechGate`）。她睡着时，还没说出口的那句会被丢掉，不补发（T-209）。测试：`tests/initiative-gates.test.ts`。
- **一个心情时机只归一个部分认领**：先问手（她的小动作可能变成伸手），手拿了就不再问；再问开口（六个认领者）。谁拿了，记给时钟。测试：`tests/initiative-gates.test.ts`；金标准 `order.cueChain` 钉住这两步。
- **猜拳：答应那一轮告诉她事实，第一手提前定好；她的台词都要朗读；气泡不挡按钮（待复验）**：①答应那一轮的私有上下文（`rpsChatContext`，中英两版）只写事实：这句话说完游戏马上开始，身边会出现三个按钮、用户点按钮出拳、三局两胜；并且"你第一次要出的是X，用户还没出拳时就已经定下了"。第一手在答应那一轮、用户出拳之前抽好（`RpsHost.sealFirst`，同一个 `chooseRpsHand`），交给开局（`RpsMatchOptions.first`），第一局封存的正是它，所以她说的一定是真的；之后几局照旧。主进程的第二条路（haiku 事后判断是在叫她玩）她回复时没有这条上下文，没覆盖。②她在游戏里说的每一句都读出来：小窗照旧走平常的气泡和朗读；全屏 Unbound 里页面没有朗读，以前只画一个本页的气泡、什么都不读（这就是 16:28 结尾那句没读的原因）。现在主进程把每一句当成「她自己的一句话」放进她的气泡（有读出来的凭据），再让桌宠窗口按"读的就是显示的"读（`electron/unbound/game-line.ts` `GameLineRelay`，接线 `unbound-games-wiring.ts createGameLines`；桌宠窗口走 `held-lines.ts` 的 `game` 分支，只读、不进她的历史）。③没读出来的每一句写一行体验记录（`rps` 的 `line-unread`，原因是封闭的词：聊天或打字占着窗口、朗读关着、朗读出了错、她的气泡没露出来；从不记台词）。④她的聊天气泡不会盖住按钮和比分（`src/initiative/rps-layout.ts`，按钮在她抬起的手旁边，气泡压上来时按钮挪到最近的空地，不抖动）。小窗里没找到没朗读的代码原因（只在聊天占着窗口、你在打字、朗读关着、朗读出错时才不读），以后看体验记录的 `line-unread`。测试 `tests/rps-1628.test.ts`，变异 `R1628-*`。
- **次数、冷却、互动余额**（I-010）：开口、冲动、猜拳都先问余额；没说出口的时机，退回次数和余额。测试：`tests/initiative-gates.test.ts`。
- **取消要分清**：用户发消息时，外面还没说的主动句要取消；只是打字时，纪念邀请不取消。她的内心句只能由宠物窗口确认。测试：`tests/initiative-gates.test.ts`、`tests/user-profile-chat-wiring.test.ts`。
- **她的文件夹**：写文件只经她的文件夹的主机；文件夹关着就不写；状态文件留在配置里。测试：`tests/initiative-gates.test.ts`、`tests/her-folder.test.ts`。
- **她自己留心（闹钟）：开关在用户画像页，默认关；关着一字不加、不读、不响（I-195）**：她在回复里写 `⟪alarm|…⟫`（时间、日期、事、等他说到的词，可叠加；语法和限制在 `shared/behaviors/alarms/`，写坏的悄悄丢），记在 `reminders.json` 里（`moments/alarm-store.ts`，`by: 'her'`，和用户的提醒分开；每角色 5 个，等事的 3 天过期，各只响一次）；到点或事发生时作为 `her-alarm` 时刻走 `MomentHost` 同一条路（`moments/alarms.ts` 管开关、每轮提示词、取消的话、事件）。记号由边说边演的过滤器在所有路径里拿掉，从不漏进字。用户画像页（`src/memory/HerAlarmsSection.ts`）有开关和带取消按钮的清单；窗口到主机一个调用 `herAlarms`。记录：`docs/claude/2026-11-22-i195-her-alarms.md`；测试 `tests/i195-her-alarms.test.ts`；变异 `i195-*`。
- **深夜休息提醒**：同一晚不重复提醒，重启后也一样；记录文件在配置里，不写进开发日志。测试：`tests/initiative-gates.test.ts`。
- **猜拳的手不做手脚（规矩清单第 13 条）**：她的手是她自己点名的（`RpsMatchOptions.named`），没点名就均匀随机（`chooseRpsHand`），不再有"故意让着用户"；只在有习惯可读时第一局可能照习惯出（`read`）。她拿到的只有事实（谁出了什么、谁赢）。记录 `docs/claude/2026-11-25-rules-program.md`，测试 `tests/rps-game.test.ts`、`tests/rps-voice.test.ts`。
- **猜拳的手在揭晓前不给宠物窗口。** 接线里有这句注释（`electron/wiring/initiative-together-wiring.ts:41`），猜拳的比赛留在这边。测试：`tests/rps-game.test.ts:87`（揭晓前窗口看不到她的手，揭晓时封印核对通过）；`tests/rps-host.test.ts:178`（晚到的手不会看到她的手）。
- **数据地图**：猜拳、牵手、我们的小东西、留给你的东西，由主动登记（`registerPrivacyStores('initiative', …)`，`electron/wiring/initiative-wiring.ts:136-137`）。删除都先进回收站（I-144）：`electron/foundation/data-map.ts` 里这四样的 recycle 都是 take（猜拳 `:140`、牵手 `:154`、我们的小东西 `:157`、留给你的东西 `:171`）。关「允许记录」只影响前两样：猜拳记录整份删（`:141`），牵手只删所有角色的拉钩、计划跟着删（`:155`）；我们的小东西和留给你的东西不受影响（`:158`、`:172`）。测试：`tests/memory-privacy-gates.test.ts`、`tests/data-map.test.ts`。
- **R20 代办提议默认关**（`PROACTIVE_TASK_OFFERS = false`，注释写的是第一轮的产品决定）。

## 5. 测试在哪

- `node scripts/dev/ops.mjs owned initiative`：只跑这部分相关的测试。
- test-parts.json 里 owner 是 initiative 的文件有 44 个。
- 最重要的几个：
  - `tests/initiative-gates.test.ts`（2026-11-16 新增，14 项；记录里 54 个变异全被抓）
  - `tests/wiring-golden.test.mjs`（`cueChain`、`moodPublish` 两节，注册点数 32）
  - `tests/r20-proactive-offer-main.test.ts`（读接线源码，断言没改，求值时加了认领链的文字）
  - `tests/inner-loop.test.ts`、`tests/i086-give-wiring.test.ts`、`tests/i087-hands-wiring.test.ts`、`tests/rps-wiring.test.ts`

## 6. 改的时候小心

- **金标准**（`tests/fixtures/wiring-golden.json`，由 `scripts/dev/wiring-golden.mjs` 生成）钉着注册点、心情发布的每一步、认领链、退出和时钟。改它们，要重新生成，并在记录里说明。
- **认领链的顺序不能换**：手先，开口后。手拿了，开口就不被问。
- **顺序表里调用的函数不能放在接线文件的顶层**：`initR20ProactiveOffers`、`claimMoodCue`、`cancelProactiveVision` 都在 `wireInitiative` 里面造，经 `provides` 交回；顶层函数会被金标准就地展开，结构就变了。
- **四个谓词要一字不差**：`senseRouterFree`、`feedingFree`、`keepsakeCalm`、`specialDayCalm`，`wiring-skeleton` 的"一字不差"那项守着。
- **`selfLook`（她自己看）的计时在退出时没有停**。这是搬之前就有的，定时器是 `unref` 的，不拖住退出。要补，就在退出顺序里加一行 `selfLook.dispose()`，并改金标准的退出那一节。
- **体验记录和应用会话不要搬进这里**，它们归记忆。

## 7. 和 Claude 有关的地方

- **2-3 内心循环**（`electron/initiative/inner-loop/model.ts`，`decideWithClaude`）：单次 haiku，答 JSON。答偏了会影响她的动作，靠本机解析守住。内心循环的一句话和猜拳台词共用 2-1 的单次无工具调用（`quickLineWithClaude`）。
- **2-4 常驻的 haiku 待命进程**（`electron/initiative/inner-loop/warm-line.ts`，`WarmLine`）：Claude Code 第一条消息前不出声，所以"准备好"按 4 秒算，是按时间猜的。
- **2-7 猜拳的一句台词**（`electron/initiative/rps/wiring.ts`）：单次 haiku，严格一行 JSON。
- **2-16 她的文件夹的纪念**（`electron/initiative/her-folder/keepsake-model.ts`、`keepsake-prompt.ts`）：聊天模型，第一行是严格 JSON 头，后面是原样全文；带思考标签或头不对的一律拒绝写入。
- **2-21 她自己看一眼**（`electron/initiative/self-look/wiring.ts`）：haiku 看一张图，写一句；只在用户开着「发图片」时，画面会发给所选的大脑。I-168 起不限次数、不隔冷却：最坏约每小时 60 次调用（每分钟最多一次她自己想看），体验记录那行带"这一小时第几次"。
- **1-10 R20 代办提议**：生成走 `streamClaude`（`kind:'chat'`，`writable:false`），在接线文件的 `initR20ProactiveOffers` 里。默认关。`handbook/brain-interface.md` 1-10 仍写注入点在 `electron/main.ts`，待更新。
- **开口的选择**在 `electron/brain/opening-host.ts`，属于大脑部分，不在这个文件夹。主动只调用它。挑这一步本身不调用 Claude（该文件头注释第 10 行：挑这一步 0 次模型调用）；挑中之后说的那句，照原来的聊天路径走。
