// 不认识的字段照样保留、但不使用 (docs/claude/2026-11-04-keep-unknown-fields.md): a newer version wrote fields this one does not
// know; this version reads the file, saves it for another reason, and the fields are still there, byte for byte, while no
// window, export or internal-channel answer ever sees them. Every file here lives in a fresh temporary folder.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { DEFAULT_TTS_CONFIG } from '../shared/tts';
import type { AppSettings } from '../shared/contracts';
import { AssetRegistry } from '../electron/assets';
import { publicSettings, SettingsStore, SETTINGS_KNOWN_FIELDS, type SecretStorage } from '../electron/settings';
import { validateSettings } from '../electron/validation';
import { CharacterCardStore, parseCharacterCardText } from '../electron/character-cards';
import type { CharacterCard, CharacterDraft } from '../shared/character-cards';
import { RelationshipStore } from '../electron/relationship/store';
import { withRound, withTouch } from '../shared/relationship';
import { KEPT_UNKNOWN_FIELDS_LIMIT, KeptFields, looksLikeSecretName, splitUnknownFields, type KnownFields } from '../electron/unknown-fields';

const PREFIX = 'soft-hearts-keep-unknown-';
async function folder(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), PREFIX));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith(PREFIX));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
const secrets: SecretStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`encrypted:${value}`),
  decryptString: bytes => bytes.toString().slice('encrypted:'.length),
};
const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const same = (actual: unknown, expected: unknown, message: string) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
const hides = (surface: unknown, markers: readonly string[], what: string) => {
  const text = typeof surface === 'string' ? surface : JSON.stringify(surface);
  for (const marker of markers) assert.ok(!text.includes(marker), `${what} must not carry ${marker}`);
};
/** Paths in `value` the table does not know (a known whole value is not looked into). */
function unknownPaths(value: Record<string, unknown>, shape: KnownFields, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const name = prefix ? `${prefix}.${key}` : key;
    if (!Object.hasOwn(shape, key)) return [name];
    const rule = shape[key];
    return rule !== true && child && typeof child === 'object' && !Array.isArray(child) ? unknownPaths(child as Record<string, unknown>, rule, name) : [];
  });
}

// ---- the helper ----

test('secret-like names are recognized by their words, not by any substring', () => {
  for (const name of ['apiKey', 'apiKeyEncrypted', 'tts_api_key', 'AUTH-TOKEN', 'password', 'refreshToken', 'cookies', 'clientSecret', 'APIKEY'])
    assert.equal(looksLikeSecretName(name), true, name);
  for (const name of ['hotkey', 'keyboardLayout', 'keyframe', 'author', 'monkey', 'tokenizerName', 'privacyNote', 'glow'])
    assert.equal(looksLikeSecretName(name), false, name);
});

test('kept fields go back where they were, never over a known value, and only with the object they belong to', () => {
  const shape: KnownFields = { a: true, pet: { visible: true, size: { width: true } } };
  const raw = JSON.parse('{"a":1,"later":{"x":[1,"二",null]},"pet":{"visible":true,"glow":0.5,"size":{"width":3,"depth":4}},"b":"x"}');
  const logs: string[] = [];
  const split = splitUnknownFields(raw, shape, { label: 'test.json', log: line => logs.push(line) });
  assert.deepEqual(split.known, { a: 1, pet: { visible: true, size: { width: 3 } } }, 'the reading rules see only what they know');
  assert.deepEqual(split.kept.names(), ['later', 'pet.glow', 'pet.size.depth', 'b']);
  assert.deepEqual(split.dropped, []);
  assert.deepEqual(logs, []);
  const written = split.kept.writeInto({ a: 2, b: 'normalized wins', pet: { visible: false, size: { width: 5 } } });
  assert.deepEqual(written, { a: 2, b: 'normalized wins', later: { x: [1, '二', null] }, pet: { visible: false, size: { width: 5, depth: 4 }, glow: 0.5 } });
  assert.deepEqual(split.kept.writeInto({ a: 2, pet: { visible: true } }), { a: 2, pet: { visible: true, glow: 0.5 }, later: { x: [1, '二', null] }, b: 'x' },
    'a known object the value no longer has takes its own kept fields with it');
  assert.equal(raw.pet.glow, 0.5, 'the raw value is not changed');
});

