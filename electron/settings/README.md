# 设置和控制窗口框架（settings）

给别的 agent 看的部分说明。总入口见 handbook/for-other-agents.md。

## 1. 这部分做什么

用户在设置里改的东西怎么存、怎么检查、怎么发到各处。还有陪伴命令：用户说"置顶""隐藏""呼吸大一点""跟着鼠标""读的声音小一点""别读了"，这些要真的生效，并且不会因为旧选项晚到而覆盖新的选择。控制窗口的导航和布局也在这里。

用户感觉到的是：改了设置马上生效，关掉再开还在，说了一句命令她就照做。

## 2. 文件在哪

- 三个文件夹：`electron/settings/`、`shared/settings/`、`src/settings/`。
- 公开页：
  - `electron/settings/index.ts`（导出 `SettingsStore`、`validateSettings`、`CompanionCommandHost`、`UiLanguageStore`、`applyFirstLanguageHint` 等；后者见下面"第一次安装的语言"）
  - `shared/settings/index.ts`（导出 `CAPABILITIES`、`CompanionCommandView` 等；`DEFAULT_SETTINGS` 和 `CLAUDE_MODEL_ALIASES` 从基础层 `shared/foundation/defaults.ts` 转出）
  - `src/settings/index.ts`（导出 `ControlNavigation`、`mergeSettings`、`settingsStartup` 等；后者让窗口在第一次读设置之前就开始听 `desk:settings`，启动期间漏掉的变化在接上处理时重读一次，2026-11-26，`docs/claude/2026-11-25-first-turn-empty.md`）
- 接线：`electron/wiring/settings-wiring.ts`，入口 `wireSettings(needs)`；另有 `wireSaveSettings(prepare, applied)` 和 `wireSettingsSync(steps)` 接收 main.ts 给的步骤表。
- 留在 `electron/main.ts` 的：
  - 两张步骤表：`saveSettings` 的顺序和 `sync` 的顺序，都由 main.ts 给出；
  - `companionCommands` 的引用（聊天一轮和窗口事件要用），退出时由 `releaseCompanionCommands(...)` 关掉；
  - 设置存储本身的创建（ready 链里）。

## 3. 从哪进、谁调用它

- main.ts 调用 `wireSettings(...)`，然后 `settings.register(partIpc('settings'))`。
- `saveSettings` 是有序步骤：
  - 写盘前 11 步（`savePrepare`），设置自己的有 `keepHostIntents`、`keepStaleAssetClears`、`modelChangeClearsMotion`；
  - 写盘后 3 步（`saveApplied`）。
- `sync` 是 12 步，由 `wireSettingsSync` 按原顺序排，`broadcastSettings`（发 `desk:settings`）是设置自己的。
- 陪伴命令的几个处理函数（`scopedHost(..., false)`，两个窗口都能调，桌宠要能回答）：`chooseCompanionCommand`、取景相关的 `beginPetFraming`、`completePetFraming`、`reportPetFramingState`、`noteManualCameraChange`。这是原来的写法，没有改。
- IPC 总数：接线文件 `electron/wiring/settings-wiring.ts` 里有 7 处 host 调用（2026-11-16 核实：379–382 行是取景相关的 4 个，395 行的 `chooseCompanionCommand` 是陪伴命令的入口，396–397 行是读写设置）。陪伴命令的几组（置顶、显示、呼吸、跟随鼠标、朗读音量、停止朗读）都经 `chooseCompanionCommand` 这一个处理函数进入，分类在 `electron/settings/companion-command-intent.ts`，不各占一个 IPC。
- 时钟和生命周期：这部分没有时钟条目。`sync` 是设置改动后的扇出，不是时钟。

## 4. 它守着的规矩

- **密钥只在主机，用系统安全存储加密。** `publicSettings`（`electron/settings/settings.ts:55`）把密钥去掉后才发给窗口。测试：`tests/backend.test.ts:212`（发给窗口的设置里没有密钥）、`tests/i070-drama3.test.ts:339`（付费语音的密钥不在发出去的设置里）；系统安全存储不可用时，语音密钥不退回明文保存，`tests/backend.test.ts:241`。
- **陪伴命令只给它对应的目标**：先核对调用的窗口是不是对的，再排队提交，过期的选择要作废（修订号）。测试：`tests/companion-command-host.test.ts`、`tests/companion-command-adapter.test.ts`、`tests/companion-visibility-intent.test.ts`、`tests/companion-follow-mouse-intent.test.ts`、`tests/companion-readout-volume-intent.test.ts`、`tests/companion-stop-readout-intent.test.ts`。
- **置顶要走修订号。** 旧的写入不能覆盖新的设置。测试：`tests/pet-always-on-top-host.test.ts`（去掉 `keepHostIntents` 步骤，会失败）。
- **置顶命令的目标要检查：调用的窗口必须可见。** 测试：`tests/r41-visibility-host-path.test.ts`。注意：这一条有一个原有的覆盖缺口，去掉它没有测试失败，见第 6 节。
- **saveSettings 和 sync 的顺序是金标准钉着的。** 测试：`tests/wiring-golden.test.mjs`（`order.saveSettings` 43 行，`order.sync` 77 行）。
- **默认值。** 点穿透默认开（决定：`shared/foundation/defaults.ts:18`，`clickThrough: true`）；用户自己关掉后，下次启动保持关。测试：`tests/click-through-default.test.ts:13`（新配置默认开；存过的选择关或开都保留）。
- **点穿透只听用户自己的设置（I-223，2026-11-26）。** 显示/隐藏桌宠（托盘项、Ctrl+Alt+P、关桌宠窗口）只翻"显不显示"，不碰点穿透（`click-through.ts` 的 `toggledVisibility`；Ctrl+Alt+P 现在就是单纯显示/隐藏）。会改它的只有用户自己的选择：设置页、托盘「恢复鼠标交互」（`rescueFromTray`，显示并关掉）、恢复桌宠（把桌宠整体设回默认，点穿透跟着回默认）、恢复默认设置、内部通道/聊天卡片。每一次改变都在体验记录里写一行 `setting`（`via`：settings / tray / recover / reset / agent / chat），没变不写。测试：`tests/click-through-keeps-setting.test.ts`，变异 CT1–CT7。

