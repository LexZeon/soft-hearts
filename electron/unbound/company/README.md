# 全屏里几位同时在场（I-209），主机这一侧

记录：第 1 步 `docs/claude/2026-11-24-i209-step1.md`，第 3 步 `docs/claude/2026-11-24-i209-step3-instances.md`。

第 3 步起，台上每一位都是**一份完整的全屏**：和第一位同一个类 `UnboundHost`、自己的窗口、页面、导演、拉、亲抱、气泡、自己的小生活。这个文件夹只管她们之间要共用的东西。

| 文件 | 管什么 |
|---|---|
| `host.ts` | 谁在场（面板的「谁在场」、上限三位、守门送回最后来的那位并说一句）；在场名单变了就经 `present` 告诉大脑和协调者 |
| `ports.ts` | 卡片和模型：只给资源网址，不给路径；给面板的名字另带一个 `label`（卡片不止一种语言时带"（中文）/（English）"标签，I-219，只显示用，`name` 仍是她被告知的名字） |
| `build.ts` | 用接线做出第一位的主机和协调者（不碰 Electron 本身，测试可以给假的窗口和 ipc）；`electron-host.ts` 给真的 |
| `stage.ts` | 协调者：请出来、送回去（先走出屏幕再关窗）、点谁和谁说、一次一个声音（台词和嘴归说话的那位）、一次一个亲抱；第 4 步：她接话的那句归她（`own`：进她的窗口、占发言权，`release`：念完交出），台上的人的卡片编号（`ids`），歌的东西送到别人（`relayAll`） |
| `stage-world.ts` | 同一个世界：转发每位的身体，窗口按远近排前后。镜头不共用（2026-11-25）：每个窗口按她自己的身体对准同一条地面线，见下 |
| `instance-ports.ts` | 另外每一位自己的端口（她的心情、亲抱、生活记录、位置；第 4 步：她被拉的报告只动她自己的心情）；亲抱一次一个的两道闸 |
| `ipc-fanout.ts` | 几个主机共用同一组请求频道：按发请求的窗口找到它自己的主机 |
| `place-share.ts` | 两个位置文件各一本：每位的记录只由她自己的主机写，不互相覆盖；以前的单份记录归第一位 |
| `shared-senses.ts` | 感知只看一次：全屏程序的监视一份；"看一眼"一次给所有人 |
| `preload-api.ts` | 页面这一侧的请求：守门、她的身体、她走出去了；事件：共用的世界 |
| `voice-proof.ts` | 台上的声音（`docs/claude/2026-11-24-i209-stage-voice.md`）：每个页面的"气泡画出来了"只能证明送到**自己窗口**的那句，交给第一位主机那份显示证明（唯一一个声音读的那份）；`stage.ts windowOf` 说一句话的气泡去了谁的窗口 |

**「三人同框（Beta）」开关**（`shared/foundation/channel-defaults.ts` 的 `threeOnStage`，稳定版、开发版默认都开，2026-11-25 起）：经 `CompanyPorts.enabled` 读。关着时 `host.ts` 的 `look()` 不给行、`set(id, true)` 不收；开关一变 `gateChanged()` 清空选择并告诉舞台没有别人（舞台用送回去的办法先走出屏幕）。没接这个口子时按"开"。

不变的边界（`tests/i209-company-boundaries.test.ts`）：这里不引用大脑、心情、记忆、主动，也不引用感知；是谁的一轮只经大脑自己的闸门（`electron/brain/handed-line-gate.ts turnOwnerFor`）传一个角色卡编号。只有一位在场时这里什么都不做，第一位和以前完全一样。

第 4 步（`docs/claude/2026-11-24-i209-step4.md`）：都听得见、都记、谁接话由她们定在 `electron/brain/stage-chat/`；这里只多了上面几个口子。另外几位被摸、被拉、亲抱时动的是她自己的心情（`electron/mood/stage-touch.ts`，接线 `electron/wiring/unbound-stage-wiring.ts`）。

**三人同框别卡（2026-11-24，记录 `docs/claude/2026-11-24-stage-smooth.md`）**：台上每位是一整个全屏窗口，三个窗口每秒各画 60 次整屏。现在你正陪着的那位照旧；没在说话、没被碰、没在走、没在亲抱、没在跟着歌跳的陪衬，每秒最多画 30 次，像素比低一档（只动画布，不动她的档位、物理和自测），出现任何一样就在下一帧回到满帧满像素。
- 谁是"你正陪着的"：协调者把最后点的那位（`address`）作为 `focus` 写进每个页面的视图（`StageView.focus`，点的人一变就重发；一个人时不写）；说话、被碰、走路、亲抱、跳舞由页面自己读（`src/unbound/main.ts involvement`）。规则在 `shared/unbound/company/extra-pace.ts`（纯逻辑，`ExtraPace`），页面一侧在 `stage-page.ts pace`，`src/unbound/perf.ts setPace` 把它用到帧率闸（`FrameGovernor.setCap`）和像素比（`pixelTier`）上。只有一位时、没有 `involvement` 读数时、自测在量时都不动。测量脚本可用 `?pace=0` 关掉。
- 每个页面每分钟报一次帧时间（`unbound:stage-frames`，`FrameSampler`：中位、p95、帧率、画质、占了多少时间是陪衬降帧；只有数字和一个画质词），协调者收下后用自己数的台上人数、她的卡片编号写一行体验记录 `frame-time`（`shared/stage/smooth-journal.ts`）；同一个页面 30 秒内只收一行，不合格式的整行丢掉。
- 显卡：见 `electron/foundation/gpu-choice/README.md`。

**一条地面线、谁说话谁动嘴（2026-11-25）**：
- 地面：每个窗口按**她自己的身体**定镜头高度（和只有她一个时一样：她的脚总在工作区底边那条线上），别人站多远不影响她的镜头（`src/unbound/company/stage-page.ts camera`）。第 3 步的"大家用离你最近那位的镜头高度"拿掉了：把一位往前拉 1 米，另外两位在屏幕上会上下动约 50 像素。视图里不再有 `subject`。
- 嘴：控制窗口每句话一出声就发一条"这句开始被听见"（`relaySpeechFace`，键是 `句子编号的那条话#第几句`）。台上有别人时它先到 `stage.ts speechFace`：这条话的主人立刻拿到发言权（`StageFloor.sounding`），嘴从别的窗口关上、在她的窗口张开；她说话时的脸（重音、响度）也只送到她的窗口，"停"送到每个窗口。原来发言权只在上一句"念完（done）且声音停了"两件事按这个顺序到齐时才交出，一句没念出来、或 done 晚于声音停，发言权就落后一句，后一位说话动的是前一位的嘴。一个人时照旧走第一位主机。
- 嘴型记录：每个全屏页面（一个人时也一样）把她念一条回复时嘴张开多少（`src/unbound/mouth-journal.ts`，记法同桌面小窗）经 `unbound:stage-mouth` 报上来，协调者按窗口认人，记一行 `mouth-reading`，写在**她自己**的卡片编号下；同一个页面 1 秒内只收一行，格式由体验记录再查一遍（只有封闭的词和数字）。
