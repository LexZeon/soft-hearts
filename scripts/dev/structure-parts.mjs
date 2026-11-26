// Which of the program's 12 parts every source file belongs to (docs/claude/2026-11-15-overhaul-plan.md, step 1), or which of the two
// layer groups that are not parts: the foundation and the wiring (the trunk group retired in the wiring rewrite step 2).
// Data only: ordered rules, the FIRST rule that matches a repo-relative path (forward slashes) wins.
//   - a string ending in "/" matches a directory prefix; any other string matches that exact path;
//   - a RegExp is tested against the whole path.
// Each rule carries a note saying why those files are in that part. A file no rule places is "unassigned" (the inventory lists them).
// The assignment is a first pass made by reading names and import graphs, not a decision about the final folders: change a rule
// here, run `node scripts/dev/structure-inventory.mjs`, and every report follows.
// 2026-11-16 parts 4 (docs/claude/2026-11-16-overhaul-parts-4.md): the old part 1 "core" (主干：接线、设置、动作) is retired. What it held
// is now the actions part (身体动作), the settings part (设置和控制窗口框架), the foundation group and the trunk group; the trunk group retired in
// the wiring rewrite step 2 (its files went to the foundation, the wiring group and four parts).

/** The parts: each has folders and public pages (PART_FOLDERS). */
export const PART_IDS = ['settings', 'stage', 'senses', 'memory', 'mood', 'brain', 'unbound', 'initiative', 'safety', 'cards', 'voice', 'actions'];
/**
 * Groups a file can belong to that are not parts (layers, plan section 8): 'foundation' (FOUNDATION below) and 'wiring' (the entries,
 * the wiring files and the contract: WIRING, CONTRACT below). The trunk group (what was left of the old core) was sorted into these
 * and the parts in the wiring rewrite step 2 (docs/claude/2026-11-16-wiring-steps-0-2.md). The inventory lists them beside the parts.
 */
export const LAYER_GROUP_IDS = ['foundation', 'wiring'];
/** Every id assignPart can return. */
export const GROUP_IDS = [...PART_IDS, ...LAYER_GROUP_IDS];

export const PARTS = {
  settings: { n: 1, name: '设置和控制窗口框架' },
  stage: { n: 2, name: '舞台：桌宠画面' },
  senses: { n: 3, name: '感知' },
  memory: { n: 4, name: '记忆和关系' },
  mood: { n: 5, name: '心情和反应' },
  brain: { n: 6, name: '她的大脑：聊天' },
  unbound: { n: 7, name: 'Unbound' },
  initiative: { n: 8, name: '她主动做的事' },
  safety: { n: 9, name: '连接、任务和安全' },
  cards: { n: 10, name: '角色卡' },
  voice: { n: 11, name: '声音' },
  actions: { n: 12, name: '身体动作' },
  foundation: { n: 'F', name: '基础（层，不是部分）' },
  wiring: { n: 'W', name: '接线（层，不是部分）：程序入口、接线文件、接口总表' },
};

/** Folders and files that are not part of the program's parts: listed separately in the inventory. */
export const SOURCE_ROOTS = ['electron/', 'shared/', 'src/'];
export const SEPARATE_ROOTS = ['scripts/', 'tests/'];
/** What counts as a source file inside the three roots (licenses and notices are .txt and not code). */
export const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.mjs', '.js', '.css', '.json', '.html'];


/**
 * Where each part lives once it has moved into folders (overhaul plan section 8, step 3). The part's public page is
 * `<folder>index.ts`: the only file of the part that other parts may import (the layer check, rule part-imports-part-internal).
 * Every file under a part folder belongs to that part (the first rules below are made from this table).
 * Moved so far (docs/claude/2026-11-16-overhaul-parts-1.md): 10 角色卡, 11 声音, 7 Unbound; (2026-11-16-overhaul-parts-2.md): 9 连接、任务和安全, 8 她主动做的事, 4 记忆和关系;
 * (2026-11-16-overhaul-parts-3.md): 3 感知, 5 心情和反应, 6 她的大脑：聊天; (2026-11-16-overhaul-parts-4.md): 2 舞台, then the old core split
 * into 12 身体动作 and 1 设置和控制窗口框架. Every part now has its folders.
 */
