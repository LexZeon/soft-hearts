// 2026-11-24: the internal channel opens the two
// spending choices to the user's own Claude, each as "the user's words AND the dialog the user clicks" (CLAUDE.md 敏感操作弹窗):
//   1. Drama 3's monthly limit (set_setting drama3_monthly_limit; 0 = no limit, 1..500 US dollars, as the control window);
//   2. any character's own voice provider, the paid ones included (set_character_voice; the 角色页's 「她的声音」 choice).
// Keys, Bailian's address and region stay closed. The read side (list_settings' voices, read_handbook) answers "是不是额度没了".
// Synthetic data through the real AgentToolRegistry and the fake soft hearts of tests/helpers/app-tools-world.ts; no Electron, no Claude.
// docs/claude/2026-11-24-channel-voice-spend.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_ALWAYS_DIALOG_TOOLS, AGENT_TOOLS, agentSetting, settingAlwaysDialog, settingValueNeedsConsent } from '../shared/safety/agent-channel';
import { FISH_MONTHLY_CAP_MAX_USD, validFishMonthlyCap } from '../shared/voice/fish-voice';
import { CAPABILITIES } from '../shared/settings/capabilities';
import { handbookCategory } from '../shared/settings/capability-handbook';
import { AgentToolRegistry } from '../electron/safety/agent-channel/registry';
import { AGENT_HOST_OPERATIONS, createHostBridge, type IpcHandler } from '../electron/safety/agent-channel/bridge';
import * as appTools from '../electron/safety/agent-channel/app-tools';
import { characterVoiceArgs } from '../electron/safety/agent-channel/tools/voice';
import { drama3View, voiceCostLine } from '../electron/safety/agent-channel/tools/voice-spend';
import { A, B, NOW, WORDS, makeWorld, type Tweak } from './helpers/app-tools-world';

type World = ReturnType<typeof makeWorld>;
const registryFor = (world: World, options: { interconnect?: boolean; answer?: boolean; assistant?: boolean } = {}) => {
  const asked: { title: string; detail: string }[] = [];
  let undo: { label: string; run(guard: () => void): unknown } | undefined;
  world.state.interconnect = options.interconnect ?? true;
  const registry = new AgentToolRegistry(appTools.createAppTools(world.bridge, world.options), {
    enabled: () => true, interconnect: () => options.interconnect ?? true, ...(options.assistant ? { alwaysConfirm: true } : {}),
    confirm: async request => { asked.push({ title: request.title, detail: request.detail }); return options.answer ?? true; },
    called: (_summary, offer) => { undo = offer; }, now: () => 0, confirmTimeoutMs: 1000, runTimeoutMs: 1000,
  });
  return { registry, asked, undo: () => undo };
};
const opNames = (world: World) => world.ops.map(op => (op as { op: string }).op);
const voiceOf = (world: World, id: string) => (world.state.cards.cards.find(card => card.id === id) as { voice?: unknown }).voice;
const limitOf = (world: World) => world.state.settings.tts?.fishMonthlyCapUsd;
const call = async (name: string, args: Record<string, unknown>, tweak?: Tweak, options: Parameters<typeof registryFor>[1] = {}) => {
  const world = makeWorld(tweak), run = registryFor(world, options);
  return { world, ...run, result: await run.registry.call(name, args) };
};

// ---------------------------------------------------------------- the catalog and the handbook

