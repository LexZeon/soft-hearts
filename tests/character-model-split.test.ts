// C1 角色和模型分开 (docs/claude/2026-11-03-character-model.md): a loaded model picks its own card, the preinstalled
// Gene card goes with the preinstalled Gene only, and the startup split backs up and never deletes or overwrites.
// Synthetic models only (tests/helpers/pmx-write.ts); no private model or profile is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CharacterCardStore, PRESET_GENE_MODEL_ERROR } from '../electron/character-cards';
import { MODEL_SPLIT_BACKUP, planCardForModel, readModelIdentity, splitCardFromModelAtStartup } from '../electron/character-model-link';
import { BUNDLED_CHARACTER_MODEL, defaultCharacterMoodTemplate, type CharacterDraft } from '../shared/character-cards';
import {
  characterNameForModel, decideCharacterForModel, minimalCharacterDraft, normalizeCharacterName, readMmdModelNames,
  sameModelReference, startupNeedsModelSplit,
} from '../shared/character-model';
import { writePmx } from './helpers/pmx-write';

const tinyModel = (name: string, englishName = name, encoding: 0 | 1 = 0) => writePmx({ name, englishName, encoding,
  positions: [0, 0, 0], skin: [{ deform: 0, bones: [0], weights: [1] }], bones: [{ name: 'センター', parent: -1, position: [0, 0, 0] }], morphs: [] });

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-model-split-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function modelFile(directory: string, folder: string, file: string, pmxName: string, englishName = pmxName): Promise<string> {
  const target = path.join(directory, 'models', folder, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, tinyModel(pmxName, englishName));
  return target;
}
function draft(name: string): CharacterDraft {
  return { name, description: `${name} 的简介`, personality: `${name} 的性格`, scenario: '', greeting: '', examples: '', systemPrompt: '', mood: defaultCharacterMoodTemplate() };
}
/** A fresh profile: the preinstalled Gene card is the only card and is current. */
async function freshStore(directory: string): Promise<CharacterCardStore> {
  const cards = new CharacterCardStore(directory, 'legacy persona');
  await cards.load({ preinstalledGene: true, freshProfile: true });
  return cards;
}
const bundledIdentity = () => readModelIdentity('unused', { bundled: true });

test('the three rules as a pure decision: linked card, unlinked card with the model\'s name, else a new card', () => {
  const cards = [
    { id: 'gene', name: 'Gene', modelPath: BUNDLED_CHARACTER_MODEL },
    { id: 'alice', name: 'Alice', modelPath: 'C:\\Models\\Alice\\alice.pmx' },
    { id: 'bob', name: 'ＢＯＢ ' },
    { id: 'plain', name: '小雪' },
  ];
  const decide = (activeId: string, reference: string, names: string[]) =>
    decideCharacterForModel({ cards, activeId, presetGeneId: 'gene', reference, names, newName: names[0] ?? '新角色' });
  // Rule 1: the current card stays when it goes with the model; another linked card is switched to (case and separators do not matter).
  assert.deepEqual(decide('alice', 'c:/models/alice/ALICE.pmx', ['Alice']), { kind: 'keep', id: 'alice' });
  assert.deepEqual(decide('gene', 'C:\\Models\\Alice\\alice.pmx', ['whatever']), { kind: 'switch', id: 'alice' });
  assert.deepEqual(decide('alice', BUNDLED_CHARACTER_MODEL, ['Gene']), { kind: 'switch', id: 'gene' });
  // Rule 2: name match ignores width, case and spacing; the current card is preferred among matches.
  assert.deepEqual(decide('gene', 'D:\\x\\b.pmx', ['bob']), { kind: 'bind', id: 'bob' });
  // Rule 3: nothing matches (an unlinked current card with another name is not reused).
  assert.deepEqual(decide('plain', 'D:\\x\\c.pmx', ['Carol']), { kind: 'create', name: 'Carol' });
  // The preinstalled Gene card is never rule 2's target, even when it has lost its link and the names match.
  const unlinkedGene = [{ id: 'gene', name: 'Gene' }];
  assert.deepEqual(decideCharacterForModel({ cards: unlinkedGene, activeId: 'gene', presetGeneId: 'gene', reference: 'D:\\gene-copy\\Gene.pmx', names: ['Gene'], newName: 'Gene' }),
    { kind: 'create', name: 'Gene' });
  assert.deepEqual(decideCharacterForModel({ cards: unlinkedGene, activeId: 'gene', presetGeneId: 'gene', reference: BUNDLED_CHARACTER_MODEL, names: ['Gene'], newName: 'Gene' }),
    { kind: 'keep', id: 'gene' });
  assert.equal(normalizeCharacterName(' Ｇｅｎｅ\u3000'), 'gene');
  assert.ok(sameModelReference('C:\\A\\b.PMX', 'c:/a/b.pmx'));
  assert.ok(!sameModelReference(BUNDLED_CHARACTER_MODEL, 'C:\\bundled\\gene.pmx'));
});

