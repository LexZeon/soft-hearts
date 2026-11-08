// I-025 漏项检查: the control window as the app builds it (src/ui/layout.ts renderControls plus every panel src/main.ts mounts
// in it), with a fake host. Bundled by esbuild and run in headless Edge/Chromium by tests/capability-coverage.test.mjs; no
// Electron, no profile, no network. Each panel gets data that shows its fullest state (one item in each list), so the scan
// sees the controls a user can reach. Nothing here reads the source text of src/main.ts.
import { renderControls } from '../../src/ui/layout';
import { setUiLanguage } from '../../src/ui/ui-language';
import { SingleEmojiControls } from '../../src/ui/SingleEmojiControls';
import { CharacterStickerControls } from '../../src/ui/CharacterStickerControls';
import { FeedRecognitionPanel } from '../../src/ui/FeedRecognitionPanel';
import { MoodJudgePanel } from '../../src/ui/MoodJudgePanel';
import { ReactionDispositionsPanel, ReactionsPanel } from '../../src/ui/ReactionsPanel';
import { UserActivityPanel } from '../../src/ui/UserActivityPanel';
import { JournalPanel } from '../../src/ui/JournalPanel';
import { AgentChannelPanel } from '../../src/ui/AgentChannelPanel';
import { LocalAsrPanel } from '../../src/ui/LocalAsrPanel';
import { PoseSensingPanel } from '../../src/ui/PoseSensingPanel';
import { ChatAvailabilityNotice } from '../../src/ui/ChatAvailabilityNotice';
import { UserProfilePanel } from '../../src/ui/UserProfilePanel';
import { TextMemorialPanel } from '../../src/ui/TextMemorialPanel';
import { MemoryPanel } from '../../src/ui/MemoryPanel';
import { ListenTogetherPanel } from '../../src/ui/ListenTogetherPanel';
import { AmbientTranscriptHistory } from '../../src/ui/AmbientTranscriptHistory';
import { EmotionalVoiceControls } from '../../src/ui/EmotionalVoice';
import { CodexTasks } from '../../src/ui/CodexTasks';
import { MotionLibraryControls } from '../../src/ui/MotionLibrary';
import { ScreenSharingOptions } from '../../src/ui/ScreenSharingOptions';
import { CharacterCards } from '../../src/ui/CharacterCards';
import { CharacterPage } from '../../src/ui/CharacterPage';
import { BlushCalibrationControls } from '../../src/ui/BlushCalibrationControls';
import { ModelCapabilityPanel } from '../../src/ui/ModelCapabilityPanel';
import { deriveModelCapabilities } from '../../shared/model-capability';
import { DEFAULT_SETTINGS } from '../../shared/defaults';
import { DEFAULT_TTS_CONFIG } from '../../shared/tts';
import { defaultCharacterMoodTemplate, type CharacterCardState } from '../../shared/character-cards';
import type { ControlDescriptor } from '../../shared/capability-controls';

const ID = '11111111-2222-4333-8444-555555555555';
const SECOND = '22222222-3333-4444-8555-666666666666';
const card = (id: string, name: string) => ({ id, name, description: '安静', personality: '温柔', scenario: '', greeting: '你好', examples: '',
  systemPrompt: '', mood: defaultCharacterMoodTemplate(), modelName: 'Gene' });
export const CARD_STATE: CharacterCardState = { cards: [card(ID, '菲菲'), card(SECOND, '小雨')], activeId: ID, revision: 1 };

/** Never settles: a panel that waits on it keeps its first (loading) state; the controls it builds up front still count. */
const pending = <T>() => new Promise<T>(() => {});
const settings = () => ({ ...structuredClone(DEFAULT_SETTINGS), tts: structuredClone(DEFAULT_TTS_CONFIG) });

const rosterEntry = (id: string, name: string, active: boolean) => ({ id, name, tagline: '温柔', active, preset: false,
  model: { state: 'ok' as const, name: 'Gene' }, avatar: { kind: 'initial' as const, dataUrl: null, initial: name[0] }, knownDay: 3, lastChatAt: 1 });
