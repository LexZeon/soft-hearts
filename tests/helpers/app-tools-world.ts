// The internal channel's behaviour golden (docs/claude/2026-11-17-app-tools-split.md). A fixed fake soft hearts (settings, two
// character cards, senses, recycle bin, songs, local recognizer, pose component, model check, her mood, files, manuals) behind a
// recording AgentAppBridge, and every tool of electron/safety/agent-channel/app-tools.ts driven through the real AgentToolRegistry
// in each way the user's Claude can reach it: 三方互通 on with and without the user's words, off (the dialog), the Claude 助手
// (always a dialog), her chat cards (set_setting), and a dialog answered "no". What is kept per call: the answer, the dialog text,
// the notice, what was recorded (tier, outcome, approval, words length), every host operation it asked for, and the undo it offered
// (run once, with its own host operations). Nothing here comes from the user's real data; no Electron, no Claude, no real files.
import { DEFAULT_SETTINGS } from '../../shared/foundation/defaults';
import type { AppSettings } from '../../shared/foundation/settings';
import type { CharacterCardState } from '../../shared/foundation/character-card';
import { DEFAULT_TTS_CONFIG } from '../../shared/voice';
import { DEFAULT_MODEL_PHYSICS } from '../../shared/stage/model-physics';
import { MODEL_CAPABILITY_IDS } from '../../shared/stage';
import { buildModelProfile } from '../../shared/stage/model-profile';
import { CHAT_ACTION_WORDS } from '../../shared/brain';
import { TAKE_ME_THERE_IDS } from '../../shared/initiative';
import { DISPOSITIONS, DISPOSITION_IDS } from '../../shared/mood';
import { REALER_DURATIONS } from '../../shared/mood/realer-duration';
import {
  AGENT_ALWAYS_DIALOG_TOOLS, AGENT_NEVER_EXPOSED, AGENT_SERVER_INFO, AGENT_SETTINGS, AGENT_TIER_LABELS, AGENT_TOOLS,
  type AgentSettingSpec, type AgentSettingValue,
} from '../../shared/safety/agent-channel';
import { AgentToolRegistry, type AgentToolDefinition, type AgentUndoOffer } from '../../electron/safety/agent-channel/registry';
import type { FileSystemPort } from '../../electron/safety/agent-channel/validate';
import type { HandbookDocSpec } from '../../shared/safety/handbook-docs';
import * as appTools from '../../electron/safety/agent-channel/app-tools';
import { profileInput, toyModel } from './model-fixtures';

type Bridge = appTools.AgentAppBridge;
export const A = '0f8fad5b-d9cb-469f-a165-70867728950e';
export const B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
export const NEW_CARD = '3b241101-e2bb-4255-8caf-4136c566a962';
export const ENTRY = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
export const OTHER_ENTRY = 'b1ffcd00-0d1c-4ef8-bb6d-6bb9bd380a22';
export const DELETED_ENTRY = 'd31e7ed0-0000-4000-8000-00000000c4a5'; // I-173: the bin entry a deleted card goes into
const FILE_VOICE = { provider: 'bailian', voiceId: 'longanhuan_v3.1' }; // I-173: the voice a card file brings
export const WORDS = '好的，就这样做吧';
export const NOW = Date.UTC(2026, 10, 17, 3, 0, 0);
const MODEL = { path: 'C:\\models\\gene\\gene.pmx', url: 'local://gene', name: 'Gene' };
const OTHER_MODEL = 'C:\\models\\other\\other.pmx';

/** What the fake app is like right now. Every call of the golden starts from a fresh one. */
export interface WorldState {
  settings: AppSettings; cards: CharacterCardState; interconnect: boolean;
  windows: { pet: appTools.WindowFacts | null; controls: appTools.WindowFacts | null };
  perception: appTools.PerceptionFacts; voiceCall: boolean; faceCheckPhase: string;
  recycle: { id: string; characterId: string; characterName: string; part: 'chat' | 'profile'; label: string; deletedAt: number; expiresAt: number }[];
  recycleDays: number; songs: number;
  localAsr: { phase: string; prompt: boolean; downloadBytes: number; installedBytes: number; progress: number | null; componentVersion: number; notice: string };
  host: appTools.HostSettingFacts; dispositions: Record<string, number> | null; capabilityChoices: Record<string, string>;
  /** 2026-11-23: she is out in full-screen Unbound (a default place can be set from where she stands). */
  unboundOut: boolean;
  /** 2026-11-24: Drama 3's spending this month as getTtsBudget gives it (numbers only); null: unreadable. */
  fishBudget: { month: string; bytes: number; spentMicroUsd: number } | null;
}

/** World variants a sample may ask for (by name, so the golden says which). */
export const TWEAKS = {
  'paid-bailian': (s: WorldState) => { s.settings.tts = { ...s.settings.tts!, provider: 'bailian' } as AppSettings['tts']; },
  'paid-fish': (s: WorldState) => { s.settings.tts = { ...s.settings.tts!, provider: 'fish', fishApiKey: '••••' } as AppSettings['tts']; },
  'pet-hidden': (s: WorldState) => { s.windows.pet = { visible: false, minimized: false }; },
  'controls-hidden': (s: WorldState) => { s.windows.controls = { visible: false, minimized: true }; },
  'no-model': (s: WorldState) => { s.settings.model = null; },
  'asr-installed': (s: WorldState) => { s.localAsr.phase = 'ready'; s.localAsr.installedBytes = 240_000_000; },
  'asr-downloading': (s: WorldState) => { s.localAsr.phase = 'downloading'; s.localAsr.progress = 0.4; },
  'pose-installed': (s: WorldState) => { s.host.pose = { ...s.host.pose!, phase: 'ready' as never }; },
  'pose-downloading': (s: WorldState) => { s.host.pose = { ...s.host.pose!, phase: 'downloading' as never }; },
  'senses-on': (s: WorldState) => { s.perception = { camera: true, cameraImages: true, cameraPose: true, faceCheck: true, microphone: true, screen: true, systemAudio: { music: true, movie: true } }; s.voiceCall = true; },
  'b-active': (s: WorldState) => { s.cards.activeId = B; },
  // 2026-11-23: a default place for her in Unbound is already set / she is not out in full screen (nothing to keep).
  'unbound-default-set': (s: WorldState) => { s.host.unboundDefaultPlace = 'default'; },
  'unbound-home': (s: WorldState) => { s.unboundOut = false; },
  // I-173: her own voice (the 角色页's 「她的声音」) is already Drama 3, with no id of its own yet.
  'own-fish': (s: WorldState) => { (s.cards.cards[0] as { voice?: unknown }).voice = { provider: 'fish', voiceId: '' }; },
  // 2026-11-24: a Drama 3 limit of 10 dollars already spent past (she reads with the system voice this month), and an unreadable budget.
  'fish-spent': (s: WorldState) => { s.settings.tts = { ...s.settings.tts!, fishApiKey: '••••', fishMonthlyCapUsd: 10 } as AppSettings['tts']; s.fishBudget = { month: '2026-11', bytes: 1_250_000, spentMicroUsd: 12_500_000 }; },
  'no-budget': (s: WorldState) => { s.fishBudget = null; },
} as const;
export type Tweak = keyof typeof TWEAKS | 'old-host';