test('kept fields are opaque: JSON and structured clone (Electron IPC) show nothing of them', () => {
  const { kept } = splitUnknownFields({ later: 'UNKNOWN-OPAQUE' }, {}, { label: 'test.json', log: () => {} });
  assert.equal(kept.empty, false);
  assert.equal(JSON.stringify(kept), '{}');
  assert.equal(JSON.stringify({ wrapped: kept }), '{"wrapped":{}}');
  hides(structuredClone(kept), ['UNKNOWN-OPAQUE'], 'a structured clone');
  assert.deepEqual(Object.keys(kept), []);
  assert.equal(KeptFields.none.empty, true);
});

test('a prototype key is never kept and never changes a prototype', () => {
  const raw = JSON.parse('{"a":1,"__proto__":{"POLLUTED":true},"later":{"__proto__":{"POLLUTED":true}}}');
  const logs: string[] = [];
  const split = splitUnknownFields(raw, { a: true }, { label: 'test.json', log: line => logs.push(line) });
  assert.deepEqual(split.dropped, ['__proto__', 'later']);
  const written = split.kept.writeInto({ a: 1 });
  assert.equal(Object.hasOwn(written, '__proto__'), false);
  assert.equal(({} as Record<string, unknown>).POLLUTED, undefined);
  assert.equal(Object.getPrototypeOf(split.known), Object.prototype);
  assert.equal(logs.length, 1);
});

// ---- settings.json ----

async function settingsWithFutureFields(t: TestContext, change: (raw: Record<string, any>) => void) {
  const directory = await folder(t);
  const file = path.join(directory, 'settings.json');
  const first = new SettingsStore(directory, secrets, new AssetRegistry());
  await first.load();
  await first.save(structuredClone(DEFAULT_SETTINGS));
  const raw = await readJson(file);
  change(raw);
  await writeFile(file, JSON.stringify(raw, null, 2));
  const logs: string[] = [];
  const store = new SettingsStore(directory, secrets, new AssetRegistry(), undefined, line => logs.push(line));
  await store.load();
  return { directory, file, raw, store, logs };
}

test('settings.json: a newer version\'s fields survive this version saving for another reason, byte for byte', async t => {
  const { file, raw, store, logs } = await settingsWithFutureFields(t, raw => {
    raw.futureTop = { list: [1, '二', { deep: null }], marker: 'UNKNOWN-SETTING-TOP' };
    raw.pet.futureGlow = 'UNKNOWN-SETTING-PET';
    raw.voiceInput.futureMode = { a: 1, b: [true] };
    raw.camera.futureLens = 3.25;
  });
  // The pet window's own toggle (electron/main.ts persists the whole settings with one field changed).
  await store.persist({ ...store.current, pet: { ...store.current.pet, alwaysOnTop: false } });
  let after = await readJson(file);
  assert.equal(after.pet.alwaysOnTop, false, 'the change itself is saved');
  same(after.futureTop, raw.futureTop, 'a top-level field');
  same(after.pet.futureGlow, raw.pet.futureGlow, 'a field inside a known section');
  same(after.voiceInput.futureMode, raw.voiceInput.futureMode, 'another section');
  same(after.camera.futureLens, raw.camera.futureLens, 'a number');
  // The control window's save, then a restart and one more save: still there.
  await store.save({ ...publicSettings(store.current), voice: { ...store.current.voice, rate: 1.5 } });
  const again = new SettingsStore(path.dirname(file), secrets, new AssetRegistry());
  await again.load();
  await again.persist({ ...again.current, innerLoop: false });
  after = await readJson(file);
  assert.equal(after.voice.rate, 1.5);
  assert.equal(after.innerLoop, false);
  same(after.futureTop, raw.futureTop, 'after a restart');
  same(after.pet.futureGlow, raw.pet.futureGlow, 'after a restart');
  same(after.voiceInput.futureMode, raw.voiceInput.futureMode, 'after a restart');
  assert.deepEqual(logs, []);
});