test('the startup split only moves a current card that is linked to another model', () => {
  assert.equal(startupNeedsModelSplit({ id: 'gene', name: 'Gene', modelPath: BUNDLED_CHARACTER_MODEL }, 'gene', 'D:\\other\\o.pmx'), true);
  assert.equal(startupNeedsModelSplit({ id: 'gene', name: 'Gene' }, 'gene', 'D:\\other\\o.pmx'), true, 'the Gene card without its link still belongs to Gene');
  assert.equal(startupNeedsModelSplit({ id: 'gene', name: 'Gene', modelPath: BUNDLED_CHARACTER_MODEL }, 'gene', BUNDLED_CHARACTER_MODEL), false);
  assert.equal(startupNeedsModelSplit({ id: 'own', name: '小雪' }, 'gene', 'D:\\other\\o.pmx'), false, 'an unlinked card keeps the model it is shown with');
  assert.equal(startupNeedsModelSplit({ id: 'gene', name: 'Gene', modelPath: BUNDLED_CHARACTER_MODEL }, 'gene', null), false);
});

test('a model names itself: PMX local name (UTF-16 and UTF-8), then English name, then folder, then file name', async () => {
  assert.deepEqual(readMmdModelNames(tinyModel('アリス', 'Alice')), { local: 'アリス', universal: 'Alice' });
  assert.deepEqual(readMmdModelNames(tinyModel('爱丽丝', 'Alice', 1)), { local: '爱丽丝', universal: 'Alice' });
  const pmd = new Uint8Array(300); pmd.set([0x50, 0x6d, 0x64]); new DataView(pmd.buffer).setFloat32(3, 1, true); pmd.set(new TextEncoder().encode('Miku'), 7);
  assert.deepEqual(readMmdModelNames(pmd), { local: 'Miku', universal: '' });
  assert.equal(readMmdModelNames(new TextEncoder().encode('not a model')), null);
  assert.equal(characterNameForModel({ modelNames: ['', 'Alice'], folder: 'folder', stem: 'file' }), 'Alice');
  assert.equal(characterNameForModel({ modelNames: [' \u0007 '], folder: '爱丽丝', stem: 'file' }), '爱丽丝');
  assert.equal(characterNameForModel({ modelNames: [], folder: '', stem: 'file' }), 'file');
  await withDirectory(async directory => {
    const file = await modelFile(directory, '爱丽丝文件夹', 'alice.pmx', '');
    const identity = await readModelIdentity(file, { bundled: false });
    assert.equal(identity.newName, '爱丽丝文件夹', 'no PMX name: the folder name');
    assert.equal(identity.reference, file);
    assert.deepEqual(identity.names, ['爱丽丝文件夹', 'alice']);
    const broken = path.join(directory, 'models', 'Broken', 'broken.pmx');
    await mkdir(path.dirname(broken), { recursive: true }); await writeFile(broken, 'xx');
    assert.equal((await readModelIdentity(broken, { bundled: false })).newName, 'Broken');
  });
  // The minimal card: the model's name, one line, the balanced template.
  const minimal = minimalCharacterDraft('Alice');
  assert.equal(minimal.name, 'Alice');
  assert.equal(minimal.description, 'Alice，住在用户桌面上的伙伴。');
  assert.deepEqual([minimal.personality, minimal.scenario, minimal.greeting, minimal.examples, minimal.systemPrompt], ['', '', '', '', '']);
  assert.deepEqual(minimal.mood, defaultCharacterMoodTemplate());
});

