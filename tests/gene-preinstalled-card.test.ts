import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CharacterCardStore } from '../electron/character-cards';
import { atomicWriteFile, type AtomicFileWriter } from '../electron/atomic-file';
import { GENE_PRESET_FILE, GENE_PRESET_KEY, GENE_PRESET_DEFINITION_SHA256, inspectGeneProfile, preinstalledGeneDraft } from '../electron/gene-preinstalled-card';
import { BUNDLED_CHARACTER_MODEL, MAX_CHARACTER_CARDS, defaultCharacterMoodTemplate } from '../shared/character-cards';
import { DEFAULT_MOOD_PARAMETERS, createMoodState } from '../shared/mood';

async function fixture(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-gene-preset-'));
  try { await run(directory); }
  finally {
    assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('soft-gene-preset-'));
    await rm(directory, { recursive: true, force: true });
  }
}
const file = (directory: string) => path.join(directory, 'characters.json');
const ledgerFile = (directory: string) => path.join(directory, GENE_PRESET_FILE);
const readCards = async (directory: string) => JSON.parse(await readFile(file(directory), 'utf8'));
const readLedger = async (directory: string) => JSON.parse(await readFile(ledgerFile(directory), 'utf8'));
const privateCard = () => ({ id: randomUUID(), name: '  Gene  ', description: 'ORIGINAL_PRIVATE_FIXTURE', personality: 'Keep my character',
  scenario: '', greeting: 'PRIVATE_GREETING', examples: '', systemPrompt: 'PRIVATE_PERSONA', mood: defaultCharacterMoodTemplate(),
  modelPath: path.join(os.tmpdir(), 'synthetic-own-model.pmx'), modelName: 'custom/model-label.pmx' });
const textDraft = (name: string, systemPrompt: string) => ({ name, description: '', personality: '', scenario: '', greeting: '', examples: '', systemPrompt });
async function seed(directory: string) {
  const card = privateCard(); card.mood.parameters.sensitivity.O = 1.3; card.mood.parameters.blush.size = 73;
  await writeFile(file(directory), JSON.stringify({ version: 1, revision: 7, activeId: card.id, cards: [card] })); return card;
}
async function open(directory: string, writer: AtomicFileWriter = atomicWriteFile) {
  const profile = await inspectGeneProfile(directory);
  const cards = new CharacterCardStore(directory, profile.legacySystemPrompt ?? 'FULL_LEGACY_PERSONA', writer);
  const state = await cards.load({ preinstalledGene: true, freshProfile: profile.fresh });
  return { cards, state, profile };
}

test('truly fresh profile directly starts with the complete Gene preset and host-only bundled binding', async () => fixture(async directory => {
  await writeFile(path.join(directory, 'qa-text-isolation.json'), '{}');
  await writeFile(path.join(directory, 'Local State'), '{}');
  const { cards, state, profile } = await open(directory);
  assert.equal(profile.fresh, true); assert.equal(state.cards.length, 1);
  assert.equal(state.cards[0].name, 'Gene'); assert.equal(state.activeId, state.cards[0].id);
  assert.deepEqual(state.cards[0].mood?.parameters, DEFAULT_MOOD_PARAMETERS);
  assert.equal(cards.getActive().modelPath, BUNDLED_CHARACTER_MODEL);
  assert.equal((await readLedger(directory)).status, 'installed');
  assert.equal((await readLedger(directory)).cardId, state.activeId);
  const exported = JSON.parse(cards.export(state.activeId));
  assert.equal(exported.version, 2); assert.deepEqual(Object.keys(exported.card).sort(), Object.keys(preinstalledGeneDraft()).sort());
  for (const key of ['id','modelPath','modelName','presetKey','values','boredom','longing','history']) assert.equal(Object.hasOwn(exported.card, key), false);
  const initial = createMoodState(1000, exported.card.mood.parameters);
  assert.deepEqual(initial.values, DEFAULT_MOOD_PARAMETERS.baseline); assert.equal(initial.boredom, 0); assert.equal(initial.longing, 0);
}));

