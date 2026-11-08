# soft hearts · 给你自己的 Claude Code 的说明

这份文件是写给你电脑上的 Claude Code 看的。你打开这个项目时它会自动读取。用户要你改东西或接着开发时，先按这里的约定做。

## 这是什么

soft hearts 是一个 Windows 桌面上的 MMD 桌宠：一个三维角色（MMD 模型，PMX/PMD 格式）常驻在屏幕上，用户可以和她文字聊天、切换动作、调镜头和窗口。聊天走用户自己电脑上登录好的 Claude Code，不另外接模型服务。

- 目前只在 Windows 上使用和验证。
- 陪伴聊天本身不带任何工具，只是说话。
- 任务执行（读写用户选定文件夹里的文件、运行命令）是单独的功能，默认关闭，用户在应用的「Claude 任务」里打开并选文件夹后才可用。实现在 `electron/claude-tasks/`。
- 聊天的实现在 `electron/claude.ts`。

## 目录地图

| 路径 | 作用 |
| --- | --- |
| `electron/` | 主进程（宿主）：窗口、设置、密钥、聊天调用、任务执行、内部通道。`electron/main.ts` 很大，而且是 CRLF 换行。改它时只做接线，新逻辑优先放进新模块。 |
| `electron/preload.ts` | 渲染进程能用的接口白名单，只列出明确允许的函数。 |
| `electron/claude.ts` | 陪伴聊天调用 Claude Code。 |
| `electron/claude-tasks/` | 任务执行（可选，默认关闭）。 |
| `electron/agent-channel/` | 内部通道：让用户自己的 Claude Code 通过 MCP 帮忙换角色、调设置。 |
| `src/` | 界面，不用框架，直接操作页面元素。`src/ui/` 放各个面板；`src/stage/` 放 Three.js MMD 舞台（模型、动作、镜头）。 |
| `shared/` | 宿主和界面都用到的逻辑。`shared/behaviors/<行为名>/` 是一个行为的文件夹，其中 `knobs.ts` 放可调数值，每个旋钮上方有注释说明。 |
| `tests/` | 测试，`*.test.ts` 和 `*.test.mjs`。 |
| `scripts/` | 启动、构建、打包、冒烟测试和桌面更新脚本。`scripts/dev/` 是开发辅助，其中 `test-all.mjs` 跑全套测试，`heavy.mjs` 用来包住耗资源的命令。 |
| `assets/bundled/` | 随应用发布的第三方素材（预装的 Gene 模型、动作等）。每份素材保留来源、作者署名和 CC BY 4.0 授权。只放已审过的素材。 |
| `docs/` | 说明文档。`docs/architecture.md` 是结构说明，`docs/character-cards.md` 是角色卡说明。 |

根目录的 `start-soft-hearts.cmd` 是一键启动脚本，`promote-to-stable.cmd` 用来把测过的开发版设为稳定版。

## 常用命令

在项目根目录运行（PowerShell）：

- `pnpm install`：第一次安装依赖。
- `pnpm dev`：开发运行。使用开发配置，不碰用户的正式配置。
- `pnpm typecheck`：类型检查，改完代码先跑这个。
- `pnpm test`：全套测试（实际运行 `scripts/dev/test-all.mjs`）。也可以只跑某几个文件：`node scripts/dev/test-all.mjs tests/某个文件.test.ts`。
- `pnpm build`：构建。`pnpm start`：用构建结果启动。
- `pnpm smoke`：启动真实的 Electron，用隔离的临时配置检查窗口和聊天流程。
- `pnpm desktop:update`、`pnpm desktop:promote`、`pnpm desktop:rollback`：桌面开发版更新、设为稳定版、退回上一个稳定版。这些会写桌面快捷方式，只在用户明确要求时运行。
- `start-soft-hearts.cmd`：安装、构建并启动源码版。

会长时间占满处理器的命令（比如大批量测试、手动打包），用下面的格式包住，它会在用户使用电脑时排队、降低优先级：

```powershell
node scripts/dev/heavy.mjs --label 名字 -- 命令 参数
```

## 配置目录（很重要）

- 正式配置：`%APPDATA%\soft-hearts-claude`，只给安装好的稳定版使用。
- 源码运行（`pnpm dev`、`pnpm start`、`start-soft-hearts.cmd`）和开发版：`%APPDATA%\soft-hearts-claude-dev`。第一次创建时会从正式配置只读复制一次设置。

