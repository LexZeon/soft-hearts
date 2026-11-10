import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import type { AppSettings } from '../shared/contracts';
import type { CharacterCardState } from '../shared/character-cards';
import {
  AGENT_NEVER_EXPOSED, AGENT_SETTINGS, AGENT_TOOLS, agentOptionsCard, validateAgentSettingValue,
} from '../shared/agent-channel';
import { AgentToolRegistry, stripSecretFields, type AgentAuditEntry, type AgentConfirmRequest, type AgentToolDefinition } from '../electron/agent-channel/registry';
import { argsObject, cardId, inspectLocalFile, localFilePath, type FileSystemPort } from '../electron/agent-channel/validate';
import { createAppTools, settingViews, type AgentAppBridge } from '../electron/agent-channel/app-tools';
import { sanitizeAuditEntry } from '../electron/agent-channel/audit';
import { createHostBridge, recordAgentOperations, AGENT_HOST_OPERATIONS, type IpcHandler } from '../electron/agent-channel/bridge';

const tick = () => new Promise(resolve => setImmediate(resolve));
const CARD_A = '0f8fad5b-d9cb-469f-a165-70867728950e', CARD_B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

function registryFixture(definitions: AgentToolDefinition[], overrides: Partial<ConstructorParameters<typeof AgentToolRegistry>[1]> = {}) {
  const audit: AgentAuditEntry[] = [], notices: string[] = [], asked: AgentConfirmRequest[] = [], signals: AbortSignal[] = [];
  let answer: (value: boolean) => void = () => {};
  let enabled = true;
  const registry = new AgentToolRegistry(definitions, {
    enabled: () => enabled,
    confirm: (request, signal) => { asked.push(request); signals.push(signal); return new Promise<boolean>(resolve => { answer = resolve; }); },
    notice: (_tool, title) => notices.push(title),
    audit: entry => audit.push(entry),
    confirmTimeoutMs: 250,
    ...overrides,
  });
  return { registry, audit, notices, asked, signals, answer: (value: boolean) => answer(value), setEnabled: (value: boolean) => { enabled = value; } };
}

function tool(name: string, tier: AgentToolDefinition['tier'], run: () => unknown = () => ({ ran: name })): AgentToolDefinition {
  return { name, title: name, tier, validate: raw => argsObject(raw, ['x']), run,
    ...(tier === 'confirm' ? { confirmation: () => ({ title: `确认 ${name}`, detail: '细节' }) } : {}) };
}

test('validators reject malformed arguments, ids, settings values and paths', () => {
  for (const bad of [[], 'x', 1, new Date(), Object.create({ x: 1 }), { extra: 1 }]) assert.throws(() => argsObject(bad, ['x']));
  assert.deepEqual(argsObject(undefined, []), {});
  for (const bad of ['', 'abc', `${CARD_A}x`, 42, null, '../etc/passwd']) assert.throws(() => cardId(bad));
  assert.equal(cardId(CARD_A.toUpperCase()), CARD_A);
  const volume = AGENT_SETTINGS.find(setting => setting.id === 'readout_volume')!;
  for (const bad of [-1, 101, 50.5, '50', true, null]) assert.throws(() => validateAgentSettingValue(volume, bad));
  assert.equal(validateAgentSettingValue(volume, 60), 60);
  const fps = AGENT_SETTINGS.find(setting => setting.id === 'fps')!;
  assert.throws(() => validateAgentSettingValue(fps, 45));
  assert.equal(validateAgentSettingValue(fps, 60), 60);
  for (const bad of ['relative\\a.json', '\\\\server\\share\\a.json', '//server/a.json', 'C:\\a.txt', 'C:\\a\u0000.json', 'C:a.json', 5])
    assert.throws(() => localFilePath(bad, ['.json'], 'win32'), String(bad));
  assert.equal(localFilePath('C:\\Users\\me\\..\\me\\card.JSON', ['.json'], 'win32'), 'C:\\Users\\me\\card.JSON');
  for (const bad of ['card.json', '//host/card.json', '/tmp/card.txt', '/tmp/\ncard.json']) assert.throws(() => localFilePath(bad, ['.json'], 'linux'));
  assert.equal(localFilePath('/home/me/model.pmx', ['.pmx', '.pmd'], 'linux'), '/home/me/model.pmx');
});

