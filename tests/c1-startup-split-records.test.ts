// C1's startup migration promised "只新增卡或换当前卡，原卡逐字节不变". Codex T-112 round 009 found two ways it broke that
// promise (M02, M03); these are its two minimal sequences, plus the same promise for C3's in-place update: apart from
// the card being updated, every card's stored record stays exactly as it was. Synthetic cards and paths only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CharacterCardStore } from '../electron/character-cards';
import { CharacterResponseStore } from '../electron/character-response';
import { CharacterCardUpdater } from '../electron/character-card-update';
import { MODEL_SPLIT_BACKUP, planCardForModel, splitCardFromModelAtStartup, type ModelIdentity } from '../electron/character-model-link';
import { BUNDLED_CHARACTER_MODEL, CHARACTER_CARD_FORMAT, defaultCharacterMoodTemplate } from '../shared/character-cards';

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-startup-records-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
/** Metadata only: no model file is created or read. */
const model = (directory: string, name: string): ModelIdentity => ({ reference: path.join(directory, 'metadata-only', name, `${name}.pmx`), names: [name], newName: name, displayName: `${name}.pmx` });
const draft = (name: string) => ({ name, description: 'synthetic description', personality: 'synthetic personality', scenario: '', greeting: '', examples: '', systemPrompt: '',
  mood: defaultCharacterMoodTemplate(), slowWarmUp: true });
const disk = async (directory: string) => JSON.parse(await readFile(path.join(directory, 'characters.json'), 'utf8'));
const LEGACY = '11111111-1111-4111-8111-111111111111';

test('M02: the startup split does not rewrite a sparse older record the store accepts', async () => withDirectory(async directory => {
  const old = { version: 1, cards: [{ id: LEGACY, name: 'Legacy', modelPath: BUNDLED_CHARACTER_MODEL }], activeId: LEGACY };
  const bytes = JSON.stringify(old);
  await writeFile(path.join(directory, 'characters.json'), bytes);
  const cards = new CharacterCardStore(directory, 'synthetic');
  await cards.load();
  const split = await splitCardFromModelAtStartup(cards, model(directory, 'Aster'), directory);
  assert.equal(split?.result.kind, 'create');
  assert.equal(await readFile(path.join(directory, MODEL_SPLIT_BACKUP), 'utf8'), bytes);
  const saved = await disk(directory);
  assert.deepEqual(saved.cards.find((card: { id: string }) => card.id === LEGACY), old.cards[0], 'the old record is exactly as it was: no default fields written into it');
  assert.equal(saved.cards.length, 2);
  // And it still reads as the same card.
  const again = new CharacterCardStore(directory, 'synthetic');
  await again.load();
  assert.equal(again.publicState().cards.find(card => card.id === LEGACY)?.name, 'Legacy');
}));

test('M03: with the preinstalled Gene current and an unlinked card of the model\'s name, the startup split only changes the current card', async () => withDirectory(async directory => {
  const cards = new CharacterCardStore(directory, 'synthetic legacy');
  await cards.load({ preinstalledGene: true, freshProfile: true });
  await cards.save(draft('Aster'));
  const before = await disk(directory), aster = before.cards.find((card: { name: string }) => card.name === 'Aster');
  assert.notEqual(before.activeId, aster.id, 'Gene is current');
  const split = await splitCardFromModelAtStartup(cards, model(directory, 'Aster'), directory);
  // Rule 2 at startup: she becomes current, but nothing is written into her card (no model link).
  assert.equal(split?.result.kind, 'select');
  const after = await disk(directory);
  assert.equal(after.activeId, aster.id);
  assert.equal(after.cards.length, before.cards.length, 'no card added');
  for (const card of before.cards) assert.deepEqual(after.cards.find((value: { id: string }) => value.id === card.id), card, `${card.name} is exactly as it was`);
  assert.equal(after.cards.find((card: { id: string }) => card.id === aster.id).modelPath, undefined);
  // Stable: the next start leaves everything alone (her card has no link, so nothing is "linked to another model").
  const stable = await readFile(path.join(directory, 'characters.json'));
  assert.equal(await splitCardFromModelAtStartup(cards, model(directory, 'Aster'), directory), null);
  assert.deepEqual(await readFile(path.join(directory, 'characters.json')), stable);
  // Loading the model yourself still links a card of its name (C1 rule 2 on load is unchanged).
  assert.deepEqual(await planCardForModel(cards, model(directory, 'Aster')), { kind: 'bind', id: aster.id });
}));

test('C3: updating one card in place leaves every other card\'s stored record exactly as it was, sparse ones included', async () => withDirectory(async directory => {
  const target = '22222222-2222-4222-8222-222222222222';
  const old = { version: 1, activeId: LEGACY, cards: [
    { id: LEGACY, name: 'Legacy', modelPath: BUNDLED_CHARACTER_MODEL },
    { id: target, name: '阿澄', description: '', personality: '安静', scenario: '', greeting: '', examples: '', systemPrompt: '', mood: defaultCharacterMoodTemplate() },
  ] };
  await writeFile(path.join(directory, 'characters.json'), JSON.stringify(old));
  const cards = new CharacterCardStore(directory, 'synthetic');
  await cards.load();
  const responses = new CharacterResponseStore(directory, () => cards.publicState().cards.map(card => card.id));
  await responses.load();
  const updater = new CharacterCardUpdater({ cards, responses, directory });
  const file = JSON.stringify({ format: CHARACTER_CARD_FORMAT, version: 2, card: { name: '阿澄', personality: '安静，也会撒娇', mood: defaultCharacterMoodTemplate() } });
  assert.equal((await updater.update(target, file, cards.cardFingerprint(target))).changed, true);
  let saved = await disk(directory);
  assert.deepEqual(saved.cards[0], old.cards[0], 'the other card, sparse as it was');
  assert.equal(saved.cards[1].personality, '安静，也会撒娇');
  assert.equal(saved.cards[1].id, target);
  // Other everyday writes keep it as well: switching, the editor's save of another card.
  await cards.activate(target);
  await cards.save({ ...draft('阿澄'), personality: '编辑器里改的' }, target);
  saved = await disk(directory);
  assert.deepEqual(saved.cards[0], old.cards[0]);
  // A change to that card itself writes it out in full, as before.
  await cards.setSlowWarmUp(LEGACY, true);
  saved = await disk(directory);
  assert.equal(saved.cards[0].slowWarmUp, true);
  assert.equal(saved.cards[0].description, '');
}));
