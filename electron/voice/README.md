# 声音（voice）

给别的 agent 看的部分说明。总入口见 handbook/for-other-agents.md。

## 1. 这部分做什么

她说话的那一段：把回复一句一句读出来，读的时候气泡和声音对得上，取消、换角色、停止时立刻停，停了的那一句不会再冒出来。还有语音通话（你说一句，她接一句，中间可以打断）、她说话时不让电脑睡着、用来显示的每月额度（付费语音）。

用户感觉到的是：她开口的第一个字要快，读的和看到的是同一句，你按停她就停，换了人她不接着读上一个人的话。

## 2. 文件在哪

- 两个文件夹：`electron/voice/`、`shared/voice/`。
- `src/voice/` 也存在（2026-11-16 核实），里面是朗读的界面和语音通话的部件，例如 `src/voice/voice-call/barge-in.ts`（有人盖着她说话的声音检测；2026-11-19 起只打开"盖着她听"，不让她停）、`src/voice/speech.ts`、`src/voice/reply-speech.ts`。
- 通话里她的快速回应（嗯、啊）也动口型：`src/voice/voice-call/filler-mouth.ts` 在声音真的响起时给口型一个张开的倍数，`shared/behaviors/voice-call/mouth.ts` 定类别和范围；说话来源 `'filler'` 与回复的来源并列，互不清除；整屏 Unbound 经 `setAmbientAudioSpeaking(on, shape)` 的第二个参数和 `unbound:filler-mouth`。
- 公开页：
  - `electron/voice/index.ts`（导出 `SpeechRuntime`、`speechSynthesizer`、`FishBudget`、`CompletedReplySpeech`、`SpeechPlaybackActivity`、`CallOffers`、`CallStreamingSpeech`、`CallVadBridge` 等）
  - `shared/voice/index.ts`（导出 `TtsConfig`、`DEFAULT_TTS_CONFIG`、`formatReplyBubbles`、`VOICE_CALL_KNOBS` 等）
- 接线：`electron/wiring/voice-wiring.ts`，入口 `wireVoice(needs)`，`register(partIpc('voice'))`。
- `voice-wiring.ts` 还替感知转出了 `VoiceChatHost`（不在声音的公开页上，原因是会和大脑的部分成环）。
- 留在 `electron/main.ts` 的：
  - 退出时三行：`speechPlaybackActivity.dispose()`、`speechRuntime.stop()`、`voiceCall.dispose()`；
  - 窗口事件里的朗读清理；
  - 聊天一轮里的"冻结语气"调用（名字从 `voice.provides` 取）。
