// I-014 "三方互通": on by default, remembered once turned off; with it on the user's own Claude acts
// without a second dialog (notice, backup, undo), the pet's chat still asks, deletions wait in a recycle bin, and the
// user's Claude Code is connected once. docs/claude/2026-11-03-three-way-interconnect.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import type { AppSettings } from '../shared/contracts';
import type { CharacterCardState } from '../shared/character-cards';
import { AGENT_NEVER_EXPOSED, AGENT_TOOLS, type AgentChannelNotice } from '../shared/agent-channel';
import { REALER_EMOTIONS_CONSENT } from '../shared/realer-emotions';
import { AgentToolRegistry, type AgentAuditEntry, type AgentConfirmRequest, type AgentConfirmText, type AgentToolDefinition } from '../electron/agent-channel/registry';
import { argsObject, noArgs, type FileSystemPort } from '../electron/agent-channel/validate';
import { createAppTools, type AgentAppBridge, type PerceptionFacts } from '../electron/agent-channel/app-tools';
import { AgentChannelHost, type AgentChannelHostOptions } from '../electron/agent-channel/host';
import { INTERCONNECT_FILE, InterconnectStore } from '../electron/agent-channel/interconnect';
import { AGENT_CREDENTIALS_FILE } from '../electron/agent-channel/credentials';
import { autoLinkAllowed, linkClaudeCode, listedInClaudeCode, spawnClaudeRunner } from '../electron/agent-channel/claude-code-link';
import { registrationArguments, setupSnippets } from '../electron/agent-channel/setup-text';
import { createHostBridge, recordAgentOperations, AGENT_PET_OPERATIONS, type IpcHandler } from '../electron/agent-channel/bridge';
import { createMemoryBridge } from '../electron/agent-channel/memory-bridge';
import { chatSettingApplier } from '../electron/chat-settings';
import { realerEmotionsRequest } from '../electron/realer-emotions-host';
import { MemoryRecycleBin, RECYCLE_DEFAULT_DAYS } from '../electron/memory-recycle-bin';
import { forgetRecoverably, restoreRecoverably } from '../electron/recoverable-forget';
import { MemoryStore } from '../electron/memory';
import { UserProfileStore } from '../electron/user-profile';
import { localDateKey } from '../electron/diary/diary-dates';

const CARD_A = '0f8fad5b-d9cb-469f-a165-70867728950e', CARD_B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const DAY = 86_400_000;

/** Hosts a test started; closed before its folder goes (a live host still writing its audit log could make the removal fail). */
const owned = new WeakMap<test.TestContext, AgentChannelHost[]>();
function own(t: test.TestContext, host: AgentChannelHost): AgentChannelHost {
  owned.get(t)?.push(host) ?? owned.set(t, [host]);
  return host;
}