test('settings.json: unknown fields never become settings, never reach a window, and a save cannot plant new ones', async t => {
  const markers = ['UNKNOWN-SETTING-TOP', 'UNKNOWN-SETTING-PET', 'futureTop', 'futureGlow'];
  const { file, store } = await settingsWithFutureFields(t, raw => {
    raw.futureTop = 'UNKNOWN-SETTING-TOP';
    raw.pet.futureGlow = 'UNKNOWN-SETTING-PET';
  });
  hides(store.current, markers, 'the settings the host uses');
  // What getSettings answers to the control window and to the internal channel (electron/main.ts, agent-channel/bridge.ts).
  hides(publicSettings(store.current), markers, 'public settings');
  hides(structuredClone(publicSettings(store.current)), markers, 'public settings over IPC');
  const saved = await store.save({ ...publicSettings(store.current), RENDERER_PLANTED: 'x', pet: { ...store.current.pet, plantedToo: 1 } });
  hides(saved, markers, 'what a save answers');
  const after = await readJson(file);
  assert.equal(Object.hasOwn(after, 'RENDERER_PLANTED'), false, 'a window cannot add a field');
  assert.equal(Object.hasOwn(after.pet, 'plantedToo'), false);
  assert.equal(after.futureTop, 'UNKNOWN-SETTING-TOP', 'only what the file had comes back');
});

test('settings.json: secret-like and oversized unknown fields are not kept, and the log names them without their content', async t => {
  const secret = await settingsWithFutureFields(t, raw => {
    raw.futureServiceToken = 'SETTING-SECRET-VALUE';
    raw.voice.futureService = { apiKey: 'NESTED-SECRET-VALUE' };
    raw.futureFine = 'kept';
  });
  await secret.store.persist({ ...secret.store.current, innerLoop: false });
  let after = await readJson(secret.file);
  assert.equal(Object.hasOwn(after, 'futureServiceToken'), false);
  assert.equal(Object.hasOwn(after.voice, 'futureService'), false);
  assert.equal(after.futureFine, 'kept');
  assert.equal(secret.logs.length, 1);
  assert.match(secret.logs[0], /settings\.json/);
  assert.match(secret.logs[0], /futureServiceToken/);
  hides(secret.logs, ['SETTING-SECRET-VALUE', 'NESTED-SECRET-VALUE'], 'the log');

  const big = await settingsWithFutureFields(t, raw => {
    raw.futureHuge = 'y'.repeat(KEPT_UNKNOWN_FIELDS_LIMIT + 1);
    raw.pet.futureSmall = 'SMALL-VALUE';
  });
  await big.store.persist({ ...big.store.current, innerLoop: false });
  after = await readJson(big.file);
  assert.equal(Object.hasOwn(after, 'futureHuge'), false, 'over the limit nothing is kept');
  assert.equal(Object.hasOwn(after.pet, 'futureSmall'), false);
  assert.equal(after.innerLoop, false, 'the save itself still happens');
  assert.equal(big.logs.length, 1);
  assert.match(big.logs[0], /futureHuge（65539 字节）/);
  assert.match(big.logs[0], /pet\.futureSmall（13 字节）/);
  hides(big.logs, ['yyyy', 'SMALL-VALUE'], 'the log');
});

test('settings.json: every field this version writes is in its known table (so nothing it owns is ever "kept")', async t => {
  const directory = await folder(t);
  const store = new SettingsStore(directory, secrets, new AssetRegistry());
  const previous: AppSettings = { ...structuredClone(DEFAULT_SETTINGS), motionLayers: { gesture: null, expression: null } };
  const full = {
    ...structuredClone(DEFAULT_SETTINGS),
    pet: { ...DEFAULT_SETTINGS.pet, size: { width: 400, height: 560 } },
    voiceInput: { ...DEFAULT_SETTINGS.voiceInput!, apiKey: 'voice-input-fixture' },
    tts: { ...DEFAULT_TTS_CONFIG, provider: 'bailian', apiHost: 'https://fixture.example', apiKey: 'tts-fixture', introduced: true,
      styleBindings: [{ characterId: 'gene', modelPath: 'C:/m.pmx', voice: DEFAULT_TTS_CONFIG.voice, instruction: '', emotion: 'custom', rate: 1 }] },
    experienceJournal: true,
  };
  await store.persist(validateSettings(full, previous));
  const written = await readJson(path.join(directory, 'settings.json'));
  assert.ok(written.voiceInputApiKeyEncrypted && written.ttsApiKeyEncrypted && written.motionLayers && written.pet.size && written.tts.styleBindings.length);
  assert.deepEqual(unknownPaths(written, SETTINGS_KNOWN_FIELDS), [], 'add the field to SETTINGS_KNOWN_FIELDS (electron/settings.ts)');
});