- 语音输入（听用户说话，`voiceHost`、`foregroundAsr`）归感知，不在这里。
- 语音输入和通话的每一轮，私下说明里多一句"这是语音识别转来的文字，可能有错字"（I-158，`shared/voice/speech-recognition-note.ts`，端口 `speechNote`；英文角色给英文版）；打字不经这里，不加。
- 语音输入和通话的每一段可以带画面了（I-161，端口 `look`，`electron/senses/voice-look.ts`）：话里请她看就截一帧，开着「发图片」时每段带小画面；帧在写给 Claude 那一刻再问一次（这一段还在、还是这次通话），段结束就丢。带了帧时私下说明里多一句和打字那一轮同样的感知话（`shared/brain/call-frame-note.ts`，共用 `attachedFramesWords`）；请她看却没拿到画面时说"这一轮没有画面"（中英文）。请她看的那一段截图附图用了多少毫秒，记进通话那一轮的日志（`lookMs`）。
- I-161 语义看：端口 `senses`（`electron/senses/sense-router/voice.ts`）。新的一段话一交给反应判定就同步交给 I-040 判断（不等它）；她第一个字出来时告诉反应判定和判断；写给 Claude 那一刻读一次"刚看到的事实"放进私下说明；段结束（`done`）和挂电话（`revoke` 里的 `end`）就忘掉。
- I-189（`docs/claude/2026-11-22-i189-pose-uses.md`）：窗口里她的朗读有两个可以让它停下的主人：喂食（B06）和"你转开或走开了"（`src/voice/away-read-pause.ts`，停在一句说完的地方，转回来接着念，一直不回来就安静结束、剩下的只留在气泡里）。两者共用一个暂停（`src/voice/shared-pause.ts`：第一个按住就停，最后一个松开才接着念）。通话里你侧过脸开口不算插她的话：`MediaInput` 的 `overHerHeld`（接线 `src/wiring/user-attention-wiring.ts`），读数来自主机的姿势（只在「姿势识别（本机）」开着时有）。
- I-164 读法：角色卡的声音里多一张「显示的字 → 读的字」小表（`shared/foundation/character-voice-reading.ts`，最多 24 条，可只给某一个服务商，单个字的口癖只在单独出现时才读）。只在两个出口、`speakableText` 之后用一次：云端声音在 `electron/voice/speech-runtime.ts` 的 `speak`，系统声音在 `src/voice/speech.ts` 的 `speak`（纯函数在 `shared/voice/reading-map.ts`）。气泡、聊天记录、记忆、日记、分段、边说边演和读到哪了都按显示的字，不经过这张表；没有表的角色读出来和以前逐字一样。通话里的快速回应和喂食提示音是应用自己的固定几个字，不经这张表。
- I-161 A：一段只带「发图片」小画面时，任务上多一个 `callGlance` 标记，通话里的聊天进程据此把小画面留到挂电话（`electron/brain/call-glances.ts`）；打字聊天从不设。已有旧小画面时，私下说明多一句"前面几句附的小图是那时候的样子"（`callPastGlancesNote`，中英文）。
- 保存她念出来的声音（开发版内部测试工具，2026-11-24，记录）：`electron/voice/voice-keep/`（`availability.ts` 是唯一的门：开发版和源码运行才有；`recorder.ts` 在 `SpeechRuntime.speak` 里接她这一句的合成音频，只认来源 `her-reading`；`store.ts` 写 `<配置目录>/voice-keep/<日期>/` 下的 .wav 和小文件、按天数删整天文件夹、清空、量大小；`host.ts` 管开关、天数、每小时清理、2 GB 上限；`channel-tool.ts` 是内部通道的 `voice_keep` 工具，打开要用户原话加弹窗）。接线 `electron/wiring/voice-keep-wiring.ts`，控制窗口那一节 `src/settings/voice-keep-panel.ts`（稳定版隐藏）。系统语音录不下来；通话里的快速回应和喂食提示音不走这条路，不存；不进备份、诊断、角色卡；没有任何模型读它。测试 `tests/voice-keep.test.ts`，变异 `VK1`～`VK9`。

## 3. 从哪进、谁调用它

- main.ts 在原来造语音通话的那一行调用 `wireVoice(...)`（聊天的 Claude 进程紧跟着要读通话的计时）。
- `voice.register(partIpc('voice'))` 在录制器里，位置是原来朗读处理函数的位置。注册的有：朗读、租约、取消、喂食提示音、语音通话和 VAD、两个 TTS 页面、Drama 3 的三个操作。
- 保存步骤：`saveTtsKey`、`saveStopsSpeech` 是接线文件的顶层函数，顺序由 main.ts 的 `wireSaveSettings` 列表给出。
- 朗读相关的函数（都在 `voice.provides` 里）：`cancelCompletedReply`、`replySpeechBusy`、`clearReplySpeech`、`cancelReplyStyle`、`dropReplySpeechOwner`、`beginInitiativeSpeech`（主动说话前冻结语气）。
- IPC：接线文件 `electron/wiring/voice-wiring.ts` 里有 21 处 host 调用（按文本粗数，2026-11-16 核实）。
- 时钟和生命周期：没有时钟条目。

## 4. 它守着的规矩

