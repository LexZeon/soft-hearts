// I-173. The check: every
// handbook item (read_handbook's categories, from shared/settings/capabilities.ts) is either changeable through the channel, or reachable on
// both sides of 三方互通 — the user's Claude (open_control_page, by page and by item, the item flashing there) and her chat (「带我去」 to the
// same page). Keys, paid and privacy switches and the never items included: navigation only. Synthetic data; no Electron, no Claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES, capabilityChannel } from '../shared/settings/capabilities';
import { handbookCategory } from '../shared/settings/capability-handbook';
import { AGENT_TOOLS } from '../shared/safety/agent-channel';
import { TAKE_ME_THERE, TAKE_ME_THERE_IDS, controlNavigateRequest, matchTakeMeThere, type TakeMeThereId } from '../shared/initiative/take-me-there';
import { TAKE_ME_THERE_PLACES } from '../shared/initiative/take-me-there-places';
import { CAPABILITY_PLACES } from '../shared/initiative/take-me-there-coverage';
import { capabilityAnchor, optionReachGaps, takeMeThereItem, type ReachInput } from '../shared/initiative/take-me-there-items';
import { controlPageRequest } from '../electron/safety/agent-channel/tools/control-page';
import { takeMeThereFocusElement } from '../src/initiative/TakeMeThere';
import { A, B, WORDS, makeWorld } from './helpers/app-tools-world';
import * as appTools from '../electron/safety/agent-channel/app-tools';
import { AgentToolRegistry } from '../electron/safety/agent-channel/registry';

/** What a user says for the pages that predate the place list (the places have their own names). */
const OLD_SAYINGS: Partial<Record<TakeMeThereId, string>> = {
  'task-folder': '帮我选一个工作文件夹', 'claude-tasks': '打开 Claude 任务', screen: '打开屏幕共享', camera: '打开摄像头', mic: '打开麦克风', listen: '打开一起听',
  'bailian-key': '百炼的密钥怎么填', 'fish-key': 'Drama 3 的 key 在哪填', 'voice-scheme': '帮我换个声音', 'delete-memory': '删除你的记忆', 'delete-data': '删除聊天记录',
  'import-character': '导入角色卡', 'import-model': '导入模型', 'her-folder': '给你一个文件夹', 'convert-character': '把你转成英文版', 'claude-assistant': '带我去 Claude 助手',
};
/** Her chat offers this page for some sentence: one of its names after 带我去, or the old page's sentence. */
function chatReaches(destination: TakeMeThereId): boolean {
  const names = (TAKE_ME_THERE_PLACES as Record<string, { names: readonly string[] }>)[destination]?.names ?? [];
  return names.some(name => matchTakeMeThere(`带我去${name}`) === destination) || (OLD_SAYINGS[destination] !== undefined && matchTakeMeThere(OLD_SAYINGS[destination]) === destination);
}
const CHANNEL_PAGES = (AGENT_TOOLS.find(tool => tool.name === 'open_control_page')!.inputSchema.properties.page as { enum: string[] }).enum;
const channelItem = (id: string): string | null => { try { return controlPageRequest({ item: id }).page; } catch { return null; } };
const real = (): ReachInput => ({
  items: CAPABILITIES.map(entry => ({ id: entry.id, label: entry.label, controls: entry.controls, ...(entry.ui ? { ui: true } : {}), changeable: capabilityChannel(entry) })),
  channelPages: CHANNEL_PAGES, channelItem, chatReaches,
});

test('every handbook item is changeable through the channel, or reachable on both sides (the user\'s Claude and her chat)', () => {
  assert.deepEqual(optionReachGaps(real()), [], '这些手册条目既不能通过通道改，也带不过去：在 take-me-there-coverage.ts 给它指一个去处（必要时在 take-me-there-places.ts 加一个），并让她的聊天能说出来。');
});