## 5. 测试在哪

- `node scripts/dev/ops.mjs owned settings`：只跑这部分相关的测试。
- test-parts.json 里 owner 是 settings 的文件有 39 个。
- 最重要的几个：
  - `tests/r41-visibility-host-path.test.ts`（35 个函数，sync 和它的步骤）
  - `tests/pet-always-on-top-host.test.ts`
  - `tests/companion-framing.test.ts`、`tests/companion-breath.test.ts`
  - `tests/control-navigation.test.ts`、`tests/control-navigation-roots.test.ts`
  - `tests/wiring-golden.test.mjs`、`tests/wiring-parts.test.ts`

## 6. 改的时候小心

- **两张步骤表和它们的顺序。** 调换 `saveTtsKey` 和 `saveStopsSpeech`、或 `syncPetWindow` 和 `syncFatigue`，金标准会失败（记录里做过）。改顺序要先说明为什么。
- **读 main.ts 的测试是用帮助文件（`tests/helpers/wiring-source.ts`）来读的。** 改指向的时候断言不能放松。
- **已知的覆盖缺口**：`r41-visibility-host-path` 里，"置顶目标的调用窗口可见检查"去掉以后没有测试失败（4a 记录写的原有缺口，不是改指向造成的）。改这一行时要自己补测试。
- **`companionCommands` 的引用还在 main.ts**：要搬的话，先处理退出的 `releaseCompanionCommands` 和聊天一轮读它的地方。
- **`saveSettings` 的步骤是 main.ts 给的**：别的部分搬走时，要带走自己那一步，顺序表留在 main.ts。

## 7. 和 Claude 有关的地方

- **2-2 模型档位**（I-222，2026-11-26 起）：设置页「聊天模型」是四个选项：Opus（默认，存的值是空）、Sonnet、Haiku、跟随 Claude Code 的默认（存 `follow-default`）。空值启动时带 `--model opus`，只有 `follow-default` 不带 `--model`；含义只在 `shared/brain/claude-model.ts` 的 `chatModelArgument` 一处。以前存的 `opus` 显示成 Opus（默认）；别的 Claude 名字（fable、完整模型号）作为额外一项原样保留。账号用不了 Opus 时，应用自动把它存成 `follow-default` 并在聊天页说一次（`electron/brain/chat-model-fallback.ts`、`electron/wiring/chat-model-fallback-wiring.ts`）。跟随默认时上游一改默认，她的说话风格仍会悄悄变（手册"已知缺口" 2-2）。
- **记忆钉住**（I-222）：`settings.json` 的 `provider.memoryModel` 决定她的记忆归在哪个分区，换聊天模型不再换记忆。老配置第一次被 0.2.0 读入时，按它当时的聊天模型钉住并立刻写回同一个文件；之后任何保存（窗口、内部通道、恢复默认设置）都保留存储里的值，窗口和通道送来的值一概不认（`electron/settings/memory-pin.ts`）。改它只能靠恢复整份配置备份。
- **预装模型换了安装文件夹**（2026-11-26，`docs/claude/2026-11-26-update-blank-card.md`）：`settings.json` 存的舞台模型是绝对路径。读不到、而且它是另一个安装文件夹里的预装模型（Gene、One、Mumi）时，`load()` 问 `relocateUnreadableModel`（由 `electron/wiring/actions-wiring.ts` 的 `startMotionStores` 在读设置前装上，`electron/cards/bundled-character-models.ts` 的 `relocateBundledModel`），换成这次安装自带、校验过的那一份。读得到的路径、用户自己的模型照旧（读不到就空着，不猜）。读的时候不改存着的路径，下次保存设置时才写成新路径。
- 设置页上写着"Claude"的字样（状态、按钮）是界面文字，换大脑时要改（brain-interface 6-8）。
- 陪伴命令本身不调用 Claude。

## 第一次安装的语言（I-219）

装的 Claude 在第一次启动前问"中文还是 English"，把答案写进 `.local/first-language.txt`；`first-language-hint.ts` 在界面语言读取之前读一次：配置全新（没有 `ui-language-settings.json` 也没有 `settings.json`）才用，存成界面语言偏好，文件读完就删；不覆盖已存的选择，不认识的值忽略。记录 `docs/claude/2026-11-25-first-language.md`。