- **一次回复只朗读一次，取消、迟到、换上下文的结果不能覆盖新状态。** 整句朗读计划（`CompletedReplySpeech`）和它的显示核对（`withCompletedPrefixProof`）守着这条。测试：`tests/completed-reply-commit.test.ts`、`tests/completed-reply-ready-expiry.test.ts`、`tests/completed-prefix-proof.test.ts`。
- **她开口时不让电脑睡着（租约）**，但只有她真的在屏幕上、气泡在显示时才能开始。测试：`tests/speech-playback-admission.test.ts`（控制窗口的租约不查"她在屏幕上"，会失败）、`tests/r34-playback-host.test.ts`。
- **免费的系统语音朗读默认开；付费语音（百炼、Fish）默认关。** 这是 CLAUDE.md 的规矩。Drama 3 有月度额度（I-070），测试：`tests/i070-drama3.test.ts`。
- **逐句朗读的前缀要证明它是这一回复的。** 测试：`tests/r27-prefix-host-caller.test.ts`（4b 记录：提交前不再查朗读开关，这一条没有测试失败，是原有缺口）。
- **气泡跟着声音走（I-165，2026-11-20）**：开着朗读时，她的气泡在一句开始出声时才出这一句，第一句之前是"……"；没开朗读、声音出错或额度用完、被打断、只演不说、卡住时照旧马上全出；控制窗口的聊天页不变。顺序因此倒过来：**声音永远不等气泡的绘制回执**（主会话 11-20 转来）：跟着声音的回复只要气泡为它立着（"……"或这条回复的任何一段，画没画完都行）就开口，一句在它出声时显示；慢的、丢掉的回执（回复窗口或 Unbound 页面）只让气泡晚一点。
  - 宿主：`CompletedReplySpeech` 在接受回复时冻结 `follow`（旋钮 `shared/voice/bubble-follow/knobs.ts` 的 `mode` 不是 `'off'`），跟着时 `proofEnd` 为 0；`CompletedPrefixProof` 的 `end` 0 只看端口 `following()`（气泡此刻为这条回复立着的字，必须是这条回复的开头）；`withCompletedPrefixProof` 和播放许可这时核对 `followingText()`，不要绘制回执；气泡看不见时最多等 `proofWaitMs`（30 秒），等不到就取消这条朗读，气泡全出，不会挂住。旋钮 `'off'` 和不跟着的路照旧要显示证明。
  - 朗读的窗口：`VoiceOutput` 的 `onSegmentHeard` 报每句"出声 / 念完 / 没话可念（舞台说明）"，用宿主的句子序号；本窗口的 `BubbleFollowView`（`src/voice/bubble-follow-view.ts`）收，经 `speechChannel` 给另一个窗口，经 IPC `noteReplySpeechHeard` 给全屏 Unbound 的气泡（`electron/unbound/bubble-hold.ts`）。
  - 纯状态机 `shared/voice/bubble-follow/follow.ts`（两个窗口和宿主共用）：整句 / 逐字（逐字按这一句估计的音频时长，学她前几句真实的速度）、卡住的保险（第一句 10 秒、下一句 4 秒、一句最多 30 秒）、喂零食时暂停这些钟。
  - 测试：`tests/bubble-follow-core.test.ts`、`tests/bubble-follow-host.test.ts`（真的回复窗口和真的朗读处理函数：在"……"上就开口、后面的句子不等前一句画出来、全屏 Unbound 页面一直不报告时照样按时开口、通话里被打断后下一条也按时开口、取消后迟到的画不复活、气泡看不见时不挂住）、`tests/bubble-follow-voice.test.ts`、`tests/bubble-follow-window.test.ts`、`tests/bubble-follow-unbound.test.ts`、`tests/bubble-follow-journal.test.ts`；变异 `BF1`～`BF9`、`V5`（声音）、`BF-S1`～`BF-S4`（舞台）、`BF-B1`（大脑）、`BF-U1`～`BF-U2`（Unbound）。记录 `docs/claude/2026-11-20-bubble-follows-voice.md`。
