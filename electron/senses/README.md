# 感知（senses）

给别的 agent 看的部分说明。总入口见 handbook/for-other-agents.md。

## 1. 这部分做什么

她能"看"和"听"的部分：摄像头、屏幕、麦克风、电脑的声音、你在用哪个程序、你现在方不方便被打扰。还有她从这些里得到的东西：看一眼、一起看、一起听、听到的声音文字、认脸（I-135）、喂食时认出食物（I-019）。

用户感觉到的是：她只在你开了的时候才看、才听；你不开，她什么都拿不到。你说"别看"是对她说的话，她自己听、自己决定（I-168），真不想让她看就关开关。

**这是隐私最敏感的一部分。** 摄像头、屏幕、麦克风、系统声音默认全部关着，只有用户明确开启才会动。建议不等于同意。

## 2. 文件在哪

- 三个文件夹：`electron/senses/`、`shared/senses/`、`src/senses/`。
- 公开页（只从这里 import）：
  - `electron/senses/index.ts`（导出 `LookTurns`、`ScreenGlance`、`CameraGlance`、`ListenTogether`、`AmbientAudioRuntime`、`PoseSensingHost`、`LocalAsrHost`、`UserGazeHost` 等；`MediaRuntime` 不在公开页上，在 `electron/senses/media-runtime.ts`）
  - `shared/senses/index.ts`
  - `src/senses/index.ts`（面板，如 `CameraSharingPanel`、`PoseSensingPanel`、`ListenTogetherPanel`）
- 接线按功能分四个文件（2026-11-17 拆开，记录）。改哪样功能，读那一个文件就够：
  - `electron/wiring/senses-wiring.ts`：入口 `wireSenses(needs)`（依次造她听、语音输入、看）、`SensesNeeds` / `SensesProvides`、数据地图登记、传感窗口（顶层的 `startUserActivity()`、`startPoseAndFace(dir)`、`startLocalAsr(dir)`，ready 链里的几步，金标准就地展开）、`register(ipc)` 入口（按原来的顺序交给下面三个文件）。别的部分和 main.ts 只从这里 import。
  - `electron/wiring/senses-look-wiring.ts`（看）：摄像头、屏幕的开关和抓帧，看一眼，视觉状态，R10 主动画面话题，视觉身份，跟着看，你在哪（I-081），「截取画面」；看的 15 个处理函数；`syncVisionContext`、`saveVisionReset`、`savedVisionState`。摄像头和屏幕的隐私关口在这里。
  - `electron/wiring/senses-listen-wiring.ts`（她听）：电脑的声音，旧版声音理解，读取音频，一起听 / 一起看（`initAmbientAudio`），朗读时暂停听的守卫；这些的 20 个处理函数。系统声音、读取音频的隐私关口在这里。
  - `electron/wiring/senses-voice-input-wiring.ts`（语音输入）：识别路由、前台识别和 `asrTask`、R33 连续语音；四个采集处理函数；`syncVoiceScope`、`saveProviderStopsAudio`、`saveVoiceInputKey`。
- 接线里的 live binding（main.ts 照常从 `senses-wiring.ts` 读，那里把功能文件的再导出一次）：`poseSensing`、`faceCheck`、`localAsr`、`userActivity`、`ambientAudio`、`listenTogether`、`watchTogether`、`asrTask` 等。别的部分写的两个状态用 setter：`setVisionSupported`、`setVisionStatus`、`setLastAmbientSpeech`。
- 留在 `electron/main.ts` 的：
  - 摄像头权限开关 `cameraEnabled` 和 `setCameraPermission`（会话权限处理读它，窗口事件也写它）；
  - I-040 的 sense router 和 I-085 她自己看（比别的部分更早造，别的部分在 main.ts 求值时就读它们）；
  - `cancelProactiveVision`、`ackVisionInitiative`（它们同时取消内心循环、文字纪念等，是跨部分的扇出）；
  - 一起听的听类（`listenKind`，舞台的节拍打分喂它）；
  - "清除她记得的歌"（I-077）的处理函数，它经记忆部分进回收站；
  - 窗口事件里感知的那几行（`secureWindow` 的顺序表）；
  - 三个模块级 `setInterval`，其中一个每分钟把一起看的计数写进体验记录。

## 3. 从哪进、谁调用它