test('existing same-name private card, active identity, exact original fields and unrelated state stay untouched', async () => fixture(async directory => {
  const original = await seed(directory);
  const protectedFiles = ['settings.json','mood-state.json','memories.jsonl','character-response-settings.json','physics-settings.json','music-settings.json','blush-calibrations.json'];
  for (const name of protectedFiles) await writeFile(path.join(directory, name), 'UNCHANGED_FIXTURE_' + name);
  const { cards, state } = await open(directory);
  assert.equal(state.cards.length, 2); assert.equal(state.activeId, original.id);
  assert.deepEqual((await readCards(directory)).cards[0], original, 'append must preserve even original whitespace/model label fields');
  assert.equal(cards.getActive().modelPath, original.modelPath);
  assert.equal(state.cards[1].name, 'Gene'); assert.notEqual(state.cards[1].id, original.id);
  assert.equal((await readCards(directory)).cards[1].modelPath, BUNDLED_CHARACTER_MODEL);
  for (const name of protectedFiles) assert.equal(await readFile(path.join(directory, name), 'utf8'), 'UNCHANGED_FIXTURE_' + name);
  const raw = await readCards(directory); assert.deepEqual(Object.keys(raw).sort(), ['activeId','cards','revision','version']);
  for (const card of raw.cards) assert.equal(Object.hasOwn(card, 'presetKey'), false);
}));

test('missing cards with legacy systemPrompt remain an unbound migrated active persona plus inactive Gene', async () => fixture(async directory => {
  const old = JSON.stringify({ systemPrompt: 'FULL OLD\nSYSTEM PROMPT', model: { path: 'ORIGINAL_MODEL' }, voice: { enabled: true } });
  await writeFile(path.join(directory, 'settings.json'), old);
  const { cards, state, profile } = await open(directory);
  assert.equal(profile.fresh, false); assert.equal(profile.legacySystemPrompt, 'FULL OLD\nSYSTEM PROMPT');
  assert.equal(state.cards.length, 2); assert.equal(cards.getActive().name, '默认伙伴');
  assert.equal(cards.getActive().systemPrompt, 'FULL OLD\nSYSTEM PROMPT'); assert.equal(cards.getActive().modelPath, undefined);
  assert.equal(state.cards[1].name, 'Gene'); assert.notEqual(state.activeId, state.cards[1].id);
  assert.equal(await readFile(path.join(directory, 'settings.json'), 'utf8'), old);
}));

test('malformed settings still prove an existing profile and cannot authorize the Gene first default', async () => fixture(async directory => {
  await writeFile(path.join(directory, 'settings.json'), '{preserve broken legacy source');
  const { cards, profile } = await open(directory); assert.equal(profile.fresh, false);
  assert.equal(cards.getActive().name, '默认伙伴'); assert.equal(cards.getActive().modelPath, undefined);
  assert.equal(await readFile(path.join(directory, 'settings.json'), 'utf8'), '{preserve broken legacy source');
}));

test('historical mood/memory/response/audio data and chat directory prevent fresh classification without touching their bytes', async () => {
  for (const name of ['mood-state.json','memories.jsonl','character-response-settings.json','system-audio-transcripts.json','other-private-settings.json','settings.json.orphan.tmp','chat']) await fixture(async directory => {
    if (name === 'chat') await mkdir(path.join(directory, name)); else await writeFile(path.join(directory, name), 'OLD_HISTORY');
    const { profile, cards } = await open(directory); assert.equal(profile.fresh, false); assert.equal(cards.getActive().name, '默认伙伴');
    if (name !== 'chat') assert.equal(await readFile(path.join(directory, name), 'utf8'), 'OLD_HISTORY');
  });
});