const ENTRY = '33333333-4444-4555-8666-777777777777';
/** Fixtures that show each list with one item (and the panel in its fullest state). */
export const FIXTURES = {
  roster: { entries: [rosterEntry(ID, '菲菲', true), rosterEntry(SECOND, '小雨', false)], activeId: ID, revision: 1, pendingSwitchId: null },
  memories: { records: [{ id: 'm1', title: '一起看雨', tags: ['日常'], category: '日常', createdAt: 1, updatedAt: 2, weight: 20, messageCount: 2, turnCount: 1, sealed: true }],
    total: 1, offset: 0, limit: 20, tags: ['日常'] },
  profile: { scopeId: 'A', generation: 1, revision: 1, enabled: true,
    entries: [{ id: 'one', kind: 'fact', text: '喜欢下雨天', manual: true, source: { requestId: 'r', messageId: 'm', quote: '我喜欢下雨天' }, createdAt: 1, updatedAt: 1 }],
    diary: [{ date: '2026-11-03', text: '今天他说喜欢下雨天。', writtenAt: 1 }] },
  memorials: { scopeId: 'A', generation: 1, revision: 1, entries: [{ id: 'mm1', text: '第一次一起看雨', purpose: '纪念', createdAt: 1, updatedAt: 1 }] },
  memoryRecord: { id: 'm1', title: '一起看雨', tags: ['日常'], category: '日常', createdAt: 1, updatedAt: 2, weight: 20, messageCount: 1, turnCount: 1, sealed: true,
    messageOffset: 0, messages: [{ id: 'u1', turnId: 't', role: 'user', content: '下雨了', createdAt: 1, updatedAt: 1, status: 'complete', contentOffset: 0, totalCharacters: 3 }] },
  transcript: { id: 't1', sessionId: 's1', mode: 'music', startedAt: 1, endedAt: 2, language: { status: 'unknown', source: 'provider' }, source: 'system-audio',
    title: '一段歌声', tags: ['音乐'], createdAt: 1, text: '啦啦' },
  task: { task: { id: 'task-1', title: '整理笔记', workingDirectory: 'C:\notes', mode: 'read', createdAt: 1, updatedAt: 2, status: 'idle' },
    messages: [{ role: 'user', text: '整理笔记' }, { role: 'assistant', text: '好的' }] },
  capabilities: { authenticated: true, login: 'other', computerControl: false, reason: '', enabled: true },
  modelCapabilities: { modelKey: 'a'.repeat(64), targetKey: 'a'.repeat(64), card: deriveModelCapabilities(null), record: null, checking: false, loaded: true,
    waitingForReload: false, adaptation: null },
  journal: { enabled: true, entries: [], characters: [{ id: ID, name: '菲菲' }], failure: false, truncatedToday: false },
  agentChannel: { enabled: true, listening: true, connections: 1,
    lastAction: { tool: 'set_setting', title: '调整设置', tier: 'reversible', outcome: 'allowed', at: 1, undo: { id: 'u1', label: '把「朗读音量」改回 80%', expiresAt: 4102444800000 } },
    setup: { claudeCode: 'claude mcp add …', desktopConfig: '{}' },
    interconnect: { enabled: true, explicit: false, recycleDays: 7, claudeCode: { state: 'removed', name: 'soft-hearts-next-dev', message: '已被删除' },
      recycleBin: [{ id: ENTRY, characterId: ID, characterName: '菲菲', part: 'chat', count: 3, label: '聊天记忆 3 段', deletedAt: 1, expiresAt: 4102444800000 }] } },
  listen: { raw: { segments: 2, characters: 40, oldestAt: 1 }, total: 1,
    notes: [{ id: 'n1', kind: 'music', startedAt: 1, endedAt: 2, local: true, talked: false, what: '歌', gist: '一首慢歌', mood: '安静', points: [] }] },
  transcripts: { records: [{ id: 't1', sessionId: 's1', mode: 'music', startedAt: 1, endedAt: 2, language: { status: 'unknown', source: 'provider' },
    source: 'system-audio', title: '一段歌声', tags: ['音乐'], createdAt: 1, excerpt: '啦啦', totalCharacters: 2 }], total: 1, offset: 0, limit: 20, tags: ['音乐'] },
  tasks: [{ id: 'task-1', title: '整理笔记', workingDirectory: 'C:\\notes', mode: 'read', createdAt: 1, updatedAt: 2, status: 'idle' }],
  outage: { state: 'unavailable', kind: 'network', since: 1, checking: false },
  feed: { enabled: false },
  moodJudge: { enabled: false, cap: 200 },
  reactions: { enabled: true, chosen: false, defaultEnabled: true, today: 3, cap: 140, base: 120, perChat: 2, max: 800 },
  reactionDispositions: { characterId: ID, values: { shy: 50, clingy: 50, lively: 50, soothable: 50, volatile: 50, restrained: 50 }, stored: false,
    derived: { shy: 50, clingy: 50, lively: 50, soothable: 50, volatile: 50, restrained: 50 },
    items: [{ id: 'shy', label: '害羞', hint: '' }, { id: 'clingy', label: '黏人', hint: '' }, { id: 'lively', label: '活泼', hint: '' },
      { id: 'soothable', label: '好哄', hint: '' }, { id: 'volatile', label: '情绪起伏', hint: '' }, { id: 'restrained', label: '克制', hint: '' }] },
  userActivity: { enabled: true },
};

