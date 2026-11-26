// I-173 — the three gaps found that evening, each behind its gate:
//   1. her own voice: when 「她的声音」 is Drama 3 without an id, the id set_voice_style wrote (her binding) is used, and set_voice_style fills her
//      own id too, so the page and the channel cannot disagree into the system voice; keys never touched, no new spending decision;
//   2. update_character_card takes the file's voice only when the user's words asked for it (useFileVoice), shown in the second dialog;
//   3. delete_character: into the recycle bin, the user's words AND the dialog, never the active character or a card that changed meanwhile.
// Synthetic data through the real AgentToolRegistry and the fake soft hearts of tests/helpers/app-tools-world.ts; no Electron, no Claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TTS_CONFIG, type TtsConfig } from '../shared/voice/tts';
import { characterTtsConfig } from '../shared/voice/character-voice-resolver';
import { AGENT_ALWAYS_DIALOG_TOOLS, AGENT_TOOLS } from '../shared/safety/agent-channel';
import { AgentToolRegistry } from '../electron/safety/agent-channel/registry';
import { AGENT_HOST_OPERATIONS, createHostBridge, type IpcHandler } from '../electron/safety/agent-channel/bridge';
import * as appTools from '../electron/safety/agent-channel/app-tools';
import { A, B, DELETED_ENTRY, WORDS, makeWorld, runCall, type Tweak } from './helpers/app-tools-world';

const MODEL = 'C:/models/gene.pmx';
const FISH_READY = { fishApiKey: 'placeholder-not-a-key' };
const tts = (patch: Partial<TtsConfig> = {}): TtsConfig => ({ ...structuredClone(DEFAULT_TTS_CONFIG) as TtsConfig, ...FISH_READY, ...patch });
const settings = (config: TtsConfig) => ({ tts: config, voice: { voiceURI: '' }, model: { path: MODEL } });
const binding = (fishVoiceId: string) => ({ characterId: 'gene-en', modelPath: MODEL, voice: 'longanhuan_v3.1', instruction: '', emotion: 'custom' as const, rate: 1, fishVoiceId });
const gene = (voiceId: string) => ({ id: 'gene-en', name: 'Gene', description: 'A young woman.', voice: { provider: 'fish' as const, voiceId } });

test('her own Drama 3 with no id of its own speaks with the id her binding names (what set_voice_style wrote), never with the system voice by mistake', () => {
  // Tonight's state: the page says Drama 3 with an empty id; the channel had written the id into her binding.
  const tonight = characterTtsConfig(settings(tts({ styleBindings: [binding('g6_drama')] })), gene(''));
  assert.deepEqual([tonight.provider, tonight.fishVoiceId, tonight.voicePlan?.fallback], ['fish', 'g6_drama', null]);
  // Her own id wins over the binding's.
  assert.equal(characterTtsConfig(settings(tts({ styleBindings: [binding('g6_drama')] })), gene('her_own')).fishVoiceId, 'her_own');
  // No id anywhere: still never Drama 3's built-in voice (and the global id, maybe another character's, is never borrowed).
  const none = characterTtsConfig(settings(tts({ fishVoiceId: 'someone_elses' })), gene(''));
  assert.deepEqual([none.provider, none.voicePlan?.fallback], ['system', 'no-voice-id']);
});

const registryFor = (world: ReturnType<typeof makeWorld>, options: { interconnect?: boolean; answer?: boolean | ((request: { title: string; detail: string }) => boolean) } = {}) => {
  const asked: { title: string; detail: string }[] = [];
  let undo: { run(guard: () => void): unknown } | undefined;
  world.state.interconnect = options.interconnect ?? true;
  const registry = new AgentToolRegistry(appTools.createAppTools(world.bridge, world.options), {
    enabled: () => true, interconnect: () => options.interconnect ?? true,
    confirm: async request => { asked.push({ title: request.title, detail: request.detail }); const answer = options.answer ?? true; return typeof answer === 'function' ? answer(request) : answer; },
    called: (_summary, offer) => { undo = offer; }, now: () => 0, confirmTimeoutMs: 1000, runTimeoutMs: 1000,
  });
  return { registry, asked, undo: () => undo ? { run: async (guard: () => void) => { await undo!.run(guard); } } : undefined };
};
const opNames = (world: ReturnType<typeof makeWorld>) => world.ops.map(op => (op as { op: string }).op);

