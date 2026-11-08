// I-025 第 3 段: the rest of the settings window through the channel and her chat, each through the host operation its own
// control already calls (the real createHostBridge over fake IPC handlers, as the control window's main frame), plus privacy,
// money and deletion moved to "需要用户原话". Fake handlers only: no window, no profile, no download.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import type { AppSettings } from '../shared/contracts';
import { AGENT_SETTINGS, AGENT_TOOLS } from '../shared/agent-channel';
import { CAPABILITIES, capabilityChannel, capabilityGap } from '../shared/capabilities';
import { AgentToolRegistry, type AgentConfirmRequest } from '../electron/agent-channel/registry';
import { createAppTools } from '../electron/agent-channel/app-tools';
import { AGENT_HOST_OPERATIONS, createHostBridge, type IpcHandler } from '../electron/agent-channel/bridge';
import { ChatSettingProposals, chatSettingsSystemText, currentSettingsText, mentionsSettings, turnSettingsMentioned } from '../electron/chat-settings';

const CARD = '0f8fad5b-d9cb-469f-a165-70867728950e', NEW = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/** The host as the control window reaches it: one fake handler per IPC operation, each call recorded with its sender. */
function host(options: { posePhase?: string } = {}) {
  let settings: AppSettings = { ...structuredClone(DEFAULT_SETTINGS), model: { path: 'C:\\m\\aoi.pmx', url: 'local://aoi', name: 'aoi.pmx' } as any };
  const cards = { activeId: CARD, cards: [{ id: CARD, name: '小桃', modelName: 'aoi.pmx' } as any] };
  let music = { strength: 0.6, alwaysDance: false }, physics = { hair: { enabled: false, strength: 0.65 }, chest: { enabled: false, strength: 0.5 }, quality: 'standard' };
  let language = 'system', developer = false, proactive = false, feed = false;
  const runtime = { cameraSharing: false, voiceInput: false, screenSharing: false };
  const pose = { phase: options.posePhase ?? 'not-installed', prompt: false, downloadBytes: 120_000_000, installedBytes: 0, progress: null, route: null, level: null,
    componentVersion: 1, notice: '' };
  const calls: Array<[string, ...unknown[]]> = [], senders = new Set<number>();
  const handlers: Record<string, (...args: any[]) => unknown> = {
    getSettings: () => structuredClone(settings),
    getRuntimeState: () => ({ ...runtime }),
    setRuntimeState: patch => { calls.push(['setRuntimeState', patch]); Object.assign(runtime, patch); return { ...runtime }; },
    saveSettings: next => { calls.push(['saveSettings']); settings = structuredClone(next); return settings; },
    getCharacterCards: () => structuredClone(cards),
    bindCharacterModel: (id, enabled) => { calls.push(['bindCharacterModel', id, enabled]); if (!enabled) delete cards.cards[0].modelName; return cards; },
    getUiLanguage: () => ({ preference: language, language: 'zh-CN' }),
    setUiLanguage: value => { calls.push(['setUiLanguage', value]); language = value; return { preference: value, language: 'zh-CN' }; },
    getMood: () => ({ developerMode: developer }),
    setMoodDeveloperMode: value => { calls.push(['setMoodDeveloperMode', value]); developer = value; },
    getMusicSettings: () => ({ ...music }),
    setMusicSettings: patch => { calls.push(['setMusicSettings', patch]); music = { ...music, ...patch }; return music; },
    getModelPhysicsSettings: () => structuredClone(physics),
    setModelPhysicsSettings: next => { calls.push(['setModelPhysicsSettings', next]); physics = structuredClone(next); return physics; },
    getVisionRuntime: () => ({ proactiveVision: proactive }),
    setVisionOptions: patch => { calls.push(['setVisionOptions', patch]); proactive = patch.proactiveVision; return { proactiveVision: proactive }; },
    getFeedRecognition: () => ({ enabled: feed }),
    setFeedRecognition: value => { calls.push(['setFeedRecognition', value]); feed = value; return { enabled: feed }; },
    getPoseSensing: () => ({ ...pose }),
    downloadPoseComponents: () => { calls.push(['downloadPoseComponents']); pose.phase = 'downloading'; return new Promise(() => {}); }, // minutes
    cancelPoseDownload: () => { calls.push(['cancelPoseDownload']); pose.phase = 'not-installed'; },
    removePoseComponents: () => { calls.push(['removePoseComponents']); pose.phase = 'not-installed'; return { ...pose }; },
    recoverPet: () => { calls.push(['recoverPet']); },
    useBundledModel: () => { calls.push(['useBundledModel']); settings = { ...settings, model: { path: 'bundled:gene', url: 'bundled://gene', name: 'Gene' } as any }; return settings; },
    createCharacterForCurrentModel: () => { calls.push(['createCharacterForCurrentModel']); cards.cards.push({ id: NEW, name: 'aoi' }); return structuredClone(cards); },
  };
  const operations = new Map<string, IpcHandler>(Object.entries(handlers).map(([name, run]) =>
    [name, (event: any, ...args: unknown[]) => { senders.add(event.sender.id); return run(...args); }]));
  const window = (id: number) => ({ isDestroyed: () => false, isVisible: () => true, isMinimized: () => false,
    webContents: { id, isDestroyed: () => false, send() {} } });
  const loads: string[] = [];
  const bridge = createHostBridge({ version: () => '0', controls: () => window(11), pet: () => window(12), operations,
    admit: (guard, run) => { guard(); return run(); }, importCharacterCard: async () => { throw new Error('x'); },
    loadModel: async file => { loads.push(file); settings = { ...settings, model: { path: file, url: 'local://x', name: 'aoi.pmx' } as any }; return settings.model!; },
    commitPetBoolean: async () => { throw new Error('x'); }, commitReadoutVolume: async () => { throw new Error('x'); }, commitBreath: async () => { throw new Error('x'); },
    replyLatency: () => [], broadcast: () => {}, interconnected: () => true });
  const asked: AgentConfirmRequest[] = [], notices: string[] = [];
  let undo: { label: string; run(guard: () => void): unknown } | undefined;
  const registry = new AgentToolRegistry(createAppTools(bridge), { enabled: () => true, interconnect: () => true,
    confirm: async request => { asked.push(request); return true; }, notice: (_t, title, detail) => notices.push(`${title}：${detail ?? ''}`),
    called: (_summary, offer) => { undo = offer; } });
  return { call: (name: string, args: unknown): Promise<any> => registry.call(name, args), calls, senders, settings: () => settings, asked, notices,
    undo: () => undo, loads, pose, runtime, state: () => ({ music, physics, language, developer, proactive, feed }) };
}