/** Answers for the host calls the panels make while mounting. Anything not listed never settles. */
const answers: Record<string, () => unknown> = {
  getSettings: settings,
  getCharacterCards: () => structuredClone(CARD_STATE),
  getCharacterRoster: () => structuredClone(FIXTURES.roster),
  getUserProfile: () => structuredClone(FIXTURES.profile),
  getRelationshipNickname: () => '小笨蛋',
  listCodexTasks: () => structuredClone(FIXTURES.tasks),
  readCodexTask: () => structuredClone(FIXTURES.task),
  codexTaskCapabilities: () => structuredClone(FIXTURES.capabilities),
  getTextMemorials: () => structuredClone(FIXTURES.memorials),
  getMotionLibrary: () => ({ directory: 'motions', packs: [{ id: 'gene', installedMotionIds: [], complete: true, bundled: true },
    { id: '100style-idles', installedMotionIds: [], complete: false }, { id: 'fnoji-dances', installedMotionIds: [], complete: false }] }),
};
const answer = <T>(value: T) => () => Promise.resolve(structuredClone(value));

/** The preload API as far as the mounted panels use it: `on*` subscribe (and never fire), the rest answer or wait. */
export const fakeDesktop: Record<string, unknown> = new Proxy({}, {
  get: (_target, name) => {
    if (typeof name !== 'string') return undefined;
    if (/^on[A-Z]/.test(name)) return () => () => {};
    const answer = answers[name];
    return (..._args: unknown[]) => answer ? Promise.resolve(answer()) : pending();
  },
});

const $ = (id: string) => { const found = document.getElementById(id); if (!found) throw new Error(`#${id} is missing`); return found; };
const error = (message: string) => { (window as any).harnessErrors.push(message); };

/**
 * Empty containers the layout leaves for something to fill in later. Each must get its panel here, so a panel added to the
 * layout (and mounted by src/main.ts) cannot stay out of the scan. The ones listed are filled by chat, not by a panel.
 */
export const NOT_PANELS: readonly string[] = Object.freeze(['attachments', 'voice-action-slot', 'stage', 'toast', 'screen-sources', 'notice-detail-text']);
const placeholders = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('div[id], section[id], pre[id]')]
  .filter(node => !node.childElementCount && !node.textContent?.trim()).map(node => node.id);

export interface MountedControlWindow { mounted: string[]; placeholders: string[]; unfilled: string[] }

