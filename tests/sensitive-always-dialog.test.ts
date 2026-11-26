// 敏感操作弹窗 (answering "外部'原话'那件，要不要改成敏感操作照样弹窗？": "敏感操作弹窗"). With 三方互通 on, a call
// from the user's own Claude Code that carries userWords still opens the soft hearts dialog for SENSITIVE operations (privacy,
// spending — money or the user's Claude usage —, deleting, downloading or loading files); ordinary changes keep the direct path.
// userWords stay required for the sensitive ones and are shown in the dialog. With 三方互通 off nothing changes; the Claude 助手
// (alwaysConfirm surface) and her chat cards are unchanged. Real tool definitions with stubbed host steps; no Claude, no Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import * as channelCatalog from '../shared/safety/agent-channel';
import { AGENT_SETTINGS, AGENT_TOOLS, type AgentSettingSpec } from '../shared/safety/agent-channel';
import { CAPABILITIES } from '../shared/settings/capabilities';
import { handbookCategory } from '../shared/settings/capability-handbook';
import { AgentToolRegistry, type AgentConfirmRequest, type AgentToolDefinition, type AgentWordsUse } from '../electron/safety/agent-channel/registry';
import { createAppTools, type AgentAppBridge } from '../electron/safety/agent-channel/app-tools';
import { createConversionTools } from '../electron/cards/character-convert/tools';
import { buildJournalEntry, describeJournalEntry, readJournalLine } from '../shared/memory/journal';
import { setUiLanguage } from '../shared/foundation/ui-language';
import { uiText } from '../src/foundation/ui-language';

const A = '0f8fad5b-d9cb-469f-a165-70867728950e';
const WORDS = '帮我打开它吧';
const tick = () => new Promise(resolve => setImmediate(resolve));
// 2026-11-24: generous bounds. Nothing here tests the timeout itself; under a loaded machine (the candidate build ran next to four
// sub-agents) the first case took 3.2 s and a 2 s confirm timeout answered before the test did (confirm_timeout). These only bound a broken test.
async function until(check: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('timed out waiting'); await tick(); }
}

