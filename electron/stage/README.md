# 舞台（stage）

给别的 agent 看的部分说明。总入口见 handbook/for-other-agents.md。

## 1. 这部分做什么

她在屏幕上的样子：桌宠窗口（透明、置顶、只有她身上能点、周围让鼠标穿过去）、回复气泡窗口、她的身体（MMD 模型、姿势、手势、表情、物理、生活动作、跳舞）、单 emoji 小窗、她的眉眼和身体的个性化、模型体检（I-024：这个模型能做哪些表情）、表情预览（惊喜、害羞）。

用户感觉到的是：她一直在、动作顺，不瞬移；点她身上有反应，点旁边的空地不挡你干活；拖她、藏她、找回她都听话。

## 2. 文件在哪

- 三个文件夹：`electron/stage/`、`shared/stage/`、`src/stage/`。
- 公开页：`electron/stage/index.ts`、`shared/stage/index.ts`、`src/stage/index.ts`。
- 画她的那一块是 Unbound 的窗口引擎（`src/unbound/window-mode/`，说明见那里的 README）；I-176 第 3 步（2026-11-23）删了老舞台 `src/stage/MmdStage.ts` 和 `src/stage/mmd/`。`src/stage/` 里留下的是引擎借用的零件（程序生命、睡姿、物理、捏脸、音乐、取景……）。
- 主机这边的接线（第 4g 步搬来，2026-11-17 按功能拆成四个文件，记录 `docs/claude/2026-11-17-split-stage-wiring.md`）：改哪个功能就读哪个文件。
  - `electron/wiring/stage-wiring.ts`：入口 `wireStage`、`StageNeeds`、`register(ipc)`（按原来的顺序调下面三个文件）；桌宠窗口造时就有的状态（鼠标接收、呈现、拖动、各窗口的可见性记录）；单 emoji 窗口、提示和设置；表情预览（E1）；生活动作；回复气泡的处理函数 `updatePetReply`。别的文件导出的东西它都转出，所以 main.ts 和别的部分照旧从它导入。
  - `electron/wiring/stage-window-wiring.ts`：桌宠窗口。她看不看得见（`onScreen`、`herOnScreen`、`replySurface`、`nativeVisibility`）、每次同步的大小位置置顶点穿（`syncPetWindow`）、拖动和拖动结束、显示隐藏找回、不压任务栏，和它的处理函数（`registerStageWindowHandlers`）。
  - `electron/wiring/stage-body-wiring.ts`：她的身体。身体模型代数、Gene 凭据、发布的心情带的身体姿态（`withBodyPose`）、个性化的眉眼和身体编写、它们的存储和处理函数（`registerStageAuthoringHandlers`）。
  - `electron/wiring/stage-model-wiring.ts`：关于模型知道的东西。模型档案缓存、模型体检（I-024）和「试一下」、物理设置，和它们的处理函数（`registerStageModelHandlers`、`registerStagePhysicsHandlers`）。
  - `electron/wiring/stage-avoid-wiring.ts`（X-549，2026-11-19，`startStageWindows` 调它）：不挡控制窗口。回复气泡读控制窗口的矩形（大脑的 `electron/brain/reply-avoid.ts` 排位置）；她的身体真挡住控制窗口底部那一条（输入、发送、停止）时缓动让开、窗口走了走回来（`electron/stage/companion-step-aside.ts`）。记录 `docs/claude/2026-11-19-control-window-avoid.md`。
  - `electron/wiring/physics-lab-wiring.ts`（R01，2026-11-17）：物理调参台。按模型保存的物理调参（`electron/stage/physics-tuning-store.ts`，侧车 `physics-tuning.json`，按模型内容哈希，不进角色卡），给桌宠和 Unbound 的物理设置带上它（`physicsWithTuning`、`physicsForWindows`），开发者用的调参台窗口（`electron/stage/physics-lab-window.ts`，自己的预加载 `physics-lab-preload-api.ts`，两道门在 `physics-lab-guard.ts`）。页面在 `src/stage/physics-lab/`（见那里的 README），记录 `docs/claude/2026-11-17-physics-lab.md`。