test('rule 3, then rule 1 both ways: a new model gets its own card; loading Gene again switches back to the Gene card', async () => {
  await withDirectory(async directory => {
    const cards = await freshStore(directory);
    const gene = cards.getActive();
    assert.equal(gene.modelPath, BUNDLED_CHARACTER_MODEL);
    const file = await modelFile(directory, 'AliceFolder', 'alice.pmx', 'アリス', 'Alice');
    const identity = await readModelIdentity(file, { bundled: false });
    const create = await planCardForModel(cards, identity);
    assert.deepEqual(create, { kind: 'create', name: 'アリス' });
    const created = await cards.adoptModel(create!, { modelPath: identity.reference, modelName: identity.displayName });
    assert.equal(created.changed, true);
    const alice = cards.getActive();
    assert.notEqual(alice.id, gene.id);
    assert.equal(alice.name, 'アリス');
    assert.equal(alice.modelPath, file);
    assert.equal(alice.modelName, 'alice.pmx');
    assert.deepEqual(alice.mood, defaultCharacterMoodTemplate());
    // The Gene card is untouched and still goes with the preinstalled Gene only.
    const geneAfter = cards.publicState().cards.find(card => card.id === gene.id)!;
    const { modelPath: _path, ...genePublic } = gene;
    assert.deepEqual(geneAfter, genePublic);
    // Rule 1: the preinstalled Gene picks the Gene card; Alice's model picks Alice's card (no third card).
    const back = await planCardForModel(cards, await bundledIdentity());
    assert.deepEqual(back, { kind: 'switch', id: gene.id });
    await cards.adoptModel(back!, { modelPath: BUNDLED_CHARACTER_MODEL, modelName: 'Gene' });
    assert.equal(cards.getActive().id, gene.id);
    const again = await planCardForModel(cards, identity);
    assert.deepEqual(again, { kind: 'switch', id: alice.id });
    await cards.adoptModel(again!, { modelPath: file, modelName: 'alice.pmx' });
    assert.equal(cards.getActive().id, alice.id);
    assert.equal(cards.publicState().cards.length, 2);
    assert.equal(await planCardForModel(cards, identity), null, 'the current card already goes with the model');
  });
});

test('rule 2: an unlinked card whose name matches the folder is linked and becomes current; nothing else changes', async () => {
  await withDirectory(async directory => {
    const cards = await freshStore(directory);
    await cards.save(draft('Bob'));
    const bob = cards.publicState().cards.find(card => card.name === 'Bob')!;
    const before = structuredClone(cards.publicState().cards);
    const file = await modelFile(directory, 'bob', 'model.pmx', 'ボブ', 'B-o-b');
    const identity = await readModelIdentity(file, { bundled: false });
    const decision = await planCardForModel(cards, identity);
    assert.deepEqual(decision, { kind: 'bind', id: bob.id });
    await cards.adoptModel(decision!, { modelPath: file, modelName: identity.displayName });
    assert.equal(cards.getActive().id, bob.id);
    assert.equal(cards.getActive().modelPath, file);
    const after = cards.publicState().cards;
    assert.equal(after.length, before.length);
    for (const card of before) {
      const now = after.find(value => value.id === card.id)!;
      assert.deepEqual({ ...now, modelName: undefined }, { ...card, modelName: undefined }, 'text and mood of every card are unchanged');
    }
  });
});

test('the preinstalled Gene card is never linked to another model; without its link it still goes with Gene only', async () => {
  await withDirectory(async directory => {
    const cards = await freshStore(directory);
    const gene = cards.getActive();
    assert.equal(await cards.presetGeneId(), gene.id);
    const file = await modelFile(directory, 'Other', 'other.pmx', 'Other');
    await assert.rejects(cards.bindModel(gene.id, file, 'other.pmx'), { message: PRESET_GENE_MODEL_ERROR });
    assert.equal(cards.getActive().modelPath, BUNDLED_CHARACTER_MODEL);
    // Older profiles could remove its link (tests/gene-preinstalled-card.test.ts); it still is no other model's card.
    await cards.bindModel(gene.id, null);
    const identity = await readModelIdentity(file, { bundled: false });
    assert.deepEqual(await planCardForModel(cards, identity), { kind: 'create', name: 'Other' });
    assert.equal(await planCardForModel(cards, await bundledIdentity()), null, 'the Gene model still finds the Gene card current');
    // A copy of Gene's model elsewhere is another model: its own card, named so it never looks like the Gene card.
    const geneCopy = await modelFile(directory, 'gene-copy', 'gene.pmx', 'Gene');
    assert.deepEqual(await planCardForModel(cards, await readModelIdentity(geneCopy, { bundled: false })), { kind: 'create', name: 'Gene 2' });
    await cards.bindModel(gene.id, BUNDLED_CHARACTER_MODEL, 'Gene');
    // Another card may still take any model.
    await cards.save(draft('Copy of Gene'));
    const copy = cards.publicState().cards.find(card => card.name === 'Copy of Gene')!;
    await cards.bindModel(copy.id, file, 'other.pmx');
    assert.equal(cards.publicState().cards.find(card => card.id === copy.id)!.modelName, 'other.pmx');
  });
});

