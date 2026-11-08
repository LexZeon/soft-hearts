// I-025 第 2 段: 语音输入 through all three ways,
// and the "需要用户原话" level: with 三方互通 on, a call needing consent must carry the user's own words
// from the conversation, or nothing happens; no dialog. Fake bridges and temp data only: nothing is downloaded, no real profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import type { AppSettings } from '../shared/contracts';
import type { LocalAsrView } from '../shared/local-asr';
import { AGENT_SETTINGS, AGENT_TOOLS } from '../shared/agent-channel';
import type { ChatSettingCardView } from '../shared/chat-settings';
import { buildJournalEntry, describeJournalEntry, readJournalLine } from '../shared/journal';
import { setUiLanguage } from '../shared/ui-language';
import { uiText } from '../src/ui/ui-language';
import { readChatSettingCard, renderChatSettingCard } from '../src/ui/ChatSettingCard';
import {
  AGENT_USER_WORDS_MISSING, AgentToolRegistry, type AgentAuditEntry, type AgentConfirmRequest, type AgentWordsUse,
} from '../electron/agent-channel/registry';
import { sanitizeAuditEntry } from '../electron/agent-channel/audit';
import { ASR_MODEL_BYTES, createAppTools, settingExtras, type AgentAppBridge } from '../electron/agent-channel/app-tools';
import { AGENT_HOST_OPERATIONS, createHostBridge, type IpcHandler } from '../electron/agent-channel/bridge';
import { SENSEVOICE_REPO } from '../electron/asr/manifest';
import { ChatSettingProposals, chatSettingApplier, chatSettingsSystemText, currentSettingsText, mentionsSettings } from '../electron/chat-settings';
import { handbookCategory } from '../shared/capability-handbook';

setUiLanguage('zh-CN');
const CARD = '0f8fad5b-d9cb-469f-a165-70867728950e';
const WORDS = '帮我把语音输入下载一下吧';
const DOWNLOAD = 355_000_000;

/** soft hearts as the channel sees it: settings, the pet, the microphone switch and the local recognizer (a state machine). */
function world(options: { phase?: LocalAsrView['phase']; pet?: boolean; interconnect?: boolean } = {}) {
  const settings: AppSettings = structuredClone(DEFAULT_SETTINGS);
  let mic = false, interconnect = options.interconnect ?? true;
  const asr: LocalAsrView = { phase: options.phase ?? 'not-installed', prompt: false, downloadBytes: DOWNLOAD, installedBytes: 0, progress: null,
    componentVersion: 1, notice: '' };
  const calls: string[] = [];
  const fail = async () => { throw new Error('not in this test'); };
  const bridge: AgentAppBridge = {
    version: () => '0.1.0', settings: () => structuredClone(settings),
    characters: () => ({ activeId: CARD, cards: [{ id: CARD, name: '菲菲' } as any] }),
    windows: () => ({ pet: { visible: options.pet ?? true, minimized: false }, controls: { visible: true, minimized: false } }),
    activateCharacter: fail, bindCurrentModel: fail, setPetVisible: fail, saveSettings: fail, commitPetBoolean: fail, commitReadoutVolume: fail,
    commitBreath: fail, importCharacterCard: fail, loadModel: fail, rendererAction: () => true,
    diagnostics: () => ({ replyLatency: [], petWindow: { enabled: false, entries: 0 } }),
    interconnected: () => interconnect,
    perception: () => ({ camera: false, microphone: mic, screen: false, systemAudio: { music: false, movie: false } }),
    setPerception: async (kind, enabled, _purposes, guard) => {
      guard(); calls.push(`${kind}:${enabled}`);
      // Like the host: voice input stays off while there is no recognizer (it raises the download question instead).
      if (kind === 'microphone') mic = enabled && (asr.phase === 'idle' || asr.phase === 'ready' || asr.phase === 'starting');
    },
    localAsr: () => structuredClone(asr),
    downloadLocalAsr: async guard => { guard(); calls.push('download'); asr.phase = 'downloading'; asr.progress = 0; },
    cancelLocalAsrDownload: async guard => { guard(); calls.push('cancel'); asr.phase = 'not-installed'; asr.progress = null; },
    removeLocalAsr: async guard => { guard(); calls.push('remove'); asr.phase = 'not-installed'; },
  };
  return { bridge, calls, asr, mic: () => mic, setInterconnect: (value: boolean) => { interconnect = value; } };
}