test('installed preset user edits, tuning, unbinding and another active card survive restarts and definition-version metadata', async () => fixture(async directory => {
  const first = await open(directory), geneId = first.state.activeId;
  const edited = { ...preinstalledGeneDraft(), name: 'My edited Gene', systemPrompt: 'MY_PERSONALITY', mood: defaultCharacterMoodTemplate() };
  edited.mood.parameters.baseline.D = 71; edited.mood.parameters.blush.size = 78;
  await first.cards.save(edited, geneId); await first.cards.bindModel(geneId, null);
  await first.cards.save(textDraft('Other active character', 'OTHER_PERSONA'));
  const other = first.cards.publicState().cards.find(card => card.id !== geneId)!; await first.cards.activate(other.id);
  const upgradedLedger = { ...await readLedger(directory), definitionVersion: 2, definitionSha256: '0'.repeat(64) };
  await writeFile(ledgerFile(directory), JSON.stringify(upgradedLedger));
  const beforeCards = await readFile(file(directory), 'utf8'), beforeLedger = await readFile(ledgerFile(directory), 'utf8');
  const next = await open(directory); assert.equal(next.state.activeId, other.id); assert.equal(next.state.cards.length, 2);
  assert.equal(await readFile(file(directory), 'utf8'), beforeCards); assert.equal(await readFile(ledgerFile(directory), 'utf8'), beforeLedger);
  assert.equal(next.state.cards.find(card => card.id === geneId)?.name, 'My edited Gene');
  assert.equal((await readCards(directory)).cards.find((card: {id:string}) => card.id === geneId).modelPath, undefined);
}));

test('an installed ID removed by the user is not resurrected', async () => fixture(async directory => {
  const first = await open(directory), geneId = first.state.activeId;
  await first.cards.save(textDraft('Keep this card', 'KEEP'));
  const other = first.cards.publicState().cards.find(card => card.id !== geneId)!; await first.cards.activate(other.id); await first.cards.remove(geneId);
  const before = await readFile(file(directory), 'utf8'); const next = await open(directory);
  assert.equal(next.state.cards.length, 1); assert.equal(next.state.activeId, other.id); assert.equal(await readFile(file(directory), 'utf8'), before);
}));

test('pending UUID collision with different private content fails closed without overwrite or duplication', async () => fixture(async directory => {
  const original = await seed(directory);
  const ledger = { version: 1, presetKey: GENE_PRESET_KEY, definitionVersion: 1, definitionSha256: GENE_PRESET_DEFINITION_SHA256, cardId: original.id, status: 'pending', initialDefault: false, firstModelPending: false,
    cardsBeforeSha256: createHash('sha256').update(await readFile(file(directory))).digest('hex') };
  await writeFile(ledgerFile(directory), JSON.stringify(ledger)); const before = await readFile(file(directory), 'utf8');
  const next = await open(directory); assert.equal(next.state.cards.length, 1); assert.equal(next.state.activeId, original.id); assert.ok(next.state.notice);
  assert.equal(await readFile(file(directory), 'utf8'), before); assert.equal((await readLedger(directory)).status, 'pending');
}));

test('unreadable preset provenance never guesses by Gene name or modifies existing cards', async () => fixture(async directory => {
  const original = await seed(directory); await writeFile(ledgerFile(directory), '{BROKEN_PRESET_SOURCE');
  const before = await readFile(file(directory), 'utf8'); const next = await open(directory);
  assert.equal(next.state.activeId, original.id); assert.equal(next.state.cards.length, 1); assert.ok(next.state.notice);
  assert.equal(await readFile(file(directory), 'utf8'), before); assert.equal(await readFile(ledgerFile(directory), 'utf8'), '{BROKEN_PRESET_SOURCE');
}));

test('capacity exhaustion preserves every old record and defers rather than deleting or marking installed', async () => fixture(async directory => {
  const records = Array.from({ length: MAX_CHARACTER_CARDS }, privateCard); const activeId = records[17].id;
  const old = JSON.stringify({ version: 1, revision: 7, activeId, cards: records }); await writeFile(file(directory), old);
  const next = await open(directory); assert.equal(next.state.cards.length, MAX_CHARACTER_CARDS); assert.equal(next.state.activeId, activeId); assert.ok(next.state.notice);
  assert.equal(await readFile(file(directory), 'utf8'), old); assert.equal(await readFile(ledgerFile(directory), 'utf8').catch(() => null), null);
}));

test('reservation write failure preserves existing profile and a later successful startup adds only one inactive card', async () => fixture(async directory => {
  const original = await seed(directory), before = await readFile(file(directory), 'utf8');
  const failed = await open(directory, async (target, bytes) => { if (target.endsWith(GENE_PRESET_FILE)) throw Error('SYNTHETIC_RESERVATION_FAILURE'); await atomicWriteFile(target, bytes); });
  assert.ok(failed.state.notice); assert.equal(await readFile(file(directory), 'utf8'), before);
  const next = await open(directory); assert.equal(next.state.cards.length, 2); assert.equal(next.state.activeId, original.id);
  const again = await open(directory); assert.equal(again.state.cards.length, 2); assert.equal(again.state.activeId, original.id);
}));