- 入口：
  - `wireStage(given)`：main.ts 求值时调用一次，造可见性、鼠标接收 `petPointerInput`、呈现 `petPresentation`；返回 `register(ipc)`（处理函数）。
  - ready 链里的九步：`startPhysicsSettings`、`startEmojiSettings`、`startPersonalizeStores`、`startPersonalizeAuthoring`、`startModelProfiles`、`startModelCapabilities`、`startStageWindows`、`attachPetWindow`、`startKeepInArea`。
  - 同步的五步：`syncBodyModel`、`syncBodySelection`、`syncSingleEmoji`、`syncPetWindow`、`syncWindowVisibility`；心情发布里舞台那一步 `publishEmojiContext`。
  - 别的部分直接用的函数：`herOnScreen()`（她这句话现在看得见吗）、`replySurface()`（看得见的话在哪：桌宠气泡，或 Unbound 里的朗读）、`withBodyPose(view)`（发布的心情带上身体姿态）、`nativeVisibility(win)`。
- **最小化是临时离开**（I-171，2026-11-21）：窗口离开屏幕时 窗口离开屏幕的那一步（`electron/wiring/stage-cleanup-wiring.ts`）走 `electron/stage/companion-hidden.ts` 的 `companionHiddenStep`：电脑的声音和鼠标照停，**只有藏到托盘才结束她正在说的回复**；`nativeVisibility` 多告诉页面一个 `minimized`（只在为真时有这个键）。规则在 `shared/foundation/step-away.ts`，页面用 `shown()`（`src/wiring/chat-wiring.ts`）。语音输入和摄像头最小化时仍收回。测试：`tests/i171-step-away.test.ts`。
- 别的部分读的状态是接线文件的模块级活绑定：`petPointerInput`、`petPresentation`、`petWindowDrag`、`singleEmojiWindow`、`singleEmojiCues`、`visualAuthoring`、`bodyAuthoring`、`visualGeneReceipt`、`modelCapabilities`、`modelPhysicsSettings`、`bodyModelGeneration`（加一用 `bumpBodyModelGeneration()`）。
- 窗口这边的接线：`src/wiring/stage-wiring.ts`、`src/wiring/pet-window-wiring.ts`（`src/main.ts` 拆分后，记录 `docs/claude/2026-11-16-src-main-split.md`）。
- **显卡重置后她自己回来**（2026-11-22，记录 `docs/claude/2026-11-22-gpu-reset.md`）：画她的舞台都经 `src/stage/context-recovery.ts` 处理 WebGL 上下文的丢失和恢复（桌宠舞台 `src/stage/mmd/context.ts`，窗口引擎在 `window-stage.ts` 里）：丢了不马上报错，8 秒还没回来才提示，回来了清掉；恢复时 `pixel-probe`、`stray-pixels` 丢掉旧上下文的缓冲（`forgetContext`）。缩小过的贴图画布必须用 `src/stage/textures.ts` 的 `resizedTextureCanvas`（放在普通内存里，显卡重置清不掉）。主机那半在 `electron/foundation/gpu-reset/`。体验记录类型 `gpu-reset` 在 `shared/stage/journal-entries.ts`。
- 拉她（I-136 第 5 步，2026-11-18）：会话、上限、什么时候不算拉在 `shared/behaviors/pull/`（行为文件夹归舞台，`shared/stage/index.ts` 转出），身体层和认部位在 `src/stage/pull/`（见那里的 README），舞台方法 `src/stage/mmd/pull.ts`；胶囊挪到了 `src/foundation/body-capsules.ts`（桌宠和 Unbound 共用）。"碰了才软"的开关由 `physics-lab-wiring.ts` 按版本定默认（`touchSoft`，随物理设置发给窗口）。
- 模型导入（2026-11-18）：`electron/stage/model-import/vrm/`，VRM → PMX 的纯函数转换器，见那里的 README；只接了开发命令行 `scripts/model-lab/vrm-to-pmx.mts`，没进本页 `index.ts`。2026-11-19 起方向改成原样载入（I-152）：应用直接载入 `.vrm`、不转换（舞台的适配层 `src/stage/model-adapter/`），转换器留着当对应表的来源；它读 VRM 扩展的那一份（`vrm-read.ts`）搬到了 `shared/stage/vrm/`，两边共用。
- 收模型文件的地方（2026-11-19，I-152）：文件选择（`selectAsset`、`bindCharacterModelFile`）、内部通道 `load_model`、资源地址白名单、模型身份 `keyForModel` 都认 `.pmx`、`.pmd`、`.vrm`，列表只有一份：`shared/foundation/model-format.ts`。新卡取名读 VRM 自己的名字（`shared/foundation/glb-json.ts`）。
- 接口切片：`shared/stage/desktop-api.ts`（窗口能调的舞台操作）；体验记录切片：`shared/stage/journal-entries.ts`。
- 留在 `electron/main.ts` 的（第 4g 步记录写了原因）：
  - 建桌宠窗口、控制窗口和回复气泡窗口（回复窗口的模块属于大脑，舞台经结构类型 `ReplyWindowPort` 读它）；
  - `secureWindow` 的订阅 `windowEvents`：舞台的几行（桌宠挂掉时取消拖动、重置鼠标接收、身体代数加一）和别的部分的清理交错，同一事件按注册顺序跑，拆开会改金标准；
  - 心情发布的 `publishCue`（读大脑的 companion），等大脑那批再定；
  - 惊喜预览（主动的模块）、`reserveCompanionAuthoring`（大脑的聊天租约）。

