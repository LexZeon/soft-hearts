# 心情和反应（mood）

给别的 agent 看的部分说明。总入口见 handbook/for-other-agents.md。

## 1. 这部分做什么

她现在的心情，以及心情怎么变成她看得见的样子：表情、红晕、眼泪、困倦和睡着、被摸时的反应、每条消息后的小反应，还有"她也会需要你"。

心情按用户的设计分四层（设计依据在 `docs/mood/`，尤其 `expression-mapping.md`）：

1. **激素**：多巴胺 D、催产素 O、内啡肽 E、去甲肾上腺素 N、皮质醇 C（`shared/foundation/mood.ts`），加上腺苷 A（睡眠压力，`shared/mood/fatigue.ts`）。
2. **心情数值**：无聊 B、想念 M。激素表达不了的感受才加这一层，是有意设计的，**不要并进激素**。
3. **每次现算的**：倾向（想玩、想亲近、舒服、谨慎）、主标签、最近发生的事、变化快慢。"害羞""害怕"这类有名字的情绪，要看事件、关系和几种倾向，不是一个通道。
4. **性格**：就是角色卡里的基线、敏感度、衰减、倾向。读心情都是相对基线读。

用户感觉到的是：她的样子跟着发生的事慢慢变，不是按按钮切表情；摸她、喂她、晾着她，她都有反应，而且会记一会儿。

## 2. 文件在哪

- 三个文件夹：`electron/mood/`、`shared/mood/`、`src/mood/`。
- 公开页：
  - `electron/mood/index.ts`（导出 `MoodHost`、`MoodReplyProtocol`、`FatigueActivityBridge`、`HerNeedsHost`、`BlushCalibrationStore`、`PoseReactionHost`、`createTouchBrain`、`setTouchSink`、`startRealerExpiryWatcher` 等）
  - `shared/mood/index.ts`（导出反应表、倾向、心情调整员的词表和类型）
  - `src/mood/index.ts`（导出 `MoodCompanion`、`MoodJudgePanel`、`ReactionsPanel`、`BlushCalibrationControls`、`ProceduralTears`、`CryingTimeline`、`PetInteractionCursor` 等）
- 接线：`electron/wiring/mood-wiring.ts`（第 4f 步搬来）。入口：
  - `wireMood(given)`：main.ts 求值时调用一次，造心情调整员（I-027）、新的反应方式（I-037）、触摸的脑子（I-136）、困倦的活动桥；返回 `early()`（设好触摸往哪去）、`register(ipc)`（处理函数）和 `provides`（两个函数）；
  - ready 链里的几步：`startBlush`（红晕校准的存储）、`startRealerExpiry`（"更真实的情绪"到期，I-112 B）、`attachMood`（给心情宿主接上调整员和反应）；
  - 同步的两步：`syncMood`、`syncFatigue`；
  - 心情发布：`wireMoodPublish(steps)` 和 `publishMood(view)`，见第 3 节。
- 别的部分读的状态是接线文件的模块级活绑定：`moodJudge`、`reactions`、`touchBrain`、`fatigueActivity`、`blushCalibrations`、`moodModel`，还有函数 `companionCanExpress()`。
- **心情宿主本身不在这里造**：`MoodHost` 和"她也会需要你"在 `CompanionService`（`electron/brain/companion.ts`）里造，算大脑的核心。眼泪由舞台按发布出来的心情画（`src/mood/procedural-tears.ts`）。
- 留在 `electron/main.ts` 的：
  - 心情发布里属于舞台、主动、记忆、感知的那几步（它们读 main.ts 自己的函数）；
  - ready 链里给心情宿主接上其他部分来源的 setter；
  - 困倦的"准备好了"标志 `fatigueActivityReady`（ready 链在 registerIPC 之后打开，退出时关上）；
  - 1 秒时钟。

## 3. 从哪进、谁调用它

- **心情发布**：`CompanionService` 每出一个新的心情，就调用 `publishMood(view)`。它按 main.ts 给的顺序表，一步步跑各部分的反应（心情调整员看一眼、主动认领时机、舞台、记忆……）。顺序就是原来那个回调的顺序；某一步抛错，后面的不跑，和原来一样。
- main.ts 在安全的求助卡、主动的感知路由之后，感知拿走调整员和反应之前，调用 `wireMood(...)`，随后调用 `early()`。
- `mood.register(partIpc('mood'))` 在录制器里。注册的有：读心情、开发者模式、自动表现开关、音乐层级（只收桌宠窗口的）、心情参数的保存和恢复、红晕校准读写、直接互动（摸、捏脸、喂零食，只收可交互的桌宠窗口）、心情调整员开关、反应开关和六个反应倾向。
- 1 秒时钟和内心循环读 `companionCanExpress()`：她在屏幕上、没在被拖、你没在打字、她没在说话、没有聊天在跑、没在猜拳，才自动做表情或动作。

## 4. 它守着的规矩