- main.ts 在原来造 `media` 的位置调用 `wireSenses(...)`。它只存端口，不做别的事。
- `senses.register(partIpc('senses'))` 在录制器里。它按原来的顺序注册：看的 15 个、`userActivity?.register(scopedHost)`、她听的 20 个、语音输入的 4 个（4c、4d 记录）。入口把 `ipc` 以 `registrar` 这个名字交给三个功能文件，金标准顺着这个名字找到它们，录制器才录得到感知的操作；改名会让金标准失败。
- 保存和同步步骤：`syncVoiceScope`、`syncVisionContext`、`saveVisionReset`、`saveProviderStopsAudio`、`saveVoiceInputKey`，都是功能文件的顶层函数，顺序由 main.ts 的列表给出。
- 时钟：`clockTick` 里有几项是感知的，每秒读一次：`screenGlance.watchTick()`、`userActivity.tick()`、`faceCheck.host.notePresence(...)`、R10 主动画面的 `proactiveVision.start(...)`、`ambientComments`、`ambientAudio`。时钟条目目前由 main.ts 传入，部分还不自己登记。
- 生命周期：`secureWindow` 的监听在 main.ts 的 `windowEvents` 里（一个订阅者，顺序是原来的）。窗口隐藏时放掉摄像头就是在那里。

## 4. 它守着的规矩