export function freshState(tweak?: Tweak): WorldState {
  const settings = structuredClone(DEFAULT_SETTINGS) as AppSettings;
  settings.model = { ...MODEL };
  settings.pet = { ...settings.pet, visible: false };
  settings.tts = { ...structuredClone(DEFAULT_TTS_CONFIG), apiKey: '••••', apiHost: 'dashscope.example' } as AppSettings['tts'];
  const state: WorldState = {
    settings,
    cards: { activeId: A, revision: 3, cards: [
      { id: A, name: '阿棠', modelName: 'Gene', slowWarmUp: false, realerEmotions: false } as never,
      { id: B, name: '小雨' } as never,
    ] },
    interconnect: true,
    windows: { pet: { visible: true, minimized: false }, controls: { visible: true, minimized: false } },
    perception: { camera: false, cameraImages: false, cameraPose: false, faceCheck: false, microphone: false, screen: false, systemAudio: { music: false, movie: false } },
    voiceCall: false, faceCheckPhase: 'idle',
    recycle: [{ id: ENTRY, characterId: B, characterName: '小雨', part: 'chat', label: '聊天记忆', deletedAt: NOW - 86_400_000, expiresAt: NOW + 6 * 86_400_000 }],
    recycleDays: 7, songs: 3,
    localAsr: { phase: 'not-installed', prompt: false, downloadBytes: 251_000_000, installedBytes: 0, progress: null, componentVersion: 1, notice: '' },
    host: {
      uiLanguage: 'system', developerMode: false, music: { strength: 0.7, alwaysDance: false }, physics: structuredClone(DEFAULT_MODEL_PHYSICS) as never,
      proactiveVision: false, feedRecognition: false,
      pose: { phase: 'not-installed', prompt: false, downloadBytes: 172_000_000, installedBytes: 0, progress: null, route: null, level: null, componentVersion: 1, notice: '', strength: 1 } as never,
      moodJudge: false, reactions: true, userActivity: true, unboundDefaultPlace: 'none',
    },
    dispositions: null, capabilityChoices: {}, unboundOut: true, fishBudget: { month: '2026-11', bytes: 120_000, spentMicroUsd: 1_200_000 },
  };
  if (tweak && tweak !== 'old-host') TWEAKS[tweak](state);
  return state;
}

/** Changed paths between two JSON values (what a whole-settings save changed). */
function diff(before: unknown, after: unknown, at = ''): Record<string, unknown> {
  if (JSON.stringify(before) === JSON.stringify(after)) return {};
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    const out: Record<string, unknown> = {};
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort())
      Object.assign(out, diff((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key], at ? `${at}.${key}` : key));
    return out;
  }
  return { [at || '.']: after === undefined ? '(removed)' : after };
}

const PROFILE = buildModelProfile(profileInput(toyModel({ pose: 'T', twist: true })));
const DOCS: { spec: HandbookDocSpec; markdown: string }[] = [
  { spec: { id: 'guide/voice', file: 'docs/guide/voice.md', kind: 'guide', title: '声音和朗读', about: '怎么让她读出回复。' },
    markdown: '# 声音和朗读\n\n她可以把回复读出来。\n\n## 系统声音\n\n免费，默认打开。朗读的快慢在设置里调。\n\n## 百炼和 Drama 3\n\n要自己填 Key，按次付费。\n' },
  { spec: { id: 'mood/sleep', file: 'docs/mood/sleep.md', kind: 'design', title: '她怎么睡觉', about: '困了会睡。' },
    markdown: '# 她怎么睡觉\n\n困了会打哈欠，然后睡着。\n\n## 睡相\n\n角色卡里可以选睡相。\n' },
  { spec: { id: 'handbook/features', file: 'handbook/features.md', kind: 'handbook', title: '功能与状态', about: '每个功能做到哪一步。' },
    markdown: '# 功能与状态\n\n| 功能 | 状态 |\n|---|---|\n| 睡觉 | 待复验 |\n| 朗读 | 已确认 |\n' },
];

/** The fake files: name → size, time and content (stat and realpath only before the OK; bytes after it). */
const FILES: Record<string, { size: number; mtimeMs: number; text: string }> = {
  'C:\\cards\\new.json': { size: 2_048, mtimeMs: 1_000, text: JSON.stringify({ name: '新来的' }) },
  'C:\\cards\\big.json': { size: 2_000_000, mtimeMs: 1_000, text: '{}' },
  'C:\\cards\\update.json': { size: 4_096, mtimeMs: 2_000, text: JSON.stringify({ name: '阿棠', persona: 'new' }) },
  'C:\\cards\\renamed.json': { size: 4_096, mtimeMs: 2_000, text: JSON.stringify({ name: '阿棠二号', persona: 'new' }) },
  'C:\\cards\\same.json': { size: 4_096, mtimeMs: 2_000, text: JSON.stringify({ name: '阿棠', same: true }) },
  'C:\\cards\\voice.json': { size: 4_096, mtimeMs: 2_000, text: JSON.stringify({ name: '阿棠', persona: 'new', voice: true }) }, // I-173: a file with another voice
  [OTHER_MODEL]: { size: 40_000_000, mtimeMs: 3_000, text: '' },
};

export interface World { state: WorldState; ops: unknown[]; bridge: Bridge; fs: FileSystemPort; options: appTools.AppToolOptions }

