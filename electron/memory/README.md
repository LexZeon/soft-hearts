# 记忆和关系（memory）

给别的 agent 看的部分说明。总入口见 handbook/for-other-agents.md。

## 1. 这部分做什么

她记得的东西：聊天记忆、画像（她对你的了解，你可以改、删）、日记、每周和每月的回顾、她的笔记、你的计划（她记得你说过的事，到时间提醒）、一起看和一起听的记录、称呼和关系阶段、文字纪念、特别的日子。还有"按意思想起"（语义回忆）和删除的回收站。

用户感觉到的是：她记得你；你说要忘掉，她就真的忘掉（先进回收站，能找回）；你关掉"允许记录"，她就停止记下新的东西。

## 2. 文件在哪

- 三个文件夹：`electron/memory/`、`shared/memory/`、`src/memory/`。
- 公开页：
  - `electron/memory/index.ts`（导出 `MemoryStore`、`DiaryWriter`、`AppJournal`、`UserProfileStore`、`RelationshipHost`、`UpcomingHost`、`ReviewStore`、`TextMemorialHost` 等）
  - `shared/memory/index.ts`（导出 `MemoryConfig`、`UserProfileView`、`RelationshipStage`、`RecycleBinView` 等）
  - `src/memory/index.ts`（导出 `MemoryPanel`、`JournalPanel`、`UserProfilePanel`、`MovingMemoryPanel`、`TextMemorialPanel` 等）
- 接线：按功能拆成三个文件（2026-11-17，`docs/claude/2026-11-17-split-initiative-memory-wiring.md`），改一个功能只读一个；别的部分仍只从 `memory-wiring.ts` 拿（功能文件的导出在那里原样转出）：
  - `electron/wiring/memory-wiring.ts`：`MemoryNeeds`、`wireMemory(given)`（存端口、记忆自己的数据地图登记、造画像的来源、文字纪念和"清除她记得的歌"的回收站包装）、全部处理函数（`register`）；
  - `electron/wiring/memory-profile-wiring.ts`：`startMemory(...)`，ready 链里的一步，造画像、日记、回顾、她的笔记、移动的记忆、计划、聊天笔记、按意思想起；
  - `electron/wiring/memory-recycle-wiring.ts`：数据地图和回收站，`privacyStores()`、`recycleStores()`、`recycleSingle()`、`registerPrivacyStores(owner, …)`，`startRecycleBin()`（造回收站和它的宿主、I-014 找回的接法）。
- 数据地图和回收站的文件：`electron/foundation/data-map.ts`（每一样存储怎么删、怎么关"允许记录"）、`electron/memory/recycle/character.ts`（删角色时的顺序）、`electron/memory/privacy-wiring.ts`、`electron/memory/recycle-wiring.ts`。
- 留在 `electron/main.ts` 的：
  - **体验记录和应用会话**：`appJournal`、`journalExtras`、`appSession` 在 main.ts 里造，别的部分在 main.ts 求值时就读它们，移动它们要先改所有读者（4d 记录，没搬）；
  - 特别的日子（I-059）的创建，和留给你的东西一起造；
  - "清除她记得的歌"（I-077）的处理函数，它属于感知，经记忆给的回收站进回收站；
  - 我们的小东西、Claude 助手的回收站接法（它们的主动、安全代码还在 main.ts）；
  - 安全的存储登记（`registerPrivacyStores('safety', …)`），等它的接线收尾时带走。主动的那一份已随第 4e 步搬进 `electron/wiring/initiative-wiring.ts`。

## 3. 从哪进、谁调用它

