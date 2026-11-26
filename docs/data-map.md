# 数据地图：她记得的东西总表

应用在配置目录里存的每样东西，一样一行：存什么（不写内容）、归谁、跟你有没有关系，以及六种操作下怎么处理。表由代码生成（`electron/foundation/data-map.ts`，`node node_modules/tsx/dist/cli.mjs scripts/dev/data-map-table.ts` 打印），`tests/data-map.test.ts` 核对这页和代码一致；代码里新写一个文件、表里没有，测试就失败。

怎么读：
- **删角色并勾选「同时删除她的记忆」**：删＝照表清掉；跟着删＝派生的数据，随括号里那一项一起删；随卡删＝不勾也删；留（已确认）＝你确认过要留。删角色先进回收站（默认留 7 天，到期才真删），见「进回收站」一列。
- **关「允许记录」**：「允许记录」是日记的那个开关。"清空日记时也删"＝你清空日记时也一起删。
- **Claude 删除记忆**：你的 Claude 通过内部通道删的，先进回收站（默认留 7 天）；删「画像和日记」时，她记得的计划、回顾、她的笔记和最打动她的那件事跟着进同一项。
- **进回收站**：收＝删掉时整份收进回收站，找回时和删之前一模一样（有测试逐字节核对）；不收＝会删但不留副本，括号里是原因；不收（不会被删）＝没有哪种删除会动它。回收站在角色页最后一格，单条删除的旁边有「最近删除的」；永久删除只有你在回收站里点、再确认一次。
- **导出角色卡**、**备份**（把整个配置目录逐个文件复制）、**诊断**（`get_diagnostics`，只给内存里的回复延迟数字）。
- 每行更细的说明在 `electron/foundation/data-map.ts` 那一行的 `note` 里。

