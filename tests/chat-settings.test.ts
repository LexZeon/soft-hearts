import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppSettings } from '../shared/contracts';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { AGENT_SETTINGS, type AgentSettingSpec } from '../shared/agent-channel';
import type { ChatSettingCardView } from '../shared/chat-settings';
import {
  ChatSettingProposals, chatSettingApplier, chatSettingsSystemText, currentSettingsText, mentionsSettings, parseChatSettingProposal,
  type ChatSettingApplier,
} from '../electron/chat-settings';
import { MoodReplyProtocol } from '../electron/mood-chat';
import { CompanionService, type CompanionTurn } from '../electron/companion';
import { CLAUDE_SESSION_SYSTEM_PROMPT, sessionText } from '../electron/claude-session-prompt';
import { createAppTools, settingViews, type AgentAppBridge } from '../electron/agent-channel/app-tools';
import type { AgentAuditEntry, AgentConfirmRequest, AgentToolDefinition } from '../electron/agent-channel/registry';
import { setUiLanguage } from '../shared/ui-language';

setUiLanguage('zh-CN');
const settings = (patch: (value: AppSettings) => void = () => {}) => { const value = structuredClone(DEFAULT_SETTINGS); patch(value); return value; };
const currentOf = (value: AppSettings) => (id: string) => settingViews(value).find(view => view.id === id)?.value ?? null;
const spec = (id: string) => AGENT_SETTINGS.find(item => item.id === id)!;

// ---- Catalog, heuristic and per-turn text -------------------------------------------

test('the fixed system text is the catalog: labels and allowed values, never current values', () => {
  const text = chatSettingsSystemText();
  // I-025: `chat: 'turn'` settings (语音输入) are offered only per turn, never in the fixed text.
  for (const item of AGENT_SETTINGS.filter(setting => setting.chat !== false && setting.chat !== 'turn')) { assert.ok(text.includes(item.id), item.id); assert.ok(text.includes(item.label), item.label); }
  for (const item of AGENT_SETTINGS.filter(setting => setting.chat === 'turn')) assert.ok(!text.includes(item.id), item.id);
  // A setting for the agent channel only (体验记录) is never in her system prompt.
  for (const item of AGENT_SETTINGS.filter(setting => setting.chat === false)) assert.ok(!text.includes(item.id), item.id);
  assert.match(text, /readout_volume：朗读音量，0–100 的整数（%）/);
  assert.match(text, /fps：渲染帧率，24（24 FPS · 节能）/);
  assert.ok(!/=\s*\d/.test(text), 'no current values in fixed text');
  assert.ok(CLAUDE_SESSION_SYSTEM_PROMPT.endsWith(text), 'part of the persistent session system prompt');
  // A never-tier entry is not even listed.
  const never = { ...spec('fps'), id: 'api_key', label: '密钥', tier: 'never' } as unknown as AgentSettingSpec;
  assert.ok(!chatSettingsSystemText([...AGENT_SETTINGS, never]).includes('api_key'));
});

