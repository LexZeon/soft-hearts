# 角色卡（cards）

给别的 agent 看的部分说明。总入口见 handbook/for-other-agents.md。

## 1. 这部分做什么

她是谁，由角色卡决定。这里管角色卡的增删、切换、名册、头像和小贴图，导入和导出，建角色时和 Claude 讨论"这个角色是什么样"，以及把一张卡转成另一种语言。

删角色时，她记得的东西也要一起进回收站，用户能找回。

## 2. 文件在哪

- 三个文件夹：`electron/cards/`、`shared/cards/`、`src/cards/`。
- 公开页（别的部分只能从这里 import）：
  - `electron/cards/index.ts`
  - `shared/cards/index.ts`
  - `src/cards/index.ts`（导出 `CharacterCards`、`CharacterPage`、`CharacterStickerControls`；`CharacterVoiceControls` 由 `CharacterCards` 在角色编辑区里创建，窗口接线通过 `CharacterCards` 的 `voice` 选项给它默认声音、系统声音列表和试听）
- 接线：`electron/wiring/cards-wiring.ts`，入口 `wireCards(needs)`。它现在只有 `register`，没有 `early` 和 `start`。
- 留在 `electron/main.ts` 的：
  - `syncCharacter`：角色一变，通知各部分的那串扇出（以后要变成有序钩子表）；
  - 角色卡存储的创建：和舞台、感知的步骤穿插在 ready 链里，顺序被金标准钉着；
  - 调用 `splitCharacterFromModelAtStartup` 的那一步（函数本身在 cards）。

## 3. 从哪进、谁调用它

- main.ts 调用 `wireCards(...)`，再调用 `cards.register(partIpc('cards'))`。注册放在回收站宿主建好之后（删除要用它），内部通道录制器停下之前。
- main.ts 从 `cards.provides` 取出 `splitCharacterFromModelAtStartup`、`adoptCharacterForModel`，名字不变。
- 主要公开的东西（见 `electron/cards/index.ts`）：`CharacterCardStore`、`CharacterRevisionStore`、`CharacterCardUpdater`、`CharacterRoster`、`CharacterSwitchGate`、`activateCardCommitted`（换角色没换过去时角色卡回到对话所在的角色，2026-11-23 切换锁）、`CharacterStickerHost`、`CharacterAvatarStore`、`CharacterResponseService`、`CharacterUnderstandingHost`、`PersonalizeAuthoring`、`ConversionService`。
- IPC（处理函数）：接线文件 `electron/wiring/cards-wiring.ts` 里有 29 处 host 调用（按文本粗数，2026-11-16 核实）。主要有：卡、反应设定、个性化语言和它的研究、慢热、更真实的情绪、启用、换人、名册、新建、关联模型、小头像、删除（进回收站）、导入、导出、原地更新、理解讨论、贴图。
- 时钟和生命周期：这部分没有时钟条目。窗口事件仍在 main.ts。

## 4. 它守着的规矩

- **删角色先进回收站，能完整找回**（I-144）。删角色会连带她的记忆，那些存储由数据地图登记。测试：`tests/i144-recycle-bin.test.ts`、`tests/memory-privacy-gates.test.ts`、`tests/data-map.test.ts`。
- **角色卡只原地更新同一个角色**（体验与学习的约定）。测试：`tests/c3-card-update-in-place.test.ts`。
- **「慢慢熟悉」绑着角色，所有角色默认开**。没有 `slowWarmUp` 字段 = 开（预装卡、新卡、导入时没写这一项的卡、从没存过选择的老角色）；只有明确存了 `false` 才是关，并且存下来、导出也带。读它一律用 `slowWarmUpOf`（`shared/foundation/character-card.ts`），不要写 `=== true`。保存时没提这一项、用没写这一项的文件原地更新，都保留她存的选择。阶段仍由已有的相处天数算，开了不会把老关系重置成陌生。测试：`tests/slow-warmup-default.test.ts`、`tests/relationship-card.test.ts`；变异 `W1`～`W5`（`scripts/dev/mutations/cards.json`）。记录：`docs/claude/2026-11-20-slow-warmup-default.md`。
- **导入不授予文件或执行权限；导出不带路径、密钥、实时状态和私密历史。** 测试：
  - 导入：`tests/character-cards.test.ts:190`（导入的代码只当文字，路径、密钥、原型字段都拒绝）；`:268`（内置 Gene 的引用不导入也不导出）；`tests/character-response-portable.test.ts:38`（第 3 版导入时，多余字段、路径、运行时数据在建卡前就拒绝）。
  - 导出：`tests/c2-character-page.test.ts:187`（不带图片、模型路径、本机文件夹）；`tests/character-cards.test.ts:224`（主机专用的模型绑定导出时去掉）；`tests/diary.test.ts:355`（不带日记）；`tests/data-map.test.ts:369`（不带私密行、路径、角色文件夹）。角色卡格式里本来没有密钥字段（`shared/cards` 里搜不到 apiKey）。
  - 实时状态：导出函数（`electron/cards/character-cards.ts:780` 的 `export`）只从 `draftFields`（`:55`，人设文字、心情模板、卡自己的几个开关）取字段，不是整条存储记录，所以 id、模型路径与名字、"更真实的情绪"的到期时间和到期记号都不会出去；心情写的是角色卡的起始模板（`effectiveCharacterMood`），不是她此刻的心情；卡里没有对话、日记和实时心情这些字段。测试：`tests/character-card-export-allowlist.test.ts`（真的存储和导出函数：导出的键都在卡的字段里、上面这些都不在、文字里没有路径和密钥字样、导入器照样收）；存储里不认识的字段不出去另见 `tests/keep-unknown-fields.test.ts:268`。