const bridge = {
  settings: () => structuredClone(DEFAULT_SETTINGS), interconnected: () => true, windows: () => ({ pet: null, controls: null }),
  characters: () => ({ activeId: A, revision: 1, cards: [{ id: A, name: '阿棠' }] }),
} as unknown as AgentAppBridge;
const appTools = createAppTools(bridge);
const conversionTools = createConversionTools(() => null);
const real = (name: string): AgentToolDefinition => {
  const found = [...appTools, ...conversionTools].find(tool => tool.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};

/**
 * The real definition's policy (tier, tierFor, alwaysConfirm…, touchesFiles, interconnectOnly, wordsItem, load/confirmLoaded presence)
 * with its host steps replaced by counters, so every tool and value can be driven the same way.
 */
function driven(name: string, prepared: unknown) {
  const definition = real(name);
  const counts = { prepare: 0, load: 0, run: 0 };
  const tool: AgentToolDefinition = {
    ...definition, validate: () => prepared, prepare: () => { counts.prepare += 1; return prepared; },
    confirmation: () => ({ title: `T:${name}`, detail: 'D' }),
    ...(definition.load ? { load: (value: unknown) => { counts.load += 1; return value; }, confirmLoaded: () => ({ title: `L:${name}`, detail: 'D2' }) } : {}),
    noticeDetail: undefined, informWithoutDialog: undefined,
    run: () => { counts.run += 1; return { done: true }; },
  };
  return { tool, counts };
}

function registryFor(tool: AgentToolDefinition, interconnect: boolean, answer: boolean | 'wait' = 'wait', more: Record<string, unknown> = {}) {
  const asked: AgentConfirmRequest[] = [], answers: Array<(value: boolean) => void> = [], uses: AgentWordsUse[] = [];
  const registry = new AgentToolRegistry([tool], { enabled: () => true, interconnect: () => interconnect, confirmTimeoutMs: 60_000,
    confirm: request => { asked.push(request); return answer === 'wait' ? new Promise<boolean>(resolve => answers.push(resolve)) : Promise.resolve(answer); },
    wordsUsed: use => uses.push(use), ...more });
  return { registry, asked, answers, uses };
}

const setting = (id: string): AgentSettingSpec => { const spec = AGENT_SETTINGS.find(item => item.id === id); if (!spec) throw new Error(id); return spec; };
const settingCase = (id: string, value: boolean | string) => ({ label: `set_setting ${id}=${JSON.stringify(value)}`, name: 'set_setting',
  prepared: { spec: setting(id), value, shown: null, card: null }, args: { id, value } });

/** Every sensitive item of the user's decision (the main session's classification, docs/claude/2026-11-12-sensitive-always-dialog.md). */
const SENSITIVE = [
  { label: 'import_character_card', name: 'import_character_card', prepared: { file: 'x' }, args: { path: 'C:\\x.json' } },
  { label: 'update_character_card', name: 'update_character_card', prepared: { id: A, name: '阿棠' }, args: { id: A, path: 'C:\\x.json' } },
  { label: 'load_model', name: 'load_model', prepared: { file: 'x' }, args: { path: 'C:\\x.pmx' } },
  { label: 'voice_preview (bailian)', name: 'voice_preview', prepared: 'bailian', args: {} },
  { label: 'voice_preview (fish)', name: 'voice_preview', prepared: 'fish', args: {} },
  { label: 'delete_memories', name: 'delete_memories', prepared: { id: A, name: '阿棠', parts: ['chat'] }, args: { id: A, parts: ['chat'] } },
  { label: 'clear_song_memory', name: 'clear_song_memory', prepared: null, args: {} },
  ...(['camera', 'camera_images', 'camera_pose', 'microphone', 'screen', 'system_audio'] as const).map(kind => ({ label: `set_perception ${kind} on`,
    name: 'set_perception', prepared: { kind, enabled: true, purposes: kind === 'system_audio' ? ['music'] : [] }, args: { kind, state: 'on' } })),
  { label: 'convert_character_language', name: 'convert_character_language', prepared: { preview: { target: 'en' } }, args: {} },
  settingCase('voice_provider', 'bailian'), settingCase('voice_provider', 'fish'), settingCase('voice_input', true),
  settingCase('local_asr', 'installed'), settingCase('local_asr', 'not-installed'), settingCase('pose_sensing', 'installed'), settingCase('pose_sensing', 'not-installed'),
  settingCase('chat_model', ''), settingCase('chat_model', 'haiku'), settingCase('chat_model', 'sonnet'), settingCase('chat_model', 'opus'),
  settingCase('pause_talk', true), settingCase('mood_judge', true), settingCase('new_reactions', true), settingCase('proactive_vision', true),
  settingCase('feed_recognition', true), settingCase('user_activity', true),
];
/** Consent-needing but ordinary: the user's words are the consent, no dialog (as before). */
const ORDINARY = [
  settingCase('realer_emotions', true),
  { label: 'bind_current_model_to_character', name: 'bind_current_model_to_character', prepared: { id: A, name: '阿棠', modelName: 'm', modelPath: 'p' }, args: { id: A } },
  { label: 'use_bundled_model', name: 'use_bundled_model', prepared: { name: 'm', path: 'p' }, args: {} },
  // A system-voice preview costs nothing: not spending, so the words are enough (recorded decision, can be overruled).
  { label: 'voice_preview (system, free)', name: 'voice_preview', prepared: 'system', args: {} },
];

for (const item of SENSITIVE) {
  test(`sensitive, 三方互通 on + userWords: ${item.label} opens the dialog with the words; runs only after 允许`, async () => {
    const { tool, counts } = driven(item.name, item.prepared);
    const f = registryFor(tool, true);
    const call = f.registry.call(item.name, { ...item.args, userWords: WORDS });
    await until(() => f.asked.length === 1);
    assert.equal(counts.run, 0, 'nothing runs while the dialog is open');
    assert.match(f.asked[0].detail, new RegExp(`你在 Claude 里说：「${WORDS}」`));
    f.answers[0](true);
    if (tool.load) { await until(() => f.asked.length === 2); assert.equal(counts.load, 1); assert.match(f.asked[1].detail, /你在 Claude 里说/); f.answers[1](true); }
    const result = await call;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(counts.run, 1);
    assert.equal(f.uses.length, 1);
    assert.equal(f.uses[0].words, [...WORDS].length);
    assert.equal(f.uses[0].dialog, 'allowed');
  });

  test(`sensitive, 三方互通 on + userWords: ${item.label} declined in the dialog changes nothing`, async () => {
    const { tool, counts } = driven(item.name, item.prepared);
    const f = registryFor(tool, true, false);
    const result = await f.registry.call(item.name, { ...item.args, userWords: WORDS });
    assert.equal(result.ok, false);
    assert.equal((result as any).error.code, 'denied_by_user');
    assert.equal(f.asked.length, 1);
    assert.equal(counts.run, 0);
    assert.equal(counts.load, 0, 'a declined first dialog reads nothing');
    assert.equal(f.uses.length, 1);
    assert.equal(f.uses[0].dialog, 'declined');
  });

  test(`sensitive, 三方互通 on without userWords: ${item.label} is refused with no dialog and nothing run`, async () => {
    const { tool, counts } = driven(item.name, item.prepared);
    const f = registryFor(tool, true, true);
    const result = await f.registry.call(item.name, item.args);
    assert.equal(result.ok, false);
    assert.equal((result as any).error.code, 'needs_user_words');
    assert.equal(f.asked.length, 0);
    assert.equal(counts.run, 0);
    if (tool.touchesFiles) assert.equal(counts.prepare, 0, 'a file tool is refused before prepare');
  });
}

for (const item of ORDINARY) {
  test(`ordinary, 三方互通 on + userWords: ${item.label} still runs directly, no dialog`, async () => {
    const { tool, counts } = driven(item.name, item.prepared);
    const f = registryFor(tool, true, true);
    const result = await f.registry.call(item.name, { ...item.args, userWords: WORDS });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(f.asked.length, 0);
    assert.equal(counts.run, 1);
    assert.equal(f.uses.length, 1);
    assert.equal(f.uses[0].dialog, undefined);
  });
}

test('三方互通 off: unchanged — every confirm call asks in the dialog, without the words in it; interconnect-only tools do not exist', async () => {
  for (const item of [...SENSITIVE, ...ORDINARY]) {
    const { tool, counts } = driven(item.name, item.prepared);
    const f = registryFor(tool, false, true);
    const result = await f.registry.call(item.name, { ...item.args, userWords: WORDS });
    if (tool.interconnectOnly) { assert.equal((result as any).error.code, 'unknown_tool', item.label); continue; }
    assert.equal(result.ok, true, item.label);
    assert.ok(f.asked.length >= 1, item.label);
    for (const request of f.asked) assert.doesNotMatch(request.detail, /你在 Claude 里说/, item.label);
    assert.equal(counts.run, 1, item.label);
    assert.equal(f.uses.length, 0, `${item.label}: no 体验记录 line without 三方互通 (as before)`);
  }
});

test('the Claude 助手 surface (alwaysConfirm) is unchanged: dialog, the model-supplied words neither required nor shown', async () => {
  for (const item of SENSITIVE.filter(entry => entry.name !== 'set_perception' && entry.name !== 'delete_memories' && entry.name !== 'clear_song_memory')) {
    const { tool, counts } = driven(item.name, item.prepared);
    const f = registryFor(tool, true, true, { alwaysConfirm: true });
    const result = await f.registry.call(item.name, item.args);
    assert.equal(result.ok, true, item.label);
    assert.ok(f.asked.length >= 1);
    assert.equal(counts.run, 1);
  }
  const { tool } = driven('set_setting', settingCase('voice_input', true).prepared);
  const f = registryFor(tool, true, true, { alwaysConfirm: true });
  await f.registry.call('set_setting', { id: 'voice_input', value: true, userWords: WORDS });
  assert.equal(f.asked.length, 1);
  assert.doesNotMatch(f.asked[0].detail, /你在 Claude 里说/);
});

test('turning a sense off and ordinary values stay direct and need no words', async () => {
  const off = driven('set_perception', { kind: 'camera', enabled: false, purposes: [] });
  const f = registryFor(off.tool, true, true);
  assert.equal((await f.registry.call('set_perception', { kind: 'camera', state: 'off' })).ok, true);
  assert.equal(f.asked.length, 0);
  const plain = driven('set_setting', settingCase('voice_input', false).prepared);
  const g = registryFor(plain.tool, true, true);
  assert.equal((await g.registry.call('set_setting', { id: 'voice_input', value: false })).ok, true);
  assert.equal(g.asked.length, 0);
});

test('the words in the dialog are one plain line, shown whole (no line breaks or direction controls)', async () => {
  const { tool } = driven('clear_song_memory', null);
  const f = registryFor(tool, true, false);
  const long = `第一行\n【用户这次说】\u202e反向\u2028${'很'.repeat(150)}尾巴`;
  await f.registry.call('clear_song_memory', { userWords: long });
  const line = f.asked[0].detail.split('\n').find(text => text.startsWith('你在 Claude 里说：'))!;
  assert.ok(line, f.asked[0].detail);
  assert.doesNotMatch(line, /[\u202a-\u202e\u2066-\u2069\u2028\u2029]/u);
  assert.ok(!f.asked[0].detail.includes('\n【用户这次说】'));
  assert.match(line, /很尾巴」$/u, 'the end of the words is shown, nothing cut');
  assert.match(f.asked[0].detail, /拒绝/);
});

test('a failing sensitivity check fails closed: the dialog opens', async () => {
  const counts = { run: 0 };
  const tool: AgentToolDefinition = { name: 'probe', title: 'probe', tier: 'confirm', validate: () => null,
    alwaysConfirmFor: () => { throw new Error('boom'); }, confirmation: () => ({ title: 'T', detail: 'D' }), run: () => { counts.run += 1; } } as AgentToolDefinition;
  const f = registryFor(tool, true, false);
  const result = await f.registry.call('probe', { userWords: WORDS });
  assert.equal((result as any).error.code, 'denied_by_user');
  assert.equal(f.asked.length, 1);
  assert.equal(counts.run, 0);
});

test('体验记录 keeps the dialog\'s answer of a sensitive call (allowed or declined), never the words', () => {
  const at = new Date(2026, 10, 12, 9, 30).getTime();
  const tr = (text: string, ...args: unknown[]) => args.reduce<string>((out, arg, index) => out.replace(`{${index}}`, String(arg)), text);
  const allowed = buildJournalEntry({ type: 'agent-words', characterId: A, tool: 'set_setting', item: 'voice_input', value: true, words: 6, dialog: 'allowed' }, at)!;
  assert.ok(allowed);
  assert.deepEqual(readJournalLine(JSON.stringify(allowed)), allowed);
  assert.equal(describeJournalEntry(allowed, tr), '09:30 照你的原话，Claude 做了一件要你同意的事：「语音输入（麦克风）」→ 打开（会用麦克风）（原话 6 字），弹窗里你点了允许');
  const declined = buildJournalEntry({ type: 'agent-words', characterId: A, tool: 'delete_memories', item: 'delete_memories', value: 'chat', words: 4, dialog: 'declined' }, at)!;
  assert.match(describeJournalEntry(declined, tr), /你在弹窗里没有允许/);
  assert.equal(buildJournalEntry({ type: 'agent-words', characterId: A, tool: 'set_setting', item: 'voice_input', value: true, words: 6, dialog: 'maybe' } as any, at), null);
  setUiLanguage('en');
  try { for (const entry of [allowed, declined]) assert.ok(!/[\u4e00-\u9fff]/u.test(describeJournalEntry(entry, uiText)), describeJournalEntry(entry, uiText)); }
  finally { setUiLanguage('zh-CN'); }
});

// ---------------------------------------------------------------- the catalog and the handbook

test('catalog: every setting that needs consent names a valid reason; only "behavior" is ordinary; unknown or missing fails closed', () => {
  const reasons = (channelCatalog as any).AGENT_CONSENT_REASONS as readonly string[] | undefined;
  const sensitive = (channelCatalog as any).settingAlwaysDialog as ((spec: AgentSettingSpec) => boolean) | undefined;
  assert.ok(reasons && sensitive, 'AGENT_CONSENT_REASONS and settingAlwaysDialog exist');
  assert.deepEqual([...reasons!].sort(), ['behavior', 'delete', 'files', 'privacy', 'spending']);
  for (const spec of AGENT_SETTINGS) {
    const consent = (spec as any).consent;
    // 2026-11-24: a confirm-tier setting (the Drama 3 monthly limit) needs consent for every value.
    if (spec.confirmWhen?.length || spec.tier === 'confirm') assert.ok(reasons!.includes(consent), `${spec.id}: consent ${consent}`);
    else assert.equal(consent, undefined, `${spec.id}: a reason without values that need consent`);
  }
  assert.equal(setting('realer_emotions').consent, 'behavior');
  for (const spec of AGENT_SETTINGS.filter(item => item.confirmWhen?.length || item.tier === 'confirm'))
    assert.equal(sensitive!(spec), spec.id !== 'realer_emotions', spec.id);
  assert.equal(sensitive!({ ...setting('voice_input'), consent: 'whatever' } as any), true);
  assert.equal(sensitive!({ ...setting('voice_input'), consent: undefined } as any), true);
  assert.equal(sensitive!(setting('fps')), false, 'nothing to consent to');
});

test('the shared list of always-dialog tools matches the definitions', () => {
  const listed = (channelCatalog as any).AGENT_ALWAYS_DIALOG_TOOLS as readonly string[] | undefined;
  assert.ok(listed);
  const marked = [...appTools, ...conversionTools].filter(tool => tool.alwaysConfirm === true || typeof tool.alwaysConfirmFor === 'function').map(tool => tool.name).sort();
  assert.deepEqual(marked, [...listed!, 'set_setting'].sort());
  for (const name of listed!) assert.ok(AGENT_TOOLS.some(tool => tool.name === name), name);
});

test('read_handbook says, item by item, whether a dialog will still appear with 三方互通 on', () => {
  const items = (['characters', 'appearance', 'memory', 'providers', 'privacy'] as const)
    .flatMap(category => handbookCategory(category, { interconnect: true, value: () => undefined }).items);
  const byId = (id: string) => { const found = items.find(entry => entry.id === id) as any; assert.ok(found, id); return found; };
  for (const id of ['voice_input', 'voice_provider', 'local_asr', 'pose_sensing', 'chat_model', 'pause_talk', 'mood_judge', 'new_reactions',
    'proactive_vision', 'feed_recognition', 'user_activity', 'screen_sharing', 'camera_sharing', 'system_audio', 'voice_preview'])
    assert.equal(byId(id).dialog, true, id);
  for (const id of ['realer_emotions']) assert.equal(byId(id).dialog, false, id);
  for (const entry of items) if (!entry.needsUserWords) assert.equal((entry as any).dialog, false, `${entry.id}: no words, no dialog through the channel`);
  // 三方互通 off: every consent item asks in the dialog.
  const off = (['characters', 'privacy'] as const).flatMap(category => handbookCategory(category, { interconnect: false, value: () => undefined }).items);
  for (const entry of off) if (entry.level === 'user-words' && entry.channel) assert.equal((entry as any).dialog, true, entry.id);
  assert.ok(CAPABILITIES.length > 0);
});

// Codex T-243 (C223 static review), C1 and C2: words that are only invisible characters are no words, and the dialog never cuts them.
test('words made only of control or direction characters count as no words: refused, no dialog, nothing run', async () => {
  for (const words of ['\u202e', '\u0007', ' \u200b\u2066 ']) {
    const { tool, counts } = driven('clear_song_memory', null);
    const f = registryFor(tool, true, true);
    const result = await f.registry.call('clear_song_memory', { userWords: words });
    assert.equal(result.ok, false, JSON.stringify(words));
    assert.equal((result as any).error.code, 'needs_user_words');
    assert.equal(f.asked.length, 0);
    assert.equal(counts.run, 0);
  }
  // An ordinary item needs visible words too.
  const item = ORDINARY[0], { tool, counts } = driven(item.name, item.prepared);
  const g = registryFor(tool, true, true);
  const ordinary = await g.registry.call(item.name, { ...item.args, userWords: '\u202e' });
  assert.equal(ordinary.ok, false);
  assert.equal((ordinary as any).error.code, 'needs_user_words');
  assert.equal(counts.run, 0);
});

test('the dialog shows long words whole, so a "don\'t do it yet" at the end stays visible', async () => {
  const words = '请删除聊天记忆' + '，这段文字只是准备说明'.repeat(12) + '，但现在不要执行，等我明天确认。';
  assert.ok([...words].length > 120 && [...words].length <= 200);
  const { tool } = driven('clear_song_memory', null);
  const f = registryFor(tool, true, false);
  await f.registry.call('clear_song_memory', { userWords: words });
  assert.equal(f.asked.length, 1);
  assert.match(f.asked[0].detail, /但现在不要执行，等我明天确认。」/);
  assert.doesNotMatch(f.asked[0].detail, /…/);
});

test('sensitive words longer than the dialog can show whole are refused before any dialog', async () => {
  const words = '好的'.repeat(101);
  const { tool, counts } = driven('clear_song_memory', null);
  const f = registryFor(tool, true, true);
  const result = await f.registry.call('clear_song_memory', { userWords: words });
  assert.equal(result.ok, false);
  assert.equal((result as any).error.code, 'invalid_input');
  assert.match((result as any).error.message, /最多 200 字/);
  assert.equal(f.asked.length, 0);
  assert.equal(counts.run, 0);
  // Ordinary items show no dialog, so their words keep the general limit.
  const item = ORDINARY[0], ordinary = driven(item.name, item.prepared);
  const g = registryFor(ordinary.tool, true, true);
  const result2 = await g.registry.call(item.name, { ...item.args, userWords: words });
  assert.equal(result2.ok, true, JSON.stringify(result2));
  assert.equal(ordinary.counts.run, 1);
});