- **屏幕共享读哪块屏幕或哪个窗口（I-190）**：`screen-source.ts` 的 `ScreenSourceChoice`（接线 `electron/wiring/screen-source-wiring.ts`，三个请求 `screenSourceMenu` / `chooseScreenSource` / `getScreenSource`，广播 `desk:screen-source`）。默认"跟着系统默认"=她所在的那块屏幕（和以前一样）；屏幕共享的所有读取（粗看、看清、小图、凑近看、一起看的帧）都经 `screen-capture.ts` 的 `pick` 问它。只收上一次列表里给过的不透明编号（两分钟内），不列 soft hearts 自己的窗口；选来源从不开关屏幕共享；只在内存里（下次启动回到默认）。选的窗口关了 → 回到默认并说一次；最小化拍不到 → 这次没有图，绝不改拍整块屏幕。电脑的声音：Electron 45 在 Windows 上只给整台电脑的 loopback，菜单照实写"电脑的全部声音"。测试 `tests/i190-source-pickers.test.ts`，变异 `I190-*`。
- **她自己开口的几条（陪听停顿、系统音频评论、屏幕和摄像头的主动话题）提示词里都带最近的聊天和"只写说出口的话"（I-178，2026-11-22）**：块由主机给（`recentChat`，大脑部分的 `proactiveChatReader`），读失败当没有；屏幕话题的那段文字抽到了 `shared/senses/vision-topic-prompt.ts`。喂食句、看了一眼之后的补句例外（用户定稿的文字允许括号动作）。测试：`tests/i178-proactive-context.test.ts`。
- **「和她一起看」是一个开关：看画面 + 听台词（I-187）。** 点一下同时开屏幕共享和电脑声音的听台词（读取音频的 `movie` 用途），两样都开着时点一下两样都关；关的时候先停台词。这一下只会要屏幕共享和 system-audio/movie，绝不开摄像头、语音输入、麦克风，也不碰「和她一起听」的音乐（两者共用一次采集，一起听关掉时一起看开着就留下台词）。在看画面而台词没在听（没开、正在准备、她朗读时暂停、采不到声音）时，眼睛按钮上有个小圆点、提示里写明。逻辑：`shared/senses/watch-together-state.ts`（按钮怎么写、点一下改什么）、`src/senses/watch-together-toggle.ts`（只发这两个请求）、`src/stage/watch-together-button.ts`。一起看的每分钟计数多三项：台词能听到 / 暂停 / 没采到声音的秒数（`watch-tally` 的 `hearS`、`pausedS`、`noCaptureS`）；陪听计数多"识别排满跳过"（`skippedBusy`）。电脑声音的片段按音频时钟打时间（`src/senses/audio-frame-clock.ts`），窗口忙时晚到的片段不再被当成断开而扔掉正在拼的一段。测试 `tests/i187-watch-together.test.ts`、`tests/i187-audio-frame-clock.test.ts`；变异 `I187-*`。记录 `docs/claude/2026-11-22-watch-together-deep-fix.md`。
- **摄像头、屏幕、麦克风、系统声音默认关，必须用户明确开启。** 测试：`tests/senses-privacy-gates.test.ts`（20 项，每项求值接线里的真实代码，关着、"别看"、不是所属窗口、窗口不在屏幕上时什么都不做）。
- **"别看"不再挡任何东西（I-168）。** 应用里的 `LookTurns` 用 `{ holds: SEE_AND_SAY.holdOnNo }`（false）造：说"别看"摄像头不会被按住（`cameraHeld` 不再出现）、屏幕不会被拒（`refusedIn` 不再为真），所以小图、她凑近看、通话小画面、全屏那边、屏幕大概、她自己看一眼都只照开关走。下面写着"别看"挡住的几条，是 `holdOnNo = true`（以前的规矩）时的样子，代码和测试都还在，是这个旋钮的退路（`LookTurns` 不带选项时默认按以前）。测试：`tests/i168-she-decides-to-look.test.ts`；变异 `I168-*`。记录 `docs/claude/2026-11-21-i168-she-decides-to-look.md`。
- **（`holdOnNo = true` 时）"别看"（holdCamera）时，摄像头不出帧，她的看一眼和主动视觉都不取。** 测试：`tests/camera-two-switches.test.ts`、`tests/senses-privacy-gates.test.ts`。
- **本地姿势识别拥有摄像头时，别的地方不抓摄像头帧。** 测试：`tests/pose-privacy.test.ts`（4c 记录：去掉 `!media.sharesCameraFrames()` 会失败）。
- **I-167（2026-11-21，记录 `docs/claude/2026-11-21-gaze-at-user.md`）：姿势信号多一个 `head`**：`{ yaw, pitch, distance }`（整数度、米两位小数；屏幕的方向：yaw + = 朝屏幕右边，pitch + = 往下），姿势进程里用五个脸部关键点按原精度算（`shared/behaviors/gaze-attention/head-pose.ts`），One-Euro 平滑后再取整；没有脸时是 null，`parsePoseSignal` 只在有脸时收、形状固定。脸的位置和各个点也改成 One-Euro 平滑（旋钮 `knobs.ts` 的 `filter`），脸的中心有两只眼睛时取两眼中间。你朝着屏幕时姿势识别每秒 10 帧（算不过来就 8，再不行照旧 5；用电池时不提，`pose/route.ts` 的 `attendRate`），小动作马上发（`pose/emit-gate.ts`）。`user-gaze.ts` 用 `head` 估距离、给读数加 `turn`（头朝哪），对视进心情时还要你的头朝着她的窗口。变异 `gaze-*`（`scripts/dev/mutations/senses.json`）。
- **I-169（2026-11-21，记录 `docs/claude/2026-11-21-i169-gaze-debug.md`）：开发者模式显示她在看哪里**（窗口侧 `src/senses/gaze-debug-view.ts`、`gaze-debug-flat.ts`）：标签（在看谁、三个权重、刚换的原因、眼头角度）加视线落点的小点；只在开发者模式里创建，关着没有 DOM 节点；只读，只用舞台已有的数字，不存不记不发。读数出口：`StageGazeAttention.readout()`、`GazeAttention.readout()`。测试：`tests/gaze-debug.test.ts`。
- **I-189（2026-11-22，记录 `docs/claude/2026-11-22-i189-pose-uses.md`）：本机姿势的几个新用处**，主机在 `electron/senses/pose-uses/host.ts`，纯逻辑和旋钮在 `shared/behaviors/pose-uses/`（本部分的行为文件夹，经 `shared/senses` 导出），接线 `electron/wiring/senses-pose-uses-wiring.ts`：
  - 姿势信号多一个 `people`（检测框数出来的人数 0..4，取最近三次检测里最小的；只是一个数，不说在哪、是谁），`parsePoseSignal` 允许它缺（按 0），`POSE_RECOGNISES` 加了"点头摇头、画面里有几个人"。
  - `userGaze` 的读数多一个 `attention`（朝着屏幕 / 转开 / 不在，有把握、去抖后才给，带持续多久），窗口用它在你转开或走开 2 秒后、一句说完时停下朗读（`src/voice/away-read-pause.ts`），通话里你侧过脸开口不算插她的话（`MediaInput` 的 `overHerHeld`）。一帧拿不准永远是"不知道"，不知道时什么都不做。
  - 她问了"要不要……？"这类问题、说完念完后 5 秒内（她还在念时不算；打字、通话时不认），你正对着屏幕、身子不晃、约 1.5 秒内连点两下头或左右摇两个来回，经控制窗口自己的发送路发一条"（点头）/（摇头）"，那一轮她的资料里说明这是动作不是打字。
  - 瘫坐或离屏太近、盯屏幕很久、盯完把视线移开、连续久坐：交给 I-188 的时刻主机（`pose` 接口），同一道总闸；画面里确认有两个人、久坐数字（只在你问时）、朗读没念完就结束：只放进她下一轮的资料（`momentsChatTurn`）。全部只是信息，不写她的反应。
  - 体验记录新类型 `pose-use`（封闭的词和秒数）。测试 `tests/i189-pose-uses.test.ts`、`tests/i189-read-pause.test.ts`、`tests/i099-call-listening.test.ts`（侧脸那条）；变异 `i189-*`（`senses.json`、`voice.json`）。
