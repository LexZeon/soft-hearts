# 显卡重置后她自己回来

2026-11-22 20:38，用户在全屏 Unbound（摄像头、姿态、屏幕、麦克风都开着）时应用突然消失，下次启动记成"没正常退出"。同一分钟 Windows 日志里有三次 NVIDIA 驱动超时重置（LiveKernelEvent 0x141）。记录：`docs/claude/2026-11-22-gpu-reset.md`。

## Electron 45 默认会怎样（实测，不是猜的）

Chromium 的显卡进程每次崩溃都会自己重启，但：

- 第 2 次起，页面的 WebGL 被封（"domain blocking"），丢掉的画面回不来，她一直看不见；
- 第 3 次，整个程序改成软件合成，WebGL 关掉；
- 第 6 次，Chromium 认定"GPU process isn't usable. Goodbye."，整个应用退出。

## 现在

- 应用就绪前（`electron/wiring/health-wiring.ts` 的 `wireHealth` 第一件事，经 `electron/wiring/gpu-reset-wiring.ts`）：加 Chromium 开关 `disable-gpu-process-crash-limit`，调用 `app.disableDomainBlockingFor3DAPIs()`。两样缺一不可（实测：只加一样，第 2 次画面就回不来，或第 6 次照样退出）。
- 每次显卡进程结束（`child-process-gone`，类型 GPU）记一行体验记录 `gpu-reset`：怎么结束的（封闭词）、退出码、最近 10 分钟第几次、这次运行一共几次。一分钟崩很多次时，超过 20 次后每 20 次记一行。
- 崩溃后 1.5 秒看一眼 WebGL 还能不能用；不能用了（Chromium 改成软件合成，只有显卡进程启动失败才会这样）就记一行 `software`。
- 从不退出、不重开应用。页面的 WebGL 自己恢复，见 `src/stage/context-recovery.ts`；她的贴图画布放在普通内存里（`src/stage/textures.ts` `resizedTextureCanvas`），不然恢复后她是透明的。

## 文件

| 文件 | 内容 |
|---|---|
| `plan.ts` | 纯逻辑：开关、计数、哪次写记录、WebGL 能不能用。不引用 Electron |
| `host.ts` | 把 `plan.ts` 用到 app 上（app 作为参数传进来，测试用假的） |
| `shared/foundation/gpu-reset.ts` | 记录里的封闭词（主机和记录的白名单共用） |

## 测试

- `tests/gpu-reset-host.test.ts`：假 app 上开关和顺序、六次崩溃只记六行不退出、软件合成只记一次、崩溃风暴、记录或日志出错不影响 Electron、接线（就绪前、第一件事）、记录白名单。
- `tests/gpu-reset-stage.test.ts`：舞台的丢失和恢复。
- 变异：`scripts/dev/mutations/trunk.json` 的 `GPU1`～`GPU4`，`stage.json` 的 `GPU5`～`GPU7`。
- 真应用核对：`node scripts/dev/heavy.mjs --label gpu-reset -- node scripts/dev/gpu-reset-check.mjs --commit <提交> [--unbound] [--lose-context]`（临时配置、假 Claude，用 chrome://gpucrash 让显卡进程崩溃）。
