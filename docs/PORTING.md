# Porting guide: other models, macOS, Linux

<p align="right"><a href="#zh"><img src="images/lang-zh.svg" alt="中文" height="30"></a></p>

**Summary**

- soft hearts is **made for Claude and for Windows**: chat goes through the Claude Code on the user's own computer, and the desktop behaviour is tuned for Windows. Other models and systems are **not tested, not maintained, not guaranteed**.
- This page is a map for agents and developers who want to connect it to their own model (for example the API or command line of DeepSeek, ChatGPT and the like) or run it on macOS / Linux: what is Claude-specific, what is Windows-specific, what each is for, what you have to provide yourself, which behaviours get worse on another model, and what to test first.
- Whatever you change, keep the safety floor of section 5 below as it is (one line of it was relaxed on 2026-11-26: a port no longer has to prove there are no tools in chat, see the note at the top of section 5): keys live only in the host; a window gets no Node and no arbitrary path; screen, camera and microphone are off by default and only the user's own words can turn them on; a reply is stored only once; private data does not leave the machine.
- **An agent that wants to plug itself in as the brain should read the section "Plug yourself in: the brain protocol" first** (after section 2): how to build a relay program that pretends to be `claude` (with `CLAUDE_PATH` pointing at it), what the app writes to it and reads from it, cancelling and ending the process, the hidden markers, the safety floor, plus a table of starting points for macOS / Linux / Windows × Codex / DeepSeek / OpenCode (all unverified) and a self-check list. It applies to any system with any agent.
- **Wherever the app says Claude, you can change it to your own agent** (section 3.5, "Where the app says Claude"): the names shown on screen ("Claude assistant", "operated by Claude", "Claude tasks") follow when you change two lines in `shared/foundation/assistant-name.ts`; the places that really call Claude Code (the long-lived chat process, the one-shot small judgments, task execution, the internal channel, installing and discovery, diagnostics) are changed by plugging your agent in as in "Plug yourself in"; the prompts written for her that talk about Claude you have to rewrite yourself. A port that is not Claude should not call itself Claude.
- This is a best-effort guide: it can be read and connected to, and that is all.
- It is written as a reference for **the user's own agent** (Claude, ChatGPT, DeepSeek and others): the project itself will not adapt to other platforms; the idea is that the user's agent uses these materials to connect it on their own system.

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
  [--model <name>]             chat: opus when the saved model is empty; none for follow-default (below)
  [--effort low|medium|high]   only on a few one-shot calls
  ```

  `--tools ""`, `--strict-mcp-config`, `--safe-mode`, `--disable-slash-commands` and `--setting-sources ""` are how the Claude edition says "no tools, no MCP, no user settings" today. Do not just ignore the flags: either keep that promise or, if your backend cannot prove it, keep the chat boxed in (see the safety floor below). `--model` is passed only when the name is `default`, `fable`, `opus`, `sonnet`, `haiku` or `opusplan` (each optionally with `[1m]`), contains `claude`, or is a Bedrock ARN; anything else is dropped. Since 0.2.0 an empty chat model (or a dropped name) is sent as `--model opus`, and only the `follow-default` choice sends no `--model` (`shared/brain/claude-model.ts` `chatModelArgument`). So your relay sees `--model haiku` for the small background judgments and `--model opus`, another Claude alias, or nothing for chat: map those names to your own small and large models.
- **Other launch shapes you can leave unsupported.** The optional task runner (`electron/safety/claude-tasks/process.ts`) and the user-assistant process (`electron/safety/assistant/process.ts`) add `--tools` with names, `--mcp-config`, `--permission-prompt-tool`, `--restricted` and so on. They only start when the user switches those features on. A relay that exits non-zero on those flags leaves them off, which is the safe default.
- **`claude mcp add/get/list/remove`.** When the user opens the internal-channel panel, the app can run these through the same binary to register its MCP server with the user's own Claude Code (`electron/safety/agent-channel/claude-code-link.ts`). A relay does not need them: make `mcp` exit non-zero. If your agent supports stdio MCP servers, register the app's server in your own way instead; the control window prints the same entry as JSON (`mcpServers: { name: { command, args, env } }`, built by `electron/safety/agent-channel/setup-text.ts`), and the server is `scripts/soft-hearts-mcp.mjs`. Read section 5 first: a new caller needs a fresh safety review.

### What the app writes to stdin (one JSON object per line)

1. **A user turn:** `{"type":"user","message":{"role":"user","content":[ {"type":"text","text":"..."}, ... ]}}` followed by `\n` (`claudeInput`). Content is an optional first text block (a cacheable preface), then the prompt text block, then up to 2 image blocks `{"type":"image","source":{"type":"base64","media_type":"image/png"|"image/jpeg"|"image/webp","data":"..."}}`. The prompt text carries the character, mood and memory for this turn and a `<conversation-data>` JSON block (`currentUser`, `history`). Images only appear when the user has switched a sense on.
2. **An interrupt:** `{"type":"control_request","request_id":"interrupt-<uuid>"|"supersede-<uuid>","request":{"subtype":"interrupt"}}`. Used when the user presses stop, talks over her, switches character, or keeps talking (supersede).
3. **End of input:** the app closes stdin when it is done with the process.

The app writes the next user message only after the previous turn's `result` was read (or the process is gone). One-shot calls and the one-process-per-message fallback write one user line and close stdin straight away.

### What the app reads from stdout (one JSON object per line, `\n`-terminated)

For every user turn, in this order (`ClaudeStreamReader` in `electron/brain/claude.ts`, `ClaudeChatProcess.line` in `electron/brain/claude-process.ts`):

1. `{"type":"system","subtype":"init","session_id":"...","model":"...","tools":[],"mcp_servers":[], ...}`. **Before any text.** `tools` and `mcp_servers` must be present and empty arrays; missing or non-empty stops the turn as unsafe (the app's check is unchanged, so a relay may report empty lists only if that is true of the chat as it runs). Text arriving with no init seen is also a stop. Claude Code sends one per turn; the app checks each. `model` is only logged.
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

These are not negotiable, except the one line relaxed on 2026-11-26 (the same floor as section 5; read the note at the top of that section):

- **The relay does not add tools to companion chat.** If your CLI or API can run commands, read files, browse or load MCP servers, turn that off when the relay forwards (or refuse to run), and keep `tools: []` and `mcp_servers: []` in `init` true. If you cannot turn them off or prove it, you are no longer required to: keep the chat boxed in instead (file system denied except its own scratch folder, network off for tools, the turn stops the moment a tool request appears, a self-check at every start) and still add no tools. Never forward a tool request to the app as text; if your backend asks for a tool, end the turn with an error `result`. Do not read the user's own agent settings into the chat.
- **Keys stay in the main process or in your own CLI's login.** The app never hands a key to a window. Do not write a key into the relay's source, a log or the command line (the command line is visible to other programs).
- **Do not send the user's data to a service the user did not choose.** The prompt text carries private conversation, memory and sometimes a camera or screen frame. It may go to the backend the user picked for this app and nowhere else: no extra logging service, no telemetry, no second model "for quality". Do not save frames or prompts to disk.
- **Keep the other two switches off until reviewed:** task execution and the internal MCP channel (sections 3.1 and 5).

### Where to start, by combination (a starting point, not a promise)

None of these rows has been tested by the maintainers. "Unverified" means exactly that: look up your own CLI's current non-interactive and streaming options and do not copy flag names from this page; none are given here on purpose.

| System and agent | Where to hook in | Watch out for | First thing to verify |
|---|---|---|---|
| **macOS + Codex** | Relay that forwards to Codex's non-interactive or JSON-event mode (look up your CLI's non-interactive, JSON-stream mode; unverified). | Streaming granularity (a mode that emits only whole messages makes the first word late); whether tools and shell are really off for chat (prove it, or else box the chat in; see the safety floor); cancel by ending the child on `SIGTERM`; MCP support differs. | Hand test: pipe one `user` line into the relay and see `init`, deltas, `result`. |
| **macOS + DeepSeek** | Relay that calls an OpenAI-compatible chat-completions endpoint with streaming on, mapping each streamed content piece to a `text_delta` (unverified for your account: model names, limits, the exact fields). | Keep your own message list; send no tool definitions; abort the HTTP request on interrupt and on `SIGTERM`; a reasoning model may emit reasoning text, which must not go into `text_delta`; check that the model follows the closed markers. | Same hand test, then a small one-shot (`--model haiku` shape) that must return strict JSON. |
| **Linux + DeepSeek** | Same as macOS + DeepSeek. | Same, plus: a GUI launch does not inherit your shell variables, so keep the key where your relay reads it (its own owner-only config file), not in the app's environment; make the relay file executable. | Same, then `pnpm dev` with `CLAUDE_PATH` set from a launcher that has the display. |
| **Linux + OpenCode** | Relay that forwards to OpenCode's non-interactive mode, or to its local server if it has one (look up its current docs; unverified). | Whether it has a no-tools mode (and whether you can prove it, or must box the chat in instead); streaming support; process cleanup on `SIGTERM`; MCP is its own concern. | Hand test, then check that no tool list is anywhere in what the relay forwards. |
| **Windows + another agent** | Relay compiled to a `.exe` (a `.cmd` shim cannot be started) forwarding to that agent's CLI or API (unverified for any particular agent). | The app ends the tree with `taskkill /T /F`, so child processes die with the relay; pass the long system prompt to your backend as data, never through a shell command line. | Hand test from a terminal, then `pnpm dev`; this is the system the app was built on, so window behaviour should already work. |

### Self-check for the agent that plugged itself in

Do these in order; stop at the first one that fails and fix it before going on.

1. **Run the app on the fake Claude first.** Before your relay exists, prove your machine can run the app: `pnpm install`, `pnpm typecheck`, then `node scripts/dev/test-all.mjs` (on macOS and Linux expect Windows-only failures; sort them as in section 4.3). The packaging smoke (`pnpm smoke`, `scripts/smoke.mjs`; read its header first) runs the app on an isolated throw-away profile with the fake Claude, never a real profile or a real model. Then `pnpm dev` and see the bundled Gene model render.
2. **Swap in your relay.** Hand test it without the app: pipe one user line into it, check that `init`, deltas and `result` come out as above and that it exits when stdin closes. Then `CLAUDE_PATH=<relay> pnpm dev` and send one message.
3. **First character.** Note how long until the first word appears. The design target is the first sentence within about a second after the model starts; a backend that streams only whole messages will miss it, and that is a finding to report, not something to hide.
4. **Hidden markers do not leak.** Over at least a dozen replies, look for `<sh-` text, `⟦look`, raw JSON, or reasoning and "plan" text on screen or in the spoken voice. If any shows, the model is ignoring the closed markers or your relay adds text; do not paper over it in the app.
5. **Cancel stops.** Press stop mid-reply, switch character mid-reply, and talk over her: nothing may appear afterwards and no relay or backend process may remain (check the process list; on Unix this tests your `SIGTERM` handling).
6. **One reply is stored once.** After a normal reply, an interrupted one and a superseded one, the conversation history must hold each exactly once (look through the app on the development profile, not by editing files).
7. **No tools added to companion chat.** The relay's `init` has empty lists (true of the chat as it runs: proven, or boxed in as in the safety floor), your backend request carries no tool definitions, and a deliberate "run this command" message produces words, not an action. Run `tests/brain-gates.test.ts`, `tests/claude.test.ts` and `tests/claude-session*.test.ts` against your changes; do not weaken them.
8. **Small calls.** One-shot calls return exit code 0 with clean text or JSON; try a slow and a failing backend and check that the app shows its quiet "she cannot answer" state instead of freezing.
9. **Report honestly.** Write down what you measured and what you did not, in your own fork's notes; this repository does not promise your combination works.

## 3. Replacing the brain

Everything that depends on Claude Code is listed by seam below. The rest of the app talks to these seams, not to Claude directly, so replacing the brain means re-implementing the seams, not editing the companion.

### 3.1 The seams

| Seam | Today | Where | What your replacement must provide |
|---|---|---|---|
| **Companion chat turn** | One long-lived `claude -p --input-format stream-json --output-format stream-json --include-partial-messages` process per character; the user message goes to stdin each turn; text arrives as incremental events | `electron/brain/claude-session.ts` (`PersistentClaudeChat.stream`), `claude-process.ts`, `claude-session-prompt.ts`, pool in `session-pool/` | `stream(task, signal, emit, control?)`: stream text with `emit('delta', text)`, keep context across turns (or rebuild it each turn, slower), honour `signal` (after abort no more text may come out), start a new context on `close('context')`. The prompt and image getters on `task` must be read when written out, not earlier. |
| **No tools in companion chat (today's Claude edition)** | Launch arguments disable all tools, MCP, slash commands, user settings and session persistence; start-up report (`system/init`) must list no tools and no MCP servers; any tool block in the stream stops the turn | `electron/brain/claude.ts` (`claudeArguments`, `ClaudeStreamReader`) | A way to prove the model has no tools, or else the boxed-in fallback (section 5, item 1; no longer a proof requirement since 2026-11-26), a runtime stop when a tool request appears, and a refusal of any task whose `kind` is not `'chat'` or that is `writable`. Safety floor item 1. |
| **One-shot small calls** | A fresh `claude -p` per call with its own system prompt and model name; most answer one line of text or one JSON object | `streamClaude` in `electron/brain/claude.ts`; the port `ClaudeLinePort` (`shared/foundation/ports.ts`: `line(prompt, systemPrompt, signal) -> { text }`, no tools in the type); `quickLineWithClaude` | One function: prompt + system prompt (+ optional image) in, text and usage out, cancellable, with a hard time limit. About two dozen callers use it (reaction judgment, mood judge, pause placement, inner loop, notes, diary, model check, and so on). |
| **Model tiers** | Small judgments use the `haiku` alias (cheap and fast); the companion's own voice uses the chat model; an empty chat model means Opus, `follow-default` means Claude Code's default; aliases are validated before they reach `--model`; when the account refuses the implied Opus the app switches to `follow-default` once (`electron/brain/chat-model-fallback.ts`, keyed on Claude Code's "issue with the selected model" text) | `shared/foundation/defaults.ts` (`CLAUDE_MODEL_ALIASES`), `shared/brain/claude-model.ts`, `electron/initiative/inner-loop/model.ts` | A small-model name and a large-model name that map onto your provider. Expect to touch the alias list and the one hard-coded small model. |
| **Availability and failure text** | Failures are classified from Claude Code's English error phrases (quota, login expired, rate limit, offline, certificate, program missing); the offline fast-path reads `system/api_retry` events; reset times are parsed from text | `shared/brain/claude-failure.ts`, `electron/brain/chat-availability*.ts`, `chat-outage.ts` | A classifier for your provider's errors that returns the same closed set of kinds. Unknown errors fall into "other" safely. |
| **Process start gate and discovery** | One Claude process starts at a time after boot and after 30 minutes without a successful answer (Claude Code rotates its own login tokens; concurrent refresh can log the user out); `claude` is found on `CLAUDE_PATH`, PATH and the official install locations | `electron/brain/claude-start-gate.ts`, `scripts/claude-discovery.mjs`, `findClaude` in `electron/brain/claude.ts`, `scripts/setup.ps1` (a second copy of the list) | Your own locator and login check. If your brain is an HTTP API, the gate is unnecessary; keep the "one at a time" idea only if your login has the same hazard. |
| **Internal channel (MCP)** | A small stdio MCP server lets the user's own Claude Code change her character, settings and voices; about 40 tools in three tiers (read only, direct, needs the user's own words in `userWords`); the app registers it with `claude mcp add` | `scripts/soft-hearts-mcp.mjs`, `electron/safety/agent-channel/` (`registry.ts`, `app-tools.ts`, `claude-code-link.ts`, `tools/`), catalog `shared/safety/agent-channel-catalog.json` | A client that can call stdio MCP tools (or reuse the registry and write another transport). The app cannot verify that `userWords` is really the user's sentence: that rests on the caller, so a new caller needs a fresh safety review. Sensitive actions (privacy, spending, deletion, loading files) still raise an in-app dialog. |
| **Task execution (optional, off by default)** | A separate `claude -p` process with a restricted tool list; reading is automatic, writing and running commands ask the user each time through a local permission server; start-up report is verified (`permissionMode`, tools, servers, working folder) | `electron/safety/claude-tasks/` (`process.ts`, `policy.ts`, `permission-server.ts`) | A task runner that can hand every write and command to the app for approval and wait for the answer, plus a start-up check like `verifyTaskInit`. If yours cannot, leave task execution disabled. |
| **Her text and hidden markers** | The model writes extra structure that the app strips before anything is shown or spoken: an opening marker with a per-turn code (default off), a tail block (mood reaction, gesture, user-state judgment, settings proposal, keepsake), speech-beat words for pacing, look markers when she wants a clearer camera or screen frame, alarm markers; each is wrapped in a random token per turn | `electron/mood/mood-chat.ts`, `electron/brain/reply-opening.ts`, `electron/brain/speech-beats/`, `electron/brain/look-continuation.ts`, `electron/brain/reply-draft-guard.ts`, prompts in `shared/brain/companion-rules.ts` and `electron/brain/claude-session-prompt.ts` | A model that follows closed-vocabulary markers reliably. Every parser fails closed (an unknown or malformed marker is dropped, never shown), but a model that ignores them gives you a flat, less alive companion. Re-collect the leak shapes of your model into the draft guard. |
| **Install text and UI wording** | `START-HERE.md`, `README.md` and several UI strings say "Claude" | `src/safety/AgentChannelPanel.ts`, `shared/safety/agent-channel.ts`, `src/cards/CharacterUnderstanding.ts` and similar | (names: see 3.5) Your own names and install steps. |
| **Memory scope** | Chat memory is keyed by character plus connection: kind, base URL and a model name pinned in `provider.memoryModel` at the first 0.2.0 start (changing the chat model no longer changes it) | `electron/foundation/memory-provider-scope.ts`, `electron/settings/memory-pin.ts`, `electron/memory/memory.ts` (`scopeKey`) | A stable connection id. Keep the pin when you change the brain on an existing profile; changing it makes memory look disconnected (it is not deleted). |

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
2. Implement `PersistentClaudeChat.stream` against your streaming API, keep the "no tools" assertions that are true of your brain (or, if you box the chat in, the checks for that), cancellation and one-turn-at-a-time rules, and make the tests in section 5 pass against your brain.
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

**Changed on 2026-11-26.** Until then "companion chat has no tools, and a port must be able to prove it" was a bottom line. The owner lifted that one line (his words, in short: the software will in future be able to operate the computer through an agent); the other items below stay as they are. Today the Claude edition still runs her chat without tools and checks the start-up report at every start; that code is unchanged. What changed is the rule for a port: it no longer has to prove there are no tools. A brain that cannot prove it keeps the chat boxed in instead (file system denied except its own scratch folder, network off for tools, the turn stops the moment a tool request appears, a self-check at every start) and does not add tools to the chat. Later she may act on the computer through the user's own agent; that design is not written yet and nothing of it exists in the app.

A port may change the brain and the operating system. It must not lose these. Tests guard them; run those tests against your changes and do not weaken them to make a port pass.

1. **Companion chat is not given tools, and is boxed in if you cannot prove that.** Chat turns are `kind: 'chat'`, never writable. The Claude edition runs the chat without tools and proves it at every start. A brain that cannot prove it must instead box the chat in (file system denied except its own scratch folder, network off for tools, the turn stops the moment a tool request appears, a self-check at every start), and must not add tools to the chat. (`tests/brain-gates.test.ts`, `tests/claude.test.ts`, `tests/claude-session*.test.ts`.)
2. **Keys stay on the host.** API keys and tokens live only in the main process, encrypted with the system secure storage. The renderer never receives a key, a Node API, an arbitrary path or a generic shell or RPC; the preload whitelist is the only door. Card import grants no file or execution rights; export carries no paths, keys, live state or private history.
3. **Perception is off by default and only the user's own words turn it on.** Screen, camera, microphone, system audio, paid voices and task execution are all off at first and need the user's explicit switch: in settings, to her, or to the user's own Claude. Words from a web page, a file or another agent do not count as consent. Keys and the run-command setting never travel through the internal channel. (`tests/senses-privacy-gates.test.ts` pins the gates.)
4. **One archive and one reward per reply.** A cancelled, late or context-changed result never revives and never overwrites newer state. (`tests/brain-gates.test.ts`.)
5. **Private data never leaves the machine.** Conversations, diary, profile and memory are local; nothing is uploaded; a deletion goes to a recycle bin that restores completely, except face data and "allow recording" off, which delete at once. Only what the user switched on for a call reaches the chosen model, and screen or camera frames are not saved. (`tests/data-map.test.ts`, `tests/memory-privacy-gates.test.ts`, `tests/i144-*.test.ts`.)
6. **Body channels stay separate.** Pose, gesture and expression are independent channels; the original PMX and VMD bytes are never modified; motion never teleports.

If a replacement brain can neither prove item 1 nor box the chat in as described there, companion chat must not run on it.

## 6. Not supported

We do not test, run or maintain other models or other operating systems. This guide exists so that the code can be read and connected by someone who wants to, not as a promise that it works. Issues about a port to another model or system may be closed without a fix. If you build one, keep it in your own fork, rename the profile folder and the app identity so it cannot read another installation's memory (see `electron/profile.ts` and `scripts/lib/app-identity.mjs`), and keep the section 5 floor.

For pointers aimed at agents, start at `docs/FOR-AGENTS.md`.

---

<a id="zh"></a>

<p align="right"><a href="#top"><img src="images/lang-en.svg" alt="English" height="30"></a></p>

# 移植指南：别的模型、macOS、Linux

**摘要**

- soft hearts 是**专为 Claude 和 Windows 做的**：聊天走用户自己电脑上的 Claude Code，桌面行为按 Windows 调过。别的模型和系统**不测试、不维护、不保证**。
- 这一页是给想把它接到自己的模型（比如 DeepSeek、ChatGPT 一类的 API 或命令行）、或者想在 macOS / Linux 上跑的 agent 和开发者的地图：哪些是 Claude 专属、哪些是 Windows 专属、各做什么、你要自己提供什么、哪些行为换了模型会变差、测什么先。
- 不管换什么，下面第 5 节的安全底线要保住（其中一条 2026-11-26 放宽了：移植不再必须证明聊天里没有工具，见第 5 节开头的说明）：密钥只在主机里；窗口拿不到 Node 和任意路径；屏幕、摄像头、麦克风默认关，只有用户本人的话能打开；一次回复只存一次；私人数据不出本机。
- **想把自己接成大脑的 agent，先读"Plug yourself in: the brain protocol"一节**（第 2 节之后）：怎么做一个假装成 `claude` 的转接程序（`CLAUDE_PATH` 指向它）、应用写给它什么、从它读什么、取消和结束进程、隐藏记号、安全底线，加一张 macOS / Linux / Windows × Codex / DeepSeek / OpenCode 的起点表（都未验证）和一份自检清单。适用于任何系统加任何 agent。
- **哪里写的是 Claude，都能换成你自己的 agent**（第 3.5 节"Where the app says Claude"）：界面上显示的名字（「Claude 助手」「由 Claude 操作」「Claude 任务」）改 `shared/foundation/assistant-name.ts` 里的两行就跟着变；真正去调用 Claude Code 的地方（常驻聊天进程、一次性小判断、任务执行、内部通道、安装和发现、诊断），按上面"Plug yourself in"把你的 agent 接进去就行；写给她看的、讲 Claude 的那些提示词要自己改写。不是 Claude 的移植版不要自称 Claude。
- 这是尽力而为的说明：能读懂、能接上，仅此而已。
- 这份是写给**用户自己的 agent**（Claude、ChatGPT、DeepSeek 等）的参考：项目本身不会去适配别的平台，是让用户的 agent 照着这些资料，在他们自己的系统上接起来。

---

## 1. 这是什么，为谁做的

soft hearts 是一个桌面陪伴：一个 3D 角色（PMX/PMD 或 VRM 模型，用 Three.js 渲染）住在屏幕上，和用户说话、会动、有心情、会记事，还可以选择让她看、听、做任务，每一项都放在一个默认关闭的开关后面。

它是**专为 Claude 和 Windows 做的**。这是设计上的选择，不是历史遗留：

- **Claude。** 聊天走用户自己的 Claude Code 安装和登录（应用从不读取、保存或转发任何凭据）。陪伴依赖 Claude Code 给的几样东西：一个长驻的 `claude -p` 进程来保持对话、逐 token 的流式输出、提示词缓存（固定的角色提示词写一次，之后便宜地重读，第一个字快就靠它）、一个又快又便宜的小模型（haiku 一类）来做几十个后台小判断、一个能证明自己没有工具的无工具启动模式，以及一个支持 MCP 的命令行，让用户自己的 Claude 可以操作这个应用。她的回复过滤和隐藏记号，都是照 Claude 的习惯调的。
- **Windows。** 窗口行为（透明、点击穿透、置顶层级、全屏检测、任务栏和工作区处理）、安装和更新流程（快捷方式、便携包）、显示器尺寸测量、系统声音采集，以及离线组件包，都只在 Windows 11（x64 和 arm64）上做过、验证过。

不是为这些做的：别的模型厂商、别的操作系统。照这里说的改一改，它们也许能用；这里没有人测试或维护它们（第 6 节）。

## 2. 一页讲完架构

- **技术栈。** Electron 主程序（`electron/`，TypeScript、Node）、无框架的窗口（`src/`，DOM 代码加一个 Three.js 舞台）、共享的纯逻辑（`shared/`）、测试（`tests/`，用 `node scripts/dev/test-all.mjs` 跑）、脚本（`scripts/`）。Node 22.12+，pnpm。
- **部分。** 十二个部分，每个在 `electron/`、`shared/`、`src/` 下各有一个文件夹，和一个公开的 `index.ts`：cards（角色卡）、voice（声音）、unbound（全屏模式）、safety（连接、任务、内部通道）、initiative（她自己主动做的事）、memory（记忆）、senses（感知）、mood（心情）、brain（大脑）、stage（舞台）、settings（设置）、actions（身体动作）。一个部分不会伸手去碰另一个部分的内部。共享的类型和小的无状态工具放在 `shared/foundation/`、`electron/foundation/`、`src/foundation/`，它们不引入任何一个部分。
- **接线。** 只有接线知道所有的部分。主程序一侧：`electron/main.ts`（入口和启动顺序）和 `electron/wiring/*-wiring.ts`。窗口一侧：`src/main.ts` 选出是哪个窗口，并调用 `src/wiring/*.ts` 里的启动步骤。新功能放进它自己的部分，在接线里接上；不要让 `main.ts` 变长。
- **窗口能碰到什么。** `DesktopAPI`：这个类型在 `shared/contracts.ts` 里由各部分的切片 `shared/<部分>/desktop-api.ts` 拼出来，一个有类型的预加载白名单（`electron/safety/preload.ts`）刚好只开放这些调用。窗口拿不到 Node、拿不到密钥、拿不到任意路径，也拿不到通用的 shell 或 RPC。加一个调用，就是加一条切片条目加一条有类型的预加载条目；`tests/contracts-surface.test.mjs` 把整个接口面钉住了。
- **大脑在哪里。** `electron/brain/` 加 `shared/brain/`。接线在 `electron/wiring/brain-wiring.ts` 和 `brain-chat-wiring.ts`。聊天轮次：`electron/brain/claude-session.ts`（一个长驻进程）、`electron/brain/session-pool/`（每个角色一个热会话）、`electron/brain/claude.ts`（一次性调用、启动参数、流读取器）、`electron/brain/claude-launch/`（一个负责启动和结束进程的工作线程）。别处的小判断通过同一个函数找到模型（`quickLineWithClaude`，`electron/initiative/inner-loop/model.ts`）。
- **状态。** 全部放在一个有名字的配置的 Electron `userData` 文件夹下；数据登记在一张表里（`electron/foundation/data-map-*.ts`），删除和回收站都照着这张表走。
- 更多：`docs/architecture.md`（模块边界）、`docs/developing.md`（装好以后）、`docs/character-cards.md`。

## 把你自己接进来：大脑协议（Plug yourself in: the brain protocol）

**如果你是一个 agent（Codex、OpenCode、接了 DeepSeek 或别的提供方的 agent，或任何别的），而你的人类想让你在他自己的系统上当"大脑"，不管那是 macOS、Linux 还是 Windows，先读这一节。** 下面所有内容都是写作时从代码里读出来的；没有一条在 Claude Code 以外的任何 agent 上跑过。以代码为准：这里的一行和代码对不上时，信代码，并改这一页。

### 最短的路：一个假装成 `claude` 的转接程序

应用不直接和模型 API 说话。它启动一个叫 `claude` 的程序，往它的 stdin 写 JSON 行，从它的 stdout 读 JSON 行。所以改动最小的移植办法是做一个**转接程序**（relay）：一个小程序，接受应用用到的那部分 Claude Code 命令行，说同样的 stream-json 行，在里面转发给你自己的命令行或 API。然后把 `CLAUDE_PATH` 指向这个转接程序。应用的代码一行不用改，每一道安全检查都继续对着你的输出运行。

怎么做，按顺序：

1. 读那个已经会说这套协议的假 Claude：`scripts/lib/fake-claude.mjs`。`createFakeClaude()` 就是整套协议，写成一个纯函数（`line()` 接一行 stdin，一个 `output` 回调接 stdout 事件）；底部的 `main()` 是围着它的一个二十行的 stdin/stdout 循环。它是测试用的替身（它坚持要应用那一组一模一样的 argv，只回一句固定的话），所以照它的形状抄，不要照它的检查抄。`tests/helpers/fake-claude-stream.ts` 展示了在真实 Claude Code 上量出来的排队和打断行为；`tests/fixtures/fake-claude-task.mjs` 是第二个例子。
2. 写你的转接程序，让它对每条用户消息打印一个 `system/init`，然后是流式文本，然后一个 `result`（细节在下面）。先像假 Claude 那样回一句固定的话，再把文本接到你的后端。
3. 让它能被应用启动。应用用 `shell: false` 启动它：在 macOS 和 Linux 上，一个第一行是 `#!/usr/bin/env node`（或别的解释器）的可执行文件就行；在 Windows 上它必须是一个真正的 `.exe`（`.cmd`、`.bat` 或 `.ps1` 的转接壳用这种方式启动不了），比如打包好的单文件可执行程序。
4. 在开发配置上、设好这个变量运行应用：`CLAUDE_PATH=/path/to/relay pnpm dev`（按你的 shell 设变量的写法来；永远不要把它指向真实的配置）。`CLAUDE_PATH` 必须指向一个存在的文件；不存在的话，应用会报错，而且**不会**退回去搜索。

### 应用怎么找到并启动 `claude`

- **哪个文件。** `electron/brain/claude.ts` 里的 `findClaude` 调用 `scripts/claude-discovery.mjs` 里的 `discoverClaude`：设了 `CLAUDE_PATH` 就用它（一个确切的文件；路径错了就是错误，不退回）；否则在 `PATH` 的每个目录里找 `claude`（Windows 上是 `claude.exe`）；再否则按一份有限的清单：`~/.local/bin`、`/opt/homebrew/bin`（macOS）、`/usr/local/bin`、`/usr/bin`；Windows 上是 `%USERPROFILE%\.local\bin`、WinGet 的链接文件夹和 npm 的全局安装文件夹。它只检查文件元数据，从不运行候选程序。`scripts/setup.mjs`（`pnpm setup:unix`）用同一个查找器，并打印后面的步骤。
- **怎么启动。** 一个工作线程启动所有进程（`electron/brain/claude-launch/`，所以界面线程从不等它）：`shell: false`，三条管道，隐藏窗口，工作目录 = 每个进程一个全新的**空**临时文件夹。
- **环境变量。** 应用自己的环境，去掉所有以 `CLAUDE` 开头的变量（只保留一份短清单：`CLAUDE_CONFIG_DIR`、`CLAUDE_CODE_OAUTH_TOKEN`、`CLAUDE_CODE_GIT_BASH_PATH`、`CLAUDE_CODE_USE_*` 和 `CLAUDE_CODE_SKIP_*_AUTH` 这几类），去掉 `ELECTRON_RUN_AS_NODE`，再加上 `NO_COLOR=1` 和 `DISABLE_AUTOUPDATER=1`。你自己的提供方变量（比如用户环境里的一个 API key）原样透传；`CLAUDE_PATH` 本身不会传给子进程。见 `electron/brain/claude.ts` 里的 `claudeEnvironment`。
- **陪伴聊天进程的命令行**（`claudeArguments`，按这个顺序）：

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
  --system-prompt <文本，最多 20000 个字符>
  [--model <名字>]             聊天：保存的模型为空时是 opus；跟随默认时不传（见下）
  [--effort low|medium|high]   只在少数几个一次性调用上
  ```

  `--tools ""`、`--strict-mcp-config`、`--safe-mode`、`--disable-slash-commands` 和 `--setting-sources ""` 就是 Claude 版今天表达"没有工具、没有 MCP、不读用户设置"的办法。不要干脆无视这些参数：要么守住这句承诺，要么（你的后端拿不出证明时）把聊天关在碰不到东西的地方（见下面的安全底线）。`--model` 只在名字是 `default`、`fable`、`opus`、`sonnet`、`haiku` 或 `opusplan`（后面都可以带 `[1m]`）、含有 `claude`、或是一个 Bedrock ARN 时才传；别的一律丢掉。从 0.2.0 起，空的聊天模型（或被丢掉的名字）会作为 `--model opus` 发出，只有"跟随默认"（`follow-default`）这个选择才不发 `--model`（`shared/brain/claude-model.ts` 的 `chatModelArgument`）。所以你的转接程序会看到：后台小判断是 `--model haiku`，聊天是 `--model opus`、另一个 Claude 别名、或什么都没有：把这些名字对应到你自己的小模型和大模型上。
- **可以不支持的其他启动形态。** 可选的任务执行器（`electron/safety/claude-tasks/process.ts`）和用户助手进程（`electron/safety/assistant/process.ts`）会加上带名字的 `--tools`、`--mcp-config`、`--permission-prompt-tool`、`--restricted` 等等。它们只在用户打开那些功能时才启动。一个遇到这些参数就以非零退出的转接程序，等于让它们保持关闭，这是安全的默认。
- **`claude mcp add/get/list/remove`。** 用户打开内部通道面板时，应用可以通过同一个可执行文件运行这些命令，把自己的 MCP 服务登记到用户自己的 Claude Code 里（`electron/safety/agent-channel/claude-code-link.ts`）。转接程序不需要它们：让 `mcp` 以非零退出就行。如果你的 agent 支持 stdio 的 MCP 服务，就用你自己的办法登记应用的服务；控制窗口会把同一条登记打印成 JSON（`mcpServers: { name: { command, args, env } }`，由 `electron/safety/agent-channel/setup-text.ts` 生成），服务本体是 `scripts/soft-hearts-mcp.mjs`。先读第 5 节：一个新的调用方需要重新做一次安全审查。

### 应用往 stdin 写什么（每行一个 JSON 对象）

1. **一轮用户消息：** `{"type":"user","message":{"role":"user","content":[ {"type":"text","text":"..."}, ... ]}}`，后面跟 `\n`（`claudeInput`）。content 是：一个可选的开头文本块（一段可缓存的前言），然后是提示词文本块，然后最多 2 个图片块 `{"type":"image","source":{"type":"base64","media_type":"image/png"|"image/jpeg"|"image/webp","data":"..."}}`。提示词文本里带着这一轮的角色、心情和记忆，还有一个 `<conversation-data>` JSON 块（`currentUser`、`history`）。图片只在用户打开了某项感知时才出现。
2. **一次打断：** `{"type":"control_request","request_id":"interrupt-<uuid>"|"supersede-<uuid>","request":{"subtype":"interrupt"}}`。用户按停止、盖过她说话、换角色、或接着说话（supersede，顶替）时用。
3. **输入结束：** 应用用完这个进程时关闭 stdin。

应用只有在上一轮的 `result` 读到之后（或进程已经没了）才写下一条用户消息。一次性调用和"每条消息一个进程"的退路，都是写一行用户消息就马上关掉 stdin。

### 应用从 stdout 读什么（每行一个 JSON 对象，以 `\n` 结尾）

每一轮用户消息，按这个顺序（`electron/brain/claude.ts` 里的 `ClaudeStreamReader`，`electron/brain/claude-process.ts` 里的 `ClaudeChatProcess.line`）：

1. `{"type":"system","subtype":"init","session_id":"...","model":"...","tools":[],"mcp_servers":[], ...}`。**在任何文本之前。** `tools` 和 `mcp_servers` 必须存在而且是空数组；缺了或不为空，这一轮就当作不安全而停下（应用的这个检查没有变，所以转接程序只有在聊天实际运行时这确实成立，才能报空列表）。没见过 init 就来了文本，也一样停下。Claude Code 每一轮发一个；应用每次都检查。`model` 只记日志。
2. 流式文本，形式是 `{"type":"stream_event","event":{...}}`，里面的事件有：`message_start`、`content_block_start`（`content_block.type` 必须是 `text`、`thinking` 或 `redacted_thinking`；别的任何类型都会被当成工具请求并停下这一轮）、带 `{"type":"text_delta","text":"..."}` 的 `content_block_delta`（显示和朗读的就是这个；按顺序发小块的增量，第一块尽量早发）、`content_block_stop`、`message_delta`（`delta.stop_reason`；值为 `refusal` 表示拒绝）、`message_stop`。
3. 可选：`{"type":"assistant","message":{"id":"...","role":"assistant","content":[{"type":"text","text":"..."}]}}`。只有在你完全没发过增量时，它才会被当作文本；不要两种都发而且内容不同。
4. `{"type":"result","subtype":"success","is_error":false,"result":"<完整文本>","usage":{...},"total_cost_usd":0}` 结束这一轮。从 `usage` 里读的字段：`input_tokens`、`output_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens`（都可选，只要是数字）。失败：`is_error: true` 或 `subtype` 不是 `success`，由 `result`（或 `errors`）装一段文字。失败的种类（额度、登录、限流、离线、证书、其他）是从这段文字里的英文短语猜出来的（`shared/brain/claude-failure.ts`）；认不出的归到"其他"，这是安全的。
5. 对一次打断：`{"type":"control_response","response":{"subtype":"success","request_id":"<同一个 id>"}}`，然后是被打断那一轮自己的 `result`（用错误的 subtype 也行）。3 秒内没有这个 `result`，应用就杀掉进程。对一个你不支持的请求，回一个错误的 `control_response`；应用随后会结束进程，或者让这一轮继续跑。
6. 可选：`{"type":"system","subtype":"api_retry","attempt":n,"error_status":null|数字}`。数字表示"服务器回应了"；从第二次尝试起 `null` 会让这一轮以离线收场。一轮里连续 30 秒没有任何事件，也以离线收场。

应用对你的输出强制执行的硬规矩：轮次之外不许有输出（否则应用会把进程当作步调错乱而关掉）；一行最多 2,000,000 个字符；超过 100,000 个字符的回复会被截断；每条用户消息恰好一个最终的 `result`。

### 会话和接着一段对话

应用**一样都不用** Claude Code 的续接功能：从不传 `--resume`、`--continue` 或 `--session-id`（`--no-session-persistence` 始终开着）。事件里的 `session_id` 不读。连续性来自长驻进程本身：你的转接程序进程把它在 stdin 上收到的消息留作对话，并把每次回复追加进去。一个进程在这些情况下被换掉：空闲 10 分钟（窗口隐藏时 3 分钟）、12 轮或 60,000 个字符之后、崩溃、或角色变了；新进程从空白开始，应用把上下文重建在提示词文本里（`<conversation-data>` 里的 `history`）。所以你的转接程序不需要任何存储：每个进程在内存里留一份消息列表，退出就忘。如果你的后端没有多轮状态，就每轮重发这份列表。应用最多保持三个热进程（每个角色一个），并且可能在任何消息到来之前就启动一个；用户消息来之前，什么都不要打印。

### 一次性的小判断

大约二十来个后台小调用（反应、心情、笔记、日记等）会启动一个全新的进程，用同样的参数，但带它们自己的 `--system-prompt`（常常是"只回一个 JSON 对象"或"一句话"）、`--model haiku`，有时还带 `--effort`。它们写一行用户消息，关掉 stdin，读到进程退出，并且需要在成功的 `result` 之后**退出码为 0**；非零退出或文本为空都算失败。把模型的文字原样返回：不包装、不加代码围栏、不加评论，因为调用方解析的是最后一个 JSON 对象或整行。限制：总共 120 秒（有些长的调用自己设空闲上限），第一个事件 30 秒内要到。一个慢的或贵的小模型会让这些调用主导时间和花费；一个弱的会让应用丢掉答案，于是功能会变安静而不是变错。

### 要遵守的时间限制

一个聊天轮次：总共 120 秒；第一个事件在 30 秒内；被打断的一轮必须在 3 秒内发出它的 `result`。启动之后、以及 30 分钟没有成功回答之后，应用一次只启动一个进程，直到有一个流出了它的第一个事件（启动门，`electron/brain/claude-start-gate.ts`；等待是有上限的）。它存在的原因是 Claude Code 会轮换登录令牌；你的转接程序可以不管这个原因，但后端一回答，还是应该马上发出第一个 `stream_event`。

### 取消和结束进程

- 正常停止：上面那条打断消息。马上停止写文本（打断之后的东西应用会丢掉，但你的转接程序不能为一个已停的轮次继续生成）。
- 结束一个进程：先关 stdin，再 `terminateClaude`（`electron/brain/claude.ts`；由 `electron/brain/claude-launch/off-main.ts` 里的工作线程运行）。**Windows：** `taskkill /PID <pid> /T /F`（整棵进程树），如果还没退出，再来一次普通的 kill。**macOS 和 Linux：** 对你的转接程序的 pid 发一个 `SIGTERM`，不是对进程组。所以你的转接程序必须在 stdin 结束和收到 `SIGTERM` 时退出，并且自己停掉它启动的任何子命令行或 HTTP 请求；留着子进程不管的转接程序，在 Unix 上会泄漏进程。

### 应用在文本里期待什么

你不需要理解这些记号，只要把文本逐字节、按顺序原样传过去。你转发给的那个模型则确实需要照提示词里的要求写出它们。

- **开头记号。** 固定的系统提示词里有一个叫 `<sh-open>` 的记号；回复应当以它开头，只有它后面的部分才会显示、朗读和存档（它前面的文字，不管写了什么，都丢掉；这是防止推理内容漏出来的一道防线）。如果模型忘了写，应用会把整条回复拿住，等它完整了再按别的规则截取，第一个字大约要多等一秒到两秒半。转接程序不能在它前面加文字。
- **尾巴。** 回复之后，模型会写几个块，用一个每轮随机的、取自提示词的令牌包起来：`<sh-state-HEX>...</sh-state-HEX>`（心情反应、手势、用户状态判断），有时还有 `<sh-memorial-HEX>`、`<sh-setting-HEX>`、`<sh-file-HEX>`（HEX 是这一轮的令牌，32 个十六进制字符）。应用在显示或朗读任何东西之前先把它们剥掉；不认识的或格式不对的会丢掉，绝不显示。看的记号 `⟦look-camera⟧` 和 `⟦look-screen⟧` 以及节奏词，也是同样地剥掉。
- **不要翻译、包装、总结或重新分块。** 不要把你自己的推理、日志或工具痕迹放进 `text_delta`；推理只能作为 `thinking` 块发，或者干脆不发。
- **一次回复只存一次。** 应用按它自己的账存一次回复。你这一边：每条用户消息恰好一个 `result`，打断之后什么都不再发。

先读的代码：`electron/brain/claude-launch/`（进程怎么启动和结束）、`electron/brain/claude-process.ts`（轮次、打断、时间限制）、`electron/brain/claude.ts`（`claudeArguments`、`claudeInput`、`ClaudeStreamReader`、`findClaude`、`claudeEnvironment`、`streamClaude`）、`scripts/claude-discovery.mjs`，然后是上面提到的假 Claude 和它们的测试：`tests/smoke-fake-claude.test.ts`、`tests/claude-session.test.ts`、`tests/claude.test.ts`。

### 转接程序的安全底线

这些没有商量余地，只有 2026-11-26 放宽的那一条除外（和第 5 节是同一条底线；先读那一节开头的说明）：

- **转接程序不给陪伴聊天加工具。** 如果你的命令行或 API 能运行命令、读文件、浏览网页或加载 MCP 服务，转发时把这些关掉（或者拒绝运行），并让 `init` 里的 `tools: []` 和 `mcp_servers: []` 保持属实。关不掉、或拿不出这种证明，现在也可以：改为把聊天关在碰不到东西的地方（文件系统拒绝，只留它自己的临时文件夹；工具走的网络关掉；一出现工具请求就停这一轮；每次启动自检），而且仍然不给聊天加工具。永远不要把一个工具请求当文本转发给应用；如果你的后端要求用工具，就以一个错误的 `result` 结束这一轮。不要把用户自己的 agent 设置读进聊天。
- **密钥留在主进程里，或留在你自己命令行的登录里。** 应用从不把密钥交给窗口。不要把密钥写进转接程序的源码、日志或命令行（命令行别的程序看得到）。
- **不要把用户的数据发给用户没选的服务。** 提示词文本里带着私人的对话、记忆，有时还有一帧摄像头或屏幕画面。它可以去用户为这个应用选的那个后端，别的地方都不行：不加额外的日志服务，不做遥测，不为了"质量"再调第二个模型。不要把画面或提示词存到磁盘上。
- **另外两个开关在审查之前保持关闭：** 任务执行和内部的 MCP 通道（第 3.1 节和第 5 节）。

### 按组合选起点（只是起点，不是承诺）

这些行没有一行被维护者测试过。"未验证"就是字面意思：去查你自己命令行当前的非交互和流式选项，不要照抄这一页上的参数名；这里故意一个都没给。

| 系统和 agent | 接在哪里 | 要留意 | 先验证什么 |
|---|---|---|---|
| **macOS + Codex** | 转接程序转发给 Codex 的非交互或 JSON 事件模式（去查你的命令行的非交互、JSON 流模式；未验证）。 | 流的粒度（只在整条消息时才输出的模式会让第一个字很晚）；聊天时工具和 shell 是不是真的关了（拿出证明，拿不出就把聊天关在碰不到东西的地方，见安全底线）；取消的办法是收到 `SIGTERM` 就结束子进程；MCP 支持各不相同。 | 手动测试：往转接程序里灌一行 `user`，看有没有 `init`、增量和 `result`。 |
| **macOS + DeepSeek** | 转接程序调用一个兼容 OpenAI 的 chat-completions 端点，开流式，把每一段流出的内容对应成一个 `text_delta`（对你的账号来说未验证：模型名、限制、确切的字段）。 | 自己保存消息列表；不发任何工具定义；打断时和收到 `SIGTERM` 时中止 HTTP 请求；推理型模型可能会输出推理文字，这些不能进 `text_delta`；检查模型是否遵守封闭的记号。 | 同样的手动测试，然后做一个小的一次性调用（`--model haiku` 那种形状），它必须返回严格的 JSON。 |
| **Linux + DeepSeek** | 同 macOS + DeepSeek。 | 同上，另外：图形界面启动不会继承你 shell 里的变量，所以把密钥放在你的转接程序读得到的地方（它自己的、只有所有者能读的配置文件），不要放在应用的环境变量里；把转接程序文件设成可执行。 | 同上，然后在一个有显示环境的启动器里设好 `CLAUDE_PATH` 运行 `pnpm dev`。 |
| **Linux + OpenCode** | 转接程序转发给 OpenCode 的非交互模式，或者它的本地服务（如果有的话；去查它当前的文档；未验证）。 | 它有没有一个无工具模式（你能不能证明它，还是只能改为把聊天关起来）；是否支持流式；`SIGTERM` 时的进程清理；MCP 是它自己的事。 | 手动测试，然后检查转接程序转发出去的东西里哪里都没有工具列表。 |
| **Windows + 别的 agent** | 转接程序编译成 `.exe`（`.cmd` 壳启动不了），转发给那个 agent 的命令行或 API（对任何具体的 agent 都未验证）。 | 应用用 `taskkill /T /F` 结束整棵进程树，所以子进程会随转接程序一起死；把很长的系统提示词当作数据交给你的后端，永远不要通过 shell 命令行。 | 在终端里手动测试，然后 `pnpm dev`；这是应用做出来时用的系统，所以窗口行为应当本来就能用。 |

### 接好自己的 agent 之后的自检

按顺序做；遇到第一个不过的就停下，先修好再往下。

1. **先在假 Claude 上跑起应用。** 在你的转接程序存在之前，先证明你的机器能运行应用：`pnpm install`、`pnpm typecheck`，然后 `node scripts/dev/test-all.mjs`（在 macOS 和 Linux 上，预期会有只限 Windows 的失败；按 4.3 节的办法分类）。打包冒烟（`pnpm smoke`，`scripts/smoke.mjs`；先读它的开头）在一个隔离的一次性配置上、用假 Claude 运行应用，从不碰真实的配置或真实的模型。然后 `pnpm dev`，看预装的 Gene 模型渲染出来。
2. **换上你的转接程序。** 不通过应用手动测试它：往里灌一行用户消息，检查 `init`、增量和 `result` 是不是按上面的样子出来，以及 stdin 关闭时它会退出。然后 `CLAUDE_PATH=<转接程序> pnpm dev` 并发一条消息。
3. **第一个字。** 记下第一个字过多久才出现。设计目标是模型开始之后大约一秒内出第一句；只输出整条消息的后端会错过这个目标，这是要报告的发现，不是要藏起来的东西。
4. **隐藏记号不漏。** 至少看十几条回复，在屏幕上或朗读的声音里找 `<sh-` 文字、`⟦look`、原始 JSON，或推理和"计划"类的文字。只要出现任何一个，就是模型无视了封闭的记号，或者你的转接程序加了文字；不要在应用里把它糊过去。
5. **取消要真的停。** 在一条回复中途按停止、中途换角色、盖过她说话：之后什么都不能出现，也不能有转接程序或后端进程残留（查进程列表；在 Unix 上这是在测你对 `SIGTERM` 的处理）。
6. **一次回复只存一次。** 一条正常回复、一条被打断的、一条被顶替的之后，对话历史里每一条都必须恰好存一次（通过开发配置上的应用去看，不要去改文件）。
7. **没有给陪伴聊天加工具。** 转接程序的 `init` 里是空列表（聊天实际运行时确实如此：已证明，或已按安全底线关起来），你给后端的请求里没有任何工具定义，而且故意发一句"运行这个命令"，得到的是话，不是动作。对着你的改动运行 `tests/brain-gates.test.ts`、`tests/claude.test.ts` 和 `tests/claude-session*.test.ts`；不要削弱它们。
8. **小调用。** 一次性调用要以退出码 0 返回干净的文字或 JSON；试一个慢的和一个失败的后端，检查应用显示的是它安静的"她现在答不了"状态，而不是卡住。
9. **如实汇报。** 在你自己的分支的笔记里写下你量过什么、没量过什么；这个仓库不承诺你的组合能用。

## 3. 替换大脑

所有依赖 Claude Code 的东西，都按接缝列在下面。应用的其余部分和这些接缝对话，不直接和 Claude 对话，所以替换大脑就是重新实现这些接缝，不是去改陪伴本身。

### 3.1 接缝

| 接缝 | 现在 | 在哪里 | 你的替代品必须提供什么 |
|---|---|---|---|
| **陪伴聊天的一轮** | 每个角色一个长驻的 `claude -p --input-format stream-json --output-format stream-json --include-partial-messages` 进程；每轮用户消息写进 stdin；文本以增量事件的形式到来 | `electron/brain/claude-session.ts`（`PersistentClaudeChat.stream`）、`claude-process.ts`、`claude-session-prompt.ts`，池在 `session-pool/` | `stream(task, signal, emit, control?)`：用 `emit('delta', text)` 流出文本，跨轮保持上下文（或每轮重建，更慢），遵守 `signal`（中止之后不能再出文本），在 `close('context')` 时开一个新的上下文。`task` 上的提示词和图片取值函数必须在写出的那一刻读，不能提前读。 |
| **陪伴聊天里没有工具（Claude 版今天的做法）** | 启动参数关掉所有工具、MCP、斜杠命令、用户设置和会话持久化；启动报告（`system/init`）必须不列任何工具和 MCP 服务；流里出现任何工具块都会停下这一轮 | `electron/brain/claude.ts`（`claudeArguments`、`ClaudeStreamReader`） | 一种能证明模型没有工具的办法，或者改用"关起来"的兜底办法（第 5 节第 1 条；2026-11-26 起不再要求必须拿出证明）、一个出现工具请求时在运行中停下的机制，以及对任何 `kind` 不是 `'chat'` 或 `writable` 的任务一律拒绝。安全底线第 1 条。 |
| **一次性小调用** | 每次调用一个全新的 `claude -p`，带它自己的系统提示词和模型名；大多数回答一行文字或一个 JSON 对象 | `electron/brain/claude.ts` 里的 `streamClaude`；端口 `ClaudeLinePort`（`shared/foundation/ports.ts`：`line(prompt, systemPrompt, signal) -> { text }`，类型里没有工具）；`quickLineWithClaude` | 一个函数：输入提示词 + 系统提示词（+ 可选的图片），输出文字和用量，可取消，有硬性的时间上限。大约二十来个调用方在用它（反应判断、心情判断、停顿位置、内心循环、笔记、日记、模型检查，等等）。 |
| **模型档位** | 小判断用 `haiku` 别名（便宜又快）；陪伴自己的声音用聊天模型；聊天模型为空意味着 Opus，`follow-default` 意味着 Claude Code 的默认；别名在到达 `--model` 之前会被校验；当账号不让用隐含的 Opus 时，应用会切到 `follow-default` 一次（`electron/brain/chat-model-fallback.ts`，以 Claude Code 的"issue with the selected model"这段文字为依据） | `shared/foundation/defaults.ts`（`CLAUDE_MODEL_ALIASES`）、`shared/brain/claude-model.ts`、`electron/initiative/inner-loop/model.ts` | 一个小模型的名字和一个大模型的名字，对应到你的提供方上。预计要动别名列表和那一个写死的小模型。 |
| **可用性和失败文字** | 失败是从 Claude Code 的英文错误短语里分类的（额度、登录过期、限流、离线、证书、程序缺失）；离线的快速通道读 `system/api_retry` 事件；重置时间是从文字里解析出来的 | `shared/brain/claude-failure.ts`、`electron/brain/chat-availability*.ts`、`chat-outage.ts` | 一个针对你提供方错误的分类器，返回同一组封闭的种类。认不出的错误安全地归到"其他"。 |
| **进程启动门和发现** | 启动之后、以及 30 分钟没有成功回答之后，一次只启动一个 Claude 进程（Claude Code 自己会轮换登录令牌；并发刷新可能让用户登出）；`claude` 在 `CLAUDE_PATH`、PATH 和官方安装位置上被找到 | `electron/brain/claude-start-gate.ts`、`scripts/claude-discovery.mjs`、`electron/brain/claude.ts` 里的 `findClaude`、`scripts/setup.ps1`（那份清单的第二份拷贝） | 你自己的定位器和登录检查。如果你的大脑是一个 HTTP API，启动门就不需要；只有当你的登录也有同样的隐患时，才保留"一次一个"的想法。 |
| **内部通道（MCP）** | 一个小小的 stdio MCP 服务，让用户自己的 Claude Code 改她的角色、设置和声音；大约 40 个工具，分三档（只读、直接做、需要在 `userWords` 里带用户自己的话）；应用用 `claude mcp add` 登记它 | `scripts/soft-hearts-mcp.mjs`、`electron/safety/agent-channel/`（`registry.ts`、`app-tools.ts`、`claude-code-link.ts`、`tools/`），目录 `shared/safety/agent-channel-catalog.json` | 一个能调用 stdio MCP 工具的客户端（或者复用注册表，另写一种传输）。应用没法验证 `userWords` 真的是用户的原话：这一点靠调用方，所以一个新的调用方需要重新做一次安全审查。敏感的操作（隐私、花钱、删除、载入文件）仍然会在应用里弹出对话框。 |
| **任务执行（可选，默认关闭）** | 一个单独的 `claude -p` 进程，带受限的工具清单；读是自动的，写和运行命令每次都通过本地的权限服务询问用户；启动报告会被校验（`permissionMode`、工具、服务、工作文件夹） | `electron/safety/claude-tasks/`（`process.ts`、`policy.ts`、`permission-server.ts`） | 一个能把每次写和每条命令交给应用批准并等待回答的任务执行器，再加一个像 `verifyTaskInit` 那样的启动检查。如果你的做不到，就让任务执行保持禁用。 |
| **她的文字和隐藏记号** | 模型会多写一些结构，应用在显示或朗读任何东西之前先剥掉：一个带每轮代码的开头记号（默认关）、一个尾块（心情反应、手势、用户状态判断、设置提议、纪念）、控制节奏的断句词、她想要更清晰的摄像头或屏幕画面时的看记号、闹钟记号；每个都用每轮一个的随机令牌包起来 | `electron/mood/mood-chat.ts`、`electron/brain/reply-opening.ts`、`electron/brain/speech-beats/`、`electron/brain/look-continuation.ts`、`electron/brain/reply-draft-guard.ts`，提示词在 `shared/brain/companion-rules.ts` 和 `electron/brain/claude-session-prompt.ts` | 一个能稳定遵守封闭词汇记号的模型。每一个解析器都是失败就关（不认识或格式不对的记号会被丢掉，绝不显示），但一个无视它们的模型会给你一个平的、不那么有生气的陪伴。把你的模型的漏出形状重新收集进草稿守卫。 |
| **安装文字和界面措辞** | `START-HERE.md`、`README.md` 和若干界面字符串里写着"Claude" | `src/safety/AgentChannelPanel.ts`、`shared/safety/agent-channel.ts`、`src/cards/CharacterUnderstanding.ts` 等 | （名字：见 3.5）你自己的名字和安装步骤。 |
| **记忆的范围** | 聊天记忆以角色加连接来索引：种类、基础地址，以及在第一次 0.2.0 启动时钉在 `provider.memoryModel` 里的一个模型名（改聊天模型不再改变它） | `electron/foundation/memory-provider-scope.ts`、`electron/settings/memory-pin.ts`、`electron/memory/memory.ts`（`scopeKey`） | 一个稳定的连接标识。在已有的配置上换大脑时保持这个钉；改了它，记忆会显得断开（并没有被删）。 |

### 3.2 哪些行为依赖 Claude

- **封闭的隐藏记号和先说话的记号。** 回复协议假定模型能稳定地写出几个词汇固定的块。所有解析器都很严格，认不出的就丢掉，但质量取决于模型守不守规矩。
- **提示词缓存。** 固定的角色提示词、每个角色一个热进程、以及下一个进程的预热，都是围绕按工作目录和内容块前缀复用缓存来设计的。没有缓存的话，第一个字的延迟大概要长好几倍，每一轮也更贵。
- **haiku 量级的判断。** 大约二十来个后台调用假定有一个小的、便宜的、快的模型，能回答严格的一行 JSON 或一句短话。换成更慢或更贵的模型，这些调用会主导花费和时间；换成更弱的模型，解析器会丢掉答案，功能是变安静而不是变错。
- **流的节奏。** 第一个字的目标（大约一秒内出第一句）是对着 Claude Code 的流分块量出来的，它在第一块之后会停 0.2 到 0.5 秒。别的提供方节奏不同；要重新量。
- **打断。** 停止和顶替依赖一个带宽限期的 `control_request` 打断，然后是杀进程。一个没有按 id 取消功能的提供方，至少得保证中止之后不再交付任何东西。
- **模型自己的习惯。** 草稿过滤和 JSON "取最后一个对象"的提取，处理的是 Claude 产生的漏出（推理文字、答案前面的标签）。别的模型漏的方式不一样。

### 3.3 换了别的模型，多半会变差的地方

角色的声音（提示词是照 Claude 调的；"她听起来还像她自己吗"必须重新测）、第一个字的速度、记号遵守程度（心情反应、手势、节奏）、后台判断（反应、心情、笔记、日记的质量）、感知功能里的图像理解质量，以及拒绝的行为。陪伴的规则（`shared/brain/companion-rules.ts`）是用中文写的，并且是照 Claude 的指令遵循能力调的。

只在另一个模型上运行（比如 DeepSeek，通过一个假装成 `claude` 的转接程序）是可以的，但移植时要先检查这几点：

- **图片。** 每一轮都可以带屏幕和摄像头的小图，一起看和看一眼的功能会描述画面。如果模型不能接图片，这些功能要么停用，要么得给一次性调用另配一个能看图的模型。
- **隐藏记号。** 表情、手势、走动、画面、闹钟、里程碑和笔记，都是她写在回复里的看不见的记号。一个对格式遵守得松的模型可能会漏写、拼错，或让它们显示在气泡里；过滤器只藏格式正确的那些。
- **速度。** 第一个字的速度靠的是固定角色提示词的提示词缓存和一个热进程；别的提供方缓存方式不同，所以第一个字可能更晚。
- **是 agent，不只是模型。** 任务执行（经用户批准读写文件）和内部通道（用户自己的 agent 调用的 MCP 工具），需要一个带工具和 MCP 的 agent 外壳，不是一个单纯的聊天模型；选一个支持你所用模型的 agent。
- **我们没有测过。** 应用是照 Claude 调的；她换了别的模型之后还像不像她自己，要由移植的人来判断。

### 3.4 移植大脑的一个合理顺序

1. 用另一个后端实现一次性端口（`ClaudeLinePort`、`streamClaude`），让后台的小判断先跑起来。
2. 对着你的流式 API 实现 `PersistentClaudeChat.stream`，保住对你的大脑成立的"没有工具"断言（如果你把聊天关起来，就保住对应的检查）、取消，以及一次只处理一轮的规矩，并让第 5 节里的测试对着你的大脑通过。
3. 替换发现、登录检查、失败分类和界面措辞。
4. 在你为你的调用方审过它们的安全规则之前，让内部通道和任务执行保持禁用。
5. 重新调提示词，重新量第一个字的延迟和记号遵守程度。

### 3.5 应用里哪些地方写着 Claude

**这里列出的每一处，都可以改成你自己的 agent。** 人们读到的名字是一行；真正运行 Claude Code 的地方，按上面"Plug yourself in: the brain protocol"（把你自己接进来：大脑协议）所说，通过接上你的 agent 来改。这张清单上没有一样是锁死的。

指引，不是锁：不是跑在 Claude 上的移植版，应当显示自己的名字，不要自称 Claude；跑在 Claude 上的移植版，名字就保持原样。

**名字，集中在一个地方。** `shared/foundation/assistant-name.ts`：

```ts
export const ASSISTANT_NAME: string = 'Claude';          // 「Claude 助手」, 「由 Claude 操作」, "your Claude"
export const ASSISTANT_CLI_NAME: string = 'Claude Code'; // 「你的 Claude Code」: what the program that runs the agent is called on screen
```

改这两行，屏幕上的文字就跟着变。它通过两条路到达屏幕：

1. 经过 `t()`（`shared/foundation/ui-language.ts`）或窗口标记辅助函数（`src/foundation/ui-language.ts`：`uiText`、`uiMarkup`、`uiHtml`）的文字，在最后一步由 `applyAssistantNames()` 替换：整词的 `Claude Code` 变成 `ASSISTANT_CLI_NAME`，整词的 `Claude` 变成 `ASSISTANT_NAME`；`Claudette` 或小写的 `claude` 命令不动。词典（`shared/foundation/ui-copy.*.en.ts`）保留原样写的那个词，因为英文是按确切的中文原句去查的。
2. 不经过 `t()` 的主程序一侧消息（错误、通知、对话框、工具结果、数据表的行、诊断），用模板字符串由这两个常量拼出来。

在这个版本上，两条路给出的文字和以前显示的完全一样。`tests/claude-names.test.mjs` 把这一点钉住了，并且证明改了名字，两条路都跟着变。`scripts/dev/claude-names-scan.mjs` 列出仍然含有这个词的每一个字符串，`scripts/dev/claude-names-allowlist.json` 说明哪些文件可以含、为什么，出现新的写死的名字时测试会失败。

已知的限制：当一条现在带着这个常量的主程序一侧消息，同时又是一个英文词典的键时，这个键就是那些确切的词；你改了 agent 的名字，这样的英文条目就对不上了，显示出来的是中文。改名字时，要把这个键一起改。

**A 类：显示给用户看的名字（用常量改名）**

| 在哪里 | 她或用户读到什么 |
|---|---|
| `shared/foundation/ui-copy.*.en.ts` 和 `src/` 下的窗口（通过 `uiText()`、`t()`、`uiHtml()`） | 「Claude 助手」页、「Claude 任务」页和它的批准、「Claude 内部通道」面板、「由 Claude 操作」徽标、写着"你的 Claude"的设置提示、了解角色的聊天、用量说明（"会用你的 Claude 用量"） |
| `electron/brain/claude*.ts`、`shared/brain/chat-availability.ts`、`electron/brain/chat-settings.ts` | 聊天失败的话（离线、被拒绝、没有回复、超时、登录）、「由 Claude 操作：…」通知 |
| `electron/safety/{agent-channel,assistant,claude-tasks,test-commands}/**`、`shared/safety/{claude-link-diag,codex-tasks,diagnostics,journal-entries}.ts` | 通道工具的结果、连接诊断、任务和助手进程的错误、批准文字 |
| `electron/cards/**`、`shared/cards/**`、`electron/stage/personalize-*.ts`、`electron/wiring/stage-body-wiring.ts` | 角色卡转换和翻译的通知、"语言研究用的是当前的 Claude 连接" |
| `shared/settings/capabilities.ts`、`shared/settings/capability-handbook.ts`、`electron/foundation/data-map*.ts`、`electron/senses/sense-cards.ts`、`electron/unbound/permission-bundle.ts` | 手册里的设置说明、数据表的行、各个感知开关说它们发出什么 |

**B 类：真正调用 Claude Code 的地方（通过接上你的 agent 来替换）**

用转接程序接上：把 `CLAUDE_PATH` 指向一个说同样命令行和 stream-json 的程序（参数和消息见上面的"最短的路"、"应用怎么找到并启动 `claude`"和"应用往 stdin 写什么"）。每一处：它为她做什么、在哪里、你的替身必须提供什么。

| 它为她做什么 | 在哪里 | 你的替身必须提供什么 |
|---|---|---|
| **长驻的聊天进程**：每个角色一个热进程；她的回复一个字一个字流出来；新消息或停止会打断她 | `electron/brain/claude-session.ts`、`claude-process.ts`、`session-pool/`、`long-chat/`、`claude-launch/`（一个工作线程启动这些进程） | stdin/stdout 的 stream-json、增量文本事件、打断、没有工具（启动报告必须不列任何） |
| **一次性的小判断**（haiku 量级）：反应和心情判断、接话和停顿说话的决定、"看"和"一起看"的描述、日记和笔记、特别日子的话、设备判断、订阅源识别、内心循环、舞台编排 | `electron/brain/claude.ts` 里的 `streamClaude`，以及 `electron/{initiative,mood,memory,senses,voice,stage,unbound}/**` 和 `electron/brain/{module-router,pause-talk,speak-only}/` 里调用它的地方 | 一个全新的无工具调用，回答一行文字或一个 JSON 对象，又快又便宜；`haiku` 只是一个别名，你的转接程序可以把它对应到别的 |
| **任务执行**（默认关闭；每次写或运行命令都问用户） | `electron/safety/claude-tasks/`（`process.ts`、`service.ts`、`policy.ts`） | 一个单独的、带受限工具清单的进程，一个本地的权限询问工具，一份诚实的启动报告；在你为你的调用方读过它的安全规则之前，让它保持关闭 |
| **「Claude 助手」**（用户自己的 agent，在控制窗口里，用来使用和调整 soft hearts） | `electron/safety/assistant/` | 一个能用工具、够得到内部通道的进程；它不是她，什么都不会进她的记忆 |
| **角色卡转换、翻译和"聊聊这个角色"** | `electron/cards/character-convert/`（`model.ts`、`translate.ts`）、`electron/cards/character-understanding.ts` | 普通的一次性调用，回答较长，走同一条 `streamClaude` 的路 |
| **内部通道**（你自己的 agent 通过 MCP 操作应用） | `electron/safety/agent-channel/`（`claude-code-link.ts` 运行 `claude mcp add/get/list/remove`；`host.ts`、`registry.ts`、`tools/`）、`scripts/soft-hearts-mcp.mjs`（stdio 的壳）、工具文字在 `shared/safety/agent-channel-catalog.json`（15 处提到 Claude） | 一个能用 MCP 服务的 agent。MCP 服务的名字是 `soft-hearts-next`（开发配置是 `soft-hearts-next-dev`；见 `credentials.ts`、`setup-text.ts` 里的 `AGENT_EDITION`）。用你的 agent 自己的机制代替 `claude mcp add` 去登记它，并改目录里的描述 |
| **找到并安装 `claude` 命令** | `electron/brain/claude.ts` 里的 `findClaude`、`scripts/claude-discovery.mjs`、`scripts/setup.mjs`、`scripts/setup-platform.mjs`、`scripts/setup.ps1`、`electron/brain/chat-availability-host.ts`（帮助页） | 把 `CLAUDE_PATH` 指向转接程序，或者改发现逻辑去找你的命令 |
| **点名它的诊断和启动门** | `shared/safety/claude-link-diag.ts`、`electron/brain/claude-start-gate.ts`（启动之后、以及 30 分钟没有回答之后，一次只启动一个进程）、`shared/brain/journal-entries.ts` | 你的 agent 能把它的错误对应上去的失败类别（登录、额度、离线、程序缺失）；决定你要不要"一次一个"的启动门 |

维护者在一张私下的表里保存着同样的清单，带每一个调用点、每个参数，以及弄错每一处的风险（七组共 77 行；这些组就是上面的各行）。如果你要移植，自己也保存一份。

**C 类：她读到的、讲 Claude 的文字（手动改写，不要用替换）**

大约 28 个字符串告诉她、或告诉另一头的 agent 一些关于 Claude 的事：她不能说自己是 Claude 或编程助手、Claude 自己的安全规则仍然适用、一次角色卡谈话是怎么进行的。它们在这些提示词文件里：`shared/foundation/i139-texts.ts`、`shared/brain/companion-refusal-rules.ts`、`shared/mood/realer-emotions.ts`、`shared/cards/character-understanding.ts`、`shared/initiative/inner-loop.ts`、`shared/initiative/rps-voice.ts`、`shared/senses/{feed-recognition,sense-router}.ts`、`electron/brain/{claude-session-prompt,outage-lines}.ts`、`electron/brain/stage-chat/model.ts`、`electron/initiative/her-folder/keepsake-prompt.ts`、`electron/safety/assistant/prompt.ts`。用你的 agent 的口吻重新写，并重新测她是不是仍然像她自己。允许清单把它们标成 `prompt` 这一类，所以扫描能找到它们。

故意保持原样的：`shared/initiative/take-me-there*.ts` 里的页面名匹配（它是用和页面相同的那些词去读页面名的，所以改名之后要检查它）、工作线程脚本 `electron/brain/claude-launch/off-main.ts` 里的一行错误文字（它是一个不能导入东西的脚本字符串），以及 `shared/memory/letter.ts` 里一封固定的、写的是过去的信。

## 4. 在 macOS 或 Linux 上运行

代码是 Electron 和 Node 上的 TypeScript，所以大部分在构造上就是可移植的。下面的清单是**不可移植**的那部分：每一行说它做什么、在别的系统上是否已经安全地降级、你要用什么替代。"没测过"适用于每一个替代品：没有人在别的系统上运行过这个应用。

### 4.1 真正只限 Windows 的

| 方面 | 文件 | 它做什么 | 现在在别处会怎样 | 移植用什么 |
|---|---|---|---|---|
| **结束进程树** | `electron/brain/claude-launch/off-main.ts`（工作线程）、`electron/brain/claude.ts` 里的 `terminateClaude`、`electron/safety/claude-tasks/process.ts`、`electron/cards/character-convert/quit.ts` | 通过 `System32` 运行 `taskkill /PID <pid> /T /F`，然后是一次普通的 kill；由工作线程运行，这样启动它不会卡住界面线程 | 退回 `child.kill()`（不杀整棵树） | POSIX：让子进程在自己的进程组里启动（`detached`），用 `process.kill(-pid)`；保留工作线程的做法 |
| **前台程序**（只在屏幕共享开着时） | `electron/senses/foreground-app.ts` | 一个 Windows PowerShell 辅助程序调用 `GetForegroundWindow`，报告程序的文件名 | 在 Windows 以外探测返回 `null`（功能缺席） | macOS：通过 `NSWorkspace` 取最前面的应用（一个小的原生辅助程序或 AppleScript，不需要屏幕内容）。Linux：X11 的 `_NET_ACTIVE_WINDOW` 或合成器的 API；Wayland 没有通用的答案 |
| **正在播放什么** | `electron/senses/now-playing/service.ts`、`script.ts` | PowerShell 读系统媒体会话（SMTC）；只在"一起听"开着时 | 在 Windows 以外返回 `null` | macOS：通过一个辅助程序取"正在播放"信息；Linux：D-Bus 上的 MPRIS |
| **显示器的物理尺寸** | `electron/unbound/display-size.ts` | PowerShell 读 WMI 的 `WmiMonitorBasicDisplayParams` 和注册表里 EDID 的厘米字节，让全屏的角色按真实厘米来缩放 | 在 Windows 以外返回 `null`（这时她的大小是按显示器的 DPI 估的，不是量的） | macOS：`CGDisplayScreenSize`；Linux：`/sys/class/drm/*/edid` 里的 EDID 或 `xrandr --verbose` |
| **有全屏程序在前面** | `electron/unbound/fullscreen-watch.ts` | PowerShell 辅助程序每秒轮询一次 `SHQueryUserNotificationState`（这对她只是一个事实，从来不是把她藏起来的理由） | 在 Windows 以外什么都不做 | macOS：从窗口列表取演示 / 全屏空间的状态；Linux：`_NET_WM_STATE_FULLSCREEN` |
| **在界面线程之外启动辅助程序** | `electron/unbound/off-main-spawn.ts` | 从一个工作线程启动上面那些辅助程序 | 与平台无关 | 保留 |
| **系统声音采集**（"一起听"、对音乐的反应） | `electron/senses/system-audio.ts`、`src/senses/SystemAudio.ts`、`electron/wiring/senses-listen-wiring.ts` | Electron 的 display-media 加 Windows 的回环音频；运行时除非平台是 `win32` 否则拒绝启动；环境聆听也以 `win32` 为条件 | 带一条消息拒绝 | macOS 和 Linux 在原装的 Electron 里没有对应的东西（以这个仓库用的 Electron 版本线为准）：一个虚拟回环设备，或更新的 Electron 能力 |
| **离线组件**（姿势、语音识别、认脸、声纹、"按意思想起"） | `electron/foundation/pose-manifest.ts`、`asr-manifest.ts`、`electron/senses/pose/component-store.ts`（`defaultComponentRoot` 需要 `LOCALAPPDATA`）、`electron/memory/memory-semantic/electron-wiring.ts` | 把模型文件和按平台分的运行时包（`win32-x64`、`win32-arm64`，带 DirectML 库）下载到组件文件夹；语音识别用的是 sherpa-onnx 项目的 SenseVoice 模型 | 在 Windows 以外 `posePlatform()` 返回 `null`，组件根目录是 `null`，所以这些全都保持关闭 | 为你的平台构建运行时包（onnxruntime-node 带 macOS 和 Linux 的二进制；DirectML 只有 Windows 有：用 CPU、CoreML 或 CUDA 的提供方），把平台加进 `POSE_PLATFORMS`，从 `app.getPath('userData')` 算出一个组件根目录 |
| **网络设置的快捷入口** | `electron/brain/chat-availability-host.ts` | 从"连不上"的帮助里打开 Windows 的网络设置页 | 抛出一条清楚的消息 | 打开该平台的网络偏好设置，或者去掉这个按钮 |
| **启动时检查进程是否还在** | `electron/wiring/startup-wait-wiring.ts` | 用 `tasklist`，因为 Windows 在进程真正消失很久之前就设好了退出码 | 用 `process.kill(pid, 0)` | 已经处理好了 |
| **受管的桌面通道**（安装好的稳定版和开发版、版本文件夹、校验过的不可变包） | `electron/desktop-channel.ts`、`electron/desktop-entry.ts`、`electron/desktop-shortcut.ts`、`electron/lnk-plain-path.ts` | 校验一个打包好的 Windows 版本，并写 `.lnk` 快捷方式（包括一个对 OneDrive 安全的快捷方式目标） | 需要 `win32` 和打包好的应用；否则不返回通道，应用作为普通的源码版或便携版运行 | 跳过整个通道系统；发布一个应用包（macOS）或 AppImage / tarball（Linux） |
| **安装、更新和快捷方式脚本** | `scripts/setup.ps1`、`scripts/update-desktop.mjs`、`scripts/pin-delivery.mjs`、`scripts/refresh-desktop-shortcuts.ps1`、`scripts/start-latest.ps1`、`start-soft-hearts.cmd`、`promote-to-stable.cmd` | PowerShell 和 `.cmd` 的安装器、每晚的稳定版安装、写快捷方式 | `update-desktop.mjs` 在 Windows 以外拒绝运行。**`scripts/setup.mjs`（`pnpm setup:unix`，辅助函数在 `scripts/setup-platform.mjs`）现在用和 Windows 同样的规则去找 Claude Code（`CLAUDE_PATH`、PATH、官方安装文件夹；只读 `claude --version` 的字符串，从不登录，从不征求同意，从不做付费调用）。它没有在真实的 macOS 或 Linux 机器上运行过，也没有人维护：是给你自己的 agent 的一个参考起点。找不到 Claude Code 时它会打印下一步。改它的时候要保住第 5 节的安全底线** | `pnpm install` 然后 `pnpm dev`，或者 `pnpm build && pnpm start`；自己写安装器 |
| **维护者的工具** | `scripts/dev/*`（托盘的在场文件、真实磁盘检查、z 序探测）、许多 `scripts/*-smoke.mjs`、`tests/*first-run*.ps1` | Windows 路径、`taskkill`、PowerShell | 许多测试和冒烟假定了 Windows 的路径或工具 | 预期会失败；按测试逐个修或跳过 |

### 4.2 跨平台的 API，但只在 Windows 上调过和测过

| 方面 | 文件 | 移植的注意点 |
|---|---|---|
| **陪伴窗口** | `electron/main.ts`（创建窗口）、`electron/stage/pet-pointer-input.ts`、`pet-restore.ts`、`electron/unbound/window-options.ts` | 透明、无边框、`skipTaskbar`，用 `setIgnoreMouseEvents` 做点击穿透。Linux 上透明需要合成器，点击穿透的事件转发不是处处都有；macOS 上要检查 Spaces 和全屏应用。 |
| **置顶层级** | `electron/stage/pet-topmost.ts`（Windows 上是 `'pop-up-menu'`，别处是 `'floating'`）、`electron/unbound/*`（`'screen-saver'`）、`electron/brain/reply-window.ts` | 这套策略（停在普通窗口之上、不和别的置顶窗口抢、只在她自己的时刻抬起）是围绕 Windows 的 z 序设计的。按平台重新推出层级，并用截图工具和一个全屏视频来测。 |
| **工作区和任务栏的假设** | `electron/stage/*`、`electron/brain/reply-window.ts`、`electron/unbound/her-place.ts` 里的 `screen.getPrimaryDisplay().workArea` | macOS 的菜单栏和 Dock、Linux 的面板、多显示器布局里的负坐标。 |
| **托盘和全局快捷键** | `electron/wiring/shell-wiring.ts`（24 px 位图托盘图标，提示文字 "Ctrl+Alt+P"）、`electron/unbound/typing-wiring.ts` | macOS 要更小尺寸的模板图标，并用 Option 代替 Alt；Linux 需要 app-indicator。 |
| **密钥存储** | `electron/settings/settings.ts`、`electron/senses/face/store.ts`、`electron/senses/voiceprint/store.ts` | Electron 的 `safeStorage`（Windows 上是 DPAPI，macOS 上是 Keychain，Linux 上是 libsecret 或 kwallet）。三处在加密不可用时都**失败就关**（拒绝密钥，不登记任何东西）。在 Linux 上还要检查 `safeStorage.getSelectedStorageBackend()`，别接受明文的后端。`scripts/lib/desktop-profiles.mjs` 直接调用 DPAPI，但那是维护者的工具。 |
| **配置和数据路径** | `electron/profile.ts`、`electron/foundation/atomic-file.ts`、`electron/mood/color-block-log.ts` | 配置放在 Electron 的 `userData` 下。路径比较只在 `win32` 上不区分大小写。原子文件替换只在 Windows 上对 `EPERM`/`EBUSY` 重试。诊断文件夹用 `LOCALAPPDATA`，别处就是关着的。 |
| **GPU 恢复** | `electron/foundation/gpu-reset/` | 让 WebGL 在 GPU 进程反复崩溃后还能活下来的开关（在 Windows 上用 Electron 45 / Chromium 156 量过）。是标准的 Chromium 开关；在别处要重新量。 |
| **系统声音** | `src/voice/speech.ts`、`src/voice/output-sink.ts` | 朗读用浏览器的 `speechSynthesis`，所以声音列表和质量来自操作系统。选声音的逻辑假定了 Windows 的声音名字。付费的云端声音是普通的 HTTPS，可以移植。 |
| **摄像头、屏幕、麦克风** | `electron/senses/screen-capture.ts`、`screen-source.ts`、渲染进程的 `getUserMedia` | 标准的 Electron API，默认关闭。macOS 需要在应用包里声明隐私权限（摄像头、麦克风、屏幕录制）并在运行时申请；应用里还没有这部分代码。Wayland 的屏幕采集要走一个 portal。 |
| **打包** | `package.json` 的 `build`、`scripts/package.mjs` | electron-builder 有 `win portable`（x64、arm64）、`mac zip`、`linux tar.gz` 的目标，配 `pnpm dist:*` 脚本。只有 Windows 的那些被构建和运行过。 |
| **主机上的 Claude Code** | `scripts/claude-discovery.mjs` | 发现逻辑已经列出了 macOS 和 Linux 的安装位置；Claude Code 自己在 Windows 上需要 Git for Windows。对着你装的版本核对 stream-json 事件的形状。 |
| **可移植的，没问题** | Three.js 舞台、MMD 加载器、WASM 物理（Ammo）、`shared/`、角色卡、记忆逻辑、心情、隐私门 | 纯 TypeScript 或 WebGL。 |

### 4.3 在一个新系统上先测什么

1. `pnpm install`、`pnpm typecheck`，然后跑测试：运行 `node scripts/dev/test-all.mjs`，预期会有 Windows 路径和 PowerShell 的失败；列一张表，把"需要移植"和"只是测试里假定了 Windows"分开。
2. 先用 `pnpm dev`（开发配置，永远不要用你真实的那个），确认出现一个窗口，预装的 Gene 模型渲染出来并且会动。
3. 窗口行为：透明背景、透明区域上的点击穿透、始终置顶、拖动、隐藏到托盘、退出。
4. 用你的大脑做一次真实的聊天往返，然后在回复中途打断它，检查之后什么都没来。
5. 密钥存储：存一个密钥，重启，检查它还在；关掉钥匙串，检查应用拒绝。
6. 然后才是各个感知（每一个都在它默认关闭的开关后面）、声音和全屏模式。

## 5. 任何移植都必须保住的安全底线

**2026-11-26 改了一处。** 在此之前，"陪伴聊天不带工具，而且移植必须能证明"是一条底线。用户把这一条去掉了（他的原话大意：以后的软件是能借 agent 操作电脑的），下面其他几条照旧。Claude 版今天仍然让她的聊天不带工具，每次启动都检查启动报告，这部分代码没变。变的是对移植的要求：不再必须证明没有工具。拿不出这种证明的大脑，改为把聊天关在碰不到东西的地方（文件系统拒绝，只留它自己的临时文件夹；工具走的网络关掉；一出现工具请求就停这一轮；每次启动自检），并且不给聊天加工具。以后她也许会借用户自己的 agent 去操作电脑；这个方案还没写，应用里现在没有它的任何部分。

移植可以换大脑，可以换操作系统。这些不能丢。测试守着它们；对着你的改动运行这些测试，不要为了让一个移植通过而削弱它们。

1. **不给陪伴聊天加工具；拿不出证明就把它关起来。** 聊天的轮次是 `kind: 'chat'`，从不可写。Claude 版让聊天不带工具，并且每次启动都证明这一点。拿不出这种证明的大脑，必须改为把聊天关在碰不到东西的地方（文件系统拒绝，只留它自己的临时文件夹；工具走的网络关掉；一出现工具请求就停这一轮；每次启动自检），并且不给聊天加工具。（`tests/brain-gates.test.ts`、`tests/claude.test.ts`、`tests/claude-session*.test.ts`。）
2. **密钥留在主程序。** API key 和令牌只在主进程里，用系统的安全存储加密。渲染进程从不收到密钥、Node API、任意路径或通用的 shell 或 RPC；预加载白名单是唯一的门。导入角色卡不授予文件或执行权限；导出不带路径、密钥、实时状态或私人历史。
3. **感知默认关闭，只有用户自己的话才能打开。** 屏幕、摄像头、麦克风、系统声音、付费声音和任务执行一开始全部关闭，需要用户明确地打开：在设置里、对她说、或对用户自己的 Claude 说。来自网页、文件或别的 agent 的话不算同意。密钥和运行命令的设置永远不经过内部通道。（`tests/senses-privacy-gates.test.ts` 把这些门钉住了。）
4. **一次回复只存一次档、只奖励一次。** 被取消的、迟到的、或上下文已经变了的结果，从不复活，也从不覆盖更新的状态。（`tests/brain-gates.test.ts`。）
5. **私人数据从不离开这台机器。** 对话、日记、画像和记忆都在本地；什么都不上传；删除会进入一个能完整恢复的回收站，只有人脸数据和关掉"允许录制"这两样是立刻删除。只有用户为一次通话开启的内容才会到达所选的模型，屏幕或摄像头的画面不保存。（`tests/data-map.test.ts`、`tests/memory-privacy-gates.test.ts`、`tests/i144-*.test.ts`。）
6. **身体的各个通道保持分开。** 姿势、手势和表情是独立的通道；原始的 PMX 和 VMD 字节从不被修改；动作从不瞬移。

如果一个替换的大脑既拿不出第 1 条的证明，也做不到上面说的把聊天关起来，陪伴聊天就不能跑在它上面。

## 6. 不提供支持

我们不测试、不运行、不维护别的模型和别的操作系统。这份指南的存在，是为了让想这么做的人能读懂代码、接得上，不是承诺它能用。关于移植到别的模型或系统的 issue，可能会不修就关掉。如果你做了一个，把它放在你自己的分支里，改掉配置文件夹和应用标识，让它读不到另一个安装的记忆（见 `electron/profile.ts` 和 `scripts/lib/app-identity.mjs`），并保住第 5 节的底线。

面向 agent 的入口，从 `docs/FOR-AGENTS.md` 开始。