- **姿势信号（`PoseSignal`）除了在不在（`confidence`）、朝向、坐姿、动作幅度、节奏、事件，还带三个至信度（2026-11-17，都是 0..1）**：`facingConfidence`、`postureConfidence`、`eventConfidence`（只有这次信号里的事件才有键）。算法在 `electron/senses/pose/confidence.ts`（关键点分数 x 最近 7 帧的一致程度；'unknown' 是 0），校验在 `parsePoseSignal`（缺字段、非有限数拒绝，超范围限到 0..1），三档说法 `poseConfidenceBand`（sure / maybe / unsure）在 `shared/senses/pose-confidence.ts`。现有使用者都不读这三项。测试 `tests/pose-confidence.test.ts`，变异 `S-pose-conf-*`。记录 `docs/claude/2026-11-17-pose-confidence.md`。
- **（`holdOnNo = true` 时）屏幕只读大概时，"别看"要挡住。** 测试：`tests/screen-rough-only.test.ts`。
- **语音输入和通话的每一段，和打字走同一套"看一眼"的规矩（I-161）。** 识别出的文字（`shared/senses/call-look.ts spokenLookText`，只把"憋看"这类听错的"别看"改回"别"）走同一个 `LookAttachments.request`：先决定、再截图；帧有 ticket、走同一个 `admit`，写给 Claude 那一刻再问一次；开着「发图片」时每段带那张已存的小画面（`CALL_LOOK.glanceEveryTurn`，"别看"时不带）。一段的帧只属于这一段（`electron/senses/voice-look.ts`，段结束就 `drop`）。测试：`tests/i161-call-frames.test.ts`、`tests/i161-spoken-look.test.ts`；变异 `i161-*`（senses）、`V30`/`V31`（voice）。记录 `docs/claude/2026-11-19-call-frames.md`。
- **语音和通话里看不看，也按语义判断（I-161）。** 每段话照旧先走上面的句式规则（快路）；同时每一段新话也交给打字的 I-040 判断（`electron/senses/sense-router/voice.ts` → `host.ts`），问题骑在这段话本来就有的反应判定那一次 haiku 调用上，不多一次判断调用（反应判定没问时另起一次，要 `CALL_LOOK.semanticOwnJudge`，默认关）。要看且开着就看一眼、写成事实：语音输入照打字那样她再补一句；通话里绝不另起回复，事实放进她下一段话的私下说明（这段还没写出去就放进这段；`takeCarried`/`releaseCarried`，同一次收音、同一角色和对话、60 秒内、那个感知还开着、没说"别看"才给，段结束或挂电话就忘）。上一段还没看完的那一眼不再被新一段扔掉（`carry-store.ts`、`host.ts` 的 `lingering`）：事实带"N 秒前"、以"你知道的事"的口气进之后的某一段，要不要提由她，丢掉的规则一样。测试 `tests/i161-call-semantic-look.test.ts`；变异 `i161s-*`（senses）。记录 `docs/claude/2026-11-20-call-semantic-look.md`。
- **关掉一个感知不打断她，也不清空聊天（I-221，2026-11-26，`docs/claude/2026-11-26-off-switch-interrupts.md`）**：关「发图片」、屏幕共享、摄像头，换了来源，或关她主动看时，主机立刻扔掉她看过的东西（取到一半的画面中止、留着的摄像头那张、通话和热进程里的小画面、看的票、她自己看的那一眼），之后拍不到也发不出新画面；她正在说的这条回复和声音照常说完，页面上的话都留着（`senses-look-wiring.ts sightOff` → `desk:vision-context-cleared { keepConversation }`，窗口 `src/brain/clear-after-reply.ts`）。已经在这条请求里的那一帧跟着这条请求走（11-25 的决定）；"关掉之后的旧帧"照旧（`electron/main.ts`）。换对话、换窗口这类真正换了上下文的，照旧清空。测试 `tests/off-switch-interrupts.test.ts`；变异 `I221-*`、`NI13`～`NI16`、`B4-sharing-off-cuts-her`。
- **通话里的小画面留到挂电话（I-161 A）**：只带「发图片」小画面的一段，`TurnFrames.glanceOnly`/`glanceStill` 告诉聊天进程"可以留、还能不能看"（检查只握着 ticket，不握画面）；"别看"、关摄像头/「发图片」/屏幕（`media-runtime.ts callGlancesRevoked`）和清视觉上下文都会让接线调 `claudeChat.forgetFrames()`。测试 `tests/i161-call-glance-held.test.ts`、`tests/senses-privacy-gates.test.ts`；记录 `docs/claude/2026-11-19-call-glance-a.md`。
- **每个考虑过要不要看的语音/通话段，体验记录里写一行（I-161，没能复现，先让下次看得清）**：`voice-call` 的 `look` 事件，只有固定词和是非——句式规则要看什么、语义判断走哪条路（反应判定上/单独问/没问）、当时开着什么、判断答什么、结果（看了/判断说不用看/要看的没开/你说了别看/没有结果/没看成/被打断/没有判断）。由路由器轮次结束时的 `onEnd`（`SenseTurnEnd`）经 `electron/senses/sense-router/voice.ts` 写，板块 `shared/voice/call-look-journal.ts`；不改任何看不看的决定。说明见 `docs/claude/2026-11-21-call-screen-look.md`。
- **看到的东西直接影响她说什么（I-166）。** 打字、语音输入、通话的每一轮，开着的每个感知各附一张小图（摄像头 320×240、屏幕 320×200，约一百个图像 token，十几 KB）：`LookAttachments.request` 在清楚画面之后取（摄像头用窗口备着的那张，过期了——全屏时窗口被节流——就现拍一张缩小；屏幕的在打字时先拍，`electron/senses/small-frames.ts`），没备好的最多等 `SEE_AND_SAY.smallWaitMs`，过了这一轮就不带。没开的、说了"别看"的（屏幕的"别看"、摄像头的"别看"、拿不准的话）一张都不取；窗口模式感知照旧默认关。小图在 `TurnFrames` 里标成小图（`screenGlance()`、`glanceOnly()`），不算"叫她看"。"看看我""看看这个"这类句式仍立刻附清楚的画面（不经模型）。haiku 的"要不要看"判断不再拿到摄像头和屏幕（`judgedSenses`，`SEE_AND_SAY.haikuLook` 关；听的判断照旧）。她自己想看清时写记号，清楚的那张由 `LookAttachments.closer` 拍：只在那个感知开着、没被"别看"按住时拍，拍完之后说"别看"或关掉，送出前再查一次就没了。接线在 `electron/wiring/see-and-say-wiring.ts`。测试：`tests/i166-see-and-say.test.ts`；变异 `I166-*`（senses、brain）。记录 `docs/claude/2026-11-21-i166-see-and-say.md`。
- **她凑近看要拿到清楚的那张（2026-11-22）**：`LookAttachments.closer` 只在这个感知自己的开关（屏幕共享的那次打开 `openings`）、视觉上下文变了或说了"别看"（`holdOnNo` 开时）时扔掉画面，别的开关（语音输入、摄像头）让 media revision 变了不再扔；第一次因为来源没准备好、拍到一半被打断、屏幕没给画面而落空时，在 `closerTimeoutMs` 之内再试一次（`SEE_AND_SAY.closerTries`），每次试之前都先查开关和"别看"，开关变了、上下文变了从不重试。屏幕取帧 `ScreenSnapshots.sampleOnce`：上一次被停掉的读取还占着那个位置时，先等它走（最多 `STALE_SLOT_WAIT_MS`）再拍新的，不再马上给空，也从不同时读两次；一个读者不等了，只在没人再等时才停掉那次读取。`screen-capture.ts` 的两次读也改成看屏幕共享的那次打开，不看 media revision。看屏幕取帧的视觉上下文不再带她的心情 token（`senses-look-wiring.ts` 传 `scope: speech`）。`report` 给体验记录一个封闭的 `miss` 词和试了几次。测试 `tests/closer-no-frame.test.ts`；变异 `CNF-*`、`I166-closer-allowed`。记录 `docs/claude/2026-11-22-closer-no-frame.md`。
- **清楚的画面也留在热进程（I-168，"按你的推荐"，`SEE_AND_SAY.keepClearFrames`）**：`LookAttachments` 的 `keepClearFrames` 端口（see-and-say 接线给）开着时，这一轮宿主自己拍的清楚画面也算"可以留"（`TurnFrames.glanceOnly`），各带自己的检查（`glanceStill`，只握 ticket）；她凑近看的那张由 `closer()` 返回的 `still` 检查。手动附的快照照旧用完就换。
- **窗口要在屏幕上，才能拿到摄像头帧或系统声音。** 测试：`tests/senses-privacy-gates.test.ts`（4c 记录里是原有缺口，现在补上了）。"在屏幕上"按 `onScreen` 算：她在全屏 Unbound 外面时，藏着的桌宠窗口算在屏幕上（2026-11-21：以前 `publishCameraSample` 只看 `isVisible()`，她在外面时每次看你都失败）；别的藏着的窗口、她在家时藏着不算；拍的途中说了"别看"画面不收。拒收时那次请求当场结束，原因用固定词告诉体验记录（`camera-sample.ts` 的 `miss`）。
- **"看你"的话（2026-11-21，`shared/senses/look-at-you.ts`、`look-can-see.ts asksCanSeeYou`）**：说到你本人（"你看看我是不是……"）、看摄像头本身、问能不能看见你，都是摄像头；"这个"在屏幕和摄像头都开时两样都看（`lookWants`），但摄像头被"别看"按住时"这个"只看屏幕。体验记录的摄像头行在没看成时写断在哪一步、被打断时写到了哪一步和被什么打断；聊天消息也写 `look` 行（`chat: true`，`electron/senses/sense-router/chat-look.ts`）。测试 `tests/unbound-camera-look.test.ts`；变异 `cam-sample-held`、`cam-sample-out-feature`、`look-either-held`、`camera-look-miss-closed`。记录 `docs/claude/2026-11-21-unbound-camera-look.md`。
- **认脸（I-135）默认关，只在摄像头开着时检查；关摄像头要马上停。** 测试：`tests/face-check-host.test.ts`（2026-11-16 核实）：开关或摄像头关着时，什么都不取、不查、不启动（`:139`）；两个摄像头开关都关时不取帧、不碰端口（`:401`）；不点开关就不下载模型（`:237`）。
- **认脸每次检查的分数和"该查却没查"的原因写进体验记录（2026-11-25）**：`face-score` 行只有封闭的结果词、相似度（两位小数）、最像登记的第几组、脸清不清楚、正面程度、检测把握；一分钟没检查写 `idle` 行（识别组件没装好 / 检查没有启动 / 识别进程没能正常运行 / 摄像头没有给出画面 / 画面给了识别没有结果）。每秒的巡查在 `host.notePresence` 里（`host.watch()`），摄像头开着却没在查时会把检查重新起来。测试 `tests/face-check-restart.test.ts`、`tests/face-check-real-models.test.ts`（真模型，缺模型时跳过）。登记时的摄像头画面只发给控制窗口（`previewTarget`），不存。判定线见 `electron/senses/face/knobs.ts`（0.363 是 OpenCV 的官方线，0.30 以下算明显不是，之间是灰区）。
- **她自己看一眼（I-085）：画面不留，那句话只在内存里 10 分钟。** I-168 起没有冷却、每小时次数、打字后的安静期；只看她想不想（`wantToLook`，每分钟算一次）、开关、醒着、在屏幕上、Claude 连得上、一次一眼、这一轮已带了摄像头小图就不重复看。最坏约每小时 60 次 haiku；体验记录每次看的那行带"这一小时第几次"。测试：`tests/i085-self-look.test.ts`、`tests/i085-chat-look.test.ts`。
- **听到的原文不能随便带出去**（一起听）。规则在本机。数据地图里一起听的行（`electron/foundation/data-map.ts:149`）导出时从不带出（`cardExport: 'never'`）；忘掉角色时原文一起删（`tests/listen-together.test.ts:146`），清空原文保留笔记（`:172`）；转写内容只当材料，注入的指令不生效（`:227`）。
  - 其他出口（2026-11-17 逐条查过，没有哪个出口把听到的原文带出本机，除了下面发给她自己的 Claude 的那几处）：
    - 诊断：数据地图里每一行的 `diagnostics` 都是 `never`，只有 `dev-logs` 例外（`tests/data-map.test.ts:188`）；诊断块只由版本、系统、连接状态和日志的封闭字段拼成（`electron/safety/agent-channel/diagnostics.ts:23-40`）。
    - 内部通道（给用户自己的 Claude 的工具）：读类工具只有 get_status、get_her_state、list_characters、list_settings、read_handbook、get_diagnostics、list_model_capabilities、list_recycle_bin（`app-tools.ts:779-1508`），没有一个返回听到的文字；list_recycle_bin 只给日期加固定的"听到的一段"这类标签和条数（`electron/memory/recycle/items-wiring.ts:107`，不带文字的测试是 `tests/three-way-interconnect.test.ts:530`，那条用的是聊天记录，对听到的文字没有单独的测试名）。
    - 发给模型的：转写只在她自己的 Claude 调用里当"外部材料"出现，共三处：聊天一轮里（`electron/main.ts:1029-1030`，只在当前有听的会话时加，取最近 3 段、每段 650 字以内，`ambientContextText` 在 `electron/senses/ambient-comments.ts:48`，测试 `tests/ambient-comments.test.ts:73`）、她对听到的声音的评论（`ambient-comments.ts:147`）、用户问起听过的东西时（`ListenTogetherCore.askTurn`，`electron/senses/listen-together/core.ts`，测试 `tests/listen-together.test.ts:302`、`:323`，普通消息不带）。这三处都只在用户开着听的开关时有转写可取；"开关关着时第一处不加"没有单独的测试名。

