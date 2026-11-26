# 连接、任务和安全（safety）

给别的 agent 看的部分说明。总入口见 handbook/for-other-agents.md。

## 1. 这部分做什么

这一部分管四件事：

- **求助卡**：她觉得你可能有危险时，在角色之外显示求助电话。这张卡不能被关掉。
- **测试命令**：开发者用的，让她按指定的心情或状态回一句。
- **Claude 任务（R20）**：另起一个 Claude Code 进程，去你选的文件夹里做事。读文件自动放行，写文件和运行命令每次都要你批准。默认关。
- **内部通道**：让你自己的 Claude Code 通过 MCP 换角色、调设置（"三方互通"）。还有 Claude 助手，在控制窗口里的"你的 Claude"。

用户感觉到的是：不经你同意，她和 Claude 不会动你的电脑；求助卡在该出现的时候出现；你能看见每一步。

## 2. 文件在哪

- 三个文件夹：`electron/safety/`、`shared/safety/`、`src/safety/`。
- 公开页：
  - `electron/safety/index.ts`（导出 `AgentToolRegistry`、`createPerceptionSwitches`、`agentHostActions`、`allowsClipboardWrite` 等）
  - `shared/safety/index.ts`（导出 `AGENT_TOOLS`、`LINK_FAILURES`、`CodexTaskSummary`、`crisisRegionPreference` 等）
  - `src/safety/index.ts`（导出 `AgentChannelPanel`、`AssistantPanel`、`CodexTasks`、`SafetyCard`、`TestCommandNotes` 等）
- 接线：`electron/wiring/safety-wiring.ts`，入口 `wireSafety(needs)`。另外 `safety-wiring.ts` 还转出了 `agentChannelRefresh`（`electron/safety/agent-channel/electron-wiring.ts`）、`createMemoryBridge`（`electron/safety/agent-channel/memory-bridge.ts`）给记忆部分用（`safety-wiring.ts:29-30`，2026-11-16 核实）。
- 留在 `electron/main.ts` 的：
  - 测试命令"每条命令找谁回答"的 ports；
  - 内部通道的应用侧选项（`AgentChannelWiring` 里 main.ts 给的那些，4a 记录）；
  - `recycleAssistant` 的登记（`registerPrivacyStores('safety', …)`，主动和安全的存储暂时由 main.ts 替它们登记，见 4d 记录）；
  - 控制窗口关掉时中断正在跑的任务（`secureWindow` 里，`codexTasks` 是活绑定）。
- `electron/safety/codex.ts` 还在仓库里，没有任何地方引入它，看起来是原 Codex 版的旧代码（brain-interface 已知缺口）。
- **内部通道的工具**（用户自己的 Claude 能读、能做的事，2026-11-17 拆分，记录 `docs/claude/2026-11-17-app-tools-split.md`）：
  - `electron/safety/agent-channel/app-tools.ts` 是目录页：`createAppTools` 从各片收齐工具，按 `APP_TOOL_ORDER` 排成一张表，并转出别的文件用的名字（引用方一个字没改）。
  - 每片一个领域，都在 `electron/safety/agent-channel/tools/`：`status`（读状态、她怎么样、诊断）、`characters`（角色卡、反应倾向）、`settings`（列设置、改设置）、`setting-values`（每项设置怎么读、要不要同意、说明文字；不含工具）、`handbook`（手册）、`voice`（朗读、声音风格、某个角色自己的声音、试听；花钱的声音怎么计费、怎么读在 `voice-spend`，不含工具）、`stage`（桌宠、窗口、模型、模型体检、小动作）、`senses`（感知开关）、`memory`（删除记忆、回收站、她记得的歌）。
  - `read_handbook` 读的说明文档只有名单上的几页（`shared/safety/user-manuals.json`：角色卡、声音设计、旋钮表、数据地图、摸她、发布说明）。同一份名单决定软件包带哪些（`package.json` 的 `assistant-docs`）和公开版留哪些（`scripts/release/export-public.mjs`），`tests/user-manuals.test.ts` 让三处保持一致。开发手册（`handbook/`）不在名单上：不打进软件包，应用里的 Claude 读不到。新写一页给用户看的说明，要同时加进名单和 `package.json` 的 filter。
  - `tools/app-bridge.ts`：`AgentAppBridge`，工具能请主机读什么、做什么（只有类型）。`tools/common.ts`：各片共用的帮手（`createToolContext`、`title`、`unavailable`）。
  - 每个工具的名字、标题、档、给 Claude 看的说明和参数格式在 `shared/safety/agent-channel-catalog.json`；"总要弹窗"的清单是 `shared/safety/agent-channel.ts` 的 `AGENT_ALWAYS_DIALOG_TOOLS`。