export function makeWorld(tweak?: Tweak): World {
  const state = freshState(tweak);
  const ops: unknown[] = [];
  /** A host change: the commit guard first (as the host does), then it is written down and applied. */
  const op = (guard: (() => void) | undefined, name: string, args: Record<string, unknown> = {}) => { guard?.(); ops.push({ op: name, ...args }); };
  const summary = (name: string, changed: boolean) => ({ format: 'soft-hearts-v3', name: { before: '阿棠', after: name, changed }, changedFields: ['personality'],
    mood: 'kept', slowWarmUp: { before: false, after: false, part: 'same' }, response: 'kept', understandingNotes: 'kept', language: 'kept',
    sleepHabit: 'kept', musicTaste: 'kept', slips: 'kept', presetGene: false, unchanged: false });
  const memories: appTools.AgentMemoryBridge = {
    forget: async (characterId, characterName, parts, guard) => {
      op(guard, 'memories.forget', { characterId, characterName, parts });
      const entries = parts.filter(part => part === 'chat').map((part, i) => ({ id: `c0ffee0${i}-0000-4000-8000-000000000000`, characterId, characterName, part,
        label: part === 'chat' ? '聊天记忆' : '画像和日记', deletedAt: NOW, expiresAt: NOW + state.recycleDays * 86_400_000 }));
      state.recycle.push(...entries as never[]);
      return { entries: entries as never, empty: parts.filter(part => part !== 'chat'), failed: [] };
    },
    restore: async (entryId, guard) => {
      op(guard, 'memories.restore', { entryId });
      const entry = state.recycle.find(item => item.id === entryId);
      if (!entry) throw new Error('回收站里没有这一项。');
      state.recycle = state.recycle.filter(item => item !== entry);
      return { restored: entry as never, count: 12, replaced: entryId === ENTRY ? { ...entry, id: OTHER_ENTRY, label: '新的聊天记忆' } as never : null };
    },
    list: () => structuredClone(state.recycle) as never,
    days: () => state.recycleDays,
    setDays: async (days, guard) => { op(guard, 'memories.setDays', { days }); state.recycleDays = days; return days; },
  };
  const full: Bridge = {
    version: () => '9.9.9-golden',
    settings: () => structuredClone(state.settings),
    characters: () => structuredClone(state.cards),
    windows: () => structuredClone(state.windows),
    activateCharacter: async (id, guard) => { op(guard, 'activateCharacter', { id }); state.cards.activeId = id; return null; },
    bindCurrentModel: async (id, guard) => { op(guard, 'bindCurrentModel', { id }); const card = state.cards.cards.find(item => item.id === id)!; card.modelName = state.settings.model?.name; return null; },
    setSlowWarmUp: async (value, guard, characterId) => { op(guard, 'setSlowWarmUp', { value, characterId }); (state.cards.cards.find(item => item.id === (characterId ?? state.cards.activeId)) as { slowWarmUp?: boolean }).slowWarmUp = value; return null; },
    setRealerEmotions: async (value, guard, characterId, duration) => { op(guard, 'setRealerEmotions', { value, characterId, duration: duration ?? '(none)' }); (state.cards.cards.find(item => item.id === (characterId ?? state.cards.activeId)) as { realerEmotions?: boolean }).realerEmotions = value; return null; },
    setExperienceJournal: async (value, guard) => { op(guard, 'setExperienceJournal', { value }); state.settings.experienceJournal = value; return null; },
    settingChanged: (id, previous, value, via) => { ops.push({ op: 'settingChanged', id, previous, value, via }); },
    setPetVisible: async (visible, guard) => { op(guard, 'setPetVisible', { visible }); state.settings.pet.visible = visible; return null; },
    saveSettings: async (next, guard) => { op(guard, 'saveSettings', { changed: diff(state.settings, next) }); state.settings = structuredClone(next); return null; },
    commitPetBoolean: async (value, actionId, guard) => { op(guard, 'commitPetBoolean', { value, actionId });
      if (actionId === 'pet.set-always-on-top') state.settings.pet.alwaysOnTop = value; else state.settings.pet.followMouse = value; return { persistence: 'saved', presentation: 'applied' }; },
    commitReadoutVolume: async (percent, guard) => { op(guard, 'commitReadoutVolume', { percent }); state.settings.voice.volume = percent / 100; return { persistence: 'saved', presentation: 'applied' }; },
    commitBreath: async (percent, guard) => { op(guard, 'commitBreath', { percent }); return { persistence: 'not-committed', presentation: 'none' }; },
    importCharacterCard: async (content, guard) => { op(guard, 'importCharacterCard', { content });
      state.cards.cards.push({ id: NEW_CARD, name: JSON.parse(content).name } as never); return { ...structuredClone(state.cards), notice: '导入了一张角色卡。' }; },
    planCharacterCardUpdate: async (id, content) => { ops.push({ op: 'planCharacterCardUpdate', id, content });
      const file = JSON.parse(content); if (file.broken) throw new Error('角色卡格式不对。');
      return { id, expected: 'rev-3', summary: { ...summary(file.name, file.name !== '阿棠'), unchanged: file.same === true, ...(file.voice ? { voice: 'offered', fileVoice: FILE_VOICE } : {}) } } as never; },
    updateCharacterCard: async (id, content, expected, guard, options) => { op(guard, 'updateCharacterCard', { id, content, expected, ...(options ? { options } : {}) });
      const file = JSON.parse(content), card = state.cards.cards.find(item => item.id === id)!; card.name = file.name;
      const voice = file.voice ? (options?.useFileVoice ? 'replaced' : 'offered') : undefined;
      if (voice === 'replaced') (card as { voice?: unknown }).voice = FILE_VOICE;
      return { state: structuredClone(state.cards), summary: { ...summary(file.name, file.name !== '阿棠'), ...(voice ? { voice, fileVoice: FILE_VOICE } : {}) }, notice: '已更新。' } as never; },
    // I-173: the 角色页's own 「她的声音」 save and its delete into the recycle bin.
    saveCharacterVoice: async (id, voice, guard) => { op(guard, 'saveCharacterVoice', { id, voice });
      const card = state.cards.cards.find(item => item.id === id) as { voice?: unknown };
      if (voice === null) delete card.voice; else card.voice = structuredClone(voice); return structuredClone(state.cards); },
    deleteCharacter: async (id, forgetMemories, guard) => { op(guard, 'deleteCharacter', { id, forgetMemories });
      const gone = state.cards.cards.find(item => item.id === id)!; state.cards.cards = state.cards.cards.filter(item => item.id !== id);
      state.recycle.push({ id: DELETED_ENTRY, characterId: id, characterName: gone.name, part: 'character' as never, label: forgetMemories ? '角色和她的记忆' : '角色卡', deletedAt: NOW, expiresAt: NOW + state.recycleDays * 86_400_000 });
      return structuredClone(state.cards); },
    loadModel: async (file, guard) => { op(guard, 'loadModel', { file }); const name = file.split('\\').pop()!.replace(/\.pmx$/, '');
      state.settings.model = { path: file, url: `local://${name}`, name }; return { name }; },
    rendererAction: action => { ops.push({ op: 'rendererAction', action }); return !!state.windows.controls; },
    diagnostics: () => ({ replyLatency: [
      { status: 'complete', firstContentMs: 900, firstVisibleMs: 1_000, firstSentenceVisibleMs: 1_400, streamEndMs: 3_000, allVisibleMs: 3_200, chars: 40, deltas: 12 },
      { status: 'stopped', firstContentMs: 700, firstVisibleMs: null, firstSentenceVisibleMs: null, streamEndMs: null, allVisibleMs: null, chars: 0, deltas: 0 },
      { status: 'complete', firstContentMs: 1_100, firstVisibleMs: 1_150, firstSentenceVisibleMs: 1_600, streamEndMs: 2_500, allVisibleMs: 2_600, chars: 33, deltas: 9 },
    ], petWindow: { enabled: true, entries: 5 } }),
    memory: () => ({ rss: 300 * 1048576, heapUsed: 80 * 1048576 }),
    uptimeSeconds: () => 4_321.4,
    partsOff: () => ['senses/face-check'], // overhaul step 7: one part switched off alone (get_status, get_diagnostics)
    interconnected: () => state.interconnect,
    perception: () => structuredClone(state.perception),
    setPerception: async (kind, enabled, purposes, guard) => { op(guard, 'setPerception', { kind, enabled, purposes: [...purposes] });
      const p = state.perception;
      if (kind === 'system_audio') for (const purpose of purposes) p.systemAudio[purpose] = enabled;
      else if (kind === 'camera') { p.cameraPose = enabled; if (!enabled) p.cameraImages = false; p.camera = !!(p.cameraPose || p.cameraImages); }
      else if (kind === 'camera_images') { p.cameraImages = enabled; p.camera = !!(p.cameraPose || p.cameraImages); }
      else if (kind === 'camera_pose') { p.cameraPose = enabled; p.camera = !!(p.cameraPose || p.cameraImages); }
      else if (kind === 'face_check') p.faceCheck = enabled;
      // The microphone opens only with the local recognizer installed (as the companion's own switch).
      else if (kind === 'microphone') p.microphone = enabled && state.localAsr.phase === 'ready';
      else p[kind] = enabled;
      return null; },
    faceCheckPhase: () => state.faceCheckPhase as never,
    voiceCall: () => state.voiceCall,
    setVoiceCall: async (on, via, guard) => { op(guard, 'setVoiceCall', { on, via }); state.voiceCall = on && state.localAsr.phase === 'ready'; return null; },
    memories,
    songs: { count: async () => state.songs, clear: async () => { ops.push({ op: 'songs.clear' }); const count = state.songs; state.songs = 0;
      return { count, restore: async () => { ops.push({ op: 'songs.restore', count }); state.songs = count; } }; } },
    localAsr: () => structuredClone(state.localAsr) as never,
    downloadLocalAsr: async guard => { op(guard, 'downloadLocalAsr'); state.localAsr.phase = 'downloading'; },
    cancelLocalAsrDownload: async guard => { op(guard, 'cancelLocalAsrDownload'); state.localAsr.phase = 'not-installed'; },
    removeLocalAsr: async guard => { op(guard, 'removeLocalAsr'); state.localAsr.phase = 'not-installed'; },
    hostSettings: () => structuredClone(state.host),
    herState: () => ({ snapshot: { primary: 'happy', values: { D: 70, O: 55, E: 50, N: 20, C: 30 } as never, phase: 'rua', lastInteractionAt: NOW - 25 * 60_000 },
      parameters: { baseline: { D: 50, O: 50, E: 50, N: 25, C: 30 } as never }, fatigue: { phase: 'drowsy' }, herLife: { activity: 'reading' } }),
    now: () => NOW,
    setUiLanguage: async (preference, guard) => { op(guard, 'setUiLanguage', { preference }); state.host.uiLanguage = preference; },
    setDeveloperMode: async (enabled, guard) => { op(guard, 'setDeveloperMode', { enabled }); state.host.developerMode = enabled; },
    setMusic: async (patch, guard) => { op(guard, 'setMusic', { patch }); state.host.music = { ...state.host.music!, ...patch }; },
    setPhysics: async (next, guard) => { op(guard, 'setPhysics', { next }); state.host.physics = structuredClone(next); },
    setProactiveVision: async (enabled, guard) => { op(guard, 'setProactiveVision', { enabled }); state.host.proactiveVision = enabled; },
    setFeedRecognition: async (enabled, guard) => { op(guard, 'setFeedRecognition', { enabled }); state.host.feedRecognition = enabled; },
    setMoodJudge: async (enabled, guard) => { op(guard, 'setMoodJudge', { enabled }); state.host.moodJudge = enabled; },
    setUserActivity: async (enabled, guard) => { op(guard, 'setUserActivity', { enabled }); state.host.userActivity = enabled; },
    setUnboundDefaultPlace: async (keepHere, guard) => { op(guard, 'setUnboundDefaultPlace', { keepHere }); if (keepHere && !state.unboundOut) return false; state.host.unboundDefaultPlace = keepHere ? 'default' : 'none'; return true; },
    downloadPose: async guard => { op(guard, 'downloadPose'); state.host.pose = { ...state.host.pose!, phase: 'downloading' as never }; },
    cancelPoseDownload: async guard => { op(guard, 'cancelPoseDownload'); state.host.pose = { ...state.host.pose!, phase: 'not-installed' as never }; },
    removePose: async guard => { op(guard, 'removePose'); state.host.pose = { ...state.host.pose!, phase: 'not-installed' as never }; },
    recoverPet: async guard => { op(guard, 'recoverPet'); },
    openControlPage: async (page, guard, focus) => { op(guard, 'openControlPage', { page, ...(focus ? { focus } : {}) }); },
    useBundledModel: async guard => { op(guard, 'useBundledModel'); state.settings.model = { path: 'C:\\app\\gene\\gene.pmx', url: 'local://bundled', name: 'Gene（预装）' }; },
    unbindCharacterModel: async (id, guard) => { op(guard, 'unbindCharacterModel', { id }); delete (state.cards.cards.find(item => item.id === id) as { modelName?: string }).modelName; },
    createCharacterForCurrentModel: async guard => { op(guard, 'createCharacterForCurrentModel'); state.cards.cards.push({ id: NEW_CARD, name: state.settings.model!.name, modelName: state.settings.model!.name } as never); return structuredClone(state.cards); },
    modelCapabilities: async () => ({ modelKey: state.settings.model ? 'k'.repeat(64) : null, modelUrl: 'local://gene', profile: state.settings.model ? PROFILE : null,
      record: state.settings.model ? { checkedAt: NOW - 3_600_000, choices: structuredClone(state.capabilityChoices), haiku: {} } as never : null }),
    setModelCapabilityChoice: async (modelKey, id, choice, guard) => { op(guard, 'setModelCapabilityChoice', { modelKey, id, choice });
      if (choice === null) delete state.capabilityChoices[id]; else state.capabilityChoices[id] = choice; },
    previewModelCapability: async (id, guard) => { op(guard, 'previewModelCapability', { id }); return state.windows.pet?.visible ? 'shown' : 'pet-hidden'; },
    playChatAction: async (word, guard) => { op(guard, 'playChatAction', { word });
      return word === 'heart' ? { word, played: false, status: 'cannot', reason: '这个模型没有手指。', missing: ['左手手指', '右手手指'] } as never
        : { word, played: true, status: 'played', reason: '', missing: [] } as never; },
    setReactions: async (enabled, guard) => { op(guard, 'setReactions', { enabled }); state.host.reactions = enabled; },
    setReactionDispositions: async (values, guard) => { op(guard, 'setReactionDispositions', { values });
      const before = state.dispositions ? { ...state.dispositions } : null;
      state.dispositions = values === null ? null : { ...(state.dispositions ?? Object.fromEntries(DISPOSITION_IDS.map(id => [id, 50]))), ...values };
      return { ...dispositionsView(), before } as never; },
    reactionDispositions: () => dispositionsView() as never,
    fishBudget: () => structuredClone(state.fishBudget),
  };
  function dispositionsView() {
    const derived = Object.fromEntries(DISPOSITION_IDS.map(id => [id, 50]));
    return { characterId: state.cards.activeId, values: state.dispositions ?? derived, stored: state.dispositions !== null, derived,
      items: DISPOSITION_IDS.map(id => ({ id, label: DISPOSITIONS[id].label, hint: DISPOSITIONS[id].hint })) };
  }
  // An older host: only what every version has (each feature tool must say it cannot, never act).
  const REQUIRED: (keyof Bridge)[] = ['version', 'settings', 'characters', 'windows', 'activateCharacter', 'bindCurrentModel', 'setPetVisible', 'saveSettings',
    'commitPetBoolean', 'commitReadoutVolume', 'commitBreath', 'importCharacterCard', 'loadModel', 'rendererAction', 'diagnostics', 'memory', 'uptimeSeconds', 'interconnected', 'now'];
  const bridge = tweak === 'old-host' ? Object.fromEntries(REQUIRED.map(key => [key, full[key]])) as unknown as Bridge : full;
  const fs: FileSystemPort = {
    // Looking at a file (its place and stat) is written down too: before the user's words nothing of a file may be looked at (T-239).
    realpath: async file => { ops.push({ op: 'realpath', file }); if (!FILES[file]) throw new Error('ENOENT'); return file; },
    stat: async file => { ops.push({ op: 'stat', file }); const found = FILES[file]; if (!found) throw new Error('ENOENT'); return { isFile: () => true, size: found.size, mtimeMs: found.mtimeMs }; },
  };
  const options: appTools.AppToolOptions = {
    fs, platform: 'win32',
    fileBytes: { readBytes: async file => { ops.push({ op: 'readFile', file }); return Buffer.from(FILES[file]?.text ?? '', 'utf8'); } },
    docs: { list: async () => DOCS.map(doc => doc.spec), read: async id => { const found = DOCS.find(doc => doc.spec.id === id); if (!found) throw new Error('no'); return found.markdown; } },
  };
  return { state, ops, bridge, fs, options };
}