// ---- characters.json ----

const draftOf = (card: CharacterCard, patch: Partial<CharacterDraft> = {}): CharacterDraft => {
  const { id: _id, modelName: _model, ...draft } = card;
  return { ...draft, ...patch };
};
async function cardsWithFutureFields(t: TestContext, change: (raw: Record<string, any>) => void) {
  const directory = await folder(t);
  const file = path.join(directory, 'characters.json');
  const first = new CharacterCardStore(directory, 'legacy persona');
  await first.load();
  await first.save({ name: '第二张', description: '描述', personality: '', scenario: '', greeting: '', examples: '', systemPrompt: '' });
  await first.bindModel(first.publicState().cards[1].id, 'C:\\models\\second.pmx', 'second.pmx');
  const plain = await readFile(file, 'utf8');
  const raw = JSON.parse(plain);
  change(raw);
  await writeFile(file, JSON.stringify(raw, null, 2));
  const logs: string[] = [];
  const store = new CharacterCardStore(directory, 'legacy persona', undefined, line => logs.push(line));
  await store.load();
  return { directory, file, plain, raw, store, logs };
}

test('characters.json: a newer version\'s fields load instead of stopping the app, and survive a save for another reason', async t => {
  const { file, raw, store, logs } = await cardsWithFutureFields(t, raw => {
    raw.futureFile = { mode: 'x', list: [1, '二'] };
    raw.cards[0].futureCardField = { note: 'UNKNOWN-CARD-A', at: 1 };
    raw.cards[1].futurePerCard = ['UNKNOWN-CARD-B'];
  });
  const [a, b] = store.publicState().cards;
  await store.save(draftOf(a, { description: '改过的描述' }), a.id);
  let after = await readJson(file);
  assert.equal(after.cards[0].description, '改过的描述', 'the change itself is saved');
  same(after.cards[0].futureCardField, raw.cards[0].futureCardField, 'the changed card keeps its own field');
  same(after.cards[1], raw.cards[1], 'the card nothing changed is byte for byte the same, its field included');
  same(after.futureFile, raw.futureFile, 'the file keeps its own field');
  // A restart, then other kinds of saves (activate, the slow warm-up switch, removing the other card).
  const again = new CharacterCardStore(path.dirname(file), 'legacy persona');
  await again.load();
  await again.activate(b.id);
  await again.setSlowWarmUp(a.id, true);
  after = await readJson(file);
  same(after.cards[0].futureCardField, raw.cards[0].futureCardField, 'after a restart');
  same(after.cards[1].futurePerCard, raw.cards[1].futurePerCard, 'after a restart');
  same(after.futureFile, raw.futureFile, 'after a restart');
  await again.remove(b.id);
  after = await readJson(file);
  assert.equal(after.cards.length, 1);
  assert.ok(!JSON.stringify(after).includes('UNKNOWN-CARD-B'), 'a removed card takes its fields with it');
  same(after.cards[0].futureCardField, raw.cards[0].futureCardField, 'the other card keeps its own');
  await again.save({ name: '新卡', description: '', personality: '', scenario: '', greeting: '', examples: '', systemPrompt: '' });
  after = await readJson(file);
  assert.equal(Object.keys(after.cards[1]).some(key => key.startsWith('future')), false, 'a new card starts with nothing it was not given');
  assert.deepEqual(logs, []);
});

