# For agents and developers picking this up

<p align="right"><a href="#zh"><img src="images/lang-zh.svg" alt="中文" height="30"></a></p>

soft hearts is made for Claude and for Windows. If you are another agent (connecting another model) or you want to run it on macOS or Linux, read [docs/PORTING.md](PORTING.md) first; it is a map, not a guarantee, and we do not test or maintain other models or systems.

Other people with other systems and other agents (macOS + Codex, Linux + DeepSeek, Linux + OpenCode and so on) can do it too: first read "Plug yourself in: the brain protocol" in PORTING.md. It teaches you to build a relay program that pretends to be `claude`, so that the app takes you as its "brain".

## If you are an agent who wants to be the brain on your own system 🧠

Any system (macOS, Linux, Windows), any agent (Codex, OpenCode, a DeepSeek-backed agent, your own). Work out how to connect yourself, in this order:

1. [docs/PORTING.md](PORTING.md), section "Plug yourself in: the brain protocol": the app starts a program called `claude` and speaks JSON lines with it. Build a small relay that pretends to be `claude` and forwards to your own CLI or API, then point `CLAUDE_PATH` at it. The section lists every argument, every message in and out, the time limits, how a process is cancelled and ended on each system, and what the hidden markers in the reply look like.
2. The same section has a table of starting points by system and agent (all unverified) and a self-check list to run after you plug in: first word, marker leaks, cancel, one archive per reply, no tools added to companion chat.
3. The safety floor in section 5 applies to your relay: no tools added to companion chat (prove there are none, or keep the chat boxed in; see the note under "Rules that hold for every agent"), keys only in the host or your own login, and the user's data goes only to the service the user chose.

## What this is 🧩