test('fresh card-write failure retains pending provenance and retry uses the same UUID as first default', async () => fixture(async directory => {
  await assert.rejects(open(directory, async (target, bytes) => { if (target.endsWith('characters.json')) throw Error('SYNTHETIC_CARD_WRITE_FAILURE'); await atomicWriteFile(target, bytes); }));
  const pending = await readLedger(directory); assert.equal(pending.status, 'pending'); assert.equal(await readFile(file(directory), 'utf8').catch(() => null), null);
  const next = await open(directory); assert.equal(next.profile.fresh, true); assert.equal(next.state.activeId, pending.cardId); assert.equal(next.state.cards.length, 1);
  assert.equal((await readLedger(directory)).status, 'installed');
}));

test('post-commit provenance failure returns an honest notice and retry completes same-ID registration without card rewrite', async () => fixture(async directory => {
  const first = await open(directory, async (target, bytes) => { if (target.endsWith(GENE_PRESET_FILE) && JSON.parse(bytes).status === 'installed') throw Error('SYNTHETIC_COMPLETE_FAILURE'); await atomicWriteFile(target, bytes); });
  assert.ok(first.state.notice); assert.equal((await readLedger(directory)).status, 'pending'); const old = await readFile(file(directory), 'utf8');
  const next = await open(directory); assert.equal(next.state.activeId, first.state.activeId); assert.equal(next.state.cards.length, 1);
  assert.equal(await readFile(file(directory), 'utf8'), old); assert.equal((await readLedger(directory)).status, 'installed');
}));

test('corrupt provenance alone is prior data, never permission to overwrite with a fresh Gene default', async () => fixture(async directory => {
  await writeFile(ledgerFile(directory), '{BROKEN'); const next = await open(directory);
  assert.equal(next.profile.fresh, false); assert.equal(next.cards.getActive().name, '默认伙伴'); assert.equal(next.cards.getActive().modelPath, undefined);
  assert.ok(next.state.notice); assert.equal(await readFile(ledgerFile(directory), 'utf8'), '{BROKEN');
}));

test('interruption after first card commit resumes only the unchanged first Gene model setup once', async () => fixture(async directory => {
  const first = await open(directory), geneId = first.state.activeId;
  assert.equal((await readLedger(directory)).firstModelPending, true);
  const before = await readFile(file(directory), 'utf8');
  const restarted = await open(directory); assert.equal(restarted.profile.fresh, false);
  assert.equal(await restarted.cards.needsInitialGeneModel(false), true);
  assert.equal(restarted.state.activeId, geneId); assert.equal(await readFile(file(directory), 'utf8'), before);
  // The real main calls this only after BundledAssets.getDefaultAssets and settings commit.
  await writeFile(path.join(directory, 'settings.json'), '{"model":"TRUSTED_GENE_COMMIT_FIXTURE"}');
  await restarted.cards.completeInitialGeneModel();
  assert.equal((await readLedger(directory)).firstModelPending, false);
  assert.equal(await restarted.cards.needsInitialGeneModel(false), false);
}));

test('existing settings after an interrupted final marker are authoritative and never overwritten', async () => fixture(async directory => {
  await open(directory); const settings = '{"model":"USER_MODEL","persona":"USER_PERSONA","voice":"KEEP"}';
  await writeFile(path.join(directory, 'settings.json'), settings);
  const restarted = await open(directory), before = await readFile(file(directory), 'utf8');
  assert.equal(await restarted.cards.needsInitialGeneModel(true), false);
  assert.equal((await readLedger(directory)).firstModelPending, false);
  assert.equal(await readFile(file(directory), 'utf8'), before); assert.equal(await readFile(path.join(directory, 'settings.json'), 'utf8'), settings);
}));

