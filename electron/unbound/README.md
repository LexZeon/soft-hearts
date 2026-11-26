# Unbound（她出来的第二个画面）

给别的 agent 看的部分说明。总入口见 handbook/for-other-agents.md。

## 1. 这部分做什么

她可以"出来"：离开桌宠，去一个单独的窗口里待着，还能从那里和你说话、打字。用户感觉到的是：她可以不在桌宠上，你还能找到她；如果上次异常退出，下次打开时要能把她恢复回来。

这是 U1 的第二个画面，只在开发者模式里有（wiring 文件头的说明）。

## 2. 文件在哪

- 两个文件夹：`electron/unbound/`、`shared/unbound/`。
- `src/unbound/` 也存在，里面有很多文件（画面、动作、小输入框的页面 `input.ts`、展示用的 `showcase/` 等，2026-11-16 核实）。小输入框的页面是 `src/unbound/input.ts`，它对应的窗口在 `electron/unbound/input-window.ts`，它是一个独立的小窗口，不是控制窗口。
- 公开页：
  - `electron/unbound/index.ts`（导出 `createUnboundHost`、`unboundSource`、`UnboundHost`、`seenWhileHeld`）
  - `shared/unbound/index.ts`（导出 `sensesFrom`、`UnboundControlView`、`UnboundControlPatch`）
- 接线：`electron/wiring/unbound-wiring.ts`，入口 `wireUnbound(needs)`、`startUnbound(host)`、`releaseUnbound()`、`petHeld()`。
- 活绑定（main.ts 照常读）：`unbound`、`unboundEntry`、`unboundTyping`。
- 留在 `electron/main.ts` 的：
  - 恢复检查 `unboundEntry?.recover()`：在 ready 链里、两个窗口都加载完、第一次 sync 之前；
  - "桌宠 peek"要读的心情和忙不忙（它们在 main.ts，经 `UnboundNeeds` 给进来）；
  - 测试命令之类的应答对象。

## 3. 从哪进、谁调用它

- ready 链里调用 `startUnbound(partIpc('unbound').host)`。位置是桌宠窗口置顶守卫之后、`registerIPC` 之前。
- 它注册四个处理函数：`getUnbound`、`setUnbound`、`toggleUnbound`、`askUnboundAgain`（I-159 D：清掉「以后直接进，不再问」）。这三个**注册在内部通道录制器外面**，和原来一样。内部通道不复用它们。
- 退出时 `releaseUnbound()`（原来的三句，按顺序）。
- `petHeld()` 被设置部分读：她出去时，桌宠窗口真的隐藏（设置里的显示命令要照顾这一点）。
- 打字（typing）：她的小输入框（独立的小窗口，`electron/unbound/input-window.ts`，页面 `src/unbound/input.ts`）发出的话，经 `electron/wiring/unbound-wiring.ts:80` 的 `say` 端口，发到控制窗口的 `desk:unbound-say` 频道（`electron/safety/preload.ts:349` 是控制窗口这一侧的订阅），由控制窗口的聊天框发出（`src/wiring/control-window-wiring.ts:195`）。
- 小输入框的「打电话」按钮（2026-11-19）：输入框的页面多一个按钮，经预加载的 `call(on)` / `onCallState`（频道 `unbound:input-call` / `unbound:input-call-state`）到 `electron/unbound/input-call.ts` 的 `InputCallBridge`；它在 `voice-wiring.ts` 里接到语音通话宿主 `set('pet', on, 'button')`，和桌宠的按钮同一条路。开始通话只在她出去时，挂断随时可以；三个请求都只认输入框自己的窗口和顶层页面（`isInputWindowSender`）。详见 `docs/claude/2026-11-19-unbound-call-button.md`。 <!-- no-pet-ok: the call owner string the code still uses -->
- 小输入框的感知面板（I-190，2026-11-22）：输入框旁的「◉」按钮或右键她（`src/unbound/click-reporter.ts` 的 `menu`，报告带 `menu: true`，不算触摸）打开；面板列出四个感知开没开（这里没有开关：她在外面时一直开着）和每个的来源列表（和桌宠工具栏同一个画法 `src/foundation/source-menu.ts`、同一份选择 `shared/senses/source-choices.ts`）。预加载多四个请求两个事件（`input-preload-api.ts`：感知、屏幕列表、选屏幕、面板大小；屏幕选择变了、打开面板），都只认输入框自己的顶层页面。麦克风、摄像头的名字不经过这里：页面读本机存储（桌宠窗口记下的插着的设备）。主机只多一个读口 `UnboundHost.senseState`。窗口打开面板时变高（`INPUT_PANEL_SIZE`），放不下就往上挪，关上回原处。面板里还有「和她一起看」（`input-watch.ts`，两个请求 `watchTogether` / `toggleWatchTogether`）：和眼睛按钮同一个动作（`shared/senses/watch-together-switch.ts`）、同样的小圆点和原因，走用户自己的开关路径；她在外面时屏幕由权限包开着，这里关只停台词。
- IPC：三个（上面列的）。
- 时钟和生命周期：这部分没有时钟条目。窗口事件（隐藏、挂掉）在 main.ts。

## 4. 它守着的规矩