| 数据 | 存什么 | 位置 | 归属 | 关于你 | 删角色并勾选「同时删除她的记忆」 | 关「允许记录」 | Claude 删除记忆 | 进回收站 | 导出角色卡 | 备份 | 诊断 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 聊天记忆 | 和她聊过的话（每段一条记录） | `memories.jsonl` | 每个角色×连接 | 是 | 删 | — | 进回收站 | 收 | 不带 | 带 | 不带 |
| 聊天对象索引 | 哪段记忆属于哪个角色、哪个连接（角色编号和连接分区编号，不含模型名） | `memory-scopes.json` | 整个配置 | 否 | 删 | — | — | 收 | 不带 | 带 | 不带 |
| 聊天小记 | 每段聊天的一句小记和你对小记的决定 | `memory-notes.json` | 每个角色×连接 | 是 | 跟着删（随「聊天记忆」） | — | 跟着处理 | 收 | 不带 | 带 | 不带 |
| 边说边演的拍子 | 她有拍子的回复演了哪几个动作（词表里的词和位置、只演不说时的灰色小字），以及她的话被打断时停在哪、为什么停（位置数字和一个固定的原因词），不含她或你说的话 | `speech-beats.json` | 每个角色×连接 | 是 | 删 | — | 随聊天进回收站 | 收 | 不带 | 带 | 不带 |
| 关键词索引 | 聊天小记和一起看笔记的关键词 | `memory-keywords/*.json` | 每个角色 | 是 | 跟着删（随「一起看的笔记」） | — | 跟着处理 | 收 | 不带 | 带 | 不带 |
| 按意思想起的向量 | 从你说过的话算出的数字向量 | `memory-vectors/*.json` | 每个角色 | 是 | 删 | — | 跟着处理 | 收 | 不带 | 带 | 不带 |
| 用户画像和日记 | 她记下的关于你的事、她写的日记 | `user-profiles/profile-*.json` | 每个角色×连接 | 是 | 删 | 不再写，已有的留 | 进回收站 | 收 | 不带 | 带 | 不带 |
| 她记得的计划 | 你说过的计划和时间 | `user-profiles/upcoming-*.json` | 每个角色×连接 | 是 | 跟着删（随「用户画像和日记」） | 删 | 随画像进回收站 | 收 | 不带 | 带 | 不带 |
| 可记录的聊天段标记 | 哪几段聊天是开着「允许记录」时说的（只有编号） | `user-profiles/upcoming-marks.json` | 整个配置 | 否 | 跟着删（随「聊天记忆」） | 删 | 跟着处理 | 收 | 不带 | 带 | 不带 |
| 她的回顾 | 她写的周回顾、月回顾 | `user-profiles/review-*.json` | 每个角色×连接 | 是 | 跟着删（随「用户画像和日记」） | 不再写，已有的留 | 随画像进回收站 | 收 | 不带 | 带 | 不带 |
| 「允许记录」开关 | 开还是关 | `user-profiles/recording.json` | 整个配置 | 否 | 留 | — | — | 不收（不会被删） | 不带 | 带 | 不带 |
| 她的笔记 | 她写的关于你的一页（最近几版） | `user-profiles/her-note-*.json` | 每个角色×连接 | 是 | 删 | 删 | 随画像进回收站 | 收 | 不带 | 带 | 不带 |
| 最打动她的一件事 | 她记下的一段你的原话和她的一句话 | `user-profiles/moving-memory-*.json` | 每个角色×连接 | 是 | 删 | 删 | 随画像进回收站 | 收 | 不带 | 带 | 不带 |
| 熟悉度和称呼 | 认识了多少天、她怎么叫你、你怎么叫她（称呼表）、她在自己的物件页边写的批注 | `relationship/*.json` | 每个角色 | 是 | 删 | — | — | 收 | 不带 | 带 | 不带 |
| 猜拳记录 | 和她猜拳的次数和结果 | `rps.json` | 每个角色 | 是 | 删 | 删；清空日记时也删 | — | 收 | 不带 | 带 | 不带 |
| 喂过她的东西 | 喂过什么、几次、最近一次（还有认食物的开关） | `feed-recognition.json` | 每个角色 | 是 | 删 | 删；清空日记时也删 | — | 收 | 不带 | 带 | 不带 |
| 她认得的歌 | 常放的歌的声音特征数字（没有歌名、没有声音） | `song-memory-*.json` | 每个角色 | 是 | 删 | — | 另有工具 | 收 | 不带 | 带 | 不带 |
| 一起听的记录 | 一起听过的片段和她的小记 | `listen-together.json` | 每个角色 | 是 | 删 | — | — | 收 | 不带 | 带 | 不带 |
| 一起看的笔记 | 一起看时她记下的描述和小结 | `watch-notes/*.json` | 每个角色 | 是 | 删 | — | 随聊天进回收站 | 收 | 不带 | 带 | 不带 |
| 一起看的截图缓存 | 一起看时的屏幕截图（短期缓存） | `watch-screens/*/*.frame` | 每个角色 | 是 | 跟着删（随「一起看的笔记」） | — | 跟着处理 | 不收（一起看时的屏幕截图只是短期缓存，过几天自己清掉；不为找回多留屏幕画面） | 不带 | 带 | 不带 |
| 牵手、拉钩的小账 | 伸手次数、第一次牵手、拉过钩的计划编号（没有对话） | `hands/*.json` | 每个角色 | 是 | 删 | 删 | — | 收 | 不带 | 带 | 不带 |
| 我们的小东西 | 她给你的、你喂她的东西清单和小图（含摄像头拍的零食小图） | `our-things/*.json`、`our-things/*/*` | 每个角色 | 是 | 删 | — | — | 收 | 不带 | 带 | 不带 |
| 她认识的人和东西 | 你对她记得的人和东西做的决定（只有名字） | `people-things/*.json` | 每个角色 | 是 | 删 | — | — | 收 | 不带 | 带 | 不带 |
| 听到的声音文字 | 一起听或系统声音转成的文字、她的评论 | `system-audio-transcripts.json`、`audio-reading-v2.json` | 每个角色×连接 | 是 | 删 | — | — | 收 | 不带 | 带 | 不带 |
| 纪念邀请的对话 | 她邀请你留文字纪念时的那几句对话 | `text-invitations.jsonl` | 每个角色×连接 | 是 | 删 | — | — | 收 | 不带 | 带 | 不带 |
| 文字纪念 | 你点头留下的文字纪念 | `text-memorials/text-memorial-*.json` | 每个角色×连接 | 是 | 留（已确认） | — | — | 单条删除收（删角色不动） | 不带 | 带 | 不带 |
| 特别的日子 | 生日、纪念日那天她提过没有 | `special-day.json` | 每个角色 | 是 | 删 | — | — | 收 | 不带 | 带 | 不带 |
| 给你留的东西 | 她在你的文件夹里留东西的记录 | `her-keepsakes.json` | 每个角色 | 是 | 删 | — | — | 收 | 不带 | 带 | 不带 |
| 回收站 | 删掉、还能找回的角色和记忆（角色页和记忆页能看到名字和数量） | `recycle-bin/settings.json`、`recycle-bin/*/*.json` | 每个角色 | 是 | 删 | — | 进回收站 | 收 | 不带 | 带 | 不带 |
| 转换角色的备份 | 转换成英文/中文角色前备份的卡、设置、聊天记忆（最近几份） | `character-convert/**` | 整个配置 | 是 | 留 | — | — | 不收（不会被删） | 不带 | 带 | 不带 |
| 她的心情 | 她的心情数值和参数 | `mood-state.json` | 每个角色 | 否 | 留（已确认） | — | — | 不收（不会被删） | 不带 | 带 | 不带 |
| 她自己的生活和需要 | 她今天在做什么、她的需要 | `her-life.json`、`her-needs.json` | 每个角色 | 否 | 留 | — | — | 不收（不会被删） | 不带 | 带 | 不带 |
| 困倦 | 她困不困、睡没睡 | `fatigue-state.json` | 整个配置 | 否 | 留 | — | — | 不收（不会被删） | 不带 | 带 | 不带 |
| 休息提醒的状态 | 上次提醒休息的时间 | `inner-loop-state.json` | 整个配置 | 否 | 留 | — | — | 不收（不会被删） | 不带 | 带 | 不带 |
| 断线时的话 | 连不上时她说的几句话（按角色卡） | `outage-lines.json` | 每个角色 | 否 | 留 | — | — | 不收（不会被删） | 不带 | 带 | 不带 |
| 她认出的时刻的状态 | 最近几晚你最后一次用电脑的时间（只有钟点）、今天和今晚已经有过的时刻 | `moments-state.json` | 整个配置 | 是 | 留 | — | — | 不收（不会被删） | 不带 | 带 | 不带 |
| 请她提醒的事 | 你请她到点提醒的事（你自己的几个字）和时间，以及她自己给自己留的心（她自己写的几个字，开关在用户画像页，默认关，那里可以看、取消）；提醒过、取消或过期的留两天后删掉 | `reminders.json` | 每个角色 | 是 | 删 | — | — | 不收（提醒是一次性的小事，到点或取消后两天自己清掉；删角色时一起删，不在回收站里多留你的话） | 不带 | 带 | 不带 |
| 你在不在电脑前 | 最近在不在、离开多久（没有按键、窗口） | `user-activity.json` | 整个配置 | 是 | 留 | — | — | 不收（不会被删） | 不带 | 带 | 不带 |
| 认脸登记 | 你的脸的特征（系统加密）和计数 | `face-check.json` | 整个配置 | 是 | 留 | — | — | 不收（不会被删） | 不带 | 带 | 不带 |
| 声纹（只认你的声音） | 你的声音的特征（系统加密，一串数字，不是录音）和录了几句 | `voiceprint.json` | 整个配置 | 是 | 留 | 删 | — | 不收（声纹是你的生物特征：删了就彻底删掉，不在回收站里多留一份） | 不带 | 带 | 不带 |
| 应用开关的时间 | 上次启动、最后还在、怎么关的 | `app-session.json`、`app-stop.json` | 整个配置 | 是 | 留 | — | — | 不收（不会被删） | 不带 | 带 | 不带 |
| 正在退出的标记 | 开始退出时的进程号、时间、程序名和界面语言（再点开的先等它走完）；下一次启动就删 | `quitting.json` | 整个配置 | 否 | 留 | — | — | 不收（不会被删） | 不带 | 带 | 不带 |
| 体验记录 | 每天的事件行（时间、角色编号、种类，没有原话） | `journal/*.jsonl` | 整个配置 | 是 | 留 | — | — | 不收（不会被删） | 不带 | 带 | 不带 |
| 开发者日志 | 开发者模式下的延迟、状态和事件行 | `dev/reply-latency.jsonl`、`dev/session-restarts.jsonl`、`dev/chat-incidents.jsonl`、`dev/speech-events.jsonl`、`dev/inner-loop.jsonl`、`dev/reply-draft-filter.jsonl`、`dev/user-state.jsonl`、`dev/her-life.jsonl`、`dev/her-needs.jsonl`、`dev/relationship.jsonl`、`dev/test-commands.jsonl`、`dev/agent-channel-audit.jsonl` | 整个配置 | 是 | 留 | — | — | 不收（不会被删） | 不带 | 带 | 只有数字 |
| 保存下来的她的声音（开发版内部测试） | 她念出来的每一句话的声音（云端语音返回的音频，每句一个 .wav）和旁边的小文件（时间、角色编号和名字、声音编号、这句话、第几句）；开关和天数；只有开发版和源码运行才有，稳定版和发布版没有这个工具 | `voice-keep/settings.json`、`voice-keep/events.jsonl`、`voice-keep/*/*` | 整个配置 | 是 | 留 | — | — | 不收（不会被删） | 不带 | 不带 | 不带 |
| Claude 助手 | 助手的模型选择和最近的对话 | `assistant/prefs.json`、`assistant/history.json` | 整个配置 | 是 | 留 | — | — | 单条删除收（删角色不动） | 不带 | 带 | 不带 |
| 她的文件夹记录 | 你选的文件夹路径、她写过哪些文件（名字和大小） | `her-folder.json` | 整个配置 | 是 | 留 | — | — | 不收（不会被删） | 不带 | 带 | 不带 |
| 设置 | 所有设置；语音服务的密钥用系统加密存在这里；她的记忆归在哪个连接分区（provider.memoryModel，0.2.0 起第一次启动时钉住，换聊天模型不变） | `settings.json` | 整个配置 | 是 | 留 | — | — | 不收（不会被删） | 不带 | 带 | 不带 |
| 其他开关和小设置 | 界面语言、物理、音乐、表情、反应、任务开关、Unbound、Unbound 入口和碰了才软的开关、她自己留心（闹钟）的开关、语音额度、按意思想起开关等 | `ui-language-settings.json`、`physics-settings.json`、`music-settings.json`、`single-emoji-settings.json`、`reactions.json`、`reaction-dispositions.json`、`mood-judge.json`、`claude-tasks.json`、`unbound-entry.json`、`channel-gates.json`、`her-alarms.json`、`drama3-usage.json`、`memory-semantic.json`、`qa-text-isolation.json`、`emotional-voice-settings.json`、`codex-tasks.json` | 整个配置 | 否 | 留 | — | — | 不收（不会被删） | 不带 | 带 | 不带 |
| 内部通道 | 通道的连接凭据、三方互通开关 | `agent-channel.json`、`interconnect.json`、`agent-channel/*` | 整个配置 | 否 | 留 | — | — | 不收（不会被删） | 不带 | 带 | 不带 |
| Unbound 里她站的地方 | 每个角色最后站的位置（每人两个数：横向比例、离屏幕多远，按角色卡编号分开；不记你在做什么） | `unbound-place.json` | 整个配置 | 否 | 留 | — | — | 不收（不会被删） | 不带 | 带 | 不带 |
| Unbound 里她出来的位置（你设的） | 你给每个角色设为默认的位置（每人两个数：横向比例、离屏幕多远，按角色卡编号分开；不记你在做什么）；她每次进全屏都从这里出来，她自己走动不会改它 | `unbound-default-place.json` | 整个配置 | 否 | 留 | — | — | 不收（不会被删） | 不带 | 带 | 不带 |
| 角色卡 | 角色卡的设定文字、关联的模型 | `characters.json` | 每个角色 | 否 | 随卡删 | — | — | 收 | 带 | 带 | 不带 |
| 角色卡的旧版备份 | 更新角色卡、拆开模型前的 characters.json 副本 | `characters.before-update-*.json`、`characters.before-model-split.json` | 整个配置 | 否 | 留 | — | — | 不收（不会被删） | 不带 | 带 | 不带 |
| 反应细调 | 这张卡的反应规则 | `character-response-settings.json` | 每个角色 | 否 | 随卡删 | — | — | 收 | 带 | 带 | 不带 |
| 角色头像 | 角色页上的头像图 | `character-avatars/*.png` | 每个角色 | 否 | 随卡删 | — | — | 收 | 不带 | 带 | 不带 |
| 角色的个性化 | 语言习惯、身体姿势、眉眼行为 | `personalize-language.json`、`personalize-body.json`、`personalize-visual.json` | 每个角色 | 否 | 留 | — | — | 不收（不会被删） | 不带 | 带 | 不带 |
| 角色贴图 | 为模型做的表情贴图 | `character-stickers/**` | 整个配置 | 否 | 留 | — | — | 不收（不会被删） | 不带 | 带 | 不带 |
| 模型和动作的数据 | 模型档案、动作适配、模型能力、脸红校准、动作标注、动作库、物理调参（按模型内容区分） | `model-profiles.json`、`motion-fits.json`、`model-capabilities.json`、`model-capabilities.unreadable-*.json`、`blush-calibrations.json`、`motion-tag-annotations.json`、`library/motions/**`、`physics-tuning.json` | 整个配置 | 否 | 留 | — | — | 不收（不会被删） | 不带 | 带 | 不带 |
| 预装角色的记号 | 预装角色装没装过 | `gene-preinstalled-card.json`、`gene-english-preinstalled-card.json`、`one-preinstalled-card.json`、`one-en-preinstalled-card.json`、`mumi-preinstalled-card.json`、`mumi-en-preinstalled-card.json` | 整个配置 | 否 | 留 | — | — | 不收（不会被删） | 不带 | 带 | 不带 |
| 语音电话的垫话 | 她的几句垫话录音缓存 | `voice-call-fillers/**` | 每个角色 | 否 | 留 | — | — | 不收（不会被删） | 不带 | 带 | 不带 |
| 聊天工作目录 | 聊天时 Claude 的工作目录（空的，不存对话） | `chat/**` | 整个配置 | 否 | 留 | — | — | 不收（不会被删） | 不带 | 带 | 不带 |
| 色块诊断 | 色块出现的次数和时间（只有数字） | `%LOCALAPPDATA%\soft-hearts-diagnostics\color-block` | 配置目录外 | 否 | 留 | — | — | 不收（不会被删） | 不带 | 不带 | 不带 |
| 离线组件 | 下载或导入的离线模型（姿势、语音识别、认脸、按意思想起、声纹） | `%LOCALAPPDATA%\soft-hearts-claude\components` | 配置目录外 | 否 | 留 | — | — | 不收（不会被删） | 不带 | 不带 | 不带 |