- **角色页每张卡的「更多 → 档案」**（I-208 第 1 步，2026-11-24）：`src/cards/CharacterArchive.ts` 画一个角色的档案（日记、笔记、画像、特别的日子、计划、熟悉度，声明了里程碑的卡多一块），只读，一个搜索框；数据来自记忆部分的 `getCharacterArchive`（见 `electron/memory/README.md`），页上没有自己的删除，指向回收站。卡转换用的几个只读文件读法搬到了记忆部分（`electron/memory/archive/readers.ts`），`snapshot.ts` 仍转出同名函数。
- **卡里的物件只带名字和固定条目，不带她的批注**（I-208 第 3 步，2026-11-24）：卡字段 `object`（`{ name, entries: [{ page, text, source? }] }`，`shared/cards/card-objects.ts` 校验：名字 ≤24 字、1～64 条、页码 1～999 不重复、内容 ≤240 字、出处 ≤24 字、不含括号和竖线；多一个字段就拒绝，所以卡文件夹带不了批注）随卡导出、导入（v2、v3）、原地更新（文件有就换，没有就保留；确认框多一行）；persona 不含它（一个字没多）。预装 Gene 带《地球投递须知》32 条。她的批注在关系文件里（记忆部分），不随卡走。测试 `tests/i208-archive-step3.test.ts`；变异 `I208-card-object-takes-extra-fields`。档案页「她的物件」块在 `src/cards/CharacterArchive.ts`（编辑、删除先问）。记录 `docs/claude/2026-11-24-i208-archive-step3.md`。
- **卡里的里程碑只带"说法"，不带"到没到"**（I-207，2026-11-23）：卡字段 `milestone`（`{ name, notYet, reached }`，`shared/cards/card-milestone.ts` 校验：各 1～24 字、一行、不含括号和竖线）随卡导出、导入、原地更新（文件有就换，没有就保留，确认框多一行）；编辑器保存不动它。到没到是关系文件里的日期（记忆部分），不进导出。没声明的卡什么都不多。测试：`tests/i207-card-milestone.test.ts`；变异 `I207-export-drops-milestone`。记录 `docs/claude/2026-11-23-card-milestone.md`。
- **她的声音跟着卡走，但不带密钥**（I-162 第 1 步）。
  - 卡字段 `voice` 读进来时过一遍 `normalizeCharacterVoice`（`shared/foundation/character-voice.ts`）：不认识的字段丢掉，路径和链接不能当声音编号。
  - 导出只带服务商、声音编号、语速、音调和描述（`portableCharacterVoice`）。描述里像密钥、路径、链接的字也去掉。
  - 原地更新默认保留她现在的声音。角色页更新时，文件里带了另一个声音，会多一个勾选「也换成文件里的声音」（默认不勾）；勾了才换（`planCharacterCardUpdate` 的 `useFileVoice`，宿主 `CharacterCardUpdater.confirm(token, options)`），内部通道那条路永远不换。预览里文件的声音过 `portableCharacterVoice`，不带像密钥、路径的字。
  - 每次启动给还没有声音的卡记下她现在的声音；保存设置时，当前角色**自己的**声音选择（她的绑定、系统声音列表）变了，她的卡跟着变；改「新角色的默认声音」（全局服务商）谁都不动。这两步在 `electron/wiring/cards-ready-wiring.ts`。
  - 角色页的「她的声音」（第 2 步，`src/cards/CharacterVoiceControls.ts`）存声音走 `saveCharacterVoice`（`electron/cards/character-voice-save.ts`，窗口调用 `saveCharacterVoice(id, voice|null)`）：只写这张卡的 `voice`（过 `normalizeCharacterVoice`，不认识的服务商拒绝），不读出任何声音、不花钱、没有 Key 字段。
  - 测试：`tests/character-voice-card.test.ts`、`tests/character-voice-step2.test.ts`、`tests/character-voice-ui.test.ts`、`tests/c3-card-update-surfaces.test.ts` 最后一条；变异 C6～C8、S2-save-voice-accepts-unknown、S2-update-takes-file-voice、S2-confirm-forces-file-voice、S2-update-summary-not-portable、S2-page-tick-default-on、S2-save-previews-voice。
- **个性化语言的保存和撤销只给控制窗口。** 测试：`tests/personalize-language-host.test.ts`（4a 记录里补的覆盖缺口）。
- **个性化的研究和授权只给控制窗口**（默认 controlOnly）。测试：`tests/personalize-authoring-host.test.ts`。
- **换角色时，正在读的回复被清掉。** 测试：`tests/character-context-lifecycle.test.ts`。