// ---- Samples: for every tool, the calls tried (valid ones for each branch, and invalid ones for the messages). ----

export interface Sample { args: Record<string, unknown>; tweak?: Tweak }
const each = <T>(list: readonly T[], make: (item: T) => Sample) => list.map(make);
function settingSamples(): Sample[] {
  const out: Sample[] = [];
  for (const spec of AGENT_SETTINGS) {
    const values: AgentSettingValue[] = spec.kind === 'number' ? [...new Set([spec.min, spec.max, ...spec.presets.map(p => p.value)])] : spec.choices.map(c => c.value);
    for (const value of values) out.push({ args: { id: spec.id, value } });
  }
  out.push({ args: { id: 'nope', value: true } }, { args: { id: 'voice_rate', value: 'fast' } }, { args: { id: 'voice_rate', value: 100, duration: 'day' } },
    { args: { id: 'realer_emotions', value: true, duration: 'month' } }, { args: { id: 'realer_emotions', value: true, duration: 'year' } },
    { args: { id: 'realer_emotions', value: true }, tweak: 'b-active' },
    { args: { id: 'voice_provider', value: 'fish' }, tweak: 'paid-fish' }, { args: { id: 'voice_provider', value: 'system' }, tweak: 'paid-bailian' },
    { args: { id: 'voice_input', value: true }, tweak: 'asr-installed' }, { args: { id: 'voice_input', value: true }, tweak: 'pet-hidden' },
    { args: { id: 'voice_input', value: false }, tweak: 'senses-on' }, { args: { id: 'voice_call', value: true }, tweak: 'asr-installed' },
    { args: { id: 'voice_call', value: false }, tweak: 'senses-on' },
    { args: { id: 'local_asr', value: 'not-installed' }, tweak: 'asr-installed' }, { args: { id: 'local_asr', value: 'not-installed' }, tweak: 'asr-downloading' },
    { args: { id: 'pose_sensing', value: 'not-installed' }, tweak: 'pose-installed' }, { args: { id: 'pose_sensing', value: 'not-installed' }, tweak: 'pose-downloading' },
    { args: { id: 'unbound_default_place', value: 'default' }, tweak: 'unbound-home' }, { args: { id: 'unbound_default_place', value: 'default' }, tweak: 'unbound-default-set' },
    { args: { id: 'unbound_default_place', value: 'none' }, tweak: 'unbound-default-set' },
    // 2026-11-24: a limit below what is already spent (she switches to the system voice now), and values the control window does not take.
    { args: { id: 'drama3_monthly_limit', value: 5 }, tweak: 'fish-spent' }, { args: { id: 'drama3_monthly_limit', value: 0 }, tweak: 'fish-spent' },
    { args: { id: 'drama3_monthly_limit', value: 2.5 } }, { args: { id: 'drama3_monthly_limit', value: 501 } }, { args: { id: 'drama3_monthly_limit', value: '20' } });
  return out;
}