/** The undo offers set_setting leaves after it ran (the host keeps the last one for 撤回). */
async function undoOffers(w: ReturnType<typeof world>, args: unknown): Promise<string[]> {
  const tool = createAppTools(w.bridge).find(item => item.name === 'set_setting')!;
  const offers: string[] = [];
  await tool.run(tool.validate(args), { signal: new AbortController().signal, check: () => {}, offerUndo: offer => offers.push(offer.label) });
  return offers;
}

function channel(w: ReturnType<typeof world>, interconnect = true) {
  const asked: AgentConfirmRequest[] = [], notices: string[] = [], audit: AgentAuditEntry[] = [], used: AgentWordsUse[] = [];
  w.setInterconnect(interconnect);
  const registry = new AgentToolRegistry(createAppTools(w.bridge), {
    enabled: () => true, interconnect: () => interconnect,
    confirm: async request => { asked.push(request); return true; },
    notice: (_tool, title, detail) => notices.push(`${title}（${detail ?? ''}）`), audit: entry => audit.push(entry), wordsUsed: use => used.push(use),
  });
  return { call: (name: string, args: unknown): Promise<any> => registry.call(name, args), asked, notices, audit, used };
}

test('三方互通 on: a call that needs consent, without the user\'s own words, does nothing and opens no dialog', async () => {
  const w = world(), c = channel(w);
  for (const args of [{ id: 'local_asr', value: 'installed' }, { id: 'local_asr', value: 'installed', userWords: '   ' }]) {
    const result = await c.call('set_setting', args);
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'needs_user_words');
    assert.equal(result.error.message, AGENT_USER_WORDS_MISSING);
    assert.match(result.error.message, /userWords/u);
  }
  assert.deepEqual(w.calls, [], 'nothing downloaded');
  assert.deepEqual(c.asked, [], 'no dialog');
  assert.deepEqual(c.notices, []);
  assert.equal(c.audit.at(-1)!.code, 'needs_user_words');
  for (const bad of [42, 'x'.repeat(2001)]) {
    const result = await c.call('set_setting', { id: 'local_asr', value: 'installed', userWords: bad });
    assert.ok(!result.ok && result.error.code === 'invalid_input');
  }
  // The existing confirm-tier tools too (R46b changed: 三方互通 on no longer means "run at once").
  for (const [name, args] of [['voice_preview', {}], ['load_model', { path: 'C:\\m\\aoi.pmx' }], ['import_character_card', { path: 'C:\\c\\aoi.json' }]] as const) {
    const result = await c.call(name, args);
    assert.ok(!result.ok, name);
  }
});

test('with the user\'s words it runs at once: the notice says what and how much; the record keeps the item, the value and the length only', async () => {
  const w = world(), c = channel(w);
  const result = await c.call('set_setting', { id: 'local_asr', value: 'installed', userWords: `  ${WORDS}  ` });
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(w.calls, ['download']);
  assert.equal((result.result as any).value, 'downloading');
  assert.match((result.result as any).note, /进度在控制窗口/u);
  assert.deepEqual(c.asked, [], 'no dialog');
  assert.deepEqual(c.notices, ['调整设置（开始下载本机语音识别（约 355 MB，来自 Hugging Face））']);
  assert.deepEqual(c.used, [{ tool: 'set_setting', item: 'local_asr', value: 'installed', words: [...WORDS].length }]);
  const last = c.audit.at(-1)!;
  assert.equal(last.approval, 'user-words');
  assert.equal(last.words, [...WORDS].length);
  assert.deepEqual(sanitizeAuditEntry(last), { at: last.at, tool: 'set_setting', tier: 'confirm', outcome: 'allowed', approval: 'user-words', words: [...WORDS].length, ms: last.ms });
  const kept = JSON.stringify([c.audit, c.used, c.notices, result]);
  assert.ok(!kept.includes(WORDS) && !kept.includes('下载一下'), 'the words themselves are never kept');
  // A second "download" while it downloads changes nothing (no second download).
  assert.ok((await c.call('set_setting', { id: 'local_asr', value: 'installed', userWords: WORDS })).ok);
  assert.deepEqual(w.calls, ['download']);
});