test('registry: read runs directly, reversible shows a notice first, never-tier tools are absent', async () => {
  const order: string[] = [];
  const f = registryFixture([
    tool('read_tool', 'read', () => { order.push('read'); return { ok: 1 }; }),
    tool('rev_tool', 'reversible', () => { order.push('run'); return { ok: 2 }; }),
    tool('secret_tool', 'never', () => { order.push('never'); return { apiKey: 'sk-live' }; }),
  ], { notice: (_tool, title) => order.push(`notice:${title}`) });
  assert.deepEqual(f.registry.names(), ['read_tool', 'rev_tool']);
  assert.deepEqual(await f.registry.call('read_tool', {}), { ok: true, result: { ok: 1 } });
  assert.deepEqual(await f.registry.call('rev_tool', {}), { ok: true, result: { ok: 2 } });
  assert.deepEqual(order, ['read', 'notice:rev_tool', 'run']);
  const hidden = await f.registry.call('secret_tool', {});
  assert.equal(hidden.ok, false);
  assert.equal(!hidden.ok && hidden.error.code, 'unknown_tool');
  assert.ok(!order.includes('never'));
  const bad = await f.registry.call('read_tool', { nope: 1 });
  assert.equal(!bad.ok && bad.error.code, 'invalid_input');
});

test('registry: a channel that is off refuses everything before validation or any side effect', async () => {
  let ran = 0;
  const f = registryFixture([tool('read_tool', 'read', () => ++ran)]);
  f.setEnabled(false);
  const result = await f.registry.call('read_tool', {});
  assert.equal(!result.ok && result.error.code, 'channel_off');
  assert.equal(ran, 0);
  assert.equal(f.audit.at(-1)?.outcome, 'denied');
});

test('registry: confirm runs only on an explicit allow; deny, timeout and busy never run', async () => {
  let runs = 0;
  const f = registryFixture([tool('ask_tool', 'confirm', () => ({ runs: ++runs }))]);
  const denied = f.registry.call('ask_tool', {});
  await tick(); assert.equal(f.asked.length, 1); assert.equal(f.asked[0].title, '确认 ask_tool');
  f.answer(false);
  assert.equal(((await denied) as any).error.code, 'denied_by_user');
  const allowed = f.registry.call('ask_tool', {});
  await tick(); f.answer(true);
  assert.deepEqual(await allowed, { ok: true, result: { runs: 1 } });
  // No answer: the timeout denies, aborts the dialog, and a late "allow" changes nothing.
  const timedOut = await f.registry.call('ask_tool', {});
  assert.equal(!timedOut.ok && timedOut.error.code, 'confirm_timeout');
  assert.equal(f.signals.at(-1)?.aborted, true);
  f.answer(true); await tick();
  assert.equal(runs, 1);
  // A second request while a dialog is open is refused, not queued.
  const first = f.registry.call('ask_tool', {});
  await tick();
  const second = await f.registry.call('ask_tool', {});
  assert.equal(!second.ok && second.error.code, 'confirm_busy');
  f.answer(false); await first;
  assert.equal(runs, 1);
  // Turning the channel off while the dialog is open voids the allow.
  const late = f.registry.call('ask_tool', {});
  await tick(); f.setEnabled(false); f.answer(true);
  assert.equal(((await late) as any).error.code, 'channel_off');
  assert.equal(runs, 1);
});