## 3. 从哪进、谁调用它

- main.ts 在原来求助卡的位置调用 `wireSafety(...)`，求值时就创建。求助卡是核心，创建失败会阻止启动，和原来一样。
- `safetyPart.register(partIpc('safety'))` 放在内部通道录制器里：`runTestCommand`、求助卡的两个处理函数、Claude 任务的处理函数。
- `safetyPart.startAgentChannel(…)` 放在录制器停下之后。录制器停在单独一行 `const agentOperationsRecorded = agentOperations.done()`，之后才做感知开关和内部通道。
- `startClaudeTasks(...)` 是 ready 链里的一步（设置存储之后）；`releaseClaudeTasks()` 是退出的一步。
- IPC：这部分的 host 调用不算少（测试命令、求助卡、Claude 任务、内部通道的工具）。内部通道的工具目录在 `electron/safety/agent-channel/app-tools.ts`（`APP_TOOL_ORDER`），共 34 个工具（I-173 加了 `delete_character`，2026-11-24 加了 `set_character_voice`），定义分在 `tools/` 的各片里（由金标准 `tests/fixtures/app-tools-golden.json` 核实）。
- 时钟和生命周期：这部分没有时钟条目。控制窗口关掉时中断任务，在 `secureWindow`（main.ts）里。

## 4. 它守着的规矩

- **任务执行默认关，写文件和运行命令每次都要你批准。** 批准通道接不上，或者被绕过，这一次操作就拒绝，不能降级成"自动批准"（`electron/safety/claude-tasks/service.ts:350` 看不到控制窗口就拒绝，`:330` 无法核对就拒绝，`:324` 启动未核实就拒绝）。测试：`tests/r20-proactive-offer-ui.test.ts`（4a 记录点名：过期后还发、不校验内容、显示前不查过期，都会失败）；`tests/claude-tasks.test.ts` 核过：没有可见的批准界面就拒绝、不悄悄放行（`:193`），同一时刻只显示一个批准（`:172`），启动核实没通过的请求直接拒绝（`:254`）；`tests/claude-tasks-policy.test.ts` 核过：文件夹里的读写和命令的放行规则，文件夹外、指向外面的符号链接、Windows 路径写法都拒绝。
  - 本页原来写"就整体关掉任务功能"，是把 `handbook/brain-interface.md` 4-1 的话放错了地方：那句说的是**换大脑时**，对方的 CLI 不支持逐项批准，就整个不开任务功能。运行时批准通道接不上，只拒绝这一次，什么都不执行（fail closed），任务本身不关；整体停止只有"开关关掉"一条路（`service.ts:149-150`）。2026-11-17 主会话核过，不需要改代码。