test('the catalog: the limit is a spending setting with the control window\'s range; the character voice tool always asks when it spends; no chat words', () => {
  const spec = agentSetting('drama3_monthly_limit')!;
  assert.ok(spec && spec.kind === 'number');
  assert.deepEqual([spec.min, spec.max, spec.step, spec.tier, spec.consent, spec.chat, spec.interconnectOnly], [0, FISH_MONTHLY_CAP_MAX_USD, 1, 'confirm', 'spending', false, true]);
  assert.equal(spec.chatWords, undefined, 'no chat words for these (no words hard-coded in the program)');
  for (const value of [0, 1, 20, 500]) assert.equal(settingValueNeedsConsent(spec, value), true, `${value}: every value is a spending decision`);
  assert.equal(settingAlwaysDialog(spec), true, 'and the dialog appears even with the user\'s words');
  assert.ok(AGENT_ALWAYS_DIALOG_TOOLS.includes('set_character_voice'));
  const tool = AGENT_TOOLS.find(item => item.name === 'set_character_voice')!;
  assert.deepEqual([tool.tier, tool.interconnectOnly, Object.keys(tool.inputSchema.properties).sort()], ['reversible', true, ['id', 'provider', 'userWords', 'voiceId']]);
  const entry = (id: string) => CAPABILITIES.find(item => item.id === id)!;
  for (const id of ['tts_fish_cap', 'character_voice']) assert.equal(entry(id).level, 'user-words', id);
  for (const id of ['tts_key', 'tts_fish_key', 'tts_connection', 'asr_key']) assert.equal(entry(id).level, 'never', `${id} stays closed`);
  const providers = handbookCategory('providers', { interconnect: true, value: () => undefined }).items.find(item => item.id === 'tts_fish_cap')!;
  const characters = handbookCategory('characters', { interconnect: true, value: () => undefined }).items.find(item => item.id === 'character_voice')!;
  for (const item of [providers, characters]) assert.deepEqual([item.channel, item.needsUserWords, item.dialog], [true, true, true], item.id);
});

// ---------------------------------------------------------------- 1. the monthly limit

test('the monthly limit: no words → refused, nothing asked or written; words → the dialog with the words, the spending and the price', async () => {
  const quiet = await call('set_setting', { id: 'drama3_monthly_limit', value: 20 });
  assert.equal(!quiet.result.ok && quiet.result.error.code, 'needs_user_words');
  assert.deepEqual([quiet.world.ops, quiet.asked.length, limitOf(quiet.world)], [[], 0, 0]);

  const done = await call('set_setting', { id: 'drama3_monthly_limit', value: 20, userWords: WORDS });
  assert.ok(done.result.ok);
  assert.equal(done.asked.length, 1, 'the dialog opened even with the words');
  assert.match(done.asked[0].title, /每月上限改为 20 美元/u);
  assert.match(done.asked[0].detail, /从：不设上限\n改为：20 美元\n本月（2026-11）已经花了约 \$1\.20/u);
  assert.match(done.asked[0].detail, /每百万字节约 10 美元/u);
  assert.match(done.asked[0].detail, new RegExp(`「${WORDS}」`, 'u'), 'the user\'s own words are shown');
  assert.equal(limitOf(done.world), 20);
  // Only the limit moved: no key, no address, no region, no provider.
  assert.deepEqual((done.world.ops.find(op => (op as { op: string }).op === 'saveSettings') as { changed: unknown }).changed, { 'tts.fishMonthlyCapUsd': 20 });
  assert.equal(done.undo(), undefined, 'no 撤回: going back is a spending decision too');
});

test('the monthly limit: a declined dialog changes nothing; with 三方互通 off it does not exist; the Claude 助手 always asks', async () => {
  const declined = await call('set_setting', { id: 'drama3_monthly_limit', value: 50, userWords: WORDS }, 'fish-spent', { answer: false });
  assert.equal(!declined.result.ok && declined.result.error.code, 'denied_by_user');
  assert.deepEqual([opNames(declined.world), limitOf(declined.world)], [[], 10]);
  const off = await call('set_setting', { id: 'drama3_monthly_limit', value: 50 }, undefined, { interconnect: false });
  assert.equal(!off.result.ok && off.result.error.code, 'invalid_input');
  assert.deepEqual([off.world.ops, off.asked.length], [[], 0]);
  const assistant = await call('set_setting', { id: 'drama3_monthly_limit', value: 50 }, undefined, { assistant: true, answer: false });
  assert.equal(assistant.asked.length, 1);
  assert.equal(limitOf(assistant.world), 0);
});