test('三方互通 off: the dialog asks as before and names the size and the source; the words are optional', async () => {
  const w = world(), c = channel(w, false);
  const result = await c.call('set_setting', { id: 'local_asr', value: 'installed' });
  assert.ok(result.ok);
  assert.equal(c.asked.length, 1);
  assert.equal(c.asked[0].title, 'Claude 请求下载本机语音识别');
  for (const part of ['355 MB', 'Hugging Face', SENSEVOICE_REPO, `约 ${Math.round(ASR_MODEL_BYTES / 1e6)} MB`, '不上传']) assert.ok(c.asked[0].detail.includes(part), part);
  assert.deepEqual(w.calls, ['download']);
  assert.equal(c.audit.at(-1)!.approval, 'dialog');
  assert.deepEqual(c.used, [], 'no words, no words record');
});

test('local_asr: not-installed cancels a running download or removes the component; both need the words; nothing on unsupported computers', async () => {
  const downloading = world({ phase: 'downloading' }), c = channel(downloading);
  assert.equal((await c.call('set_setting', { id: 'local_asr', value: 'not-installed' })).ok, false);
  assert.ok((await c.call('set_setting', { id: 'local_asr', value: 'not-installed', userWords: '别下了' })).ok);
  assert.deepEqual(downloading.calls, ['cancel']);
  assert.match(c.notices.at(-1)!, /取消下载本机语音识别/u);
  const installed = world({ phase: 'idle' }), d = channel(installed);
  assert.ok((await d.call('set_setting', { id: 'local_asr', value: 'not-installed', userWords: '把识别组件删了吧' })).ok);
  assert.deepEqual(installed.calls, ['remove']);
  assert.match(d.notices.at(-1)!, /删除本机语音识别组件/u);
  // Nothing can undo a download or a removal by itself (撤回 never re-downloads or deletes).
  assert.deepEqual(await undoOffers(world(), { id: 'local_asr', value: 'installed' }), []);
  assert.deepEqual(await undoOffers(world({ phase: 'idle' }), { id: 'local_asr', value: 'not-installed' }), []);
  const unsupported = world({ phase: 'unsupported' }), e = channel(unsupported);
  const refused = await e.call('set_setting', { id: 'local_asr', value: 'installed', userWords: WORDS });
  assert.ok(!refused.ok && /用不了/u.test(refused.error.message));
  assert.deepEqual(unsupported.calls, []);
});

test('voice_input: on needs the words and the pet; it says when the recognizer is missing; off is direct', async () => {
  const missing = world(), c = channel(missing);
  assert.equal((await c.call('set_setting', { id: 'voice_input', value: true })).ok, false);
  const notInstalled = await c.call('set_setting', { id: 'voice_input', value: true, userWords: '打开语音输入' });
  assert.ok(!notInstalled.ok && /还没有下载（local_asr）/u.test(notInstalled.error.message), JSON.stringify(notInstalled));
  const ready = world({ phase: 'idle' }), d = channel(ready);
  assert.ok((await d.call('set_setting', { id: 'voice_input', value: true, userWords: '打开语音输入' })).ok);
  assert.equal(ready.mic(), true);
  assert.match(d.notices.at(-1)!, /打开语音输入（麦克风）/u);
  assert.deepEqual(d.used.at(-1), { tool: 'set_setting', item: 'voice_input', value: true, words: 6 });
  const off = await d.call('set_setting', { id: 'voice_input', value: false });
  assert.ok(off.ok, 'turning the microphone off needs nothing');
  assert.equal(ready.mic(), false);
  // 撤回 can turn it off again, never back on.
  const on = world({ phase: 'idle' });
  assert.deepEqual(await undoOffers(on, { id: 'voice_input', value: true }), ['把「语音输入（麦克风）」改回 关闭']);
  assert.deepEqual(await undoOffers(on, { id: 'voice_input', value: false }), [], '撤回 never turns the microphone back on');
  const hidden = world({ phase: 'idle', pet: false }), e = channel(hidden);
  const refused = await e.call('set_setting', { id: 'voice_input', value: true, userWords: '打开语音输入' });
  assert.ok(!refused.ok && /桌宠显示出来/u.test(refused.error.message));
});