- **内部通道的分级。** 工具分只读、直接执行、需要用户原话三档。"需要原话"的档要填 `userWords`。应用只能核实它有没有、有多长，**核实不了它是不是用户真说的**（brain-interface 3-4）。分级检查的测试：`tests/agent-channel-registry.test.ts`（核过：读的直接跑，可撤回的先给提示，需要确认的只在明确允许时才跑，`:58`、`:87`，未开放的工具不在目录里，`:144`）。没有原话时直接拒绝的代码在 `electron/safety/agent-channel/registry.ts:355`。
- **三方互通打开时，需要用户同意的操作（隐私、花钱、删除、载入文件）要在 soft hearts 里弹窗，由用户点。** 这是 CLAUDE.md 的规矩。哪些算敏感：`shared/safety/agent-channel.ts:27` 的 `AGENT_ALWAYS_DIALOG_TOOLS`，加上感知的"打开"（`electron/safety/agent-channel/tools/senses.ts`，`alwaysConfirmFor`）、付费试听（`tools/voice.ts`）和敏感设置（`tools/settings.ts`，按设置的 `consent`）。测试：`tests/sensitive-always-dialog.test.ts`（三方互通开着、带了原话，敏感操作仍弹窗，拒绝就不改；没带原话直接拒绝）、`tests/three-way-interconnect.test.ts:256`（从桌宠聊天发起的操作，互通开着时仍弹确认）。
- **密钥和运行命令永远不经内部通道开放。** CLAUDE.md 的底线。目录里的禁止项在 `shared/safety/agent-channel-catalog.json:812`（`neverExposed`）。测试：`tests/three-way-interconnect.test.ts:174`（禁止项里的密钥、命令、文件、其他权限、永久删除，目录里一个工具都没有）；`tests/assistant.test.ts:175`（助手拿到的工具列表里也没有这些）。
- **每个选项要么通道能改，要么带得过去（I-173）。** 通道改不了的（"还不能""不开放"，包括密钥和百炼的连接地址），`open_control_page {"item": "<手册 id>"}` 把用户带到那一页并闪一下那一项，只导航不改任何东西；她在聊天里的「带我去」给同一页。检查：`tests/i173-reachable-options.test.ts`（缺哪一边就失败；每一页每一项经 `open_control_page` 什么状态都不变、结果里没有任何 Key）。删除角色卡 `delete_character` 规矩同删除记忆：三方互通开着才有、要原话、带了原话也弹窗、进回收站、不能删当前角色（`tests/i173-channel-voice-delete.test.ts`，变异 `I173-*`）。记录 `docs/claude/2026-11-22-i173-reachable-options.md`。
- **花钱的声音选项走"原话 + 弹窗"（2026-11-24）。** Drama 3 每月上限是 `set_setting` 的 `drama3_monthly_limit`（目录里 `tier: "confirm"`：每个值都要原话，`consent: spending` 所以带了原话也弹窗，`shared/safety/agent-channel.ts` 的 `settingValueNeedsConsent` / `settingHasConsent`；0 = 不设，1～500，和控制窗口一样；不给撤回）。任何一个角色自己的声音服务商是 `set_character_voice`（`tools/voice.ts`，写法同「她的声音」的保存 `saveCharacterVoice`）：结果是百炼或 Drama 3 就要原话、弹窗里写价格和本月花了多少、不给撤回；换成免费的直接改、能撤回。读的一边是 `list_settings` 的 `voices`（上限、本月花了多少只有数字、每个角色的服务商、为什么没用上），主机经控制窗口自己的 `getTtsBudget` 读（无参数）。价格、弹窗文字和读的一边都在 `tools/voice-spend.ts`（纯函数）。密钥、百炼地址和地域、Fish 账号页仍不开放：`set_character_voice` 只认 `id`、`provider`、`voiceId` 三个参数。测试 `tests/channel-voice-spend.test.ts`，变异 `CVS-1`～`CVS-8`。记录 `docs/claude/2026-11-24-channel-voice-spend.md`。
- **求助卡不能关。** 它是核心，第 7 步隔离时也不关（`electron/wiring/safety-wiring.ts:89`，`core: ['crisis-card']`）。守它的测试：`tests/wiring-parts.test.ts:140`。设置里只有"地区"选项（`shared/settings/capabilities.ts:327`），没有关掉卡的开关。卡的判断由 `tests/i117-safety.test.ts` 守（明显的话才显示卡、每晚一次、早期信号不显示），卡的显示和按钮由 `tests/i117-safety-card-ui.test.ts` 守。
  - 已知：`tests/i117-safety-card-ui.test.ts:20` 在本机没有 Edge 也没有 Playwright Chromium 时，这两个界面测试整组跳过（不报错，也不跑）。
- **剪贴板只给写，不给读。** 两个权限处理都要问剪贴板规则。测试：`tests/clipboard-permission.test.ts`（去掉任一处检查，会失败）。
- **测试命令 `runTestCommand` 两个窗口都能调**（原来的写法，它是开发者模式里的入口）。改成只给控制窗口，会让 `tests/test-command-wiring.test.ts` 失败（4a 记录做过变异）。
- **Claude 助手只能用本软件的那一个 MCP 服务器，内置工具全关；启动报告核对失败，整轮停下。** 测试：`tests/assistant.test.ts:109`（启动参数：没有内置工具，只用本软件的 MCP）、`:134`（启动报告里有别的工具，就在任何内容被接受前停下）、`:340`（安全停：不做任何事）；界面见 `tests/assistant-panel.test.ts`。

## 5. 测试在哪

- `node scripts/dev/ops.mjs owned safety`：只跑这部分相关的测试。
- test-parts.json 里 owner 是 safety 的文件有 47 个。
- 最重要的几个：
  - `tests/wiring-parts.test.ts`（求助卡和守卫是核心；安全部分的注册在录制器里）
  - `tests/claude-tasks.test.ts`、`tests/claude-tasks-policy.test.ts`、`tests/r20-proactive-offer-ui.test.ts`
  - `tests/agent-channel-registry.test.ts`、`tests/agent-channel-transport.test.ts`、`tests/agent-channel-panel.test.ts`
  - `tests/assistant.test.ts`、`tests/assistant-panel.test.ts`
  - `tests/clipboard-permission.test.ts`、`tests/test-command-wiring.test.ts`
  - `tests/i061-link-read.test.ts`、`tests/i117-safety.test.ts`
  - `tests/wiring-golden.test.mjs`、`tests/bundle-inputs.test.mjs`

## 6. 改的时候小心