test('registry: confirm-tier definitions must carry dialog text; tierFor can only raise the tier', async () => {
  assert.throws(() => new AgentToolRegistry([{ name: 'x', title: 'x', tier: 'confirm', validate: () => ({}), run: () => 1 }], { enabled: () => true, confirm: async () => true }));
  let runs = 0;
  const f = registryFixture([{ ...tool('raise', 'reversible', () => ++runs), tierFor: () => 'confirm', confirmation: () => ({ title: 't', detail: 'd' }) },
    { ...tool('lower', 'confirm', () => ++runs), tierFor: () => 'read' }]);
  const raised = f.registry.call('raise', {}); await tick();
  assert.equal(f.asked.length, 1); f.answer(false); await raised;
  const lowered = f.registry.call('lower', {}); await tick();
  assert.equal(f.asked.length, 2, 'a lower per-request tier never skips the dialog'); f.answer(false); await lowered;
  assert.equal(runs, 0);
});

test('audit records tool, tier, outcome and duration only: never arguments, results, secrets or chat text', async () => {
  const secret = 'sk-ant-SECRET-1234', chat = '我今天好难过，别告诉别人', path = 'C:\\Users\\me\\private\\card.json';
  const f = registryFixture([tool('read_tool', 'read', () => ({ apiKey: secret, nested: { token: secret, text: chat } }))]);
  const result = await f.registry.call('read_tool', { x: `${secret} ${chat} ${path}` });
  assert.deepEqual(result, { ok: true, result: { nested: { text: chat } } }, 'secret-named fields are stripped from results');
  await f.registry.call(`${secret}`, { x: chat });
  const lines = f.audit.map(entry => JSON.stringify(sanitizeAuditEntry(entry))).join('\n');
  for (const forbidden of [secret, chat, path, 'private']) assert.ok(!lines.includes(forbidden), forbidden);
  for (const entry of f.audit) assert.deepEqual(Object.keys(sanitizeAuditEntry(entry)).sort().filter(key => key !== 'code'), ['at', 'ms', 'outcome', 'tier', 'tool']);
  assert.equal(f.audit[1].tool, 'unknown');
  assert.deepEqual(sanitizeAuditEntry({ at: 'x', tool: 'evil tool\n' + secret, tier: 'root' as any, outcome: 'pwned' as any, code: 'a b' as any, ms: NaN }),
    { at: 'x', tool: 'unknown', tier: 'none', outcome: 'failed', ms: 0 });
  assert.deepEqual(stripSecretFields([{ password: 1, Authorization: 2, keep: 3 }]), [{ keep: 3 }]);
});

test('the catalog exposes exactly the host tools, no never-tier tool, and plain-data settings metadata', () => {
  const tools = createAppTools(fakeBridge().bridge);
  // I-014: the host itself defines undo_last_action and set_interconnect (agent-channel/host.ts).
  const hostOwned = ['set_interconnect', 'undo_last_action'];
  assert.deepEqual([...tools.map(item => item.name), ...hostOwned].sort(), AGENT_TOOLS.map(item => item.name).sort());
  for (const item of AGENT_TOOLS) {
    assert.notEqual(item.tier as string, 'never');
    if (!hostOwned.includes(item.name)) assert.equal(tools.find(entry => entry.name === item.name)!.tier, item.tier, item.name);
    assert.equal(item.inputSchema.additionalProperties, false);
    assert.match(item.title, /[\u4e00-\u9fff]/);
    // I-014: the one deleting tool moves memories into the recycle bin, and exists only with \u4e09\u65b9\u4e92\u901a on.
    if (item.name === 'delete_memories') { assert.equal(item.interconnectOnly, true); continue; }
    assert.doesNotMatch(item.name, /delete|remove|key|secret|token|shell|exec|command|file_(read|write)|permission/);
  }
  assert.ok(AGENT_NEVER_EXPOSED.length >= 5);
  for (const setting of AGENT_SETTINGS) {
    assert.match(setting.label, /[\u4e00-\u9fff]/); assert.ok(setting.description.length > 4);
    assert.ok(['read', 'reversible', 'confirm'].includes(setting.tier));
    if (setting.kind === 'number') { assert.ok(setting.min < setting.max && setting.unit && setting.presets.length); }
    else for (const choice of setting.choices) assert.match(choice.label, /[\u4e00-\u9fff]/);
  }
  const card = agentOptionsCard({ ...AGENT_SETTINGS.find(setting => setting.id === 'fps')!, value: 30 } as any, '<b>帧率</b>');
  assert.equal(card.prompt, '<b>帧率</b>', 'agent text stays plain text; the renderer must set it as textContent');
  assert.deepEqual(card.options.map(option => [option.value, option.current]), [[24, false], [30, true], [60, false]]);
  assert.equal(JSON.stringify(card), JSON.stringify(JSON.parse(JSON.stringify(card))), 'plain JSON data only');
});