test('startup split: the Gene card with another model gets a new card; characters.json is backed up first and nothing is deleted or rewritten', async () => {
  await withDirectory(async directory => {
    const cards = await freshStore(directory);
    await cards.save(draft('Unrelated'));
    const gene = cards.getActive();
    const file = await modelFile(directory, 'Mira-like', 'model.pmx', 'Synthetic Mira');
    const original = await readFile(path.join(directory, 'characters.json'), 'utf8');
    const originalCards = JSON.parse(original).cards as Record<string, unknown>[];
    // A restart: the store reads the same file, the stage model is someone else's.
    const restarted = new CharacterCardStore(directory, 'legacy persona');
    await restarted.load({ preinstalledGene: true });
    const split = await splitCardFromModelAtStartup(restarted, await readModelIdentity(file, { bundled: false }), directory);
    assert.ok(split);
    assert.equal(split.from, 'Gene');
    assert.equal(split.result.kind, 'create');
    assert.equal(await readFile(path.join(directory, MODEL_SPLIT_BACKUP), 'utf8'), original, 'the backup holds the exact original bytes');
    const saved = JSON.parse(await readFile(path.join(directory, 'characters.json'), 'utf8'));
    assert.equal(saved.cards.length, originalCards.length + 1);
    for (const card of originalCards) assert.deepEqual(saved.cards.find((value: { id: string }) => value.id === card.id), card, 'every original card is kept as it was');
    assert.notEqual(saved.activeId, gene.id);
    assert.equal(restarted.getActive().name, 'Synthetic Mira');
    // Chats with Gene stay with Gene: the Gene card id is unchanged, so its memories stay keyed to it.
    assert.ok(saved.cards.some((value: { id: string; name: string }) => value.id === gene.id && value.name === 'Gene'));
    // A second start changes nothing and keeps the oldest backup.
    await writeFile(path.join(directory, 'marker.txt'), '');
    assert.equal(await splitCardFromModelAtStartup(restarted, await readModelIdentity(file, { bundled: false }), directory), null);
    assert.equal(await readFile(path.join(directory, MODEL_SPLIT_BACKUP), 'utf8'), original);
  });
});

test('startup split leaves an unlinked current card alone, and a failed backup leaves every card as it was', async () => {
  await withDirectory(async directory => {
    const cards = await freshStore(directory);
    await cards.save(draft('小雪'));
    const own = cards.publicState().cards.find(card => card.name === '小雪')!;
    await cards.activate(own.id);
    const file = await modelFile(directory, 'Yuki', 'yuki.pmx', 'Yuki');
    const identity = await readModelIdentity(file, { bundled: false });
    assert.equal(await splitCardFromModelAtStartup(cards, identity, directory), null);
    await assert.rejects(readFile(path.join(directory, MODEL_SPLIT_BACKUP)), { code: 'ENOENT' }, 'no backup when nothing changes');
    // The Gene card current with Yuki's model, but the backup cannot be written (its place is a folder).
    await cards.activate((await cards.presetGeneId())!);
    const before = await readFile(path.join(directory, 'characters.json'), 'utf8');
    await mkdir(path.join(directory, MODEL_SPLIT_BACKUP));
    await assert.rejects(splitCardFromModelAtStartup(cards, identity, directory));
    assert.equal(await readFile(path.join(directory, 'characters.json'), 'utf8'), before);
  });
});

test('rule 3 respects the card limit: the model keeps the current card and the user is told why', async () => {
  await withDirectory(async directory => {
    const cards = await freshStore(directory);
    for (let index = 1; index < 64; index++) await cards.save(draft(`角色 ${index}`));
    const file = await modelFile(directory, 'Full', 'full.pmx', 'Full');
    const identity = await readModelIdentity(file, { bundled: false });
    const decision = await planCardForModel(cards, identity);
    const active = cards.getActive().id;
    await assert.rejects(cards.adoptModel(decision!, { modelPath: file, modelName: 'full.pmx' }), /最多保存 64 张角色卡/);
    assert.equal(cards.getActive().id, active);
  });
});
