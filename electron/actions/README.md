# 身体动作（actions）

给别的 agent 看的部分说明。总入口见 handbook/for-other-agents.md。

## 1. 这部分做什么

她的身体怎么动：动作库（下载、预览、换模型或动作文件、清动作层）、动作的权重和标签、聊天时的手势、她自己的动作（比如被你碰一下、摸头后的反应），以及动作的轨道覆盖。用户看到的是她动作自然、选的动作能用、换模型后动作还对得上。

姿势、手势、表情是三条独立的通道，这部分不把它们合并。

## 2. 文件在哪

- 三个文件夹：`electron/actions/`、`shared/actions/`、`src/actions/`。
- 公开页：
  - `electron/actions/index.ts`（导出 `MotionLibrary`、`BodyMotionController`、`BodyMotionAccess`、`BehaviorMotionController`、`HerActionHost` 等）
  - `shared/actions/index.ts`
  - `src/actions/index.ts`（导出 `MotionPreviewSession`）
- 接线：`electron/wiring/actions-wiring.ts`，入口 `wireActions(needs)`，`register(partIpc('actions'))` 放在原来"她的动作"注册的位置。
- 留在 `electron/main.ts` 的：
  - 三个数：身体模型代数、动作选择代数、动作下载的窗口。ready 链、saveSettings、secureWindow 也读写它们，所以搬过去的代码通过 `needs.<名字>` 读写；
  - `herActions` 的创建在接线时进行（和原来一样在模块求值时）。

## 3. 从哪进、谁调用它

- main.ts 调用 `wireActions(...)`，然后 `actions.register(partIpc('actions'))`。
- 公开的类和函数（见 `electron/actions/index.ts`）：动作库和它的权重、适配、轨道覆盖；身体动作控制器和取用；行为动作的解析；聊天手势的时长和解析；她的动作宿主。
- IPC：接线文件里 19 处 host 调用（`electron/wiring/actions-wiring.ts`，按 `scopedHost(` 和 `host(` 粗数，2026-11-16 核实）。包括她的动作（宠物窗口的回报）、身体动作取用、动作库（标签读写、轨道覆盖、预览、下载动作包、清动作层、取消下载、恢复内置模型、选模型或动作文件）。
- 时钟和生命周期：这部分没有时钟条目，也没有自己的窗口事件。姿势、表情和舞台的渲染在舞台部分（`src/stage/`）。

## 4. 它守着的规矩

- **姿势、手势、表情是独立通道，不合并。** 这是 CLAUDE.md 和重写方案的规矩。测试：`tests/motion-layers.test.ts:77`（姿势、手势、表情各用独立的真实四元数和表情轨道）。手势另有 `tests/chat-gesture.test.ts`、`tests/body-motion-access.test.ts`。
- **不修改原 PMX、VMD 的字节。** 动作适配只生成新的数据。测试：`tests/motion-retarget.test.ts:250`（适配不改输入，时间线照原样保留），`:222`（Gene 本身的动作原样返回，逐字节不变）。`src/actions/` 里没有写文件的代码（2026-11-16 搜过）。
- **动作不能瞬移。** 这是舞台的规矩（`MAX_ANIMATION_DELTA`，最低 24 帧），这部分只提供动作，不改帧率。测试在舞台那边：`tests/stage-pace.test.ts`。
- **动作标签的 IPC 只给控制窗口，参数个数要对。** 测试：`tests/motion-weights-ipc.test.ts`（4 个处理函数，窗口事件里的释放；去掉参数个数检查、或改成两窗都能调，都会失败）。
- **动作库的第三方素材只放在 `assets/bundled/**`，保留原署名和 CC BY 4.0。** 这是 CLAUDE.md 的规矩；`ACKNOWLEDGEMENTS.md` 和 `THIRD_PARTY_NOTICES.md` 管署名。测试守着：`tests/bundled-attribution.test.ts` 从 `assets/bundled/**` 的文件夹里推出清单（不是手写的）：每个第三方动作包的 `source.json` 都要写明许可和署名行、完整的 CC BY 4.0 文本和 `attribution.txt` 都在，`THIRD_PARTY_NOTICES.md` 要链到它的来源；带 LICENSE 的文件夹（语音模型、Unbound 的待机数据）的版权行和路径要在 `THIRD_PARTY_NOTICES.md` 里；没有来源文件也没有 LICENSE 的新文件夹直接失败。`tests/bundled-assets.test.ts` 的 5 个测试查的是文件有没有被改、路径和网络访问，不查署名。其他素材另有测试：`tests/unbound-bundled-idle.test.ts:38-42`、`tests/i099-smart-turn.test.ts:45-47`。
- **轨道覆盖：模型代数变了，就作废。** 测试：`tests/motion-track-coverage.test.ts`（不读代数会失败）。

## 5. 测试在哪

- `node scripts/dev/ops.mjs owned actions`：只跑这部分相关的测试。
- test-parts.json 里 owner 是 actions 的文件有 37 个。
- 最重要的几个：
  - `tests/motion-weights-ipc.test.ts`、`tests/motion-track-coverage.test.ts`、`tests/motion-track-coverage-ui.test.ts`
  - `tests/her-action-host.test.ts`、`tests/her-action-models.test.ts`
  - `tests/body-motion-qa.test.ts`、`tests/behavior-motion-resources.test.ts`
  - `tests/bundled-assets.test.ts`
  - `tests/wiring-golden.test.mjs`、`tests/wiring-parts.test.ts`

## 6. 改的时候小心

- **三个数字在 main.ts，不在这里。** 改它们的位置，要同步看 ready 链、saveSettings 和 secureWindow。
- **金标准钉着注册位置。** `actions.register` 的位置变了，金标准要重新生成。第 3 步搬这部分时，金标准只有 `registrarSites` 变了。
- **姿势、手势、表情通道不要合并。** 哪怕看起来是同一个文件，要分开改。
- **舞台的代码（当时的老舞台 `src/stage/MmdStage.ts`，现已删，画她的是 `src/unbound/window-mode/window-stage.ts`）第 4 步不碰。**
- **`motion-retarget` 已经归动作。** 重写方案第二节 D 类说它归动作；2026-11-16 核实：文件已在 `src/actions/motion-retarget.ts`，`src/stage/` 里已没有它。`tests/motion-retarget-stage.test.ts` 已指向 `../src/actions/motion-retarget`（第 12 行）。

## 7. 和 Claude 有关的地方

- **7-3 尾注标记里的手势块**（`electron/mood/mood-chat.ts`）：模型要按说明写出手势块，这部分才会收到。块写漏，手势就不做。模型输出习惯变了，要重测。
- **她的动作、聊天手势的选择**：本身不调用 Claude，是本机规则。模型只负责写出标记。
- 没有其他直接的 Claude 调用。