- **她开口前先叫醒耳机（I-150，2026-11-22）**：每个窗口的共用输出（`src/voice/audio-output.ts` 的 `SharedAudioOutput`）带一个叫醒器（`src/voice/output-wake/wake.ts`，旋钮 `src/voice/output-wake/knobs.ts`）。快要说话时（`VoiceOutput` 的 `prewarm` / `wakeForReply` / `openReply` / `speak` / 试听；接线里发消息和 `beginChat` 归这个窗口时）在已有的上下文上放一段听不见的极小信号，最后一次使用后留 `KEEP_AFTER_MS` 就停，从不一直放；冷着时云端播放器把第一块排到叫醒满 `WAKE_LEAD_MS` 之后，系统语音交给系统前等剩下的毫秒，热着不等。守着的规矩：叫醒信号不经过朗读播放器，从不算"她在说话"（嘴、口型音量、气泡、说话保持）；朗读关着或音量 0 不叫醒；**从不为它新建上下文**（2026-11-05 的卡顿）。等的时间记进逐句记录和 `reading-time` 的可选 `wakeHoldMs`。测试 `tests/output-wake.test.ts`，变异 `WAKE1`～`WAKE5`。记录 `docs/claude/2026-11-22-wake-headphones.md`。
- **换角色时，正在读的那句被取消。** 测试：`tests/character-context-lifecycle.test.ts`（4b 记录：`clearReplySpeech` 不取消正在读的那句，这一条没有测试失败，是原有缺口）。
- **语音那一轮也先去掉她的边说边演标记（2026-11-20）**：`voice-chat-host.ts` 在交给这一轮之前过 `SpeechBeatFilter`，念出来的、气泡、存档和回声检查都是干净的字。**通话里还演（2026-11-20 收尾）**：通话这一段（边读边写的那条路）经 `voice-call/beats.ts` 的 `CallBeats` 用大脑的同一个 `SpeechBeatTurn`（端口 `speechBeats`，接线在 `senses-voice-input-wiring.ts`：开关 `gateEnabled('speechBeats')`、同一个拍子文件）：开关开着才在这一段的人设里加那一句（通话版：每条回复都要说出话来，不写"整条只有标记"），拍子在它前面的字显示之前经 `desk:voice-conversation` 的 `'beats'` 事件发出，窗口等通话自己的朗读念到那一句（同一个 `speechFace` 开始事件）再演；被打断、朗读取消、停止、合并、出错：没演的作废。通话外的语音回复只去标记，不演。拍子文件按一句话（整段语音）的第一段回复记一次。测试：`tests/i091-call-step4.test.ts` 后几条、`tests/speech-beats-call.test.ts`；变异 `SB18`、`SB-C1`～`SB-C12`。记录 `docs/claude/2026-11-20-speech-beats-2-4.md`、`docs/claude/2026-11-20-speech-beats-leftovers.md`。
- **通话跟着她进出 Unbound（v1 第 3 步）**："在屏幕上"按 `electron/voice/voice-call/surface.ts`（她因为出去而被收起的桌宠窗口算）；通话状态多 `out`（她在外面，通话所在的窗口隐藏着也读通话回复，`shared/voice/voice-call.ts callReadsOut`）和 `wake`（没在通话、她在外面听她的名字）；`via: 'name'` 只能由宿主在听名字的那个窗口发起（`VoiceCallHost.called`）。测试：`tests/unbound-call.test.ts`、`tests/voiceprint.test.ts`。
- **认出 3 个字就打断（I-204，2026-11-23，记录）。** 判断仍在 `shared/behaviors/interrupt/judge.ts`（旋钮 `knobs.ts`：`minChars` 3、`echoMatchRatio` 0.7）：她说话时识别出 3 个字以上（汉字一个算一个，英文一个词算两个，"嗯啊"也算）就打断，不看音量和时长，没有叫停词表、没有语气词过滤；先查回声：`echoMatch` 是"认出的字最少改几个字能变成她那段话里连着的一截"换成的比例，到 0.7 就是她自己的声音。比的那段由 `VoiceCallHost.herText` 给（通话里：读的窗口报告的这一句和上一句，再往后 12 个字，`voice-call/interruption.ts` 的 `echoWindow`；不知道时用她整段在读的字）。通话里被打断时，`InterruptionLedger` 按读的窗口报告的句子起止（`noteReplySpeechHeard` → `VoiceCallHost.sentenceHeard`，句子位置来自 `CompletedReplySpeech.segmentRange`）记下断点，下一轮的私下说明（`shared/voice/call-cut-note.ts`，中文或英文）告诉她：被打断了、断在哪一句或两句之间、已经念出声的、原本还想说的（`CallStreamingSpeech.writtenText`，打断后还在写的也算；只是信息，不接着念、不另存）、你打断时说的那句（门的 `interrupted` 端口带过来，只进这条说明）。体验记录 `held`/`interrupt` 多 `chars`、`match` 两个数，新行 `by: 'chars'`（旧行的 `sentence`/`command` 照样能读）。测试 `tests/i204-barge-in.test.ts`；变异 `I204-*`。下面 11-19 那条的"成句""叫停话""4 个字""有声 0.5 秒"已不再适用。
- **打断只认明确、成句的话（2026-11-23 被上一条换掉）。** 她说话时声音本身（音量、语音检测）不让她停：窗口只是"盖着她听"（`src/senses/MediaInput.ts` 的 `overHer`），麦克风的开口信号也不再停朗读（`voice-conversation-session.ts speechStarted`）。识别出字后由 `electron/voice/utterance-gate.ts`（判断在 `shared/behaviors/interrupt/judge.ts`，旋钮 `shared/behaviors/interrupt/knobs.ts`）决定：成句的话或叫停话（`STOP_COMMANDS`）让她停，通话里由 `VoiceCallHost.heardOverHer` 记打断、停逐句朗读、下一轮私下说"没说完"；语气词、半句、她自己的回声、通话里短或轻的"杂音嗯"都不发、不显示、不存，只记 `voice-call` 的 `held` 次数。窗口不再调用 IPC `voiceCallBargeIn`；2026-11-22 I-177 第 2 批把这个通道删了（换成 `callDevicesAsk`）。测试：`tests/interrupt-gate.test.ts`（变异 V32–V41）、`tests/i091-voice-call.test.ts`（打断只送到她的下一次语音请求，只一次）。`tests/i099-smart-turn.test.ts` 管的是"这句话说完了没有"（智能断句），不是打断。
  - 2026-11-20：通话里自己的逐句朗读也算"她在说话"（`herVoiceFrom` 的第三个参数 `callStreamingSpeech.reading()`，接线里用 `voice-call/playing.ts`），所以朗读中的"嗯/对"被挡住。体验记录：`interrupt` 带 `overHer`，被取消的 `reading-time` 带 `cancelBy`（谁取消的，`read-cancel-cause.ts`），通话 `end` 的 `reason` 词不再被说明覆盖（说明在 `note`）。见 `docs/claude/2026-11-20-call-hervoice.md`，测试 `tests/call-her-voice.test.ts`。