test('the monthly limit: 0 means no limit, 1..500 whole dollars, the same meaning as the control window; anything else is refused before any dialog', async () => {
  for (const value of [0, 1, 37, 500]) {
    const { result, world } = await call('set_setting', { id: 'drama3_monthly_limit', value, userWords: WORDS }, 'fish-spent');
    assert.ok(result.ok, String(value));
    assert.equal(limitOf(world), value);
    assert.equal(validFishMonthlyCap(limitOf(world)), value, 'the host reads it exactly as written');
  }
  for (const value of [-1, 501, 2.5, '20', null, true]) {
    const { result, world, asked } = await call('set_setting', { id: 'drama3_monthly_limit', value, userWords: WORDS });
    assert.equal(!result.ok && result.error.code, 'invalid_input', String(value));
    assert.deepEqual([world.ops, asked.length], [[], 0]);
  }
  // A limit below what is already spent says she switches to the system voice now; "no limit" says the balance decides.
  const below = await call('set_setting', { id: 'drama3_monthly_limit', value: 5, userWords: WORDS }, 'fish-spent');
  assert.match(below.asked[0].detail, /本月已经花到 5 美元以上：改完后她这个月先用系统声音/u);
  const none = await call('set_setting', { id: 'drama3_monthly_limit', value: 0, userWords: WORDS }, 'fish-spent');
  assert.match(none.asked[0].detail, /从：10 美元\n改为：不设上限[\s\S]*预充的余额/u);
});

// ---------------------------------------------------------------- 2. a character's own voice

test('a paid voice for a named character who is not the active one: no words → refused; words → the dialog with its price; only her card changes', async () => {
  const quiet = await call('set_character_voice', { id: B, provider: 'fish', voiceId: 'g6_drama' }, 'paid-fish');
  assert.equal(!quiet.result.ok && quiet.result.error.code, 'needs_user_words');
  assert.deepEqual([quiet.world.ops, quiet.asked.length, voiceOf(quiet.world, B)], [[], 0, undefined]);

  const done = await call('set_character_voice', { id: B, provider: 'fish', voiceId: 'g6_drama', userWords: WORDS }, 'paid-fish');
  assert.ok(done.result.ok);
  assert.equal(done.world.state.cards.activeId, A, 'B is not the active character');
  assert.deepEqual(voiceOf(done.world, B), { provider: 'fish', voiceId: 'g6_drama' });
  assert.equal(voiceOf(done.world, A), undefined, 'the active character keeps hers');
  assert.deepEqual(opNames(done.world), ['saveCharacterVoice'], 'no settings save: no key, address or region can move');
  assert.match(done.asked[0].title, /「小雨」的声音换成Drama 3/u);
  assert.match(done.asked[0].detail, /按字节付费[\s\S]*每百万字节约 10 美元[\s\S]*每月上限：不设/u);
  assert.match(done.asked[0].detail, new RegExp(`「${WORDS}」`, 'u'));
  assert.equal(done.undo(), undefined, 'a paid voice is not undone by 撤回 (the way back would not need the words, the way here did)');

  const bailian = await call('set_character_voice', { id: B, provider: 'bailian', userWords: WORDS });
  assert.match(bailian.asked[0].detail, /百炼按次付费：她每读一句，都会用你的百炼账号产生一次费用/u);
  const declined = await call('set_character_voice', { id: B, provider: 'bailian', userWords: WORDS }, undefined, { answer: false });
  assert.equal(!declined.result.ok && declined.result.error.code, 'denied_by_user');
  assert.deepEqual([declined.world.ops, voiceOf(declined.world, B)], [[], undefined]);
});

