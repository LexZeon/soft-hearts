# Porting guide: other models, macOS, Linux

**中文摘要**

- soft hearts 是**专为 Claude 和 Windows 做的**：聊天走用户自己电脑上的 Claude Code，桌面行为按 Windows 调过。别的模型和系统**不测试、不维护、不保证**。
- 这一页是给想把它接到自己的模型（比如 DeepSeek、ChatGPT 一类的 API 或命令行）、或者想在 macOS / Linux 上跑的 agent 和开发者的地图：哪些是 Claude 专属、哪些是 Windows 专属、各做什么、你要自己提供什么、哪些行为换了模型会变差、测什么先。
- 不管换什么，下面第 5 节的安全底线要原样保住：密钥只在主机里；窗口拿不到 Node 和任意路径；屏幕、摄像头、麦克风默认关，只有用户本人的话能打开；一次回复只存一次；私人数据不出本机。
- **想把自己接成大脑的 agent，先读"Plug yourself in: the brain protocol"一节**（第 2 节之后）：怎么做一个假装成 `claude` 的转接程序（`CLAUDE_PATH` 指向它）、应用写给它什么、从它读什么、取消和结束进程、隐藏记号、安全底线，加一张 macOS / Linux / Windows × Codex / DeepSeek / OpenCode 的起点表（都未验证）和一份自检清单。适用于任何系统加任何 agent。
- **哪里写的是 Claude，都能换成你自己的 agent**（第 3.5 节"Where the app says Claude"）：界面上显示的名字（「Claude 助手」「由 Claude 操作」「Claude 任务」）改 `shared/foundation/assistant-name.ts` 里的两行就跟着变；真正去调用 Claude Code 的地方（常驻聊天进程、一次性小判断、任务执行、内部通道、安装和发现、诊断），按上面"Plug yourself in"把你的 agent 接进去就行；写给她看的、讲 Claude 的那些提示词要自己改写。不是 Claude 的移植版不要自称 Claude。
- 这是尽力而为的说明：能读懂、能接上，仅此而已。
- 这份是写给**用户自己的 agent**（Claude、ChatGPT、DeepSeek 等）的参考：项目本身不会去适配别的平台，是让用户的 agent 照着这些资料，在他们自己的系统上接起来。

---

## 1. What this is, and what it is made for

soft hearts is a desktop companion: a 3D character (a PMX/PMD or VRM model, rendered with Three.js) lives on the screen, talks with the user, moves, has a mood, remembers, and can optionally look, listen and run tasks, each behind a switch that is off by default.

It is **made for Claude and for Windows**. This is a design choice, not an accident of history:

- **Claude.** Chat runs through the user's own Claude Code installation and login (the app never reads, stores or forwards a credential). The companion relies on things Claude Code gives it: a long-lived `claude -p` process that keeps a conversation, token-level streaming, prompt caching (the fixed character prompt is written once and re-read cheaply, which is what makes the first word fast), a fast cheap small model (haiku class) for dozens of tiny background judgments, a tool-free launch mode that can prove it has no tools, and an MCP-capable CLI so the user's own Claude can operate the app. Her reply filters and hidden markers were tuned on Claude's habits.
- **Windows.** The window behaviour (transparent, click-through, always-on-top levels, full-screen detection, taskbar and work-area handling), the install and update flow (shortcuts, portable builds), the monitor measurement, system-audio capture, and the offline component packs were built and verified on Windows 11 (x64 and arm64) only.

Not made for: other model vendors, other operating systems. They may work after the changes described here; nobody here tests or maintains them (section 6).

## 2. Architecture in one page

- **Stack.** Electron host (`electron/`, TypeScript, Node), no-framework windows (`src/`, DOM code plus a Three.js stage), shared pure logic (`shared/`), tests (`tests/`, run with `node scripts/dev/test-all.mjs`), scripts (`scripts/`). Node 22.12+, pnpm.
- **Parts.** Twelve parts, each with a folder under `electron/`, `shared/` and `src/`, and a public `index.ts`: cards, voice, unbound (the full-screen mode), safety (connections, tasks, the internal channel), initiative (what she does on her own), memory, senses, mood, brain, stage, settings, actions (body motion). A part never reaches into another part's internals. Shared types and small stateless helpers live in `shared/foundation/`, `electron/foundation/`, `src/foundation/` and import no part.
- **Wiring.** Only the wiring knows every part. Host side: `electron/main.ts` (entry and order of startup) and `electron/wiring/*-wiring.ts`. Window side: `src/main.ts` picks the window and calls the start steps in `src/wiring/*.ts`. New features go into their own part and are attached in wiring; they do not grow `main.ts`.
- **What a window can reach.** `DesktopAPI`: the type is assembled in `shared/contracts.ts` from per-part slices `shared/<part>/desktop-api.ts`, and a typed preload whitelist (`electron/safety/preload.ts`) exposes exactly those calls. A window gets no Node, no key, no arbitrary path, no generic shell or RPC. Adding a call means a slice entry plus a typed preload entry; `tests/contracts-surface.test.mjs` pins the whole surface.
- **Where the brain is.** `electron/brain/` plus `shared/brain/`. Wiring in `electron/wiring/brain-wiring.ts` and `brain-chat-wiring.ts`. Chat turns: `electron/brain/claude-session.ts` (one long-lived process), `electron/brain/session-pool/` (one warm session per character), `electron/brain/claude.ts` (single-shot calls, launch arguments, stream reader), `electron/brain/claude-launch/` (a worker thread that starts and ends the processes). Small judgments elsewhere reach the model through one function (`quickLineWithClaude`, `electron/initiative/inner-loop/model.ts`).
- **State.** Everything is under the Electron `userData` folder of a named profile; data is registered in a map (`electron/foundation/data-map-*.ts`) that deletion and the recycle bin follow.
- More: `docs/architecture.md` (module boundaries), `docs/developing.md` (after install), `docs/character-cards.md`.

## Plug yourself in: the brain protocol

**Read this first if you are an agent (Codex, OpenCode, an agent wired to DeepSeek or another provider, or anything else) and your human wants you to be the "brain" on their own system, whether that is macOS, Linux or Windows.** Everything below was read from the code at the time of writing; none of it has been run against any agent other than Claude Code. The code is the authority: if a line here and the code disagree, believe the code and fix this page.

### The shortest path: a relay program that pretends to be `claude`

The app does not talk to a model API. It starts a program called `claude`, writes JSON lines to its stdin, and reads JSON lines from its stdout. So the least invasive port is a **relay**: a small program that accepts the part of Claude Code's command line the app uses, speaks the same stream-json lines, and inside forwards to your own CLI or API. Then point `CLAUDE_PATH` at the relay. No app code changes, and every safety check keeps running against your output.

How to do it, in order:

1. Read the fake Claude that already speaks this protocol: `scripts/lib/fake-claude.mjs`. `createFakeClaude()` is the whole protocol as a pure function (`line()` takes one stdin line, an `output` callback gets the stdout events); the `main()` at the bottom is a twenty-line stdin/stdout loop around it. It is a test-harness stand-in (it insists on the app's exact argv and answers a fixed sentence), so copy its shape, not its checks. `tests/helpers/fake-claude-stream.ts` shows the queueing and interrupt behaviour measured on a real Claude Code; `tests/fixtures/fake-claude-task.mjs` is a second example.
2. Write your relay so that, for each user message, it prints one `system/init`, then streamed text, then one `result` (details below). Start with a fixed reply like the fake does, then wire the text to your backend.
3. Make it launchable by the app. The app starts it with `shell: false`: on macOS and Linux an executable file with a `#!/usr/bin/env node` (or other interpreter) first line works; on Windows it must be a real `.exe` (a `.cmd`, `.bat` or `.ps1` shim cannot be started this way), for example a packaged single executable.
4. Run the app on the development profile with the variable set: `CLAUDE_PATH=/path/to/relay pnpm dev` (set it the way your shell sets variables; never aim it at a real profile). `CLAUDE_PATH` must name an existing file; if it does not, the app reports an error and does **not** fall back to searching.

### How the app finds and starts `claude`

- **Which file.** `findClaude` in `electron/brain/claude.ts` calls `discoverClaude` in `scripts/claude-discovery.mjs`: `CLAUDE_PATH` if set (an exact file; a wrong path is an error, no fallback); otherwise `claude` (`claude.exe` on Windows) in each `PATH` directory; otherwise a finite list: `~/.local/bin`, `/opt/homebrew/bin` (macOS), `/usr/local/bin`, `/usr/bin`; on Windows `%USERPROFILE%\.local\bin`, the WinGet links folder and the npm global install folder. It only checks file metadata and never runs a candidate. `scripts/setup.mjs` (`pnpm setup:unix`) uses the same finder and prints next steps.
- **How it is started.** One worker thread starts every process (`electron/brain/claude-launch/`, so the UI thread never waits): `shell: false`, three pipes, hidden window, working folder = a fresh **empty** temporary folder per process.
- **Environment.** The app's own environment minus every variable beginning with `CLAUDE` except a short keep list (`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_GIT_BASH_PATH`, the `CLAUDE_CODE_USE_*` and `CLAUDE_CODE_SKIP_*_AUTH` ones), minus `ELECTRON_RUN_AS_NODE`, plus `NO_COLOR=1` and `DISABLE_AUTOUPDATER=1`. Your own provider variables (an API key in the user's environment, for instance) pass through untouched; `CLAUDE_PATH` itself is not passed to the child. See `claudeEnvironment` in `electron/brain/claude.ts`.
- **The command line of a companion-chat process** (`claudeArguments`, in this order):

  ```
  -p
  --input-format stream-json
  --output-format stream-json
  --verbose
  --include-partial-messages
  --tools ""
  --strict-mcp-config
  --safe-mode
  --disable-slash-commands
  --no-session-persistence
  --setting-sources ""
  --system-prompt <text, at most 20000 characters>
  [--model <name>]             only if the saved model is a Claude alias or id (below)
  [--effort low|medium|high]   only on a few one-shot calls
  ```

  `--tools ""`, `--strict-mcp-config`, `--safe-mode`, `--disable-slash-commands` and `--setting-sources ""` are the "no tools, no MCP, no user settings" promise. Your relay must keep that promise, not ignore the flags (see the safety floor below). `--model` is passed only when the name is `default`, `fable`, `opus`, `sonnet`, `haiku` or `opusplan` (each optionally with `[1m]`), contains `claude`, or is a Bedrock ARN; anything else is dropped. So your relay sees `--model haiku` for the small background judgments and either nothing or a Claude alias for chat: map those names to your own small and large models.
- **Other launch shapes you can leave unsupported.** The optional task runner (`electron/safety/claude-tasks/process.ts`) and the user-assistant process (`electron/safety/assistant/process.ts`) add `--tools` with names, `--mcp-config`, `--permission-prompt-tool`, `--restricted` and so on. They only start when the user switches those features on. A relay that exits non-zero on those flags leaves them off, which is the safe default.
- **`claude mcp add/get/list/remove`.** When the user opens the internal-channel panel, the app can run these through the same binary to register its MCP server with the user's own Claude Code (`electron/safety/agent-channel/claude-code-link.ts`). A relay does not need them: make `mcp` exit non-zero. If your agent supports stdio MCP servers, register the app's server in your own way instead; the control window prints the same entry as JSON (`mcpServers: { name: { command, args, env } }`, built by `electron/safety/agent-channel/setup-text.ts`), and the server is `scripts/soft-hearts-mcp.mjs`. Read section 5 first: a new caller needs a fresh safety review.

### What the app writes to stdin (one JSON object per line)

1. **A user turn:** `{"type":"user","message":{"role":"user","content":[ {"type":"text","text":"..."}, ... ]}}` followed by `\n` (`claudeInput`). Content is an optional first text block (a cacheable preface), then the prompt text block, then up to 2 image blocks `{"type":"image","source":{"type":"base64","media_type":"image/png"|"image/jpeg"|"image/webp","data":"..."}}`. The prompt text carries the character, mood and memory for this turn and a `<conversation-data>` JSON block (`currentUser`, `history`). Images only appear when the user has switched a sense on.
2. **An interrupt:** `{"type":"control_request","request_id":"interrupt-<uuid>"|"supersede-<uuid>","request":{"subtype":"interrupt"}}`. Used when the user presses stop, talks over her, switches character, or keeps talking (supersede).
3. **End of input:** the app closes stdin when it is done with the process.

The app writes the next user message only after the previous turn's `result` was read (or the process is gone). One-shot calls and the one-process-per-message fallback write one user line and close stdin straight away.

### What the app reads from stdout (one JSON object per line, `\n`-terminated)

For every user turn, in this order (`ClaudeStreamReader` in `electron/brain/claude.ts`, `ClaudeChatProcess.line` in `electron/brain/claude-process.ts`):