test('every new operation is one the settings window itself calls, and only those are reused', () => {
  for (const name of ['setUiLanguage', 'setMoodDeveloperMode', 'setMusicSettings', 'setModelPhysicsSettings', 'setVisionOptions', 'setFeedRecognition',
    'downloadPoseComponents', 'cancelPoseDownload', 'removePoseComponents', 'recoverPet', 'useBundledModel', 'createCharacterForCurrentModel'])
    assert.ok(AGENT_HOST_OPERATIONS.includes(name), name);
  for (const never of ['resetSettings', 'quit', 'deleteCharacter', 'deleteMemory', 'exportCharacterCard', 'importPoseComponents', 'setClaudeTasksEnabled', 'startCodexTask'])
    assert.ok(!AGENT_HOST_OPERATIONS.includes(never), never);
});

test('direct settings change at once through their own control\'s operation, as the control window, and read back', async () => {
  const h = host();
  const set = async (id: string, value: unknown) => { const result = await h.call('set_setting', { id, value }); assert.ok(result.ok, `${id}: ${JSON.stringify(result)}`); return result.result; };
  await set('click_through', true); assert.equal(h.settings().pet.clickThrough, true);
  await set('voice_rate', 130); assert.equal(h.settings().voice.rate, 1.3);
  await set('voice_mood_influence', 20); assert.equal(h.settings().voice.moodInfluence, 20);
  await set('voice_first_chunk', 'comma'); assert.equal(h.settings().voice.firstChunk, 'comma'); // I-029
  await set('ui_language', 'en'); assert.equal(h.state().language, 'en');
  await set('developer_mode', true); assert.equal(h.state().developer, true);
  await set('music_strength', 30); assert.equal(h.state().music.strength, 0.3);
  await set('music_always_dance', true); assert.equal(h.state().music.alwaysDance, true);
  await set('physics_hair', true); assert.deepEqual(h.state().physics.hair, { enabled: true, strength: 0.65 }, 'only the switch changes, the strength stays');
  await set('physics_quality', 'high'); assert.equal(h.state().physics.quality, 'high');
  assert.deepEqual(h.asked, [], 'no dialog'); assert.deepEqual([...h.senders], [11], 'always as the control window');
  assert.deepEqual(h.calls.filter(call => call[0] === 'setMusicSettings').map(call => call[1]), [{ strength: 0.3 }, { alwaysDance: true }]);
  // 撤回 goes back for these.
  const back = h.undo()!;
  assert.match(back.label, /物理质量/);
  await back.run(() => {});
  assert.equal(h.state().physics.quality, 'standard');
  const listed = (await h.call('list_settings', {})).result.settings as Array<{ id: string; value: unknown }>;
  const value = (id: string) => listed.find(item => item.id === id)?.value;
  assert.deepEqual([value('click_through'), value('voice_rate'), value('ui_language'), value('developer_mode'), value('music_strength'), value('physics_hair'), value('physics_quality'),
    value('voice_first_chunk')], [true, 130, 'en', true, 30, true, 'standard', 'comma']);
});