export const PART_FOLDERS = {
  cards: ['electron/cards/', 'shared/cards/', 'src/cards/'],
  voice: ['electron/voice/', 'shared/voice/', 'src/voice/'],
  unbound: ['electron/unbound/', 'shared/unbound/', 'src/unbound/'],
  safety: ['electron/safety/', 'shared/safety/', 'src/safety/'],
  initiative: ['electron/initiative/', 'shared/initiative/', 'src/initiative/'],
  memory: ['electron/memory/', 'shared/memory/', 'src/memory/'],
  senses: ['electron/senses/', 'shared/senses/', 'src/senses/'],
  mood: ['electron/mood/', 'shared/mood/', 'src/mood/'],
  brain: ['electron/brain/', 'shared/brain/', 'src/brain/'],
  stage: ['electron/stage/', 'shared/stage/', 'src/stage/'],
  actions: ['electron/actions/', 'shared/actions/', 'src/actions/'],
  settings: ['electron/settings/', 'shared/settings/', 'src/settings/'],
};
const FOLDER_PARTS = Object.entries(PART_FOLDERS);

export const RULES = [
  // ---- the foundation layer (FOUNDATION below): group 'foundation', not a part -----------------------------------------------
  { part: 'foundation', match: /^(?:electron|shared|src)\/foundation\//, note: 'The foundation layer (2026-11-16): the layer check treats it as the layer under every part.' },

  // ---- parts that live in their own folders (PART_FOLDERS above) -----------------------------------------------------------
  ...FOLDER_PARTS.flatMap(([part, folders]) => folders.map((folder) => ({ part, match: folder, note: `The ${PARTS[part].name} folder (PART_FOLDERS).` }))),

  // ---- the entry's own files, kept where they are (wiring rewrite step 2, docs/claude/2026-11-16-wiring-steps-0-2.md): the profile folder
  //      names and the start-up path electron/desktop-entry.ts imports by relative path. desktop-entry.ts and profile.ts must not change by a
  //      byte, so the files it imports do not move either; they are foundation by exact path (FOUNDATION below). ---------------------
  ...['electron/profile.ts', 'electron/desktop-channel.ts', 'electron/desktop-shortcut.ts', 'electron/graceful-quit.ts', 'electron/lnk-plain-path.ts']
    .map((match) => ({ part: 'foundation', match, note: 'Foundation by exact path: the profile folders and the start-up path of electron/desktop-entry.ts, which stay in place.' })),

  // ---- the wiring layer: group 'wiring', not a part (the old trunk retired in the wiring rewrite step 2): the program entry, the two
  //      window entries' wiring, the renderer-host contract, and the wiring folders the rewrite fills (WIRING, CONTRACT below). -------
  ...['electron/main.ts', 'electron/desktop-entry.ts', 'src/main.ts', 'shared/contracts.ts', 'electron/wiring/', 'src/wiring/']
    .map((match) => ({ part: 'wiring', match, note: 'The wiring layer: entries, wiring files and the contract (WIRING, CONTRACT).' })),

  // ---- 12 actions: electron/actions/, shared/actions/, src/actions/ (PART_FOLDERS, 2026-11-16 parts 4): the body action layer — pose,
  //      gesture and expression channels, the motion library and its catalog, bindings, recipes, her actions, chat gestures, the motion tag
  //      index (shared/actions/r32/), the universal skeleton, the motion library panels. The stage's own motion code stays in src/stage/ ----

  // ---- 1 settings: electron/settings/, shared/settings/, src/settings/ (PART_FOLDERS, 2026-11-16 parts 4): the settings store and its
  //      validation, defaults, the language preference, the capability table, companion commands and the "scan" request parsers, the control
  //      window frame (navigation, layout, global styles, notices, the companion-command choices) ---------------------------------------

  // ---- 9 connections, tasks and safety: electron/safety/, shared/safety/, src/safety/ (PART_FOLDERS, 2026-11-16 parts 2): the agent
  //      channel, Claude tasks, the settings assistant, test commands, the crisis card, the preload, clipboard and Codex permissions ----

  // ---- 10 character cards: electron/cards/, shared/cards/, src/cards/ (PART_FOLDERS, 2026-11-16) ------------------------------

  // ---- 11 voice: electron/voice/, shared/voice/, src/voice/ (PART_FOLDERS, 2026-11-16); its behaviour folder shared/behaviors/voice-call/
  //      stays with the other behaviour folders (BEHAVIOUR_PARTS below) -----------------------------------------------------------

  // ---- 3 senses: electron/senses/, shared/senses/, src/senses/ (PART_FOLDERS, 2026-11-16 parts 3): camera pose, face check, local ASR,
  //      ambient audio, listening and watching together, what the user is doing; its behaviour folders stay in shared/behaviors/ ----

  // ---- 4 memory and relationship: electron/memory/, shared/memory/, src/memory/ (PART_FOLDERS, 2026-11-16 parts 2); its behaviour
  //      folder shared/behaviors/upcoming/ stays with the other behaviour folders (BEHAVIOUR_PARTS below) -------------------------------

  // ---- 5 mood and reactions: electron/mood/, shared/mood/, src/mood/ (PART_FOLDERS, 2026-11-16 parts 3): hormones and mood values,
  //      fatigue, realer emotions, her state, the mood judge, reactions, touch, her needs, emotion read off speech, mood faces and tears;
  //      its behaviour folders stay in shared/behaviors/ ----------------------------------------------------------------------------

  // ---- 6 her brain: chat: electron/brain/, shared/brain/, src/brain/ (PART_FOLDERS, 2026-11-16 parts 3): the Claude process and
  //      session, prompts and their switches, I-139, reply checks and the reply window, long chat, module routing, speak-only, pause
  //      talk, the opening of a new chat (electron/brain/opening-host.ts); its behaviour folders stay in shared/behaviors/ ----------

  // ---- 8 things she starts herself: electron/initiative/, shared/initiative/, src/initiative/ (PART_FOLDERS, 2026-11-16 parts 2). Its
  //      behaviour folders stay in shared/behaviors/ (BEHAVIOUR_PARTS below); inner-loop's opening-host.ts went to 大脑 (electron/brain/) --

  // ---- 7 Unbound: electron/unbound/, shared/unbound/, src/unbound/ (PART_FOLDERS, 2026-11-16); the showcase lives in
  //      electron/unbound/showcase/ and src/unbound/showcase/, its English text table is foundation (shared/foundation/) -------------

  // ---- 2 stage: electron/stage/, shared/stage/, src/stage/ (PART_FOLDERS, 2026-11-16 parts 4): the companion picture (MmdStage, procedural
  //      life, sleep, drawing, camera, model loading, music on the stage), her own life (electron/stage/her-life/), the companion window and
  //      its UI, the model store and capabilities, body and visual personalisation, the single-emoji window; its behaviour folder
  //      shared/behaviors/idle-gesture/ stays with the other behaviour folders (BEHAVIOUR_PARTS below) ----------------------------
];

/** Catch-alls for shared/behaviors/<name>/: one behaviour folder belongs to the part that owns the behaviour. */
const BEHAVIOUR_PARTS = {
  mood: ['blush', 'mood-judge', 'reactions', 'touch-response', 'touch-feed-effect', 'sleep-rhythm'],
  initiative: ['boredom-timing', 'feed-cue', 'give', 'hands', 'impulse', 'inner-rhythm', 'interaction-budget', 'keepsake', 'self-look', 'moments', 'alarms'], // moments (I-188): the moments she recognises, read by the inner loop and the journal; alarms (I-195): her own alarms, read by the moments host, the chat turn and the user profile page
  brain: ['busy-chat', 'long-chat', 'opening-choice', 'pause-talk', 'reply-linger', 'speech-beats', 'text-first'], // speech-beats (边说边演): read by the stage, Unbound and the voice host through shared/brain's page
  senses: ['gaze-attention', 'user-activity', 'watch-along', 'watch-timeline', 'pose-uses'], // pose-uses (I-189): what the local pose signals are used for (reading pause, a turned face in a call, nod answers, body time), read through shared/senses
  stage: ['idle-gesture', 'sleep-body', 'pull', 'talk-calm'], // pull (I-136 step 5): pulling her, read by the stage, the companion input and Unbound; sleep-body: how her body lies and moves asleep, read only by the stage (wiring rewrite step 1); talk-calm (I-170): her idle head calms while you talk, read by the stage and Unbound through shared/stage
  memory: ['upcoming'],
  voice: ['voice-call', 'interrupt', 'call-duck', 'call-devices'], // interrupt: who may cut her off, read by the voice host and the call; call-duck / call-devices (I-177 batch 2): her voice ducks while you start talking over her, Claude's device judgement
  unbound: ['part-mix'], // part-mix (I-175): how her parts mix (the mouth's base shape and lip-sync, closed-mouth shapes at a pause, "how long"), read by the Unbound engine only
};
for (const [part, names] of Object.entries(BEHAVIOUR_PARTS)) {
  RULES.splice(0, 0, { part, match: new RegExp(`^shared/behaviors/(?:${names.join('|')})/`), note: `shared/behaviors/ ${names.join(', ')}: behaviours owned by this part.` });
}

const compiled = RULES.map((rule) => ({ ...rule, test: matcher(rule.match) }));

function matcher(match) {
  if (match instanceof RegExp) return (p) => match.test(p);
  if (match.endsWith('/')) return (p) => p.startsWith(match);
  return (p) => p === match;
}

/** The part id for a repo-relative path, or null when no rule places it. */
export function assignPart(relPath) {
  const p = relPath.replace(/\\/g, '/');
  for (const rule of compiled) if (rule.test(p)) return rule.part;
  return null;
}

/** The first rule that matches (for reports and debugging). */
export function matchingRule(relPath) {
  const p = relPath.replace(/\\/g, '/');
  return compiled.find((rule) => rule.test(p)) ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Layers (docs/claude/2026-11-15-overhaul-plan.md section 8): foundation below, the 11 parts in the middle, wiring on top.
// `node scripts/dev/structure-inventory.mjs --check-layers` reads this data.

/**
 * Foundation: shared vocabulary every part may use. Types, protocol and small stateless helpers only. It must import no part.
 * Same format as RULES: a string ending in "/" is a folder prefix, any other string an exact path, a RegExp the whole path.
 */
export const FOUNDATION = [
  { match: 'shared/foundation/', why: 'Platform-free (2026-11-16): settings / runtime-state / chat / pet-reply / tts-config (split out of contracts.ts), character-card (the card types, split out of character-cards.ts), mood.ts and its 7 pure siblings (123 importers), ui-language and its English text tables (16 files of pure data that ui-language reads), recycle-bin (I-144: what the windows and the agent channel see of the bin); since the wiring rewrite step 1 (docs/claude/2026-11-16-wiring-steps-0-2.md): the universal skeleton and its retarget json, the collision proxy, the face-morph rule (with HerFaceMorph), the I-139 texts, she-chooses, the settings defaults (DEFAULT_SETTINGS, CLAUDE_MODEL_ALIASES), the proactive-talk steps (in settings.ts).' },
  { match: 'electron/foundation/', why: 'Needs Node: atomic-file (write-then-rename saving, 55 importers), data-map (the table of every stored thing and what each privacy action does to it), keyed-part (the share of one character in a shared store, put back at its place: I-144); since the wiring rewrite step 1: the offline component manifests (pose-manifest, asr-manifest: file lists and hashes).' },
  { match: 'electron/profile.ts', why: 'The profile folder names (PROFILE_FOLDER, DEVELOPMENT_PROFILE_FOLDER): never moved, never changed (wiring rewrite step 2).' },
  { match: /^electron\/(?:desktop-channel|desktop-shortcut|graceful-quit|lnk-plain-path)\.ts$/, why: 'The start-up path electron/desktop-entry.ts imports by relative path (installed channel, own shortcut, the quit switch): kept in place so desktop-entry.ts stays byte for byte (wiring rewrite step 2).' },
  { match: 'src/foundation/', why: 'Renderer only: ui-language (the window side of the language choice, 74 importers), recently-deleted (I-144: the 最近删除的 list the character page and the single-delete panels of three parts share); since the wiring rewrite step 1: the VMD reader (vmd, vmd-tracks; the host reads it too).' },
];

/**
 * Contract: the renderer↔host API (DesktopAPI in shared/contracts.ts) and the wire types only one part or the wiring uses. It names
 * every part's IPC types, so it sits at the wiring level: it may import any part, and only the wiring, the contract clients below and
 * the contract itself may import it (rule imports-contract). Parts take the shared vocabulary from FOUNDATION and their own wire types
 * from their own files. Until a part does, its imports of the contract are counted as debt. The slices DesktopAPI extends
 * (shared/<part>/desktop-api.ts, docs/claude/2026-11-16-contracts-split.md) are ordinary files of their part, not contract files.
 */
export const CONTRACT = [
  { match: 'shared/contracts.ts', why: 'DesktopAPI, the preload surface: since 2026-11-16 it only joins the per-part slices (shared/<part>/desktop-api.ts, which are part files and hold the calls and single-part wire types of their part) and re-exports the old names for compatibility.' },
];

/** Who may import the contract besides the wiring: the preload, which implements DesktopAPI. (The renderer has no API client module yet.) */
export const CONTRACT_CLIENTS = [
  { match: 'electron/safety/preload.ts', why: 'The typed preload whitelist implements DesktopAPI.' },
];

/**
 * Wiring: the files that know every part and connect them. Nothing may import them (only other wiring may).
 * The wiring files themselves may import any part.
 */
export const WIRING = [
  { match: 'electron/main.ts', why: 'Host start-up: connects every part to windows, IPC and the profile.' },
  { match: 'src/main.ts', why: 'The renderer entry of both windows: picks the window (pet or control) and starts each part\'s renderer wiring in order (overhaul step 5, docs/claude/2026-11-16-src-main-split.md).' },
  { match: 'src/wiring/', why: 'The renderer wiring folder (overhaul step 5): every file ends in -wiring.ts; one per part or window (pet-window-wiring, control-window-wiring). Nothing in it runs on import (tests/renderer-golden.test.mjs).' },
  { match: 'electron/desktop-entry.ts', why: 'The program entry: chooses the profile folder, then loads electron/main.ts (wiring rewrite step 2; never changed).' },
  { match: 'electron/wiring/', why: 'The wiring folder (wiring rewrite step 3, docs/claude/2026-11-16-wiring-step-3.md): every file ends in -wiring.ts; the skeleton (ipc, shell, lifecycle, clock, parts, ports) and one <part>-wiring.ts per part. Nothing in it runs on import (tests/wiring-skeleton.test.ts).' },
  { match: /^(?:electron|shared|src)\/(?:[\w-]+\/)*[\w-]*wiring\.ts$/, why: 'Part wiring modules (the overhaul step 4 creates one per part; electron/safety/agent-channel/electron-wiring.ts already exists).' },
];

// PART_FOLDERS (each part's folders and so its public pages) is defined above RULES, which are made from it.

const compileList = (list) => list.map((r) => ({ ...r, test: matcher(r.match) }));
const compiledFoundation = compileList(FOUNDATION);
const compiledWiring = compileList(WIRING);
const compiledContract = compileList(CONTRACT);
const compiledContractClients = compileList(CONTRACT_CLIENTS);

export const isFoundation = (relPath) => compiledFoundation.some((r) => r.test(relPath.replace(/\\/g, '/')));
export const isWiring = (relPath) => compiledWiring.some((r) => r.test(relPath.replace(/\\/g, '/')));
export const isContract = (relPath) => compiledContract.some((r) => r.test(relPath.replace(/\\/g, '/')));
export const isContractClient = (relPath) => compiledContractClients.some((r) => r.test(relPath.replace(/\\/g, '/')));
export const foundationRule = (relPath) => compiledFoundation.find((r) => r.test(relPath.replace(/\\/g, '/'))) ?? null;

/** Is this file the public page of its part: <part folder>/index.<ext>? */
export function isPublicPage(relPath, part) {
  const p = relPath.replace(/\\/g, '/');
  return (PART_FOLDERS[part] ?? []).some((folder) => new RegExp(`^${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}index\\.(?:ts|tsx|mts|js|mjs)$`).test(p));
}