function fakeBridge(initial: Partial<AppSettings> = {}) {
  let settings: AppSettings = { ...structuredClone(DEFAULT_SETTINGS), ...initial };
  settings.provider = { ...settings.provider, apiKey: 'sk-should-never-leave' } as any;
  const cards: CharacterCardState = { activeId: CARD_A, cards: [
    { id: CARD_A, name: '小桃', modelName: 'Gene', persona: '私密人设正文' } as any,
    { id: CARD_B, name: '阿澄', persona: '另一段人设' } as any] };
  const calls: unknown[][] = [];
  let controls = { visible: true, minimized: false } as { visible: boolean; minimized: boolean } | null;
  const commit = async () => ({ persistence: 'saved' as const, presentation: 'applied' });
  const bridge: AgentAppBridge = {
    version: () => '0.1.0',
    settings: () => structuredClone(settings),
    characters: () => structuredClone(cards),
    windows: () => ({ pet: { visible: true, minimized: false }, controls }),
    activateCharacter: async id => { calls.push(['activate', id]); cards.activeId = id; },
    bindCurrentModel: async id => { calls.push(['bind', id]); (cards.cards.find(card => card.id === id) as any).modelName = settings.model?.name; },
    setPetVisible: async visible => { calls.push(['visible', visible]); settings.pet.visible = visible; },
    saveSettings: async next => { calls.push(['save', next.voice.enabled, next.pet.fps]); settings = structuredClone(next); },
    commitPetBoolean: async (value, actionId) => { calls.push([actionId, value]); return commit(); },
    commitReadoutVolume: async percent => { calls.push(['volume', percent]); settings.voice.volume = percent / 100; return commit(); },
    commitBreath: async percent => { calls.push(['breath', percent]); return { persistence: 'not-committed', presentation: 'not-requested' }; },
    importCharacterCard: async content => { calls.push(['import', content]); cards.cards.push({ id: CARD_B.replace('7c', '8c'), name: '新卡' } as any); return structuredClone(cards); },
    loadModel: async file => { calls.push(['load', file]); settings.model = { path: file, url: 'local://x', name: 'm.pmx' } as any; return { name: 'm.pmx' }; },
    rendererAction: action => { calls.push(['renderer', action]); return true; },
    diagnostics: () => ({ replyLatency: [{ status: 'complete', firstContentMs: 900, firstVisibleMs: 1000, firstSentenceVisibleMs: 1100, streamEndMs: 2000, allVisibleMs: 2100, chars: 40, deltas: 9, provider: 'claude', text: '不该出现' } as any], petWindow: { enabled: true, entries: 3 } }),
    memory: () => ({ rss: 200 * 1048576, heapUsed: 50 * 1048576 }),
    uptimeSeconds: () => 12,
  };
  return { bridge, calls, settings: () => settings, cards, hideControls: () => { controls = null; } };
}

async function runTool(tools: AgentToolDefinition[], name: string, args: unknown, allow = true) {
  const asked: AgentConfirmRequest[] = [];
  const registry = new AgentToolRegistry(tools, { enabled: () => true, confirm: async request => { asked.push(request); return allow; } });
  return { result: await registry.call(name, args), asked };
}