async function directory(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sh-mutual-'));
  t.after(async () => {
    for (const host of owned.get(t) ?? []) await host.dispose().catch(() => {});
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}

// ---------------------------------------------------------------- the switch itself

test('三方互通: on for a profile that never chose (old or new), an explicit off is remembered, an unreadable file stays off', async t => {
  const dir = await directory(t);
  const fresh = new InterconnectStore(dir);
  assert.deepEqual(await fresh.load(), { enabled: true, explicit: false, autoRegistered: [] }, 'old profiles upgrade to the new default');
  await fresh.noteAutoRegistered('soft-hearts-next');
  const noted = await new InterconnectStore(dir).load();
  assert.deepEqual(noted, { enabled: true, explicit: false, autoRegistered: ['soft-hearts-next'] }, 'remembering a registration does not count as a choice');
  await fresh.setEnabled(false);
  const reopened = new InterconnectStore(dir);
  assert.deepEqual(await reopened.load(), { enabled: false, explicit: true, autoRegistered: ['soft-hearts-next'] }, 'the user turned it off: it stays off');
  await reopened.setEnabled(true);
  assert.equal((await new InterconnectStore(dir).load()).enabled, true);
  await assert.rejects(reopened.setEnabled('yes'));
  await writeFile(path.join(dir, INTERCONNECT_FILE), '{not json');
  const broken = await new InterconnectStore(dir).load();
  assert.equal(broken.enabled, false, 'fewer dialogs is never the fallback');
  assert.equal(broken.unreadable, true);
});

function fakeTools(log: string[]): AgentToolDefinition[] {
  return [
    { name: 'get_status', title: '读取状态', tier: 'read', validate: noArgs, run: () => ({ ok: true }) },
    { name: 'import_character_card', title: '导入角色卡', tier: 'confirm', validate: noArgs, confirmation: () => ({ title: '导入？', detail: '文件' }),
      noticeDetail: () => 'card.json', run: () => { log.push('import'); return { imported: true }; } },
    { name: 'set_perception', title: '开关感知', tier: 'reversible', interconnectOnly: true, validate: raw => argsObject(raw, ['kind']),
      run: () => { log.push('perception'); return { on: true }; } },
  ];
}

function hostFixture(dir: string, link?: AgentChannelHostOptions['linkClaudeCode']) {
  const log: string[] = [], asked: AgentConfirmRequest[] = [], notices: AgentChannelNotice[] = [];
  const host = new AgentChannelHost({ profileDirectory: dir, tools: fakeTools(log), confirmTimeoutMs: 200,
    confirm: async request => { asked.push(request); return true; }, publishNotice: notice => notices.push(notice),
    ...(link ? { linkClaudeCode: link, linkDelayMs: 0 } : {}) });
  return { host, log, asked, notices };
}

test('default on: the channel opens at startup with no switch touched; confirm-tier tools run without a dialog, with the user words and the notice', async t => {
  const dir = await directory(t);
  const f = hostFixture(dir);
  own(t, f.host);
  const view = await f.host.init();
  assert.equal(view.enabled, true); assert.equal(view.listening, true);
  assert.equal(view.interconnect?.enabled, true); assert.equal(view.interconnect?.explicit, false);
  await stat(path.join(dir, AGENT_CREDENTIALS_FILE));
  assert.ok(f.host.registry.names().includes('set_perception'), 'interconnect-only tools exist');
  // I-025: the user's own words from the conversation are the consent; without them nothing happens.
  const missing = await f.host.registry.call('import_character_card', {});
  assert.equal(!missing.ok && missing.error.code, 'needs_user_words');
  const result = await f.host.registry.call('import_character_card', { userWords: '把这张角色卡导进来' });
  assert.deepEqual(result, { ok: true, result: { imported: true } });
  assert.deepEqual(f.asked, [], 'no dialog');
  assert.deepEqual(f.notices.map(notice => [notice.title, notice.detail]), [['导入角色卡', 'card.json']]);
  await assert.rejects(f.host.setEnabled(false), /先关掉“三方互通”/, 'the channel stays open while 三方互通 is on');
});

test('turned off: the channel closes, dialogs come back, interconnect-only tools vanish; the choice survives a restart', async t => {
  const dir = await directory(t);
  const f = hostFixture(dir);
  own(t, f.host); // Also when an assertion fails: a listening pipe would keep the test process alive.
  await f.host.init();
  const off = await f.host.setInterconnect(false);
  assert.equal(off.enabled, false); assert.equal(off.interconnect?.enabled, false); assert.equal(off.interconnect?.explicit, true);
  await assert.rejects(stat(path.join(dir, AGENT_CREDENTIALS_FILE)), 'the token file is gone');
  assert.ok(!f.host.registry.names().includes('set_perception'));
  // The user may still open the channel by hand, exactly as before I-014: then every confirm-tier call asks.
  await f.host.setEnabled(true);
  assert.equal((await f.host.registry.call('import_character_card', {})).ok, true);
  assert.equal(f.asked.length, 1, 'the dialog is back');
  const hidden = await f.host.registry.call('set_perception', { kind: 'camera' });
  assert.equal(!hidden.ok && hidden.error.code, 'unknown_tool', 'refused exactly like a tool that does not exist');
  assert.ok(!f.log.includes('perception'));
  await f.host.setEnabled(false);
  await f.host.dispose();
  const restarted = hostFixture(dir);
  own(t, restarted.host);
  const view = await restarted.host.init();
  assert.equal(view.enabled, false, 'an explicit off stays off after a restart');
  assert.equal(view.interconnect?.enabled, false);
  const back = await restarted.host.setInterconnect(true);
  assert.equal(back.enabled, true); assert.equal(back.interconnect?.enabled, true);
});

// ---------------------------------------------------------------- the registry gate

function registry(definitions: AgentToolDefinition[], interconnect: () => boolean) {
  const asked: AgentConfirmRequest[] = [], notices: Array<[string, string | undefined]> = [], audit: AgentAuditEntry[] = [], informed: AgentConfirmText[] = [];
  const reg = new AgentToolRegistry(definitions, { enabled: () => true, interconnect,
    confirm: async request => { asked.push(request); return false; }, notice: (_tool, title, detail) => notices.push([title, detail]),
    inform: text => informed.push(text), audit: entry => audit.push(entry) });
  return { reg, asked, notices, audit, informed };
}

test('registry: 三方互通 decides per call between the dialog and running at once; never-tier tools stay undefined either way', async () => {
  let mutual = true, ran = 0;
  const confirmTool: AgentToolDefinition = { name: 'c', title: '确认类', tier: 'confirm', validate: noArgs, confirmation: () => ({ title: '?', detail: '' }),
    informWithoutDialog: () => ({ title: '说明', detail: '给你看一次' }), run: () => ++ran };
  const secret: AgentToolDefinition = { name: 'read_key', title: '密钥', tier: 'never', validate: noArgs, run: () => 'sk-live' };
  const f = registry([confirmTool, secret], () => mutual);
  const missing = await f.reg.call('c', {});
  assert.equal(!missing.ok && missing.error.code, 'needs_user_words', 'I-025: no words, nothing happens');
  assert.equal(ran, 0);
  assert.deepEqual(await f.reg.call('c', { userWords: '好，打开' }), { ok: true, result: 1 });
  assert.deepEqual(f.asked, []);
  assert.deepEqual(f.informed, [{ title: '说明', detail: '给你看一次' }], 'shown once, not waited for');
  assert.equal(f.audit.at(-1)!.approval, 'user-words');
  assert.equal(f.audit.at(-1)!.words, 4);
  mutual = false;
  const denied = await f.reg.call('c', {});
  assert.equal(!denied.ok && denied.error.code, 'denied_by_user');
  assert.equal(f.asked.length, 1); assert.equal(ran, 1, 'off: the dialog decides (and said no)');
  assert.equal(f.informed.length, 1, 'no extra explanation when the dialog itself explained');
  for (const state of [true, false]) {
    mutual = state;
    assert.ok(!f.reg.names().includes('read_key'));
    const refused = await f.reg.call('read_key', {});
    assert.equal(!refused.ok && refused.error.code, 'unknown_tool');
  }
});

test('the never list keeps keys, commands, files, other permissions and permanent deletion out; the catalog has no tool for them', () => {
  const never = AGENT_NEVER_EXPOSED.join('\n');
  for (const word of ['密钥', '运行命令', '任意读写文件', '权限', '永久删除']) assert.match(never, new RegExp(word));
  for (const tool of AGENT_TOOLS) assert.doesNotMatch(tool.name, /key|secret|token|shell|exec|command|file_(read|write)|permission|purge|empty_bin/);
  const interconnectOnly = AGENT_TOOLS.filter(tool => tool.interconnectOnly).map(tool => tool.name).sort();
  assert.deepEqual(interconnectOnly, ['delete_memories', 'list_recycle_bin', 'restore_memories', 'set_perception']);
});

// ---------------------------------------------------------------- the app's own tools

function bridgeFixture(options: { mutual?: boolean; tts?: Partial<NonNullable<AppSettings['tts']>> } = {}) {
  let mutual = options.mutual ?? true;
  let settings: AppSettings = structuredClone(DEFAULT_SETTINGS);
  settings.model = { path: 'C:\\m\\gene.pmx', url: 'local://gene', name: 'gene.pmx' };
  if (options.tts) settings.tts = { ...(settings.tts ?? {}), ...options.tts } as any;
  const cards: CharacterCardState = { activeId: CARD_A, cards: [{ id: CARD_A, name: '小桃', realerEmotions: false } as any, { id: CARD_B, name: '阿澄' } as any] };
  const perception: PerceptionFacts = { camera: false, microphone: false, screen: false, systemAudio: { music: false, movie: false } };
  const calls: unknown[][] = [];
  let pet = { visible: true, minimized: false };
  const commit = async () => ({ persistence: 'saved' as const, presentation: 'applied' });
  const bridge: AgentAppBridge = {
    version: () => '0.1.0', settings: () => structuredClone(settings), characters: () => structuredClone(cards),
    windows: () => ({ pet, controls: { visible: true, minimized: false } }),
    activateCharacter: async id => { calls.push(['activate', id]); cards.activeId = id; },
    bindCurrentModel: async id => { calls.push(['bind', id]); },
    setRealerEmotions: async value => { calls.push(['realer', value]); (cards.cards[0] as any).realerEmotions = value; },
    setPetVisible: async visible => { settings.pet.visible = visible; },
    saveSettings: async next => { calls.push(['save', next.tts?.provider ?? 'system', next.pet.fps]); settings = structuredClone(next); },
    commitPetBoolean: commit, commitReadoutVolume: commit, commitBreath: commit,
    importCharacterCard: async () => { calls.push(['import']); return structuredClone(cards); },
    loadModel: async file => { calls.push(['load', file]); settings.model = { path: file, url: 'local://x', name: path.win32.basename(file) }; return { name: path.win32.basename(file) }; },
    rendererAction: action => { calls.push(['renderer', action]); return true; },
    diagnostics: () => ({ replyLatency: [], petWindow: { enabled: false, entries: 0 } }),
    interconnected: () => mutual,
    perception: () => structuredClone(perception),
    setPerception: async (kind, enabled, purposes) => {
      calls.push(['perception', kind, enabled, ...purposes]);
      if (kind === 'system_audio') for (const purpose of purposes) perception.systemAudio[purpose] = enabled;
      else if (kind === 'camera_images') perception.cameraImages = enabled; else if (kind === 'camera_pose') perception.cameraPose = enabled;
      else perception[kind] = enabled;
    },
  };
  return { bridge, calls, perception, settings: () => settings, cards, setMutual: (value: boolean) => { mutual = value; }, hidePet: () => { pet = { visible: false, minimized: false }; } };
}
const fs: FileSystemPort = { realpath: async file => file, stat: async () => ({ isFile: () => true, size: 10, mtimeMs: 1 }) };

function appRegistry(f: ReturnType<typeof bridgeFixture>, mutual: () => boolean) {
  const asked: AgentConfirmRequest[] = [], notices: string[] = [], informed: AgentConfirmText[] = [];
  let undo: { label: string; run(guard: () => void): unknown } | undefined;
  const reg = new AgentToolRegistry(createAppTools(f.bridge, { fs, platform: 'win32', readText: async () => '{"name":"卡"}' }), {
    enabled: () => true, interconnect: mutual, confirm: async request => { asked.push(request); return true; },
    notice: (_tool, title, detail) => notices.push(detail ? `${title}：${detail}` : title), inform: text => informed.push(text),
    called: (_summary, offer) => { if (offer) undo = offer; } });
  return { reg, asked, notices, informed, undo: () => undo };
}

test('app tools with 三方互通 on: import, model, realer emotions run without dialogs; notices name what happened; off they ask again', async () => {
  const f = bridgeFixture();
  const r = appRegistry(f, () => f.bridge.interconnected!());
  assert.equal((await r.reg.call('import_character_card', { path: 'C:\\cards\\aoi.json', userWords: '导入 aoi' })).ok, true);
  assert.equal((await r.reg.call('load_model', { path: 'C:\\m\\aoi.pmx', userWords: '换成 aoi 的模型' })).ok, true);
  const realer = await r.reg.call('set_setting', { id: 'realer_emotions', value: true, userWords: '让她情绪更真实一点' });
  assert.equal(realer.ok, true);
  assert.deepEqual(r.asked, [], 'no confirmation dialog while 三方互通 is on');
  assert.equal(r.informed.length, 1, 'the realer-emotions explanation is still shown once');
  assert.equal(r.informed[0].detail, REALER_EMOTIONS_CONSENT.detail);
  assert.match(r.informed[0].title, /小桃/);
  assert.deepEqual(r.notices, ['导入角色卡：aoi.json', '载入模型：aoi.pmx', '调整设置：「当前角色更真实的情绪」改为 更真实']);
  assert.deepEqual(f.calls.filter(call => call[0] !== 'renderer').map(call => call[0]), ['import', 'load', 'realer']);
  f.setMutual(false);
  await r.reg.call('set_setting', { id: 'realer_emotions', value: false });
  await r.reg.call('set_setting', { id: 'realer_emotions', value: true });
  assert.equal(r.asked.length, 1, 'off: the consent dialog is back');
  assert.equal((r.asked as AgentConfirmRequest[])[0].buttons?.[1], REALER_EMOTIONS_CONSENT.accept);
  assert.equal(r.informed.length, 1);
});

test('从桌宠聊天发起的操作在互通打开时仍弹确认: the chat cards never skip the dialog, whatever 三方互通 says', async () => {
  const f = bridgeFixture({ mutual: true });
  const asked: AgentConfirmRequest[] = [];
  const apply = chatSettingApplier(createAppTools(f.bridge, { settingVia: 'chat' }), { confirm: async request => { asked.push(request); return false; } });
  const result = await apply('realer_emotions', true);
  assert.equal(asked.length, 1, 'the consent dialog shows for a chat card even with 三方互通 on');
  assert.equal(!result.ok && result.error.code, 'denied_by_user');
  assert.ok(!f.calls.some(call => call[0] === 'realer'), 'declined: nothing changed');
});

test('the settings window: with 三方互通 on a click turns 更真实的情绪 on at once and shows the explanation; off it asks first', async () => {
  let mutual = true;
  const cards: CharacterCardState = { activeId: CARD_A, cards: [{ id: CARD_A, name: '小桃', realerEmotions: false } as any] };
  const asked: unknown[] = [], shown: Array<{ message: string; detail: string; buttons: string[] }> = [], saved: boolean[] = [];
  const request = realerEmotionsRequest({ cards: () => structuredClone(cards), interconnected: () => mutual,
    confirm: async options => { asked.push(options); return false; }, inform: options => shown.push(options),
    save: async (_id, value) => { saved.push(value); (cards.cards[0] as any).realerEmotions = value; return structuredClone(cards); } });
  await request(CARD_A, true);
  assert.deepEqual(saved, [true]); assert.deepEqual(asked, []);
  assert.equal(shown.length, 1); assert.equal(shown[0].detail, REALER_EMOTIONS_CONSENT.detail); assert.deepEqual(shown[0].buttons, ['知道了']);
  await request(CARD_A, false);
  mutual = false;
  await request(CARD_A, true);
  assert.equal(asked.length, 1, 'off: the dialog asks'); assert.deepEqual(saved, [true, false], 'declined: not saved');
});

test('interconnect-only settings: absent while off; the paid voice needs the user\'s own key, and the change can be undone', async () => {
  const off = bridgeFixture({ mutual: false });
  const r0 = appRegistry(off, () => false);
  const hidden = await r0.reg.call('set_setting', { id: 'voice_provider', value: 'bailian' });
  assert.equal(!hidden.ok && hidden.error.code, 'invalid_input');
  const noKey = bridgeFixture({ mutual: true });
  const r1 = appRegistry(noKey, () => true);
  // I-025: switching to the paid voice needs the user's own words; without them nothing is even checked.
  const unasked = await r1.reg.call('set_setting', { id: 'voice_provider', value: 'bailian' });
  assert.equal(!unasked.ok && unasked.error.code, 'needs_user_words');
  const refused = await r1.reg.call('set_setting', { id: 'voice_provider', value: 'bailian', userWords: '换成百炼吧' });
  assert.equal(!refused.ok && refused.error.code, 'unavailable');
  assert.match(!refused.ok ? refused.error.message : '', /密钥不经过内部通道/);
  const keyed = bridgeFixture({ mutual: true, tts: { apiKey: '__saved__', apiHost: 'https://example.invalid' } });
  const r2 = appRegistry(keyed, () => true);
  const switched = await r2.reg.call('set_setting', { id: 'voice_provider', value: 'bailian', userWords: '换成百炼吧' });
  assert.equal(switched.ok, true);
  assert.equal(keyed.settings().tts?.provider, 'bailian');
  assert.ok(!JSON.stringify(switched).includes('__saved__'), 'the key marker never comes back');
  assert.match(r2.undo()!.label, /系统声音/);
  await r2.undo()!.run(() => {});
  assert.equal(keyed.settings().tts?.provider, 'system');
});

test('set_perception: only with 三方互通 on, only with the pet showing, the user\'s own host path, and 撤回 turns it back', async () => {
  const f = bridgeFixture({ mutual: true });
  const r = appRegistry(f, () => f.bridge.interconnected!());
  // I-025: opening a sense needs the user's own words; closing never does.
  const unasked = await r.reg.call('set_perception', { kind: 'camera', state: 'on' });
  assert.equal(!unasked.ok && unasked.error.code, 'needs_user_words');
  assert.equal(f.perception.camera, false);
  const camera = await r.reg.call('set_perception', { kind: 'camera', state: 'on', userWords: '打开摄像头' });
  assert.deepEqual(camera, { ok: true, result: { kind: 'camera', label: '摄像头', on: true } });
  assert.deepEqual(f.calls.at(-1), ['perception', 'camera', true]);
  assert.equal(r.notices.at(-1), '开关感知：打开摄像头');
  assert.equal(r.undo()!.label, '关掉摄像头');
  await r.undo()!.run(() => {});
  assert.equal(f.perception.camera, false);
  // I-036: the camera's two switches each by name; opening needs the user's words like any sense, closing does not.
  const unaskedImages = await r.reg.call('set_perception', { kind: 'camera_images', state: 'on' });
  assert.equal(!unaskedImages.ok && unaskedImages.error.code, 'needs_user_words');
  const images = await r.reg.call('set_perception', { kind: 'camera_images', state: 'on', userWords: '打开摄像头发图片' });
  assert.deepEqual(images, { ok: true, result: { kind: 'camera_images', label: '摄像头发图片', on: true } });
  assert.deepEqual(f.calls.at(-1), ['perception', 'camera_images', true]);
  assert.equal(r.undo()!.label, '关掉摄像头发图片');
  assert.ok((await r.reg.call('set_perception', { kind: 'camera_pose', state: 'off' })).ok, 'closing 姿势识别 needs no words');
  assert.deepEqual(f.calls.at(-1), ['perception', 'camera_pose', false]);
  await r.reg.call('set_perception', { kind: 'camera_images', state: 'off' });
  assert.equal(f.perception.cameraImages, false);
  await r.reg.call('set_perception', { kind: 'system_audio', state: 'on', purpose: 'movie', userWords: '陪我看剧' });
  assert.deepEqual(f.perception.systemAudio, { music: false, movie: true });
  await r.reg.call('set_perception', { kind: 'system_audio', state: 'off' });
  assert.equal(r.undo()?.label, '关掉电脑声音', 'I-025: 撤回 after closing is the earlier close, never a re-open');
  assert.deepEqual(f.calls.at(-1), ['perception', 'system_audio', false, 'music', 'movie'], 'off without a purpose closes both');
  const bad = await r.reg.call('set_perception', { kind: 'camera', state: 'on', purpose: 'music' });
  assert.equal(!bad.ok && bad.error.code, 'invalid_input');
  f.hidePet();
  const hidden = await r.reg.call('set_perception', { kind: 'microphone', state: 'on' });
  assert.equal(!hidden.ok && hidden.error.code, 'unavailable');
  assert.ok((await r.reg.call('set_perception', { kind: 'screen', state: 'off' })).ok, 'turning off never needs the pet');
  f.setMutual(false);
  const gone = await r.reg.call('set_perception', { kind: 'camera', state: 'on' });
  assert.equal(!gone.ok && gone.error.code, 'unknown_tool');
});

test('undo: load_model goes back to the model it replaced; a value changed again since is never overwritten', async () => {
  const f = bridgeFixture({ mutual: true });
  const r = appRegistry(f, () => true);
  await r.reg.call('load_model', { path: 'C:\\m\\aoi.pmx', userWords: '换成 aoi' });
  assert.equal(r.undo()!.label, '换回模型「gene.pmx」');
  await r.undo()!.run(() => {});
  assert.deepEqual(f.calls.filter(call => call[0] === 'load'), [['load', 'C:\\m\\aoi.pmx'], ['load', 'C:\\m\\gene.pmx']]);
  await r.reg.call('set_setting', { id: 'fps', value: 30 });
  const fpsUndo = r.undo()!;
  assert.match(fpsUndo.label, /帧率/);
  await f.bridge.saveSettings({ ...f.settings(), pet: { ...f.settings().pet, fps: 24 } }, () => {}); // the user changed it again
  await assert.rejects(Promise.resolve().then(() => fpsUndo.run(() => {})), /之后又改过了/);
  assert.equal(f.settings().pet.fps, 24);
});

test('host undo: the panel button and undo_last_action undo the latest action once, within 30 minutes', async t => {
  const dir = await directory(t);
  const f = bridgeFixture({ mutual: true });
  let wall = Date.UTC(2026, 10, 3, 12);
  const host = new AgentChannelHost({ profileDirectory: dir, tools: createAppTools(f.bridge, { fs, platform: 'win32' }), confirm: async () => true, clock: () => wall });
  own(t, host);
  await host.init();
  const fpsBefore = f.settings().pet.fps;
  assert.equal((await host.registry.call('set_setting', { id: 'fps', value: 24 })).ok, true);
  const undo = host.view().lastAction?.undo;
  assert.ok(undo, 'the panel shows 撤回');
  await assert.rejects(host.undo('another-id'));
  await host.undo(undo!.id);
  assert.equal(f.settings().pet.fps, fpsBefore);
  assert.equal(host.view().lastAction?.undo, undefined, 'only once');
  await assert.rejects(host.undo(undo!.id));
  assert.equal((await host.registry.call('set_setting', { id: 'fps', value: 24 })).ok, true);
  const viaChannel = await host.registry.call('undo_last_action', {});
  assert.equal(viaChannel.ok, true);
  assert.equal(f.settings().pet.fps, fpsBefore);
  assert.equal((await host.registry.call('set_setting', { id: 'fps', value: 24 })).ok, true);
  wall += 29 * 60_000;
  assert.ok(host.view().lastAction?.undo, 'still there after 29 minutes');
  wall += 2 * 60_000;
  assert.equal(host.view().lastAction?.undo, undefined, 'expired after 30 minutes');
  const late = await host.registry.call('undo_last_action', {});
  assert.equal(!late.ok && late.error.code, 'unavailable');
});

// ---------------------------------------------------------------- the recycle bin

test('recycle bin: per character, data before the index, restorable until it expires, then purged; the period is adjustable', async t => {
  const dir = await directory(t);
  let now = Date.UTC(2026, 10, 3, 12);
  const bin = new MemoryRecycleBin(dir, () => now);
  await bin.load();
  assert.equal(bin.retentionDays, RECYCLE_DEFAULT_DAYS);
  const a = await bin.put({ characterId: CARD_A, characterName: '小桃', part: 'chat', count: 2, label: '聊天记忆 2 段' }, { kind: 'chat', providerScope: 'p', records: [1, 2] });
  const b = await bin.put({ characterId: CARD_B, characterName: '阿澄', part: 'profile', count: 1, label: '画像 1 条、日记 0 天' }, { kind: 'profile', providerScope: 'p', stored: {} });
  assert.equal(a.expiresAt, a.deletedAt + 7 * DAY);
  await stat(path.join(dir, 'recycle-bin', CARD_A, `${a.id}.data.json`));
  await stat(path.join(dir, 'recycle-bin', CARD_B, `${b.id}.json`));
  assert.deepEqual(bin.summaries(CARD_A).map(entry => entry.id), [a.id], 'separate per character');
  const reloaded = new MemoryRecycleBin(dir, () => now);
  await reloaded.load();
  assert.deepEqual(reloaded.summaries().map(entry => entry.label).sort(), ['画像 1 条、日记 0 天', '聊天记忆 2 段']);
  const meta = await readFile(path.join(dir, 'recycle-bin', CARD_A, `${a.id}.json`), 'utf8');
  assert.ok(!meta.includes('records'), 'the small file has names and counts only');
  assert.deepEqual((await reloaded.read(a.id)).data, { kind: 'chat', providerScope: 'p', records: [1, 2] });
  now += 6 * DAY;
  assert.equal(await reloaded.purge(), 0);
  await assert.rejects(reloaded.setRetentionDays(0)); await assert.rejects(reloaded.setRetentionDays(31)); await assert.rejects(reloaded.setRetentionDays(2.5));
  await reloaded.setRetentionDays(14);
  now += 7 * DAY; // 13 days in
  assert.equal(await reloaded.purge(), 0, 'a longer period keeps them');
  await reloaded.setRetentionDays(3);
  assert.equal(reloaded.summaries().length, 0, 'a shorter period purges what is past it');
  await assert.rejects(stat(path.join(dir, 'recycle-bin', CARD_A, `${a.id}.data.json`)));
  await assert.rejects(reloaded.read(a.id), /没有这一项/);
  assert.equal((await new MemoryRecycleBin(dir, () => now).load().then(() => 3)), 3);
});

function receipt(body: string, id: string) { return { requestId: id, messageId: `message-${id}`, source: 'text' as const, text: body, acceptedAt: Date.now() }; }

test('delete_memories → recycle bin → restore: chat memory and profile with diary come back; nothing is lost on a swap', async t => {
  const dir = await directory(t);
  const providerScope = 'claude-scope', scope = { characterId: CARD_A, providerScope }, other = { characterId: CARD_B, providerScope };
  const memory = new MemoryStore(dir); await memory.load();
  const turn = async (where: typeof scope, id: string, text: string, at: number) => {
    await memory.beginTurn(where, { id, userText: text, at }); await memory.appendAssistant(where, id, `嗯，${text}`, at + 1); await memory.finishTurn(where, id, 'complete', at + 2);
  };
  await turn(scope, 't1', '下雨天去书店', 1_000); await memory.seal(scope); await turn(scope, 't2', '明天面试', 5_000); await turn(other, 'o1', '只属于阿澄', 2_000);
  const profiles = new UserProfileStore(path.join(dir, 'user-profiles'));
  await profiles.activate(scope); profiles.setEnabled(true);
  const body = '我在学钢琴。';
  const ticket = profiles.beginObservation(profiles.acceptUserMessage(receipt(body, 'fact-1')));
  await profiles.completeObservation(ticket!, 'fact-1', [{ kind: 'fact', quoteStart: 0, quoteEnd: body.length }]);
  assert.equal(await profiles.saveDiary(profiles.diaryTicket()!, localDateKey(Date.now() - DAY), '今天他说起书店。'), true);
  const profileFile = (await import('node:fs/promises')).readdir(path.join(dir, 'user-profiles'));
  const bin = new MemoryRecycleBin(dir); await bin.load();
  const ports = { providerScopes: () => [providerScope, 'unused-scope'], chat: memory, profiles, bin };
  const countOf = (where: typeof scope) => memory.list(where, {}, Date.now()).total;
  assert.equal(countOf(scope), 2);
  const forgot = await forgetRecoverably(CARD_A, '小桃', ['chat', 'profile'], ports);
  assert.deepEqual(forgot.failed, []); assert.deepEqual(forgot.empty, []);
  assert.deepEqual(forgot.entries.map(entry => [entry.part, entry.label]), [['chat', '聊天记忆 2 段'], ['profile', '画像 1 条、日记 1 天']]);
  assert.equal(countOf(scope), 0, 'her chat memory left the archive');
  assert.equal(countOf(other), 1, 'another character is untouched');
  assert.ok(!(await readFile(path.join(dir, 'memories.jsonl'), 'utf8')).includes('下雨天去书店'), 'compacted out of the journal like a delete');
  assert.deepEqual((await (await import('node:fs/promises')).readdir(path.join(dir, 'user-profiles'))).filter(n => n !== 'recording.json'), [], 'the profile file left (only the on-off switch, no content, stays)');
  assert.ok((await profileFile).filter(n => n !== 'recording.json').length === 1);
  assert.equal(memory.hasDeletedTurn(scope, 't1'), true, 'forgotten turns are tombstoned, like a delete');
  // She chats again after the deletion; then the old chats come back alongside.
  await turn(scope, 't3', '新的话题', 9_000);
  const restoredChat = await restoreRecoverably(forgot.entries[0].id, ports);
  assert.equal(restoredChat.count, 2);
  assert.equal(memory.hasDeletedTurn(scope, 't1'), false, 'restored turns are no longer tombstoned');
  assert.equal(countOf(scope), 3, 'old and new together');
  const reread = new MemoryStore(dir); await reread.load();
  assert.equal(reread.list(scope, {}, Date.now()).total, 3, 'and it survives a restart');
  assert.ok(reread.retrieve(scope, '下雨天去书店').length >= 1, 'recall finds the restored chat again');
  // She learned something new meanwhile: restoring swaps that newer profile into the bin instead of losing it.
  await profiles.activate(scope); profiles.setEnabled(true);
  const fresh = '我养了一只猫。';
  const ticket2 = profiles.beginObservation(profiles.acceptUserMessage(receipt(fresh, 'fact-2')));
  await profiles.completeObservation(ticket2!, 'fact-2', [{ kind: 'fact', quoteStart: 0, quoteEnd: fresh.length }]);
  const restoredProfile = await restoreRecoverably(forgot.entries[1].id, ports);
  assert.ok(restoredProfile.replaced, 'the newer profile went into the bin');
  const view = (await profiles.activate(scope))!;
  assert.deepEqual(view.entries.map(entry => entry.text), [body]);
  assert.equal(view.diary.length, 1);
  assert.deepEqual(bin.summaries().map(entry => entry.id), [restoredProfile.replaced!.id]);
  await restoreRecoverably(restoredProfile.replaced!.id, ports);
  assert.deepEqual((await profiles.activate(scope))!.entries.map(entry => entry.text), [fresh], 'and can be swapped back');
  await assert.rejects(restoreRecoverably(forgot.entries[0].id, ports), /没有这一项/, 'an entry comes back once');
});

test('the recycle bin is written before anything is removed: a bin that cannot write keeps her memories', async t => {
  const dir = await directory(t);
  const providerScope = 'p', scope = { characterId: CARD_A, providerScope };
  const memory = new MemoryStore(dir); await memory.load();
  await memory.beginTurn(scope, { id: 'x', userText: '别忘了我', at: 1 }); await memory.finishTurn(scope, 'x', 'complete', 2);
  const bin = new MemoryRecycleBin(dir); await bin.load();
  (bin as any).put = async () => { throw new Error('disk full'); };
  const outcome = await forgetRecoverably(CARD_A, '小桃', ['chat'], { providerScopes: () => [providerScope], chat: memory, profiles: null, bin });
  assert.deepEqual(outcome.failed, ['chat']);
  assert.equal(memory.list(scope, {}, Date.now()).total, 1, 'nothing deleted');
});

test('delete_memories through the channel: interconnect-only, a known card, a notice that says it is recoverable, undo restores', async t => {
  const dir = await directory(t);
  const f = bridgeFixture({ mutual: true });
  const memory = new MemoryStore(dir); await memory.load();
  const scope = { characterId: CARD_A, providerScope: 'p' };
  await memory.beginTurn(scope, { id: 'x', userText: '我们的秘密', at: 1 }); await memory.finishTurn(scope, 'x', 'complete', 2);
  const bin = new MemoryRecycleBin(dir); await bin.load();
  const changes: string[] = [];
  f.bridge.memories = createMemoryBridge(bin, { providerScopes: () => ['p'], chat: () => memory, profiles: () => null,
    change: async (characterId, parts, mode, guard, run) => { guard(); changes.push(`${mode}:${characterId}:${parts.join(',')}`); return run(); } });
  const r = appRegistry(f, () => f.bridge.interconnected!());
  const bad = await r.reg.call('delete_memories', { id: CARD_A, parts: ['chat', 'chat'] });
  assert.equal(!bad.ok && bad.error.code, 'invalid_input');
  const unknown = await r.reg.call('delete_memories', { id: '11111111-2222-4333-8444-555555555555', parts: ['chat'] });
  assert.equal(!unknown.ok && unknown.error.code, 'invalid_input');
  // I-025: deleting needs the user's own words.
  const unasked = await r.reg.call('delete_memories', { id: CARD_A, parts: ['chat'] });
  assert.equal(!unasked.ok && unasked.error.code, 'needs_user_words');
  assert.equal(memory.list(scope, {}, Date.now()).total, 1, 'nothing deleted without the words');
  const done = await r.reg.call('delete_memories', { id: CARD_A, parts: ['chat'], userWords: '把小桃的聊天记忆删了吧' }) as any;
  assert.equal(done.ok, true);
  assert.match(done.result.note, /没有永久删除/);
  assert.equal(done.result.recycled.length, 1);
  assert.match(r.notices.at(-1)!, /小桃.*回收站.*7 天内可找回/);
  assert.equal(memory.list(scope, {}, Date.now()).total, 0);
  const listed = await r.reg.call('list_recycle_bin', {}) as any;
  assert.equal(listed.result.entries.length, 1);
  assert.ok(!JSON.stringify(listed).includes('我们的秘密'), 'the bin listing never carries the text');
  await r.undo()!.run(() => {});
  assert.equal(memory.list(scope, {}, Date.now()).total, 1, '撤回 put it back');
  assert.deepEqual(changes, [`forget:${CARD_A}:chat`, `restore:${CARD_A}:chat`]);
  f.setMutual(false);
  const gone = await r.reg.call('delete_memories', { id: CARD_A, parts: ['chat'] });
  assert.equal(!gone.ok && gone.error.code, 'unknown_tool');
});

// ---------------------------------------------------------------- the user's own Claude Code

const fakeClaude = fileURLToPath(new URL('./fixtures/fake-claude-mcp.mjs', import.meta.url));
const launch = { command: 'C:\\Apps\\soft hearts next\\soft hearts next.exe', args: ['C:\\Apps\\soft hearts next\\resources\\agent-channel\\soft-hearts-mcp.mjs', '--profile', 'C:\\Users\\me\\AppData\\Roaming\\soft-hearts-claude'], env: { ELECTRON_RUN_AS_NODE: '1' } };

async function fakeClaudeState(t: test.TestContext, state: { servers: string[]; failAdd?: boolean; failList?: boolean }) {
  const dir = await directory(t);
  const file = path.join(dir, 'state.json');
  await writeFile(file, JSON.stringify({ ...state, calls: [] }));
  const runner = spawnClaudeRunner(process.execPath, { ...process.env, FAKE_CLAUDE_STATE: file }, [fakeClaude]);
  const read = async () => JSON.parse(await readFile(file, 'utf8')) as { servers: string[]; calls: string[][] };
  return { runner, read };
}

test('Claude Code: already registered is left alone; missing is registered once with the panel\'s own command line', async t => {
  const there = await fakeClaudeState(t, { servers: ['github', 'soft-hearts-next'] });
  const linked = await linkClaudeCode({ name: 'soft-hearts-next', launch, runner: there.runner, allowed: true, registeredBefore: false });
  assert.equal(linked.state, 'linked'); assert.match(linked.message, /已接上你的 Claude Code/);
  assert.deepEqual((await there.read()).calls, [['mcp', 'list']], 'not registered twice');
  const missing = await fakeClaudeState(t, { servers: ['soft-hearts-next-dev'] });
  const registered = await linkClaudeCode({ name: 'soft-hearts-next', launch, runner: missing.runner, allowed: true, registeredBefore: false });
  assert.equal(registered.state, 'registered');
  const state = await missing.read();
  assert.deepEqual(state.calls[1], registrationArguments(launch, 'soft-hearts-next'));
  assert.deepEqual(state.calls[1].slice(0, 6), ['mcp', 'add', '--transport', 'stdio', '--scope', 'user']);
  assert.ok(state.servers.includes('soft-hearts-next') && state.servers.includes('soft-hearts-next-dev'), 'the dev name is a different server');
  // The copyable text and the automatic registration are the same command line.
  const text = setupSnippets(launch, 'soft-hearts-next').claudeCode;
  for (const arg of registrationArguments(launch, 'soft-hearts-next')) assert.ok(text.includes(arg.includes(' ') ? `"${arg}"` : arg), arg);
});

test('Claude Code: a name the user removed is not added back; failures are only reported; test profiles never run claude', async t => {
  const removed = await fakeClaudeState(t, { servers: [] });
  const kept = await linkClaudeCode({ name: 'soft-hearts-next', launch, runner: removed.runner, allowed: true, registeredBefore: true });
  assert.equal(kept.state, 'removed'); assert.match(kept.message, /重新接上/);
  assert.equal((await removed.read()).calls.length, 1);
  const forced = await linkClaudeCode({ name: 'soft-hearts-next', launch, runner: removed.runner, allowed: true, registeredBefore: true, force: true });
  assert.equal(forced.state, 'registered', '「重新接上」 adds it again');
  const failing = await fakeClaudeState(t, { servers: [], failAdd: true });
  const failed = await linkClaudeCode({ name: 'soft-hearts-next', launch, runner: failing.runner, allowed: true, registeredBefore: false });
  assert.equal(failed.state, 'failed'); assert.match(failed.message, /复制下面的命令/);
  const broken = await fakeClaudeState(t, { servers: [], failList: true });
  assert.equal((await linkClaudeCode({ name: 'soft-hearts-next', launch, runner: broken.runner, allowed: true, registeredBefore: false })).state, 'failed');
  assert.deepEqual((await broken.read()).calls, [['mcp', 'list']], 'a failed list never leads to an add');
  assert.equal((await linkClaudeCode({ name: 'soft-hearts-next', launch, runner: null, allowed: true, registeredBefore: false })).state, 'missing');
  let ran = 0;
  const skipped = await linkClaudeCode({ name: 'soft-hearts-next', launch, runner: async () => { ran++; return { code: 0, stdout: '', stderr: '' }; }, allowed: false, registeredBefore: false });
  assert.equal(skipped.state, 'skipped'); assert.equal(ran, 0);
  const appData = 'C:\\Users\\me\\AppData\\Roaming';
  assert.equal(autoLinkAllowed(`${appData}\\soft-hearts-claude`, appData, {}, 'win32'), true);
  assert.equal(autoLinkAllowed(`${appData}\\SOFT-HEARTS-CLAUDE-DEV\\`, appData, {}, 'win32'), true);
  assert.equal(autoLinkAllowed(`${appData}\\soft-hearts-claude`, appData, { SOFT_HEARTS_CLAUDE_CODE_LINK: 'off' }, 'win32'), false);
  for (const profile of ['C:\\Temp\\soft-hearts-pretrial-1a2b', `${appData}\\soft-hearts`, `${appData}\\soft-hearts-claude\\nested`, 'C:\\Temp\\sh-agent-x'])
    assert.equal(autoLinkAllowed(profile, appData, {}, 'win32'), false, profile);
});

test('the list parser knows our line from a look-alike name and from output that is not a list', () => {
  const list = 'Checking MCP server health...\n\nsoft-hearts-next-dev: "C:\\a.exe" "b" - ✓ Connected\ngithub: npx -y gh - ✗ Failed to connect\n';
  assert.equal(listedInClaudeCode(list, 'soft-hearts-next'), false);
  assert.equal(listedInClaudeCode(list, 'soft-hearts-next-dev'), true);
  assert.equal(listedInClaudeCode('\u001b[32msoft-hearts-next\u001b[0m: "x" - ✓ Connected', 'soft-hearts-next'), true);
  assert.equal(listedInClaudeCode('No MCP servers configured. Use `claude mcp add` to add a server.', 'soft-hearts-next'), false);
  assert.equal(listedInClaudeCode('error: unknown command', 'soft-hearts-next'), null);
});

test('the host links once, a little after startup, only with 三方互通 on, and remembers what it registered', async t => {
  const dir = await directory(t);
  const calls: Array<[boolean, readonly string[]]> = [];
  const f = hostFixture(dir, async (force, autoRegistered) => { calls.push([force, [...autoRegistered]]); return { state: 'registered', name: 'soft-hearts-next', message: '已接上' }; });
  own(t, f.host);
  await f.host.init();
  const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); };
  await until(() => f.host.view().interconnect?.claudeCode.state === 'registered');
  assert.equal(f.host.view().interconnect?.claudeCode.message, '已接上');
  assert.deepEqual(calls, [[false, []]]);
  assert.deepEqual((await new InterconnectStore(dir).load()).autoRegistered, ['soft-hearts-next']);
  await f.host.relinkClaudeCode();
  assert.deepEqual(calls[1], [true, ['soft-hearts-next']]);
  await f.host.setInterconnect(false);
  assert.equal(f.host.view().interconnect?.claudeCode.state, 'idle');
  await assert.rejects(f.host.relinkClaudeCode());
});