- main.ts 在原来 `activateUserProfile` 的位置调用 `wireMemory(...)`（角色卡接线之后）。
- ready 链里调用 `startMemory(store, companion, activateUserProfile, initTextMemorials, …)`，把回收站、宿主和读入回收站放在 `cards.register` 之前（卡的处理函数要往回收站里删）。
- `memory.register(partIpc('memory'))` 在录制器里，位置是原来 `listMemories` 的位置。注册的有：聊天记忆（列出、读、改、删进回收站、设置）、文字纪念五个、画像 / 日记 / 计划 / 回顾 12 个、最打动她的那件三个、称呼和关系阶段三个、一起听记录、聊天笔记、回收站四个、按意思想起的开关、删一条听到的记录。
- 时钟：`clockTick` 里有 `diaryWriter.tick()`（一天一次，写缺的日记）、`reviewWriter.tick()`（一周、一月的回顾）、`herNote.writer.tick()`（她的笔记，每天 04:00 后，你不聊天时）。时钟条目目前仍由 main.ts 传入。
- 生命周期：这部分没有自己的窗口事件。关"允许记录"走 `privacyStores()`，删角色走 `recycleStores()`。

## 4. 它守着的规矩

- **角色卡里"里程碑"到没到，记在关系文件里，只记第一次**（I-207，2026-11-23）：`RelationshipData.cardMilestone`（本地日期，没有 = 还没到）；`RelationshipHost` 的 `reachCardMilestone`（第一次记日期并写一行体验记录 `card-milestone`，之后的记号一律不动）、`clearCardMilestone`、`restoreCardMilestone`；清除先进回收站（新种类 `card-milestone`，数据地图 `relationship` 一行登记了），跟着角色走（删角色一起删、备份带上），转换出来的新角色不带（`adopt`），导出的角色卡不带。读记号、每轮那句话在 `electron/wiring/card-milestone-wiring.ts`。测试：`tests/i207-card-milestone.test.ts`；变异 `I207-milestone-recorded-twice`、`I207-adopt-carries-milestone`。
- **熟悉度只给她事实**（I-210，2026-11-25，记录 `docs/claude/2026-11-25-familiarity-facts.md`）：开头那句只写认识第几天、第 k 级「名字」（共 5 级）、这一级已有效几天、到下一级大概还差几天（`stageReference`，`shared/memory/relationship.ts`；最高级没有"到下一级"；手设级别时不给数；英文卡读英文一句）。没有按级别的说明；昵称问句只留"问一次、`nick` 字段"，小事那句只说明这是日记里的几件小事。普通性格门槛 1/4/12/36 有效天数（`STAGE_BASE_THRESHOLDS`），性格系数 0.5～2 照旧乘；只升不降，老关系一次升几级。测试：`tests/relationship.test.ts`；变异 `M-I210-level-guidance-back`、`M-I210-thresholds-back`、`M-I210-reference-numbers-missing`。
- **角色档案只读，只给用户看，不进提示词**（I-208 第 1 步，2026-11-24，记录 `docs/claude/2026-11-24-i208-archive-step1.md`）：角色页「更多 → 档案」读 `electron/memory/archive/`（`reader.ts` 汇总、`search.ts` 搜索和分页、`readers.ts` 是和卡转换共用的只读文件读法，原来在 `electron/cards/character-convert/snapshot.ts`，那边仍转出同名函数）。一个窗口到主机的调用 `getCharacterArchive`（`shared/memory/archive.ts` 的请求格式，只收角色编号、搜索词、种类、偏移和条数；只给控制窗口；接线 `electron/wiring/character-archive-wiring.ts`，由 `memory-wiring.ts` 一行登记）。只读她自己的几份文件：每个连接的画像文件（日记、画像）、`upcoming-*.json`（计划）、聊天笔记（只取这些连接的聊天范围）、关系文件（熟悉度、里程碑到没到）；特别的日子是从画像文字里算出来的，和特别的日子同一个解析。不是她的卡的编号一个文件都不开；一个角色一次最多列最新的 1000 条，一页最多 50 条，每条最多 600 字；读到的结果只缓存 3 秒（翻页、搜索用），打开页面时重读。没有自己的删除：改和删仍在「用户画像」和各记忆页，删掉的进回收站。里程碑的读取也走这条（用户画像页那块的「清除」仍在闹钟通道上，先进回收站）。测试：`tests/i208-archive.test.ts`（12 项）；变异 `I208-archive-leaks-other-notes`、`I208-archive-unknown-id-reads`、`I208-archive-request-takes-anything`、`I208-archive-unbounded-page`、`I208-archive-host-open-to-all-windows`、`I208-archive-reaches-the-prompt`、`I208-archive-search-case-sensitive`。第 3 步（物件和批注）已加：见下一条。
- **她的页边批注**（I-208 第 3 步，2026-11-24，记录 `docs/claude/2026-11-24-i208-archive-step3.md`）：卡里声明了物件（`shared/cards/card-objects.ts`）的角色，她在回复里写看不见的记号 `⟪note|页码|话⟫`，回复完整结束后由 `electron/wiring/card-objects-wiring.ts` 读，记进这个角色自己的关系文件（`objectNotes`：`{ id, date, page, text }`，`RelationshipHost.addObjectNotes` 等；坏的一条读时被略过，带换行或括号的话不放行）。只有 Claude 一侧的代码写（记号，和用户在档案页的改和删），不随卡导出、不进诊断、不跟转换走、别的角色读不到；删的进回收站（种类 `object-note`）。档案页「她的物件」由 `electron/memory/archive/object-items.ts` 汇总（批注新的在前，原文按页码）；档案的读取调用仍然只读，批注的改和删借 `herAlarms` 通道（`electron/wiring/card-objects-call-wiring.ts`）。测试 `tests/i208-archive-step3.test.ts`；变异 `I208-notes-not-keyed-by-character`、`I208-adopt-carries-notes`。
- **删她记得的东西，先进回收站，能完整找回**（I-144）。删一条聊天、画像、日记、计划、回顾、称呼、文字纪念、听到的声音文字，都先拷下来进回收站再删。回收站没准备好，什么都不删。测试：`tests/memory-privacy-gates.test.ts`（23 项）、`tests/i144-recycle-bin.test.ts`、`tests/i144-recycle-host.test.ts`、`tests/i144b-recycle-items.test.ts`。
- **认脸数据和关"允许记录"是马上删，不进回收站。** 测试：`tests/data-map.test.ts`（数据地图里的规则），`tests/memory-privacy-gates.test.ts`。
- **删角色连带她的记忆，关"允许记录"清掉数据地图说的那几样。** 顺序由数据地图决定，不看部分登记的先后。金标准的 `privacy` 一节钉着顺序。测试：`tests/wiring-golden.test.mjs`（调换 `her-note` 和 `moving-memory` 会失败）。
- **回收站的内容只发摘要给控制窗口；接口只给控制窗口。** 测试：`tests/memory-privacy-gates.test.ts`、`tests/wiring-golden.test.mjs`、`tests/wiring-parts.test.ts`。
- **Claude 找回不会永久删除。** 找回角色和单条、找回聊天和画像，都不会永久删。测试：`tests/memory-privacy-gates.test.ts`。
- **英文角色自己的英文回复不算"漏出的草稿"。** 她的笔记（材料和写出的文字）、「最触动她的那一刻」（挑材料、核对引文、交接、清理）判断漏出的草稿时都带着角色语言（`character(scope).english`）；中文角色不变，内部标记对所有语言照丢。测试：`tests/english-drafts-memory.test.ts`；变异 EN1～EN6。
- **记忆、日记、回顾只读。** 日记和回顾的写入器只写它们自己的文件，不改记忆（brain-interface 2-18、2-20）。
- **体验记录的格式不变。** `shared/memory/journal.ts` 是用户稳定版里真实体验记录的格式：写出的每一行、旧行怎么读回，都由两份金标准钉住（`tests/journal-behaviour.test.ts`：60 种记录、79 207 个输入的行、面板文字和读回；`tests/journal-surface.test.mjs`：84 个导出的完整类型）。2026-11-16 起它只是核心，每种记录在所属部分的 `shared/<部分>/journal-entries.ts`（拆片记录）；`tests/journal-slices.test.ts` 管着拆法。