- **只认你的声音（Unbound v1 第 3 步，2026-11-17）**：`electron/senses/voiceprint/`（CAM++ 中文声纹，唯一批准的下载，运行库只从已装组件复制，`approvedFetch` 拒绝别的地址）。默认关；录声纹用用户自己的语音输入（按住 T 说几句，录的那几句不进聊天）；只存一串数字（系统加密，`voiceprint.json`），一键删、关「允许记录」也删、不进回收站、不发给任何模型、不进内部通道和诊断。每段话在转文字之前先过声纹（`gate.ts screenClip`）：明显不是你 → 不转文字、不给她；拿不准、太短、太吵、几个人混在一起 → 当是你，控制窗口那一行会说"确认不了"。她在外面、没在通话、声纹在用、本机识别时，转出的字里有她的本名或你对她的称呼（`shared/memory/nickname-table.ts`，只认字面）才开始通话，其余的字直接丢掉。接线：`electron/wiring/senses-voiceprint-wiring.ts`（从 `senses-voice-input-wiring.ts` 接进 VoiceChatHost 的 `screen`、`wake`）。测试：`tests/voiceprint.test.ts`（11 项）、`tests/voiceprint-real.test.ts`（真模型，要环境变量）。

## 5. 测试在哪

- `node scripts/dev/ops.mjs owned senses`：只跑这部分相关的测试。
- test-parts.json 里 owner 是 senses 的文件有 123 个（最大的一块）。
- 最重要的几个：
  - `tests/senses-privacy-gates.test.ts`（4c 补的 20 项，抓住 65 个变异中的全部）
  - `tests/pose-privacy.test.ts`、`tests/screen-rough-only.test.ts`、`tests/camera-two-switches.test.ts`
  - `tests/look-stale-frame.test.ts`、`tests/look-turns.test.ts`、`tests/look-request.test.ts`
  - `tests/audio-dance-input.test.ts`、`tests/audio-reading-app-wiring.test.ts`、`tests/listen-late-window.test.ts`
  - `tests/i084-look-at-me.test.ts`、`tests/visual-self-main-wiring.test.ts`
  - `tests/wiring-golden.test.mjs`、`tests/wiring-parts.test.ts`、`tests/wiring-skeleton.test.ts`