## 3. 从哪进、谁调用它

- main.ts 在原来造鼠标接收的位置调用 `wireStage(...)`（在 Unbound、IPC 守卫、外壳之前）。
- `stagePart.register(partIpc('stage'))` 在录制器里，注册的有：单 emoji 设置、表情预览、生活动作、模型档案、模型体检六个、回复气泡、眉眼编写十三个、身体编写、物理设置、桌宠窗口的点穿 / 拖动 / 呈现样本 / 置顶。
- `core: ['pet-window', 'reply-window', 'presentation']`：第 7 步的隔离永远不关这三样，它们出错照旧致命（方案第三节）。

## 4. 它守着的规矩

- **气泡跟着声音走（I-165，2026-11-20）**：开着朗读时，桌宠窗口（旧舞台和「桌宠用 Unbound 引擎」的窗口舞台是同一个回复气泡）发布回复的 `showAnswer` 只把声音已经念到的那一段交给回复窗口（`src/stage/reply-voice-cap.ts`：只管它点名的那条回复、已经显示了字的回复永远不再藏回去、不切开表情字），第一句出声前是"……"（等待的三个点），"等朗读""读完了"这些只改状态的更新不会把"……"清掉；收起了的、换掉了的回复不会因为迟到的放开重新出现。阅读器（"查看完整回复"）一直是全文。回复窗口的 `followingText()`：气泡此刻为这条回复立着的字（"……"是空串），画没画完都算，声音按它开口、不等绘制回执。说明见 `electron/voice/README.md` 同名一条，记录 `docs/claude/2026-11-20-bubble-follows-voice.md`。
- **只认桌宠窗口**：点穿、拖动、回复气泡、呈现样本，只收桌宠窗口自己发来的请求；第三个窗口不能改置顶。测试：`tests/stage-gates.test.ts`（24 项，第 4g 步新增，补上了 30 个原来没有测试的检查）。
- **过期的不算数**：过期的拖动结束不写设置；找回桌宠时让进行中的拖动过期；生活动作要核对心情的 token、是否允许、资源是不是登记过的，不把本地路径交给窗口。测试：`tests/stage-gates.test.ts`。
- **只给控制窗口的**：「试一下」、个性化保存、身体研究、体检开关只能由控制窗口发起；体检结果只认桌宠报的。测试：`tests/stage-gates.test.ts`、`tests/wiring-golden.test.mjs`。
- **让位不抢用户的手、不瞬移、不存盘**（X-549）：只在她的身体真挡住控制窗口的输入那一条、用户没在拖她时让；最多 320 DIP，缓动；用户亲手放在那儿就不动，直到控制窗口挪动或重新出现；别人挪过她就以新位置为家；只调 `setBounds`，置顶不变。测试：`tests/companion-step-aside.test.ts`、`tests/control-avoid-wiring.test.ts`，变异 `T253-S1`～`S13`。
- **表情预览发给每个窗口的舞台**，不只一个。测试：`tests/stage-gates.test.ts`。
- **发布的心情带身体姿态**（`withBodyPose`），窗口读心情也带。测试：`tests/stage-gates.test.ts`、金标准。
- **退出和挂掉要收拾**：关桌宠时置顶守护停；退出时单 emoji 窗口和提示清理；桌宠渲染进程挂掉时重置鼠标接收、取消拖动。金标准的 `beforeQuit`、`secureWindow` 两节钉着。
- **动作不瞬移；姿势、手势、表情是独立通道；不改 PMX/VMD 的字节**（CLAUDE.md 和 R29 一组）。帧率最低 24，`MAX_ANIMATION_DELTA` 和 R29f 的余量不改；平静时 30 帧要用户试过才开。测试：`tests/stage-pace.test.ts` 和 `src/stage` 的各个 `*-stage.test.ts`。
- **边说边演的拍子（2026-11-20）**：舞台接口多了 `speechBeat(word)`。窗口引擎的 `window-beats.ts` 演（老舞台的叠加层已随 I-176 第 3 步删除）：表情、看向、慢眨眼挂在她自己的活动上，身体的词在窗口里不走动；睡着时不演。记录 `docs/claude/2026-11-20-speech-beats-2-4.md`。
- **模型体检的 haiku 只能是单次、不可写、不带工具**，Claude 不可用时不问。测试：`tests/stage-gates.test.ts`（M1、M2）。