test('list_settings and read_handbook tell the size and the source before anything is downloaded', async () => {
  const w = world(), c = channel(w);
  const listed = await c.call('list_settings', {});
  assert.ok(listed.ok);
  const local = (listed.result as any).settings.find((item: any) => item.id === 'local_asr');
  assert.equal(local.value, 'not-installed');
  const download = local.details.find((item: any) => item.value === 'installed').detail;
  for (const part of ['355 MB', 'Hugging Face', SENSEVOICE_REPO]) assert.ok(download.includes(part), part);
  const voice = (listed.result as any).settings.find((item: any) => item.id === 'voice_input');
  assert.equal(voice.value, false);
  const page = (await c.call('read_handbook', { category: 'providers' })).result as ReturnType<typeof handbookCategory>;
  const item = page.items.find(entry => entry.id === 'local_asr')!;
  assert.equal(item.level, 'user-words'); assert.equal(item.needsUserWords, true); assert.equal(item.channel, true); assert.equal(item.chat, true);
  assert.equal(item.now, 'not-installed');
  assert.match(item.write, /set_setting \{"id":"local_asr"/u);
  // 三方互通 off: the microphone's state is not read (as get_status), and nothing asks for words.
  const off = channel(w, false);
  const quiet = (await off.call('list_settings', {})).result as any;
  assert.equal(quiet.settings.find((entry: any) => entry.id === 'voice_input').value, null);
});

test('the catalog: every confirm-tier tool requires userWords; set_setting accepts it', () => {
  for (const tool of AGENT_TOOLS.filter(item => item.tier === 'confirm')) {
    assert.ok(tool.inputSchema.properties.userWords, tool.name);
    assert.ok(tool.inputSchema.required?.includes('userWords'), tool.name);
  }
  assert.ok(AGENT_TOOLS.find(tool => tool.name === 'set_setting')!.inputSchema.properties.userWords);
  for (const id of ['voice_input', 'local_asr'] as const) {
    const spec = AGENT_SETTINGS.find(item => item.id === id)!;
    assert.equal(spec.chat, 'turn'); assert.equal(spec.cardConsent, true); assert.ok(spec.confirmWhen?.length);
  }
});

// ---- Her chat ------------------------------------------------------------------------

test('her fixed system prompt does not change: voice input is offered only in the turn that mentions it', () => {
  const fixed = chatSettingsSystemText();
  assert.equal(fixed, chatSettingsSystemText(AGENT_SETTINGS.filter(spec => spec.chat !== 'turn')), 'byte for byte the same as without them');
  assert.ok(!fixed.includes('local_asr') && !fixed.includes('voice_input'));
  for (const text of ['帮我下载语音输入', '把麦克风打开', '我想用说的，不想打字了', 'turn on the microphone', '语音识别组件删了吧'])
    assert.equal(mentionsSettings(text), true, text);
  const w = world();
  const current = currentSettingsText(structuredClone(DEFAULT_SETTINGS), AGENT_SETTINGS, undefined, settingExtras(w.bridge));
  assert.match(current, /local_asr="not-installed"（本机语音识别组件，可选 "installed"（下载） \/ "not-installed"（不要（取消下载或删除组件）））/u);
  assert.match(current, /voice_input=false（语音输入（麦克风），可选 true（打开（会用麦克风）） \/ false（关闭））/u);
  // The settings already in her fixed prompt read exactly as before.
  assert.match(current, /readout_volume=80（0–100）/u);
});

function chat(w: ReturnType<typeof world>) {
  const sent: ChatSettingCardView[] = [], confirms: AgentConfirmRequest[] = [], notices: string[] = [];
  const proposals = new ChatSettingProposals({ settings: () => w.bridge.settings(), send: (_owner, card) => sent.push(card), id: () => 'p1' });
  proposals.connect(chatSettingApplier(createAppTools(w.bridge, { settingVia: 'chat' }), {
    confirm: async request => { confirms.push(request); return true; }, notice: (_tool, title) => notices.push(title) }), { extras: () => settingExtras(w.bridge) });
  return { proposals, sent, confirms, notices };
}

test('对她说「下载语音输入」: a card says how much and from where; the tap is the consent and starts it (no second dialog)', async () => {
  const w = world({ interconnect: false }), h = chat(w);
  const turn = h.proposals.beginTurn('帮我下载语音输入');
  assert.ok(turn.instruction, 'the per-turn settings context is offered');
  assert.match(turn.instruction!('<s>', '</s>'), /local_asr="not-installed"/u);
  const card = h.proposals.offer(turn.ticket, 7, 'reply-1', '{"id":"local_asr","value":"installed","reason":"你想用语音输入"}')!;
  assert.ok(card);
  assert.equal(card.current, '还没下载'); assert.equal(card.proposed, '下载'); assert.equal(card.confirm, false);
  for (const part of ['355 MB', 'Hugging Face', SENSEVOICE_REPO]) assert.ok(card.detail?.includes(part), part);
  assert.deepEqual(w.calls, [], 'a proposal changes nothing by itself');
  const applied = await h.proposals.choose(7, { proposalId: card.proposalId, choiceId: card.choices.find(choice => choice.proposed)!.choiceId });
  assert.equal(applied?.state, 'applied');
  assert.match(applied!.message!, /已开始下载本机语音识别/u);
  assert.deepEqual(h.confirms, [], 'the card was the consent');
  assert.deepEqual(w.calls, ['download']);
  // The card as the pet shows it: the detail line is plain text.
  const read = readChatSettingCard(JSON.parse(JSON.stringify(card)))!;
  assert.equal(read.detail, card.detail);
  const nodes: any[] = [];
  const doc = { createElement: (tag: string) => { const node: any = { tag, className: '', textContent: '', dataset: {}, children: [] as any[],
    setAttribute() {}, append(...items: any[]) { this.children.push(...items); } }; nodes.push(node); return node; } };
  renderChatSettingCard(read, doc as any, () => {});
  assert.ok(nodes.some(node => node.className === 'chat-setting-card__detail' && node.textContent === card.detail));
});

test('对她说「打开语音输入」: the card says it uses the microphone; cancelling changes nothing', async () => {
  const w = world({ phase: 'idle' }), h = chat(w);
  const turn = h.proposals.beginTurn('把语音输入打开');
  const card = h.proposals.offer(turn.ticket, 3, 'reply-2', '{"id":"voice_input","value":true}')!;
  assert.equal(card.current, '关闭'); assert.match(card.detail!, /麦克风/u);
  const cancelled = await h.proposals.choose(3, { proposalId: card.proposalId, choiceId: 'cancel' });
  assert.equal(cancelled?.state, 'cancelled');
  assert.equal(w.mic(), false);
  const again = h.proposals.beginTurn('还是打开语音输入吧');
  const second = h.proposals.offer(again.ticket, 3, 'reply-3', '{"id":"voice_input","value":true}')!;
  const applied = await h.proposals.choose(3, { proposalId: second.proposalId, choiceId: second.choices.find(choice => choice.proposed)!.choiceId });
  assert.equal(applied?.state, 'applied');
  assert.equal(w.mic(), true);
  assert.deepEqual(h.confirms, []);
});

test('更真实的情绪 in her chat still shows its own dialog after the tap (unchanged)', async () => {
  const w = world();
  const cards = { activeId: CARD, cards: [{ id: CARD, name: '菲菲', realerEmotions: false } as any] };
  w.bridge.characters = () => structuredClone(cards);
  w.bridge.setRealerEmotions = async (value, guard) => { guard(); cards.cards[0].realerEmotions = value; };
  const sent: ChatSettingCardView[] = [], confirms: AgentConfirmRequest[] = [];
  const proposals = new ChatSettingProposals({ settings: () => w.bridge.settings(), cards: () => cards, send: (_o, card) => sent.push(card), id: () => 'p9' });
  proposals.connect(chatSettingApplier(createAppTools(w.bridge, { settingVia: 'chat' }), { confirm: async request => { confirms.push(request); return true; } }));
  const turn = proposals.beginTurn('你可以更真实一点');
  const card = proposals.offer(turn.ticket, 1, 'r', '{"id":"realer_emotions","value":true}')!;
  await proposals.choose(1, { proposalId: card.proposalId, choiceId: card.choices.find(choice => choice.proposed)!.choiceId });
  assert.equal(confirms.length, 1);
});

// ---- Host bridge and 体验记录 --------------------------------------------------------------

test('the host bridge reuses the control window\'s own download button and returns once it started', async () => {
  for (const name of ['getLocalAsr', 'downloadLocalAsr', 'cancelLocalAsrDownload', 'removeLocalAsr']) assert.ok(AGENT_HOST_OPERATIONS.includes(name), name);
  const senders: unknown[] = [], guards: string[] = [];
  const view: LocalAsrView = { phase: 'not-installed', prompt: false, downloadBytes: DOWNLOAD, installedBytes: 0, progress: null, componentVersion: 1, notice: '' };
  const operations = new Map<string, IpcHandler>([
    ['getLocalAsr', () => view],
    ['downloadLocalAsr', event => { senders.push(event.sender.id); return new Promise(() => {}); }], // a download that takes minutes
  ]);
  const controls = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, webContents: { id: 11, isDestroyed: () => false, send() {} } };
  const bridge = createHostBridge({ version: () => '0', controls: () => controls, pet: () => null, operations,
    admit: (guard, run) => { guard(); guards.push('admit'); return run(); }, importCharacterCard: async () => { throw new Error('x'); },
    loadModel: async () => { throw new Error('x'); }, commitPetBoolean: async () => { throw new Error('x'); }, commitReadoutVolume: async () => { throw new Error('x'); },
    commitBreath: async () => { throw new Error('x'); }, replyLatency: () => [], broadcast: () => {} });
  assert.equal(bridge.localAsr!()!.phase, 'not-installed');
  const started = Date.now();
  await bridge.downloadLocalAsr!(() => { guards.push('guard'); });
  assert.ok(Date.now() - started < 2000, 'does not wait for the whole download');
  assert.deepEqual(senders, [11], 'as the control window, like the user\'s click');
  assert.ok(guards.includes('guard') && guards.includes('admit'));
});