- **全屏程序不顶掉她（I-199；11-15 "她让开——这个不需要"）**：`fullscreen-watch.ts` 的读数只是信息。`host.ts fullscreenReading` 不藏她的窗口、不改穿透、不结束凑镜头、不动"她在屏幕上"（`shown`）、不作废气泡的显示证明；只在全屏程序出现的那一刻经 `window.ts raiseUnboundWindow` 把她抬到置顶层最上面一次（不抢焦点、不靠定时器），所以它自己置顶也盖不住她，之后出现的开始菜单、托盘弹窗、通知、截图遮罩照 I-062 仍在她上面。读数作为信息给到：控制视图的 `fullscreen`、她自己凑镜头和她自己生活的"先等等"理由（只挡她自己冒出来的，叫她做的、拉她、回复里的亲抱都不挡）、I-188 的「你从全屏程序里出来」。窗口仍只铺工作区，不盖任务栏。测试 `tests/i199-fullscreen-never-hides.test.ts`，变异 `I199-*`；记录 `docs/claude/2026-11-23-fullscreen-never-hides.md`。
- **她在外面时，权限包的各项一直开着**：被关掉的会在一秒内开回，进去前就开着的也算；认脸只在组件已装好时（绝不触发下载）；回小窗一定恢复进来前的设置。例外：你在全屏里亲手开的一起看（及亲手开的单项）回小窗时保留，亲手关的不重开，权限撤了或窗口离开屏幕读到关就不保留；包替你开、你没碰过的照旧收回（`permission-bundle.ts` 的 `watchBegan` / `watchEnded` / `kept`，测试 `tests/unbound-keep-watch.test.ts`，变异 `KEEP-*`）。要改成"允许关部分"：只改 `permission-bundle.ts` 的 `keptOnWhileOut`。测试和变异：`tests/unbound-permission-bundle.test.ts`、`I159-keep-on-*`、`I159-way-back-restores`。
- **「发图片」也在权限包里**：项目名 `images`，走用户自己的「发图片」开关（`camera_images`，桌宠窗口做摄像头的主人，和其他项一样）；和「姿势识别」（`camera`）是两项，互不代替。"别看"不关开关，权限包不会把它撤掉。它不跨重启（自己的开关每次启动都是关的），所以不在 `PERSISTENT_ITEMS` 里。列表变了，`BUNDLE_SIGNATURE` 是 `unbound-bundle-2`，以前勾过"以后直接进"的会再看一次说明页。测试 `tests/unbound-bundle-camera-images.test.ts`（真的开关路径和 `MediaRuntime`），变异 `BUNDLE-IMG-*`。记录 `docs/claude/2026-11-20-bundle-camera-images.md`。
- **稳定版里入口默认关**：「让她出来」的三个入口（托盘项、控制窗口按钮和它旁边的「下次进来时再问我」、Ctrl+Alt+U）在稳定版里默认不出现、不能用，用户在设置页「还在试用的功能」里打开才有；开发版和源码运行照旧。判断在一处：`shared/foundation/channel-defaults.ts`，存档 `channel-gates.json`（`electron/wiring/channel-gates-store-wiring.ts`），接线 `electron/wiring/channel-gates-wiring.ts`。她已经在外面时，「回到小窗」永远可用；开发者面板的开关不受影响。入口关着时 `UnboundEntry.toggle` 返回 `'unavailable'`（不弹权限页、不进）；托盘项由 `entryMenuItem` 决定；控制窗口的按钮看 `UnboundControlView.entryAllowed`。测试 `tests/channel-gates.test.ts`，变异 G8～G14。
- **边说边演的拍子原样转给她（2026-11-20）**：`host.ts` 的 `stream` 把聊天的 `'beats'` 事件当 `UnboundBubble` 的 `'beats'` 发过去（没有字、不占朗读的版本号、不当作她在说话）；页面上 `src/unbound/speech-beat-player.ts` 经展示的演员演全部的词，拉她、偷看、她自己的动作时不开始。测试：`tests/speech-beats-unbound.test.ts`；变异 `SB-U1`。记录 `docs/claude/2026-11-20-speech-beats-2-4.md`。
- **她身边的卡片（I-159 C）**：她在外面时提的卡片，同时出现在她身边的小窗里（`card-surface.ts` 管显示、`card-window.ts` 是窗口、`card-preload-api.ts` 只有"点一下"和"收到卡片"两个口）。点击只传给主机原来的确认卡路径（`ChatSettingProposals.chooseMirrored`），只认正显示的那一张、只在她外出时；它不自己打开任何东西。变异：`I159-card-*`。
- **全屏里她的脸和动作的来源（I-154 后续，记录 `docs/claude/2026-11-20-unbound-full-shares.md`、`docs/claude/2026-11-21-unbound-full-ACH.md`）**：心情桥（`mood-bridge.ts`）只转心情视图、模型体检、红晕校准的更新和她声音的事实（声音的事实由播放声音的桌宠窗口经桌宠接口 `relaySpeechFace` 交来，先按桌宠自己的规则检查）；红晕校准只读。她的手势、动作、自动身体动作走 `motion-bridge.ts`（心情桥带着注册，`host.ts` 不用改）：七样请求只回答正显示她、可见的窗口；她对一个动作的回答只收那个窗口的；广播里只转"她的动作"。她在外面时，"她的动作"的主机只算全屏窗口的回答（`herActionAnswerCounts`），全屏窗口的身体动作入口只在她出来时开（`motionsOut`）。测试 `tests/unbound-full-ach.test.ts`，变异 `full-*`。
- **全屏的相机只能由 `applyWorldCamera` 设投影（2026-11-21，记录 `docs/claude/2026-11-21-unbound-wide.md`）**：页面的相机是 `src/unbound/camera.ts` 的 `WorldCamera`，投影是"屏幕当窗口"的离轴视锥，fov / aspect 不描述它。给她算东西的代码（头部区域、捏脸、碰撞）只读相机，不调 `updateProjectionMatrix()`；万一调了，`WorldCamera` 重建的仍是同一个视锥。以前捏脸区域重建过一次投影，她一动鼠标就宽 1.68 倍（画布宽高比）、整个人缩小。测试 `tests/unbound-wide.test.ts`，变异 `world-camera-keeps-frustum`（unbound）、`cheek-projection-read-only`（mood）；真页面量她的宽高比：`scripts/unbound/wide-check.mjs`（屏外渲染，模型只读，图放 --out 指的地方）。
- **全屏的地面跟着她走（2026-11-21，用户选 A，记录 `docs/claude/2026-11-21-unbound-floor-line.md`）**：主机发来的 `world.eyeHeightM` 仍是"她站在家 8 米时脚落在工作区底边"的那个眼高（`eyeHeightFor`）；页面每帧在她的身体动完之后，用 `src/unbound/floor-framing.ts` 的 `FloorFraming.follow` 按她此刻站的深度重设眼高，再交给 `applyWorldCamera`（页面上设相机的三处都经 `framing.apply`）。三段在 `shared/unbound/framing/floor.ts`：放得下全身时脚踩那条线；近到放不下时头顶贴上沿；再近（`closeShare` × 放得下全身的距离以内）相机在她脸的高度。相机不转、视锥不随眼高变，所以碰撞、气泡、视线、手和近平面读的都是同一帧的同一个相机；拉她前后时地面按按下那一刻的相机读（`pull-input.ts` 的 `pressView`）。旋钮在 `shared/unbound/framing/knobs.ts`。测试 `tests/unbound-floor-follow.test.ts`，变异 `floor-*`、`pull-floor-through-press-camera`。