## 5. 测试在哪

- `node scripts/dev/ops.mjs owned memory`：只跑这部分相关的测试。
- test-parts.json 里 owner 是 memory 的文件有 78 个。
- 最重要的几个：
  - `tests/memory-privacy-gates.test.ts`（4d 新增，79 个变异全被抓）
  - `tests/data-map.test.ts`、`tests/i144-recycle-bin.test.ts`、`tests/i144-recycle-host.test.ts`、`tests/i144b-recycle-items.test.ts`
  - `tests/wiring-golden.test.mjs`（`privacy` 一节）、`tests/wiring-parts.test.ts`
  - `tests/user-profile-host-wiring.test.ts`、`tests/diary.test.ts`、`tests/her-note.test.ts`
  - `tests/i088-period-review.test.ts`、`tests/i089-recall-matter.test.ts`
  - `tests/character-scope-isolation.test.ts`

## 6. 改的时候小心

- **加一个存储，要做三件事。** 在数据地图（`electron/foundation/data-map.ts`）登记；在拥有它的部分的接线里 `registerPrivacyStores`；关"允许记录"和删角色的顺序照数据地图来。4d 记录：少登记一个，编译期就会报错（7 个变异全被 tsc 拒绝）。
- **`registerPrivacyStores` 的两张表**（`RECYCLE_STORE_OWNERS`、`RECORDING_OFF_STORE_OWNERS`）是编译期规则。改表时，要同步看 tsc 的报错。
- **接线文件之间有一个环**：memory-wiring 读 senses-wiring 的活绑定；senses-wiring 和 cards-wiring 调 memory-wiring 的 `registerPrivacyStores`。都只在函数里用，求值顺序无关。以后要是把登记表挪进基础层，环就没了。拆成三个文件后（2026-11-17），三个文件之间也互相读活绑定（`memory-recycle-wiring.ts` 读 `activateProfile`，`memory-profile-wiring.ts` 读 `privacyStores`），同样只在函数里用；登记表本身在 `memory-recycle-wiring.ts`，从 `memory-wiring.ts` 转出。
- **`startMemory` 里的 `noteGate.userBusy`（笔记和计划共用的忙闲判断）** 要照原样保留，AppPorts 的谓词要在接线里找到它。
- **数据地图的 owner 要和登记它的部分一致。** 4d 记录改过邀请记录（`text-invitations`）的 owner。
- **体验记录没搬。** 它的读者多，移动前要先把它挪到所有读者之前造，金标准的退出和 ready 链会跟着变。
- **加一种体验记录，放进它所属部分的片**（`shared/<部分>/journal-entries.ts`）：输入的样子、封闭词表、三个函数里各一个 case、`<部分>_JOURNAL_TYPES` 里的名字；再在 `shared/memory/journal.ts` 的 `JOURNAL_TYPES` 里加名字，在 `tests/helpers/journal-behaviour.ts` 的 `BASES` 里给合法输入，重新生成两份金标准并在提交里写理由。核心文件里不写任何一种记录的代码。片只能用自己部分的文件和基础层（两个部分都用的词表放 `shared/foundation/journal-fields.ts`）。
- **心情快照**（I-179）：`journal/mood-snapshots.ts`，应用开着每 5 分钟、启动和换角色各一条 `mood-snapshot`，由 `MoodJournal.view` 调用，开关关着不写也不攒；`withMoodNow` 给 mood-book 行补当时的全部心情数值。读取脚本 `scripts/experience/mood-timeline.mjs` 只读配置。
- **记忆里的"模型名"** 参与分区：换大脑，记忆看起来会"断开"（不是丢失，但用户会感觉到）。见第 7 节。