- **先侧耳听，再判断（I-177 第 2 批，2026-11-22，记录）。** 通话里你一开口（窗口的"你在插话"），她的云端声音先平滑降低（`src/voice/voice-call/call-duck.ts`，经 `src/voice/output-bus.ts`），照常读；主机判成句或叫停话照旧让她停，被拦下的片段（语气词、半句、回声）由 `voice-chat-host.ts` 给窗口发一个 `held` 事件（只有类型，没有字），她的声音回来接着说。放低只调音量，从不让她停（变异 DUCK1、DUCK2）。挂断那行体验记录数"停下 / 接着说"（`voice-call/host.ts`，只云端声音）。测试：`tests/i177-call-duck.test.ts`、`tests/interrupt-gate.test.ts`。
- **她还没出声时再补一句，直接接上去（I-197，2026-11-23，记录）。** 通话里从你一句交给她开始，到她的声音真正放出来为止（字到了、声音没出来也算），`electron/voice/voice-call/add-on.ts` 的 `CallAddOn` 开着一个"还没回"的窗口（`VoiceCallHost.addOn`；读的窗口报告某句 `noteReplySpeechHeard` 'start' 就关；通话里不朗读时，她第一个字就关）。窗口开着时：插话的门只把她的"嗯……"短音当成她在说话（`herVoice`，防回声），所以"对""好"这种短句也照样收；新的一段话并进还没回的那一段（`voice-conversation-session.ts` 的 `joinFor`/`reopen`），请求还没写进进程就并成同一条（`absorb`），写进去了就用 `supersede()` 停那一轮（进程不关），下一轮带上一句当上下文、只说一句"他在你开口前又补了一句，两句一起回"（`voice-notes.ts` 的 `voiceAddOnNote`）。被丢掉的那条：朗读清空，不存（`VoiceCompanionLeg` 的 `holdArchive`/`discard`/`commit`：出声前写的字先扣着），窗口收到 `terminal` 的 `dropped` 后把它从聊天里拿掉（`src/voice/voice-call/add-on-drop.ts`）。回复写完但还没出声时最多等 `addOn.holdMs`（6 秒）：出声了照常算，补一句就丢掉，等不到就照常算。体验记录 `voice-call` 的 `add-on` 一行（隔了多久、请求写进去没有、丢了几个字）。出声以后照旧走上面的打断规则；但你**开口**在她出声之前、话在她出声之后才认出来的那句仍算补一句（`speechStart` 记开口，窗口等这句话的下落：认出来就接，认成噪声就照常算，最长等同一个 6 秒；11-24，22:29 的事）。测试 `tests/i197-call-add-on.test.ts`、`tests/i197-add-on-records.test.ts`；变异 `I197-*`。打字那一步移到以后的任务。
- **打开麦克风不再让她停（取代 11-03 的"读完这一句就停"）。** `VoiceChatHost` 开麦（`open`）时不发停朗读；识别出的成句话或叫停话被接受时照旧立刻停。测试 `tests/voice-mic-finish-sentence.test.ts`，变异 VMIC。
- **她用哪个声音，只问一个解析函数**（I-162 第 1 步，记录）。
  - 每个角色的默认声音在她的卡上（`voice`：服务商、声音编号、语速、音调、声音描述）。
  - 所有朗读路径都调 `characterTtsConfig(设置, 当前卡)`（`shared/voice/character-voice-resolver.ts`），不直接调 `effectiveTtsConfig`。后者现在只是"角色 + 模型"绑定里的风格那一层。
  - 解析规则：
    - 绝不用已知是另一性别的声音；
    - Drama 3 没有声音编号就不用；
    - 她的服务商用不了时，先试"新角色的默认服务商"，再试系统声音，控制窗口说一行原因。
  - 系统声音由窗口按 `voicePlan` 挑（`src/voice/voice-language.ts pickSystemVoice`）。
  - 测试：`tests/character-voice-resolver.test.ts`、`tests/character-voice-paths.test.ts`（新的直接调用者会让它失败）、`tests/character-voice-card.test.ts`。
  - **第 2 步：界面（2026-11-20，记录）。**
    - 角色页多了「她的声音」（`src/cards/CharacterVoiceControls.ts`）：服务商、那家的声音（百炼和系统声音的列表标出已知的男声/女声）、语速、音调（只有系统声音能调）、声音描述（兼容提示词）。它的表单和选项表在 `shared/voice/character-voice-form.ts`（纯函数，没有 Key 字段）。
    - 朗读设置里原来的「输出方案」改名「新角色的默认声音」，只管新角色和还没有自己声音的角色；「这个角色的朗读声音」下拉去掉，换成一行说明和「去她的声音设置」按钮。内部通道的 `voice_provider` 同样只改这个默认。
    - 选付费服务商（百炼、Drama 3）只是存下选择：不读任何声音、不花钱；试听仍走原来的付费提示和同意；没有哪里会把免费声音自动升成付费。
    - 她用不上自己的声音时，那一行提示可以一点就到「她的声音」（`带我去` 的去处 `character-voice`，`goToHerVoice`），有英文版（`VoicePlan.noticeEn`）。
    - 系统声音的她自己的语速、音调：解析函数放进 `voicePlan.rate/pitch`（只在系统声音真是她的声音时），窗口在 `src/voice/speech.ts` 里乘在全局语速、音调上（`systemVoiceDelivery`）。云端声音的语速以她卡上的为准，没设就用面板里的。
    - 测试：`tests/character-voice-step2.test.ts`、`tests/character-voice-ui.test.ts`；变异 S2-default-moves-nobody、S2-fallback-takes-her-pace、S2-cloud-pace-from-panel。