export async function mountControlWindow(app: HTMLElement): Promise<MountedControlWindow> {
  (window as any).harnessErrors = [];
  (window as any).desktop = fakeDesktop;
  setUiLanguage('zh-CN');
  renderControls(app);
  const empty = placeholders(app);
  const mounted: string[] = [];
  // A panel's init may wait on a host answer that never comes (pending); what it built up to then is what is scanned.
  const settle = (value: unknown) => Promise.race([Promise.resolve(value), new Promise(resolve => setTimeout(resolve, 150))]);
  const mount = async (name: string, work: () => unknown) => {
    try { await settle(work()); mounted.push(name); }
    catch (problem) { error(`${name}: ${problem instanceof Error ? problem.stack ?? problem.message : String(problem)}`); }
  };
  await mount('single-emoji', () => new SingleEmojiControls($('single-emoji-controls'), { get: pending, save: pending, preview: pending, changed: () => () => {} } as any));
  await mount('character-stickers', () => new CharacterStickerControls($('single-emoji-controls'), new Proxy({}, { get: (_t, n) => n === 'changed' ? () => () => {} : pending }) as any));
  await mount('feed-recognition', () => new FeedRecognitionPanel($('feed-recognition'), { get: answer(FIXTURES.feed) as any, set: pending, changed: () => () => {}, error }));
  await mount('user-activity', () => new UserActivityPanel($('user-activity'), { get: answer(FIXTURES.userActivity) as any, set: pending, changed: () => () => {}, error }));
  await mount('mood-judge', () => new MoodJudgePanel($('mood-judge'), { get: answer(FIXTURES.moodJudge) as any, set: pending, changed: () => () => {}, error }));
  await mount('reactions', () => new ReactionsPanel($('reactions'), { get: answer(FIXTURES.reactions) as any, set: pending, changed: () => () => {}, error }));
  await mount('reaction-dispositions', () => new ReactionDispositionsPanel($('reaction-dispositions'), { get: answer(FIXTURES.reactionDispositions) as any, set: pending, changed: () => () => {}, error }));
  await mount('journal', () => new JournalPanel($('experience-journal'), { get: answer(FIXTURES.journal) as any, setEnabled: pending, changed: () => () => {}, error }));
  await mount('agent-channel', () => new AgentChannelPanel($('agent-channel'), { get: answer(FIXTURES.agentChannel) as any, setEnabled: pending, changed: () => () => {}, copy: pending, error,
    setInterconnect: pending, relink: pending, undo: pending, restore: pending, setRecycleDays: pending }));
  await mount('local-asr', () => new LocalAsrPanel($('local-asr'), { get: pending, changed: () => () => {}, download: pending, cancel: pending, dismiss: pending,
    importFiles: pending, remove: pending, reveal: () => {}, error }));
  await mount('pose-sensing', () => new PoseSensingPanel($('pose-sensing'), { get: pending, changed: () => () => {}, download: pending, cancel: pending, dismiss: pending,
    importFiles: pending, remove: pending, redetect: pending, diagnostics: pending, reveal: () => {}, error }, $('runtime-camera').closest('label')));
  await mount('chat-availability', () => new ChatAvailabilityNotice($('chat-availability'), { get: answer(FIXTURES.outage) as any, changed: () => () => {}, retry: pending, help: pending,
    networkSettings: pending, error }));
  await mount('user-profile', () => {
    const panel = new UserProfilePanel($('user-profile-panel'), $('user-profile-toggle') as HTMLButtonElement, fakeDesktop as any, error);
    panel.setMemorials(new TextMemorialPanel(fakeDesktop as any, () => {}));
    panel.open();
  });
  await mount('memory', () => new MemoryPanel($('memory-panel'), { list: answer(FIXTURES.memories), read: answer(FIXTURES.memoryRecord), edit: pending, remove: pending, note: pending, removeNote: pending,
    config: pending, configure: pending, error } as any).refresh());
  await mount('listen-together', () => {
    const section = document.createElement('section'); section.id = 'listen-together-panel'; $('memory-panel').append(section);
    return new ListenTogetherPanel(section, { view: answer(FIXTURES.listen), clearRaw: pending, deleteNote: pending, onError: error, confirm: () => false } as any).init();
  });
  await mount('ambient-history', () => {
    const section = document.createElement('section'); section.id = 'ambient-transcript-history'; $('memory-panel').append(section);
    return new AmbientTranscriptHistory(section, { list: answer(FIXTURES.transcripts), read: answer(FIXTURES.transcript), comments: answer([]), remove: pending, onError: error } as any).init();
  });
  await mount('emotional-voice', () => new EmotionalVoiceControls($('emotional-voice'), {
    getConfig: () => structuredClone(DEFAULT_TTS_CONFIG), getContextKey: () => 'c', getContextLabel: () => '菲菲 · Gene 的专属语音风格',
    onChange: pending, onPreview: pending, onCharacterPreview: pending, onStop: () => {}, onOpenConsole: pending, onOpenGuide: pending,
    onFirstUse: () => {}, onError: error } as any));
  await mount('codex-tasks', () => new CodexTasks($('codex-tasks'), { api: fakeDesktop as any, getSettings: settings as any, beforeStart: pending,
    onDirectorySelected: () => {}, onError: error, onOpen: () => {} }).init());
  await mount('motion-library', () => new MotionLibraryControls($('motion-library'), { getModel: () => null, getSettings: settings as any,
    beforeInstall: pending, onPreview: pending, onStopPreview: pending, onClearLayer: pending, onEnabled: pending, onError: error } as any).init());
  await mount('screen-sharing', () => {
    const mountPoint = document.createElement('div'); mountPoint.className = 'control-sharing-options'; mountPoint.dataset.moodUi = 'true';
    $('runtime-screen').closest('.settings-section')!.append(mountPoint);
    return new ScreenSharingOptions(mountPoint, () => {});
  });
  await mount('character-cards', () => new CharacterCards($('character-cards'), { onError: error, onState: () => {}, expressionSupport: () => null,
    onVisualPreview: pending, onExpressionPreview: pending, onBodyPreview: pending, onDelete: () => {}, onCreated: () => {} }).init());
  await mount('character-page', () => new CharacterPage($('character-page'), { api: fakeDesktop as any, onError: error, onNotice: () => {}, onState: () => {},
    onEdit: () => {}, onTune: () => {}, onBlank: () => {}, capture: pending, modelUrl: () => '' }).init());
  await mount('blush-calibration', () => {
    const container = document.createElement('div'); $('character-cards').after(container);
    return new BlushCalibrationControls(container, { onApply: pending, onPreview: pending, onError: error });
  });
  await mount('model-capabilities', () => { // I-024 这个模型能做什么 (between the editor and the blush calibration, as src/main.ts)
    const container = document.createElement('div'); $('character-cards').after(container);
    new ModelCapabilityPanel(container, { preview: pending, setChoice: pending, onError: error }).update(FIXTURES.modelCapabilities);
  });
  // Open what a user opens to reach the per-item controls: one memory, one transcript, one task.
  for (const selector of ['#memory-list [data-record-id]', '#ambient-transcript-list [data-record-id]'])
    document.querySelector<HTMLElement>(selector)?.click();
  await new Promise(resolve => setTimeout(resolve, 150));
  const still = new Set(placeholders(app));
  return { mounted, placeholders: empty, unfilled: empty.filter(id => still.has(id) && !NOT_PANELS.includes(id)) };
}