test('set_voice_style fills her own Drama 3 id when 「她的声音」 is already Drama 3; the undo puts it back; keys and the provider never move', async () => {
  const world = makeWorld('own-fish' as Tweak), { registry, undo } = registryFor(world);
  const result = await registry.call('set_voice_style', { voiceId: 'her_voice_1' });
  assert.ok(result.ok);
  assert.deepEqual((world.state.cards.cards[0] as { voice?: unknown }).voice, { provider: 'fish', voiceId: 'her_voice_1' });
  assert.deepEqual(opNames(world), ['saveSettings', 'saveCharacterVoice']);
  const changed = (world.ops[0] as { changed: Record<string, unknown> }).changed;
  assert.deepEqual(Object.keys(changed), ['tts.styleBindings'], 'only her binding: no key, host, region, limit or provider');
  assert.doesNotMatch(JSON.stringify(world.ops), /apiKey|fishApiKey|apiHost|region|fishMonthly/u);
  await undo()!.run(() => {});
  assert.deepEqual((world.state.cards.cards[0] as { voice?: unknown }).voice, { provider: 'fish', voiceId: '' }, 'undone');
  // A voice of another provider is left alone: choosing Drama 3 for her stays the user's own choice on the page.
  for (const voice of [undefined, { provider: 'bailian', voiceId: 'longanhuan_v3.1' }, { provider: 'system', voiceId: '' }]) {
    const plain = makeWorld(); if (voice) (plain.state.cards.cards[0] as { voice?: unknown }).voice = voice;
    assert.ok((await registryFor(plain).registry.call('set_voice_style', { voiceId: 'her_voice_1' })).ok);
    assert.equal(opNames(plain).includes('saveCharacterVoice'), false, `her ${voice?.provider ?? 'missing'} voice is left alone`);
    assert.deepEqual((plain.state.cards.cards[0] as { voice?: unknown }).voice, voice);
  }
  // An empty id (Drama 3's own voice) is never written into hers.
  const empty = makeWorld('own-fish' as Tweak);
  assert.ok((await registryFor(empty).registry.call('set_voice_style', { voiceId: '' })).ok);
  assert.equal(opNames(empty).includes('saveCharacterVoice'), false);
  // A paid provider for her still cannot be picked through the channel.
  const paid = await registryFor(makeWorld()).registry.call('set_voice_style', { provider: 'fish' });
  assert.equal(!paid.ok && paid.error.code, 'invalid_input');
});

test('the undo of her voice refuses when 「她的声音」 changed after the call', async () => {
  const world = makeWorld('own-fish' as Tweak), { registry, undo } = registryFor(world);
  assert.ok((await registry.call('set_voice_style', { voiceId: 'her_voice_1' })).ok);
  (world.state.cards.cards[0] as { voice?: unknown }).voice = { provider: 'fish', voiceId: 'typed_on_the_page' };
  await assert.rejects(undo()!.run(() => {}), /她的声音/u);
  assert.deepEqual((world.state.cards.cards[0] as { voice?: unknown }).voice, { provider: 'fish', voiceId: 'typed_on_the_page' });
});

test('update_character_card takes the file\'s voice only with useFileVoice (the user\'s words), and the second dialog says so', async () => {
  const kept = await runCall('update_character_card', { args: { id: A, path: 'C:\\cards\\voice.json' } }, 'interconnect+words');
  const keptUpdate = (kept.ops as { op: string; options?: unknown }[]).find(op => op.op === 'updateCharacterCard')!;
  assert.equal(keptUpdate.options, undefined, 'without the words for it, her voice stays');
  const taken = await runCall('update_character_card', { args: { id: A, path: 'C:\\cards\\voice.json', useFileVoice: true } }, 'interconnect+words');
  assert.deepEqual((taken.ops as { op: string; options?: unknown }[]).find(op => op.op === 'updateCharacterCard')!.options, { useFileVoice: true });
  assert.match((taken.dialogs as { detail: string }[])[1].detail, /声音：换成文件里的。[\s\S]*声音也换成文件里的（你在对话里要求的）/u);
  // Without the user's words nothing is looked at; a declined second dialog writes nothing.
  const noWords = await runCall('update_character_card', { args: { id: A, path: 'C:\\cards\\voice.json', useFileVoice: true } }, 'interconnect, no words');
  assert.deepEqual(noWords.ops, []);
  const world = makeWorld(), { registry } = registryFor(world, { answer: request => !request.title.includes('更新一个角色') });
  const declined = await registry.call('update_character_card', { id: A, path: 'C:\\cards\\voice.json', useFileVoice: true, userWords: WORDS });
  assert.equal(!declined.ok && declined.error.code, 'denied_by_user');
  assert.equal(opNames(world).includes('updateCharacterCard'), false);
  // A file without another voice: the dialog says hers stays.
  const nothing = await runCall('update_character_card', { args: { id: A, path: 'C:\\cards\\update.json', useFileVoice: true } }, 'interconnect+words');
  assert.match((nothing.dialogs as { detail: string }[])[1].detail, /文件里没有别的声音，她的声音不变/u);
  assert.equal((nothing.ops as { op: string; options?: unknown }[]).find(op => op.op === 'updateCharacterCard')!.options, undefined);
});