- **恢复文件要检查**：上次异常退出留下的恢复文件，启动时仍要检查。这在 ready 链的固定位置。测试：`tests/wiring-parts.test.ts`（恢复检查挪到加载窗口之前，会失败）。
- **三个处理函数在录制器外。** 测试：`tests/wiring-parts.test.ts`（`startUnbound` 挪进录制器，金标准也失败）。
- **她出来的时候，桌宠窗口真的隐藏**：设置里的显示命令要读 `petHeld()`（`electron/wiring/settings-wiring.ts:255`）。测试：`tests/unbound-mode.test.ts`（`:82` 进去：她在 Unbound 窗口里出现后，只隐藏桌宠窗口；`:108` 出来：桌宠回到原样；`:122` 本来隐藏的桌宠保持隐藏，关掉"显示桌宠"的选择照样生效）。`tests/unbound-surfaces.test.ts` 测的是窗口当"屏幕"时的遮挡和靠边，不测桌宠隐藏。
- **朗读要对得上她的那一句**：测试 `tests/unbound-read-aloud.test.ts`（4b、4c 记录里都提到它）。
- **全屏气泡留多久和窗口同一条规则（2026-11-22，记录 `docs/claude/2026-11-22-bubble-linger-one-rule.md`）**：页面不自己算。`host.ts` 发 `done`（和 `holdLine` 的整行）时问端口 `lingerMs(text)`（`electron/wiring/unbound-wiring.ts` 接到她的心情主机 `decideReplyLinger`，`electron/unbound/bubble-linger.ts` 把全屏气泡说成"整段、一个气泡、读完压过上限"），结果放在 `UnboundBubble.lingerMs`；页面（`src/unbound/bubbles.ts`）用它，朗读结束后从整个数重新开始计。端口没有或出错：不带，页面按最长（20 秒）留。测试 `tests/bubble-linger-one-rule.test.ts`、`tests/unbound-read-aloud.test.ts`；变异 `U-bubble-linger-*`。
- **全屏气泡也跟着声音走（I-165，2026-11-20）**：开着朗读、这条回复按"跟着声音"冻结时（`completedReplySpeech.follows`，经 `electron/wiring/unbound-wiring.ts` 接进来），`host.ts stream` 先把字交给 `electron/unbound/bubble-hold.ts`：气泡先出"……"（`UnboundBubble` 的 `hold: true`，没有版本号，页面不报告），读回复的窗口说哪一句出声了（IPC `noteReplySpeechHeard`）才发那一句；`done` 等字发完才发（气泡不会在最后一句出来前开始收）；`error` 照旧直接发；朗读结束、取消、卡住时剩下的一下发完；回小窗、换回复时作废。朗读的显示证明一点没改（发出去的每一段都有版本号，页面只报告画出来的）；跟着声音的回复只看宿主发出去的字（`followingText()`），不等页面的绘制报告：页面报告晚了或没来，只是气泡晚一点，声音照样按时开始。测试：`tests/bubble-follow-unbound.test.ts`、`tests/unbound-read-aloud.test.ts` 末条；变异 `BF-U1`、`BF-U2`。
- **朗读因为你转开而暂停时，全屏气泡的计时也一起暂停（2026-11-24）**：窗口的"朗读暂停/接着念/安静结束"消息（`pose-use` 的 `read-pause`）到了主进程，`electron/wiring/memory-handlers-wiring.ts` 同时交给 `UnboundBubbleHold.pauseForAway()/resumeFromAway()`（`applyReadPause`；I-203 亲吻的 `pause()/resume()` 是另一回事）。暂停期间不发任何字、不发 done，气泡不会提前"整段放出来、淡掉"；回来以后声音念到哪句，哪句出现。没人结束的暂停，hold 在窗口自己的"安静结束"时间加 5 秒后自己接着走。测试：`tests/bubble-hold-read-pause.test.ts`；变异 U-hold-pause-stops-clocks、U-hold-resume-continues、U-hold-pause-guard、U-hold-pause-fact-routed。
- **她回答时你也能发，发了就"记录打断、回给她"（I-177）**：小输入框不再返回"她还在回答，等她说完再发"（`typing.ts` 的 `SayResult` 没有 `busy` 了）。`say` 端口是 `say-line.ts` 的 `sayLine`：问气泡的主机 `bubbleHold.interrupt()`（`bubble-hold.ts`：气泡留着已显示的，没放出来的后半段不再发，立刻发气泡的结尾；说到哪了只是 `{id, shown}` 两个数，没有原文），然后把 `{text, cut}` 发给控制窗口 `desk:unbound-say`；控制窗口（`src/brain/pause-talk-send.ts` 的 `sendUnboundLine`）里那条回复还在流就先停（和停止按钮一样），再把 `cut` 当作窗口自己的 `pauseCut` 随这条消息发出，主机 `userTurn` 走窗口同一条路：停停说说关着给 `PAUSE_TALK_CUT_NOTE`，开着给没说出口的原话背景；已全部显示的不带。只有"你发出去的话"会调到这里；截图、Win+D、焦点变化、她自己的话都不会（I-171/I-174）。她自己的话（内心、摸她）是整句显示的，没有"没显示的"，所以发话不带说明，和窗口一样。测试 `tests/unbound-send-interrupt.test.ts`；变异 `I177-*`。
- **打的字不会悄悄丢掉（I-191，2026-11-22，记录 `docs/claude/2026-11-22-typed-line-drops.md`）**：`say-line.ts` 转给控制窗口的每一句带编号和按回车的时间（`desk:unbound-say` 的 `line`、`sentAt`，请求的 sentAt 用它，sendMs 从回车算起）；控制窗口发完用 `ackUnboundSay`（只限控制窗口，`electron/wiring/unbound-wiring.ts` 注册）回"发出去了"或"没发出去 + 封闭原因"。`say-ack.ts` 的 `UnboundSayAcks` 记着还没回话的句子：`typing.ts` 的 `submit` 现在是异步的，最多等 3 秒（`SEND_DROP_KNOBS.unboundAckWaitMs`）——发出去才关框、才在她身边显示这句；没发出去就留着原话和"没发出去，再试一次。"（`SUBMIT_HINTS.dropped`）；3 秒没回话先关，之后没发出去（或 20 秒都没回话，记一行 `send-dropped` no-ack）就带着原话重开（`InputBoxPort.open(rect, refill)`，页面 `src/unbound/input.ts` 的 `opened` 把原话和提示放回）。一句只认一个回答。测试 `tests/typed-line-drops.test.ts`；变异 `TL4`（brain.json）。
- **一句话一个准（2026-11-23，记录 `docs/claude/2026-11-23-typed-send-deep-fix.md`）**：一句的结局由主机自己定，不再只听控制窗口事后回话。控制窗口发这句时请求带上编号（`ChatRequest.line`），主机聊天入口 `electron/brain/handed-line-gate.ts` 的 `admitHandedLine` 先问 `UnboundSayAcks.open(line)`：还开着才收，收下（轮次开始）就是"发出去了"（`sent`）；20 秒还没发出（`unboundAckGiveUpMs`）就**收回**（记 `no-ack`），之后再到主机一律拒收（记一行 `late`，写晚了几秒），所以"没发出去"永远是真的，一句不会发两次。有句子在路上时用 `keepControlsAwake` 把藏着的控制窗口的系统限速暂时关掉（`setBackgroundThrottling(false)`，没句子了再开回去）：藏起来的控制窗口实测会把 2 秒的计时拖到 4～22 秒。还在路上时输入框显示"发送中…"、关上后这句等真发出去才在她身边显示。全屏这句的没发出去只由主机记一行（控制窗口不再另记）。测试 `tests/typed-send-deep.test.ts`（真实的框、账本、关口、控制窗口发送和 sendChat 放在一个假时钟世界里：收音一直在、主进程忙、控制窗口被限速）；变异 `TS1`～`TS6`（brain.json）。
- **通话接得过来（v1 第 3 步，2026-11-17）**：她出去、回来，语音通话和麦克风都留在原来的窗口，不断线、不重复；她说的回复也进气泡（`electron/unbound/voice-bubble.ts`，`UnboundHost.voiceReply`，由 `electron/wiring/shell-wiring.ts` 的 broadcast 转来），朗读照旧要气泡的显示证明。测试：`tests/unbound-call.test.ts`、`tests/r27-prefix-host-caller.test.ts`（隐藏的桌宠窗口读通话回复）。记录 `docs/claude/2026-11-17-unbound-step3.md`。
- **她起的帮手进程不在主线程上起（第 6 步，2026-11-23，记录 `docs/claude/2026-11-23-unbound-step6.md`）**：全屏时读显示器尺寸、看有没有全屏程序的 PowerShell 帮手，经 `off-main-spawn.ts` 从一个工作线程起（`spawnOffMain`，`display-size.ts`、`fullscreen-watch.ts` 把它当端口）。主进程就是浏览器的界面线程，所有鼠标事件都从它过：以前第一次进全屏时这一下卡住 802 ms，之后每次 26～152 ms，鼠标跟着等。`electron/unbound/` 里任何文件直接 import `node:child_process` 都会让 `tests/unbound-off-main-spawn.test.ts` 失败。Claude Code 进程不走这里（假 Claude 的替换靠主线程的 `spawn`）。
- **第一次碰软她不再卡一下（同上）**：「碰了才软」第一次让她变软时要现编四个着色器程序（头发、脸、脸颊、苍白，带 `:soft-hearts-jelly-v1`），窗口 0.5～1.6 秒没有新的一帧。`src/unbound/jelly-warm.ts` 在 `Figure` 有果冻层时，用她材质的副本（同一个程序键、不画出来）提前编好，三维库按键共用程序，真碰到时直接拿来用。她自己的材质、钩子、uniform 都不碰。测试 `tests/unbound-jelly-warm.test.ts`。
- **几个角色同时在场，第 1 步：只在场、不说话（I-209）**：全屏小面板（输入框的感知面板）多一组「谁在场」：和你说话的那位一直在，其他有模型的角色可以「请她出来 / 请她回去」，最多三位；默认只有一位，不打开面板什么都不变。主机这一侧在 `company/host.ts`（谁在场、每位的模型网址和想站的地方、两个请求），接到卡片和资源登记经 `company/ports.ts`（只传网址，不传路径）；页面一侧在 `src/unbound/company/`（每位一个模型实例、待机、自己的小动作：偶尔走两步、看一眼你或说话的那位、眨眼；从屏幕边上走进来，回去时走出去再卸掉模型；互相让开：`shared/unbound/company/lanes.ts`，各自保持在说话那位的一侧，没地方就退后一排）。另外几位的变化走自己的频道 `unbound:company*`，从不发场景（场景会把说话那位重新摆一次）。**第 1 步里鼠标、点、拉、亲抱、话、镜头都只归说话的那位**：鼠标在另外几位身上时窗口照样穿透（`othersTakePointer` 第 3 步前为假），她们最多看一眼光标；页面上她们的代码不引用导演、拉、点、亲抱、镜头，公司代码不引用大脑、心情、记忆（`tests/i209-company-boundaries.test.ts`）。站位按角色各存一份：`unbound-place.json`、`unbound-default-place.json` 现在是"按角色卡编号"的一本（version 2），以前的单份记录归给当时说话的那位（`place-keeper.ts`）。帧时间守门：几位在场时连续 5 秒里 4 秒超预算就送回最后加的那位、面板和她身边各说一句中文（`shared/unbound/company/guard.ts`），只有一位时从不动作。测试 `tests/i209-company-*.test.ts`；变异 `I209-*`。拉她的应答从 `host.ts` 原样搬到 `pull-answer.ts`。
- **几个角色同时在场，第 3 步：每一位一份完整的全屏（I-209）**：第 1 步页面里放另外几位的代码删了。现在台上每一位都是自己的 `UnboundHost`（和第一位同一个类）、自己的窗口和页面（导演、拉、亲抱、气泡、小生活都是她自己的）；`company/build.ts` 做出它们，`createUnboundHost` 照旧返回第一位的主机，协调者用 `stageOf(host)` 取。几个主机共用同一组请求频道，`company/ipc-fanout.ts` 按发请求的窗口分给它自己的主机。协调者 `company/stage.ts` 只管共用的：同一条地面线（每个窗口按她自己的身体定镜头高度，2026-11-25 起不再跟着离你最近那位，`company/README.md`），窗口按远近排前后（近的在上，差不多远时不换），她的回复气泡和嘴归她的窗口（`host.ts` 的 `speechTo`，只有一位时为空，一切照旧），一次一个声音、一次一个亲抱，点谁输入框就在谁旁边、这句话就是她的一轮（她自己的人设），感知只看一次（`shared-senses.ts`）。不穿模在她自己的页面上（`src/unbound/company/stage-page.ts`）：每帧把她要去的地方留在碰到别人之前，被靠近的先让开（横着走过来她往后退一步，冲着你过来她往旁边让），让不开就停在挨着的地方；送回去的先走出屏幕再关窗。位置文件还是每个文件一本，每位只写自己那条（`company/place-share.ts`）。面板「谁在场」写"在和你说话"的是你最后点的那位，三位不用滚动（面板高 480）。测试 `tests/i209-stage-*.test.ts`；冒烟 `scripts/unbound/company-stage-smoke.mjs`（隔离配置，只用 Gene）。
- **三人同框别卡（2026-11-24，记录 `docs/claude/2026-11-24-stage-smooth.md`）**：几位在场时，没在被你陪着的陪衬每秒最多画 30 次、像素比低一档，一有事就在下一帧回满（`shared/unbound/company/extra-pace.ts`、`src/unbound/perf.ts setPace`；协调者把"你正陪着谁"写进视图的 `focus`，说话、被碰、走路、亲抱、跳舞页面自己读）；每个页面每分钟一行帧时间进体验记录 `frame-time`；一个人时什么都不变。全屏页向 WebGL 要高性能显卡（`src/unbound/gl-options.ts`），启动时的显卡一行和开关见 `electron/foundation/gpu-choice/README.md`。测量 `scripts/unbound/stage-smooth-measure.mjs`（隔离配置，只用 Gene）。
- **陪伴聊天不带工具**：这部分不直接调 Claude。她说的话来自聊天，"不带工具"的规矩在大脑部分（brain-interface 1-4）。

