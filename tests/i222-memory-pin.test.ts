// I-222 (docs/claude/2026-11-26-chat-model-default.md): choosing a chat model no longer moves her to another memory. The memory scope's
// model part is a pin written at the first start after the upgrade; every profile stays filed exactly where it is today. Real stores in
// temporary folders, synthetic ids and text only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SettingsStore, publicSettings, SETTINGS_KNOWN_FIELDS } from '../electron/settings/settings';
import { validateProvider, validateSettings } from '../electron/settings/validation';
import { storedMemoryPin } from '../electron/settings/memory-pin';
import { AssetRegistry } from '../electron/foundation/assets';
import { memoryProviderScope } from '../electron/foundation/memory-provider-scope';
import { CompanionService } from '../electron/brain/companion';
import { characterProviderScopes, forgetCharacterMemories, forgettableProviderScopes } from '../electron/cards/character-forget';
import { characterForgetRegistry } from '../electron/memory/privacy-wiring';
import { UserProfileStore } from '../electron/memory/user-profile';
import { RpsStore } from '../electron/initiative/rps/store';
import { followClaudeCodeAfterRefusal } from '../electron/brain/chat-model-fallback';
import { VisionProviderSupport, claudeModelSupportsVision } from '../electron/senses/vision-support';
import { saveResetsVision } from '../electron/senses/vision-context';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import { memoryConnectionChanged } from '../shared/foundation/memory-connection';
import type { AppSettings, ProviderConfig } from '../shared/foundation/settings';
import { chatModelOptions, chosenChatModel } from '../src/settings/chat-model-select';

const BASE = DEFAULT_SETTINGS.provider.baseUrl;
/** The scope exactly as every version before 0.2.0 computed it: [kind, base URL, chat model]. */
const legacyScope = (kind: string, baseUrl: string, model: string) =>
  createHash('sha256').update(JSON.stringify([kind, baseUrl.trim().replace(/\/$/, ''), model])).digest('hex');
const secret = { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' };

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-i222-pin-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}
async function writeLegacy(directory: string, provider: Record<string, unknown>): Promise<void> {
  const legacy = { ...structuredClone(DEFAULT_SETTINGS), provider } as Record<string, unknown>;
  delete (legacy.provider as Record<string, unknown>).memoryModel;
  await writeFile(path.join(directory, 'settings.json'), JSON.stringify(legacy));
}
const disk = async (directory: string) => JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8'));
const withModel = (settings: AppSettings, model: string): AppSettings => ({ ...publicSettings(settings), provider: { ...settings.provider, model } });

test('golden: an unchanged profile hashes to the same scope as before 0.2.0 (default base URL, empty and opus)', () => {
  assert.equal(legacyScope('claude', BASE, ''), 'fb5670663973d28dffda502f4c1ae05ba7f7e8436c96b6f9fa99a5fcd6abb99b');
  assert.equal(legacyScope('claude', BASE, 'opus'), '5041020737a651e5766baf1c440bb998109ce71a095562dbe95251199064fe96');
  assert.equal(memoryProviderScope({ kind: 'claude', baseUrl: BASE, model: '' }), legacyScope('claude', BASE, ''), 'no pin: files under the chat model, as before');
  assert.equal(memoryProviderScope(DEFAULT_SETTINGS.provider), legacyScope('claude', BASE, ''), 'a new profile: one scope from the start');
  // The pin decides, not the chat model.
  for (const model of ['', 'opus', 'sonnet', 'haiku', 'follow-default'])
    assert.equal(memoryProviderScope({ kind: 'claude', baseUrl: BASE, model, memoryModel: '' }), legacyScope('claude', BASE, ''), model);
  assert.equal(memoryProviderScope({ kind: 'claude', baseUrl: BASE, model: '', memoryModel: 'sonnet' }), legacyScope('claude', BASE, 'sonnet'));
  // Kind and base URL stay in the scope as they were.
  assert.notEqual(memoryProviderScope({ kind: 'claude', baseUrl: 'http://127.0.0.1:9/v1', model: '', memoryModel: '' }), legacyScope('claude', BASE, ''));
});