test('the check has teeth: a removed place, a page missing from the channel, a page her chat cannot say, and a refused item are each noticed', () => {
  const base = real();
  const item = (id: string) => base.items.find(entry => entry.id === id)!;
  assert.ok(!item('tts_fish_key').changeable && !item('speech_beats').changeable, 'the items tonight were about cannot be changed through the channel');
  // 2026-11-24: her own voice and the Drama 3 limit can now be changed through the channel (a spending one: the words and the dialog).
  assert.ok(item('character_voice').changeable && item('tts_fish_cap').changeable);
  assert.match(optionReachGaps({ ...base, items: [{ id: 'a_new_switch', controls: ['#a-new-switch'], changeable: false }] }).join('\n'), /a_new_switch.*没有「带我去」/u);
  assert.match(optionReachGaps({ ...base, channelPages: base.channelPages.filter(page => page !== 'fish-key') }).join('\n'), /tts_fish_key.*不在 open_control_page/u);
  // 2026-11-24: character_voice is changeable through the channel now, so the Drama 3 key's page stands in for "a page her chat cannot say".
  assert.match(optionReachGaps({ ...base, chatReaches: destination => destination !== 'fish-key' && chatReaches(destination) }).join('\n'), /tts_fish_key.*聊天里给不出/u);
  assert.match(optionReachGaps({ ...base, channelItem: id => id === 'speech_beats' ? null : channelItem(id) }).join('\n'), /speech_beats.*没有打开/u);
  // Something the channel can change needs no place (the rule is "either … or"); the interface itself is not an item.
  assert.deepEqual(optionReachGaps({ ...base, items: [{ id: 'x', controls: [], changeable: true }, { id: 'y', controls: [], ui: true, changeable: false }] }), []);
});

test('tonight\'s items: her own voice, the Drama 3 key, deleting a card and the chat page each have their page and anchor', () => {
  const at = (id: string) => takeMeThereItem(CAPABILITIES.find(entry => entry.id === id)!);
  assert.deepEqual(at('character_voice'), { destination: 'character-voice', anchor: null }, '「她的声音」 flashes its whole panel');
  assert.deepEqual(at('tts_fish_key'), { destination: 'fish-key', anchor: 'tts-fish-key' });
  assert.deepEqual(at('tts_key'), { destination: 'bailian-key', anchor: 'tts-api-key' });
  assert.deepEqual(at('asr_key'), { destination: 'voice-input', anchor: 'asr-key' });
  assert.deepEqual(at('character_delete'), { destination: 'delete-character', anchor: null }, 'the tile\'s 「更多」, not the editor\'s button further down');
  assert.equal(at('chat_itself')?.destination, 'chat-page');
  assert.equal(at('network_settings')?.destination, 'chat-page');
  assert.equal(at('ui_navigation'), null, 'the interface itself has no page');
  // Her chat says the same pages.
  assert.equal(matchTakeMeThere('帮我删除小雨这个角色'), 'delete-character');
  assert.equal(matchTakeMeThere('怎么删除角色卡片'), 'delete-character');
  assert.equal(matchTakeMeThere('删除角色的记忆'), 'delete-memory', 'deleting memories keeps its own page');
  assert.equal(matchTakeMeThere('不要删除角色'), null);
  assert.equal(matchTakeMeThere('带我去她的声音'), 'character-voice');
  assert.equal(matchTakeMeThere('Claude 助手在哪'), 'claude-assistant');
  assert.equal(matchTakeMeThere('我刚用 Claude 助手问了个问题'), null, 'a mention without a request is not a button');
  // The check found it: 别 inside 识别 read as "no", so the voice-input page (and its key) had no sentence at all.
  assert.equal(matchTakeMeThere('带我去识别方式'), 'voice-input');
  assert.equal(matchTakeMeThere('语音识别在哪里设置'), 'voice-input');
  assert.equal(matchTakeMeThere('别打开摄像头'), null, 'a real 别 still says no');
});

test('every page of 「带我去」 is in open_control_page\'s list, has a sentence her chat answers, and the old opt-out of the chat page is gone', () => {
  assert.deepEqual([...CHANNEL_PAGES].sort(), [...TAKE_ME_THERE_IDS].sort(), 'the catalog lists exactly the pages that exist');
  for (const id of TAKE_ME_THERE_IDS) assert.ok(chatReaches(id), `${id}: no sentence makes her offer 「带我去：${TAKE_ME_THERE[id].title}」`);
  for (const id of ['chat_itself', 'network_settings', 'character_delete', 'character_voice', 'tts_fish_key', 'tts_fish_cap', 'speech_beats', 'claude_tasks', 'reset_settings'])
    assert.equal(typeof CAPABILITY_PLACES[id], 'string', `${id} must point at a page`);
});

test('anchors are plain element ids only; a pattern or a data attribute flashes the section', () => {
  assert.equal(capabilityAnchor(['#tts-fish-key', '#tts-fish-clear-key']), 'tts-fish-key');
  assert.equal(capabilityAnchor(['#character-voice-*']), null);
  assert.equal(capabilityAnchor(['[data-recycle=days]', '@local-asr 「下载」']), null);
  assert.equal(capabilityAnchor(['#a"b', '#ok']), 'ok');
  for (const entry of CAPABILITIES) { const place = takeMeThereItem(entry); if (place?.anchor) assert.match(place.anchor, /^[A-Za-z][A-Za-z0-9_-]*$/u, entry.id); }
});