1. `{"type":"system","subtype":"init","session_id":"...","model":"...","tools":[],"mcp_servers":[], ...}`. **Before any text.** `tools` and `mcp_servers` must be present and empty arrays; missing or non-empty stops the turn as unsafe. Text arriving with no init seen is also a stop. Claude Code sends one per turn; the app checks each. `model` is only logged.
2. Streamed text as `{"type":"stream_event","event":{...}}` with inner events: `message_start`, `content_block_start` (`content_block.type` must be `text`, `thinking` or `redacted_thinking`; any other type is read as a tool request and stops the turn), `content_block_delta` with `{"type":"text_delta","text":"..."}` (this is what is shown and spoken; send small deltas in order, and send the first one as early as you can), `content_block_stop`, `message_delta` (`delta.stop_reason`; the value `refusal` marks a refusal), `message_stop`.
3. Optionally `{"type":"assistant","message":{"id":"...","role":"assistant","content":[{"type":"text","text":"..."}]}}`. It is used as the text only if you sent no deltas at all; do not send both with different text.
4. `{"type":"result","subtype":"success","is_error":false,"result":"<full text>","usage":{...},"total_cost_usd":0}` ends the turn. Fields read from `usage`: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` (all optional, numbers only). Failure: `is_error: true` or a `subtype` other than `success`, with `result` (or `errors`) holding a text. The failure kind (quota, login, rate limit, offline, certificate, other) is guessed from English phrases in that text (`shared/brain/claude-failure.ts`); anything unknown falls into "other", which is safe.
5. For an interrupt: `{"type":"control_response","response":{"subtype":"success","request_id":"<same id>"}}`, then the interrupted turn's own `result` (an error subtype is fine). Without that `result` inside 3 seconds the app kills the process. For a request you do not support, answer with an error `control_response`; the app then ends the process or lets the turn run on.
6. Optional: `{"type":"system","subtype":"api_retry","attempt":n,"error_status":null|number}`. A number means "the server answered"; `null` from the second attempt on makes the turn end as offline. A turn with no event at all for 30 seconds also ends as offline.

Hard rules the app enforces on your output: no output outside a turn (the app then closes the process as out of step); lines up to 2,000,000 characters; a reply over 100,000 characters is cut off; exactly one final `result` per user message.

### Sessions and continuing a conversation

The app uses **none** of Claude Code's resume features: it never passes `--resume`, `--continue` or `--session-id` (and `--no-session-persistence` is always on). `session_id` in the events is not read. Continuity comes from the long-lived process itself: your relay process keeps the messages it received on stdin as the conversation and appends each reply. A process is replaced after 10 minutes idle (3 when the window is hidden), after 12 turns or 60,000 characters, on a crash, or when the character changes; the new process starts empty, and the app rebuilds the context inside the prompt text (`history` in `<conversation-data>`). So your relay needs no storage: keep an in-memory message list per process and forget it on exit. If your backend has no multi-turn state, resend that list each turn. The app keeps up to three warm processes (one per character) and may start one before any message arrives; do not print anything until a user message comes.

### One-shot small judgments

About two dozen small background calls (reaction, mood, notes, diary, and so on) start a fresh process with the same flags but their own `--system-prompt` (often "answer with one JSON object" or "one sentence"), `--model haiku` and sometimes `--effort`. They write one user line, close stdin, read until the process exits, and need **exit code 0** after a success `result`; a non-zero exit or empty text is a failure. Return the model's text exactly: no wrapper, no code fence, no commentary, because the callers parse the last JSON object or the whole line. Limits: 120 seconds overall (some long calls set their own idle limit) and 30 seconds to the first event. A slow or costly small model makes these calls dominate time and cost; a weak one makes the app drop answers, so features go quiet instead of wrong.

### Time limits to respect

A chat turn: 120 s overall; first event within 30 s; an interrupted turn must send its `result` within 3 s. After boot and after 30 minutes without a successful answer, the app starts one process at a time until one has streamed its first event (the start gate, `electron/brain/claude-start-gate.ts`; the wait is bounded). It exists because Claude Code rotates login tokens; your relay can ignore the reason but should still send its first `stream_event` promptly once the backend answers.

### Cancelling and ending the process

- Normal stop: the interrupt message above. Stop writing text at once (the app discards anything after the abort, but your relay must not keep generating for a stopped turn).
- Ending a process: stdin is closed first, then `terminateClaude` (`electron/brain/claude.ts`; run from the worker in `electron/brain/claude-launch/off-main.ts`). **Windows:** `taskkill /PID <pid> /T /F` (the whole process tree), then a plain kill if it still has not exited. **macOS and Linux:** one `SIGTERM` to your relay's pid, not to a process group. So your relay must exit on stdin end and on `SIGTERM`, and must itself stop any child CLI or HTTP request it started; a relay that leaves its child running leaks processes on Unix.

### What the app expects inside the text

You do not have to understand the markers, only to pass text through byte for byte and in order. The model you forward to does need to follow the prompt that asks for them.

- **The opening marker.** The fixed system prompt names the marker `<sh-open>`; the reply is expected to begin with it, and only what follows it is shown, spoken and archived (text before it is dropped, whatever it says; this is the guard against leaked reasoning). If the model forgets it, the app holds the whole reply until it is complete and then cuts by other rules, which adds roughly one to two and a half seconds before the first word. The relay must not add text before it.
- **The tail.** After the reply the model writes blocks wrapped in a per-turn random token taken from the prompt: `<sh-state-HEX>...</sh-state-HEX>` (mood reaction, gesture, user-state judgment), and sometimes `<sh-memorial-HEX>`, `<sh-setting-HEX>`, `<sh-file-HEX>` (HEX is this turn's token, 32 hex characters). The app strips them before anything is shown or spoken; an unknown or malformed one is dropped, never shown. The look markers `⟦look-camera⟧` and `⟦look-screen⟧` and the pacing words are stripped the same way.
- **Do not translate, wrap, summarise or re-chunk.** Do not put your own reasoning, logging or tool traces into `text_delta`; send reasoning only as `thinking` blocks, or not at all.
- **One archive per reply.** The app saves a reply once, from its own accounting. Your part: exactly one `result` per user message, and nothing at all after an abort.

Code to read first: `electron/brain/claude-launch/` (how processes start and end), `electron/brain/claude-process.ts` (turns, interrupt, time limits), `electron/brain/claude.ts` (`claudeArguments`, `claudeInput`, `ClaudeStreamReader`, `findClaude`, `claudeEnvironment`, `streamClaude`), `scripts/claude-discovery.mjs`, then the fakes named above and their tests: `tests/smoke-fake-claude.test.ts`, `tests/claude-session.test.ts`, `tests/claude.test.ts`.

### Safety floor for a relay

These are not negotiable (the same floor as section 5):

- **The relay must not give companion chat tools.** If your CLI or API can run commands, read files, browse or load MCP servers, turn that off when the relay forwards (or refuse to run), and keep `tools: []` and `mcp_servers: []` in `init` true. Never forward a tool request to the app as text; if your backend asks for a tool, end the turn with an error `result`. Do not read the user's own agent settings into the chat.
- **Keys stay in the main process or in your own CLI's login.** The app never hands a key to a window. Do not write a key into the relay's source, a log or the command line (the command line is visible to other programs).
- **Do not send the user's data to a service the user did not choose.** The prompt text carries private conversation, memory and sometimes a camera or screen frame. It may go to the backend the user picked for this app and nowhere else: no extra logging service, no telemetry, no second model "for quality". Do not save frames or prompts to disk.
- **Keep the other two switches off until reviewed:** task execution and the internal MCP channel (sections 3.1 and 5).

### Where to start, by combination (a starting point, not a promise)

None of these rows has been tested by the maintainers. "Unverified" means exactly that: look up your own CLI's current non-interactive and streaming options and do not copy flag names from this page; none are given here on purpose.

| System and agent | Where to hook in | Watch out for | First thing to verify |
|---|---|---|---|
| **macOS + Codex** | Relay that forwards to Codex's non-interactive or JSON-event mode (look up your CLI's non-interactive, JSON-stream mode; unverified). | Streaming granularity (a mode that emits only whole messages makes the first word late); whether tools and shell are really off for chat (require proof, see the safety floor); cancel by ending the child on `SIGTERM`; MCP support differs. | Hand test: pipe one `user` line into the relay and see `init`, deltas, `result`. |
| **macOS + DeepSeek** | Relay that calls an OpenAI-compatible chat-completions endpoint with streaming on, mapping each streamed content piece to a `text_delta` (unverified for your account: model names, limits, the exact fields). | Keep your own message list; send no tool definitions; abort the HTTP request on interrupt and on `SIGTERM`; a reasoning model may emit reasoning text, which must not go into `text_delta`; check that the model follows the closed markers. | Same hand test, then a small one-shot (`--model haiku` shape) that must return strict JSON. |
| **Linux + DeepSeek** | Same as macOS + DeepSeek. | Same, plus: a GUI launch does not inherit your shell variables, so keep the key where your relay reads it (its own owner-only config file), not in the app's environment; make the relay file executable. | Same, then `pnpm dev` with `CLAUDE_PATH` set from a launcher that has the display. |
| **Linux + OpenCode** | Relay that forwards to OpenCode's non-interactive mode, or to its local server if it has one (look up its current docs; unverified). | Whether it has a no-tools mode you can prove; streaming support; process cleanup on `SIGTERM`; MCP is its own concern. | Hand test, then check that no tool list is anywhere in what the relay forwards. |
| **Windows + another agent** | Relay compiled to a `.exe` (a `.cmd` shim cannot be started) forwarding to that agent's CLI or API (unverified for any particular agent). | The app ends the tree with `taskkill /T /F`, so child processes die with the relay; pass the long system prompt to your backend as data, never through a shell command line. | Hand test from a terminal, then `pnpm dev`; this is the system the app was built on, so window behaviour should already work. |

### Self-check for the agent that plugged itself in

Do these in order; stop at the first one that fails and fix it before going on.

1. **Run the app on the fake Claude first.** Before your relay exists, prove your machine can run the app: `pnpm install`, `pnpm typecheck`, then `node scripts/dev/test-all.mjs` (on macOS and Linux expect Windows-only failures; sort them as in section 4.3). The packaging smoke (`pnpm smoke`, `scripts/smoke.mjs`; read its header first) runs the app on an isolated throw-away profile with the fake Claude, never a real profile or a real model. Then `pnpm dev` and see the bundled Gene model render.
2. **Swap in your relay.** Hand test it without the app: pipe one user line into it, check that `init`, deltas and `result` come out as above and that it exits when stdin closes. Then `CLAUDE_PATH=<relay> pnpm dev` and send one message.
3. **First character.** Note how long until the first word appears. The design target is the first sentence within about a second after the model starts; a backend that streams only whole messages will miss it, and that is a finding to report, not something to hide.
4. **Hidden markers do not leak.** Over at least a dozen replies, look for `<sh-` text, `⟦look`, raw JSON, or reasoning and "plan" text on screen or in the spoken voice. If any shows, the model is ignoring the closed markers or your relay adds text; do not paper over it in the app.
5. **Cancel stops.** Press stop mid-reply, switch character mid-reply, and talk over her: nothing may appear afterwards and no relay or backend process may remain (check the process list; on Unix this tests your `SIGTERM` handling).
6. **One reply is stored once.** After a normal reply, an interrupted one and a superseded one, the conversation history must hold each exactly once (look through the app on the development profile, not by editing files).
7. **No tools in companion chat.** The relay's `init` has empty lists, your backend request carries no tool definitions, and a deliberate "run this command" message produces words, not an action. Run `tests/brain-gates.test.ts`, `tests/claude.test.ts` and `tests/claude-session*.test.ts` against your changes; do not weaken them.
8. **Small calls.** One-shot calls return exit code 0 with clean text or JSON; try a slow and a failing backend and check that the app shows its quiet "she cannot answer" state instead of freezing.
9. **Report honestly.** Write down what you measured and what you did not, in your own fork's notes; this repository does not promise your combination works.

## 3. Replacing the brain

Everything that depends on Claude Code is listed by seam below. The rest of the app talks to these seams, not to Claude directly, so replacing the brain means re-implementing the seams, not editing the companion.

### 3.1 The seams

| Seam | Today | Where | What your replacement must provide |
|---|---|---|---|
| **Companion chat turn** | One long-lived `claude -p --input-format stream-json --output-format stream-json --include-partial-messages` process per character; the user message goes to stdin each turn; text arrives as incremental events | `electron/brain/claude-session.ts` (`PersistentClaudeChat.stream`), `claude-process.ts`, `claude-session-prompt.ts`, pool in `session-pool/` | `stream(task, signal, emit, control?)`: stream text with `emit('delta', text)`, keep context across turns (or rebuild it each turn, slower), honour `signal` (after abort no more text may come out), start a new context on `close('context')`. The prompt and image getters on `task` must be read when written out, not earlier. |
| **No tools in companion chat** | Launch arguments disable all tools, MCP, slash commands, user settings and session persistence; start-up report (`system/init`) must list no tools and no MCP servers; any tool block in the stream stops the turn | `electron/brain/claude.ts` (`claudeArguments`, `ClaudeStreamReader`) | A way to prove the model has no tools (or to refuse the turn), a runtime stop when a tool request appears, and a refusal of any task whose `kind` is not `'chat'` or that is `writable`. Safety floor item 1. |
| **One-shot small calls** | A fresh `claude -p` per call with its own system prompt and model name; most answer one line of text or one JSON object | `streamClaude` in `electron/brain/claude.ts`; the port `ClaudeLinePort` (`shared/foundation/ports.ts`: `line(prompt, systemPrompt, signal) -> { text }`, no tools in the type); `quickLineWithClaude` | One function: prompt + system prompt (+ optional image) in, text and usage out, cancellable, with a hard time limit. About two dozen callers use it (reaction judgment, mood judge, pause placement, inner loop, notes, diary, model check, and so on). |
| **Model tiers** | Small judgments use the `haiku` alias (cheap and fast); the companion's own voice uses the chat model; empty chat model means Claude Code's default; aliases are validated before they reach `--model` | `shared/foundation/defaults.ts` (`CLAUDE_MODEL_ALIASES`), `shared/brain/claude-model.ts`, `electron/initiative/inner-loop/model.ts` | A small-model name and a large-model name that map onto your provider. Expect to touch the alias list and the one hard-coded small model. |
| **Availability and failure text** | Failures are classified from Claude Code's English error phrases (quota, login expired, rate limit, offline, certificate, program missing); the offline fast-path reads `system/api_retry` events; reset times are parsed from text | `shared/brain/claude-failure.ts`, `electron/brain/chat-availability*.ts`, `chat-outage.ts` | A classifier for your provider's errors that returns the same closed set of kinds. Unknown errors fall into "other" safely. |
| **Process start gate and discovery** | One Claude process starts at a time after boot and after 30 minutes without a successful answer (Claude Code rotates its own login tokens; concurrent refresh can log the user out); `claude` is found on `CLAUDE_PATH`, PATH and the official install locations | `electron/brain/claude-start-gate.ts`, `scripts/claude-discovery.mjs`, `findClaude` in `electron/brain/claude.ts`, `scripts/setup.ps1` (a second copy of the list) | Your own locator and login check. If your brain is an HTTP API, the gate is unnecessary; keep the "one at a time" idea only if your login has the same hazard. |
| **Internal channel (MCP)** | A small stdio MCP server lets the user's own Claude Code change her character, settings and voices; about 40 tools in three tiers (read only, direct, needs the user's own words in `userWords`); the app registers it with `claude mcp add` | `scripts/soft-hearts-mcp.mjs`, `electron/safety/agent-channel/` (`registry.ts`, `app-tools.ts`, `claude-code-link.ts`, `tools/`), catalog `shared/safety/agent-channel-catalog.json` | A client that can call stdio MCP tools (or reuse the registry and write another transport). The app cannot verify that `userWords` is really the user's sentence: that rests on the caller, so a new caller needs a fresh safety review. Sensitive actions (privacy, spending, deletion, loading files) still raise an in-app dialog. |
| **Task execution (optional, off by default)** | A separate `claude -p` process with a restricted tool list; reading is automatic, writing and running commands ask the user each time through a local permission server; start-up report is verified (`permissionMode`, tools, servers, working folder) | `electron/safety/claude-tasks/` (`process.ts`, `policy.ts`, `permission-server.ts`) | A task runner that can hand every write and command to the app for approval and wait for the answer, plus a start-up check like `verifyTaskInit`. If yours cannot, leave task execution disabled. |
| **Her text and hidden markers** | The model writes extra structure that the app strips before anything is shown or spoken: an opening marker with a per-turn code (default off), a tail block (mood reaction, gesture, user-state judgment, settings proposal, keepsake), speech-beat words for pacing, look markers when she wants a clearer camera or screen frame, alarm markers; each is wrapped in a random token per turn | `electron/mood/mood-chat.ts`, `electron/brain/reply-opening.ts`, `electron/brain/speech-beats/`, `electron/brain/look-continuation.ts`, `electron/brain/reply-draft-guard.ts`, prompts in `shared/brain/companion-rules.ts` and `electron/brain/claude-session-prompt.ts` | A model that follows closed-vocabulary markers reliably. Every parser fails closed (an unknown or malformed marker is dropped, never shown), but a model that ignores them gives you a flat, less alive companion. Re-collect the leak shapes of your model into the draft guard. |
| **Install text and UI wording** | `START-HERE.md`, `README.md` and several UI strings say "Claude" | `src/safety/AgentChannelPanel.ts`, `shared/safety/agent-channel.ts`, `src/cards/CharacterUnderstanding.ts` and similar | (names: see 3.5) Your own names and install steps. |
| **Memory scope** | Chat memory is keyed by character plus connection (the connection includes the model name) | `electron/memory/memory.ts` (`scopeKey`) | A stable connection id. Changing the brain on an existing profile makes memory look disconnected (it is not deleted); decide on purpose whether to keep the scope. |

### 3.2 What behaviour depends on Claude

- **Closed hidden markers and the speak-first marker.** The reply protocol assumes the model reliably emits a few fixed-vocabulary blocks. All parsers are strict and drop what they do not recognise, but quality depends on compliance.
- **Prompt caching.** The fixed character prompt, the per-character warm process and the pre-warm of the next process are designed around cache reuse by working directory and content-block prefix. Without caching, first-word latency is probably several times longer and each turn costs more.
- **Haiku-sized judgments.** About two dozen background calls assume a small, cheap, fast model that answers strict one-line JSON or one short sentence. With a slower or pricier model these calls dominate cost and time; with a weaker one the parsers will drop answers and features go quiet instead of wrong.
- **Streaming cadence.** The first-word target (the first sentence within about a second) was measured against Claude Code's stream chunking, which pauses 0.2 to 0.5 seconds after the first chunk. Another provider has different cadence; re-measure.
- **Interruption.** Stop and supersede rely on a `control_request` interrupt with a grace period and then a process kill. A provider without cancellation by id must at least guarantee that nothing more is delivered after abort.
- **The model's own habits.** The draft filter and JSON "last object" extraction handle leaks that Claude produced (reasoning text, tags in front of an answer). Other models leak differently.

### 3.3 What will probably degrade on another model

Voice of the character (the prompts were tuned on Claude; "does she still sound like herself" must be re-tested), first-word speed, marker compliance (mood reactions, gestures, pacing), the background judgments (reaction, mood, notes, diary quality), image understanding quality for the sense features, and refusal behaviour. The companion's rules (`shared/brain/companion-rules.ts`) are written in Chinese and tuned to Claude's instruction following.

Running on another model only (for example DeepSeek through a relay posing as `claude`) is possible, with these caveats a port should check first:

- **Images.** Each turn can carry small pictures of the screen and the camera, and the watch-together and look features describe frames. If the model cannot take images, those features stop working or need a second, vision-capable model for the one-shot calls.
- **Hidden markers.** Expressions, gestures, walking, frames, alarms, the milestone and notes are invisible markers she writes inside her reply. A model that follows the format loosely may skip them, misspell them or let them show in the bubble; the filter hides only well-formed ones.
- **Speed.** First-word speed leans on prompt caching of the fixed character prompt and a warm process; another provider caches differently, so the first word may come later.
- **An agent, not only a model.** Task execution (reading and writing files with the user's approval) and the internal channel (MCP tools the user's own agent calls) need an agent shell with tools and MCP, not a bare chat model; pick an agent that supports the model you use.
- **Not tested by us.** The app is tuned on Claude; whether she still feels like herself on another model is for the port to judge.

### 3.4 A reasonable order for a brain port

1. Implement the one-shot port (`ClaudeLinePort`, `streamClaude`) with a different backend and get the small background judgments working.
2. Implement `PersistentClaudeChat.stream` against your streaming API, keep the "no tools" assertions, cancellation and one-turn-at-a-time rules, and make the tests in section 5 pass against your brain.
3. Replace discovery, login checks, failure classification and UI wording.
4. Leave the internal channel and task execution disabled until you have reviewed their safety rules for your caller.
5. Re-tune the prompts and re-measure first-word latency and marker compliance.

### 3.5 Where the app says Claude

**Every place listed here can be changed to your own agent.** The name people read is one line; the places that actually run Claude Code are changed by plugging your agent in, as described in "Plug yourself in: the brain protocol" above. Nothing on this list is locked.

Guidance, not a lock: a port that is not running on Claude should show its own name and not claim to be Claude; a port that is running on Claude should leave the name as it is.

**The name, in one place.** `shared/foundation/assistant-name.ts`:

```ts
export const ASSISTANT_NAME: string = 'Claude';          // 「Claude 助手」, 「由 Claude 操作」, "your Claude"
export const ASSISTANT_CLI_NAME: string = 'Claude Code'; // 「你的 Claude Code」: what the program that runs the agent is called on screen
```

Change those two lines and the screen text follows. It reaches the screen by two routes:

1. Text that passes `t()` (`shared/foundation/ui-language.ts`) or the window markup helpers (`src/foundation/ui-language.ts`: `uiText`, `uiMarkup`, `uiHtml`) is swapped at the last step by `applyAssistantNames()`: whole-word `Claude Code` becomes `ASSISTANT_CLI_NAME`, whole-word `Claude` becomes `ASSISTANT_NAME`; `Claudette` or a lower-case `claude` command is left alone. The dictionaries (`shared/foundation/ui-copy.*.en.ts`) keep the word as written, because the English text is looked up by the exact Chinese source sentence.
2. Host-side messages that never pass `t()` (errors, notices, dialogs, tool results, data-map rows, diagnostics) are built from the constants in template strings.

On this build both routes give exactly the text that was shown before. `tests/claude-names.test.mjs` pins that and shows that changing the names changes both routes. `scripts/dev/claude-names-scan.mjs` lists every string that still holds the word, `scripts/dev/claude-names-allowlist.json` says which files may and why, and the test fails when a new hard-coded name appears.

Known limit: when a host-side message that now carries the constant is also an English-dictionary key, the key is the exact words; if you rename the agent, such an English entry no longer matches and the Chinese words show. Edit the key together with the name.

**Class A: names shown to the user (rename with the constant)**

| Where | What she or the user reads |
|---|---|
| `shared/foundation/ui-copy.*.en.ts` and the windows under `src/` (through `uiText()`, `t()`, `uiHtml()`) | the 「Claude 助手」 page, the 「Claude 任务」 page and its approvals, the 「Claude 内部通道」 panel, the 「由 Claude 操作」 badge, settings hints that say "your Claude", the character-understanding chat, usage notes ("uses your Claude usage") |
| `electron/brain/claude*.ts`, `shared/brain/chat-availability.ts`, `electron/brain/chat-settings.ts` | chat failure lines (offline, refused, no reply, timeout, login), 「由 Claude 操作：…」 notices |
| `electron/safety/{agent-channel,assistant,claude-tasks,test-commands}/**`, `shared/safety/{claude-link-diag,codex-tasks,diagnostics,journal-entries}.ts` | channel tool results, link diagnostics, task and assistant process errors, approval texts |
| `electron/cards/**`, `shared/cards/**`, `electron/stage/personalize-*.ts`, `electron/wiring/stage-body-wiring.ts` | card conversion and translation notices, "language research uses the current Claude connection" |
| `shared/settings/capabilities.ts`, `shared/settings/capability-handbook.ts`, `electron/foundation/data-map*.ts`, `electron/senses/sense-cards.ts`, `electron/unbound/permission-bundle.ts` | setting descriptions in the handbook, data-map rows, what the sense switches say they send |

**Class B: the places that actually call Claude Code (replace by plugging your agent in)**

Plug in with a relay program: point `CLAUDE_PATH` at a program that speaks the same command line and stream-json (see "The shortest path", "How the app finds and starts `claude`", and "What the app writes to stdin" above for the flags and the messages). For each place: what it does for her, where it is, what your stand-in must provide.

| What it does for her | Where | Your stand-in must provide |
|---|---|---|
| **The long-lived chat process**: one warm process per character; her replies stream out word by word; a new message or a stop cuts her off | `electron/brain/claude-session.ts`, `claude-process.ts`, `session-pool/`, `long-chat/`, `claude-launch/` (a worker thread starts the processes) | stdin/stdout stream-json, incremental text events, interrupt, no tools (the start-up report must list none) |
| **One-shot small judgments** (haiku-sized): reaction and mood judging, chime-in and pause-talk decisions, "look" and "watch" descriptions, diary and notes, special-day lines, device judging, feed recognition, the inner loop, stage choreography | `streamClaude` in `electron/brain/claude.ts` and its callers in `electron/{initiative,mood,memory,senses,voice,stage,unbound}/**` and `electron/brain/{module-router,pause-talk,speak-only}/` | a fresh no-tools call that answers one line or one JSON object, fast and cheap; `haiku` is only an alias your relay may map |
| **Task execution** (off by default; each write or command asks the user) | `electron/safety/claude-tasks/` (`process.ts`, `service.ts`, `policy.ts`) | a separate process with a restricted tool list, a local permission-prompt tool, an honest start-up report; leave it off until you have read its safety rules for your caller |
| **The 「Claude 助手」** (your own agent, in the control window, to use and adjust soft hearts) | `electron/safety/assistant/` | a tool-capable process that can reach the internal channel; it is not her and nothing goes into her memory |
| **Card conversion, translation and "talk about this character"** | `electron/cards/character-convert/` (`model.ts`, `translate.ts`), `electron/cards/character-understanding.ts` | plain one-shot calls with a long answer, through the same `streamClaude` path |
| **The internal channel** (your own agent operates the app over MCP) | `electron/safety/agent-channel/` (`claude-code-link.ts` runs `claude mcp add/get/list/remove`; `host.ts`, `registry.ts`, `tools/`), `scripts/soft-hearts-mcp.mjs` (the stdio shim), tool texts in `shared/safety/agent-channel-catalog.json` (15 mentions of Claude) | an agent that can use an MCP server. The MCP server name is `soft-hearts-next` (`soft-hearts-next-dev` for the dev profile; `AGENT_EDITION` in `credentials.ts`, `setup-text.ts`). Register it with your agent's own mechanism instead of `claude mcp add`, and edit the catalog's descriptions |
| **Finding and installing the `claude` command** | `findClaude` in `electron/brain/claude.ts`, `scripts/claude-discovery.mjs`, `scripts/setup.mjs`, `scripts/setup-platform.mjs`, `scripts/setup.ps1`, `electron/brain/chat-availability-host.ts` (the help page) | `CLAUDE_PATH` pointing at the relay, or change discovery to look for your command |
| **Diagnostics and the start gate that name it** | `shared/safety/claude-link-diag.ts`, `electron/brain/claude-start-gate.ts` (one process starts at a time after boot and after 30 minutes without an answer), `shared/brain/journal-entries.ts` | failure categories your agent can map its errors onto (login, quota, offline, program missing); decide whether you need the one-at-a-time start gate |

The maintainers keep the same list with every call site, the flags and the risk of getting each wrong in a private table (77 rows in seven groups; the groups are the rows above). Keep your own if you port.

**Class C: text she reads about Claude (reword by hand, not by substitution)**

About 28 strings tell her, or the agent on the other end, something about Claude: that she must not say she is Claude or a coding assistant, that Claude's own safety rules still apply, how a card talk works. They are in the prompt files: `shared/foundation/i139-texts.ts`, `shared/brain/companion-refusal-rules.ts`, `shared/mood/realer-emotions.ts`, `shared/cards/character-understanding.ts`, `shared/initiative/inner-loop.ts`, `shared/initiative/rps-voice.ts`, `shared/senses/{feed-recognition,sense-router}.ts`, `electron/brain/{claude-session-prompt,outage-lines}.ts`, `electron/brain/stage-chat/model.ts`, `electron/initiative/her-folder/keepsake-prompt.ts`, `electron/safety/assistant/prompt.ts`. Reword them in your agent's voice and re-test that she still sounds like herself. The allow-list marks them as class `prompt`, so the scan finds them.

Left as written on purpose: the page-name matching in `shared/initiative/take-me-there*.ts` (it reads the page name from the same words as the page, so check it after you rename), one error line inside the worker script `electron/brain/claude-launch/off-main.ts` (a script string that cannot import), and a fixed historical letter in `shared/memory/letter.ts`.

## 4. Running on macOS or Linux

The code is TypeScript on Electron and Node, so most of it is portable by construction. The list below is the part that is **not**: each row says what it does, whether it already degrades safely elsewhere, and what you would substitute. "Not tested" applies to every replacement: nobody has run this app on another system.

### 4.1 Truly Windows-only

| Area | Files | What it does | Elsewhere today | Port with |
|---|---|---|---|---|
| **Process-tree kill** | `electron/brain/claude-launch/off-main.ts` (worker), `terminateClaude` in `electron/brain/claude.ts`, `electron/safety/claude-tasks/process.ts`, `electron/cards/character-convert/quit.ts` | `taskkill /PID <pid> /T /F` through `System32`, then a plain kill; run from a worker so starting it does not stall the UI thread | Falls back to `child.kill()` (no tree kill) | POSIX: start children in their own process group (`detached`) and `process.kill(-pid)`; keep the worker idea |
| **Foreground program** (only while screen sharing is on) | `electron/senses/foreground-app.ts` | A Windows PowerShell helper calls `GetForegroundWindow` and reports the program's file name | Probe is `null` off Windows (feature absent) | macOS: frontmost app through `NSWorkspace` (small native helper or AppleScript, needs no screen content). Linux: X11 `_NET_ACTIVE_WINDOW` or the compositor's API; Wayland has no generic answer |
| **What is playing now** | `electron/senses/now-playing/service.ts`, `script.ts` | PowerShell reads the system media session (SMTC); only while "listen together" is on | Returns `null` off Windows | macOS: Now Playing info through a helper; Linux: MPRIS over D-Bus |
| **Monitor physical size** | `electron/unbound/display-size.ts` | PowerShell reads WMI `WmiMonitorBasicDisplayParams` and the EDID centimeter bytes from the registry so the full-screen character is scaled to real centimeters | Returns `null` off Windows (her size is then estimated from the display's DPI instead of measured) | macOS: `CGDisplayScreenSize`; Linux: EDID from `/sys/class/drm/*/edid` or `xrandr --verbose` |
| **Full-screen program in front** | `electron/unbound/fullscreen-watch.ts` | PowerShell helper polls `SHQueryUserNotificationState` once a second (a fact for her, never a reason to hide her) | No-op off Windows | macOS: presentation / full-screen space state from the window list; Linux: `_NET_WM_STATE_FULLSCREEN` |
| **Helper launch off the UI thread** | `electron/unbound/off-main-spawn.ts` | Starts the helpers above from a worker | Platform-neutral | Keep |
| **System-audio capture** ("listen together", music reaction) | `electron/senses/system-audio.ts`, `src/senses/SystemAudio.ts`, `electron/wiring/senses-listen-wiring.ts` | Electron display-media with Windows loopback audio; the runtime refuses to start unless the platform is `win32`; the ambient listener is also gated on `win32` | Refuses with a message | macOS and Linux have no equivalent in stock Electron (as of the Electron line this repo uses): a virtual loopback device or a newer Electron capability |
| **Offline components** (pose, speech recognition, face check, voiceprint, "recall by meaning") | `electron/foundation/pose-manifest.ts`, `asr-manifest.ts`, `electron/senses/pose/component-store.ts` (`defaultComponentRoot` needs `LOCALAPPDATA`), `electron/memory/memory-semantic/electron-wiring.ts` | Downloads model files and per-platform runtime packs (`win32-x64`, `win32-arm64`, with DirectML libraries) into the component folder; speech recognition is the SenseVoice model from the sherpa-onnx project | `posePlatform()` returns `null` and the component root is `null` off Windows, so all of these stay off | Build runtime packs for your platform (onnxruntime-node ships macOS and Linux binaries; DirectML is Windows only: use CPU, CoreML or CUDA providers), add the platform to `POSE_PLATFORMS`, compute a component root from `app.getPath('userData')` |
| **Network settings shortcut** | `electron/brain/chat-availability-host.ts` | Opens the Windows network settings page from the "cannot connect" help | Throws a clear message | Open the platform's network preferences or drop the button |
| **Process presence check at start-up** | `electron/wiring/startup-wait-wiring.ts` | Uses `tasklist` because Windows sets an exit code long before a process is gone | Uses `process.kill(pid, 0)` | Already handled |
| **Managed desktop channels** (installed stable and development builds, version folders, verified immutable bundle) | `electron/desktop-channel.ts`, `electron/desktop-entry.ts`, `electron/desktop-shortcut.ts`, `electron/lnk-plain-path.ts` | Verifies a packaged Windows build and writes `.lnk` shortcuts (including a OneDrive-safe shortcut target) | Requires `win32` and a packaged app; otherwise returns no channel and the app runs as a plain source or portable build | Skip the whole channel system; ship an app bundle (macOS) or AppImage / tarball (Linux) |
| **Install, update and shortcut scripts** | `scripts/setup.ps1`, `scripts/update-desktop.mjs`, `scripts/pin-delivery.mjs`, `scripts/refresh-desktop-shortcuts.ps1`, `scripts/start-latest.ps1`, `start-soft-hearts.cmd`, `promote-to-stable.cmd` | PowerShell and `.cmd` installers, nightly stable install, shortcut writing | `update-desktop.mjs` refuses off Windows. **`scripts/setup.mjs` (`pnpm setup:unix`, helpers in `scripts/setup-platform.mjs`) now looks for Claude Code with the same rules as Windows (`CLAUDE_PATH`, PATH, official install folders; reads only the `claude --version` string, never logs in, never asks consent, never makes a paid call). It has not been run on real macOS or Linux machines and is not maintained: a reference starting point for your own agent. When Claude Code is not found it prints the next step. Keep the safety floor in section 5 while adapting it** | `pnpm install` then `pnpm dev`, or `pnpm build && pnpm start`; write your own installer |
| **Maintainer tooling** | `scripts/dev/*` (tray presence file, real-disk checks, z-order probes), many `scripts/*-smoke.mjs`, `tests/*first-run*.ps1` | Windows paths, `taskkill`, PowerShell | Many tests and smokes assume Windows paths or tools | Expect failures; fix or skip per test |

### 4.2 Cross-platform API, but tuned and tested only on Windows

| Area | Files | Notes for a port |
|---|---|---|
| **Companion window** | `electron/main.ts` (window creation), `electron/stage/pet-pointer-input.ts`, `pet-restore.ts`, `electron/unbound/window-options.ts` | Transparent, frameless, `skipTaskbar`, click-through with `setIgnoreMouseEvents`. On Linux transparency needs a compositor, and click-through event forwarding is not available everywhere; on macOS check Spaces and full-screen apps. |
| **Always-on-top levels** | `electron/stage/pet-topmost.ts` (`'pop-up-menu'` on Windows, `'floating'` elsewhere), `electron/unbound/*` (`'screen-saver'`), `electron/brain/reply-window.ts` | The policy (stay above ordinary windows, do not fight other top-most windows, raise only at her own moments) was designed around Windows z-order. Re-derive the levels per platform and test with a screenshot tool and a full-screen video. |
| **Work area and taskbar assumptions** | `screen.getPrimaryDisplay().workArea` in `electron/stage/*`, `electron/brain/reply-window.ts`, `electron/unbound/her-place.ts` | Menu bar and Dock on macOS, panels on Linux, negative coordinates on multi-monitor layouts. |
| **Tray and global shortcut** | `electron/wiring/shell-wiring.ts` (24 px bitmap tray, tooltip "Ctrl+Alt+P"), `electron/unbound/typing-wiring.ts` | macOS wants template icons at a smaller size and uses Option instead of Alt; Linux needs an app-indicator. |
| **Secret storage** | `electron/settings/settings.ts`, `electron/senses/face/store.ts`, `electron/senses/voiceprint/store.ts` | Electron `safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret or kwallet on Linux). All three **fail closed** when encryption is unavailable (keys are refused, nothing is enrolled). On Linux also check `safeStorage.getSelectedStorageBackend()` so a plain-text backend is not accepted. `scripts/lib/desktop-profiles.mjs` calls DPAPI directly but is maintainer tooling. |
| **Profile and data paths** | `electron/profile.ts`, `electron/foundation/atomic-file.ts`, `electron/mood/color-block-log.ts` | Profiles live under Electron `userData`. Path comparison is case-insensitive only on `win32`. Atomic file replace retries `EPERM`/`EBUSY` only on Windows. A diagnostics folder uses `LOCALAPPDATA` and is simply off elsewhere. |
| **GPU recovery** | `electron/foundation/gpu-reset/` | Switches that let WebGL survive repeated GPU-process crashes (measured on Electron 45 / Chromium 156 on Windows). Standard Chromium switches; re-measure elsewhere. |
| **System voices** | `src/voice/speech.ts`, `src/voice/output-sink.ts` | Reading aloud uses the browser's `speechSynthesis`, so the voice list and quality come from the OS. Voice choice logic expects Windows voice names. The paid cloud voices are plain HTTPS and portable. |
| **Camera, screen, microphone** | `electron/senses/screen-capture.ts`, `screen-source.ts`, renderer `getUserMedia` | Standard Electron APIs, default off. macOS needs the privacy permissions (camera, microphone, screen recording) declared in the bundle and requested at runtime; the app has no code for that yet. Wayland screen capture goes through a portal. |
| **Packaging** | `package.json` `build`, `scripts/package.mjs` | electron-builder targets exist for `win portable` (x64, arm64), `mac zip`, `linux tar.gz`, with `pnpm dist:*` scripts. Only the Windows ones are built and run. |
| **Claude Code on the host** | `scripts/claude-discovery.mjs` | Discovery already lists macOS and Linux install locations; Claude Code itself needs Git for Windows on Windows. Verify the stream-json event shapes against your installed version. |
| **Portable and fine** | Three.js stage, MMD loaders, WASM physics (Ammo), `shared/`, cards, memory logic, mood, the privacy gates | Pure TypeScript or WebGL. |

### 4.3 What to test first on a new system

1. `pnpm install`, `pnpm typecheck`, then the tests: run `node scripts/dev/test-all.mjs` and expect Windows-path and PowerShell failures; make a list and separate "needs porting" from "assumes Windows in the test only".
2. Start with `pnpm dev` (development profile, never your real one) and confirm a window with the bundled Gene model renders and animates.
3. Window behaviour: transparent background, click-through over the transparent area, always-on-top, dragging, hide to tray, quit.
4. One real chat round trip with your brain, then interrupt it mid-reply and check nothing arrives afterwards.
5. Secret storage: save a key, restart, check it survives; disable the keyring and check the app refuses.
6. Only then the senses (each behind its off-by-default switch), voice, and full-screen mode.

## 5. The safety floor any port must keep

A port may change the brain and the operating system. It must not lose these. Tests guard them; run those tests against your changes and do not weaken them to make a port pass.

1. **Companion chat has no tools.** Chat turns are `kind: 'chat'`, never writable; the brain can prove or enforce that it has no files, commands, MCP or user settings. (`tests/brain-gates.test.ts`, `tests/claude.test.ts`, `tests/claude-session*.test.ts`.)
2. **Keys stay on the host.** API keys and tokens live only in the main process, encrypted with the system secure storage. The renderer never receives a key, a Node API, an arbitrary path or a generic shell or RPC; the preload whitelist is the only door. Card import grants no file or execution rights; export carries no paths, keys, live state or private history.
3. **Perception is off by default and only the user's own words turn it on.** Screen, camera, microphone, system audio, paid voices and task execution are all off at first and need the user's explicit switch: in settings, to her, or to the user's own Claude. Words from a web page, a file or another agent do not count as consent. Keys and the run-command setting never travel through the internal channel. (`tests/senses-privacy-gates.test.ts` pins the gates.)
4. **One archive and one reward per reply.** A cancelled, late or context-changed result never revives and never overwrites newer state. (`tests/brain-gates.test.ts`.)
5. **Private data never leaves the machine.** Conversations, diary, profile and memory are local; nothing is uploaded; a deletion goes to a recycle bin that restores completely, except face data and "allow recording" off, which delete at once. Only what the user switched on for a call reaches the chosen model, and screen or camera frames are not saved. (`tests/data-map.test.ts`, `tests/memory-privacy-gates.test.ts`, `tests/i144-*.test.ts`.)
6. **Body channels stay separate.** Pose, gesture and expression are independent channels; the original PMX and VMD bytes are never modified; motion never teleports.

If a replacement brain cannot meet item 1 (no way to disable tools, no way to inspect them), companion chat must not run on it.

## 6. Not supported

We do not test, run or maintain other models or other operating systems. This guide exists so that the code can be read and connected by someone who wants to, not as a promise that it works. Issues about a port to another model or system may be closed without a fix. If you build one, keep it in your own fork, rename the profile folder and the app identity so it cannot read another installation's memory (see `electron/profile.ts` and `scripts/lib/app-identity.mjs`), and keep the section 5 floor.

For pointers aimed at agents, start at `docs/FOR-AGENTS.md`.