export function samplesFor(name: string): Sample[] {
  switch (name) {
    case 'get_status': return [{ args: {} }, { args: { x: 1 } }, { args: {}, tweak: 'senses-on' }];
    case 'get_her_state': case 'list_characters': case 'get_diagnostics': case 'list_model_capabilities': case 'list_recycle_bin': return [{ args: {} }];
    // (the spent and unreadable Drama 3 budgets are read in tests/channel-voice-spend.test.ts: a whole settings list here repeats old setting ids)
    case 'list_settings': return [{ args: {} }, { args: {}, tweak: 'asr-downloading' }];
    // 2026-11-24: any character's own provider; a paid one needs the words and the dialog (with its price), a free one is direct and undoable.
    case 'set_character_voice': return [{ args: { id: B, provider: 'fish', voiceId: 'g6_drama' } }, { args: { id: B, provider: 'fish', voiceId: 'g6_drama' }, tweak: 'paid-fish' },
      { args: { id: A, provider: 'bailian' } }, { args: { id: A, provider: 'system' } }, { args: { id: B, provider: 'default' } }, { args: { id: B, provider: 'default' }, tweak: 'paid-fish' },
      { args: { id: A, provider: 'system' }, tweak: 'own-fish' }, { args: { id: A, provider: 'fish' }, tweak: 'fish-spent' },
      { args: { id: A, provider: 'fish', apiKey: 'x' } }, { args: { id: A, provider: 'bailian', apiHost: 'evil.example' } }, { args: { id: A, provider: 'bailian', region: 'intl' } },
      { args: { id: A, provider: 'fish', voiceId: '../x' } }, { args: { id: A, provider: 'default', voiceId: 'x' } }, { args: { id: 'x', provider: 'system' } },
      { args: { id: NEW_CARD, provider: 'system' } }, { args: { id: A, provider: 'loud' } }];
    case 'read_handbook': return [{ args: {} },
      ...each(['window', 'chat', 'characters', 'appearance', 'memory', 'providers', 'agent', 'privacy'], category => ({ args: { category } })),
      { args: { doc: 'guide/voice' } }, { args: { doc: 'guide/voice', section: 1 } }, { args: { doc: 'guide/voice', section: 9 } }, { args: { doc: 'guide/voice', part: 2 } },
      { args: { doc: 'guide/nothing' } }, { args: { doc: '../secret' } }, { args: { find: '朗读 声音' } }, { args: { find: '睡觉' } },
      { args: { doc: 'handbook/features', find: '睡觉' } }, { args: { doc: 'guide/voice', find: '火箭' } },
      { args: { category: 'chat', doc: 'guide/voice' } }, { args: { section: 1 } }, { args: { category: 'kitchen' } }, { args: { find: '' } }];
    case 'activate_character': return [{ args: { id: B } }, { args: { id: A } }, { args: { id: 'nope' } }, { args: { id: NEW_CARD } }];
    case 'set_read_aloud': return [{ args: { state: 'off' } }, { args: { state: 'on' } }, { args: { state: 'loud' } }];
    case 'set_setting': return settingSamples();
    case 'play_preview': return [{ args: { kind: 'surprise' } }, { args: { kind: 'shy' } }, { args: { kind: 'shy' }, tweak: 'controls-hidden' }];
    case 'set_model_capability': return [...MODEL_CAPABILITY_IDS.flatMap(id => [{ args: { id, value: 'on' } }, { args: { id, value: 'off' } }]),
      { args: { id: 'blush', value: 'on' }, tweak: 'no-model' }];
    case 'try_model_capability': return [...each(MODEL_CAPABILITY_IDS, id => ({ args: { id } })), { args: { id: 'blush' }, tweak: 'pet-hidden' }];
    case 'play_her_action': return [...each(CHAT_ACTION_WORDS, action => ({ args: { action } })), { args: { action: 'dance' } }];
    case 'set_reaction_dispositions': return [{ args: { shy: 30, lively: 80 } }, { args: { reset: true } }, { args: { reset: true, shy: 1 } }, { args: {} }, { args: { shy: 101 } }];
    case 'show_pet': case 'recover_pet': case 'use_bundled_model': case 'create_character_for_current_model': case 'clear_song_memory': case 'voice_preview':
      return [{ args: {} }, ...(name === 'voice_preview' ? [{ args: {}, tweak: 'paid-bailian' as Tweak }, { args: {}, tweak: 'paid-fish' as Tweak }, { args: {}, tweak: 'controls-hidden' as Tweak }]
        : name === 'create_character_for_current_model' || name === 'use_bundled_model' ? [{ args: {}, tweak: 'no-model' as Tweak }] : [])];
    case 'open_control_page': return [...each(TAKE_ME_THERE_IDS, page => ({ args: { page } })), { args: { page: 'nowhere' } },
      // I-173: a handbook item (its page and the element to flash), a card's 「更多」, and the refusals.
      { args: { item: 'tts_fish_key' } }, { args: { item: 'character_voice' } }, { args: { item: 'speech_beats' } }, { args: { item: 'network_settings' } },
      { args: { item: 'character_delete', character: B } }, { args: { page: 'delete-character', character: B } }, { args: { item: 'tts_fish_key', page: 'fish-key' } },
      { args: { item: 'ui_navigation' } }, { args: { item: 'nope' } }, { args: { item: 'Bad-Id' } }, { args: { item: 'character_voice', page: 'fish-key' } },
      { args: { page: 'bailian-key', character: B } }, { args: { item: 'character_delete', character: NEW_CARD } }, { args: { item: 'character_delete', character: 'x' } }, { args: {} }];
    case 'set_voice_style': return [{ args: { voice: 'longxiaochun_v2', emotion: 'happy' } }, { args: { provider: 'system' } }, { args: { provider: 'follow' } },
      { args: { provider: 'fish' } }, { args: { voiceId: 'abc_123', actingStyle: '温柔一点' } }, { args: { rate: 1.25, instruction: '  慢慢说  ' } },
      { args: {} }, { args: { rate: 3 } }, { args: { voice: 'a b' } }, { args: { voice: 'longxiaochun_v2' }, tweak: 'no-model' },
      // I-173: her own voice is Drama 3: the id goes into it too (and back with the undo); an empty id leaves hers alone.
      { args: { voiceId: 'her_voice_1' }, tweak: 'own-fish' }, { args: { voiceId: '' }, tweak: 'own-fish' }, { args: { rate: 1.1 }, tweak: 'own-fish' }];
    case 'set_perception': return [
      ...(['camera', 'camera_images', 'camera_pose', 'face_check', 'microphone', 'screen'] as const).flatMap(kind => [{ args: { kind, state: 'on' } }, { args: { kind, state: 'off' }, tweak: 'senses-on' as Tweak }]),
      { args: { kind: 'system_audio', state: 'on' } }, { args: { kind: 'system_audio', state: 'on', purpose: 'movie' } }, { args: { kind: 'system_audio', state: 'off' }, tweak: 'senses-on' },
      { args: { kind: 'screen', state: 'on', purpose: 'music' } }, { args: { kind: 'screen', state: 'on' }, tweak: 'pet-hidden' }, { args: { kind: 'face_check', state: 'on' }, tweak: 'pet-hidden' }];
    case 'import_character_card': return [{ args: { path: 'C:\\cards\\new.json' } }, { args: { path: 'C:\\cards\\big.json' } }, { args: { path: 'C:\\cards\\none.json' } },
      { args: { path: 'C:\\cards\\x.txt' } }, { args: { path: '\\\\server\\share\\a.json' } }];
    case 'update_character_card': return [{ args: { id: A, path: 'C:\\cards\\update.json' } }, { args: { id: A, path: 'C:\\cards\\renamed.json' } },
      { args: { id: A, path: 'C:\\cards\\same.json' } }, { args: { id: NEW_CARD, path: 'C:\\cards\\update.json' } },
      // I-173: the file's voice only with useFileVoice (the user's words), shown in the second dialog.
      { args: { id: A, path: 'C:\\cards\\voice.json' } }, { args: { id: A, path: 'C:\\cards\\voice.json', useFileVoice: true } },
      { args: { id: A, path: 'C:\\cards\\update.json', useFileVoice: true } }, { args: { id: A, path: 'C:\\cards\\voice.json', useFileVoice: false } }];
    case 'load_model': return [{ args: { path: OTHER_MODEL } }, { args: { path: 'C:\\models\\none.pmx' } }, { args: { path: 'C:\\models\\a.vrm' } }];
    case 'bind_current_model_to_character': return [{ args: { id: B } }, { args: { id: B }, tweak: 'no-model' }];
    case 'unbind_character_model': return [{ args: { id: A } }, { args: { id: B } }];
    case 'delete_memories': return [{ args: { id: A, parts: ['chat'] } }, { args: { id: A, parts: ['chat', 'profile'] } }, { args: { id: A, parts: ['chat', 'chat'] } }, { args: { id: A, parts: [] } }];
    // I-173: into the recycle bin; never the active card; her memories only when asked.
    case 'delete_character': return [{ args: { id: B } }, { args: { id: B, forgetMemories: true } }, { args: { id: A } }, { args: { id: B }, tweak: 'b-active' },
      { args: { id: NEW_CARD } }, { args: { id: B, forgetMemories: 'yes' } }, { args: { id: 'x' } }];
    case 'restore_memories': return [{ args: { entryId: ENTRY } }, { args: { entryId: OTHER_ENTRY } }, { args: { entryId: 'x' } }];
    default: return [{ args: {} }];
  }
}