test('a free voice is direct and undoable while what it replaced was free; "default" spends when the default is paid; nothing changing asks nothing', async () => {
  const free = await call('set_character_voice', { id: B, provider: 'system' });
  assert.ok(free.result.ok);
  assert.deepEqual([free.asked.length, voiceOf(free.world, B)], [0, { provider: 'system', voiceId: '' }]);
  await free.undo()!.run(() => {});
  assert.equal(voiceOf(free.world, B), undefined, 'undone: she follows the default again');
  // From a paid voice to the free one: direct, but no undo back to the paid one.
  const fromPaid = await call('set_character_voice', { id: A, provider: 'system' }, 'own-fish');
  assert.ok(fromPaid.result.ok);
  assert.equal(fromPaid.undo(), undefined);
  // "default" while the default for new characters is Drama 3 is a spending decision.
  const toDefault = await call('set_character_voice', { id: A, provider: 'default' }, 'own-fish');
  assert.ok(toDefault.result.ok, 'default is the free system voice here: direct');
  const paidDefault = makeWorld('paid-fish');
  (paidDefault.state.cards.cards[1] as { voice?: unknown }).voice = { provider: 'system', voiceId: '' };
  const refused = await registryFor(paidDefault).registry.call('set_character_voice', { id: B, provider: 'default' });
  assert.equal(!refused.ok && refused.error.code, 'needs_user_words');
  assert.deepEqual(voiceOf(paidDefault, B), { provider: 'system', voiceId: '' });
  // Asking for what she already has changes nothing and needs no words.
  const same = makeWorld('own-fish');
  const unchanged = await registryFor(same).registry.call('set_character_voice', { id: A, provider: 'fish' });
  assert.ok(unchanged.ok);
  assert.deepEqual([same.ops, (unchanged.result as { unchanged?: boolean }).unchanged], [[], true]);
  // The undo refuses once her voice changed again (on the page).
  const later = await call('set_character_voice', { id: B, provider: 'system' });
  (later.world.state.cards.cards[1] as { voice?: unknown }).voice = { provider: 'system', voiceId: 'typed on the page' };
  await assert.rejects(Promise.resolve(later.undo()!.run(() => {})), /之后又改过了/u);
});

test('keys and addresses stay closed: unknown arguments, unknown settings and the old tools all refuse them before anything happens', async () => {
  for (const extra of [{ apiKey: 'sk-x' }, { fishApiKey: 'x' }, { apiHost: 'evil.example' }, { region: 'intl' }, { fishMonthlyCapUsd: 1 }])
    assert.throws(() => characterVoiceArgs({ id: A, provider: 'fish', ...extra }), /不认识的参数/u, JSON.stringify(extra));
  for (const args of [{ id: A, provider: 'bailian', apiHost: 'evil.example', userWords: WORDS }, { id: B, provider: 'fish', fishApiKey: 'x', userWords: WORDS }]) {
    const { result, world, asked } = await call('set_character_voice', args);
    assert.equal(!result.ok && result.error.code, 'invalid_input');
    assert.deepEqual([world.ops, asked.length], [[], 0]);
  }
  for (const id of ['tts_key', 'tts_fish_key', 'tts_connection', 'tts_api_host', 'tts_region', 'fishApiKey']) {
    const { result, world } = await call('set_setting', { id, value: 'x', userWords: WORDS });
    assert.equal(!result.ok && result.error.code, 'invalid_input', id);
    assert.deepEqual(world.ops, []);
  }
  for (const extra of [{ apiKey: 'x' }, { apiHost: 'evil.example' }, { region: 'intl' }, { fishApiKey: 'x' }, { fishMonthlyCapUsd: 3 }]) {
    const { result, world } = await call('set_voice_style', { rate: 1.1, ...extra });
    assert.equal(!result.ok && result.error.code, 'invalid_input', JSON.stringify(extra));
    assert.deepEqual(world.ops, []);
  }
  // A voice id that is a path or a link never reaches a card.
  for (const voiceId of ['../x', 'C:\\keys\\a', 'https://evil.example/v']) assert.throws(() => characterVoiceArgs({ id: A, provider: 'fish', voiceId }));
});

// ---------------------------------------------------------------- the read side