test('what needs consent (a bigger model, sharing the screen with Claude, sending pictures, a download) needs the user\'s words', async () => {
  const h = host();
  for (const [id, value] of [['chat_model', 'opus'], ['proactive_vision', true], ['feed_recognition', true], ['pose_sensing', 'installed']] as const) {
    const refused = await h.call('set_setting', { id, value });
    assert.equal(!refused.ok && refused.error.code, 'needs_user_words', id);
  }
  assert.deepEqual(h.calls, [], 'nothing happened');
  assert.ok((await h.call('set_setting', { id: 'chat_model', value: 'opus', userWords: '换成 opus 吧' })).ok);
  assert.equal(h.settings().provider.model, 'opus');
  assert.ok((await h.call('set_setting', { id: 'proactive_vision', value: true, userWords: '你可以看着屏幕主动跟我聊' })).ok);
  assert.ok((await h.call('set_setting', { id: 'feed_recognition', value: true, userWords: '喂你的时候认一下图吧' })).ok);
  assert.deepEqual(h.state().proactive, true); assert.equal(h.state().feed, true);
  // F7 停停说说: one more haiku call per reply, so turning it on needs the user's words; turning it off never does.
  const talk = await h.call('set_setting', { id: 'pause_talk', value: true });
  assert.equal(!talk.ok && talk.error.code, 'needs_user_words');
  assert.ok((await h.call('set_setting', { id: 'pause_talk', value: true, userWords: '把停停说说打开试试' })).ok);
  assert.equal(h.settings().voice.pauseTalk, true);
  assert.ok((await h.call('set_setting', { id: 'pause_talk', value: false })).ok);
  assert.notEqual(h.settings().voice.pauseTalk, true);
  // Closing them never needs words; 撤回 never re-opens them.
  assert.ok((await h.call('set_setting', { id: 'proactive_vision', value: false })).ok);
  assert.equal(h.undo(), undefined);
  const started = Date.now();
  const download = await h.call('set_setting', { id: 'pose_sensing', value: 'installed', userWords: '把姿态感知组件下了吧' });
  assert.ok((await h.call('set_setting', { id: 'pose_sensing', value: 'installed', userWords: '下吧' })).ok, 'asked again while it downloads');
  assert.ok(download.ok && download.result.value === 'downloading' && /隐私与设置/u.test(download.result.note));
  assert.ok(Date.now() - started < 2000, 'returns once the download started');
  assert.match(h.notices.at(-1)!, /开始下载本机姿态感知组件（约 120 MB）/u);
  assert.ok((await h.call('set_setting', { id: 'pose_sensing', value: 'not-installed', userWords: '算了别下了' })).ok);
  assert.deepEqual(h.calls.filter(call => /Pose/u.test(call[0])).map(call => call[0]), ['downloadPoseComponents', 'cancelPoseDownload']);
  const installed = host({ posePhase: 'idle' });
  assert.ok((await installed.call('set_setting', { id: 'pose_sensing', value: 'not-installed', userWords: '删掉姿态感知组件' })).ok);
  assert.deepEqual(installed.calls.map(call => call[0]), ['removePoseComponents']);
  const listed = (await h.call('list_settings', {})).result.settings as Array<{ id: string; details?: Array<{ value: unknown; detail: string }> }>;
  assert.match(listed.find(item => item.id === 'pose_sensing')!.details![0].detail, /OpenMMLab/u);
});

test('privacy: a sense opens only with the words, as the pet window; closing is direct and 撤回 after it never re-opens', async () => {
  const h = host();
  assert.equal((await h.call('set_perception', { kind: 'camera', state: 'on' })).error.code, 'needs_user_words');
  assert.equal(h.runtime.cameraSharing, false);
  assert.ok((await h.call('set_perception', { kind: 'camera', state: 'on', userWords: '打开摄像头' })).ok);
  assert.equal(h.runtime.cameraSharing, true);
  assert.deepEqual([...h.senders].sort(), [11, 12], 'read as the control window, switched as the pet (the user’s own switch)');
  assert.ok((await h.call('set_perception', { kind: 'camera', state: 'off' })).ok);
  assert.equal(h.runtime.cameraSharing, false);
  assert.equal(h.undo(), undefined, 'no way back to an open camera without the words');
});