// ---- Modes: how the user's Claude (or her chat, or the Claude 助手) reaches the registry. ----

interface Mode { interconnect: boolean; words: boolean; answer: boolean; assistant?: boolean; via?: 'chat' }
export const MODES: Record<string, Mode> = {
  'interconnect+words': { interconnect: true, words: true, answer: true },
  'interconnect, no words': { interconnect: true, words: false, answer: true },
  'interconnect+words, dialog declined': { interconnect: true, words: true, answer: false },
  'interconnect off, dialog allowed': { interconnect: false, words: false, answer: true },
  'interconnect off, dialog declined': { interconnect: false, words: false, answer: false },
  'assistant (always a dialog)': { interconnect: true, words: true, answer: true, assistant: true },
  'her chat card': { interconnect: false, words: false, answer: true, via: 'chat' },
};
/** Modes tried for a sample: all of them on the plain world (her chat only for set_setting); the two main ones on a variant. */
function modesFor(name: string, sample: Sample): string[] {
  if (sample.tweak) return ['interconnect+words', 'interconnect off, dialog allowed'];
  return Object.keys(MODES).filter(mode => mode !== 'her chat card' || name === 'set_setting');
}

const plain = (value: unknown) => JSON.parse(JSON.stringify(value ?? null));

export async function runCall(name: string, sample: Sample, modeName: string): Promise<Record<string, unknown>> {
  const mode = MODES[modeName];
  const world = makeWorld(sample.tweak);
  world.state.interconnect = mode.interconnect;
  const tools = appTools.createAppTools(world.bridge, { ...world.options, ...(mode.via ? { settingVia: mode.via } : {}) });
  const asked: unknown[] = [], notices: unknown[] = [], informs: unknown[] = [], words: unknown[] = [], audit: unknown[] = [];
  let undo: AgentUndoOffer | undefined;
  const registry = new AgentToolRegistry(tools, {
    enabled: () => true, interconnect: () => mode.interconnect, ...(mode.assistant ? { alwaysConfirm: true } : {}),
    confirm: async request => { asked.push({ title: request.title, detail: request.detail, ...(request.buttons ? { buttons: request.buttons } : {}), toolTitle: request.toolTitle }); return mode.answer; },
    notice: (tool, title, detail) => notices.push({ tool, title, ...(detail ? { detail } : {}) }),
    inform: text => informs.push(text), wordsUsed: use => words.push(use),
    audit: entry => { const { at: _at, ms: _ms, ...rest } = entry; audit.push(rest); },
    called: (_summary, offer) => { undo = offer; },
    now: () => 0, confirmTimeoutMs: 10_000, runTimeoutMs: 10_000,
  });
  const result = await registry.call(name, mode.words ? { ...sample.args, userWords: WORDS } : sample.args);
  const out: Record<string, unknown> = { result: plain(result) };
  if (asked.length) out.dialogs = asked;
  if (notices.length) out.notices = notices;
  if (informs.length) out.informs = plain(informs);
  if (words.length) out.wordsUsed = plain(words);
  out.audit = plain(audit);
  out.ops = plain(world.ops);
  if (undo) {
    const before = world.ops.length;
    let undone: unknown;
    try { await undo.run(() => {}); undone = 'ok'; } catch (error) { undone = { error: (error as Error).message }; }
    out.undo = { label: undo.label, result: undone, ops: plain(world.ops.slice(before)) };
  }
  return out;
}