test('list_settings and read_handbook say the limit, this month\'s spending (numbers only) and each character\'s voice: enough for "是不是额度没了"', async () => {
  const world = makeWorld('fish-spent');
  (world.state.cards.cards[1] as { voice?: unknown }).voice = { provider: 'fish', voiceId: 'g6_drama' };
  const { registry } = registryFor(world);
  const listed = await registry.call('list_settings', {});
  assert.ok(listed.ok);
  const voices = (listed.result as { voices: any }).voices;
  assert.deepEqual(voices.drama3, { monthlyLimitUsd: 10, noLimit: false, month: '2026-11', spentUsd: 12.5, bytes: 1_250_000, reachedLimit: true, usdPerMillionBytes: 10, keySaved: true });
  assert.deepEqual(voices.characters.map((row: any) => [row.name, row.active, row.own?.provider ?? null, row.provider, row.speaksWith, row.because ?? null]),
    [['阿棠', true, null, 'system', 'system', null], ['小雨', false, 'fish', 'fish', 'system', '本月 Drama 3 已经到上限']]);
  assert.equal(voices.newCharacterDefault, 'system');
  const limit = (listed.result as { settings: { id: string; value: unknown }[] }).settings.find(item => item.id === 'drama3_monthly_limit');
  assert.equal(limit?.value, 10);
  const text = JSON.stringify(voices);
  assert.doesNotMatch(text, /••••|dashscope\.example|apiKey|apiHost|region/u, 'no key, no address');

  const items = async (category: string) => {
    const read = await registry.call('read_handbook', { category });
    assert.ok(read.ok, category);
    return (read.result as { items: { id: string; now: any }[] }).items;
  };
  const cap = (await items('providers')).find(item => item.id === 'tts_fish_cap')!;
  assert.deepEqual([cap.now.monthlyLimitUsd, cap.now.spentUsd, cap.now.reachedLimit], [10, 12.5, true]);
  const own = (await items('characters')).find(item => item.id === 'character_voice')!;
  assert.deepEqual(own.now.map((row: any) => row.provider), ['system', 'fish']);
  // Unreadable spending is unknown, never zero.
  const blind = await registryFor(makeWorld('no-budget')).registry.call('list_settings', {});
  assert.ok(blind.ok);
  assert.deepEqual([(blind.result as any).voices.drama3.spentUsd, (blind.result as any).voices.drama3.reachedLimit], [null, null]);
});

test('the price follows the clock (the launch price until 12-01 Pacific), and an earlier month\'s record counts as zero this month', () => {
  assert.match(voiceCostLine('fish', new Date(NOW)), /每百万字节约 10 美元（11 月 30 日之后约 50 美元）/u);
  assert.match(voiceCostLine('fish', new Date(Date.UTC(2026, 11, 5))), /每百万字节约 50 美元，/u);
  const settings = makeWorld('fish-spent').state.settings;
  const old = drama3View(settings, { month: '2026-10', bytes: 9, spentMicroUsd: 99_000_000 }, new Date(NOW));
  assert.deepEqual([old.spentUsd, old.bytes, old.reachedLimit], [0, 0, false]);
});

test('the host reads the spending through the control window\'s own getTtsBudget (no arguments); anything odd is unknown', () => {
  assert.ok(AGENT_HOST_OPERATIONS.includes('getTtsBudget'));
  assert.ok(!AGENT_HOST_OPERATIONS.some(name => /Key|Host|Region|openFish/u.test(name)), 'no key, address or Fish account page');
  let answer: unknown = { month: '2026-11', bytes: 10, spentMicroUsd: 100 };
  const seen: unknown[][] = [];
  const controls = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, webContents: { id: 7, isDestroyed: () => false, send: () => {} } };
  const operations = new Map<string, IpcHandler>([['getTtsBudget', (_event: unknown, ...args: unknown[]) => { seen.push(args); return answer; }]]);
  // no-pet-ok: AgentHostWiring's own field name (the companion window), kept as the host names it
  const bridge = createHostBridge({ version: () => '1', controls: () => controls, pet: () => null, operations, admit: (_guard, run) => run(),
    importCharacterCard: async () => ({ cards: [], activeId: '' }), loadModel: async () => ({ name: 'm' } as never),
    // no-pet-ok: AgentHostWiring's own method name, kept as the host names it
    commitPetBoolean: async () => ({ persistence: 'saved', presentation: 'applied' }), commitReadoutVolume: async () => ({ persistence: 'saved', presentation: 'x' }),
    commitBreath: async () => ({ persistence: 'saved', presentation: 'x' }), replyLatency: () => [], broadcast: () => {} });
  assert.deepEqual(bridge.fishBudget!(), { month: '2026-11', bytes: 10, spentMicroUsd: 100 });
  assert.deepEqual(seen, [[]], 'called with no arguments');
  answer = { month: 'x', bytes: -1, spentMicroUsd: 'a lot' };
  assert.equal(bridge.fishBudget!(), null);
});
