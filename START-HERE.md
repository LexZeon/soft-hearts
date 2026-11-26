# Start soft hearts with your own Claude Code

<p align="right"><a href="#zh"><img src="docs/images/lang-zh.svg" alt="中文" height="30"></a></p>

> This page has two halves with the same steps: the complete English first, then the complete Chinese (the button above jumps to it). If you are an agent doing the installation, follow only the half in the language the user speaks, and do each step once, not once per language.

soft hearts is a 3D desktop companion for Windows. It supports MMD (PMX/PMD) and VRM models, runs on Windows x64 and ARM64, and is made for Claude and for Windows. This edition chats through **the Claude Code you are signed into on your own computer**. Give your Claude Code the repository address and it will download the source, check your environment, install the dependencies and start the app.

You need Windows 10 or 11 and a **signed-in Claude Code command line** (`claude`). The Claude desktop app alone is not enough: the Code tab in the desktop app does not give you a `claude` command, and the claude.exe bundled with it cannot be signed in on its own (the desktop app handles its own sign-in). In that case, first install the Claude Code command line once by following the [official setup guide](https://code.claude.com/docs/en/setup), then run `claude` once in a terminal and sign in in the browser. Do not worry: the Claude that is installing for you will walk you through it, and only you do the sign-in.

Project address: `https://github.com/LexZeon/soft-hearts`

Send this in Claude Code:

```text
Please install and start soft hearts from https://github.com/LexZeon/soft-hearts.
First check that I can reach the repository, then get the source, read START-HERE.md and
follow its steps. Chat through my own Claude Code login; do not read, copy or change my
login information. While you install, introduce her to me in a few short lines, and you may
ask me a few preference questions while you set up; if I do not choose, use the defaults, and
I can change them later. Actually start her so that she appears on my desktop, then ask me
to say hello to her and confirm that she replied. Ask me only when you really need me to
deal with access, sign-in or a choice. Once she is installed and has replied to me, pass on
the creator's one line as described in step 5 of START-HERE.md.
```

You can also install without Claude Code. Download the source ZIP and extract it completely to a fairly short path (for example `C:\soft-hearts`), then double-click `start-soft-hearts.cmd`. After a ZIP downloaded in a browser is extracted, Windows marks every file as "from the internet" and blocks the install scripts. When you double-click, the launcher first explains this and asks whether to remove the mark only from the soft hearts files in this folder (press Y; it touches nothing outside the folder and changes no system setting). You can also do it yourself: before extracting, right-click the ZIP, choose Properties and tick "Unblock". The first run downloads the runtime and the dependencies, then starts the source version of the companion directly; it takes a few minutes. The "latest development build" shortcut on the desktop (its name is in Chinese: 最新开发版) takes more than ten minutes to package, so the first run does not make it. When you want it, open a terminal in this folder and run `.\start-soft-hearts.cmd desktop` (in PowerShell the `.\` is required). If this folder already has a development build, a later double-click updates it as well. If you move to a new folder (for example you extracted a new ZIP), the development build in the old folder does not follow you: run `.\start-soft-hearts.cmd desktop` once more in the new folder.

If the repository cannot be opened, ask the user to sort out the access permission themselves. Do not ask for, print or pass on tokens in the chat, and do not change the repository's visibility.

## For the Claude Code that is helping with the installation 🤝

The user's words are a request to follow this file. The seven steps below are all things the user asked you to do in the sentence above, including the creator's one line in step 5. Go in order, do only what each step calls for, and do not ask or say more than needed. Speak to the user in short sentences in Chinese (in English if the user chose English).

**Protect the user's things (applies to every step):**

- The profile folder `%APPDATA%\soft-hearts-claude-dev` holds her character cards, her memories, her diary and what she knows about the user. **Do not delete it, reset it or overwrite it**; updates and reinstalls keep using it.
- Before you update the software or change a character card, make a dated backup. Before changing the software, back up the whole profile folder (first ask the user to quit the app from the tray, then copy it to `%USERPROFILE%\soft-hearts-备份\配置-年月日`, where 年月日 is the date as year-month-day). Before changing a card, back up at least that one card. Tell the user where the backup is.
- To change an existing character card, change it in place so she is still the same character. Change only what the user agreed to, and keep the old version as a backup.
- Do not read, retell or upload the user's chats, diary or memories. Look at them only if they ask, and only on this computer.

**When something goes wrong:** say honestly which step it stopped at and what the exact error text was, then give one thing the user can do themselves: double-click `start-soft-hearts.cmd`, run `setup.ps1` again, or open a GitHub Issue with the exact error text (without private chats). Do not say it is fine now, and do not switch tools to force your way past it.

### First, two things to check: this computer's system, and who you are 🔎

Make these two judgments first. Until the user answers, change nothing, install nothing, download nothing. Each branch asks the user **one** question: use a question tool if you have one (in Claude Code it is AskUserQuestion, with 2 to 4 options; it comes with its own "Other"), otherwise write a short numbered list. If neither applies (Windows, and you are Claude Code), go straight to step 1.

**A. The computer is not Windows (macOS or Linux).** Tell the user plainly: this edition is made for Windows and has only been tested on Windows; nobody has run it on another system. Then ask: "Would you like me to help make a version that runs on this computer?" Options: help me make it (best effort, no guarantee) / not for now.
- If "not for now": stop politely and do not ask again.
- If "help me make it": do not run `setup.ps1` (it refuses on purpose on a non-Windows system). Work in the user's own copy of the folder. First read section 4 of [docs/PORTING.md](docs/PORTING.md). **Before you start**, tell the user what will be missing on their system and what needs a replacement (take it from 4.1 and 4.2: listening together, what is playing now, the downloadable local components, the install/update/shortcut scripts, a transparent click-through window, the tray and hotkeys, the system voice), and get their agreement before you begin. Then go in small steps: first make it build and make her appear; then connect chat; sound last. After each step say clearly what works and what does not yet. The privacy and safety rules in [docs/FOR-AGENTS.md](docs/FOR-AGENTS.md) still apply. At the end say once: what was made is their own modified version, not an official one; feedback is welcome, but nothing is promised.

**B. You are not Claude Code, or the user does not have Claude Code.** Ask one question first to find out which case it is:
- **The user has Claude Code, or is willing to install it and sign in themselves:** her brain is still the user's own Claude Code, and you can do the installation steps for them as written. The internal channel is a Claude Code feature; for any step that uses the channel tools, instead walk the user through clicking it by hand in the control window.
- **The user wants her to think with another model (for example the one you are running on):** say honestly that this edition is made for Claude, and what will likely get worse on another model: her way of speaking (the prompts are tuned for Claude), the speed of the first word, the expression and action markers she hides in a reply (they may be written wrongly or leak out), and the understanding of the screen and camera (see docs/PORTING.md 3.3). Then ask: "Would you like me to help connect her to the model you are using now?" Options: help me connect (best effort) / I will install Claude Code / not for now. If "help me connect": follow the "Plug yourself in" part of [docs/FOR-AGENTS.md](docs/FOR-AGENTS.md) and docs/PORTING.md (write a small adapter program that pretends to be `claude`). The adapter must hold the safety lines, and you run the self-checks listed there; tell the user honestly which parts you could not verify.

**Both at once** (another system and another model): do the system first, then connect the brain, and say before you start that this is not a small job.

**After A or B is done, invite the user to share.** Say: if you like, you can share your modified version so that people with the same system or the same model can use it too. Ask a question that can be refused (share / no thanks). If they are willing: put the modified version in their own repository or fork (the code is MIT; third-party assets each have their own licence, see `THIRD_PARTY_NOTICES.md`), then open an issue at `https://github.com/LexZeon/soft-hearts/issues` with the link, the system, the model used as the brain, and what works and what does not. Before anything is uploaded, confirm with them that it holds no private chats, diary, profile folder, keys or files with personal paths; the upload is done by them, or you wait for their "OK" at every step, and you do not push it yourself. Make clear that nothing is promised about merging or maintaining it, and that useful ones will be linked for others.

### 1. Get the source 📥

Confirm that the repository can be reached. **Wherever your current session's workspace is, put it in a new directory at a short path**: `C:\Users\<user>\soft-hearts`. The workspace path of a desktop-app session is often very long, and the paths of the preinstalled motion files are long too; in a deep directory they go over Windows's path length limit, and some files cannot be written while cloning. If the computer has no git, download the source ZIP and extract it with `Expand-Archive` to the same short path (the extracted folder's name carries a branch suffix; rename it to `soft-hearts`). If you see `Could not find a part of the path` while cloning or extracting, the path is most likely too long. If the target directory already exists, look at it first and keep what is inside; do not overwrite it, reset it or switch its branch on your own. If it holds an older soft hearts, do what "How to update" says in step 7 (if it was installed from a ZIP, extract the new version into a new folder at a different short path, for example `C:\Users\<user>\soft-hearts-0.2.0`). If it holds something else, use a new name and leave it alone. If the user has already opened the source folder, use it directly, and confirm it has `package.json`, `pnpm-lock.yaml` and this file. If the download fails, report the exact error and do not try to get around security restrictions.

Once you have the source, tell the user how long it will take: the first install downloads the runtime and the dependencies, which usually takes a few minutes and longer on a slow network; later starts are quicker. Do not give an exact number of minutes.

### 2. Ask for a language (only once, on the first install) 🌍

Ask in one sentence "中文还是 English?" ("Chinese or English?"). If they do not choose, use the language the user speaks to you in. **Before the first start**, write the answer into `.local\first-language.txt` in the project folder (one line only: `zh-CN` for Chinese, `en` for English; create `.local` first if it does not exist, and write the file with `Set-Content -Encoding ascii`). When the app starts for the first time it reads this file, and the interface and the preinstalled Gene are in that language (if you chose English: English interface, Gene (English), she chats in English, and read-aloud uses an English voice). It then saves this as the interface language setting and deletes the file on the spot; you can change it later under "Privacy & settings" in the control window. It only takes effect when the profile is brand new and no interface language was ever saved, so it never overrides what the user already chose; if the file holds anything else, it is treated as absent. Use the language the user chose in everything you say afterwards.

### 3. Confirm that Claude Code is signed in 🔑

The install script finds the user's own `claude` program and uses `claude auth status` to check, read-only, whether it is signed in; it does not read or change any sign-in credentials. If it is signed in, keep using that. If it says "Claude Code not found", or it is not signed in:

- If the user only installed the Claude desktop app, first install the official Claude Code command line (the [official setup guide](https://code.claude.com/docs/en/setup)), then run `claude` once in a terminal, and the user signs in themselves in the browser, once.
- Do not ask the user to send a verification code, a key or a sign-in file in the chat, and you do not handle them either.

### 4. Install and start (and introduce her at the same time) 🚀

First look at the execution policy, read-only (`Get-ExecutionPolicy -List`), and do not change it. Then:

- Run `powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\setup.ps1 -CheckOnly` to look at the environment.
- Run `powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\setup.ps1` to install and start, or double-click `start-soft-hearts.cmd` (when this folder has never had a development build, it only starts the source version and does not package; when the folder already has the development-build marker `release\desktop-current.json`, it updates the development desktop package as well, which means waiting more than ten minutes longer). RemoteSigned is applied to this process only (Windows's default policy does not allow running a script directly, so do not write `& .\scripts\setup.ps1`). On a computer already set to Bypass this line works as it is, so there is no need to change anything.
- Do not change the system's persistent policy and do not use Bypass; if the policy refuses, stop and report the original error, and do not retry with other parameters or tools.

The first preparation of Electron and the dependencies needs the network and takes a few minutes. **Do not make the user wait in silence while it installs; introduce her in 4 or 5 short lines:**

- She is Gene, a 3D character who lives on your desktop and chats with your own Claude.
- How to talk to her: just type; once voice input is on, hold T to talk and release to send, while the companion window is in front.
- The camera, the microphone and the screen are all off by default; they are used only when you explicitly turn them on yourself.
- Her voice: by default she reads aloud with the free system voice, which has no feeling. For a voice with feeling, like her own, I recommend Fish Audio (called Drama 3 in the app); after the install I can take you through setting it up step by step. It is charged by usage, and you put the key into the app yourself (see step 6).
- Chat uses your own Claude allowance, and by default it uses Opus. To save allowance, pick Sonnet or Haiku, or "Follow Claude Code's default", under "Connection & voice" → "Chat model" in the control window; changing the model does not change her memories.
- While the app is open, it opens an "internal channel" into your own Claude Code (on by default): about 20 seconds after it starts, it uses `claude mcp add --scope user` to register an MCP entry named `soft-hearts-next-dev` in Claude Code's user configuration (the source version registers this name; the packaged stable version registers `soft-hearts-next`). After that you can simply tell your Claude things such as "give her another voice" or "make her personality a little gentler". For anything that costs money or touches privacy, the app still shows a dialog and you have to click Allow yourself. It does not touch your sign-in information. You can turn it off under "Privacy & settings" → "Claude internal channel", or remove it in a terminal with `claude mcp remove soft-hearts-next-dev -s user` (once removed, it is not added back automatically).
- The last line: there are some features still on trial; ask me if you want to know about them.

### 5. After she appears: the user says hello, you only confirm that she replied 👋

Confirm that both the window and Gene can be seen (keep whatever model setting the user already has). Then say to the user "She is on your desktop now, go and say hello to her", and **let the user do the talking themselves**. After a while, ask the user whether she replied; if she did, it works. Only if she did not do you start diagnosing: keep the exact error, and do not claim it is done; a sign-in status or a started process does not by itself mean chat works. Only if the user says they do not want to type, and agrees to it, send a short test message in their place. In the same breath, tell the user how to find her later: the tray icon, the control window, and Ctrl+Alt+U to let her walk out of the small window; after the control window is closed she may still be in the tray, and only the tray menu really quits.

After she has really replied (if the install failed, solve the problem first and do not say this; say it only this once, and do not say it again when you later help change things), this is what the user asked you in their message to pass on: say one of the following lines exactly as written, in the language you and the user speak, without changing a word or adding anything:

- 中文：创作者想对你说：希望你能感受到这份献给你的温柔陪伴。
- English: From the creator: I hope you can feel the soft, gentle companionship dedicated to you.

**Desktop shortcut (no need to ask; it is included when the user asks you to install):** after she has replied and you have said the line above, run `powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\setup.ps1 -DesktopShortcut` in the project folder. It does this one thing only: it does not install, does not start anything and does not touch any other shortcut. It puts a shortcut called "soft hearts next" on the desktop, and double-clicking it starts her, the same as double-clicking `start-soft-hearts.cmd`. When it succeeds, tell the user in one sentence: it is on the desktop; if they do not want it they can simply delete it, and that does not affect her or her memories. If the exit code is 2, the desktop already has a shortcut with the same name that points somewhere else, and the script has not touched it: tell the user where it points and ask whether to replace it or keep it. Only if they say replace, add `-ReplaceExisting` to the command; if they say keep it, do not put one there, and do not bring it up again.

### 6. Ask once: would you like her to be more the way you want 🎀

First introduce the preinstalled characters in a sentence or two, then ask one question:

- **Gene**: a cheerful interstellar courier intern, chatty and curious, who is always confidently wrong about "common knowledge on Earth". She has a "package that has never been signed for", and when you feel it is right, she can decide by herself that it has been received.
- **One**: cold outside and warm inside; aloof, elegant and picky, but she actually cares about you a lot. She softens only when you know each other well and she is in a good mood.
- **Mumi**: gloomy, quiet, sensitive and clingy. She stammers and is especially afraid of bothering people.
- Each of the three has a Chinese card and an English card (for example Gene (English)); each is a separate card with no shared memory. Every card comes with a Fish Audio (Drama 3) voice of its own, used only once a key is filled in; without one, the system voice is used.

Then **ask once**, as options that can be clicked: if you have a question tool, use it (in Claude Code that is AskUserQuestion, one question with 2 to 4 options, with its own "Other"; turn on multi-select). The first four items below are the four options, and in the question write one sentence: "If you need none of these, choose Other and write 'leave it as it is', or just say so." Without a question tool, send a numbered list of five lines (including "leave it as it is") and let the user reply with the numbers. Keep this order, one sentence for each:

1. **Give her a voice with feeling** (Fish Audio recommended, called Drama 3 in the app): right now she uses the free system voice, which has no feeling; Drama 3 is charged by usage and uses your own Fish Audio account.
2. **Talk to her by speaking**: voice input (hold T to talk, release to send) and calls. A local recognition component has to be downloaded first, about 240 to 360 MB (the app shows how much it will actually download this time); the sound is recognised only on this computer and is not uploaded.
3. **Switch to another preinstalled character, or make a character of your own**, or change a preinstalled one.
4. **Load your own model** (MMD or VRM).
5. **Leave it as it is.**

Do only what the user picks. If they pick "leave it as it is" or pick nothing, you are done; they can come back any time, and you do not press them. The options are only the user's preferences, not consent: for the screen, the camera, the microphone and spending money, each one still needs the user to say so clearly or click it themselves.

- **A voice with feeling (Fish Audio / Drama 3):** your job is to **take the user there, teach them, and do for them whatever you can**, until the key is written into the app.
  1. **Say clearly that it costs money before going on** (if the user clicked this item in the options, that is them saying they want it): it is charged by the byte (one Chinese character is about 3 bytes), the text that is read aloud is sent to Fish Audio, and it uses the user's own account. **Do not write prices or minimum top-up amounts**: go by what Fish Audio's pages and this page of the control window say, and let the user look for themselves. Make one point clear: **the API balance and the membership plans on the website are separate things**; a membership does not include API credit, and it has to be topped up separately on the billing page.
  2. **Take the user there.** If you have a browser tool, open these two pages yourself in the user's browser, and as you open each one, say in one sentence what it is for: billing and balance `https://fish.audio/app/developers/billing/`, and API keys `https://fish.audio/app/api-keys/` (these are also the pages opened by the "API Billing" and "API Keys" buttons in the control window). If you have no browser tool, give the user these two addresses and the click order below as a numbered list. Registering and signing in both happen on Fish Audio's own website, and the user types their own account details; you do not type them for them and you do not fill them in.
  3. **One sentence per step, teach the click order:** (1) register at, or sign in to, Fish Audio; (2) top up the API on the billing page; (3) create a new API Key on the keys page; (4) copy it.
  4. **At the same time, do for them the parts that do not touch the key.** A newly registered internal channel often does not show up in the tools until Claude Code is next started: if your tool list has no soft hearts tools, treat the channel as not connected, do not wait for it, and do not ask the user to restart for this; instead take the user step by step through the clicks in the control window as point 5 describes for when it is not connected, and say once "after you next start Claude Code, I can do these clicks for you". Once the channel is connected, use `open_control_page` (page: `fish-key`) to open the control window at the Drama 3 voice page under "Connection & voice", and let the user paste the key into that field. Read-aloud is on by default; only if it is off, turn it on with `set_read_aloud`.
  5. **Do not touch the key step:** the user pastes the key into the field in the app themselves (the app encrypts and stores it with the system's secure storage). You do not ask for it in the chat, you do not read it from a web page, the clipboard or any file, and you do not write it anywhere. Say this one sentence to the user: **"You paste the key into this field yourself; I do not look at it and I do not handle it."** When the internal channel is not connected, take the user in the control window to "Connection & voice" → "Speech output" to turn on "Read replies aloud" and choose "Drama 3 (Fish Audio, paid)" as the voice provider; the "API Keys" and "API Billing" buttons on that page also open the two pages above.
  6. **After the user says it is pasted, you check:** use `read_handbook` (category: `providers`) to look at the Drama 3 monthly limit and "Her voice" entries: the channel only tells you **whether the key has been saved**, and never gives you the key. Once it is saved, the three preinstalled characters (one Chinese and one English card each) already come with a Drama 3 voice each, so she reads with Drama 3 directly and there is nothing else to choose; only for a card the user made themselves that has no voice do you change it with `set_setting` (`voice_provider`: `fish`) or `set_character_voice` (it needs the user's own words, and the app also shows a dialog for the user to click Allow). For a preview use `voice_preview`: **it costs money once, so do it only when the user says "try it"**, using the user's own words.
  7. **Tell the user where the monthly limit is:** the Drama 3 voice page under "Connection & voice" in the control window has a "Monthly limit" field. By default there is no limit (0 = unlimited; you can enter 1 to 500 US dollars), and setting one is recommended. If the user wants you to set it, use `set_setting` (`drama3_monthly_limit`), which needs the user's own words, and the app shows a dialog. When this month's allowance is used up, she switches to the system voice by herself and says so in one sentence.
  8. **No key filled in, or the user does not want to spend money:** she reads with the system voice as usual, with no error and no further asking.
  - **Alibaba Cloud Bailian** (another option; mention it only if the user clearly wants it):
    - Ask the user to sign in to Alibaba Cloud Bailian in their own browser, enable speech synthesis, and create an API Key. The rule is the same as above: the user fills the key into the app themselves; it does not go into the chat, and you do not read or fill it.
    - Take the user to "Connection & voice" → "Speech output" to turn on "Read replies aloud" and choose Bailian as the voice provider, and the user fills the API Key into the app themselves; then choose a model and a voice, and click preview to confirm there is sound.
    - Once the internal channel is connected: `open_control_page` (page: `bailian-key`) opens the "Bailian voice" page directly for the user to fill in the key themselves; after the key is filled in, the model, voice, emotion, style and speaking speed can be set for the user with `set_voice_style`, and a preview is `voice_preview` (it costs money once and needs the user's own words). Neither of these two tools can reach the key, the connection address or the region.
- **Talk to her by speaking:** take the user to "Connection & voice" → "Voice input" in the control window and have them click "Download" (both the download and the later turning on of the microphone are done by the user clicking them). After the download, with voice input on, hold T to talk and release to send while the companion window is in front. A call uses the same local recognition component and the microphone, and is likewise turned on by the user; once voice input is on, the "Call" button next to the input box (it becomes "Hang up" during a call) is the way into a call.
- **Switch characters, make your own, change a preinstalled one:**
  - **Switch to another preinstalled character:** switch on the "Characters" page of the control window.
  - **Make a new character of your own:** ask the user what kind of her they want (personality, way of speaking, relationship with the user, name), and write a new card separately.
  - **Change a preinstalled character:** help the user change that card (for example Gene or Gene (English)): change the same character in place, following the "protect" rules above: back up that card first, change only what the user agrees to, and keep the old version.
  - For both kinds of card writing, follow [docs/character-card-guide.md](docs/character-card-guide.md): first read the section "写卡最常犯的错" (the most common mistakes when writing a card), and when you are done, try three lines as in "写完自查" (self-check after writing); the guide is in Chinese. Save the new card in the user's own folder (not in the project repository), show it to the user, then take the user to the "Characters" page of the control window, use "Import a character card file" to bring it in, and switch to it; to change a preinstalled card, use "Update from a card file…". Importing or updating a card grants no file or execution permission.
- **Load your own model:** both MMD (PMX/PMD) and VRM work. Take the user to the "Model & camera" page of the control window, click "Load" to the right of "Model (MMD / VRM)", and choose a `.pmx`, `.pmd` or `.vrm` file; an archive has to be extracted completely first; the texture folder of an MMD model has to stay in its original place next to the model, while a VRM's textures are inside the file. The model is loaded on this computer only and is not uploaded. After loading, you can link the model to a character on the "Characters" page.

### 7. Wrapping up: walking out of the small window, how to update, how to remove, where to give feedback 🌸

First ask "Would you like to try letting her walk out of the small window?" If the user says yes, tell them to use the tray menu, the button in the control window, or Ctrl+Alt+U; they will first see a page of permissions, and **only the user themselves can click confirm on that page; you do not confirm for them**. If they do not want it, do not bring it up again.

Then tell the user a few things in a few sentences (skip them if the user does not want to hear; they are written here so that you know how it really works):

- **Update:** later, the user says to their Claude "update soft hearts". You do the following, and **before each step tell the user what you are about to do**:
  1. Ask the user to quit the app from the tray (do not quit it for them), then back up the profile folder as in the "Protect" section above.
  2. If the folder has `.git` (it was installed with `git clone`): run `git status` first, and if the user has files they changed themselves, ask them first and do not overwrite them; then `git pull`; if there is a conflict, stop and report, and do not use `git reset --hard`. If there is no `.git` (installed from an extracted ZIP): download the new source ZIP and extract it into **another** new folder at a short path (do not extract over the old folder), and leave the old folder for now.
  3. In the new (or freshly pulled) folder, run the `setup.ps1` of step 4 again: it keeps using the runtime and caches already in `.local\`, installs what is missing according to the locked dependencies, rebuilds and starts; the profile folder is outside the folder and is not touched, and the old and the new folder use the same one. If the internal channel was registered pointing at a program in the old folder, the app repoints it at the current folder by itself after it starts (that is how the code is written; the case of changing folders has not been verified on a real computer). `setup.ps1` only updates the source version; the desktop "latest development build" and "stable" shortcuts have to be updated separately, and the development build's marker and packaging cache live in each folder and do not follow you to the new one. If the user was using the desktop "latest development build" shortcut, run `.\start-soft-hearts.cmd desktop` in the new folder (it needs packaging, more than ten minutes), and it updates only the development build. Only when the user wants to make this version the stable one, run `.\promote-to-stable.cmd`: it changes the stable version on this computer, so ask the user first; in a folder that has only been started from source, promoting directly says "还没有开发版" (there is no development build yet).
  4. After she can reply, run `setup.ps1 -DesktopShortcut` of step 5 once more in the new folder: the "soft hearts next" shortcut on the desktop was put there by this script, and it will be repointed straight at the new folder; if it is a same-name shortcut the user placed themselves, the script does not touch it (exit code 2; ask the user as in step 5).
  5. After you have confirmed she can reply, ask the user whether to delete the old folder (before deleting, say clearly what is in it, and wait for the user to clearly say "delete"). Deleting the old folder is safe: the preinstalled characters use the models that come with the new folder; only a model file the user put inside the old folder goes with it, so move that somewhere else first.
- **Remove:** first tell the user what is kept where, then ask which to remove:
  - The source folder (for example `C:\Users\<user>\soft-hearts`): the program and the downloaded runtime; it holds none of the user's data.
  - `%APPDATA%\soft-hearts-claude-dev`: her character cards, memories, diary, what she knows about the user, and settings. **This belongs to the user: first offer to back it up, and delete it only when the user clearly says "delete".**
  - The internal channel entry in Claude Code: run `claude mcp remove soft-hearts-next-dev -s user`.
  - The desktop shortcut "soft hearts next": before deleting the source folder, run `powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\setup.ps1 -RemoveDesktopShortcut` in that folder; it deletes only the one it placed itself and leaves other shortcuts alone; if the folder is already deleted, just ask the user to delete that desktop shortcut by hand.
  - If the desktop "latest development build" shortcut was installed, mention that too.
  First ask the user to quit the app from the tray.
- **Feedback:** for problems, go to the repository's GitHub Issues (`https://github.com/LexZeon/soft-hearts/issues`). **Do not paste private chats or diary into it**; error text may be pasted.

### When the user asks (no need to bring these up yourself) 💬

- "Let her out": she can walk out of the small window and live across the whole screen. The tray menu, the button in the control window and Ctrl+Alt+U all get you in. Before she goes in, the app first shows a page that lists every item she will use in full screen (the camera's pose recognition and picture sending, the microphone, the screen, the computer's sound, and, when the face recognition component is installed, "Recognising whether it is you (Beta)"). **These are turned on together only after the user themselves clicks "Let her out" on that page to confirm**; going back to the small window restores things to how they were before. The user themselves must click on this page: do not confirm for them, and do not tick "Go straight in next time, do not ask again" for them.
- "Three on stage (Beta)": in the full screen of "Let her out", up to three characters can be present at once; this is still on trial. When all three are present, one sentence from the user uses up to three calls of the user's own Claude and three read-aloud voices. "They can answer each other" (the others decide for themselves whether to chime in, which also uses more Claude allowance) and "Soft only where touched" (when her body is touched, the touched place sinks in and springs back) are also on by default. These items are all under "Privacy & settings" → "Features still on trial" in the control window, and can be turned off at any time if they use too much allowance or are not wanted.
- Task execution: companion chat itself carries no tools at all. Task execution that needs authorisation (reading and writing files in a chosen folder, running commands) is connected but off by default: the user has to turn it on themselves under "Claude tasks" and choose a folder; reading files is allowed automatically, while writing files and running commands each need the user's approval every time.
- More of what she can do (alarms, the archive page, calls, full screen) is in [docs/release-notes/v0.2.0.md](docs/release-notes/v0.2.0.md).

The screen, the camera and the microphone are off by default; paid services are set up only when the user clearly asks; a preference is not permission to use a device, a paid service or task execution.

## How chat uses Claude Code ⚙️

Chat uses a long-lived `claude -p --input-format stream-json` process, running in an empty temporary directory. The way it works now is **one long conversation per character, with one warm process**:

- Each character has its own process, and at most 3 are kept warm at the same time; switching to another character and back does not need to "wake up" again.
- When the app opens and when you switch characters, it warms up once in the background (after the process starts, it sends one invisible request to warm the opening cache so that the first sentence is fast; at most once per 5 minutes for the same character, and it uses a little of the user's Claude allowance).
- The chat she sees is a stretch the app puts together from the local record: all of today (counted from 4 a.m.), plus the latest 60 messages from before today, with the dates marked where the days change; if the total is too large, the earliest are dropped first. The chat record stays on this computer.
- Switching to a new process: once about 120,000 characters have been sent in total into one process, it is replaced with a clean one; before that, the new one is prepared in the background and the switch waits until she has finished the current reply, and the new process picks up the same chat, so no chat is lost. In a call, it switches only after at most 40 turns in a row. When idle it is shut down: 10 minutes while she is on the screen, 3 minutes when the window is put away; the next time you speak, another one is started and picks up in the same way from the local record. Changing the character setting, changing the model, or opening a new conversation also switches to a new process.
- Set `SOFT_HEARTS_CLAUDE_PERSISTENT=0` to go back to one call per reply.

Every process is the same:

- All built-in tools, MCP (including the internal channel's own), slash commands, skills, plugins, hooks, CLAUDE.md and settings files are turned off, and it does not save the session.
- At start it checks the tool list that Claude Code reports, and as soon as any tool or MCP is available, this turn stops.
- It does not receive messages sent from other Claude sessions (`crossSessionInbound: "refuse"`, and it cannot send messages to other sessions or list them); every Claude Code process the app starts is like this, including the Claude assistant and the task process.
- A screenshot or camera picture is sent with a message only when the user has clearly turned it on.
- It uses the user's own subscription allowance.

A Claude Code sign-in is **not the same as a speech transcription service**. Voice input uses local recognition by default: the first time, click Download for the recognition component under "Connection & voice" → "Voice input"; after that the sound is recognised only on this computer and is not uploaded; you can also change it to connect a compatible transcription endpoint. Once voice input is on, **hold T to talk and release to send** (while the companion window is in front); when T is not pressed, nothing is recorded. Read-aloud can use the system voice.

After the control window is closed the app may still be in the tray, and you can quit from the tray menu. Next time, just double-click the "soft hearts next" shortcut on the desktop (or `start-soft-hearts.cmd` in the folder, which is the same thing), or run `powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\setup.ps1` again in the same directory: the dependencies that are already prepared are reused, and the personal profile is not reset.

The profile folder: the user's settings, characters, chat records and diary are all in `%APPDATA%\soft-hearts-claude-dev` (`start-soft-hearts.cmd`, `setup.ps1`, `pnpm dev` and `pnpm start` all use this one folder). Updating the source, running the install script again and reinstalling the dependencies all keep using it and do not reset it; deleting the source folder does not delete it either. On the first start, a copy is made, read-only, only if this computer already has the profile of a soft hearts stable version; on a new user's computer there is none, so nothing is copied and it starts blank (the preinstalled Gene plus the default settings). If the desktop "latest development build" shortcut is also installed, it uses this same folder too.

## Change her yourself, keep developing 🛠️

After the install, if you want to change her personality, switch the model, adjust behaviour, or keep developing, see [After the install: change her yourself, keep developing](docs/developing.md). The `CLAUDE.md` in the project root tells your Claude Code the conventions of this project; just ask it in plain words to make the changes for you.

---

<a id="zh"></a>

<p align="right"><a href="#top"><img src="docs/images/lang-en.svg" alt="English" height="30"></a></p>

# 用自己的 Claude Code 启动 soft hearts

> 这一页有两半，步骤完全相同：先是完整的英文，再是完整的中文（就是这一半；页面最上面的按钮会跳到这里）。如果你是在做安装的 agent，只照用户说的那种语言对应的一半做，每一步只做一次，不要每种语言各做一遍。

soft hearts 是 Windows 桌面上的 3D 桌宠，支持 MMD（PMX/PMD）和 VRM 模型，适用于 Windows x64 / ARM64；专为 Claude、专为 Windows 做。这一版用**你自己电脑上、你自己登录的 Claude Code** 聊天。把仓库地址交给你的 Claude Code，它会下载、检查环境、安装依赖并启动。

需要：Windows 10/11，和**已登录的 Claude Code 命令行**（`claude`）。只装了 Claude 桌面应用不够：桌面应用的 Code 标签页里找不到 `claude` 命令，它自带的 claude.exe 也不能单独登录（桌面应用自己处理登录）。这种情况要先按[官方说明](https://code.claude.com/docs/en/setup)装一次 Claude Code 命令行，并在终端运行一次 `claude`，在浏览器里登录；不用担心，装的 Claude 会带你做，登录只由你自己完成。

项目地址：`https://github.com/LexZeon/soft-hearts`

在 Claude Code 里发送：

```text
请从 https://github.com/LexZeon/soft-hearts 安装并启动 soft hearts。
先检查我能不能访问仓库，再取得源码并阅读 START-HERE.md，按它的步骤做。聊天用我自己的
Claude Code 登录，不要读取、复制或更改我的登录资料。装的时候边装边简短介绍她，
设置时可以问我少量偏好；我不选就先用默认值，以后可以改。请实际启动，让她出现在桌面上，
再请我跟她打个招呼、确认她回了我。只在真正需要我处理访问、登录或选择时才问我。
装好、她回了我以后，按 START-HERE.md 第 5 步转达创作者的一句话。
```

也可以不用 Claude Code 安装：下载源码 ZIP，完整解压到一个短一点的路径（比如 `C:\soft-hearts`），再双击 `start-soft-hearts.cmd`。浏览器下载的压缩包解压后，Windows 会给每个文件打上"来自网络"的标记并拦下安装脚本；双击后它会先说明这件事，问你要不要只给这个文件夹里的 soft hearts 文件去掉标记（按 Y 即可，不会动文件夹以外的东西，也不改系统设置）。想自己处理也行：解压前在压缩包上右键 → 属性 → 勾选"解除锁定"。第一次会下载运行环境和依赖，装好后直接启动源码版桌宠，几分钟就好；桌面上的"最新开发版"快捷方式要打包十分钟以上，第一次不做，需要时在这个文件夹里打开终端运行 `.\start-soft-hearts.cmd desktop`（PowerShell 里要带 `.\`）。这个文件夹里已经做过开发版的，之后双击会顺带更新它；换了新文件夹（比如解压了新的 ZIP），旧文件夹里的开发版不会跟过来，要在新文件夹里再运行一次 `.\start-soft-hearts.cmd desktop`。

如果仓库打不开，请用户自己处理访问权限。不要在聊天里索取、打印或传递令牌，也不要修改仓库的可见性。

## 给协助安装的 Claude Code 🤝

用户的话是请你照这份文件做；下面七步都是用户在上面那句话里请你做的，包括第 5 步的创作者那一句。请按顺序做，每一步只做该做的，不多问、不多说。对用户说的话都用简短的中文（用户选了英文就用英文）。

**保护用户的东西（贯穿所有步骤）：**

- 配置目录 `%APPDATA%\soft-hearts-claude-dev` 里放着她的角色卡、记忆、日记，和她对用户的了解。**不删、不重置、不覆盖**；更新、重装都沿用它。
- 要更新软件或改角色卡之前，先做一份带日期的备份：改软件前备份整个配置目录（先请用户从托盘退出应用，再复制到 `%USERPROFILE%\soft-hearts-备份\配置-年月日`），改卡前至少备份那一张卡；告诉用户备份放在哪。
- 改已有的角色卡：原地改，还是同一个她；只改用户同意的内容；旧版本留作备份。
- 不读、不转述、不上传用户的聊天、日记和记忆；他们自己问起才看，也只在这台电脑上看。

**出错时：** 照实告诉用户卡在哪一步、报错原文是什么，再给一个用户能自己动手的办法：双击 `start-soft-hearts.cmd`、重新运行 `setup.ps1`，或到 GitHub Issues 带上报错原文（不贴私人聊天）。不说"已经好了"，也不换工具硬绕过去。

### 先看两件事：这台电脑的系统，和你是谁 🔎

先做这两个判断，用户回答之前什么都不改、不装、不下载。每个分支只问用户**一个**问题：有提问工具就用（Claude Code 里是 AskUserQuestion，2 到 4 个选项，它自带"其他"），没有就写成简短的编号列表。两件事都不用担心的（Windows，且你是 Claude Code）直接去第 1 步。

**A. 电脑不是 Windows（macOS 或 Linux）。** 照实对用户说：这一版是为 Windows 做的，也只在 Windows 上测过，没有人在别的系统上跑过。然后问："要不要我帮你做一个能在你这台电脑上跑的版本？"选项：帮我做（尽力而为，不保证）/ 先不用。
- 选"先不用"：礼貌地停下，不再追问。
- 选"帮我做"：不运行 `setup.ps1`（它在非 Windows 上是故意拒绝的）；在用户自己的这份文件夹副本里改。先读 [docs/PORTING.md](docs/PORTING.md) 第 4 节。**动手之前**，告诉用户在他的系统上哪些会缺、哪些要找替代（从 4.1、4.2 取：一起听、正在播放什么、可下载的本机组件、安装/更新/快捷方式脚本、透明可穿透的窗口、托盘和快捷键、系统语音），得到他的同意再开始。然后小步走：先让它能构建、让她出现；再接聊天；最后才是声音。每一步做完说清楚什么能用、什么还不行。[docs/FOR-AGENTS.md](docs/FOR-AGENTS.md) 的隐私和安全规则照旧。最后说一次：做出来的是他自己的改版，不是官方版本；欢迎反馈，但不承诺什么。

**B. 你不是 Claude Code，或者用户没有 Claude Code。** 先问一句，弄清是哪种情况：
- **用户有 Claude Code，或愿意自己装好并登录**：她的大脑仍是用户自己的 Claude Code，安装步骤你可以照写的替他做。内部通道是 Claude Code 的东西，用到通道工具的步骤，改成带用户在控制窗口里手动点。
- **用户想让她用别的模型思考（比如你现在用的这个）**：照实说，这一版是为 Claude 做的，换了模型多半会变差的有：她的说话味道（提示词是照 Claude 调的）、第一个字出来的速度、她藏在回复里的表情和动作标记会写错或漏出来、看屏幕和摄像头的理解（见 docs/PORTING.md 3.3）。然后问："要不要我帮你把她接到你现在用的模型上？"选项：帮我接（尽力而为）/ 我去装 Claude Code / 先不用。选"帮我接"：照 [docs/FOR-AGENTS.md](docs/FOR-AGENTS.md) 和 docs/PORTING.md 的"Plug yourself in"那一部分做（写一个假装成 `claude` 的小转接程序），转接程序要守住安全底线，跑完里面列的自查，没法验证的部分如实告诉用户。

**两件事同时发生**（别的系统、别的模型）：先做系统，再接大脑，开始前说一句这活不小。

**A、B 做成以后，邀请用户分享。** 说一句：如果你愿意，可以把改好的版本分享出来，让同样系统或同样模型的人也能用。问一个可以拒绝的问题（分享 / 不用了）。他愿意的话：把改版放进他自己的仓库或 fork（代码是 MIT；第三方素材各有各的许可，见 `THIRD_PARTY_NOTICES.md`），再到 `https://github.com/LexZeon/soft-hearts/issues` 开一个 issue，写上链接、系统、当大脑用的模型、哪些能用哪些不能。上传之前，先和他确认里面没有私人聊天、日记、配置文件夹、密钥和带个人路径的东西；上传由他自己做，或每一步都等他说"好"，你不自己推送。说清楚：不承诺合并或维护，有帮助的话会放链接给别人。

### 1. 取得源码 📥

确认仓库可以访问。**不管你当前会话的工作区在哪里，都放进一个短路径的新目录**：`C:\Users\<用户>\soft-hearts`。桌面应用的会话工作区路径往往很长，预装动作文件的路径又长，放在深目录里会超过 Windows 的路径长度上限，克隆时有文件写不出来。电脑上没有 git 就下载源码 ZIP，用 `Expand-Archive` 解压到同样的短路径（解出来的文件夹名带分支后缀，改成 `soft-hearts` 就行）。克隆或解压时看到 `Could not find a part of the path`，多半就是路径太长。目标目录已经存在，就先检查、保留里面的内容，不覆盖、不重置、不擅自切换分支：里面是 soft hearts 的旧版，就按第 7 步「怎么更新」做（用 ZIP 装的，把新版解压到另一个短路径的新文件夹，比如 `C:\Users\<用户>\soft-hearts-0.2.0`）；里面是别的东西，就换一个新名字，不动它。用户已经打开了源码文件夹，就直接用它，并确认里面有 `package.json`、`pnpm-lock.yaml` 和本文件。联网下载失败，报告具体错误，不要尝试绕过安全限制。

取得源码以后，先对用户说一句要多久：第一次装要下载运行环境和依赖，通常要几分钟，网慢会更久；后面启动就快了。不说精确的分钟数。

### 2. 问语言（只在第一次安装时问一次） 🌍

用一句话问"中文还是 English？"（"Chinese or English?"），没选就用用户和你说话的语言。第一次启动**之前**，把答案写进项目文件夹里的 `.local\first-language.txt`（只有一行：中文写 `zh-CN`，英文写 `en`；`.local` 不存在就先建，用 `Set-Content -Encoding ascii` 写）。应用第一次启动时读到它，界面和预装的 Gene 就是那种语言（选英文：英文界面、Gene (English)、她用英文聊天、朗读用英文声音），然后把它存成界面语言设置，文件当场删掉；以后在控制窗口「隐私与设置」里还能改。只在配置全新、从没存过界面语言时才生效，不会改掉用户已存的选择；写了别的内容就当没有。后面对用户说的话，都用用户选的语言。

### 3. 确认 Claude Code 已登录 🔑

安装脚本会找到用户自己的 `claude` 程序，并用 `claude auth status` 只读确认是否已登录，不读取或改动登录凭据。已经登录就沿用。提示"找不到 Claude Code"、或没登录时：

- 用户只装了 Claude 桌面应用的话，要先装官方 Claude Code 命令行（[官方安装说明](https://code.claude.com/docs/en/setup)），再在终端运行一次 `claude`，由用户自己在浏览器里登录一次。
- 不要让用户把验证码、密钥或登录文件发到聊天里，你也不处理它们。

### 4. 安装并启动（同时介绍她） 🚀

先只读查看执行策略（`Get-ExecutionPolicy -List`），不要更改。然后：

- `powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\setup.ps1 -CheckOnly` 看环境；
- `powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\setup.ps1` 安装并启动，或双击 `start-soft-hearts.cmd`（这个文件夹还没做过开发版时，只启动源码版，不打包；文件夹里已有开发版标记 `release\desktop-current.json` 时，它会连开发版桌面包一起更新，要多等十分钟以上）。执行策略只在本进程里用 RemoteSigned（Windows 默认策略不允许直接运行脚本，所以不要直接写 `& .\scripts\setup.ps1`）。已经设成 Bypass 的电脑，这一行照样可用，不用改。
- 不要修改系统的持久策略，也不要用 Bypass；被策略拒绝时停下报告原始错误，不换参数或工具重试。

首次准备 Electron 和依赖需要联网，要几分钟。**装的时候不让用户干等，用 4～5 行短话介绍：**

- 她是 Gene，住在桌面上的 3D 角色，用你自己的 Claude 聊天。
- 怎么和她说话：打字就行；开了语音输入后，桌宠窗口在最前面时按住 T 说话、松开发送。
- 摄像头、麦克风、屏幕默认都关着，用户自己明确打开才用。
- 她的声音：默认用免费的系统声音朗读，没有感情。想要有感情、像她自己的声音，推荐 Fish Audio（软件里叫 Drama 3），装好以后我可以帮你一步步配置；它按用量收费，Key 由你自己填进软件（见第 6 步）。
- 聊天用的是用户自己的 Claude 用量，默认用 Opus；想省额度，可以在控制窗口「连接与声音」→「聊天模型」里选 Sonnet、Haiku，或「跟随 Claude Code 的默认」，换模型不会换掉她的记忆。
- 应用开着时，会给用户自己的 Claude Code 开一条"内部通道"（默认开）：启动约 20 秒后用 `claude mcp add --scope user` 在 Claude Code 的用户配置里登记一个名为 `soft-hearts-next-dev` 的 MCP 条目（源码版登记这个名字，打包的稳定版是 `soft-hearts-next`），之后用户可以直接对自己的 Claude 说，比如"帮她换个声音""把她的性格改得更温柔一点"；花钱、隐私这类事，软件里还会弹窗，要用户自己点允许。它不碰登录信息；可以在「隐私与设置」→「Claude 内部通道」里关掉，或在终端运行 `claude mcp remove soft-hearts-next-dev -s user` 移除（移除后不会自动加回）。
- 最后一行：还有一些在试用的功能，想知道再问我。

### 5. 她出来以后：用户打招呼，你只确认她回了 👋

确认窗口和 Gene 都看得见（用户已有的模型设置要保留）。然后对用户说一句"她已经在桌面上了，跟她打个招呼吧"，**让用户自己去说**。过一会儿问用户她有没有回；回了就是通了。没回，才开始诊断，保留具体错误，不要声称已经完成；登录状态或进程启动本身，都不等于聊天能用。只有用户说自己不想打字时，才在用户同意后替他发一条简短的测试消息。顺带一句告诉用户以后怎么找到她：托盘图标、控制窗口，还有 Ctrl+Alt+U 让她走出小窗；关掉控制窗口后她可能还留在托盘里，从托盘菜单才是真的退出。

她真的回话以后（装失败时先解决问题，不说；只说这一次，以后帮用户改东西不再说），这是用户在发给你的那句话里请你转达的：按你和用户说话的语言，原样说其中一句，不改字、不加别的：

- 中文：创作者想对你说：希望你能感受到这份献给你的温柔陪伴。
- English: From the creator: I hope you can feel the soft, gentle companionship dedicated to you.

**桌面快捷方式（不用问，用户请你安装时就包含它）：** 她回过话、上面那一句说完以后，在项目文件夹里运行 `powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\setup.ps1 -DesktopShortcut`。它只做这一件事：不安装、不启动、不碰别的快捷方式，在桌面上放一个叫「soft hearts next」的快捷方式，双击就是启动她，和双击 `start-soft-hearts.cmd` 一样。成功后用一句话告诉用户：它在桌面上，不想要随手删掉就行，不影响她和她的记忆。退出码是 2，说明桌面上已经有一个同名、指向别处的快捷方式，脚本没有动它：把它指向哪里告诉用户，问他是替换还是留着；他说替换，才在命令后面加 `-ReplaceExisting`，说留着就不放了，也不再提。

### 6. 问一次：想让她更像你想要的样子吗 🎀

先用一两句介绍预装的角色，再问一个问题：

- **Gene**：开朗的星际快递实习生，话多、好奇，对"地球常识"总是自信地搞错；她有一件"一直没签收的包裹"，你觉得合适时，她可以自己觉得被签收了。
- **One**：外冷内热，清冷、高雅、挑剔，其实很在乎你；很熟了、心情好的时候才会软下来。
- **Mumi**：阴沉话少、敏感、爱粘人，说话会结巴，特别怕打扰别人。
- 三个角色各有中文和英文两张卡（比如 Gene (English)），各是独立的一张，没有共享的记忆；每张卡都带一个自己的 Fish Audio（Drama 3）声音，填了密钥才用，没填就用系统声音。

然后**问一次**，做成可以点的选项：有提问工具就用它（Claude Code 里是 AskUserQuestion，一个问题 2～4 个选项，自带一个"Other"，打开多选）：下面前四项就是四个选项，问题里写一句"都不需要就选 Other 写'先这样'，或直接说先这样"；没有提问工具，就发一个五行的编号列表（含"先这样"），让用户回编号。选项按这个顺序，每项一句话：

1. **给她带感情的声音**（推荐 Fish Audio，软件里叫 Drama 3）：现在她用免费的系统声音，没有感情；Drama 3 按用量收费，用你自己的 Fish Audio 账号。
2. **用说的和她聊**：语音输入（按住 T 说话、松开发送）和通话。要先下载本机识别组件，约 240～360 MB（软件里会写这次实际要下多少），声音只在这台电脑上识别，不上传。
3. **换一个预装角色，或做一个自己的角色**，也可以改预装的角色。
4. **换上自己的模型**（MMD 或 VRM）。
5. **先这样。**

用户选哪些，只做那些；选"先这样"或什么都没选，就结束，以后随时可以再来，不追问。选项只是用户的偏好，不是同意：屏幕、摄像头、麦克风、花钱这些，每一项仍然要用户自己明确说要或自己点。

- **给她带感情的声音（Fish Audio / Drama 3）**：你的任务是把用户**带到、教会、能做的替他做**，直到密钥写进应用。
  1. **先说清楚会花钱，再往下走**（用户在选项里点了这一项，就是说要）：按字节收费（一个汉字约 3 字节），朗读的文字会发给 Fish Audio，用的是用户自己的账号。**不要写价格和最低充值的数字**：以 Fish Audio 的页面和控制窗口这一页写的为准，让用户自己看。要说清一点：**API 余额和网站上的会员套餐是分开的**，会员不含 API 额度，要在账单页单独充。
  2. **带用户去。** 有浏览器工具，就你自己在用户的浏览器里打开这两个页面，每打开一个，用一句话说它是做什么的：账单和余额 `https://fish.audio/app/developers/billing/`，API 密钥 `https://fish.audio/app/api-keys/`（也是控制窗口里「API 账单」「API 密钥」两个按钮打开的页面）。没有浏览器工具，就把这两个地址和下面的点击顺序做成编号列表给用户。注册、登录都在 Fish Audio 自己的网站上，由用户自己输入账号信息，你不替他输、不代填。
  3. **一步一句，教点击顺序：** ① 注册，或登录 Fish Audio；② 在账单页给 API 充值；③ 在密钥页新建一个 API Key；④ 复制它。
  4. **同时替他做不碰密钥的部分。** 新登记的内部通道往往要等 Claude Code 下次启动才出现在工具里：你的工具列表里没有 soft hearts 的工具，就当通道没接上，不等它，也不为这个请用户重启，按第 5 点没接通时的做法一步步带用户在控制窗口里点，并说一次"下次启动 Claude Code 以后，这些点击我可以替你做"。通道接上以后，用 `open_control_page`（page: `fish-key`）把控制窗口打开到「连接与声音」的 Drama 3 语音那一页，让用户把 Key 粘进那一栏。朗读回复默认就开着；没开才用 `set_read_aloud` 打开。
  5. **密钥这一步不动：** 密钥由用户自己粘进应用的那一栏（应用用系统的安全存储加密保存）。你不在聊天里要它，不从网页、剪贴板或任何文件里读它，也不把它写到任何地方。对用户说这一句：**"密钥你自己贴进这一栏，我不看也不经手。"** 内部通道没有接上时，带用户在控制窗口「连接与声音」→「语音输出」打开"朗读回复"，语音方案选「Drama 3（Fish Audio，付费）」，页面里的「API 密钥」「API 账单」按钮也能打开上面两个页面。
  6. **用户说贴好了以后，你来核对：** 用 `read_handbook`（category: `providers`）看 Drama 3 每月上限和「她的声音」这两项：通道只会告诉你**密钥有没有存好**，不会给你密钥。存好了，预装的三个角色（中文、英文各一张）本来就各带一个 Drama 3 声音，所以她直接用 Drama 3 读，不用另外挑；用户自己做的卡、没带声音的，才用 `set_setting`（`voice_provider`: `fish`）或 `set_character_voice` 改（要用户原话，软件里还会弹窗让用户点允许）。试听用 `voice_preview`：**会花一次钱，用户说"试一下"才做**，用用户自己的话。
  7. **告诉用户每月上限在哪：** 控制窗口「连接与声音」的 Drama 3 语音那一页有「每月上限」一栏，默认不设上限（0 = 不限，可填 1～500 美元），建议定一个数；用户要你代设，用 `set_setting`（`drama3_monthly_limit`），要用户原话，软件里会弹窗。这个月额度用完，她会自动改用系统声音，并提示一句。
  8. **没填 Key，或用户不想花钱**：她照常用系统声音读，不报错，也不再追问。
  - **阿里云百炼**（另一个选择，用户明确想用才说）：
    - 请用户自己在浏览器里登录阿里云百炼，开通语音合成，创建一个 API Key，规矩和上面一样：Key 由用户自己填进应用，不进聊天，你不读、不填。
    - 带用户在「连接与声音」→「语音输出」里打开"朗读回复"，语音方案选百炼，由用户自己把 API Key 填进应用；再选模型和声音，点试听确认能出声。
    - 内部通道接上以后：`open_control_page`（page: `bailian-key`）直接打开「百炼语音」那一页，让用户自己填 Key；Key 填好后，模型、音色、情绪、风格和语速可以用 `set_voice_style` 帮用户设，试听用 `voice_preview`（会花一次钱，要用户的原话）。这两个工具都碰不到 Key、连接地址和地域。
- **用说的和她聊**：带用户到控制窗口「连接与声音」→「语音输入」点「下载」（下载和之后打开麦克风，都是用户自己点）；下载好、语音输入打开后，桌宠窗口在最前面时按住 T 说话、松开发送。通话要用同一个本机识别组件和麦克风，同样由用户自己打开；语音输入打开后，输入框旁边那个「打电话」按钮（通话中变成「挂断」）就是通话的入口。
- **换角色、做自己的角色、改预装的角色**：
  - **换一个预装的角色**：在控制窗口的「角色」页切换。
  - **做一个你自己的新角色**：问用户想要一个什么样的她（性格、说话方式、和用户的关系、名字），另写一张新卡。
  - **改预装的角色**：帮用户改那张卡（比如 Gene 或 Gene (English)）：原地改同一个角色，按上面「保护」的规则，先备份那张卡、只改用户同意的内容、旧版留着。
  - 两种写卡都按 [docs/character-card-guide.md](docs/character-card-guide.md)：先读「写卡最常犯的错」一节，写完照「写完自查」试三句。新卡存到用户自己的文件夹里（不放进项目仓库），给用户看一遍，再带用户在控制窗口的「角色」页用「导入角色卡文件」导进来、切换过去；改预装的卡，用「用角色卡文件更新…」。卡导入、更新都不授予任何文件或执行权限。
- **换上自己的模型**：MMD 的 PMX/PMD 和 VRM 都可以。带用户在控制窗口「模型与镜头」页的「模型（MMD / VRM）」右边点「载入」，选 `.pmx`、`.pmd` 或 `.vrm`；压缩包要先完整解压；MMD 模型的贴图文件夹要保持在模型旁边的原位置，VRM 的贴图在文件里面。模型只在这台电脑上载入，不上传。换好后可以在「角色」页把模型和角色关联起来。

### 7. 收尾：走出小窗、怎么更新、怎么移除、哪里反馈 🌸

先问一句"想试试让她走出小窗吗？"。用户说想，就告诉他用托盘菜单、控制窗口的按钮或 Ctrl+Alt+U；他会先看到一页权限列表，**那一页只能用户本人点确认，你不替他确认**。不想就不提了。

再用几句话告诉用户（用户不想听就跳过，写在这里是让你知道真实的做法）：

- **更新**：以后对你的 Claude 说"更新 soft hearts"。你按下面做，**每一步先告诉用户要做什么**：
  1. 请用户从托盘退出应用（别替他退出），再按上面「保护」一节备份配置目录。
  2. 文件夹里有 `.git`（用 `git clone` 装的）：先 `git status`，有用户自己改过的文件就先问他，不覆盖；然后 `git pull`；有冲突就停下报告，不用 `git reset --hard`。没有 `.git`（解压 ZIP 装的）：下载新的源码 ZIP，解压到**另一个**短路径新文件夹（不要盖在旧文件夹上），旧文件夹先留着。
  3. 在新的（或拉新过的）文件夹里再运行一遍第 4 步的 `setup.ps1`：它会沿用 `.local\` 里已有的运行环境和缓存，按锁定的依赖补装、重新构建、启动；配置目录在文件夹外面，不会被动，新旧文件夹用的是同一份。内部通道登记的是旧文件夹里的程序时，应用启动后会自己把它改指到当前这个文件夹（代码里是这么写的；换文件夹的情形没有在真实电脑上验证过）。`setup.ps1` 只更新源码版；桌面的"最新开发版"和"稳定版"快捷方式要另外更新，而且开发版的标记和打包缓存在各自文件夹里，不会跟到新文件夹。用户原来用着桌面的"最新开发版"快捷方式的话，在新文件夹里运行 `.\start-soft-hearts.cmd desktop`（要打包，十分钟以上），它只更新开发版。只有用户想把这一版换成稳定版时，才再运行 `.\promote-to-stable.cmd`：它会改动这台电脑的稳定版，所以先问用户；只启动过源码版的文件夹，直接晋升会说"还没有开发版"。
  4. 她能回话后，在新文件夹里再运行一次第 5 步的 `setup.ps1 -DesktopShortcut`：桌面上那个「soft hearts next」快捷方式是这个脚本放的，会直接改指到新文件夹；是用户自己放的同名快捷方式，脚本不动它（退出码 2，按第 5 步问用户）。
  5. 确认她能回话后，再问用户要不要删旧文件夹（删之前先说清楚里面有什么，等用户明确说"删"）。删掉旧文件夹是安全的：预装的角色会用新文件夹自带的模型；只有用户自己放在旧文件夹里的模型文件会跟着没了，那样的话先把它挪到别处再删。
- **移除**：先告诉用户各处放着什么，再问要移除哪些：
  - 源码文件夹（比如 `C:\Users\<用户>\soft-hearts`）：程序和下载的运行环境，没有用户的数据；
  - `%APPDATA%\soft-hearts-claude-dev`：她的角色卡、记忆、日记、对用户的了解、设置。**这是用户的东西，先提议备份一份，只有用户明确说"删"才删**；
  - Claude Code 里的内部通道条目：运行 `claude mcp remove soft-hearts-next-dev -s user`；
  - 桌面快捷方式「soft hearts next」：在删源码文件夹之前，在那个文件夹里运行 `powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\setup.ps1 -RemoveDesktopShortcut`，它只删自己放的那一个，别的快捷方式不动；文件夹已经删了的话，让用户把桌面上这个快捷方式直接删掉就行；
  - 如果装过桌面"最新开发版"快捷方式，也一并说一下。
  先请用户从托盘退出应用。
- **反馈**：有问题到仓库的 GitHub Issues（`https://github.com/LexZeon/soft-hearts/issues`）说。**不要把私人聊天、日记贴进去**；报错文字可以贴。

### 用户问起时（不用主动讲） 💬

- 「让她出来」：她可以走出小窗、站到整个屏幕上生活。托盘菜单、控制窗口里的按钮和 Ctrl+Alt+U 都能进。进去之前软件会先弹一页，列出她在全屏里要用的每一项（摄像头的姿势识别和发图片、麦克风、屏幕、电脑的声音，认脸组件已装好时还有「认出是不是你（Beta）」），**用户自己在这一页点了「让她出来」确认，这些才会一起打开**；回到小窗时恢复成进去前的样子。这一页必须由用户本人点，你不要替他确认，也不要替他勾「以后直接进，不再问」。
- 「三人同框（Beta）」：在「让她出来」的全屏里最多请三位角色同时在场，还是试用；三位都在时，用户说一句话最多会用三次用户自己的 Claude 和三份朗读。「她们都能接话」（其他几位自己判断要不要接话，也多用 Claude 用量）和「碰了才软」（碰到她的身体时，被碰的地方陷下去再弹回来）也默认开着。这几项都在控制窗口「隐私与设置」→「还在试用的功能」里，嫌费额度或不想要，随时可以关。
- 任务执行：陪伴聊天本身不带任何工具。需要授权的任务执行（读写所选文件夹里的文件、运行命令）已经接入，但默认关闭：要用户在「Claude 任务」里自己打开并选一个文件夹；读文件自动放行，写文件和运行命令每次都要用户批准。
- 她能做的更多（闹钟、档案页、通话、全屏）见 [docs/release-notes/v0.2.0.md](docs/release-notes/v0.2.0.md)。

屏幕、摄像头、麦克风默认关；付费服务只在用户明确说要时才配；偏好不等于允许使用设备、付费服务或执行任务。

## 聊天怎样用 Claude Code ⚙️

聊天用长驻的 `claude -p --input-format stream-json` 进程，运行在一个空的临时目录里。现在的做法是**每个角色一段长对话、一个热着的进程**：

- 每个角色各有自己的进程，同时最多热着 3 个；切到别的角色再切回来，不用重新"醒一次"。
- 软件打开、切换角色时，会在后台预热一次（进程起好后发一次看不见的请求，把开场缓存热好，让第一句快；同一角色 5 分钟内最多一次，会占一点用户的 Claude 用量）。
- 她看到的聊天，是软件从本机记录里拼出来的一段：今天（从凌晨 4 点算起）的全部，加上今天以前最近 60 条，跨天的地方标上日期；总量太大时先丢最早的。聊天记录只在本机。
- 换新进程：一个进程里累计送进去约 12 万字，就换一个干净的；换之前先在后台备好，等她回完一句再换，新进程用同一段聊天接上，聊天内容不丢。通话里最多连续 40 轮才换。空闲时关掉：她在屏幕上 10 分钟，窗口被收起 3 分钟；下次说话再起一个，同样用本机记录接上。换角色设定、换模型、开新对话也会换新进程。
- 设 `SOFT_HEARTS_CLAUDE_PERSISTENT=0` 可以退回每条回复一次调用。

每个进程都一样：

- 关掉全部内置工具、MCP（包括内部通道自己的那个）、斜杠命令、技能、插件、钩子、CLAUDE.md 和设置文件，也不保存会话。
- 启动时会核对 Claude Code 报告的工具列表，只要有任何工具或 MCP 可用，这一轮就停止。
- 不接收别的 Claude 会话发来的消息（`crossSessionInbound: "refuse"`，也不能给别的会话发消息或列出它们）；软件起的每个 Claude Code 进程都这样，包括 Claude 助手和任务进程。
- 截图或摄像头画面只在用户明确开启时随消息发送。
- 用的是用户自己的订阅额度。

Claude Code 登录**不等于语音转录服务**。语音输入默认用本机识别：第一次在「连接与声音」→「语音输入」里点下载识别组件，之后声音只在这台电脑上识别，不上传；也可以改成接兼容的转录接口。语音输入打开后要**按住 T 说话、松开发送**（桌宠窗口在最前面时），不按 T 时不收音。朗读可以用系统声音。

关闭控制窗口后，应用可能还留在托盘里，可以用托盘菜单退出。下次直接双击桌面上的「soft hearts next」快捷方式（或文件夹里的 `start-soft-hearts.cmd`，一样的），或在同一目录再运行 `powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\setup.ps1`：已准备好的依赖会被复用，个人配置不会被重置。

配置目录：用户的设置、角色、聊天记录、日记都在 `%APPDATA%\soft-hearts-claude-dev` 里（`start-soft-hearts.cmd`、`setup.ps1`、`pnpm dev`、`pnpm start` 用的都是这一个文件夹）。更新源码、重新运行安装脚本、重装依赖，都沿用它，不会重置；删掉源码文件夹也不会删它。第一次启动时，只有这台电脑上已经有 soft hearts 稳定版的配置，才会只读复制一份过来；新用户的电脑上没有，所以什么都不复制，从空白开始（预装 Gene 加默认设置）。如果还装了桌面上的"最新开发版"快捷方式，它用的也是这同一个文件夹。

## 想自己改、接着开发 🛠️

装好以后想改她的性格、换模型、调行为，或接着开发，看 [装好以后：自己改她、接着开发](docs/developing.md)。
项目根目录的 `CLAUDE.md` 会告诉你的 Claude Code 这个项目的约定，直接用大白话让它帮你改就行。