/** Every tool, every sample, every mode: the behaviour golden (tool → "args [variant]" → mode → record). */
export async function behaviourGolden(): Promise<Record<string, Record<string, Record<string, unknown>>>> {
  const out: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const definition of appTools.createAppTools(makeWorld().bridge, makeWorld().options)) {
    const name = definition.name, rows: Record<string, Record<string, unknown>> = {};
    for (const sample of samplesFor(name)) {
      const key = `${JSON.stringify(sample.args)}${sample.tweak ? ` [${sample.tweak}]` : ''}`;
      const runs: Record<string, unknown> = {};
      // A run that answered exactly like an earlier mode of the same sample is written as "= that mode" (read tools mostly).
      const seen = new Map<string, string>();
      for (const mode of modesFor(name, sample)) {
        const record = await runCall(name, sample, mode), text = JSON.stringify(record);
        runs[mode] = seen.has(text) ? `= ${seen.get(text)}` : record;
        if (!seen.has(text)) seen.set(text, mode);
      }
      rows[key] = runs;
    }
    // An older host: every tool once, with the user's words (what it says when the version cannot do it).
    rows['{} [old-host]'] = { 'interconnect+words': await runCall(name, { args: samplesFor(name)[0].args, tweak: 'old-host' }, 'interconnect+words') };
    out[name] = rows;
  }
  return out;
}

/** Each definition as the registry sees it: name, title, tier, the flags and which hooks it has, in the list's order. */
export function definitionsGolden(): unknown[] {
  const world = makeWorld();
  return appTools.createAppTools(world.bridge, world.options).map((definition: AgentToolDefinition) => {
    const record = definition as unknown as Record<string, unknown>;
    const flags = Object.fromEntries(['interconnectOnly', 'alwaysConfirm', 'touchesFiles'].filter(key => key in record).map(key => [key, record[key]]));
    const hooks = Object.keys(record).filter(key => typeof record[key] === 'function').sort();
    return { name: definition.name, title: definition.title, tier: definition.tier, ...flags, hooks };
  });
}

/** Which tools exist with 三方互通 on and off, and each one's tier there (registry names() and tierOf()). */
export function exposureGolden(): unknown {
  const out: Record<string, unknown> = {};
  for (const interconnect of [true, false]) {
    const world = makeWorld();
    const registry = new AgentToolRegistry(appTools.createAppTools(world.bridge, world.options), { enabled: () => true, interconnect: () => interconnect, confirm: async () => false });
    out[interconnect ? 'interconnect on' : 'interconnect off'] = Object.fromEntries(registry.names().map(name => [name, registry.tierOf(name)]));
  }
  return out;
}

/** The fixed catalog the user's Claude reads (tool names, titles, tiers, descriptions, input schemas), the settings and what is never exposed. */
export function catalogGolden(): unknown {
  return plain({ server: AGENT_SERVER_INFO, tools: AGENT_TOOLS, settings: AGENT_SETTINGS, neverExposed: AGENT_NEVER_EXPOSED,
    alwaysDialogTools: AGENT_ALWAYS_DIALOG_TOOLS, tierLabels: AGENT_TIER_LABELS });
}