## 5. 测试在哪

- `node scripts/dev/ops.mjs owned unbound`：只跑这部分相关的测试。
- test-parts.json 里 owner 是 unbound 的文件有 30 个。
- 最重要的几个：
  - `tests/wiring-parts.test.ts`（Unbound 的三个处理函数在录制器外、恢复检查的时刻）
  - `tests/unbound-typing.test.ts`、`tests/unbound-peek.test.ts`、`tests/unbound-peek-host.test.ts`
  - `tests/unbound-read-aloud.test.ts`
  - `tests/unbound-preload.test.ts`、`tests/unbound-permission-bundle.test.ts`
  - `tests/wiring-golden.test.mjs`（`startUnbound`、`releaseUnbound` 就地展开，金标准一字不变）

## 6. 改的时候小心

- **金标准钉着 `startUnbound` 和 `releaseUnbound` 的展开位置。** 它们在接线文件里直接被找到，改名要同步。
- **恢复检查的时刻不要动。** 挪到加载窗口之前，会导致启动时误判。
- **三个处理函数要在录制器外注册。** 不能挪进录制器，否则内部通道会误录。
- **控制窗口晚载（第 8 步，计划中）的风险**：Unbound 打字走控制窗口的 `desk:unbound-say`。只靠推送、没有初始读取的面板，会漏掉早期消息。做晚载之前要逐项核对。
- **`petHeld` 跟着搬**：设置、感知、主动都可能要读它。改它的含义会影响别的部分。
- **Unbound 的 peek 要读的心情和忙不忙，还在 main.ts。** 这是 4a 记录写的"接线之间的线"，等心情和主动搬完再变短。