## 5. 测试在哪

- `node scripts/dev/ops.mjs owned cards`：只跑这部分相关的测试。
- test-parts.json 里 owner 是 cards 的文件有 43 个。
- 最重要的几个：
  - `tests/character-context-lifecycle.test.ts`（换角色、syncCharacter 整条链）
  - `tests/character-model-split.test.ts`、`tests/c1-startup-split-records.test.ts`（模型和角色卡的拆分）
  - `tests/character-card-lint.test.ts`
  - `tests/i071-convert.test.ts` 和同系列 `i071-convert-fix*.test.ts`（转换角色）
  - `tests/wiring-golden.test.mjs`、`tests/wiring-parts.test.ts`

## 6. 改的时候小心

- **金标准**（`scripts/dev/wiring-golden.mjs` 生成的 `tests/fixtures/wiring-golden.json`）钉着注册位置和 ready 链。改 `cards.register` 的位置，金标准会变，要重新生成，并在记录里说明。
- `motionSelectionGeneration` 是 main.ts 的计数，cards 只能通过 `needs.noteModelSelection()` 写它。
- `syncCharacter` 留在 main.ts，不要搬进角色卡（它是跨部分的扇出）。
- `cards-wiring.ts` 只能伸进 cards 自己的内部。它要的回收站和动作类型，写成了结构类型，没有 import 别的部分的内部文件（规则 `wiring-imports-other-internal`，计数必须是 0）。
- 角色卡存储的创建在 ready 链里，不在 `register` 里。不要把它挪进注册，顺序会变。
- `registerCharacterStickerControls` 现在由 cards-wiring 注册，排在注册表的最后。

## 7. 和 Claude 有关的地方

- **2-17 角色理解**（`electron/cards/character-understanding.ts`）：建角色时，每一步一次单次聊天模型调用，整段讨论每次重放，答严格 JSON。读不懂就原样显示，不存。换大脑后讨论的口吻会变。
- **3-7 转换角色**（`electron/cards/character-convert/model.ts`、`translate.ts`）：单次无工具调用，模型和思考强度跟 Claude 助手一致。回答是一个 JSON 对象，格式不对问一次，还不对就停。翻译走样（漏事实、改语气）本机抓不到，只保证格式和长度。
- **1-10 个性化的文字和选图**：文字部分在 `electron/cards/personalize-authoring.ts` 和 `personalize-language.ts`，身体和画面的那一半在 `electron/stage/personalize-*.ts`（2026-11-16 核实两处文件都在）。注意：`handbook/brain-interface.md` 1-10 写的是 `electron/stage/personalize-*.ts`，这是旧路径，文件已经分到 cards 和 stage 两处，手册待更新。

## I-209 第 2 步（2026-11-24）

- `CharacterCardStore.getCard(id)`：按编号读一张卡（台上别人的一轮读她自己的卡、语言、名字，不读"当前角色"）。
- 角色页换角色、删当前角色卡时，只中止被换走那位的聊天任务（`electron/brain/turn-owner` 的 `companionChangeStops`；任务没有归属时照旧中止）。台上另一位正在说的话不受影响。"当前角色"只剩两处真是一个：控制窗口里选中、正在编辑的卡，和桌面陪伴窗口。记录 `docs/claude/2026-11-24-i209-step2.md`。


## 预装角色（0.2.0，`docs/claude/2026-11-25-six-presets.md`）

预装六张卡（Gene、One、Mumi，各中文和英文）：定义在 `shared/cards/presets/*.json`，名册和安装在 `gene-preinstalled-card.ts`（`PREINSTALLED_PRESETS`），模型钥匙和校验在 `bundled-character-models.ts` + `shared/cards/bundled-characters.ts`（`bundled:gene` / `bundled:one` / `bundled:mumi`，文件清单 `shared/cards/bundled-characters.json`，换模型后跑 `node scripts/dev/bundled-characters-manifest.mjs`）。只在全新配置里安装；已有配置只补完"记录在、没装完"的卡，从不新增。

预装模型不认安装位置（2026-11-26，`docs/claude/2026-11-26-update-blank-card.md`）：解压到新文件夹或换了打包版本后，设置和旧卡里还存着旧文件夹的路径。凡是落在某个安装的 `assets/bundled/` 里、位置对得上预装模型的文件（Gene 是 `mmdagent-ex/gene/<版本>/model/gene.pmx`，One、Mumi 按清单），都按它的钥匙算（`shared/cards/bundled-characters.ts` 的 `bundledModelKeyForInstalledPath` / `canonicalModelReference`）。舞台模型的身份由 `character-model-link.ts` 的 `stageModelIdentity` 算（接线只调用它）；比较模型（`sameModelReference`、`effectiveCardModel`）和切到卡时载入模型都先换成钥匙，所以载入的是这次安装自带的那份。存着的卡不改写。用户自己载入的模型照旧按路径比。
