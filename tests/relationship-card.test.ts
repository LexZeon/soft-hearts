import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CharacterCardStore } from '../electron/character-cards';
import { CHARACTER_CARD_FORMAT, CHARACTER_CARD_VERSION, validateCharacterDraft, type CharacterDraft } from '../shared/character-cards';
import { RelationshipHost } from '../electron/relationship/host';
import { AGENT_SETTINGS, agentSetting, validateAgentSettingValue } from '../shared/agent-channel';
import { createAppTools, settingViews, type AgentAppBridge } from '../electron/agent-channel/app-tools';
import { ChatSettingProposals, chatSettingsSystemText, currentSettingsText, mentionsSettings, parseChatSettingProposal } from '../electron/chat-settings';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import type { AppSettings } from '../shared/contracts';
import type { CharacterCardState } from '../shared/character-cards';
import { AgentToolRegistry } from '../electron/agent-channel/registry';
import { NEUTRAL_TENDENCIES } from '../shared/relationship';

const draft = (name: string, fields: Partial<CharacterDraft> = {}): CharacterDraft => ({
  name, description: '', personality: '', scenario: '', greeting: '', examples: '', systemPrompt: '', ...fields,
});
async function withStore(run: (store: CharacterCardStore, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-relationship-card-'));
  try { const store = new CharacterCardStore(directory, 'Existing custom persona'); await store.load(); await run(store, directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('the card field: off by default, older cards without it read as off, only a boolean is accepted', () => {
  const plain = validateCharacterDraft(draft('旧卡'));
  assert.equal(plain.slowWarmUp, undefined);
  assert.equal(Object.hasOwn(plain, 'slowWarmUp'), false, 'an older card stays exactly what it was');
  assert.equal(validateCharacterDraft(draft('新卡', { slowWarmUp: true })).slowWarmUp, true);
  assert.equal(validateCharacterDraft(draft('新卡', { slowWarmUp: false })).slowWarmUp, false);
  for (const bad of ['true', 1, 0, null, {}, []]) assert.throws(() => validateCharacterDraft({ ...draft('x'), slowWarmUp: bad } as never), /只能是开或关/, String(bad));
  assert.throws(() => validateCharacterDraft({ ...draft('x'), slowRelationship: true } as never), /只允许/);
});

test('a card that never turned it on is stored and exported byte for byte as before; turning it on and off leaves no trace', async () => {
  await withStore(async (store, directory) => {
    const state = await store.save(draft('阿棠'));
    const id = state.cards.find(card => card.name === '阿棠')!.id;
    const stored = () => readFile(path.join(directory, 'characters.json'), 'utf8').then(JSON.parse).then(value => value.cards.find((card: { id: string }) => card.id === id));
    assert.equal(Object.hasOwn(await stored(), 'slowWarmUp'), false);
    const exported = JSON.parse(store.export(id));
    assert.equal(exported.format, CHARACTER_CARD_FORMAT);
    assert.equal(exported.version, CHARACTER_CARD_VERSION);
    assert.equal(Object.hasOwn(exported.card, 'slowWarmUp'), false);
    // Saving an explicit "off" from the editor stores nothing either.
    await store.save(draft('阿棠', { slowWarmUp: false }), id);
    assert.equal(Object.hasOwn(await stored(), 'slowWarmUp'), false);
    // On: stored, exported, and read back by an import.
    await store.save(draft('阿棠', { slowWarmUp: true }), id);
    assert.equal((await stored()).slowWarmUp, true);
    assert.equal(store.publicState().cards.find(card => card.id === id)?.slowWarmUp, true);
    const onFile = store.export(id);
    assert.equal(JSON.parse(onFile).card.slowWarmUp, true, 'the switch travels with the card');
    const imported = await store.import(onFile);
    const copy = imported.cards.find(card => card.id !== id && card.name === '阿棠')!;
    assert.equal(copy.slowWarmUp, true);
    // An older file without the field imports as off.
    const older = JSON.stringify({ format: CHARACTER_CARD_FORMAT, version: CHARACTER_CARD_VERSION, card: { ...JSON.parse(onFile).card, slowWarmUp: undefined, name: '旧文件' } });
    const olderState = await store.import(older);
    assert.equal(olderState.cards.find(card => card.name === '旧文件')?.slowWarmUp, undefined);
    // A save from an editor that does not know the field keeps what was there.
    await store.save({ ...draft('阿棠') }, id);
    assert.equal((await stored()).slowWarmUp, true);
    // Off again: the field is gone, not "false".
    await store.save(draft('阿棠', { slowWarmUp: false }), id);
    assert.equal(Object.hasOwn(await stored(), 'slowWarmUp'), false);
  });
});

test('setSlowWarmUp changes only that card\'s switch', async () => {
  await withStore(async store => {
    await store.save(draft('甲')); await store.save(draft('乙'));
    const cards = store.publicState().cards;
    const [a, b] = [cards.find(card => card.name === '甲')!, cards.find(card => card.name === '乙')!];
    const before = JSON.stringify(store.publicState().cards.filter(card => card.id !== a.id));
    const state = await store.setSlowWarmUp(a.id, true);
    assert.equal(state.cards.find(card => card.id === a.id)?.slowWarmUp, true);
    assert.equal(JSON.stringify(state.cards.filter(card => card.id !== a.id)), before, 'no other card changes');
    assert.equal(state.cards.find(card => card.id === b.id)?.slowWarmUp, undefined);
    assert.equal(state.cards.find(card => card.id === a.id)?.name, '甲');
    const same = await store.setSlowWarmUp(a.id, true);
    assert.equal(same.revision, state.revision, 'no change, no new revision');
    const off = await store.setSlowWarmUp(a.id, false);
    assert.equal(off.cards.find(card => card.id === a.id)?.slowWarmUp, undefined);
    await assert.rejects(async () => store.setSlowWarmUp(a.id, 'yes' as never));
    await assert.rejects(() => store.setSlowWarmUp('missing', true), /不存在/);
  });
});

test('the exported card carries no relationship data: no days, no nickname, no memes', async () => {
  await withStore(async (store, directory) => {
    const id = store.publicState().activeId;
    await store.setSlowWarmUp(id, true);
    const host = new RelationshipHost({ directory, developerMode: () => false });
    host.setCardSource(() => ({ slowWarmUp: true, tendencies: { ...NEUTRAL_TENDENCIES } }));
    await host.prepare({ characterId: id, providerScope: 'x' }, () => ({ first: null, rounds: new Map() }));
    for (let i = 0; i < 3; i++) await host.noteRound(id);
    await host.setNickname(id, '小糖保密');
    await host.flush();
    const exported = store.export(id);
    assert.equal(exported.includes('小糖保密'), false);
    const card = JSON.parse(exported).card as Record<string, unknown>;
    assert.deepEqual(Object.keys(card).sort(), ['description', 'examples', 'greeting', 'mood', 'name', 'personality', 'scenario', 'slowWarmUp', 'systemPrompt']);
    for (const name of ['days', 'metDate', 'nickname', 'meme', 'memes', 'qualityDays', 'milestones', 'relationship']) assert.equal(exported.includes(`"${name}"`), false, name);
    // The numbers live in their own file, not in the card store.
    assert.equal((await readFile(path.join(directory, 'characters.json'), 'utf8')).includes('小糖保密'), false);
    assert.equal((await readFile(path.join(directory, 'relationship', `${id}.json`), 'utf8')).includes('小糖保密'), true);
  });
});

// ---- the chat setting ----

const settings = (): AppSettings => structuredClone(DEFAULT_SETTINGS);
const cards = (slowWarmUp?: boolean): Pick<CharacterCardState, 'cards' | 'activeId'> => ({
  activeId: 'a', cards: [{ id: 'a', ...draft('甲', slowWarmUp === undefined ? {} : { slowWarmUp }) }, { id: 'b', ...draft('乙') }],
});

test('the setting is in the catalog as a reversible boolean on the current character, and is told to Claude as a fixed catalog line', () => {
  const spec = agentSetting('slow_warm_up')!;
  assert.equal(spec.label, '当前角色慢慢升温');
  assert.equal(spec.kind, 'boolean');
  assert.equal(spec.tier, 'reversible');
  assert.equal(validateAgentSettingValue(spec, true), true);
  assert.throws(() => validateAgentSettingValue(spec, 'on'));
  assert.ok(AGENT_SETTINGS.some(item => item.id === 'slow_warm_up'));
  assert.match(chatSettingsSystemText(), /slow_warm_up：当前角色慢慢升温/);
  // The value is read from the active card, not from the app settings.
  assert.equal(settingViews(settings(), cards(true)).find(view => view.id === 'slow_warm_up')?.value, true);
  assert.equal(settingViews(settings(), cards()).find(view => view.id === 'slow_warm_up')?.value, false);
  assert.equal(settingViews(settings()).find(view => view.id === 'slow_warm_up')?.value, null);
  assert.match(currentSettingsText(settings(), AGENT_SETTINGS, cards(false)), /slow_warm_up=false/);
  for (const text of ['想让她慢慢跟我熟起来', '她能不能别那么客气', '开启慢慢升温', '希望一开始就很熟', '你太慢热了']) assert.equal(mentionsSettings(text), true, text);
});

test('a proposal to warm up slowly only becomes a card; nothing changes until the user taps, and only the current card changes', async () => {
  const applied: Array<[string, unknown]> = [];
  const sent: Array<{ state: string; label: string }> = [];
  const proposals = new ChatSettingProposals({
    settings, cards: () => cards(false),
    send: (_owner, card) => { sent.push({ state: card.state, label: card.label }); },
  });
  proposals.connect(async (id, value) => { applied.push([id, value]); return { ok: true, value: {} } as never; });
  const turn = proposals.beginTurn('我想让她慢慢跟我熟起来');
  assert.ok(turn.instruction, 'the proposal protocol is offered for this message');
  assert.match(turn.instruction!('<s>', '</s>'), /slow_warm_up=false/);
  const raw = JSON.stringify({ id: 'slow_warm_up', value: true, reason: '想慢慢熟起来' });
  const parsed = parseChatSettingProposal(raw, id => settingViews(settings(), cards(false)).find(view => view.id === id)?.value ?? null);
  assert.ok(parsed && parsed.value === true);
  assert.equal(parseChatSettingProposal(JSON.stringify({ id: 'slow_warm_up', value: false }), id => settingViews(settings(), cards(false)).find(view => view.id === id)?.value ?? null), null,
    'proposing what is already so is not a proposal');
  const card = proposals.offer(turn.ticket, 1, 'reply-1', raw);
  assert.ok(card);
  assert.equal(card!.settingId, 'slow_warm_up');
  assert.equal(card!.label, '当前角色慢慢升温');
  assert.equal(applied.length, 0, 'showing the card changes nothing');
  assert.deepEqual(card!.choices.map(choice => choice.label), ['慢慢升温']);
  const tap = card!.choices.find(choice => choice.proposed)!;
  await proposals.choose(1, { proposalId: card!.proposalId, choiceId: tap.choiceId });
  assert.deepEqual(applied, [['slow_warm_up', true]]);
});

test('the agent channel\'s set_setting reaches only the bridge\'s setSlowWarmUp, and never with a value the catalog refuses', async () => {
  const calls: Array<[boolean]> = [];
  const state = cards(false);
  const bridge = {
    version: () => 't', settings, characters: () => state, windows: () => ({ pet: null, controls: null }),
    activateCharacter: async () => {}, bindCurrentModel: async () => {}, setPetVisible: async () => {}, saveSettings: async () => {},
    commitPetBoolean: async () => ({ persistence: 'saved', presentation: '' }), commitReadoutVolume: async () => ({ persistence: 'saved', presentation: '' }),
    commitBreath: async () => ({ persistence: 'saved', presentation: '' }), importCharacterCard: async () => state, loadModel: async () => ({ name: 'm' }),
    rendererAction: () => true, diagnostics: () => ({ replyLatency: [], petWindow: { enabled: false, entries: 0 } }),
    setSlowWarmUp: async (value: boolean) => { calls.push([value]); state.cards[0] = { ...state.cards[0], slowWarmUp: value }; },
  } as unknown as AgentAppBridge;
  const registry = new AgentToolRegistry(createAppTools(bridge).filter(tool => tool.name === 'set_setting' || tool.name === 'list_settings'), { enabled: () => true, confirm: async () => true });
  const listed = await registry.call('list_settings', {}) as { ok: boolean; result: { settings: Array<{ id: string; value: unknown }> } };
  assert.equal(listed.result.settings.find(item => item.id === 'slow_warm_up')?.value, false);
  const result = await registry.call('set_setting', { id: 'slow_warm_up', value: true }) as { ok: boolean; result: { previous: unknown; value: unknown } };
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [[true]]);
  assert.equal(result.result.previous, false);
  assert.equal(result.result.value, true);
  assert.equal(state.cards[1].slowWarmUp, undefined, 'the other card is untouched');
  const bad = await registry.call('set_setting', { id: 'slow_warm_up', value: 'yes' }) as { ok: boolean };
  assert.equal(bad.ok, false);
  assert.equal(calls.length, 1);
});

test('the bridge turns the setting into the host\'s own "setCharacterSlowWarmUp" operation for the active card, under the call guard', async () => {
  const { createHostBridge, AGENT_HOST_OPERATIONS } = await import('../electron/agent-channel/bridge');
  assert.ok((AGENT_HOST_OPERATIONS as readonly string[]).includes('setCharacterSlowWarmUp'));
  const seen: unknown[][] = [];
  const operations = new Map<string, (event: any, ...args: any[]) => unknown>([
    ['getCharacterCards', () => cards(false)],
    ['setCharacterSlowWarmUp', (event, ...args) => { seen.push([event.sender.id, ...args]); }],
  ]);
  const window = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, webContents: { id: 7, isDestroyed: () => false, send: () => {} } };
  const admitted: string[] = [];
  const bridge = createHostBridge({ version: () => '1', controls: () => window, pet: () => window, operations, admit: (_guard, run) => { admitted.push('admit'); return run(); },
    importCharacterCard: async () => cards(false) as never, loadModel: async () => ({ name: 'm' } as never),
    commitPetBoolean: async () => ({ persistence: 'saved', presentation: '' }), commitReadoutVolume: async () => ({ persistence: 'saved', presentation: '' }),
    commitBreath: async () => ({ persistence: 'saved', presentation: '' }), replyLatency: () => [], broadcast: () => {} });
  await bridge.setSlowWarmUp!(true, () => {});
  assert.deepEqual(seen, [[7, 'a', true]], 'the active card and the value, as the control window\'s own call');
  assert.deepEqual(admitted, ['admit']);
  await assert.rejects(bridge.setSlowWarmUp!(false, () => { throw new Error('closed'); }), /closed/);
  assert.equal(seen.length, 1, 'a closed call never reaches the handler');
});