## 6. 改的时候小心

- **隐私关口要用变异验证。** 4c 记录列了 65 个变异，每个都要有测试抓住。去掉一个检查，至少要有一个测试失败。
- **读 main.ts 的测试已改成读"接线 + main.ts"两处**（`tests/helpers/wiring-source.ts`）。断言不能放松。
- **改"只有一个 owner 能改"的状态时**，要走 setter（`setVisionSupported` 等），不要让别的部分直接写 live binding。
- **`secureWindow` 同一事件上的监听顺序要保持。** 拆订阅者会打乱顺序，目前感知的窗口事件还在 main.ts。
- **传感窗口的创建用 `startX()` 写法**（`startPoseAndFace` 等）：金标准就地展开它们，改名或挪位置，ready 链的金标准会变。
- **`AppPorts` 还没有被感知用起来**，谓词（`senseRouterFree` 等）只在测试里核对。别把它们合并：它们长得像，其实不一样（4 步记录写明）。
- **`lastAmbientSpeech` 是 live binding。** 声音和感知都会写，要经 `setLastAmbientSpeech`。

## 7. 和 Claude 有关的地方

- **1-9 图片附件**（`electron/brain/claude.ts` 的 `claudeInput`、`imageBlock`）：用户开了摄像头或屏幕，并让她看的时候，随消息带最多 2 张图。只收 PNG、JPEG、WebP。换大脑时不能放宽格式或改错误处理。
- **2-8 喂食认图**（`electron/senses/feed-recognition/model.ts`）：haiku 带一张图，答五字段 JSON。认错食物，她会说错话。图只在你喂食时发。
- **2-9 你现在方便吗**（`electron/senses/user-activity-look.ts`）：屏幕共享开着时，看一张 320×200 的缩略图，答案只能是七个固定词之一。画面会发给所选的大脑，缩略图不落盘。
- **2-10 一起看**（`electron/senses/watch-notes/wiring.ts`）：haiku 写画面描述（每小时最多 30 次），压剧情概要（5 分钟一次），带一个可选的 `watch` 词，只认四个词。I-188 起同一次调用再带一个可选的 `event` 词（error、loading、game-over、win、download-done、video-end，只认这六个），会话只在内存里记最后一个，经 `session.screenEvent` 交给她认出的时刻，只在一起看开着、给正在看的角色。屏幕画面会外发，只在"和她一起看"开着时。
- **一起看接着看、断了告诉她**（`electron/senses/watch-continuity/`，2026-11-24，记录「续」）：屏幕共享真的丢了（画面连着取不到、选的窗口没了、没人说得出原因的结束）给她一轮即时的话，只有事实；她的窗口最小化后回来，一起看自己接着开（用户这期间关过一起看或屏幕共享、屏幕被撤销、换了角色都不接），她的下一轮对话得到事实。体验记录 `watch-change`。接线：`electron/wiring/senses-listen-wiring.ts`（造它、接检测）、`electron/wiring/watch-facts-turn-wiring.ts`（她那一轮的送达）、`electron/wiring/stage-cleanup-wiring.ts`（窗口步骤）。
- **2-11 一起听**（`electron/senses/listen-together/host.ts`）：haiku 写笔记，点评用聊天模型。
- **2-21 她自己看一眼**（经 `electron/senses/sense-router/model.ts`）：haiku 带一张图，写一句事实。
- **I-040 看一下**（同一个 `senseAskWithClaude`）：一次性的看图判断。
- **7-4 JSON 夹带**：feed 和 sense 的小调用，模型会在 JSON 前后夹标签。本机取最后一个 JSON 对象，解析失败时功能不生效，不会泄到气泡。
- **2-26 句中的名字是不是在叫她（Unbound 第 4 步，2026-11-17）**（`electron/senses/voiceprint/name-call.ts`、`gate.ts` 的 `callsHer`）：名字在句中间、摄像头又不确定你正对屏幕时，haiku 只拿带名字的那一句判断"叫她 / 说她"。名字单独说或在句首、或正对屏幕当真时不问。同一处还把"声纹说是你、没叫名字"这件事（不带话）告诉 Unbound（`talkedNotToHer`）。测试 `tests/unbound-life-history.test.ts`，变异 `scripts/dev/mutations/unbound.json`（`talked-fact-only`、`name-middle-asks`）。
