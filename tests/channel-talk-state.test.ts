/**
 * 2026-11-07 (docs/claude/2026-11-07-channel-talk-state.md): the setting 「她主动找你说话」 on the channel, in her chat and in the saved
 * settings; the read-only get_her_state; and the unbind_character_model undo that its description promised.
 * Real createHostBridge / createAppTools over fake IPC handlers. The rhythm itself is measured in tests/proactive-talk.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import type { AppSettings } from '../shared/contracts';
import { AGENT_SETTINGS, AGENT_TOOLS, validateAgentSettingValue } from '../shared/agent-channel';
import { CAPABILITIES, capabilityChannel } from '../shared/capabilities';
import { herStateWords, sinceWords } from '../shared/her-state-words';
import { AgentToolRegistry } from '../electron/agent-channel/registry';
import { createAppTools } from '../electron/agent-channel/app-tools';
import { createHostBridge, type IpcHandler } from '../electron/agent-channel/bridge';
import { chatSettingApplier, chatSettingsSystemText, currentSettingsText, parseChatSettingProposal, turnSettingsMentioned, ChatSettingProposals } from '../electron/chat-settings';
import { validateSettings } from '../electron/validation';

const CARD = '0f8fad5b-d9cb-469f-a165-70867728950e';
const MINUTE = 60_000;

interface Options { mood?: unknown; model?: boolean }
function host(options: Options = {}) {
  let settings: AppSettings = { ...structuredClone(DEFAULT_SETTINGS), model: { path: 'C:\\m\\aoi.pmx', url: 'local://aoi', name: 'aoi.pmx' } as any };
  const cards = { activeId: CARD, cards: [{ id: CARD, name: '小桃', modelName: 'aoi.pmx' } as any] };
  const calls: Array<[string, ...unknown[]]> = [];
  const handlers: Record<string, (...args: any[]) => unknown> = {
    getSettings: () => structuredClone(settings),
    saveSettings: next => { calls.push(['saveSettings']); settings = structuredClone(next); return settings; },
    getCharacterCards: () => structuredClone(cards),
    bindCharacterModel: (id, enabled) => {
      calls.push(['bindCharacterModel', id, enabled]);
      if (!enabled) delete cards.cards[0].modelName; else cards.cards[0].modelName = settings.model!.name;
      return cards;
    },
    getMood: () => options.mood ?? null,
  };
  const operations = new Map<string, IpcHandler>(Object.entries(handlers).map(([name, run]) => [name, (_event: any, ...args: unknown[]) => run(...args)]));
  const window = (id: number) => ({ isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, webContents: { id, isDestroyed: () => false, send() {} } });
  const bridge = createHostBridge({ version: () => '0', controls: () => window(11), pet: () => window(12), operations,
    admit: (guard, run) => { guard(); return run(); }, importCharacterCard: async () => { throw new Error('x'); },
    loadModel: async file => { settings = { ...settings, model: { path: file, url: 'local://x', name: 'aoi.pmx' } as any }; return settings.model!; },
    commitPetBoolean: async () => { throw new Error('x'); }, commitReadoutVolume: async () => { throw new Error('x'); }, commitBreath: async () => { throw new Error('x'); },
    replyLatency: () => [], broadcast: () => {}, interconnected: () => true });
  const tools = createAppTools({ ...bridge, now: () => NOW });
  const asked: unknown[] = [];
  let undo: { label: string; run(guard: () => void): unknown } | undefined;
  const registry = new AgentToolRegistry(tools, { enabled: () => true, interconnect: () => true,
    confirm: async request => { asked.push(request); return true; }, notice: () => {}, called: (_summary, offer) => { if (offer) undo = offer; } });
  return { call: (name: string, args: unknown): Promise<any> => registry.call(name, args), tools, settings: () => settings, asked, undo: () => undo, calls, cards,
    setModel: (path: string) => { settings = { ...settings, model: { path, url: 'local://x', name: 'aoi.pmx' } as any }; } };
}
const NOW = new Date('2026-11-07T15:00:00').getTime();

// ---------------------------------------------------------------- 3. 她主动找你说话

test('proactive_talk: in the catalog with a clear Chinese title, three choices, reversible, no words needed, default 适中', () => {
  const spec = AGENT_SETTINGS.find(item => item.id === 'proactive_talk')!;
  assert.ok(spec);
  assert.equal(spec.label, '她主动找你说话');
  assert.equal(spec.kind, 'enum'); assert.equal(spec.tier, 'reversible');
  assert.deepEqual((spec as any).choices.map((c: any) => [c.value, c.label]), [['less', '少一点'], ['normal', '适中（默认）'], ['more', '多一点']]);
  assert.equal(spec.confirmWhen, undefined, 'not a privacy or paid setting: no consent');
  assert.match(spec.description, /上限|一个都不放宽/u);
  assert.equal(DEFAULT_SETTINGS.proactiveTalk, 'normal');
  assert.ok(capabilityChannel(CAPABILITIES.find(entry => entry.id === 'proactive_talk')!), 'the handbook lists it');
  assert.deepEqual(['less', 'normal', 'more'].map(v => validateAgentSettingValue(spec, v)), ['less', 'normal', 'more']);
  assert.throws(() => validateAgentSettingValue(spec, 'lots'));
});

test('proactive_talk through the channel: read, set with no dialog and no words, saved, undone', async () => {
  const h = host();
  const listed = (await h.call('list_settings', {})).result.settings.find((item: any) => item.id === 'proactive_talk');
  assert.equal(listed.value, 'normal');
  const set = await h.call('set_setting', { id: 'proactive_talk', value: 'less' });
  assert.ok(set.ok, JSON.stringify(set));
  assert.equal(h.settings().proactiveTalk, 'less');
  assert.deepEqual(h.asked, [], 'no dialog');
  assert.equal((await h.call('list_settings', {})).result.settings.find((item: any) => item.id === 'proactive_talk').value, 'less');
  const back = h.undo()!;
  assert.match(back.label, /她主动找你说话/u);
  await back.run(() => {});
  assert.equal(h.settings().proactiveTalk, 'normal');
  assert.equal((await h.call('set_setting', { id: 'proactive_talk', value: 'many' })).ok, false);
  assert.equal(h.settings().proactiveTalk, 'normal');
});

test('her chat: "你少说点话吧" brings the setting into that turn only, and a proposal for it is a normal card', async () => {
  const fixed = chatSettingsSystemText();
  assert.ok(!fixed.includes('proactive_talk'), 'her fixed prompt does not grow');
  for (const text of ['你少说点话吧', '话少一点', '能不能多说点话', '你自己多找我聊聊', '她太安静了', '别太话痨']) {
    const named = turnSettingsMentioned(text);
    assert.ok(named.some(spec => spec.id === 'proactive_talk'), text);
  }
  assert.ok(!turnSettingsMentioned('朗读的语速慢一点').some(spec => spec.id === 'proactive_talk'));
  const turn = new ChatSettingProposals({ settings: () => structuredClone(DEFAULT_SETTINGS), send: () => {} }).beginTurn('你少说点话吧')!.instruction!('<s>', '</s>');
  assert.match(turn, /proactive_talk="normal"/u);
  const current = currentSettingsText(structuredClone(DEFAULT_SETTINGS), AGENT_SETTINGS, undefined, undefined, spec => spec.id === 'proactive_talk');
  assert.match(current, /proactive_talk=/u);
  const now = (id: string) => id === 'proactive_talk' ? 'normal' : null;
  const proposal = parseChatSettingProposal('{"id":"proactive_talk","value":"less","choices":["more"],"reason":"你说话太多了"}', now)!;
  assert.deepEqual([proposal.spec.id, proposal.value, proposal.options], ['proactive_talk', 'less', ['less', 'more']]);
  assert.equal(parseChatSettingProposal('{"id":"proactive_talk","value":"normal"}', now), null, 'already there');
  assert.equal(parseChatSettingProposal('{"id":"proactive_talk","value":"silent"}', now), null, 'not a choice');
  // The tap goes through the same set_setting as the channel.
  const h = host();
  const applied = await chatSettingApplier(h.tools, { confirm: async () => { throw new Error('no dialog expected'); } })('proactive_talk', 'more');
  assert.ok(applied.ok, JSON.stringify(applied));
  assert.equal(h.settings().proactiveTalk, 'more');
});

test('saved settings: an older file has none and reads as 适中; unknown values read as 适中; a stored choice is kept', () => {
  const old = structuredClone(DEFAULT_SETTINGS) as any; delete old.proactiveTalk;
  assert.equal(validateSettings(old).proactiveTalk, 'normal');
  for (const bad of ['LESS', 3, null, {}, 'lots', '']) assert.equal(validateSettings({ ...old, proactiveTalk: bad }).proactiveTalk, 'normal');
  assert.equal(validateSettings({ ...old, proactiveTalk: 'less' }).proactiveTalk, 'less');
  assert.equal(validateSettings({ ...old, proactiveTalk: 'more' }).proactiveTalk, 'more');
});

test('the settings page has a short labelled select with the three choices', () => {
  const layout = readFileSync(new URL('../src/ui/layout.ts', import.meta.url), 'utf8');
  const select = /<select id="proactive-talk"[^>]*>(.*?)<\/select>/su.exec(layout);
  assert.ok(select, 'the select is on the page');
  assert.deepEqual([...select![1].matchAll(/<option value="(\w+)">([^<]+)</gu)].map(m => [m[1], m[2]]), [['less', '少一点'], ['normal', '适中（默认）'], ['more', '多一点']]);
  assert.match(layout, /<h3>她主动找你说话<\/h3>/u);
});

// ---------------------------------------------------------------- 4. 她现在怎么样

const MOOD = {
  characterId: CARD, developerMode: false,
  parameters: { baseline: { D: 50, O: 50, E: 50, N: 50, C: 30 }, persona: '这段不该出现的人设正文' },
  snapshot: { primary: 'happy', values: { D: 78, O: 55, E: 66, N: 52, C: 30 }, phase: 'idle', lastInteractionAt: NOW - 35 * MINUTE,
    reason: '用户说“我爱你”所以开心（聊天原文不该出现）' },
  fatigue: { phase: 'light-drowsy' },
  herLife: { activity: 'humming', since: NOW - MINUTE, until: NOW + MINUTE, source: 'rules' },
  userState: { note: '用户的私密画像文字' },
};

test('get_her_state: a synthetic mood, tiredness and activity come back as plain words', async () => {
  const h = host({ mood: MOOD });
  const result = await h.call('get_her_state', {});
  assert.ok(result.ok, JSON.stringify(result));
  const state = result.result;
  assert.deepEqual(state.mood, { label: '愉快', strength: '强' });
  assert.equal(state.sleepiness, '有点困');
  assert.equal(state.doing, '轻轻哼歌（没出声）');
  assert.equal(state.sinceLastInteraction, '半个小时左右');
  assert.equal(state.character, '小桃');
  assert.deepEqual(AGENT_TOOLS.find(tool => tool.name === 'get_her_state')!.tier, 'read');
});

test('get_her_state never carries chat, diary, profile or persona text, nor raw numbers', async () => {
  const h = host({ mood: MOOD });
  const text = JSON.stringify((await h.call('get_her_state', {})).result);
  for (const secret of ['我爱你', '聊天原文', '私密画像', '人设正文', '78', '66', 'happy', 'humming', 'light-drowsy']) assert.ok(!text.includes(secret), `${secret} leaked: ${text}`);
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['character', 'doing', 'mood', 'note', 'sinceLastInteraction', 'sleepiness']);
});

test('get_her_state words: calm has no strength, being patted beats her own activity, nothing known says so, and it works with no developer mode', () => {
  const calm = herStateWords({ ...MOOD, snapshot: { ...MOOD.snapshot, primary: 'calm' } }, NOW);
  assert.deepEqual(calm.mood, { label: '平静', strength: null });
  assert.equal(herStateWords({ ...MOOD, snapshot: { ...MOOD.snapshot, phase: 'rua' } }, NOW).doing, '正被你摸头');
  assert.equal(herStateWords({ ...MOOD, herLife: { activity: 'company' } }, NOW).doing, '在你旁边待着');
  assert.equal(herStateWords({ ...MOOD, snapshot: { ...MOOD.snapshot, values: { D: 52, O: 50, E: 50, N: 50, C: 30 } } }, NOW).mood.strength, '轻');
  assert.equal(herStateWords({ ...MOOD, snapshot: { ...MOOD.snapshot, values: { D: 60, O: 50, E: 50, N: 50, C: 30 } } }, NOW).mood.strength, '中');
  const nothing = herStateWords({}, NOW);
  assert.deepEqual([nothing.mood.label, nothing.sleepiness, nothing.doing], ['看不出来', '看不出来', '在你旁边待着']);
  assert.equal(MOOD.developerMode, false);
  assert.equal(sinceWords(NOW - 30_000, NOW), '刚刚');
  assert.equal(sinceWords(NOW - 5 * 60 * MINUTE, NOW), '好几个小时前');
  assert.equal(sinceWords(null, NOW), '还没有互动过');
});

test('get_her_state: unreadable state is an honest "unavailable", not an invented mood', async () => {
  const h = host({ mood: null });
  const result = await h.call('get_her_state', {});
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result), /读不到她的状态/u);
});

// ---------------------------------------------------------------- 5. unbind undo

test('unbind_character_model: the undo it promises ties the same model back', async () => {
  const h = host();
  const unbound = await h.call('unbind_character_model', { id: CARD });
  assert.ok(unbound.ok);
  assert.equal(h.cards.cards[0].modelName, undefined);
  const back = h.undo();
  assert.ok(back, 'an undo is offered');
  assert.match(back!.label, /重新关联到「aoi\.pmx」/u);
  await back!.run(() => {});
  assert.equal(h.cards.cards[0].modelName, 'aoi.pmx');
  assert.deepEqual(h.calls.filter(call => call[0] === 'bindCharacterModel'), [['bindCharacterModel', CARD, false], ['bindCharacterModel', CARD, true]]);
});

test('unbind_character_model: if another model was loaded meanwhile, the undo refuses instead of tying the wrong file', async () => {
  const h = host();
  await h.call('unbind_character_model', { id: CARD });
  h.setModel('C:\\m\\other.pmx');
  await assert.rejects(Promise.resolve(h.undo()!.run(() => {})), /已经不是原来的那个/u);
  assert.equal(h.cards.cards[0].modelName, undefined, 'nothing was bound');
});

test('the catalog text for unbind no longer promises more than the undo does', () => {
  const tool = AGENT_TOOLS.find(item => item.name === 'unbind_character_model')!;
  assert.match(tool.description, /刚解除后可以用 undo_last_action/u);
  assert.match(tool.description, /前提是现在载入的还是原来那个模型/u);
});