test('the handbook names where each item is: goTo on every item with a page, and the write line of the ones the channel cannot change says how to get there', () => {
  const goTo = (entry: (typeof CAPABILITIES)[number]) => takeMeThereItem(entry)?.destination ?? null;
  const items = (['window', 'chat', 'characters', 'appearance', 'memory', 'providers', 'agent', 'privacy'] as const)
    .flatMap(category => handbookCategory(category, { interconnect: true, value: () => undefined, goTo }).items);
  assert.ok(items.length > 80);
  for (const item of items) {
    const entry = CAPABILITIES.find(value => value.id === item.id)!;
    if (!goTo(entry)) continue;
    assert.deepEqual(item.goTo, { page: goTo(entry), how: `open_control_page {"item":"${item.id}"}` }, item.id);
    if (!item.channel) assert.match(item.write, /open_control_page \{"item":/u, `${item.id}: the write line must say how to take the user there`);
  }
  const key = items.find(item => item.id === 'tts_fish_key')!;
  assert.equal(key.channel, false);
  assert.match(key.write, /不开放.*open_control_page \{"item":"tts_fish_key"\}/u);
});

test('navigation never changes anything: every page and every item through open_control_page only opens the page (keys never read)', async () => {
  const args = [...TAKE_ME_THERE_IDS.map(page => ({ page })), ...CAPABILITIES.filter(entry => takeMeThereItem(entry)).map(entry => ({ item: entry.id })),
    { item: 'character_delete', character: B }];
  for (const call of args) {
    const world = makeWorld(), before = JSON.stringify([world.state.settings, world.state.cards, world.state.host, world.state.perception, world.state.recycle]);
    const registry = new AgentToolRegistry(appTools.createAppTools(world.bridge, world.options), { enabled: () => true, interconnect: () => true, confirm: async () => true,
      now: () => 0, confirmTimeoutMs: 1000, runTimeoutMs: 1000 });
    const result = await registry.call('open_control_page', { ...call, userWords: WORDS });
    assert.ok(result.ok, JSON.stringify(call));
    assert.deepEqual(world.ops.map(op => (op as { op: string }).op), ['openControlPage'], `${JSON.stringify(call)}: only the page opens`);
    assert.equal(JSON.stringify([world.state.settings, world.state.cards, world.state.host, world.state.perception, world.state.recycle]), before, `${JSON.stringify(call)}: nothing changed`);
    assert.doesNotMatch(JSON.stringify(result), /••••|apiKey|fishApiKey/u, 'no key, not even masked');
  }
});

test('the host request keeps only a known page, a plain element id and a card id; the window looks things up by id only', async () => {
  assert.equal(controlNavigateRequest('nowhere', { anchor: 'x' }), null);
  assert.deepEqual(controlNavigateRequest('fish-key', { anchor: 'tts-fish-key' }), { destination: 'fish-key', anchor: 'tts-fish-key' });
  assert.deepEqual(controlNavigateRequest('fish-key', { anchor: '#tts-fish-key', character: '../x' }), { destination: 'fish-key' }, 'a selector or a path is dropped');
  assert.deepEqual(controlNavigateRequest('delete-character', { character: A.toUpperCase() }), { destination: 'delete-character', character: A });
  assert.deepEqual(controlNavigateRequest('mic', 'tts-fish-key'), { destination: 'mic' });
  const seen: string[] = [];
  const el = (name: string) => ({ name }) as unknown as HTMLElement;
  const ports = { byId: (id: string) => { seen.push(`id:${id}`); return id === 'missing' ? null : el(id); }, revealCardMenu: async (id: string) => { seen.push(`card:${id}`); return el(`menu-${id}`); } };
  assert.equal(((await takeMeThereFocusElement({ anchor: 'tts-fish-key' }, 'emotional-voice', ports)) as unknown as { name: string }).name, 'tts-fish-key');
  assert.equal(((await takeMeThereFocusElement({ anchor: 'missing' }, 'emotional-voice', ports)) as unknown as { name: string }).name, 'emotional-voice', 'a missing element: the section');
  assert.equal(((await takeMeThereFocusElement({ anchor: 'a b' }, 'messages', ports)) as unknown as { name: string }).name, 'messages');
  assert.equal(((await takeMeThereFocusElement({ character: A }, 'character-wall', ports)) as unknown as { name: string }).name, `menu-${A}`);
  seen.length = 0;
  await takeMeThereFocusElement({ character: 'not-a-card' }, 'character-wall', ports);
  assert.deepEqual(seen, ['id:character-wall'], 'a malformed card id never reaches the page');
});