test('app tools: read tools return curated data only, never persona text, keys or chat text', async () => {
  const f = fakeBridge();
  const tools = createAppTools(f.bridge);
  const all = JSON.stringify(await Promise.all(['get_status', 'list_characters', 'list_settings', 'get_diagnostics'].map(name => runTool(tools, name, {}))));
  for (const forbidden of ['sk-should-never-leave', '私密人设正文', '另一段人设', '不该出现', 'apiKey']) assert.ok(!all.includes(forbidden), forbidden);
  const status = (await runTool(tools, 'get_status', {})).result as any;
  assert.equal(status.result.character.name, '小桃');
  assert.equal(status.result.voice.provider, 'system');
  const diagnostics = (await runTool(tools, 'get_diagnostics', {})).result as any;
  assert.equal(diagnostics.result.replyLatency.medianFirstVisibleMs, 1000);
  assert.deepEqual(diagnostics.result.memoryMb, { rss: 200, heapUsed: 50 });
  const listed = (await runTool(tools, 'list_settings', {})).result as any;
  // 三方互通 off (this bridge has no `interconnected`): the interconnect-only settings are not listed.
  assert.deepEqual(listed.result.settings.map((setting: any) => [setting.id, setting.value]),
    settingViews(f.settings(), f.bridge.characters()).filter(setting => !setting.interconnectOnly).map(setting => [setting.id, setting.value]));
  assert.ok(!listed.result.settings.some((setting: any) => setting.id === 'voice_provider' || setting.id === 'recycle_bin_days'));
});

test('app tools: reversible tools call the existing host paths and report failures honestly', async () => {
  const f = fakeBridge();
  const tools = createAppTools(f.bridge);
  assert.equal(((await runTool(tools, 'activate_character', { id: CARD_B })).result as any).result.name, '阿澄');
  assert.equal(((await runTool(tools, 'activate_character', { id: '0f8fad5b-d9cb-469f-a165-000000000000' })).result as any).error.code, 'invalid_input');
  assert.deepEqual(((await runTool(tools, 'set_read_aloud', { state: 'off' })).result as any).result, { readAloud: false });
  assert.equal(((await runTool(tools, 'set_read_aloud', { state: 'maybe' })).result as any).error.code, 'invalid_input');
  assert.equal(((await runTool(tools, 'set_setting', { id: 'readout_volume', value: 30 })).result as any).result.value, 30);
  assert.equal(((await runTool(tools, 'set_setting', { id: 'fps', value: 60 })).result as any).result.value, 60);
  assert.equal(((await runTool(tools, 'set_setting', { id: 'provider', value: 'x' })).result as any).error.code, 'invalid_input');
  assert.equal(((await runTool(tools, 'set_setting', { id: 'breath', value: 20 })).result as any).error.code, 'unavailable', 'an uncommitted save is not reported as success');
  assert.equal(((await runTool(tools, 'play_preview', { kind: 'shy' })).result as any).ok, true);
  assert.equal(((await runTool(tools, 'show_pet', {})).result as any).ok, true);
  assert.deepEqual(f.calls.filter(call => call[0] !== 'save'), [['activate', CARD_B], ['volume', 30], ['breath', 20],
    ['renderer', { kind: 'play-preview', recipe: 'shy' }], ['visible', true]]);
  f.hideControls();
  assert.equal(((await runTool(tools, 'play_preview', { kind: 'surprise' })).result as any).error.code, 'unavailable');
});