- **求助卡在 main.ts 求值时创建，注册时不包 catch。** 这是有意的：它出错要让启动失败，让用户看见。不要把它包进 try。金标准会拒绝这种改法。
- **`safetyPart.register` 必须在录制器里，startAgentChannel 必须在录制器停下之后。** 挪错位置，wiring-parts 和金标准会失败（4a 记录做过变异）。
- **`codexTasks` 是活绑定。** `secureWindow` 读它，`startClaudeTasks` 设它。
- **内部通道的工具分级改动要跟着测试。** 分级、`userWords` 检查在 `registry.ts`。把"需要原话"的档降成"直接执行"，属于放宽安全限制，要用户本人同意（brain-interface 规矩 4）。
- **加一个新工具（或改一个工具）的规矩**（也写在 `app-tools.ts` 开头）：
  1. 放进它所属领域的片 `electron/safety/agent-channel/tools/<领域>.ts`；名字加进 `app-tools.ts` 的 `APP_TOOL_ORDER`；目录条目（名字、标题、档、说明、参数格式）加进 `shared/safety/agent-channel-catalog.json`。新领域就新开一片，在 `SLICES` 里加一行。
  2. **档要明确决定，并在注释里写为什么**：`read`（什么都不改）、`reversible`（改了用户能撤回的东西，用 `context.offerUndo` 记下撤回）、`confirm`（三方互通开着时要用户原话，关着时弹窗）。敏感的（隐私、花钱或占用户的 Claude 用量、删除、下载或载入文件）再加 `alwaysConfirm`（或 `alwaysConfirmFor`），并加进 `AGENT_ALWAYS_DIALOG_TOOLS`：带了原话也照样弹窗。碰文件的加 `touchesFiles`。密钥、运行命令、任意文件、其他权限、永久删除永远不开放（`neverExposed`）。
  3. 在 `tests/helpers/app-tools-world.ts` 的 `samplesFor` 里给它几条调用，重新生成金标准（`node node_modules/tsx/dist/cli.mjs scripts/dev/app-tools-golden.ts --write`），看一遍差异再提交；在 `scripts/dev/mutations/safety.json` 里给它的闸门加变异（档降一级、去掉弹窗、去掉撤回），每条都要有测试失败。
- **金标准钉着用户的 Claude 看到的一切**（`tests/app-tools-golden.test.ts`）：目录和说明、每个工具的档和标志、三方互通开关时有哪些工具、每个工具在七种调用方式下的回答、弹窗文字、提示、记录、对主机做了什么、撤回；手册（`read_handbook`）的文字也在里面。所以改功能清单（`shared/settings/capabilities.ts`）或设置目录的文字，这个测试也会失败：确认是有意的改动，重新生成即可。
- **Claude 助手的参数和核对。** `--tools ""`、`--mcp-config`、`--strict-mcp-config`、`--allowedTools`、`--settings` 里的拒收别的会话消息（`crossSessionInbound: "refuse"`、拒绝 `SendMessage`/`ListAgents`，经 `electron/brain/claude-settings.ts` 合进同一个 JSON，任务进程同样，2026-11-25）这些是安全底线（brain-interface 3-6、1-21）。改之前先拿出证据，核对失败时整轮停。
- **`codex.ts` 是旧代码。** 没有引用，先不要删（删除要用户确认），也不要当成正在用的东西。

## 7. 和 Claude 有关的地方

这一部分和 Claude 的依赖最多，按 `handbook/brain-interface.md` 的编号：

- **3-1～3-3 内部通道登记**：MCP 的 stdio 协议版本、`claude mcp add`、`claude mcp list` 的输出格式（`electron/safety/agent-channel/claude-code-link.ts`）。版本对不上，工具列表是空的，不是安全问题；格式认不出时只提示，不改。
- **3-4 工具分级和 `userWords`**：应用核实不了用户原话，只能靠调用方守规矩。换调用方的大脑，要重新评估这一档。
- **3-6 Claude 助手**：`electron/safety/assistant/process.ts`，`claude -p` 的 stream-json、`--tools ""`、`--allowedTools mcp__soft-hearts-assistant`、`--permission-prompts none`、启动报告核对。安全底线。
- **4-1～4-4 Claude 任务**：`electron/safety/claude-tasks/process.ts`（参数、启动核对 `verifyTaskInit`、事件读取）、`permission-server.ts`（批准服务）。换大脑时，批准通道必须先接上，否则任务功能整体关掉。
- **6-6、6-7、6-8**：版本号、登记失败的分类、界面里写"Claude"的字样。
- **2-4a 求助卡的危险判断**：不是这部分调模型，是 2-4 反应判定那一次调用多一个字段（`shared/safety/judge-field.ts`）。模型判断偏了，会多弹一次卡或漏掉，本机的短语判断是兜底。