test('体验记录: one line per user-words call with the item, the value and the length; never the words', () => {
  const at = new Date(2026, 10, 4, 19, 30).getTime();
  const entry = buildJournalEntry({ type: 'agent-words', characterId: CARD, tool: 'set_setting', item: 'local_asr', value: 'installed', words: 12 }, at)!;
  assert.ok(entry);
  assert.deepEqual(readJournalLine(JSON.stringify(entry)), entry);
  assert.equal(describeJournalEntry(entry, (text: string, ...args: unknown[]) => args.reduce<string>((out, arg, index) => out.replace(`{${index}}`, String(arg)), text)),
    '19:30 照你的原话，Claude 做了一件要你同意的事：「本机语音识别组件」→ 下载（原话 12 字）');
  for (const bad of [{ value: '帮我下载' }, { words: 0 }, { words: 2001 }, { tool: 'run_command' }, { item: '用户说的话' }, { value: { text: WORDS } }])
    assert.equal(buildJournalEntry({ type: 'agent-words', characterId: CARD, tool: 'set_setting', item: 'local_asr', value: 'installed', words: 12, ...bad } as any, at), null, JSON.stringify(bad));
  const smuggled = buildJournalEntry({ type: 'agent-words', characterId: CARD, tool: 'set_setting', item: 'voice_input', value: true, words: 6, userWords: WORDS } as any, at)!;
  assert.ok(!JSON.stringify(smuggled).includes(WORDS));
  setUiLanguage('en');
  try { assert.ok(!/[\u4e00-\u9fff]/u.test(describeJournalEntry(entry, uiText)), describeJournalEntry(entry, uiText)); }
  finally { setUiLanguage('zh-CN'); }
});