test('app tools: confirm tools show the exact request, run only when allowed, and re-check the confirmed file', async () => {
  let size = 120;
  const fs: FileSystemPort = { realpath: async file => file, stat: async () => ({ isFile: () => true, size, mtimeMs: 1 }) };
  const f = fakeBridge();
  const tools = createAppTools(f.bridge, { fs, platform: 'win32', readText: async () => '{"name":"新卡"}' });
  const denied = await runTool(tools, 'import_character_card', { path: 'C:\\cards\\new.json' }, false);
  assert.match(denied.asked[0].detail, /new\.json/); assert.match(denied.asked[0].detail, /C:\\cards/);
  assert.equal((denied.result as any).error.code, 'denied_by_user');
  assert.ok(!f.calls.some(call => call[0] === 'import'));
  const imported = await runTool(tools, 'import_character_card', { path: 'C:\\cards\\new.json' });
  assert.equal((imported.result as any).result.imported.name, '新卡');
  assert.deepEqual(f.calls.find(call => call[0] === 'import'), ['import', '{"name":"新卡"}']);
  size = 2_000_000;
  assert.equal(((await runTool(tools, 'import_character_card', { path: 'C:\\cards\\big.json' })).result as any).error.code, 'invalid_input');
  size = 5_000;
  assert.equal(((await runTool(tools, 'load_model', { path: 'C:\\m\\model.vmd' })).result as any).error.code, 'invalid_input');
  const model = await runTool(tools, 'load_model', { path: 'C:\\m\\model.pmx' });
  assert.match(model.asked[0].detail, /model\.pmx/);
  assert.deepEqual(f.calls.find(call => call[0] === 'load'), ['load', 'C:\\m\\model.pmx']);
  const bind = await runTool(tools, 'bind_current_model_to_character', { id: CARD_B });
  assert.match(bind.asked[0].detail, /阿澄/); assert.match(bind.asked[0].detail, /m\.pmx/);
  assert.deepEqual(f.calls.find(call => call[0] === 'bind'), ['bind', CARD_B]);
  // A file changed between the dialog and the run is refused.
  let changes = 0;
  const shifting: FileSystemPort = { realpath: async file => file, stat: async () => ({ isFile: () => true, size: 10, mtimeMs: ++changes }) };
  const raced = await runTool(createAppTools(f.bridge, { fs: shifting, platform: 'win32', readText: async () => '{}' }), 'import_character_card', { path: 'C:\\cards\\x.json' });
  assert.equal((raced.result as any).error.code, 'unavailable');
  assert.equal(f.calls.filter(call => call[0] === 'import').length, 1);
});

test('app tools: voice preview always asks and names a paid Bailian call', async () => {
  const f = fakeBridge({ tts: { ...(DEFAULT_SETTINGS.tts ?? {}), provider: 'bailian' } as any });
  const preview = await runTool(createAppTools(f.bridge), 'voice_preview', {});
  assert.equal(preview.asked.length, 1);
  assert.match(preview.asked[0].detail, /付费/);
  assert.deepEqual(f.calls.at(-1), ['renderer', { kind: 'voice-preview' }]);
  const g = fakeBridge();
  const free = await runTool(createAppTools(g.bridge), 'voice_preview', {}, false);
  assert.match(free.asked[0].detail, /免费/);
  assert.ok(!g.calls.some(call => call[0] === 'renderer'));
});

