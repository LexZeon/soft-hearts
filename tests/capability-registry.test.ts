// I-025: the capability list (shared/capabilities.ts), its control patterns (shared/capability-controls.ts) and the handbook
// generated from it (shared/capability-handbook.ts, the channel's read_handbook). The browser scan of the settings window is
// tests/capability-coverage.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import type { AppSettings } from '../shared/contracts';
import type { CharacterCardState } from '../shared/character-cards';
import { AGENT_SETTINGS, AGENT_TOOLS, agentSetting } from '../shared/agent-channel';
import {
  CAPABILITIES, CAPABILITY_CATEGORIES, capabilityChannel, capabilityGap, capabilityHow, capabilityPatterns, capabilitySetting, capabilityValues,
} from '../shared/capabilities';
import {
  controlMatches, describeControl, parseControlPattern, unregisteredControls, unusedPatterns, type ControlDescriptor,
} from '../shared/capability-controls';
import { handbookCategory, handbookIndex } from '../shared/capability-handbook';
import { AgentToolRegistry } from '../electron/agent-channel/registry';
import { createAppTools, type AgentAppBridge } from '../electron/agent-channel/app-tools';

const CARD = '0f8fad5b-d9cb-469f-a165-70867728950e';
/** Tools the host defines itself (agent-channel/host.ts). */
const HOST_OWNED = ['undo_last_action', 'set_interconnect'];

test('the list: unique ids, known categories, patterns that parse, and a reason wherever something is not open', () => {
  const ids = CAPABILITIES.map(entry => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const entry of CAPABILITIES) {
    assert.ok(Object.hasOwn(CAPABILITY_CATEGORIES, entry.category), entry.id);
    assert.match(entry.label, /[\u4e00-\u9fff]/u, entry.id);
    assert.ok(entry.description.length > 4, entry.id);
    for (const pattern of entry.controls) assert.doesNotThrow(() => parseControlPattern(pattern), `${entry.id}: ${pattern}`);
    if (entry.level === 'never' || entry.ui) { assert.ok(entry.reason && entry.reason.length > 4, `${entry.id} 不开放要写原因`); assert.equal(entry.channel, undefined, entry.id); }
    if (capabilityGap(entry)) assert.ok(entry.reason, `${entry.id} 还不能三方改，要写原因`);
    assert.ok(capabilityValues(entry), `${entry.id} 取值`);
  }
});

test('every setting and every changing tool of the channel is in the list (a new one cannot be left out)', () => {
  for (const spec of AGENT_SETTINGS)
    assert.equal(CAPABILITIES.filter(entry => capabilitySetting(entry)?.id === spec.id).length, 1, `set_setting ${spec.id} 要在清单里有且只有一项`);
  const used = new Set(CAPABILITIES.flatMap(entry => [...(entry.channel && 'tool' in entry.channel ? [entry.channel.tool] : []), ...(entry.alsoTools ?? [])]));
  for (const tool of AGENT_TOOLS.filter(item => item.tier !== 'read' && item.name !== 'set_setting'))
    assert.ok(used.has(tool.name), `通道工具 ${tool.name} 要在清单里`);
  for (const name of used) assert.ok(AGENT_TOOLS.some(tool => tool.name === name), `清单里的 ${name} 不是通道工具`);
});

test('levels agree with the channel catalog: confirm tier is "需要用户原话", the rest is direct', () => {
  for (const entry of CAPABILITIES.filter(capabilityChannel)) {
    const channel = entry.channel!;
    const tier = 'setting' in channel ? agentSetting(channel.setting)!.tier : AGENT_TOOLS.find(tool => tool.name === channel.tool)!.tier;
    // A setting's `confirmWhen` values (更真实的情绪 on, the microphone on, the recognizer's download) escalate to confirm.
    // set_perception escalates to confirm when it opens a sense (app-tools tierFor).
    const escalates = 'setting' in channel ? !!agentSetting(channel.setting)!.confirmWhen?.length : channel.tool === 'set_perception';
    const expected = tier === 'confirm' || escalates ? 'user-words' : 'direct';
    assert.equal(entry.level, expected, entry.id);
  }
  // Keys and running commands are never open, and nothing open mentions a key.
  for (const id of ['asr_key', 'tts_key', 'claude_tasks', 'claude_code_link', 'reset_settings', 'character_delete', 'memory_delete_one'])
    assert.equal(CAPABILITIES.find(entry => entry.id === id)?.level, 'never', id);
  for (const entry of CAPABILITIES.filter(capabilityChannel)) assert.doesNotMatch(entry.label, /密钥|API Key/u, entry.id);
});