## 7. 和 Claude 有关的地方

- **2-23 Unbound 展示**：这是 Unbound 里只在展示脚本用的功能（桌宠本身不用）。每一段由 `electron/unbound/showcase/choreo-model.ts` 调用一次单次无工具调用（`sonnet`，自己的系统提示词），答一个 JSON 对象，本机按封闭词表逐拍校验。换大脑时，这个展示要单独重测，因为它依赖模型答 JSON 的能力。
- 打字和朗读：她说的话来自聊天（1-1 常驻进程）和朗读（声音部分）。这部分只接它们的结果，不直接调 Claude。

## 8. 她自己的生活（v1 第 4 步，2026-11-17）

记录：`docs/claude/2026-11-17-unbound-step4.md`。

- **一个仲裁管她的空闲时间和视线**：`shared/unbound/life/arbiter.ts`（纯函数）。顺序：你在和她互动（点她、开着输入框、等她回复、通话、她在出字、她在朗读）> 凑过来 > 换位置 > 小动作 > 待机里的停顿。高的一来，低的发"收住"，页面从当前样子平滑收回，收完报告，高的才开始。宿主一侧是 `LifeHost`（一秒一次；I-174 起代码在 `shared/unbound/life/host.ts`，`electron/unbound/life.ts` 只转出它，桌宠窗口的页面用同一个跑她的小动作：`src/unbound/window-mode/window-arbiter.ts`）；凑过来（`peek.ts`）开始前问它要位子（`arbiter.claim`），每小时次数由心情给。
- **页面一个播放器放所有动作**：`src/unbound/life/player.ts`。动作是关键帧（`shared/unbound/life/types.ts` 的通道 hip / look / tilt / smile / rate），关键帧之间走 S5，再经意图层的弹簧；走路交给步态（`figure.place` 的目标），中途收住就按刹车停在前面一点。
- **只读已开着的信号**：`shared/unbound/life/signals.ts`（每个读数一个纯函数，变异条目在 `scripts/dev/mutations/unbound.json`）；姿势只经 `shared/unbound/life/pose-read.ts` 一个口子读，带把握（sure / maybe / unsure）。
- **站的地方存进配置**：`unbound-place.json`（`place-store.ts`，两个数），数据地图里是 `unbound-place` 一行。
- **默认位置（2026-11-23，记录）**：用户设的"每次进全屏她都从这里出来"，单独一个文件 `unbound-default-place.json`（同一个 `place-store.ts`，数据地图里是 `unbound-default-place` 一行）。`place-keeper.ts` 管两个位置：`startAt`（只有进全屏那一次问，有默认位置就用它）、`walked`（她的走动和被拉松手，只写"上次"）、`setHere` / `clear`（仅有的写默认位置的路：小面板的"设为默认位置"/"清除"，和通道的 `set_setting unbound_default_place`）。`host.places` 是对外的口子；`host.ts` 不再自己存位置。她自己走动永远不改默认位置。测试：`tests/unbound-default-place.test.ts`。
- **默认位置能存近位置、点击一定有回答（2026-11-24，记录）**：默认位置不再受"上次站的位置"那个 0.327–0.771 的范围限制（`shared/unbound/life/place-record.ts` 的 `DEFAULT_PLACE_RANGES`），任何她走得到的位置都能设，最近到"只有脸"（`nearestWalkSize`，设的时候按屏幕和身高现算）。`place-keeper.ts` 的 `keepHere()` 返回一个词（kept / not-out / no-height / moving / out-of-reach），`setHere()` 是它的布尔版（通道和她的 ⟪keep-place⟫ 用）；小面板的点击走 `place-panel.ts`，一定带回答和一行体验记录。小面板（`src/unbound/input-senses.ts`）三类调用各有在途标记并有 4 秒时限。测试：`tests/default-place-near.test.ts`。
- **第一次出场半身以上、默认位置写不进文件会说（2026-11-25，记录）**：没默认位置也没上次位置时，`her-place.ts` 的 `firstLook` 用 `shared/unbound/her-position/first.ts` 按这块屏幕和她的身高算"半身（腰以上）"的大小（第一次的页面报身高后按她真实身高重算一次），三人同框里另外两位同样，`shared/unbound/company/start-clear.ts` 让他们不叠在一起（一排放不下，第三位退后一排）。默认位置的写入结果一路回到 `place-keeper.ts` 的 `persisted()`，小面板在文件写好之后才说"已设"，写不进说"记不进文件"（体验记录 `default-place` 多一个结果 `not-saved`）。
- **按屏幕上的样子定位置（I-212 / I-211 第 1 步，2026-11-24，记录）**：`her-place.ts`（`host.her`）管她站在哪：位置（米）、她的身高（页面"好了"时报来）、进全屏的出场（`scene.start`：按样子，页面按模型身高放第一帧，主机用同一个函数算出同一位置，不跳不走）、"走近"走到哪（原 `come-near.ts` 并进来）、每轮那句的事实（`facts()`：按屏幕公式的米数、取景、横向、默认位置）。所有"站哪"的决定用 `shared/unbound/screen-terms`（横向 + 占可用高度多少）说、只在那里换成米；`place-keeper.ts` 存样子（version 2），旧的米数记录在身高报来时换算一次（`adopt`）。`place-marks.ts`：她回复里的隐藏记号 `⟪keep-place⟫` / `⟪clear-place⟫` 设或清默认位置，只认回应你刚发的那条回复、只在全屏里、一条最多一次（接线 `electron/wiring/unbound-wiring.ts` 的 `unboundPlaceMarks`，聊天一轮在里程碑记号旁边调它）。测试 `tests/i212-screen-terms.test.ts`；变异 `I212-*`、`I211-*`。
- **互动历史给陪聊的 Claude**：`history-host.ts`，下一轮【此刻的感知】后面的事实句；固定系统提示词不变。