- **语音通话的"打断"要生效。** 测试：`tests/i091-voice-call.test.ts`（核过：`:145` 用户压过她的声音，她停一次，她自己的回声不算；`:327` 打断只送到她的下一次语音请求，只一次）。`tests/i099-smart-turn.test.ts` 管的是"这句话说完了没有"（智能断句），不是打断。

- **只有你插话才打断她（2026-11-25）**：会停她的路只有你自己的动作（新消息、真的开口插话、停止、关朗读只停声音、换角色或退出、开通话）。勾感知开关、存别的设置、换声音/语速/服务都不停：声音按回复冻结（`frozen-reading-voices.ts`，一条回复读到底都是开始时的声音），下一条回复才用新的；要重启她聊天进程的改动（换连接、角色设定）等回复和声音都结束（`settle-when-quiet.ts`，接线 `electron/wiring/quiet-wiring.ts`），你这时发新消息就先做完。规则在 `shared/voice/interrupt-policy.ts`。体验记录新增 `setting-deferred`。2026-11-26 补（I-221 复验，`docs/claude/2026-11-26-off-switch-interrupts.md`）：关掉「发图片」/屏幕共享/她主动看时窗口不再自己清空聊天，页面和她这条回复都留着；`setting-deferred` 一次忙碌写一行，她安静下来就算这次忙碌结束；朗读的 `cancelBy` 只在主机真的取消了一段朗读时才记原因（之前开机时的 `window`、每条新消息的 `superseded` 会留着，写到后面不相干的那次打断上）。
- **每一条被取消的朗读都写着是谁取消的；Drama 3 连不上时重试一次（2026-11-24，`docs/claude/2026-11-24-voice-gaps.md`）**：
  - 取消原因是一张封闭的词表（`shared/voice/journal-entries.ts` 的 `READING_CANCEL_BYS`）。窗口这边每次停朗读都给一个词（`speech.stop(why)` → `VoiceOutput.stop(why)`，记录里的 `cancelBy`）；宿主这边在取消的地方先记一个词（`ReadCancelCauses`）；宿主记的优先，其次是窗口给的，都没有就写 `unlogged`，所以不会再有"取消了却不知道谁取消的"。新增一条取消的路，也要给它一个词。
  - Drama 3 请求一直没连上（`network`）并且还没出过声，就等一小会儿（350–900 毫秒里随机）把同一句再发一次，只一次（`electron/voice/fish-retry.ts`，宿主用的合成是 `fishVoiceSynthesizer`：额度检查加重试）。没连上的请求不算费用，第二次被服务接受才记一次。出过声、被拒绝、超时、被停掉都不重试。
  - 体验记录：`speech` 行多了错误种类、是否重试过、第几条回复第几句；`reading-time` 行多了 `reply`（第几条回复）和 `afterRetry`；新的 `reading-segments` 行每条回复一行，列出每一句的合成用了多久、前面空了多久、哪个服务（只有数字和封闭的词）。预取深度没动。