const control = (extra: Partial<ControlDescriptor>): ControlDescriptor => ({ tag: 'input', type: 'checkbox', id: '', label: '', data: {}, within: [], ...extra });

test('control patterns: ids, prefixes, areas, data attributes, words and tags; typos throw', () => {
  const sw = control({ id: 'click-through', label: '鼠标穿透', within: ['privacy-window', 'tab-privacy', 'app'] });
  assert.ok(controlMatches(parseControlPattern('#click-through'), sw));
  assert.ok(controlMatches(parseControlPattern('#click-*'), sw));
  assert.ok(controlMatches(parseControlPattern('@privacy-window input'), sw));
  assert.ok(!controlMatches(parseControlPattern('@privacy-window button'), sw));
  assert.ok(!controlMatches(parseControlPattern('#click'), sw));
  const button = control({ tag: 'button', type: 'button', label: '下载', within: ['local-asr', 'providers-asr'] });
  assert.ok(controlMatches(parseControlPattern('@local-asr 「下载」'), button));
  assert.ok(!controlMatches(parseControlPattern('@pose-sensing 「下载」'), button));
  assert.ok(!controlMatches(parseControlPattern('@local-asr 「下」'), button));
  assert.ok(controlMatches(parseControlPattern('@local-asr 「下*」'), button));
  const data = control({ tag: 'button', data: { 'agent-channel': 'copy-claude-code' } });
  assert.ok(controlMatches(parseControlPattern('[data-agent-channel=copy-*]'), data));
  assert.ok(controlMatches(parseControlPattern('[data-agent-channel]'), data));
  assert.ok(!controlMatches(parseControlPattern('[data-agent-channel=undo]'), data));
  for (const bad of ['', 'click-through', '#', '#a #b', '@', '「」', '[data-=x]', '[data-x=]', 'div', 'button input'])
    assert.throws(() => parseControlPattern(bad), bad);
});

test('the check itself: an unregistered control is reported and a stale pattern too (without a browser)', () => {
  const page = [control({ id: 'click-through', within: ['privacy-window'] }), control({ id: 'brand-new-switch', label: '新开关', within: ['privacy-window'] })];
  const patterns = ['#click-through', '#removed-switch'].map(parseControlPattern);
  assert.deepEqual(unregisteredControls(page, patterns).map(describeControl), ['@privacy-window input:checkbox #brand-new-switch —「新开关」']);
  assert.deepEqual(unusedPatterns(page, patterns).map(pattern => pattern.source), ['#removed-switch']);
  // Every pattern of the real list is accounted for exactly once per entry.
  assert.equal(capabilityPatterns().length, CAPABILITIES.reduce((sum, entry) => sum + entry.controls.length, 0));
});

function bridge(interconnect = true): AgentAppBridge {
  const settings: AppSettings = { ...structuredClone(DEFAULT_SETTINGS), model: { path: 'C:\\m\\gene.pmx', url: 'local://gene', name: 'Gene' } as any };
  settings.voice = { ...settings.voice, enabled: true, volume: 0.6 };
  const cards: CharacterCardState = { activeId: CARD, cards: [{ id: CARD, name: '菲菲', personality: '私密人设正文' } as any] };
  const fail = async () => { throw new Error('not in this test'); };
  return {
    version: () => '0.1.0', settings: () => structuredClone(settings), characters: () => structuredClone(cards),
    windows: () => ({ pet: { visible: true, minimized: false }, controls: { visible: true, minimized: false } }),
    activateCharacter: fail, bindCurrentModel: fail, setPetVisible: fail, saveSettings: fail, commitPetBoolean: fail, commitReadoutVolume: fail,
    commitBreath: fail, importCharacterCard: fail, loadModel: fail, rendererAction: () => false,
    diagnostics: () => ({ replyLatency: [], petWindow: { enabled: false, entries: 0 } }),
    interconnected: () => interconnect,
    perception: () => ({ camera: false, microphone: true, screen: false, systemAudio: { music: false, movie: false } }),
  };
}
async function handbook(args: unknown, interconnect = true): Promise<{ ok: boolean; result?: any; error?: { code: string } }> {
  const registry = new AgentToolRegistry(createAppTools(bridge(interconnect)), { enabled: () => true, interconnect: () => interconnect, confirm: async () => false });
  return registry.call('read_handbook', args);
}