test('edited first Gene or another active card cancels the one-time model authority without card changes', async () => fixture(async directory => {
  const first = await open(directory); await first.cards.save({ ...preinstalledGeneDraft(), name: 'My edited first Gene' }, first.state.activeId);
  await first.cards.save(textDraft('A different active persona', 'OTHER'));
  const other = first.cards.publicState().cards.find(card => card.id !== first.state.activeId)!; await first.cards.activate(other.id);
  const before = await readFile(file(directory), 'utf8');
  assert.equal(await first.cards.needsInitialGeneModel(false), false);
  assert.equal(await readFile(file(directory), 'utf8'), before); assert.equal(first.cards.getActive().id, other.id);
  assert.equal((await readLedger(directory)).firstModelPending, false);
}));

test('deleting a post-commit pending Gene consumes provenance first and does not resurrect or rewrite private records', async () => fixture(async directory => {
  const original = await seed(directory); let failComplete = true;
  const current = await open(directory, async (target, bytes) => {
    if (target.endsWith(GENE_PRESET_FILE) && JSON.parse(bytes).status === 'installed' && failComplete) { failComplete = false; throw Error('SYNTHETIC_FIRST_COMPLETE_FAILURE'); }
    await atomicWriteFile(target, bytes);
  });
  assert.equal((await readLedger(directory)).status, 'pending'); const geneId = (await readLedger(directory)).cardId;
  await current.cards.remove(geneId);
  assert.equal((await readLedger(directory)).status, 'installed'); assert.equal((await readLedger(directory)).firstModelPending, false);
  const before = await readFile(file(directory), 'utf8'); assert.deepEqual((await readCards(directory)).cards, [original]);
  const restarted = await open(directory); assert.equal(restarted.state.cards.length, 1); assert.equal(restarted.state.activeId, original.id);
  assert.equal(await readFile(file(directory), 'utf8'), before);
}));

test('pending preset delete refuses the card commit when provenance cannot durably consume its identity', async () => fixture(async directory => {
  await seed(directory);
  const current = await open(directory, async (target, bytes) => {
    if (target.endsWith(GENE_PRESET_FILE) && JSON.parse(bytes).status === 'installed') throw Error('SYNTHETIC_COMPLETE_UNAVAILABLE');
    await atomicWriteFile(target, bytes);
  });
  const geneId = (await readLedger(directory)).cardId, before = await readFile(file(directory), 'utf8');
  await assert.rejects(current.cards.remove(geneId)); assert.equal(await readFile(file(directory), 'utf8'), before);
  assert.equal(current.cards.publicState().cards.length, 2); assert.equal((await readLedger(directory)).status, 'pending');
}));

test('an older application deleting a pending preset cannot cause it to reappear on upgrade', async () => fixture(async directory => {
  const original = await seed(directory);
  await open(directory, async (target, bytes) => {
    if (target.endsWith(GENE_PRESET_FILE) && JSON.parse(bytes).status === 'installed') throw Error('SYNTHETIC_COMPLETE_UNAVAILABLE');
    await atomicWriteFile(target, bytes);
  });
  const geneId = (await readLedger(directory)).cardId, stored = await readCards(directory);
  stored.cards = stored.cards.filter((card: {id:string}) => card.id !== geneId); stored.revision++;
  await writeFile(file(directory), JSON.stringify(stored)); const before = await readFile(file(directory), 'utf8');
  const next = await open(directory); assert.equal(next.state.cards.length, 1); assert.equal(next.state.activeId, original.id); assert.ok(next.state.notice);
  assert.equal(await readFile(file(directory), 'utf8'), before); assert.deepEqual((await readCards(directory)).cards, [original]);
}));

test('successful final first-model registration clears an earlier partial-install notice', async () => fixture(async directory => {
  let failOnce = true;
  const first = await open(directory, async (target, bytes) => {
    if (target.endsWith(GENE_PRESET_FILE) && JSON.parse(bytes).status === 'installed' && failOnce) { failOnce = false; throw Error('SYNTHETIC_FIRST_COMPLETE_FAILURE'); }
    await atomicWriteFile(target, bytes);
  });
  assert.ok(first.state.notice); assert.equal(await first.cards.needsInitialGeneModel(false), true);
  await writeFile(path.join(directory, 'settings.json'), '{"model":"TRUSTED_GENE_COMMIT_FIXTURE"}');
  await first.cards.completeInitialGeneModel();
  assert.equal(first.cards.publicState().notice, undefined); assert.equal((await readLedger(directory)).firstModelPending, false);
}));
