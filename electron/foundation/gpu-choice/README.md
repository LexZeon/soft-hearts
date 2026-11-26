# 显卡有没有用上

记录：`docs/claude/2026-11-24-stage-smooth.md`。

## 现在

- **向 Chromium 要高性能那块显卡**（`plan.ts`）：应用就绪前加开关 `force_high_performance_gpu`。笔记本有集显和独显时，Chromium 默认跟着 Windows 给这个应用定的那块（通常是集显）；加了开关就用独显。不写注册表，不改 Windows 的任何设置。开关在 Chromium 156（Electron 45）里实测存在。
  - 启动命令行里已经有相反的 `force_low_power_gpu`（有人特意要省电）就不去盖它。
  - 从不要软件渲染：没有 `disable-gpu`、`disable-software-rasterizer`、SwiftShader 之类的开关（加了，没显卡的机器会整个没有画面）。
- **全屏页向 WebGL 要的也是高性能**（`src/unbound/gl-options.ts`）：以前是 `low-power`，双显卡笔记本上会落在集显。
- **启动后几秒记一行体验记录 `gpu-start`**（`host.ts`；就绪后等 4 秒，不拖慢启动）：用一个扔掉的 WebGL 上下文（在应用已有的一个页面里跑一小段只读脚本，向 WebGL 要高性能）问"实际是谁在画"，只记封闭的词：硬件还是软件、厂商（nvidia / amd / intel / qualcomm / apple / other）、机器上是否列出第二块真显卡（Electron 能读到才写）、有没有向 Chromium 要高性能、**有显卡却在软件渲染**（`fellBack`，用户最看不出来的那种）。设备名、驱动路径一个字都不进记录。
- 软件渲染时：开发者读数（全屏页的开发叠层 `src/unbound/debug-lines.ts gpuLine`）说"没有用上显卡，是处理器在软件渲染"，主进程的开发日志也写一行 `SOFTWARE`。

## 文件

| 文件 | 内容 |
|---|---|
| `plan.ts` | 纯逻辑：开关、启动那一行怎么得出来。不引用 Electron |
| `host.ts` | 把 `plan.ts` 用到 app 上（app 作为参数传进来，测试用假的） |
| `shared/foundation/gpu-kind.ts` | 渲染器字符串、厂商编号、设备列表 → 封闭的词（主机和全屏页共用） |
| `electron/wiring/gpu-choice-wiring.ts` | 接线：真的 app，和那个只读的探针（`health-wiring.ts` 的 `wireHealth` 里，紧跟显卡重置之后） |

## 测试

`tests/gpu-choice.test.ts`：渲染器字符串分类、几块显卡、开关与相反请求、启动行（这台机器一块、笔记本两块、软件渲染）、软件渲染被报出来、假 app 上开关在就绪前加上而行在几秒后写、探针失败也写一行 unknown、记录里只有封闭词。变异：`gpu-software-not-reported`、`gpu-fell-back-not-flagged`、`gpu-high-performance-not-asked`、`stage-page-asks-low-power`、`stage-readout-software-silent`。