test('new tools: 一键恢复桌宠, 换回预装 Gene (with the words, 撤回 back), 解除关联, 用现在的模型新建角色', async () => {
  const h = host();
  assert.ok((await h.call('recover_pet', {})).ok);
  assert.equal((await h.call('use_bundled_model', {})).error.code, 'needs_user_words');
  const bundled = await h.call('use_bundled_model', { userWords: '换回 Gene 吧' });
  assert.ok(bundled.ok); assert.equal(h.settings().model?.name, 'Gene');
  assert.equal(h.undo()!.label, '换回模型「aoi.pmx」');
  await h.undo()!.run(() => {});
  assert.deepEqual(h.loads, ['C:\\m\\aoi.pmx']);
  const unbound = await h.call('unbind_character_model', { id: CARD });
  assert.ok(unbound.ok); assert.match(h.notices.at(-1)!, /不再自动载入「aoi\.pmx」/u);
  assert.equal((await h.call('unbind_character_model', { id: CARD })).error.code, 'unavailable', 'nothing left to unbind');
  const created = await h.call('create_character_for_current_model', {});
  assert.deepEqual(created.result.created, { id: NEW, name: 'aoi' });
  assert.equal(created.result.activeId, CARD, 'not switched to it');
  assert.deepEqual(h.calls.map(call => call[0]).filter(name => !/^get/u.test(name)),
    ['recoverPet', 'useBundledModel', 'bindCharacterModel', 'createCharacterForCurrentModel']);
  for (const name of ['recover_pet', 'use_bundled_model', 'unbind_character_model', 'create_character_for_current_model'])
    assert.ok(AGENT_TOOLS.some(tool => tool.name === name), name);
});

test('her chat: each per-turn setting comes into a turn only when the message names it; her fixed prompt never grows', () => {
  const fixed = chatSettingsSystemText();
  assert.equal(fixed, chatSettingsSystemText(AGENT_SETTINGS.filter(spec => spec.chat !== 'turn')));
  for (const [text, id] of [['鼠标穿透打开吧', 'click_through'], ['朗读的语速慢一点', 'voice_rate'], ['换成英文界面', 'ui_language'], ['让她一直跟着跳', 'music_always_dance'],
    ['头发物理打开', 'physics_hair'], ['聊天模型换成 opus', 'chat_model'], ['喂食的时候认图吧', 'feed_recognition'], ['帮我下载语音输入', 'local_asr']] as const) {
    assert.ok(mentionsSettings(text), text);
    assert.ok(turnSettingsMentioned(text).some(spec => spec.id === id), `${text} → ${id}`);
  }
  const named = new Set(turnSettingsMentioned('朗读的语速慢一点').map(spec => spec.id));
  const current = currentSettingsText(structuredClone(DEFAULT_SETTINGS), AGENT_SETTINGS, undefined, undefined, spec => spec.chat !== 'turn' || named.has(spec.id));
  assert.match(current, /voice_rate=100（系统声音语速/u);
  assert.ok(!current.includes('local_asr') && !current.includes('click_through'), 'only what this message is about');
  // Through the real turn: a message about the speaking rate brings only that, not the microphone or the download.
  const proposals = new ChatSettingProposals({ settings: () => structuredClone(DEFAULT_SETTINGS), send: () => {} });
  const turn = proposals.beginTurn('朗读的语速慢一点')!.instruction!('<s>', '</s>');
  assert.match(turn, /voice_rate=/u);
  assert.ok(!turn.includes('local_asr') && !turn.includes('voice_input') && !turn.includes('click_through'), turn.slice(0, 400));
  for (const id of ['developer_mode', 'physics_chest', 'physics_quality', 'voice_provider', 'recycle_bin_days', 'experience_journal'])
    assert.equal(AGENT_SETTINGS.find(spec => spec.id === id)!.chat, false, `${id} stays out of her chat`);
});

test('the list after part 3: what moved, and every remaining gap says why', () => {
  for (const id of ['recover_pet', 'bundled_model', 'character_new_current', 'character_unbind_model', 'physics_hair', 'physics_chest', 'physics_quality', 'music_strength',
    'music_always_dance', 'chat_model', 'voice_rate', 'voice_mood_influence', 'developer_mode', 'pose_sensing', 'proactive_vision', 'ui_language', 'click_through', 'feed_recognition'])
    assert.ok(capabilityChannel(CAPABILITIES.find(entry => entry.id === id)!), id);
  for (const id of ['screen_sharing', 'camera_sharing', 'system_audio', 'voice_input', 'voice_provider', 'delete_memories', 'chat_model', 'proactive_vision', 'feed_recognition'])
    assert.equal(CAPABILITIES.find(entry => entry.id === id)!.level, 'user-words', `${id}: privacy, money or deletion`);
  const gaps = CAPABILITIES.filter(capabilityGap);
  for (const entry of gaps) assert.ok(entry.reason && !entry.reason.startsWith('内部通道还没有这个操作'), `${entry.id} says its own reason`);
  assert.ok(gaps.length <= 20, `${gaps.length} gaps left`);
});