规则：

- 测试和调试永远不碰正式配置。真实 Electron 的检查只用隔离的临时配置。
- 对话、日记、角色记住的关于用户的内容，都只存在配置目录里。不要为了测试去读、改或删除它们，也不要把它们提交进仓库。
- 要改设置，用应用里的界面，或者用应用的内部通道。不要直接编辑配置目录里的文件。
- 不要读取、复制或改动 Claude Code 自己的登录资料。

## 产品与安全底线

改代码时必须守住下面这些。它们是产品的边界，不是可以顺手放宽的选项。

- 渲染进程（界面）拿不到 Node 能力、密钥、任意文件路径，也不能调用通用的 shell 或远程过程调用。它只能通过 `electron/preload.ts` 白名单里的函数和宿主说话。
- 屏幕共享、摄像头、麦克风、系统声音采集、付费语音（百炼）、任务执行，默认全部关闭，只能由用户自己明确打开。你给的建议不等于用户同意。改默认值前，先问用户。
- 密钥只存在宿主里，用操作系统的安全存储加密。不写进代码、文档、日志或截图。
- 角色卡导入不会授予文件或执行权限。导出时不带路径、密钥、实时状态和私人聊天历史。
- 同一条回复只归档、只奖励一次。取消、迟到、或者已经换了上下文的结果，不能复活或覆盖新的状态。
- 动作（pose）、手势（gesture）、表情（expression）是三条独立的通道，互不清除。
- 不修改 PMX/VMD 原文件的字节。模型和动作按原样加载。
- 随包素材必须保留原作者署名和 CC BY 4.0 授权信息；代码以外的素材不适用项目的 MIT 授权。

## 怎样改代码

- 测试是为行为服务的。新测试要能抓住真实的失败。避免那种"读取 `main.ts` 的源码文字再 eval"的脆弱测试；新代码优先抽成可以直接导入的模块，再测模块。
- 改完先跑 `pnpm typecheck`，再跑和改动相关的测试。改动较大时跑 `pnpm test`，并考虑 `pnpm smoke`。
- 新增的界面文字要同时给英文。界面文字用 `src/ui/ui-language.ts` 里的 `uiText` 或 `t` 包起来；英文条目放在 `shared/ui-copy.*.en.ts` 里（例如 `shared/ui-copy.tasks.en.ts`），由 `shared/ui-copy.en.ts` 汇总。部分测试（比如 `tests/chat-availability-copy.test.ts`）会检查这些英文条目是否存在。
- 可调的数值放在对应行为的 `knobs.ts` 里，不要散落在代码各处。
- 完成后向用户说明：改了什么，跑了哪些测试，哪些只是没在真机上验证过。

## 用户个人的改动怎样跟着新版本走

用户可能会拿到新版本，同时想保留自己的改动。建议这样做：

1. 个人改动放在单独的 git 分支上，不直接改 `main`。
2. 改完提交到这个分支。提交前用 `git status` 看一眼，确认没有私人模型、聊天记录、密钥、截图。
3. 新版本来了：切回 `main` 执行 `git pull`，再切回个人分支执行 `git merge main`，把新版本合进来。
4. 出现冲突时，逐个文件说明两边各改了什么，再解决。拿不准时先问用户。不要用 `git reset --hard` 或 `git checkout -- .` 这类会丢掉改动的命令。

私人模型放在仓库之外，比如 `%USERPROFILE%` 下的某个文件夹，应用里只记录它的位置。

## 改角色卡和数值前先读

改角色卡和数值前，先读这两份：

- [角色卡和她的数值怎么写](docs/character-card-guide.md)：角色卡有哪些字，每个数是什么意思、能填多少，想要的样子该怎么写。
- [想改什么 → 改哪里](docs/knobs.md)：每一种表现对应哪个文件里的哪个数字。

只改角色卡里的文字和数值时，不需要改代码。改了代码，照上面的「怎样改代码」来做。

## 需要先问用户的事

下面这些事，做之前先问用户并等用户回答：

- 删除文件或覆盖用户已有的文件。
- 推送到别人的仓库，或者改动远程仓库的设置。
- 会产生付费调用、或者需要新的付费服务。
- 打开或放宽任何设备权限（麦克风、摄像头、屏幕、系统声音）或安全限制。
- 改变用户已经确认过的行为。