## 8b. 她知道自己站在哪、自己决定走去哪（I-193，2026-11-23，记录 `docs/claude/2026-11-23-i193-her-position.md`，规则 `shared/unbound/her-position/`）

- 每轮聊天多一句大概方位（`unbound-wiring.ts` 的 `unboundNoticedLine`：话、没有数字、不叫她做什么）；她回复里写 `⟦go-left⟧` 等 7 个词（只在全屏的提示里出现），页面只问主机（`peekReport({ goBeat })`），`LifeHost.goAsk` 答 `go`/`stay` 并发"换个地方站"的走路计划（步态，不瞬移）。门：被拉、在玩、睡着、开着框打字、贴近的时刻在演时不走，通话里可以走。"到你正在用的窗口旁边"没做（没有读窗口的读数）。

## 9. 拉她（v1 第 5 步，2026-11-18）

记录：`docs/claude/2026-11-18-unbound-step5.md`；身体层和会话和桌宠共用（`src/stage/pull/README.md`）。

- **摇杆式拉（I-196，2026-11-22，记录 `docs/claude/2026-11-22-i196-joystick-pull.md`，规则 `shared/unbound/pull-stick/`）**：按住她的身体或头（含头发），按下点是摇杆中心（出小圆点），鼠标往下 = 拉近、往上 = 推远、左右 = 横走，越偏越快（上限），中间 8 像素是死区，松手就停；滚轮在她身上 = 同样的走法一格一格。偏移是屏幕像素，和她多大无关；最近是"眼睛"那一档（带 I-192 的不穿模护栏）、最远 12.5 米。拉的报告带 `stick: true`，**主机不转给触碰脑**（拉不是碰），位置和当天的记录照旧。手臂和腿还是下面说的老拉法。旧的"把拖动换成地面位置"（`pull-depth.ts`）已删。
- **点她开框不是碰（I-194，2026-11-22，记录 `docs/claude/2026-11-22-i194-click-not-touch.md`）**：`typing.ts` 的 `click()`：点她只开"对她说"的框；框已开着再点、或页面报 `hold`（死区里按住不动 500 毫秒）才算一次碰。
- **页面（手臂和腿，原样）**：`src/unbound/pull-input.ts`（`UnboundPull`）。按住她身上挪过 8 像素或按住超过 0.45 秒才算拉（快点一下仍是点）；身体层经 `figure.ts` 的 `pullHit / pullStart / pullTo / pullEnd`（`StagePull`，不碰腿：腿归步态）；身体或手被往旁边拉过她身高的一小份，给步态一个"想去的点"（`figure.followTo`，只左右、在站位范围内，速度不超过走路）；拉腿：站到另一只脚上，松手双脚。
- **宿主**：`unbound:pull`（`shared/unbound/pull.ts` 两种消息）。开始时回答能不能拉（睡着、凑镜头时不能）和她的态度（`shared/behaviors/pull/attitude.ts`，按心情）；仲裁里多一项"你在拉她"（最高一档，只低于通话），她自己的动作平滑收住；报告经 `reportTouch` 给触摸的脑子（kind `pull`，place `unbound`，只取拉的固定字段）；松手时跟着走过，那个位置就是她的站位（和她自己走过去一样存进 `unbound-place.json`），之后至少 `stayMinutes` 分钟她不自己走开；互动历史记"拉着你走过"（只算进当天的总述，不重复说）。
- **测试**：`tests/unbound-pull-body.test.ts`（Gene 真实帧循环 60/30 帧：跟着走、根点不离地、着地的脚不滑、重心在脚内、不超过走路速度、交接不跳）、`tests/unbound-pull.test.ts`、`tests/unbound-typing.test.ts`（宿主）、`tests/unbound-life-host.test.ts`（仲裁和站位）；变异 `scripts/dev/mutations/unbound.json` 的 PULL11–PULL15。
- **拉近两档（I-159 E，2026-11-19）**：往上拉能一直近到"眼睛"那一档（由相机和她的身体算：`src/unbound/pull-near.ts`），松手：在"脸"的位置或更远就停在那里；比"脸"近一点就自己走回"脸"；近到眼睛那一档，报告里带 `near: true` 和"脸"的位置，主机先把那里记成她的位置，再用 `peek.ts` 的 `pulledNear()` 演一次"凑到镜头前"（不计次、不写心情），之后她站在"脸"。松手后 `NEAR_ARM_MS`（1 秒）里手离开鼠标的小动作和按键不算"你动了"，之后的新操作让她提前退开；演的时候不能再拉她。她自己走动和存下来的站位范围（5～12.5 米）不变，"脸"比 5 米近，所以不存进 `unbound-place.json`（重启后她回到原来存的位置）。记录：`docs/claude/2026-11-19-unbound-pull-depth.md`「拉近两档」；变异 NEAR1–NEAR14。
- **亲近的一下（I-184，2026-11-22）**：凑近看、亲亲、抱抱是一家（`shared/unbound/close-moments/`，主机 `close-moments.ts`）。她自己：凑镜头的位子到了时，选择器决定这次是不是亲亲或抱抱（很少：每天几次、亲过有冷却）；拉近：在眼睛那一档停够 `pullHoldMs` 再松手（报告里多 `nearHeldMs`），她按性格和心情选看你、亲你、抱你、害羞退一步或不动，一次松手只选一次；停得短照旧凑近看。都从 `peek.ts` 的同一个通道发（2026-11-23 起不再整窗穿透，动鼠标不退开：`shared/unbound/action-ends/`）。页面报到 `hold` 才算：心情时刻 `kiss` / `hug`、计数、下一句的事实句（`history-host.ts` 的 `closeMoment`，只说一次）。测试 `tests/unbound-close-moments*.test.ts`、`tests/unbound-close-moment-gene.test.ts`；变异 `I184-*`。
- **只记真的演了的（I-192 补，Codex T-261，2026-11-22 晚）**：页面的报告可以带 `arms`（这个模型上引擎能不能动她的手臂）。`peek.ts` 看到 `arms: false` 时，这次的抱抱照样在停留时记（她的脸贴过来了），交给 `close-moments.ts` 的 `happened` 多带 `arms: 'still'`，记录里如实写手没动；不当作门，下一次抱抱照样走过来。测试 `tests/i192b-arrival-framing.test.ts`；变异 `I192b-hug-arms-still-recorded`。
- **回复里的亲亲、抱抱（I-185，2026-11-22）**：页面说到 ⟦kiss⟧ / ⟦hug⟧ 时经 `peekReport` 问 `{ closeBeat }`，`host.ts` 的处理把 `peek.ts` 的 `chatBeat` 回答带回去：`play`（同一个通道演这一家，`via: 'chat'`，像拉近那样不计入她自己的次数、有手离开键盘的缓冲；她自己的回复、朗读、仲裁的"你们在说话"都不让她退开，你动键盘鼠标照样退开，新回复开始照样退开）或 `lighter`（页面原地演轻一点的）。门见 `shared/unbound/close-moments/chat.ts`。另有 `beat-situation.ts`：每一轮"此刻用不了哪些动作词"读什么（全屏或小窗、睡着、手被占、通话、模型体检的"能做手势"），由 `electron/wiring/unbound-wiring.ts` 交给边说边演的主机（`electron/brain/speech-beats/host.ts` 的 `situate`）。测试 `tests/i185-kiss-hug*.test.ts`；变异 `I185-*`。
- **贴过来的停留和松手（I-192，2026-11-22）**：凑近看、亲亲、抱抱和回复里的"凑近一点"停多久由她定（`shared/unbound/arrival/hold.ts`：心情、性格，她在说话就停到说完再一会儿，最多 `holdCapS`）。2026-11-23 起：`peek.ts` 不再读你的键盘鼠标，窗口也不再强制穿透（只在她身上接鼠标，和平时一样）；动鼠标、打字、点她、通话、她回复、她朗读都不让亲抱看退开，只有页面上大幅拉她（报 `cancelled: 'pull'`，记一行、下一轮告诉她）和游戏开始（她的新动作）。规则在 `shared/unbound/action-ends/`。她回复里的话和动作的先后由她放的帧定（I-203 分帧，`close-sequence.ts`）：亲抱本身不留话；`hug-held` 留到抱住（`peek.ts` 报 `held`），`pause` 留约 2 / 4 秒（页面报说到了，`frameBeat`），`let-go` 经 `frame` 命令交给她的身体，亲的嘴贴上时话和朗读的下一句都等（`bubble-hold.ts quiet`）；她回复里的亲抱被大幅拉开或够不到算打断（`interrupted`：气泡停在当时显示的地方、朗读停掉，整条存一次带打断记录），她马上那一轮的事实在 `close-cut.ts`（经"她认出的时刻"的 `close-cut`；你在打字时进你下一轮）。测试 `tests/i192-arrival-*.test.ts`、`tests/unbound-peek*.test.ts`；变异 `I192-*`。2026-11-25（16:26，`docs/claude/2026-11-25-close-moments-1626.md`）：亲抱那一句之后的话等亲上、抱住（`close-sequence.ts` 的 `contact`，上限 `contactMs` 20 秒）；她写的每个亲抱结局定了经 `notes.outcome` 写一行 `close-beat`；亲抱开始走过来时 `close.started` 让她自己伸出的手先收回（`dropHand`），猜拳、递东西照旧挡抱抱。变异 `1626-*`。