test('read_handbook without a category: the rules, the levels and every category with its counts', async () => {
  const result = await handbook({});
  assert.ok(result.ok);
  const index = result.result as ReturnType<typeof handbookIndex>;
  assert.equal(index.interconnect, true);
  assert.deepEqual(index.categories.map(item => item.id), ['window', 'chat', 'characters', 'appearance', 'memory', 'providers', 'agent', 'privacy']);
  assert.ok(index.rules.some(rule => /userWords/u.test(rule)), 'the rule for the user\'s own words');
  const providers = index.categories.find(item => item.id === 'providers')!;
  assert.ok(providers.items >= 10 && providers.channel >= 4 && providers.never >= 2);
  assert.deepEqual(index, structuredClone(index), 'plain data');
});

test('read_handbook by category: current values, how to read and change, user words, chat; never the interface-only entries', async () => {
  const result = await handbook({ category: 'providers' });
  assert.ok(result.ok);
  const page = result.result as ReturnType<typeof handbookCategory>;
  const item = (id: string) => { const found = page.items.find(entry => entry.id === id); assert.ok(found, id); return found; };
  assert.equal(item('read_aloud').now, true);
  assert.equal(item('readout_volume').now, 60);
  assert.match(item('read_aloud').write, /set_setting \{"id":"read_aloud"/u);
  assert.equal(item('read_aloud').chat, true);
  assert.equal(item('voice_preview').needsUserWords, true);
  assert.equal(item('tts_key').level, 'never');
  assert.equal(item('tts_key').now, null);
  assert.equal(item('tts_key').channel, false);
  assert.ok(!page.items.some(entry => entry.id === 'tts_guides' || entry.id === 'voice_preview_controls'), 'interface-only entries are left out');
  const privacy = (await handbook({ category: 'privacy' })).result as ReturnType<typeof handbookCategory>;
  assert.equal(privacy.items.find(entry => entry.id === 'voice_input')!.now, true);
  assert.equal(privacy.items.find(entry => entry.id === 'interconnect')!.now, true);
  for (const category of Object.keys(CAPABILITY_CATEGORIES)) {
    const answer = await handbook({ category });
    assert.ok(answer.ok, category);
    const text = JSON.stringify(answer.result);
    assert.ok(Buffer.byteLength(text) < 40 * 1024, `${category} fits in one tool result`);
    assert.doesNotMatch(text, /私密人设正文|C:\\\\m\\\\gene/u, 'no persona text, no model path');
  }
});

test('read_handbook with 三方互通 off: no user-words requirement, no sensed state, interconnect-only settings unread', async () => {
  const privacy = (await handbook({ category: 'privacy' }, false)).result as ReturnType<typeof handbookCategory>;
  assert.equal(privacy.interconnect, false);
  assert.equal(privacy.items.find(entry => entry.id === 'voice_input')!.now, null);
  assert.equal(privacy.items.find(entry => entry.id === 'recycle_bin_days')!.now, null);
  const providers = (await handbook({ category: 'providers' }, false)).result as ReturnType<typeof handbookCategory>;
  assert.ok(providers.items.every(entry => !entry.needsUserWords));
  const refused = await handbook({ category: 'everything' });
  assert.ok(!refused.ok && refused.error?.code === 'invalid_input');
  assert.ok(!(await handbook({ category: 'providers', extra: 1 })).ok);
});

test('the handbook is generated from the list: an entry added to the list shows up, with no handbook text to edit', () => {
  const extra = { id: 'new_thing', label: '一个新功能', description: '为了测试加的一项。', category: 'privacy' as const, values: '开 / 关', level: 'direct' as const,
    controls: [], reason: '还没有通道接口。' };
  const page = handbookCategory('privacy', { interconnect: true, value: () => undefined }, [...CAPABILITIES, extra]);
  const found = page.items.find(entry => entry.id === 'new_thing');
  assert.ok(found);
  assert.equal(found.channel, false);
  assert.match(found.write, /还不能/u);
  assert.equal(capabilityHow(extra).write, found.write);
});