// ---------------------------------------------------------------- the pet-frame operations

test('bridge: perception switches go through the pet window\'s own handlers as its main frame, nothing else does', async () => {
  const ipc: { handle(channel: string, handler: IpcHandler): void } = { handle: () => {} };
  const recorder = recordAgentOperations(ipc);
  const seen: Array<[string, number, unknown]> = [];
  for (const name of ['getSettings', 'getRuntimeState', 'getAudioReadingView', 'setRuntimeState', 'setAudioReadingIntent', 'rpsThrow'])
    ipc.handle(`desk:${name}`, (event: any, ...args: unknown[]) => { seen.push([name, event.sender.id, args[0]]);
      return name === 'getRuntimeState' ? { cameraSharing: true, cameraLocal: true, voiceInput: false, screenSharing: false }
        : name === 'getAudioReadingView' ? { sources: { 'system-audio': { music: { intent: false }, movie: { intent: true } } } } : undefined; });
  const operations = recorder.done();
  assert.ok(!operations.has('rpsThrow'));
  const win = (id: number) => ({ isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, webContents: { id, isDestroyed: () => false, send: () => {} } });
  const bridge = createHostBridge({ version: () => 't', controls: () => win(1), pet: () => win(2), operations, admit: (_guard: unknown, run: () => unknown) => run(),
    replyLatency: () => [], broadcast: () => {}, interconnected: () => true } as any);
  // I-036: the camera's two switches as well as "either is on".
  assert.deepEqual(bridge.perception!(), { camera: true, cameraImages: false, cameraPose: true, microphone: false, screen: false, systemAudio: { music: false, movie: true } });
  await bridge.setPerception!('microphone', true, [], () => {});
  // I-036: 「发图片」 and 「姿势识别」 are the pet window's own two switches; `camera` stays the old single one.
  await bridge.setPerception!('camera_images', true, [], () => {});
  await bridge.setPerception!('camera_pose', false, [], () => {});
  await bridge.setPerception!('camera', false, [], () => {});
  await bridge.setPerception!('system_audio', false, ['music', 'movie'], () => {});
  assert.deepEqual(seen.filter(entry => entry[0].startsWith('set')), [
    ['setRuntimeState', 2, { voiceInput: true }],
    ['setRuntimeState', 2, { cameraImages: true }],
    ['setRuntimeState', 2, { cameraLocal: false }],
    ['setRuntimeState', 2, { cameraSharing: false }],
    ['setAudioReadingIntent', 2, { source: 'system-audio', purpose: 'music', enabled: false }],
    ['setAudioReadingIntent', 2, { source: 'system-audio', purpose: 'movie', enabled: false }],
  ]);
  assert.deepEqual([...AGENT_PET_OPERATIONS].sort(), ['setAudioReadingIntent', 'setRuntimeState']);
  let closed = false;
  await assert.rejects(bridge.setPerception!('camera', true, [], () => { if (closed) throw new Error('channel_off'); closed = true; throw new Error('channel_off'); }));
  assert.equal(seen.filter(entry => entry[0] === 'setRuntimeState').length, 4, 'a closed channel never reaches the handler');
});