test('bridge: records only whitelisted handlers, restores ipcMain, and calls them as the control window main frame', async () => {
  const registered = new Map<string, IpcHandler>();
  const ipc = { handle(channel: string, handler: IpcHandler) { registered.set(channel, handler); } };
  const prototypeHandle = ipc.handle;
  const recorder = recordAgentOperations(ipc);
  const controls = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false,
    webContents: { id: 7, isDestroyed: () => false, send: (...args: unknown[]) => sent.push(args) } };
  const pet = { ...controls, webContents: { ...controls.webContents, id: 8 } };
  const sent: unknown[][] = [];
  // The same gate as main.ts scopedHost: known window, main frame, control window only.
  const gate = (operation: (sender: number, ...args: any[]) => unknown): IpcHandler => (event, ...args) => {
    const allowed = [controls, pet].find(win => win.webContents.id === event.sender.id);
    if (!allowed || event.senderFrame !== event.sender.mainFrame || allowed !== controls) throw new Error('请求来源未授权。');
    return operation(event.sender.id, ...args);
  };
  const seen: unknown[][] = [];
  for (const name of [...AGENT_HOST_OPERATIONS, 'deleteCharacterCard', 'exportCharacterCard', 'saveTtsKey'])
    ipc.handle(`desk:${name}`, gate((sender, ...args) => { seen.push([name, sender, ...args]); return name === 'getSettings' ? structuredClone(DEFAULT_SETTINGS) : { cards: [], activeId: '' }; }));
  const operations = recorder.done();
  ipc.handle('desk:getSettings', () => 'late');
  assert.deepEqual([...operations.keys()].sort(), [...AGENT_HOST_OPERATIONS].sort());
  assert.equal(registered.size, AGENT_HOST_OPERATIONS.length + 3, 'real registration still happens for every method');
  assert.equal(ipc.handle, prototypeHandle);
  const admitted: string[] = [];
  const bridge = createHostBridge({ version: () => '1', controls: () => controls, pet: () => pet, operations,
    admit: (guard, run) => { admitted.push('admit'); return run(); },
    importCharacterCard: async () => ({ cards: [], activeId: '' }), loadModel: async () => ({ name: 'm' } as any),
    commitPetBoolean: async () => ({ persistence: 'saved', presentation: 'applied' }), commitReadoutVolume: async () => ({ persistence: 'saved', presentation: 'x' }),
    commitBreath: async () => ({ persistence: 'saved', presentation: 'x' }), replyLatency: () => [], broadcast: (...args) => sent.push(args) });
  const open = () => {};
  await bridge.activateCharacter(CARD_A, open);
  await bridge.saveSettings(structuredClone(DEFAULT_SETTINGS), open);
  assert.deepEqual(seen.map(row => row.slice(0, 3)), [['activateCharacterCard', 7, CARD_A], ['saveSettings', 7, DEFAULT_SETTINGS], ['getSettings', 7]]);
  assert.deepEqual(admitted, ['admit', 'admit'], 'changing operations run under the call guard; reads do not');
  // A closed call never reaches the handler.
  const closed = () => { throw new Error('closed'); };
  await assert.rejects(bridge.setPetVisible(true, closed), /closed/);
  assert.equal(seen.some(row => row[0] === 'setPetVisible'), false);
  assert.equal((sent.at(-1) as unknown[])[0], 'desk:settings', 'an agent save is echoed to the control window too');
  assert.equal(bridge.rendererAction({ kind: 'voice-preview' }), true);
  assert.deepEqual(sent.at(-1), ['desk:agent-channel-action', { kind: 'voice-preview' }]);
});

test('the MCP shim, the host and the wire agree on names that keep this edition apart from the Codex edition', async () => {
  const shim = await import('../scripts/soft-hearts-mcp.mjs');
  const credentials = await import('../electron/agent-channel/credentials');
  const profile = await import('../electron/profile');
  assert.equal(shim.PROFILE_FOLDER, profile.PROFILE_FOLDER);
  assert.equal(shim.PIPE_PREFIX, credentials.AGENT_PIPE_PREFIX);
  assert.ok(!credentials.AGENT_PIPE_PREFIX.startsWith('\\\\.\\pipe\\soft-hearts-agent'));
  const identity = new URL('../scripts/lib/app-identity.mjs', import.meta.url);
  const exists = await readFile(identity).then(() => true, () => false);
  if (exists) {
    const app = await import(identity.href);
    assert.equal(credentials.AGENT_EDITION, app.PACKAGE_NAME);
    assert.notEqual(credentials.AGENT_EDITION, app.CODEX_EDITION.packageName);
    assert.ok([app.STABLE_PROFILE_FOLDER, app.DEVELOPMENT_PROFILE_FOLDER].includes(shim.PROFILE_FOLDER));
  }
  const one = credentials.agentEndpoint('C:\\Users\\a\\AppData\\Roaming\\soft-hearts-claude', 'win32', 'me');
  const dev = credentials.agentEndpoint('C:\\Users\\a\\AppData\\Roaming\\soft-hearts-claude-dev', 'win32', 'me');
  const other = credentials.agentEndpoint('C:\\Users\\a\\AppData\\Roaming\\soft-hearts-claude', 'win32', 'someone');
  assert.match(one, /^\\\\\.\\pipe\\soft-hearts-next-agent-[a-f0-9]{12}$/);
  assert.notEqual(one, dev); assert.notEqual(one, other);
  // Host and shim derive the same pipe from one shared function, case-insensitively like Windows.
  const wire = await import('../scripts/agent-channel-wire.mjs');
  assert.equal(wire.agentPipeName('Me', 'c:\\users\\a\\appdata\\roaming\\SOFT-HEARTS-CLAUDE\\'), one);
});