- **每一条显示出来的回复，要么读了，要么有一行说明为什么没读（2026-11-24）**：
  - 以前只有声音出过句子记录才会写一行 `reading-time`；回复交到声音手里却没人来要第一句，什么也不留。现在宿主结算一段语音时，`electron/voice/speech-handover.ts` 的 `handoverVerdict` 给出唯一的答案：交给声音（`hand`），或者一个封闭的词（`newer-line`、`no-appraisal`、`not-complete`、`superseded`，在 `READING_CANCEL_BYS` 里），词当场写成一行 `unread`。交出去的回复登记在 `ReadingLedger`（`electron/voice/reading-ledger.ts`），声音来要第一句（`ReadNotes.numberOf`）就销账；等满 `READING_IDLE_MS` 还没人来要，写一行 `not-asked`（窗口中间说过原因就用窗口的词）。
  - 窗口这边每条悄悄丢掉朗读的路（窗口没显示、新一轮已开始、气泡没就绪、朗读开关关了）现在先说一个词（`src/voice/reading-dropped.ts` → `noteJournalFact('reading-dropped')` → `readCancel.note`）。
  - 测试：`tests/voice-bubble-1226-1234.test.ts`；变异 V-held-reply-not-recorded、V-handed-reply-not-expected、V-ledger-timeout-silent、V-handover-newer-line、V-drop-fact-not-cause。
  - 没覆盖：打字发的回复由窗口自己的朗读队列读，窗口里没问过宿主就放弃的路宿主看不见（只有上面几条窗口词）。

## 5. 测试在哪

- `node scripts/dev/ops.mjs owned voice`：只跑这部分相关的测试。
- test-parts.json 里 owner 是 voice 的文件有 66 个。
- 最重要的几个：
  - `tests/voice-gaps-retry.test.ts`、`tests/voice-gaps-journal.test.ts`、`tests/voice-gaps-output.test.ts`（2026-11-24：重试、取消原因、逐句计时）
  - `tests/speech-playback-admission.test.ts`、`tests/r34-playback-host.test.ts`、`tests/r34-main-integration.test.ts`
  - `tests/completed-reply-commit.test.ts`、`tests/completed-prefix-proof.test.ts`
  - `tests/i070-drama3.test.ts`、`tests/i091-voice-call.test.ts`
  - `tests/audio-reading-app-wiring.test.ts`、`tests/character-context-lifecycle.test.ts`
  - `tests/wiring-golden.test.mjs`（调换 `saveTtsKey` 和 `saveStopsSpeech` 会失败）、`tests/wiring-parts.test.ts`

## 6. 改的时候小心

- **4b 记录里的三处原有覆盖缺口**（改指向之前就没有测试失败）：
  1. 逐句朗读提交前，不再查朗读开关；
  2. 换角色时，`clearReplySpeech` 不取消正在读的那句；
  3. 普通（非前缀）句段合成前，去掉"回复气泡确认显示"的检查。
  改这几处之前，先补测试。