const attempt = (work: () => unknown) => { try { return plain(work()); } catch (error) { return { throws: (error as Error).message }; } };

/** The module's exported helpers on fixed inputs, and its exported texts and numbers. */
export function helpersGolden(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  out.runtimeExports = Object.keys(appTools).sort();
  out.constants = { ASR_MODEL_BYTES: appTools.ASR_MODEL_BYTES, VOICE_INPUT_ON_TEXT: appTools.VOICE_INPUT_ON_TEXT, VOICE_CALL_ON_TEXT: appTools.VOICE_CALL_ON_TEXT,
    FACE_CHECK_CONSENT: appTools.FACE_CHECK_CONSENT };
  const worlds: Tweak[] = ['asr-installed', 'asr-downloading', 'pose-installed', 'pose-downloading', 'b-active', 'paid-fish'];
  const extrasOf = (tweak?: Tweak) => appTools.settingExtras(makeWorld(tweak).bridge);
  out.settingExtras = Object.fromEntries([undefined, ...worlds].map(tweak => [tweak ?? 'plain', plain(extrasOf(tweak))]));
  out.settingExtrasFailing = plain(appTools.settingExtras({ memories: { days: () => { throw new Error('x'); } } as never, perception: () => { throw new Error('x'); },
    localAsr: () => { throw new Error('x'); }, hostSettings: () => { throw new Error('x'); }, voiceCall: () => { throw new Error('x'); } }));
  out.settingViews = Object.fromEntries([undefined, ...worlds].map(tweak => { const w = makeWorld(tweak);
    return [tweak ?? 'plain', plain(appTools.settingViews(w.bridge.settings(), w.bridge.characters(), extrasOf(tweak)).map(view => ({ id: view.id, value: view.value })))]; }));
  out.settingViewsBare = plain(appTools.settingViews(structuredClone(DEFAULT_SETTINGS) as AppSettings));
  const details: Record<string, unknown> = {}, consent: Record<string, unknown> = {};
  for (const spec of AGENT_SETTINGS) {
    const values: AgentSettingValue[] = spec.kind === 'number' ? [spec.min, spec.max] : spec.choices.map(c => c.value);
    for (const value of values) {
      for (const tweak of [undefined, 'asr-downloading', 'pose-downloading'] as (Tweak | undefined)[]) {
        const text = appTools.settingDetail(spec.id, value, extrasOf(tweak));
        if (text !== undefined) details[`${spec.id}=${JSON.stringify(value)}${tweak ? ` [${tweak}]` : ''}`] = text;
      }
      consent[`${spec.id}=${JSON.stringify(value)}`] = { agent: appTools.settingNeedsConsent(spec as AgentSettingSpec, value, 'agent'), chat: appTools.settingNeedsConsent(spec as AgentSettingSpec, value, 'chat') };
    }
  }
  out.settingDetail = details;
  out.settingDetailWithoutExtras = Object.fromEntries(['local_asr', 'pose_sensing'].map(id => [id, appTools.settingDetail(id as never, 'installed')]));
  out.settingNeedsConsent = consent;
  out.voiceStyleArgs = Object.fromEntries([{ provider: 'follow' }, { provider: 'system' }, { provider: 'bailian' }, { provider: 'x' }, { voiceId: '' }, { voiceId: 'a'.repeat(129) },
    { actingStyle: '很'.repeat(200) }, { actingStyle: ' 轻声 ' }, { model: 'qwen-tts' }, { model: '../x' }, { emotion: 'sad' }, { emotion: 'angry!' },
    { instruction: 'a\u0001b' }, { instruction: 'x'.repeat(1001) }, { rate: 0.5 }, { rate: 1.234 }, { rate: 2.01 }, {}, { other: 1 }, 'text', null]
    .map(raw => [JSON.stringify(raw), attempt(() => appTools.voiceStyleArgs(raw))]));
  const styleWorld = makeWorld();
  const s = styleWorld.bridge.settings();
  out.voiceStyleOf = { active: plain(appTools.voiceStyleOf(s, A)), noCharacter: plain(appTools.voiceStyleOf(s, '')) };
  out.withVoiceStyle = Object.fromEntries([{ voice: 'v2' }, { voiceId: 'fish1', actingStyle: '轻' }, { actingStyle: '' }, { provider: 'system' as const }, { rate: 1.5, emotion: 'sad' as never }]
    .map(patch => [JSON.stringify(patch), { character: diff(s.tts, appTools.withVoiceStyle(s, A, patch).tts), global: diff(s.tts, appTools.withVoiceStyle(s, '', patch).tts) }]));
  const cards = makeWorld().bridge.characters();
  out.realerEmotions = {
    confirmation: plain(appTools.realerEmotionsConfirmation(cards)), confirmationNoCards: plain(appTools.realerEmotionsConfirmation(null)),
    confirmationFor: Object.fromEntries(REALER_DURATIONS.map(d => [d, plain(appTools.realerEmotionsConfirmationFor('小雨', d))])),
    confirmationForUnnamed: plain(appTools.realerEmotionsConfirmationFor(null)),
    information: plain(appTools.realerEmotionsInformation(cards)), informationNamed: plain(appTools.realerEmotionsInformation(null, '小雨', 'forever')),
  };
  const phases = ['unsupported', 'not-installed', 'downloading', 'installing', 'idle', 'ready'];
  out.componentValue = Object.fromEntries([...phases.map(phase => [phase, appTools.componentValue({ phase })]), ['null', appTools.componentValue(null)]]);
  out.localAsrValue = Object.fromEntries([...phases.map(phase => [phase, appTools.localAsrValue({ phase } as never)]), ['null', appTools.localAsrValue(null)]]);
  out.localAsrDownloadText = [null, { downloadBytes: 0 }, { downloadBytes: 251_000_000 }, { downloadBytes: 300_000_000 }].map(view => appTools.localAsrDownloadText(view as never));
  out.poseDownloadText = [null, { downloadBytes: 0 }, { downloadBytes: 172_000_000 }].map(view => appTools.poseDownloadText(view as never));
  out.handbookRequest = Object.fromEntries([undefined, {}, { category: 'chat' }, { category: 'x' }, { doc: 'guide/voice' }, { doc: 'guide/voice', section: 2, part: 3 },
    { doc: 'C:\\a.md' }, { doc: 'guide/voice', find: ' 朗读 ' }, { doc: 'guide/voice', find: 'x', section: 1 }, { find: '睡' }, { find: 'x'.repeat(101) },
    { section: 1 }, { doc: 'guide/voice', section: -1 }, { doc: 'guide/voice', part: 0 }, { doc: 'guide/voice', section: 1.5 }, { category: 'chat', find: 'x' }, { other: 1 }]
    .map(raw => [JSON.stringify(raw) ?? 'undefined', attempt(() => appTools.handbookRequest(raw))]));
  return out;
}
