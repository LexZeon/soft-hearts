# 装好以后：自己改她、接着开发

这份说明给装好 soft hearts 之后想自己改一改、或者接着开发的人看。最省事的办法是让你自己的 Claude Code 来做，项目根目录的 `CLAUDE.md` 会告诉它这个项目的规矩。

## 最省事：让你自己的 Claude 来改

在项目文件夹里打开 Claude Code，直接用大白话说你想要什么。它会先读 `CLAUDE.md`，知道该改哪里、怎么验证、哪些事要先问你。

可以直接照抄下面的说法，换成你自己的意思：

- 「把她的说话方式改得轻松一点、句子短一点。只改角色卡里的说话方式和对话示例，别动其他设置。改完告诉我改了哪几个字段。」
- 「她有点太爱主动开口。帮我找到 `shared/behaviors/inner-rhythm/knobs.ts` 里管这件事的数值，只改这一个，并告诉我改前改后的值。改完跑 `pnpm typecheck`。」
- 「把设置里「她主动找你说话」那一段的提示文字改成我下面写的内容，英文版也要补上。改完跑 `pnpm typecheck` 和 `pnpm test`。」
- 「我放了一个 VMD 动作文件在 `<你的动作文件路径>`。先看它能不能在「模型与动作」里加载，再告诉我要改哪里才能让它出现在动作列表里。先给我计划，我确认后再动手。」

建议第一次让它「先给计划，我确认后再改」，熟悉之后再放手。

## 常见的改动在哪

| 想改什么 | 在哪里改 |
| --- | --- |
| 她的性格、说话方式、开场白、对话示例 | 应用「连接与声音」里的角色卡：新建或复制一张，编辑后点保存。也可以导出 JSON 修改后再导入。格式见 `docs/character-cards.md`。 |
| 换成自己的模型（PMX/PMD）或动作（VMD） | 应用「模型与动作」里选择文件。模型留在你自己的文件夹里即可，不要放进 `assets/bundled/`（那里只放随包发布、已审过的素材）。 |
| 她主动找你说话的频率 | 设置里的「她主动找你说话」，有「少一点 / 适中 / 多一点」三档。更细的数值在 `shared/behaviors/inner-rhythm/knobs.ts` 和 `shared/behaviors/boredom-timing/knobs.ts`。 |
| 脸红、一会儿动一下、回答后停留多久等行为 | 对应行为文件夹里的 `knobs.ts`，例如 `shared/behaviors/blush/knobs.ts`、`shared/behaviors/reply-linger/knobs.ts`、`shared/behaviors/idle-gesture/knobs.ts`。每个数值上方都有一行说明。 |
| 界面上的文字 | `src/ui/` 下对应的面板文件。新增的文字要同时给英文，英文放在 `shared/ui-copy.*.en.ts`。 |
| 她说话的声音（朗读） | 应用「连接与声音」里设置。朗读默认用系统语音，代码在 `src/ui/speech.ts`。 |
| 语音输入 | 应用里设置，代码在 `src/ui/VoiceDraftInput.ts`。 |
| 镜头 | `src/stage/CameraController.ts`。窗口位置和尺寸相关的代码在 `electron/` 下的 `pet-*.ts` 文件里。 |
| 聊天调用 Claude Code 的方式 | `electron/claude.ts`。 |
| 任务执行（读写文件夹、运行命令） | `electron/claude-tasks/`。默认关闭，改动时要保留「写文件和运行命令每次都要用户批准」。 |
| 角色卡的数值（心情、脸红、想念、反应倾向）怎么写、能填多少 | [角色卡和她的数值怎么写](character-card-guide.md)。字段、单位和范围都在那里。 |
| 想让她某个表现不一样，要改哪个数字 | [想改什么 → 改哪里](knobs.md)，按“用户会怎么说”找到对应的文件和名字。 |

改完代码后，在源码文件夹里运行 `pnpm typecheck`，再运行 `pnpm test`。