## 5. 测试在哪

- `node scripts/dev/ops.mjs owned stage`：只跑这部分相关的测试。
- 变异：第 4g 步的 70 个变异在 `scripts/dev/mutations/stage.json`（表在 `docs/claude/2026-11-16-wiring-step-4g.md`），`node scripts/dev/mutate.mjs --part stage` 重跑；拆文件后每项的 `file` 指向它现在所在的文件。
- 最重要的几个：`tests/stage-gates.test.ts`、`tests/wiring-golden.test.mjs`、`tests/renderer-golden.test.mjs`、`tests/stage-pace.test.ts`、`tests/i024-*.test.ts`、`tests/personalize-*.test.ts`、`tests/model-physics-*.test.ts`、`tests/her-life*.test.ts`。

## 6. 改的时候小心

- **接线拆成了四个文件，每个都在 40 KB 以下，不再钉大小。** 新功能放进 `electron/stage/` 的模块，接线里只留一两行，加在对应功能的文件里；别把功能文件的东西搬回 `stage-wiring.ts`。
- **功能文件的处理函数要按原来的顺序注册**：`stage-wiring.ts` 的 `register` 依次调它们，处理函数在内部通道的录制器里。功能文件的注册函数收 `host` / `scopedHost`（不收整个 `ipc`），金标准才认得出这是交出注册器、跟进那个文件；收 `ipc` 的话，`recoverPet`、`setPetVisible` 这些会被当成"不在录制器里"，金标准失败。
- **功能文件之间共用的状态只在一个文件里赋值**（ES 模块不能给导入的绑定赋值）：窗口一造就有的放 `stage-wiring.ts`，由 `wireStage` / `startStageWindows` 造；别的文件只读或调它的方法。
- **顺序表里调用的不能是接线文件的顶层函数**（金标准会就地展开）：像 `refreshSingleEmojiContext` 这种，在 `wireStage` 里造，经 `keepForSteps` 交给步骤（4f、4g 的做法）。
- **身体模型代数**（`bodyModelGeneration`）是"这个凭据还算不算数"的依据：换模型、渲染进程挂掉都要加一，加一只用 `bumpBodyModelGeneration()`。
- **`herOnScreen()` 也算 Unbound 里的朗读**：她在 Unbound 时桌宠窗口藏着，但她的话仍然看得见。改它会影响说话、主动开口、朗读的所有判断。
- **改舞台的画法先读 `src/unbound/window-mode/README.md`**：新功能加成窗口引擎的一个成员（`window-stage-*.ts`、`window-*.ts`），不往 `window-stage.ts` 里堆；舞台接口 `src/stage/stage-surface.ts` 的成员名单和签名两处一起改；`window-stage.ts` 的 `tick` 里谁先写谁后写就是动作规矩的一部分，别随手调换。动作相关的规矩见 `docs/mood/action-composition.md`。

## 7. 和 Claude 有关的地方

- **模型体检（I-024）**：每个模型最多问一次 haiku（单次、无工具，`quickLineWithClaude`），只给部件名，让它猜哪些表情能用；再由窗口在真网格上核对。答案、"都不合适"和失败都记住。`electron/stage/model-capability-host.ts`。登记在 `handbook/brain-interface.md` 2-24（2026-11-17 补登）。
- **个性化的眉眼和身体**（`electron/stage/personalize-*.ts`）：用聊天模型的单次调用写文字和选图（brain-interface 1-10）。
- 其余（她说什么、心情）不在这部分；舞台只按发布的心情和动作提示去演。