## 7. 和 Claude 有关的地方

- **1-11 记忆分区**（`electron/memory/memory.ts`，`scopeKey`）：聊天记忆按"角色 + 连接"分开存，连接里带模型名（`provider.model`，空值是 Claude Code 默认）。换大脑后，她的记忆会看起来"断开"。CLAUDE.md 的底线是更新不能让记忆断开，所以换模型名时要想清楚。
- **2-12 聊天笔记**（`electron/memory/memory-notes/host.ts`）：单次 haiku，七字段一行 JSON，只在后台、不忙的时候写，忙的时候让路，读 `claudeCallsInFlight()`。笔记会进记忆，写错了会一直带着。
- **2-13 提前记计划**（`electron/memory/upcoming/host.ts`）：单次 haiku 把你说的计划记成带时间的计划。记错时间，她会提错醒。
- **2-15 特别的日子**（`electron/memory/special-day/model.ts`）：生日或纪念日当天，她说一句（30 字内），最多两次。提示词里带最近的聊天（24 小时内，没有就没有）和"只写说出口的话"那句（I-178，2026-11-22）。
- **2-18 日记**（`electron/memory/diary/diary-writer.ts`）：一天一次，用聊天模型写。日记质量随模型变。
- **2-20 这阵子的回顾**（`electron/memory/period-review/writer.ts`）：一周、一月各一小段，答严格 JSON。只写资料里有的事，写不好就不写。
- **按意思想起**（语义回忆，`electron/memory/memory-semantic/`）：用的是本机的向量模型（许可证在 `electron/memory/memory-semantic/licenses/` 里，2026-11-16 核实）。是否完全不调 Claude：2026-11-16 核实，代码里没有调用（`vectors.ts`、`engine.ts`、`worker.ts` 都只在本机跑；路径里的 soft-hearts-claude 只是文件夹名）。brain-interface 里的登记情况不在本页核对范围。
- **3-4 内部通道的删除工具**：你自己的 Claude 删记忆，经"记忆桥"（`createMemoryBridge`）进回收站。它的参数和分级在 safety 部分（见 `electron/safety/README.md`）。
- **边说边演的拍子跟着聊天记录走（2026-11-20）**：profile 里的 `speech-beats.json`（大脑部分写，`electron/brain/speech-beats/archive.ts`）描述的是她的回复，所以聊天记录删了，它也不留：`MemoryStore.onTurnsRemoved` 在删一段记录、忘掉一个角色和连接的聊天时告诉它被删的轮次（`electron/memory/memory.ts`；I-186 起可以挂多个听的，大脑的进程池也听：删了谁的聊天就关谁的热进程）；进回收站、找回走数据地图的行 `speech-beats`（回收登记 `speechBeats`）、单条聊天记录的回收条目（`ChatRecordData.speechBeats`）、Claude 删除记忆的聊天条目（`recoverable-forget.ts` 的 `beats`）。重新读出历史时，`MemoryStore.recentShown` 带上只演不说的回复（正文是空的）的灰色小字，只用来画。测试：`tests/speech-beats-privacy.test.ts`、`tests/speech-beats-grey-reload.test.ts`；变异 `SB-P1`～`SB-P18`、`SB-G1`～`SB-G7`。记录 `docs/claude/2026-11-20-speech-beats-leftovers.md`。