## 运行和测试

在源码文件夹里打开 PowerShell：

```powershell
pnpm install       # 第一次，或依赖变了以后
pnpm dev           # 开发运行，使用开发配置
pnpm typecheck     # 类型检查
pnpm test          # 全套测试
pnpm build         # 构建
pnpm start         # 用构建结果启动
pnpm smoke         # 启动真实的 Electron，用临时配置检查窗口和聊天
```

- `pnpm dev` 和 `pnpm start` 用的是开发配置 `%APPDATA%\soft-hearts-claude-dev`，不会碰你的正式配置。
- 会长时间占满电脑的命令（比如大批量测试、手动打包），可以用 `node scripts/dev/heavy.mjs --label 名字 -- 命令` 包住。它会在你使用电脑时排队、降低优先级。`pnpm test` 自己已经会这样做。
- 想单独跑某个测试文件：`node scripts/dev/test-all.mjs tests/某个文件.test.ts`。

## 做一个自己的日常版

源码版每次启动都要在终端里运行，不太方便。想要桌面快捷方式，可以做一个"开发版"，试满意后再设为"稳定版"。

1. 在源码文件夹里运行 `start-soft-hearts.cmd desktop`（等同 `pnpm desktop:update`）。它会检查类型、测试和打包，然后装成开发版，桌面出现「soft hearts next - 最新开发版」快捷方式。第一次打包要十分钟以上，源码没变时只刷新快捷方式。
2. 试用满意后，双击 `promote-to-stable.cmd`（等同 `pnpm desktop:promote`）。桌面会出现「soft hearts next - 稳定版」快捷方式。之后的开发版更新不会改动它。
3. 新的稳定版有问题时，运行 `pnpm desktop:rollback`，退回上一个稳定版。它不重新打包，也不动配置。之后再双击 `promote-to-stable.cmd` 就能换回当前开发版。

配置目录的分工：

- 稳定版使用 `%APPDATA%\soft-hearts-claude`。
- 开发版和所有源码运行（`start-soft-hearts.cmd` 打开的、`pnpm dev`、`pnpm start`）使用 `%APPDATA%\soft-hearts-claude-dev`。

同一份配置同时只能开一个桌宠。要打开新版本，先从托盘菜单退出旧的。

只想要一个可以拷走的便携版，可以运行 `pnpm dist:win`，输出在 `release/` 文件夹里。

## 新版本来了怎么保留自己的改动

建议把你的改动放在单独的 git 分支上，这样新版本来了可以合进来，你的改动不会丢。

第一次先建分支：

```powershell
git switch -c my-changes
```

之后每次改完：

```powershell
git status          # 先看一眼：不应该出现模型、聊天记录、密钥、截图
git add -A
git commit -m "写一句你改了什么"
```

新版本来了，取得新版本并合进你的分支：

```powershell
git switch main
git pull
git switch my-changes
git merge main
```

- 如果提示有冲突，让你的 Claude 逐个文件讲清楚两边各改了什么，再解决。
- 拿不准时可以运行 `git merge --abort`，它会回到合并之前的状态，不会丢你的改动。
- 不要用 `git reset --hard` 或 `git checkout -- .`，它们会直接丢掉没提交的改动。
- 你的正式配置和开发配置都在仓库之外，更新代码不会动它们。

如果你是下载 ZIP 解压的，文件夹里没有 git 记录。先用 `git clone` 取得仓库，再把你改过的文件复制过去。

## 想把改动分享回来

这是可选的。觉得某个改动对别人也有用，可以在项目主页（https://github.com/LexZeon/soft-hearts）上：

- 用 Issues 反馈问题，或说明你遇到的情况；
- 先 fork（在网页上复制一份到自己的账号），把你的分支推到自己的 fork，再发起 Pull request（改动建议）。

分享前请确认改动里没有你自己的模型、角色卡原文、聊天记录、密钥或截图。