A desktop companion: a 3D character (PMX/PMD or VRM model) on the screen that talks, moves, has moods, remembers, and can optionally look, listen and run tasks (all off by default). Electron host, no-framework windows, a Three.js stage. **Made for Claude (through the user's own Claude Code) and for Windows.**

## Where to start 🧭

1. [docs/PORTING.md](PORTING.md): what is Claude-specific, what is Windows-specific, what you would have to provide to connect your own model or run on macOS or Linux, and the safety floor a port must keep. Best effort, not supported.
2. [docs/architecture.md](architecture.md): module boundaries. [docs/developing.md](developing.md): working on it after install.
3. `CLAUDE.md` at the repository root: the working agreement for a Claude Code agent in this repository.

## Rules that hold for every agent 📏

**Changed on 2026-11-26.** Until then "companion chat has no tools, and a port must be able to prove it" was a bottom line. The owner lifted that one line (in short: the software will in future be able to operate the computer through an agent); the other safety rules stay as they are. Today the Claude edition still runs her chat without tools and checks at every start; that code is unchanged. A port that cannot prove there are no tools keeps the chat boxed in instead (file system denied except its own scratch folder, network off for tools, the turn stops the moment a tool request appears, a self-check at every start) and does not add tools to the chat. Later she may act on the computer through the user's own agent; that design is not written yet and nothing of it exists in the app. The details are in section 5 of `docs/PORTING.md`.

- Develop against the development profile (`pnpm dev`), never against a real user profile.
- Do not weaken the safety floor in section 5 of `docs/PORTING.md` to make a change pass: no tools added to companion chat, keys only in the host, perception off by default, one archive per reply, private data stays local.
- Do not commit private models, textures, chat logs, character-card text, keys or screenshots of someone's desktop. Third-party assets live only under `assets/bundled/` with their original credit.
- If you are the Claude installing it for a user for the first time, ask the language first (Chinese or English) and write it to `.local/first-language.txt` before the first launch: `START-HERE.md`, step 2. The app reads it once, on a fresh profile only.
- Put a new feature in its own part's folder and attach it through the wiring files; keep new files small.
- Run `node scripts/dev/test-all.mjs` before you claim something works.

---

<a id="zh"></a>

<p align="right"><a href="#top"><img src="images/lang-en.svg" alt="English" height="30"></a></p>

# 给接手的 agent 和开发者

soft hearts 专为 Claude 和 Windows 做。如果你是别的 agent（接别的模型）或想在 macOS / Linux 上跑它，先读 [docs/PORTING.md](PORTING.md)；它是地图，不是保证，别的模型和系统我们不测试也不维护。

别人用别的系统加别的 agent（macOS + Codex、Linux + DeepSeek、Linux + OpenCode 等）也可以：先读 PORTING.md 里的"Plug yourself in: the brain protocol"（"把你自己接进来：大脑协议"），它教你做一个假装成 `claude` 的转接程序，让应用把你当作"大脑"。

## 如果你是想在自己的系统上当"大脑"的 agent 🧠

任何系统（macOS、Linux、Windows），任何 agent（Codex、OpenCode、接了 DeepSeek 的 agent、你自己的）。按这个顺序弄清怎么把自己接上：

1. [docs/PORTING.md](PORTING.md) 里的"Plug yourself in: the brain protocol"一节：应用启动一个叫 `claude` 的程序，和它用 JSON 行对话。做一个假装成 `claude` 的小转接程序，转发给你自己的命令行或 API，再把 `CLAUDE_PATH` 指向它。这一节列出了每个参数、进出的每种消息、时间限制、各系统上怎样取消和结束一个进程，以及回复里的隐藏记号长什么样。
2. 同一节里有一张按系统和 agent 排的起点表（都没验证过），和一份接上以后要跑的自检清单：第一个字、记号漏出、取消、一次回复只存一次、没有给陪伴聊天加工具。
3. 第 5 节的安全底线同样适用于你的转接程序：不给陪伴聊天加工具（能证明没有就证明，拿不出证明就把聊天关在碰不到东西的地方，见"对每个 agent 都成立的规矩"下面的说明）、密钥只放在主程序或你自己的登录里、用户的数据只发给用户选的那个服务。

## 这是什么 🧩

一个桌面陪伴：屏幕上有一个 3D 角色（PMX/PMD 或 VRM 模型），会说话、会动、有心情、会记事，还可以选择让她看、听、做任务（都默认关闭）。Electron 主程序、无框架的窗口、Three.js 舞台。**专为 Claude（通过用户自己的 Claude Code）和 Windows 做。**

## 从哪里开始 🧭

1. [docs/PORTING.md](PORTING.md)：哪些是 Claude 专属、哪些是 Windows 专属、要接上你自己的模型或在 macOS、Linux 上跑你得自己提供什么，以及移植必须保住的安全底线。尽力而为，不提供支持。
2. [docs/architecture.md](architecture.md)：模块边界。[docs/developing.md](developing.md)：装好以后怎样改。
3. 仓库根目录的 `CLAUDE.md`：这个仓库里 Claude Code agent 的工作约定。

## 对每个 agent 都成立的规矩 📏

**2026-11-26 改了一处。** 在此之前，"陪伴聊天不带工具，而且移植必须能证明"是一条底线。用户把这一条去掉了（大意：以后的软件是能借 agent 操作电脑的），其他安全规矩照旧。Claude 版今天仍然让她的聊天不带工具，每次启动都检查，这部分代码没变。拿不出"没有工具"证明的移植，改为把聊天关在碰不到东西的地方（文件系统拒绝，只留它自己的临时文件夹；工具走的网络关掉；一出现工具请求就停这一轮；每次启动自检），并且不给聊天加工具。以后她也许会借用户自己的 agent 去操作电脑；这个方案还没写，应用里现在没有它的任何部分。细节见 `docs/PORTING.md` 第 5 节。

- 对着开发配置（`pnpm dev`）开发，不要对着真实用户的配置。
- 不要为了让一个改动通过而削弱 `docs/PORTING.md` 第 5 节的安全底线：不给陪伴聊天加工具、密钥只在主程序里、感知默认关闭、一次回复只存一次、私人数据只留在本机。
- 不要提交私人模型、贴图、聊天记录、角色卡文字、密钥，或别人桌面的截图。第三方素材只放在 `assets/bundled/` 下，并保留原来的署名。
- 如果你是第一次替用户安装的 Claude，先问语言（中文还是 English），第一次启动之前把它写进 `.local/first-language.txt`：见 `START-HERE.md` 第 2 步。应用只读它一次，而且只在全新的配置上。
- 新功能放进它自己那个部分的文件夹，通过接线文件接入；新文件保持小。
- 说"好了"之前，先运行 `node scripts/dev/test-all.mjs`。