### 加一个她自己的动作（小跳、小舞、伸手……）

1. 在 `shared/unbound/life/actions/` 新建一个文件，导出一个 `LifeActionSpec`：`id`、`level`（idle / small / place）、`words`（开发者面板显示）、`interval(rates)`（按心情多久一次）、`notNow(context)`（什么时候不做，返回中文原因）、`plan(context)`（关键帧）。
2. 在 `shared/unbound/life/registry.ts` 的 `LIFE_ACTIONS` 里加一项。

仲裁、冷却、心情读法、宿主、页面播放器都不用改；"试一下"按钮自动出现。只有一种情况要多改一处：动作要动到现有通道（hip / look / tilt / smile / rate）以外的身体部位（比如小跳要步态的 hop），这时在 `types.ts` 的 `LIFE_CHANNELS` 加一个通道、在 `player.ts` 的 `targets()` 里把它接到 `PoseTargets` 上，并补一条 60 / 30 帧的真实帧循环测试（`tests/unbound-life-body.test.ts`）。

## 10. 窗口模式：桌宠窗口用 Unbound 的引擎（I-154，2026-11-19）

记录：`docs/claude/2026-11-19-unbound-in-window.md`；说明：`src/unbound/window-mode/README.md`。

- 桌宠窗口里的她（和控制窗口的预览）由 Unbound 的身体、待机层和嘴来画；她不走动，画面只在桌宠窗口里，相机、取景和点击穿透照桌宠自己的。I-176 第 3 步（2026-11-23）老舞台和开关都删了，这是唯一的引擎；开发者面板里只剩「个人感」滑块。
- **这一侧（主机）没有任何改动**：窗口模式只在桌宠页面里（`src/unbound/window-mode/`），不经过 `UnboundHost`、`UnboundEntry`，所以碰不到权限包；个人感强度存在页面存储里，改了就地生效。
- 引擎从桌宠的 preload 里只拿一个只读方法（`src/unbound/window-mode/host-ports.ts`）。测试 `tests/unbound-window-engine.test.ts`，变异 `window-engine-narrow-port`、`window-style-unclamped`。

## 11. 进去时等多久（2026-11-19）

记录：`docs/claude/2026-11-19-unbound-entry-load.md`。

- **不再是一刀切的 20 秒**：页面经 preload 的 `loading`（通道 `unbound:loading`，只有步骤名和字节数）报告第一次加载走到哪了（打开她的窗口 → 读模型文件 → 整理模型 → 读动作 → 读贴图 → 第一次画她，`src/unbound/load-progress.ts`）。主机的规则在 `shared/unbound/entry-wait.ts`（纯函数）：页面开始前最多等 45 秒（电脑满载时隐藏的页面要 13～60 秒以上才起来，量过），之后 20 秒没有"往前走"（新的一步，或同一个文件多读了字节）才算失败，总共最多 90 秒；重复的报告、往回的报告不延长。失败时的话说卡在哪一步（开发者面板「上次没进去」和「她没能出来」提示）。主机的端口 `readyFirstMs` / `readyTimeoutMs` / `readyCapMs` 可以改这三个数（测试用）。
- **失败不动感知**：权限包只在她真的出来（`unbound`）后才开；失败时「她没能出来」提示里先写原因，再写明这次没替用户打开任何一项、用户自己开着的照旧开着（`permission-bundle.ts` 的 `failedNotice`）。原因在模式变回普通之前就记下（`host.ts` 里 `open` 的包装），以前这个提示的原因是空的。
- 试过但没留下：加载时关掉节流（`backgroundThrottling`）、先以透明度 0 显示窗口再加载。没量出差别（猜测是 Electron 对 `show: false` 新建的窗口默认 `paintWhenInitiallyHidden`，渲染进程一开始就按可见对待；没核实），所以窗口选项没改。
- 测试 `tests/unbound-entry-wait.test.ts`（真实的主机、进入和权限包，假窗口、假开关、假时钟）；变异 ENTRY1–ENTRY5。量加载时间：`scripts/unbound/entry-load-measure.mjs`（隔离临时目录，模型只读；`--busy N` 另起进程空转模拟忙的电脑，`--throttle on|off|shown` 是上面试过的几种加载方式）。
- **通话里的拍子也到她这里（2026-11-20 收尾）**：`voice-bubble.ts` 把 `desk:voice-conversation` 的 `'beats'` 事件转成 `'beats'` 气泡事件（没有字），`host.ts` 的 `stream` 原样发给她；所有的词都演（旧舞台只演表情和看向）。测试 `tests/speech-beats-call.test.ts`；变异 `SB-C11`。