test('the pipe is bound to its profile: a token file copied from another profile is ignored by the app and refused by the shim', async () => {
  const credentials = await import('../electron/agent-channel/credentials');
  const shim = await import('../scripts/soft-hearts-mcp.mjs');
  const { mkdir, mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { readFileSync } = await import('node:fs');
  const os = await import('node:os'), path = await import('node:path');
  const root = await mkdtemp(path.join(os.tmpdir(), 'sh-bind-'));
  try {
    const stable = path.join(root, 'soft-hearts-claude'), dev = path.join(root, 'soft-hearts-claude-dev');
    const file = (endpoint: string) => JSON.stringify({ version: 1, edition: 'soft-hearts-next', endpoint, token: 'a'.repeat(64), createdAt: 'x' });
    const read = () => readFileSync(path.join(dev, credentials.AGENT_CREDENTIALS_FILE), 'utf8');
    await mkdir(dev, { recursive: true });
    // What a stable -> development copy left behind before the seeding fix (7c093fa): stable's pipe in dev's folder.
    await writeFile(path.join(dev, credentials.AGENT_CREDENTIALS_FILE), file(credentials.agentEndpoint(stable, 'win32', 'tester')));
    assert.equal(await new credentials.AgentCredentialStore(dev, 'win32', 'tester').read(), null, 'the dev app does not turn its channel on from it');
    assert.throws(() => shim.readCredentials(dev, 'win32', read, 'tester'), (error: any) => error.code === 'channel_off' && /不属于这个配置目录/.test(error.message));
    // Another user's pipe for the same folder is refused too; the folder's own pipe is accepted by both.
    await writeFile(path.join(dev, credentials.AGENT_CREDENTIALS_FILE), file(credentials.agentEndpoint(dev, 'win32', 'someone')));
    assert.equal(await new credentials.AgentCredentialStore(dev, 'win32', 'tester').read(), null);
    const own = credentials.agentEndpoint(dev, 'win32', 'tester');
    await writeFile(path.join(dev, credentials.AGENT_CREDENTIALS_FILE), file(own));
    assert.equal((await new credentials.AgentCredentialStore(dev, 'win32', 'tester').read())?.endpoint, own);
    assert.equal(shim.readCredentials(dev, 'win32', read, 'tester').endpoint, own);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('registration text: options before the name, one quoted launch line, and valid desktop JSON with Windows paths', async () => {
  const { agentServerName, setupSnippets } = await import('../electron/agent-channel/setup-text');
  const launch = { command: 'C:\\Users\\me\\soft hearts next\\soft hearts next.exe',
    args: ['C:\\Users\\me\\soft hearts next\\resources\\agent-channel\\soft-hearts-mcp.mjs', '--profile', 'C:\\Users\\me\\AppData\\Roaming\\soft-hearts-claude'],
    env: { ELECTRON_RUN_AS_NODE: '1' } };
  assert.equal(agentServerName('C:\\Users\\me\\AppData\\Roaming\\soft-hearts-claude'), 'soft-hearts-next');
  assert.equal(agentServerName('C:\\Users\\me\\AppData\\Roaming\\soft-hearts-claude-dev\\'), 'soft-hearts-next-dev');
  const text = setupSnippets(launch, 'soft-hearts-next');
  assert.equal(text.claudeCode, 'claude mcp add --transport stdio --scope user --env=ELECTRON_RUN_AS_NODE=1 soft-hearts-next -- '
    + '"C:\\Users\\me\\soft hearts next\\soft hearts next.exe" "C:\\Users\\me\\soft hearts next\\resources\\agent-channel\\soft-hearts-mcp.mjs" "--profile" "C:\\Users\\me\\AppData\\Roaming\\soft-hearts-claude"');
  assert.deepEqual(JSON.parse(text.desktopConfig), { mcpServers: { 'soft-hearts-next': launch } });
  assert.ok(!/token|[a-f0-9]{64}/.test(text.claudeCode + text.desktopConfig), 'the token stays in the profile file');
});