- **保存步骤的顺序**：`saveTtsKey` 和 `saveStopsSpeech` 的顺序被金标准钉着（调换会失败）。
- **`clearReplySpeech` 不能写成接线文件的顶层函数**：金标准会把排序表里调用的顶层函数就地展开，saveSettings 的金标准会变。它现在是 `wireVoice` 里设的绑定。
- **退出和窗口事件的朗读清理还在 main.ts。** 挪动时要保持顺序。
- **`VoiceChatHost` 从接线文件转出**：以后要是把 voice-chat-host 和 companion 的环拆开，可以改成从公开页拿。

## 7. 和 Claude 有关的地方

- **1-1 常驻聊天进程**：语音回复走聊天那一条常驻进程（`electron/voice/voice-chat-host.ts`，经 `electron/brain/`）。
- **1-12 计时**：首字和耗时的三个时间点，用来看首字速度（R27 要求第一句一秒内出现）。
- **1-13 通话里的热进程**：通话期间常驻进程不因闲置关掉，开通话时没有就先预热一个。冷启动约 3.7 秒，热进程约 1.6 秒（基线记录）。
- **1-14 通话换新的轮数**：`holdWarm` 开着时上限 40 轮；口语规则是固定的中文文字（不写"电话"）。**实验记录：Opus 不说"听不到"，Sonnet、Haiku 会说。** 换更快的模型，可能把通话说破。
- **7-1 草稿过滤**：朗读前也要挡住草稿（思考过程、英文计划等），进了朗读就是核心底线。
- **7-5 首字节奏**：Claude Code 的流在第一小块之后常停 0.2 到 0.5 秒，换大脑后要重测首字。
- 通话和耳机（I-177 第 1 批）：窗口这边 `src/voice/voice-call/call-mic.ts` 记下见过的声音设备（种类和去掉机主名的名字，不含 id）、按用户自己的"麦克风优先级列表"选通话的麦克风（空列表 = 系统默认，从不自动换）、通话开始时出外放提醒（一天一次，可关）、耳机麦克风说明和"换 / 不换 / 以后再说"的建议卡片；纯规则在 `shared/voice/call-devices.ts`（耳机还是外放、机主名去除、同一副耳机配对、关键词判断、优先级选择）。Claude 判断（第 2 批）：`call-device-judge.ts`（IPC `callDevicesAsk`，haiku，每组设备一次、Claude 可用时才问、一天最多 6 次；主进程再去一次机主名，回答只留送去的名字和三种类型；变异 CD5、CD6，测试 `tests/i177-call-device-judge.test.ts`）。她的声音从哪个设备出来（第 2 批生效）：窗口的 `src/voice/output-sink.ts` 用 `AudioContext.setSinkId` 把云端声音放到列表里第一个插着的设备，拔掉回默认，叫醒信号跟着换（变异 SINK1～3，测试 `tests/i177-output-sink.test.ts`）。两个窗口共用同一份本地存储，每次读写都先读当前的（变异 STORE1）。

## 台上的声音（I-209，2026-11-24）

记录：`docs/claude/2026-11-24-i209-stage-voice.md`。全屏三人同框时，台上每一位用自己的卡念自己的话，一次一个声音，仍是这一条朗读的路：

- `ReplySpeechStyles.begin(…, characterId)` 记下一次朗读是台上哪位的（她回你的一轮、她的接话）；桌面陪伴那位不记，和以前一样。
- `stage-voices.ts`：`readingScope`——台上别人的朗读按她的座位范围检查（她下台、对话换了就对不上，`GONE_SCOPE`）；`readingVoice`——用她的卡（声音服务、声音编号、语速、读法）。`voice-wiring.ts` 的 `speechScope(replyId)` 带编号时用它，不带时和以前一字不差。
- Drama 3 的月度上限和用量是台上所有人一份（运行时只有一个合成器）。
- `read-notes.ts`：`whose` / `offered` / `latestOwner`，朗读记录（`reading-time`、`reading-segments`、没念的那行、失败的 `speech` 行）记在说话那位名下。
- 窗口这一侧：`src/voice/reading-voices.ts` 按正在念的这一句选她的卡（`ChatStarted.speakerId`、接话那句的 `voice`）。