test('characters.json: unknown fields stay out of every card view, the export, the roster and the fingerprint', async t => {
  const markers = ['UNKNOWN-CARD-A', 'UNKNOWN-CARD-B', 'UNKNOWN-FILE', 'futureCardField', 'futurePerCard', 'futureFile'];
  const { plain, store } = await cardsWithFutureFields(t, raw => {
    raw.futureFile = 'UNKNOWN-FILE';
    raw.cards[0].futureCardField = 'UNKNOWN-CARD-A';
    raw.cards[1].futurePerCard = { value: 'UNKNOWN-CARD-B' };
  });
  const [a, b] = store.publicState().cards;
  // getCharacterCards (control window and internal channel), the active card the host builds prompts from, export, C2/C1.
  hides(store.publicState(), markers, 'publicState');
  hides(structuredClone(store.publicState()), markers, 'publicState over IPC');
  hides(store.getActive(), markers, 'getActive');
  hides(store.export(a.id), markers, 'export');
  hides(store.export(b.id), markers, 'export');
  hides(store.rosterCards(), markers, 'rosterCards');
  hides(store.modelCards(), markers, 'modelCards');
  // The C3 confirmation fingerprint is the same as for the same file without the unknown fields.
  const twin = await folder(t);
  await writeFile(path.join(twin, 'characters.json'), plain);
  const without = new CharacterCardStore(twin, 'legacy persona');
  await without.load();
  assert.equal(store.cardFingerprint(a.id), without.cardFingerprint(a.id));
  assert.equal(store.cardFingerprint(b.id), without.cardFingerprint(b.id));
  // An imported card file is not a stored file: it still may not carry unknown fields.
  const exported = JSON.parse(store.export(a.id));
  exported.card.futureCardField = 'x';
  assert.throws(() => parseCharacterCardText(JSON.stringify(exported)), /未知字段/);
});

test('characters.json: secret-like and oversized unknown fields of a card are not kept, each card on its own', async t => {
  const { file, store, logs } = await cardsWithFutureFields(t, raw => {
    raw.cards[0].futureHuge = 'z'.repeat(KEPT_UNKNOWN_FIELDS_LIMIT + 1);
    raw.cards[0].futureApiKey = 'CARD-SECRET-VALUE';
    raw.cards[1].futureFine = 'kept';
  });
  assert.equal(logs.length, 2);
  assert.ok(logs.every(line => line.includes('characters.json 第 1 张卡')));
  assert.ok(logs.some(line => line.includes('futureApiKey')) && logs.some(line => line.includes('futureHuge（65539 字节）')));
  hides(logs, ['zzzz', 'CARD-SECRET-VALUE'], 'the log');
  await store.activate(store.publicState().cards[1].id);
  const after = await readJson(file);
  assert.equal(Object.hasOwn(after.cards[0], 'futureHuge'), false, 'not kept: the card is written from what this version knows');
  assert.equal(Object.hasOwn(after.cards[0], 'futureApiKey'), false);
  assert.equal(after.cards[1].futureFine, 'kept', 'the limit is per card');
});

// ---- relationship/<id>.json (熟悉度) ----

test('relationship: a newer version\'s fields no longer make her start over, and survive the next change', async t => {
  const directory = await folder(t);
  const today = '2026-11-01', tomorrow = '2026-11-02';
  const first = new RelationshipStore(directory, { today: () => today });
  await first.update('gene', data => ({ ...withRound(withTouch(data, today), today), nickname: '小糖' }));
  const file = path.join(directory, 'relationship', 'gene.json');
  const raw = await readJson(file);
  raw.futureInJokes = [{ text: 'UNKNOWN-REL', at: 1 }];
  raw.today.futureCounter = 9;
  await writeFile(file, JSON.stringify(raw, null, 2));
  const logs: string[] = [];
  const store = new RelationshipStore(directory, { today: () => tomorrow, log: line => logs.push(line) });
  const loaded = await store.load('gene');
  assert.equal(loaded.metDate, today, 'she still knows when they met (before: an empty relationship from today)');
  assert.equal(loaded.nickname, '小糖');
  hides(loaded, ['UNKNOWN-REL', 'futureInJokes', 'futureCounter'], 'what the host reads');
  hides(store.peek('gene'), ['UNKNOWN-REL'], 'peek');
  await store.update('gene', data => withRound(withTouch(data, tomorrow), tomorrow));
  const after = await readJson(file);
  assert.deepEqual(after.days, [today, tomorrow], 'the change itself is saved');
  same(after.futureInJokes, raw.futureInJokes, 'a top-level field survives');
  assert.equal(after.today.date, tomorrow);
  assert.equal(Object.hasOwn(after.today, 'futureCounter'), false, '`today` is one whole value this version owns (it starts over each day)');
  assert.deepEqual(logs, []);
  await store.forget('gene');
  await store.update('gene', data => withRound(withTouch(data, tomorrow), tomorrow));
  assert.equal(Object.hasOwn(await readJson(file), 'futureInJokes'), false, 'forgetting her takes them too');
});
