# For agents and developers picking this up

**中文：** soft hearts 专为 Claude 和 Windows 做。如果你是别的 agent（接别的模型）或想在 macOS / Linux 上跑它，先读 [docs/PORTING.md](PORTING.md)；它是地图，不是保证，别的模型和系统我们不测试也不维护。

**中文：** 别人用别的系统加别的 agent（macOS + Codex、Linux + DeepSeek、Linux + OpenCode 等）也可以：先读 PORTING.md 里的"Plug yourself in: the brain protocol"，它教你做一个假装成 `claude` 的转接程序，让应用把你当作"大脑"。

## If you are an agent who wants to be the brain on your own system

Any system (macOS, Linux, Windows), any agent (Codex, OpenCode, a DeepSeek-backed agent, your own). Work out how to connect yourself, in this order:

1. [docs/PORTING.md](PORTING.md), section "Plug yourself in: the brain protocol": the app starts a program called `claude` and speaks JSON lines with it. Build a small relay that pretends to be `claude` and forwards to your own CLI or API, then point `CLAUDE_PATH` at it. The section lists every argument, every message in and out, the time limits, how a process is cancelled and ended on each system, and what the hidden markers in the reply look like.
2. The same section has a table of starting points by system and agent (all unverified) and a self-check list to run after you plug in: first word, marker leaks, cancel, one archive per reply, no tools in companion chat.
3. The safety floor in section 5 applies to your relay: no tools for companion chat, keys only in the host or your own login, and the user's data goes only to the service the user chose.

## What this is

A desktop companion: a 3D character (PMX/PMD or VRM model) on the screen that talks, moves, has moods, remembers, and can optionally look, listen and run tasks (all off by default). Electron host, no-framework windows, a Three.js stage. **Made for Claude (through the user's own Claude Code) and for Windows.**

## Where to start

1. [docs/PORTING.md](PORTING.md): what is Claude-specific, what is Windows-specific, what you would have to provide to connect your own model or run on macOS or Linux, and the safety floor a port must keep. Best effort, not supported.
2. [docs/architecture.md](architecture.md): module boundaries. [docs/developing.md](developing.md): working on it after install.
3. `CLAUDE.md` at the repository root: the working agreement for a Claude Code agent in this repository.

## Rules that hold for every agent

- Develop against the development profile (`pnpm dev`), never against a real user profile.
- Do not weaken the safety floor in section 5 of `docs/PORTING.md` to make a change pass: no tools in companion chat, keys only in the host, perception off by default, one archive per reply, private data stays local.
- Do not commit private models, textures, chat logs, character-card text, keys or screenshots of someone's desktop. Third-party assets live only under `assets/bundled/` with their original credit.
- If you are the Claude installing it for a user for the first time, ask the language first (Chinese or English) and write it to `.local/first-language.txt` before the first launch: `START-HERE.md`, step 3. The app reads it once, on a fresh profile only.
- Put a new feature in its own part's folder and attach it through the wiring files; keep new files small.
- Run `node scripts/dev/test-all.mjs` before you claim something works.