const LABEL_LIMIT = 80;
/** Every interactive element of the control window, read the way a person finds it (shared/capability-controls.ts). */
export function collectControls(root: ParentNode = document): ControlDescriptor[] {
  const nodes = root.querySelectorAll<HTMLElement>('button, input, select, textarea, summary, a[href], [role=switch], [role=button], [contenteditable="true"]');
  return [...nodes].map(node => {
    const within: string[] = [];
    for (let parent = node.parentElement; parent; parent = parent.parentElement) if (parent.id) within.push(parent.id);
    const data: Record<string, string> = {};
    for (const attribute of [...node.attributes]) if (attribute.name.startsWith('data-')) data[attribute.name.slice(5)] = attribute.value;
    const text = node.getAttribute('aria-label') || node.textContent || node.getAttribute('placeholder') || node.getAttribute('title')
      || node.closest('label')?.textContent || '';
    return { tag: node.tagName.toLowerCase(), type: (node as HTMLInputElement).type ?? '', id: node.id, data, within,
      label: text.replace(/\s+/gu, ' ').trim().slice(0, LABEL_LIMIT) };
  });
}

/** I-025's deliberate omission: a switch nobody put in the capability list, as a new feature would arrive. */
export function plantUnregisteredControl(): void {
  const label = document.createElement('label'); label.className = 'toggle-row';
  const input = document.createElement('input'); input.id = 'planted-unregistered-switch'; input.type = 'checkbox'; input.setAttribute('role', 'switch');
  label.append('一个没登记的新开关', input);
  $('privacy-window').append(label);
}

Object.assign(window as any, { mountControlWindow, collectControls, plantUnregisteredControl });