## 每一条话带着是谁说的（I-209 第 2 步，2026-11-24）

- 聊天那边也要知道之前是谁说的什么。存档里每条消息可以带 `by`（角色卡编号和名字，`shared/memory/speaker.ts`）。她说的每一条（回复、主动说的）都带上她自己（`MemoryStore.setSpeakerSource`，接线按卡读名字）；用户的话不带，就是用户（来访者照旧 `speaker: 'visitor'`）。
- 旧记录没有 `by`：用户的读成用户，她的读成她自己；读不懂的 `by` 当作没有。`lineSpeaker`、`speakerName`（记录页）、`historyLabel`（交给 Claude 的历史写成"Gene：……"）。第 4 步"互相听见"把别人说的话带着她的 `by` 存进每位听者的历史。测试 `tests/i209-speaker.test.ts`，变异 `I209-speaker-lost-on-reload`。

## 开场问候只对从没开过场的角色（2026-11-25）

- `MemoryStore.hasOpened(characterId)`：这个角色在任何连接下，有没有一条聊过的普通记录，或她的开场问候已经显示过（来源 `greeting` 的那一行）。她自己的观察、同框的话都不算；聊天记录关着时返回 null。`companion.recentChat()` 把它作为 `opened` 带给窗口，窗口（`src/brain/greeting-gate.ts`）只对 `opened` 不是 true、没打过招呼的角色显示问候。体验记录多了两个 `character` 事件 `greeting-first` / `greeting-new-chat`（`electron/brain/long-chat/greeting.ts` 写，不存文字）。变异 `G1`～`G5`，测试 `tests/greeting-on-switch.test.ts`，记录 `docs/claude/2026-11-25-greeting-on-switch.md`。