for (const [label, stored, pin] of [
  ['saved "" (both owner profiles before 0.2.0)', { kind: 'claude', baseUrl: BASE, model: '' }, ''],
  ['saved "sonnet" in 0.1.x', { kind: 'claude', baseUrl: BASE, model: 'sonnet' }, 'sonnet'],
  ['saved "opus" in 0.1.x', { kind: 'claude', baseUrl: BASE + '/', model: 'opus' }, 'opus'],
  ['a Codex-era profile', { kind: 'codex', baseUrl: BASE, model: 'gpt-5-codex' }, 'gpt-5-codex'],
  ['a retired OpenAI connection', { kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' }, ''],
] as const) {
  test(`old profile, ${label}: pinned where its memory is today, written at the first load, kept through saves, model changes and restarts`, async () => withDirectory(async directory => {
    await writeLegacy(directory, { ...stored });
    // What 0.1.x read: the validated provider, hashed with its chat model.
    const before = validateProvider(stored);
    const today = legacyScope(before.kind, before.baseUrl, before.model);
    const store = new SettingsStore(directory, secret, new AssetRegistry());
    await store.load();
    assert.equal(store.current.provider.memoryModel, pin);
    assert.equal(memoryProviderScope(store.current.provider), today, 'the same scope as before the upgrade');
    // Durable at once: the file has the pin before any save could change the chat model (rows 18 and 19: one write, the same file).
    assert.equal((await disk(directory)).provider.memoryModel, pin);
    assert.equal((await disk(directory)).provider.model, stored.model, 'nothing else in the file changed');
    // A chat model change from a window: same scope, page and archive stay.
    await store.save(withModel(store.current, 'haiku'));
    assert.equal(store.current.provider.model, 'haiku');
    assert.equal(memoryProviderScope(store.current.provider), today);
    // A window that loaded before the pin existed (its copy has no memoryModel) saves late: the pin stays.
    const stale = withModel(store.current, 'sonnet') as AppSettings;
    delete (stale.provider as ProviderConfig).memoryModel;
    await store.save(stale);
    assert.equal(memoryProviderScope(store.current.provider), today, 'stale baseline');
    // A forged pin from a window or the channel is ignored.
    await store.save({ ...publicSettings(store.current), provider: { ...store.current.provider, memoryModel: 'forged' } });
    assert.equal(store.current.provider.memoryModel, pin);
    // 恢复默认设置 and any other host write of whole settings keep it too.
    await store.persist({ ...structuredClone(DEFAULT_SETTINGS) });
    assert.equal(store.current.provider.memoryModel, pin);
    assert.equal(memoryProviderScope(store.current.provider), today);
    assert.equal((await disk(directory)).provider.memoryModel, pin);
    // Restart: the stored pin is read back as is.
    const again = new SettingsStore(directory, secret, new AssetRegistry());
    await again.load();
    assert.equal(memoryProviderScope(again.current.provider), today);
    // The automatic switch after a refused Opus keeps the scope (row 1).
    const fallback = followClaudeCodeAfterRefusal(again.current);
    if (fallback) {
      await again.persist(fallback);
      assert.equal(again.current.provider.model, 'follow-default');
      assert.equal(memoryProviderScope(again.current.provider), today, 'the switch to follow Claude Code does not move her memory');
    }
  }));
}

test('the pin write failing at the first load is not fatal: the pin is held and rides on the next save (row 19)', async () => withDirectory(async directory => {
  await writeLegacy(directory, { kind: 'claude', baseUrl: BASE, model: 'sonnet' });
  let fail = true;
  const writes: string[] = [];
  const writer = async (file: string, data: string) => {
    if (fail) { fail = false; throw new Error('disk full (synthetic)'); }
    writes.push(data); await writeFile(file, data);
  };
  const store = new SettingsStore(directory, secret, new AssetRegistry(), writer);
  await store.load();
  assert.equal(store.current.provider.memoryModel, 'sonnet');
  assert.equal((await disk(directory)).provider.memoryModel, undefined, 'the failed write left the file as it was');
  await store.save(withModel(store.current, 'opus'));
  assert.equal((await disk(directory)).provider.memoryModel, 'sonnet', 'the next save writes it');
  assert.equal(memoryProviderScope(store.current.provider), legacyScope('claude', BASE, 'sonnet'));
}));

test('validation and the known-fields table carry the pin; a fresh profile has one from the start (row 2)', async () => withDirectory(async directory => {
  assert.equal((SETTINGS_KNOWN_FIELDS.provider as Record<string, unknown>).memoryModel, true, 'otherwise it is kept aside as unknown');
  const previous = { ...structuredClone(DEFAULT_SETTINGS), provider: { ...DEFAULT_SETTINGS.provider, memoryModel: 'sonnet' } };
  const next = validateSettings({ ...structuredClone(DEFAULT_SETTINGS), provider: { kind: 'claude', baseUrl: BASE, model: 'opus', memoryModel: 'x' } }, previous);
  assert.deepEqual(next.provider, { kind: 'claude', baseUrl: BASE, model: 'opus', memoryModel: 'sonnet' });
  assert.equal(validateProvider({ kind: 'claude', baseUrl: BASE, model: 'follow-default' }).model, 'follow-default', 'validation keeps the follow choice');
  assert.deepEqual(storedMemoryPin({ kind: 'claude', baseUrl: BASE, model: 'opus', memoryModel: '' }), { model: '', fresh: false });
  // No file: the defaults (pin "") and the first save writes it.
  const store = new SettingsStore(directory, secret, new AssetRegistry());
  await store.load();
  assert.equal(store.current.provider.memoryModel, '');
  await store.save(withModel(store.current, 'sonnet'));
  assert.equal((await disk(directory)).provider.memoryModel, '');
  assert.equal(memoryProviderScope(store.current.provider), legacyScope('claude', BASE, ''));
}));

test('her chats: the same archive and conversation before the upgrade, after it, and after a chat model change', async () => withDirectory(async directory => {
  const oldProvider = { kind: 'claude' as const, baseUrl: BASE, model: 'sonnet' }; // 0.1.x: no pin
  const first = new CompanionService(directory, () => {});
  try {
    await first.load();
    await first.context('card-a', oldProvider, 'P');
    const turn = await first.begin('t1', '记住：合成的蓝色', 'P', () => {}, {});
    turn.push('delta', '记住了。'); await turn.finish('complete');
  } finally { await first.flush().catch(() => {}); }
  await writeLegacy(directory, oldProvider);
  const store = new SettingsStore(directory, secret, new AssetRegistry());
  await store.load();
  const service = new CompanionService(directory, () => {});
  try {
    await service.load();
    await service.context('card-a', store.current.provider, 'P');
    assert.equal(service.memory.list(service.currentScope()).records.length, 1, 'after the upgrade: her chats are there');
    const conversation = service.conversationId;
    const scopes = [...service.memory.providerScopesOf('card-a')];
    await store.save(withModel(store.current, 'opus'));
    assert.equal(service.contextChange('card-a', store.current.provider, 'P'), 'same', 'another chat model is not another connection');
    await service.context('card-a', store.current.provider, 'P');
    assert.equal(service.conversationId, conversation, 'the conversation goes on');
    assert.equal(service.memory.list(service.currentScope()).records.length, 1, 'after the model change: the same archive');
    // The automatic switch to follow Claude Code (row 1): the same scope and the same scope list.
    await store.persist(followClaudeCodeAfterRefusal(store.current) ?? withModel(store.current, 'follow-default'));
    await service.context('card-a', store.current.provider, 'P');
    assert.equal(service.conversationId, conversation);
    assert.deepEqual([...service.memory.providerScopesOf('card-a')], scopes, 'no new connection listed for her');
    const record = service.memory.list(service.currentScope()).records[0];
    assert.match(JSON.stringify(service.memory.read(service.currentScope(), record.id)), /合成的蓝色/);
    // A real connection change (another base URL) is still one.
    assert.equal(service.contextChange('card-a', { ...store.current.provider, baseUrl: 'http://127.0.0.1:9/v1' }, 'P'), 'connection');
  } finally { await service.flush().catch(() => {}); }
}));

test('deleting a character after the pin still reaches every scope she has memory in: the pinned one, 0.1.x model scopes, the chat model now (row 3)', async () => withDirectory(async directory => {
  const pinned: ProviderConfig = { kind: 'claude', baseUrl: BASE, model: 'opus', memoryModel: 'fable' };
  const listed = forgettableProviderScopes(pinned, memoryProviderScope);
  for (const model of ['fable', '', 'haiku', 'sonnet', 'opus'])
    assert.ok(listed.includes(legacyScope('claude', BASE, model)), `scope of ${JSON.stringify(model)}`);
  // Real stores: memory in the pinned scope and in an old 0.1.x scope (she was talked to under sonnet before).
  const service = new CompanionService(directory, () => {});
  const profiles = new UserProfileStore(path.join(directory, 'user-profiles'));
  const rps = new RpsStore({ file: () => path.join(directory, 'rps.json') }); await rps.load();
  try {
    await service.load();
    for (const provider of [{ kind: 'claude' as const, baseUrl: BASE, model: 'sonnet' }, pinned]) {
      await service.context('card-doomed', provider, 'P');
      const turn = await service.begin(`t-${provider.model}`, `给她的话 ${provider.model}`, 'P', () => {}, {});
      turn.push('delta', '好。'); await turn.finish('complete');
    }
    const forgotten = await forgetCharacterMemories('card-doomed', {
      providerScopes: () => characterProviderScopes('card-doomed', listed, id => service.memory.providerScopesOf(id)),
      providerScopesOf: id => service.memory.providerScopesOf(id),
      clears: characterForgetRegistry({ memory: service.memory, profiles, relationship: service.relationship, rps, feeding: { forget: () => false },
        herNote: null, movingMemory: null, songMemory: null, semantic: null, listenTogether: null, watchTogether: null, upcoming: null, hands: null }) });
    assert.deepEqual(forgotten.failed, []);
    assert.equal(forgotten.records, 2, 'both scopes cleared');
    for (const model of ['sonnet', 'fable'])
      assert.equal(service.memory.list({ characterId: 'card-doomed', providerScope: legacyScope('claude', BASE, model) }).records.length, 0, model);
  } finally { await service.flush().catch(() => {}); profiles.dispose(); }
}));

test('vision: "", opus, the follow choice and a Codex-era name (which now runs on Opus) can see images, cache key included (row 4)', async () => {
  for (const model of ['', 'opus', 'follow-default', 'sonnet']) assert.equal(claudeModelSupportsVision(model), true, model);
  const support = new VisionProviderSupport();
  const signal = new AbortController().signal;
  for (const model of ['', 'opus', 'follow-default', 'gpt-5-codex', 'haiku'])
    assert.equal(await support.supports({ kind: 'claude', baseUrl: BASE, model, memoryModel: '' }, signal), true, model);
  support.noteImageSuccess({ kind: 'claude', baseUrl: BASE, model: 'follow-default', memoryModel: '' });
  assert.equal(await support.supports({ kind: 'claude', baseUrl: BASE, model: 'follow-default', memoryModel: '' }, signal), true);
});

test('the windows: a chat model change does not clear the page or reset the memory panel; a connection change does (row 6)', () => {
  const host = { kind: 'claude' as const, baseUrl: BASE, model: '', memoryModel: '' };
  assert.equal(memoryConnectionChanged(host, { ...host, model: 'sonnet' }), false);
  assert.equal(memoryConnectionChanged(host, { ...host, model: 'follow-default' }), false);
  assert.equal(memoryConnectionChanged(host, { ...host, baseUrl: 'http://127.0.0.1:9/v1' }), true);
  const stale = { kind: 'claude' as const, baseUrl: BASE, model: 'opus' }; // a window copy from before the pin
  assert.equal(memoryConnectionChanged(stale, { ...host, model: 'haiku' }), false, 'read with the other side\'s pin');
  assert.equal(memoryConnectionChanged({ ...stale, model: '' }, { ...stale, model: 'sonnet' }), true, 'no pin on either side: as before');
  // The host's save steps: what she sees (and through it the chat page) and listening together are not started over by a model change.
  const before = { ...structuredClone(DEFAULT_SETTINGS), persona: 'P' };
  assert.equal(saveResetsVision(before, { ...before, provider: { ...before.provider, model: 'sonnet' } }), false);
  assert.equal(saveResetsVision(before, { ...before, provider: { ...before.provider, baseUrl: 'http://127.0.0.1:9/v1' } }), true);
  assert.equal(saveResetsVision(before, { ...before, persona: 'Q' }), true);
  // The settings page's choice.
  assert.deepEqual(chatModelOptions('').options.map(option => option.value), ['', 'sonnet', 'haiku', 'follow-default']);
  assert.equal(chatModelOptions('opus').selected, '', 'a saved opus shows as Opus（默认）');
  assert.equal(chosenChatModel('', 'opus'), 'opus', 'and is not rewritten unasked');
  assert.equal(chatModelOptions('gpt-5-codex').selected, '', 'a Codex-era name answers with Opus');
  const fable = chatModelOptions('fable');
  assert.equal(fable.selected, 'fable'); assert.ok(fable.options.some(option => option.value === 'fable'), 'kept as an extra choice');
  assert.equal(chosenChatModel('follow-default', ''), 'follow-default');
});