- **心情发布每一步只跑一次，顺序固定。** 金标准的 `order.moodPublish` 钉着；调换两步或跑两次都会失败。测试：`tests/mood-gates.test.ts`、`tests/wiring-golden.test.mjs`。
- **触摸往哪去，在 main.ts 求值时就设好，只设一次。** 测试：`tests/mood-gates.test.ts`。
- **桌宠里拉她的报告（I-136 5a，预加载 `petTouch`）只认显示着、没最小化的桌宠窗口**，只取拉的固定字段（部位、左右、力度、方向、按了多久、怎么结束），主机加上种类、地点和自己的时间，再过 `parseTouchEvent`：`electron/mood/touch/pet-touch.ts`。测试：`tests/pull-session.test.ts`；变异 `scripts/dev/mutations/mood.json` PULL7–PULL9。
- **直接互动只收可交互的桌宠窗口**：要看得见、没最小化、没在被拖、有模型；别的窗口送来的一律拒绝。音乐层级也只收桌宠窗口的。测试：`tests/mood-gates.test.ts`。
- **红晕校准只对正在用的模型读写**：读到一半换了模型，就报错让你重读，不会存到别的模型名下。测试：`tests/mood-gates.test.ts`。
- **心情参数先核开发者模式和是哪个角色，再存**：先存卡，再给心情宿主，再通知窗口。测试：`tests/mood-gates.test.ts`。
- **她藏起来时不判断**：反应和心情调整员在她看不见时不调模型；她在回复时，常驻的 haiku 不重建。测试：`tests/mood-gates.test.ts`。
- **困倦**：退出时活动关上；只有处理函数都注册完，才算"准备好"；回复用的困倦只读那句话自己的范围和角色。测试：`tests/mood-gates.test.ts`、`tests/sleep-entry-ready.test.ts`。
- **心情调整员默认关；新的反应方式默认开**。
- **一次回复只记一次心情账**：这条由大脑的聊天一轮守着，这部分只接收。

## 5. 测试在哪

- `node scripts/dev/ops.mjs owned mood`：只跑这部分相关的测试。
- 最重要的几个：
  - `tests/mood-gates.test.ts`（第 4f 步新增，14 项。搬家前 53 个变异原来有 22 个没有测试抓，补上后全被抓；搬家后 56 个也全被抓，见 `docs/claude/2026-11-16-wiring-step-4f.md`）
  - `tests/wiring-golden.test.mjs`（`moodPublish` 一节）、`tests/initiative-gates.test.ts`（时机认领）
  - `tests/mood-gate-unanswered-param.test.ts`、`tests/sleep-entry-ready.test.ts`、`tests/r34-main-integration.test.ts`
  - `docs/mood/` 里各设计对应的测试，按文件名找（`blush`、`fatigue`、`reaction`、`touch`、`her-needs`、`tears`）

## 6. 改的时候小心

- **说清读写闭环。** 每个和心情有关的改动，都要写清它读哪些激素和心情数值、做出什么行为、写回什么。没有写回的，要说明为什么。
- **B 和 M 不是遗留。** 新的感受先看激素能不能表达；不能，才照 B、M 的样子加心情数值，写清什么让它升、什么让它降、和哪些激素互相影响。
- **心情发布的顺序表在 main.ts 里给。** 加一步要放对位置，金标准会跟着变，要逐行解释。
- **`companionCanExpress()` 的每个条件都单独有测试。** 加条件要加测试；去掉一个条件，她可能在你打字或她说话时自己动。
- **心情宿主是核心，不能被隔离关掉**（接线计划第三节）。反应、调整员、触摸、红晕校准这些单位可以。
- **姿势、手势、表情是独立通道**，心情只发布视图，不改 PMX/VMD 字节。
- **心情的体验记录带全部数值（I-179）。** `journal-change.ts` 组装每条心情变化：D/O/E/N/C 前后值，加 B、M 前后值、A、F、困倦阶段（都是读出来的，没读到就不写），聊天引起的带回合编号（只有编号）。形状和校验在 `shared/mood/journal-state.ts`；每 5 分钟的 `mood-snapshot` 在 `electron/memory/journal/mood-snapshots.ts`。加新的心情数值要同时进这里的 `MoodAux`/`MoodNow`，否则对照时看不到它。读法：`node scripts/experience/mood-timeline.mjs`（`docs/claude/2026-11-22-i179-mood-timeline.md`）。

## 7. 和 Claude 有关的地方

- **2-4 新的反应方式**（I-037，默认开）：每条消息后，一个常驻的 haiku 进程判断 0～2 个反应。"准备好"按启动 4 秒算。文件 `electron/mood/reactions/wiring.ts`。
- **2-4a 求助信息卡的危险判断**（I-117）：搭在 2-4 那一次调用上，多一个封闭字段。坏了只当没有，不丢反应。
- **2-5 心情调整员**（I-027，默认关）：一批消息后，单次 haiku 小幅调整 D/O/E/N/C 五个数（每个数、每小时、每次都有上限，`shared/behaviors/mood-judge/choose.ts`），每天的调用次数也有上限。只发类别、数字和你那句话（截短）；I-205 起还有最近几句聊天（和内心循环同一块，只当资料，反应判定员和停停说说同样）。
- **7-3 尾注标记**：她回复后面的内部状态块（心情反应、手势等）由聊天模型按说明写出，`electron/mood/mood-chat.ts` 的 `MoodReplyProtocol` 读。写漏、写错，心情就不更新。
- 换大脑时，2-4、2-5 要换成能答 JSON 的小模型（2-4 没有常驻进程时退回单次调用）；7-3 要聊天模型能可靠写出这些块。逐条见 `handbook/brain-interface.md`。

## 台上每一位都有活着的心情（I-209 第 2 步，2026-11-24）

- `stage-moods.ts` 的 `StageMoods`（`companion.stageMoods`）：全屏台上除了当前那位以外，每一位的心情每秒按在线走（隔太久按离线走），她的事件和心情抬升也按在线算（`MoodHost.setStageSource`）。第一次上台没有心情时按她卡上的模板建一份（`MoodHost.ensure`）。
- `MoodHost.liveOf(id)` 读她的心情（不发布）；`chatContext({ characterId })` 是她那一轮的心情一行。当前那位照旧是 `get()` 和窗口那一套。
- `onView` 是第 3 步每人独立界面的口子，现在没人接。记录 `docs/claude/2026-11-24-i209-step2.md`。