test('delete_character: the user\'s words AND the dialog, into the recycle bin, the undo brings her back; only with 三方互通 on', async () => {
  assert.ok(AGENT_ALWAYS_DIALOG_TOOLS.includes('delete_character'));
  const listed = AGENT_TOOLS.find(tool => tool.name === 'delete_character')!;
  assert.deepEqual([listed.tier, listed.interconnectOnly], ['confirm', true]);
  // No words: nothing at all.
  const noWords = makeWorld(), quiet = registryFor(noWords);
  const refused = await quiet.registry.call('delete_character', { id: B });
  assert.equal(!refused.ok && refused.error.code, 'needs_user_words');
  assert.deepEqual([noWords.ops, quiet.asked.length], [[], 0]);
  // Words: the dialog still opens and shows them; declined, nothing is deleted.
  const declinedWorld = makeWorld(), declined = registryFor(declinedWorld, { answer: false });
  assert.equal(((await declined.registry.call('delete_character', { id: B, userWords: WORDS })) as { ok: boolean }).ok, false);
  assert.equal(declined.asked.length, 1);
  assert.match(declined.asked[0].detail, /小雨[\s\S]*回收站[\s\S]*好的，就这样做吧/u);
  assert.equal(opNames(declinedWorld).includes('deleteCharacter'), false);
  // Allowed: into the bin (memories only when asked), and the undo restores that bin entry.
  const world = makeWorld(), allowed = registryFor(world);
  const done = await allowed.registry.call('delete_character', { id: B, forgetMemories: true, userWords: WORDS });
  assert.ok(done.ok);
  assert.deepEqual(world.ops.find(op => (op as { op: string }).op === 'deleteCharacter'), { op: 'deleteCharacter', id: B, forgetMemories: true });
  assert.match(allowed.asked[0].detail, /同时删除她的记忆/u);
  await allowed.undo()!.run(() => {});
  assert.deepEqual(world.ops.at(-1), { op: 'memories.restore', entryId: DELETED_ENTRY });
  // 三方互通 off: not a tool at all.
  const off = await registryFor(makeWorld(), { interconnect: false }).registry.call('delete_character', { id: B });
  assert.equal(!off.ok && off.error.code, 'unknown_tool');
});

test('delete_character never deletes the character who is with the user, even when she became the active one while the dialog was open', async () => {
  const active = makeWorld(), first = registryFor(active);
  const refused = await first.registry.call('delete_character', { id: A, userWords: WORDS });
  assert.equal(!refused.ok && refused.error.code, 'unavailable');
  assert.match(!refused.ok ? refused.error.message : '', /正在陪着你.*activate_character/u);
  assert.deepEqual([active.ops, first.asked.length], [[], 0], 'refused before any dialog');
  const world = makeWorld();
  const switched = registryFor(world, { answer: () => { world.state.cards.activeId = B; return true; } });
  const late = await switched.registry.call('delete_character', { id: B, userWords: WORDS });
  assert.equal(!late.ok && late.error.code, 'unavailable');
  assert.equal(opNames(world).includes('deleteCharacter'), false);
});

test('the host passes delete, her voice and the focus through the control window\'s own operations, nothing else', async () => {
  assert.ok(AGENT_HOST_OPERATIONS.includes('deleteCharacter') && AGENT_HOST_OPERATIONS.includes('saveCharacterVoice'));
  assert.ok(!AGENT_HOST_OPERATIONS.includes('deleteCharacterCard') && !AGENT_HOST_OPERATIONS.some(name => /Key|ForGood|Recycle/u.test(name)), 'no key, no permanent delete');
  const seen: unknown[][] = [];
  const controls = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, webContents: { id: 7, isDestroyed: () => false, send: () => {} } };
  const operations = new Map<string, IpcHandler>(['deleteCharacter', 'saveCharacterVoice', 'openControls', 'getSettings'].map(name => [name, (_event: unknown, ...args: unknown[]) => { seen.push([name, ...args]); return { cards: [], activeId: '' }; }]));
  // no-pet-ok: AgentHostWiring's own field name (the companion window), kept as the host names it
  const bridge = createHostBridge({ version: () => '1', controls: () => controls, pet: () => null, operations, admit: (_guard, run) => run(),
    importCharacterCard: async () => ({ cards: [], activeId: '' }), loadModel: async () => ({ name: 'm' } as never),
    // no-pet-ok: AgentHostWiring's own field name
    commitPetBoolean: async () => ({ persistence: 'saved', presentation: 'applied' }), commitReadoutVolume: async () => ({ persistence: 'saved', presentation: 'x' }),
    commitBreath: async () => ({ persistence: 'saved', presentation: 'x' }), replyLatency: () => [], broadcast: () => {} });
  const open = () => {};
  await bridge.deleteCharacter!(B, false, open);
  await bridge.saveCharacterVoice!(A, { provider: 'fish', voiceId: 'x1' }, open);
  await bridge.openControlPage!('fish-key', open);
  await bridge.openControlPage!('fish-key', open, { anchor: 'tts-fish-key' });
  assert.deepEqual(seen, [['deleteCharacter', B, { forgetMemories: false }], ['saveCharacterVoice', A, { provider: 'fish', voiceId: 'x1' }], ['openControls', 'fish-key'],
    ['openControls', 'fish-key', { anchor: 'tts-fish-key' }]]);
  await assert.rejects(bridge.deleteCharacter!(B, false, () => { throw new Error('closed'); }), /closed/);
  assert.equal(seen.length, 4, 'a closed call never reaches the handler');
});