test('heuristic: setting words, symptoms and change verbs include current values; ordinary chat omits them', () => {
  for (const text of ['声音太大了', '帧率调高一点', '有点卡，能流畅点吗', '别老盯着鼠标看', '关掉朗读吧', '你挡住我的窗口了', '能把呼吸调小吗', 'too loud, lower the volume'])
    assert.equal(mentionsSettings(text), true, text);
  for (const text of ['今天天气真好', '我想吃火锅', '给我讲个故事吧', '', 'hello there'])
    assert.equal(mentionsSettings(text), false, text);
  assert.equal(mentionsSettings(42), false);
  const host = new ChatSettingProposals({ settings: () => settings(value => { value.voice.volume = 0.8; value.pet.fps = 30; }), send: () => {} });
  const on = host.beginTurn('声音太大了'), off = host.beginTurn('今天天气真好');
  assert.equal(off.instruction, null, 'no tokens spent on unrelated turns');
  const text = on.instruction!('<sh-setting-abc>', '</sh-setting-abc>');
  assert.match(text, /readout_volume=80（0–100）/); assert.match(text, /fps=30（24\/30\/60）/); assert.match(text, /read_aloud=true/);
  assert.match(text, /<sh-setting-abc>\{"id":"readout_volume"/); assert.match(text, /不清楚.*直接用一句话问用户/);
  assert.equal(currentSettingsText(settings()).includes('apiKey'), false);
});

// ---- Strict proposal parsing ---------------------------------------------------------

test('proposal parsing: valid shapes, malformed JSON, unknown keys and settings, out of range, never tier, no-op', () => {
  const now = currentOf(settings(value => { value.voice.volume = 0.8; value.pet.fps = 30; value.voice.enabled = true; }));
  const ok = parseChatSettingProposal('{"id":"readout_volume","value":60,"choices":[40,60,30],"reason":"你说太吵了"}', now)!;
  assert.deepEqual([ok.spec.id, ok.value, ok.options, ok.reason], ['readout_volume', 60, [60, 40, 30], '你说太吵了']);
  assert.deepEqual(parseChatSettingProposal('{"id":"read_aloud","value":false}', now)!.options, [false]);
  assert.deepEqual(parseChatSettingProposal('{"id":"fps","value":60,"choices":[24]}', now)!.options, [60, 24]);
  for (const raw of [
    '', 'not json', '{"id":"fps","value":60', '[]', 'null', '"fps"',
    '{"id":"fps","value":60,"extra":1}', '{"id":"api_key","value":"x"}', '{"id":"fps"}',
    '{"id":"readout_volume","value":150}', '{"id":"readout_volume","value":-1}', '{"id":"readout_volume","value":33.5}', '{"id":"readout_volume","value":"60"}',
    '{"id":"fps","value":45}', '{"id":"read_aloud","value":"false"}', '{"id":"breath","value":60,"choices":[10,20,30,40]}',
    '{"id":"breath","value":60,"choices":[200]}', '{"id":"breath","value":60,"choices":[]}', '{"id":"breath","value":60,"choices":"40"}',
    '{"id":"breath","value":60,"reason":5}', '{"id":"readout_volume","value":80}', '{"id":"fps","value":30,"choices":[30]}',
    'x'.repeat(801),
  ]) assert.equal(parseChatSettingProposal(raw, now), null, raw.slice(0, 60));
  const never = { ...spec('fps'), tier: 'never' } as unknown as AgentSettingSpec, read = { ...spec('fps'), tier: 'read' } as AgentSettingSpec;
  assert.equal(parseChatSettingProposal('{"id":"fps","value":60}', now, [never]), null, 'never tier is never offered');
  assert.equal(parseChatSettingProposal('{"id":"fps","value":60}', now, [read]), null);
  const reason = parseChatSettingProposal(JSON.stringify({ id: 'fps', value: 60, reason: '  第一行\n第二\u202e行\u0000' + '长'.repeat(80) }), now)!.reason;
  assert.ok(reason.startsWith('第一行 第二 行')); assert.equal([...reason].length, 60); assert.ok(!/[\u0000-\u001f\u202e]/.test(reason));
});

// ---- The nonce-protected private block -------------------------------------------------

const stateTail = (protocol: MoodReplyProtocol) => `${protocol.start}{"context":"neutral","delta":{},"reason":"r","confidence":0.9}${protocol.end}`;
const markers = (protocol: MoodReplyProtocol) => {
  const start = /<sh-setting-[a-f0-9]+>/.exec(protocol.instruction())![0];
  return { start, end: start.replace('<', '</') };
};
function run(protocol: MoodReplyProtocol, wire: string, complete = true) {
  for (const char of wire) protocol.push(char); // Worst-case chunking.
  return protocol.finish(complete);
}
const offering = () => ({ instruction: (start: string, end: string) => `提议格式：${start}{...}${end}` });

test('protocol: the exact-nonce block after the state tail is hidden from text and returned raw', () => {
  let shown = '';
  const protocol = new MoodReplyProtocol(text => { shown += text; }, { settingProposal: offering() });
  const { start, end } = markers(protocol);
  assert.ok(protocol.instruction().includes(start), 'the instruction carries this turn\'s markers');
  const appraisal = run(protocol, `好，我把声音调小一点？\n${stateTail(protocol)}${start}{"id":"readout_volume","value":60}${end}`);
  assert.equal(shown, '好，我把声音调小一点？'); assert.ok(appraisal);
  assert.equal(protocol.settingProposal(), '{"id":"readout_volume","value":60}');
  assert.equal(sessionText(`正文\n${start}{}${end}`), '正文', 'session alignment strips the setting family too');
});

test('protocol: wrong nonce, block before the tail, no offer, stopped reply and overflow never propose and never show', () => {
  const cases: Array<[string, (p: MoodReplyProtocol, s: string, e: string) => string, boolean?, boolean?]> = [
    ['wrong nonce', (p) => `正文${'\n'}${stateTail(p)}<sh-setting-0123abcd>{"id":"fps","value":60}</sh-setting-0123abcd>`],
    ['before the state tail', (p, s, e) => `正文${s}{"id":"fps","value":60}${e}${stateTail(p)}`],
    ['missing state tail', (_p, s, e) => `正文${s}{"id":"fps","value":60}${e}`],
    ['stopped', (p, s, e) => `正文\n${stateTail(p)}${s}{"id":"fps","value":60}${e}`, false],
    ['overflow', (p, s, e) => `正文\n${stateTail(p)}${s}${'x'.repeat(3_200)}${e}`],
    ['unterminated', (p, s) => `正文\n${stateTail(p)}${s}{"id":"fps","value":60}`],
  ];
  for (const [name, wire, complete = true] of cases) {
    let shown = '';
    const protocol = new MoodReplyProtocol(text => { shown += text; }, { settingProposal: offering() });
    const { start, end } = markers(protocol);
    run(protocol, wire(protocol, start, end), complete);
    assert.equal(protocol.settingProposal(), null, name);
    assert.equal(shown, '正文', `${name}: nothing private reaches the text`);
  }
  // Heuristic off: no instruction, but an imitated block is still hidden and ignored.
  let shown = '';
  const quiet = new MoodReplyProtocol(text => { shown += text; }, { settingProposal: { instruction: null } });
  assert.ok(!quiet.instruction().includes('sh-setting-'));
  run(quiet, `正文<sh-setting-0123abcd>{"id":"fps","value":60}</sh-setting-0123abcd>`);
  assert.equal(shown, '正文'); assert.equal(quiet.settingProposal(), null);
});

test('protocol: on a memorial turn the setting block may come before or after the memorial block', () => {
  for (const order of ['setting-first', 'memorial-first']) {
    let shown = '';
    const userText = '今天我完成了一件想珍藏的事。';
    const protocol = new MoodReplyProtocol(text => { shown += text; }, { textMemorial: { userText, persona: 'p', mood: 'm', context: 'c' }, settingProposal: offering() });
    const { start, end } = markers(protocol);
    const memorialStart = /<sh-memorial-[a-f0-9]+>/.exec(protocol.instruction())![0];
    const memorial = `${memorialStart}${JSON.stringify({ quote: userText, purpose: '留作纪念', invite: `要把“${userText}”留作纪念吗？` })}${memorialStart.replace('<', '</')}`;
    const setting = `${start}{"id":"breath","value":20}${end}`;
    run(protocol, `正文\n${stateTail(protocol)}${order === 'setting-first' ? setting + memorial : memorial + setting}`);
    assert.equal(shown, '正文', order);
    assert.equal(protocol.settingProposal(), '{"id":"breath","value":20}', order);
    assert.ok(protocol.textMemorialProposal(), `${order}: the memorial proposal still parses`);
  }
});

test('companion: the proposal is available only after a complete current turn; archive and reward stay single', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soft-chat-settings-'));
  try {
    const service = new CompanionService(root, () => {});
    await service.load();
    const provider = { kind: 'claude' as const, baseUrl: 'http://127.0.0.1:11434/v1', model: '' };
    await service.context('fixture-character', provider, 'Fixture persona.');
    const rewards: string[] = [];
    const event = service.mood.event.bind(service.mood);
    service.mood.event = (...args) => { rewards.push(args[0].type); return event(...args); };
    const say = async (id: string, complete: boolean) => {
      const out: string[] = [];
      const turn: CompanionTurn = await service.begin(id, '声音太大了', 'Fixture persona.', (type, text) => { if (type === 'delta') out.push(text); },
        { settingProposal: offering() });
      const start = /<sh-setting-[a-f0-9]+>/.exec(turn.persona)![0], state = /<sh-state-[a-f0-9]+>/.exec(turn.persona)![0];
      assert.equal(turn.settingProposal?.(), null, 'nothing before completion');
      const wire = `调小一点？\n${state}{"context":"neutral","delta":{},"reason":"r","confidence":0.9}${state.replace('<', '</')}${start}{"id":"readout_volume","value":60}${start.replace('<', '</')}`;
      for (const char of wire) turn.push('delta', char);
      await turn.finish(complete ? 'complete' : 'stopped');
      return { turn, text: out.join('') };
    };
    const done = await say('reply-1', true);
    assert.equal(done.text, '调小一点？');
    assert.equal(done.turn.settingProposal?.(), '{"id":"readout_volume","value":60}');
    assert.deepEqual(rewards, ['chat', 'appraisal'], 'one chat event and one appraisal');
    const archived = service.memory.read(done.turn.scope, done.turn.recordId)!;
    assert.equal(archived.messages.filter(message => message.role === 'assistant').length, 1);
    assert.equal(archived.messages.at(-1)!.content, '调小一点？', 'the archive holds only the visible text');
    const stopped = await say('reply-2', false);
    assert.equal(stopped.turn.settingProposal?.(), null, 'a stopped reply never proposes');
    await service.newConversation();
    assert.equal(done.turn.settingProposal?.(), null, 'stale after a context change');
    await service.flush();
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ---- Host cards: offer, stale, tap, apply through the registry ---------------------------

function fakeBridge(initial: (value: AppSettings) => void = () => {}) {
  const state = settings(initial), calls: unknown[][] = [];
  const commit = async () => ({ persistence: 'saved' as const, presentation: 'applied' });
  const unused = () => { throw new Error('outside this fixture'); };
  const bridge: AgentAppBridge = {
    version: () => '0', settings: () => structuredClone(state), characters: () => ({ activeId: '', cards: [] }) as any,
    windows: () => ({ pet: null, controls: null }), activateCharacter: unused, bindCurrentModel: unused,
    setPetVisible: async visible => { calls.push(['visible', visible]); state.pet.visible = visible; },
    saveSettings: async next => { calls.push(['save', next.pet.fps]); Object.assign(state, structuredClone(next)); },
    commitPetBoolean: async (value, actionId) => { calls.push([actionId, value]); return commit(); },
    commitReadoutVolume: async percent => { calls.push(['volume', percent]); state.voice.volume = percent / 100; return commit(); },
    commitBreath: async percent => { calls.push(['breath', percent]); state.pet.breath = percent / 100; return commit(); },
    importCharacterCard: unused, loadModel: unused, rendererAction: () => false,
    diagnostics: () => ({ replyLatency: [], petWindow: { enabled: false, entries: 0 } }),
  };
  return { bridge, calls, state };
}

function host(options: { apply?: ChatSettingApplier; initial?: (value: AppSettings) => void; specs?: readonly AgentSettingSpec[]; now?: () => number } = {}) {
  const fake = fakeBridge(options.initial);
  const sent: Array<{ owner: number; card: ChatSettingCardView }> = [], notices: string[] = [], audit: AgentAuditEntry[] = [];
  const confirms: AgentConfirmRequest[] = [];
  let allow = true;
  const proposals = new ChatSettingProposals({ settings: () => fake.bridge.settings(), send: (owner, card) => sent.push({ owner, card }),
    id: (() => { let n = 0; return () => `proposal-${++n}`; })(), now: options.now, specs: options.specs });
  proposals.connect(options.apply ?? chatSettingApplier(createAppTools(fake.bridge), {
    confirm: async request => { confirms.push(request); return allow; }, notice: (_tool, title) => notices.push(title), audit: entry => audit.push(entry) }));
  return { proposals, sent, notices, audit, confirms, ...fake, deny: () => { allow = false; } };
}

test('a valid proposal becomes one card for the owning window; late, stale and second offers are inert', () => {
  const h = host({ initial: value => { value.voice.volume = 0.8; } });
  const turn = h.proposals.beginTurn('声音太大了');
  const card = h.proposals.offer(turn.ticket, 7, 'reply-1', '{"id":"readout_volume","value":30,"choices":[60],"reason":"你说太吵"}')!;
  assert.deepEqual([card.label, card.current, card.proposed, card.reason, card.state, card.confirm], ['朗读音量', '默认 80%', '小声 30%', '你说太吵', 'open', false]);
  assert.deepEqual(card.choices.map(choice => [choice.label, choice.proposed, choice.current]), [['小声 30%', true, false], ['适中 60%', false, false]]);
  assert.deepEqual(h.sent.map(item => item.owner), [7]);
  assert.equal(h.proposals.offer(turn.ticket, 7, 'reply-1', '{"id":"fps","value":60}'), null, 'one card per reply');
  const late = h.proposals.beginTurn('帧率调高');
  h.proposals.invalidate(); // e.g. the character changed while this reply was streaming
  assert.equal(h.proposals.offer(late.ticket, 7, 'reply-2', '{"id":"fps","value":60}'), null, 'a late proposal is inert');
  assert.equal(h.sent.at(-1)!.card.state, 'expired', 'the open card was told it expired');
  const next = h.proposals.beginTurn('帧率调高');
  for (const raw of [null, undefined, '', '{"id":"fps","value":45}', '{"id":"api_key","value":"x"}'])
    assert.equal(h.proposals.offer(next.ticket, 7, 'reply-3', raw), null);
  assert.deepEqual(h.calls, [], 'nothing changes without a tap');
});

test('a tap on a reversible setting applies once through the registry with the "由 Claude 操作" notice', async () => {
  const h = host({ initial: value => { value.voice.volume = 0.8; } });
  const card = h.proposals.offer(h.proposals.beginTurn('声音太大了').ticket, 7, 'reply-1', '{"id":"readout_volume","value":30,"choices":[60]}')!;
  await assert.rejects(h.proposals.choose(8, { proposalId: card.proposalId, choiceId: 'c0' }), /未授权/, 'only the owning window');
  assert.equal(await h.proposals.choose(7, { proposalId: 'other', choiceId: 'c0' }), null);
  assert.equal(await h.proposals.choose(7, { proposalId: card.proposalId, choiceId: 'c9' }), null, 'only the card\'s own choices');
  const [first, second] = await Promise.all([h.proposals.choose(7, { proposalId: card.proposalId, choiceId: 'c1' }),
    h.proposals.choose(7, { proposalId: card.proposalId, choiceId: 'c0' })]);
  assert.equal(first!.state, 'applied'); assert.match(first!.message!, /由 Claude 操作：已把「朗读音量」改为 适中 60%/);
  assert.equal(second!.state, 'busy', 'a second tap while applying changes nothing');
  assert.deepEqual(h.calls, [['volume', 60]], 'applied exactly once, with the tapped value');
  assert.equal(h.state.voice.volume, 0.6);
  assert.deepEqual(h.notices, ['调整设置']); assert.deepEqual(h.audit.map(entry => [entry.tool, entry.tier, entry.outcome]), [['chat_set_setting', 'reversible', 'allowed']]);
  assert.deepEqual(h.confirms, [], 'reversible settings need no dialog');
  assert.equal(await h.proposals.choose(7, { proposalId: card.proposalId, choiceId: 'c0' }), null, 'a settled card is inert');
  assert.deepEqual(h.sent.map(item => item.card.state), ['open', 'busy', 'applied']);
});

test('cancel, expiry and a new turn leave settings untouched', async () => {
  let now = 0;
  // R29f: the default is 60 now; this card raises an older 30 (a user who chose it).
  const h = host({ now: () => now, initial: value => { value.pet.fps = 30; } });
  let card = h.proposals.offer(h.proposals.beginTurn('帧率调高').ticket, 7, 'r1', '{"id":"fps","value":60}')!;
  assert.equal((await h.proposals.choose(7, { proposalId: card.proposalId, choiceId: 'cancel' }))!.state, 'cancelled');
  card = h.proposals.offer(h.proposals.beginTurn('帧率调高').ticket, 7, 'r2', '{"id":"fps","value":60}')!;
  now = 5 * 60_000 + 1;
  assert.equal((await h.proposals.choose(7, { proposalId: card.proposalId, choiceId: 'c0' }))!.state, 'expired');
  card = h.proposals.offer(h.proposals.beginTurn('帧率调高').ticket, 7, 'r3', '{"id":"fps","value":60}')!;
  h.proposals.beginTurn('今天天气真好');
  assert.equal(await h.proposals.choose(7, { proposalId: card.proposalId, choiceId: 'c0' }), null, 'a new message makes the card inert');
  assert.deepEqual(h.calls, []); assert.equal(h.state.pet.fps, 30);
});

test('a confirm-tier setting opens the existing confirmation; refusing or allowing is reported truthfully', async () => {
  // No catalog setting is confirm-tier today; this stands in for one with the same tool shape.
  const confirmSpec = { ...spec('fps'), tier: 'confirm' } as AgentSettingSpec;
  const confirms: AgentConfirmRequest[] = [], applied: unknown[] = [];
  let allow = false;
  const tool: AgentToolDefinition = { name: 'set_setting', title: '调整设置', tier: 'reversible', tierFor: () => 'confirm',
    validate: raw => raw, confirmation: () => ({ title: 'Claude 请求修改「渲染帧率」', detail: '从：30 改为：60' }),
    run: (input: { value: unknown }) => { applied.push(input.value); return { previous: 30, value: input.value }; } };
  const apply = chatSettingApplier([tool], { confirm: async request => { confirms.push(request); return allow; } });
  const h = host({ apply, specs: [confirmSpec], initial: value => { value.pet.fps = 30; } });
  let card = h.proposals.offer(h.proposals.beginTurn('帧率调高').ticket, 7, 'r1', '{"id":"fps","value":60}')!;
  assert.equal(card.confirm, true);
  assert.equal((await h.proposals.choose(7, { proposalId: card.proposalId, choiceId: 'c0' }))!.state, 'denied');
  assert.equal(confirms.length, 1); assert.deepEqual(applied, [], 'refused: nothing applied');
  allow = true;
  card = h.proposals.offer(h.proposals.beginTurn('帧率调高').ticket, 7, 'r2', '{"id":"fps","value":60}')!;
  assert.equal((await h.proposals.choose(7, { proposalId: card.proposalId, choiceId: 'c0' }))!.state, 'applied');
  assert.equal(confirms.length, 2); assert.deepEqual(applied, [60]);
});