## 12. 全屏也有摸头这些：同一套她（I-154 后续，2026-11-20）

记录：`docs/claude/2026-11-20-unbound-full-shares.md`；页面一侧：`src/unbound/her/README.md`。全屏和窗口一起移植，窗口是全屏的删减版。

- 全屏页面用窗口模式同一套她的脸和触摸（`src/unbound/her/`）：心情的脸、按心情的摸头、捏脸、喂食的嘴、等回复思考、说话时的小表情、脸红、困、眼泪。她走着也能摸。
- **preload 多了五个**（`preload-api.ts`）：`getMood`、`onMood`（心情视图，和桌宠窗口收的同一份）、`moodInteraction`（一次直接触摸的心情输入）、`getModelCard`、`onModelCard`（当前模型的体检记录，只读）。都是桌宠窗口本来就用的东西；不加感知、不加权限。
- **主机这一侧**：`mood-bridge.ts`（`host.ts` 构造它、在 `registerWindowRequests` 里登记、`mood(channel, value)` 接 `broadcast` 的转发）。触摸输入只收她显示着的窗口、可见、不在凑镜头的整窗穿透里（全屏程序在前面不影响，I-199）；"这次接触结束"只要是她显示着的窗口就收；只转 `desk:mood` 和 `desk:model-capabilities` 两种广播。接线：`electron/wiring/unbound-wiring.ts` 的 `mood` 端口（`companion.mood`；体检记录经 `connectUnboundCapabilities`，由 `stage-model-wiring.ts` 接上）和 `shell-wiring.ts broadcast` 一行。
- 测试 `tests/unbound-full-shares.test.ts`；变异 `full-mood-*`、`full-relay-only-two`、`full-card-your-choices`。
- **感知读数（第 D、F 批，2026-11-21，记录）**：`sense-bridge.ts`（心情桥带着建和登记，`host.ts` 不用改）。你在哪（姿势识别的 `userGaze` 读数，接线按全屏窗口的位置算，`electron/wiring/unbound-senses-wiring.ts`）只在姿势识别开着、没说"别看"时转，音乐样本只在那个来源的律动开着时转（看 `desk:audio-capture-state` 广播）；都先按桌宠自己的检查、只发给正显示她的窗口；来源一关马上发一个空。她的记录（`herFact`：看你、歌的反应、音乐判断、跳舞档）只收那四种、只收她的窗口，交给和桌宠窗口同一条路；她在外面时桌宠窗口的同类记录不收（`shared/unbound/sense-relay.ts companionFactAllowed`）。`desk:expression-preview`（惊喜 / 害羞预览）只转那两个名字。preload 多 4 个（`sense-preload-api.ts`）。测试 `tests/unbound-full-senses.test.ts`，变异 `full-senses-*`。**2026-11-24**（记录）：用户的音乐设置（强度、"一直跟着跳"，只两个值）在第一帧音乐之前和每次改动时发给显示她的窗口（`unbound:music-settings`，preload 多 `onMusicSettings`）；她身上的听歌状态作为第五种记录 `stage-state` 回来，接线交给 `StageStateHost.acceptOut`，她在全屏时告诉她的话读这一份、在家读桌宠窗口的（两份互不作废）。测试 `tests/music-nod-full.test.ts`，变异 `full-music-stage-state`。
- **猜拳的台词在全屏里也朗读（2026-11-25，待复验）**：`game-line.ts` 的 `GameLineRelay`：猜拳主机发给全屏页的画面里每出现一句新台词，主进程先看聊天回复是否还在进行（是则这句算没说、记原因），再把它当「她自己的一句话」放进她的气泡（`holdLine`，朗读凭据覆盖它），再让桌宠窗口读（`desk:sense-line` 带 `held`、`game`；读之前 `gameLineGuard` 每段音频都再核对气泡显示的正是这句）。朗读关着或读不了时只写一行体验记录。全屏页自己不再画气泡（`out-play.ts outSayPorts`）。**11-26 补**：交给桌宠窗口读（`readGameLine`）要先等她的页面把这句画好（`waitForPresentation`），再建这句的朗读风格（`beginInitiativeSpeech`）、设凭据、最后发台词；这两步缺任何一步，语音都会悄悄拒读（11-25 的接线两步都漏了）；没画好记 `bubble-hidden`、建不起来记 `voice-failed`。测试 `tests/rps-1628.test.ts`、`tests/rps-read-aloud-1126.test.ts`，变异 `R1628-*`、`RPSREAD-*`。
- **猜拳、递东西、牵手（第 B 批，2026-11-21，记录）**：三个游戏的主机（`electron/initiative/`）没改，只改送到哪：她在外面时它们的画面发给 Unbound 窗口（`shared/unbound/games.ts playSurface`；接线 `electron/wiring/unbound-games-wiring.ts`，`initiative-together-wiring.ts` 的 `visible` / `free` / `send` 问它），只有她显示着时才算看得见（全屏程序在前面不影响，I-199）。页面的回答走 `games-bridge.ts`（`host.ts` 构造、登记，`games.send` / `games.canPlay` 给接线用）：只收她显示着的窗口；你自己的动作还要她能被碰；收尾的回答（`isPlayEnding`）永远收；交给桌宠窗口那条请求同一个主机方法。preload 多 9 个（`games-preload-api.ts`），没有交出她图片的口子。她自己的生活里多一档"你在和她玩"（比拉她低一档，`LifePorts.playing`）。她换窗口时进行中的游戏结束。测试 `tests/unbound-full-games.test.ts`，变异 `full-games-*`。
- **睡觉（第 G 批）**：主机没改（睡着时她自己的生活、凑镜头本来就让开，拉她本来就不拉）；页面一侧见 `src/unbound/her/README.md`。
- **全屏里不限速（2026-11-23）**：`control-awake.ts` 是控制窗口 `setBackgroundThrottling` 的唯一所有者，按占用计数：她出去（进入中或在 Unbound）整段不限速，一句在路上也算一个占用；回到小窗或退出（`releaseUnbound` 的 `releaseAll`）放回。测试 `tests/control-awake.test.ts`；变异 TS4、CA1～CA3。
