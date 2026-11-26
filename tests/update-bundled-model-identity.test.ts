// 2026-11-26 (docs/claude/2026-11-26-update-blank-card.md): after an update into a new folder (a source ZIP next to the old one, or a new
// packaged build in its own versioned folder) the settings still point the stage at the OLD folder's copy of a preinstalled model. That
// file is the same bundled model, so the startup split must leave her card alone; a model the user loaded keeps being compared by its path.
// Synthetic models only (tests/helpers/pmx-write.ts) at the stored shapes the app writes; no private model or profile is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CharacterCardStore } from '../electron/cards/character-cards';
import { bundledReferenceForPath } from '../electron/cards/bundled-character-models';
import { MODEL_SPLIT_BACKUP, planStartupSplit, splitCardFromModelAtStartup, stageModelIdentity } from '../electron/cards/character-model-link';
import { bundledModelKeyForInstalledPath, canonicalModelReference } from '../shared/cards/bundled-characters';
import { BUNDLED_CHARACTER_MODEL, defaultCharacterMoodTemplate, type CharacterDraft } from '../shared/cards/character-cards';
import { decideCharacterForModel, effectiveCardModel, sameModelReference, startupNeedsModelSplit } from '../shared/cards/character-model';
import { writePmx } from './helpers/pmx-write';
import { BundledAssets } from '../electron/actions/bundled-assets';
import { relocateBundledModel } from '../electron/cards/bundled-character-models';
import { AssetRegistry } from '../electron/foundation/assets';
import { SettingsStore } from '../electron/settings/settings';
import { realpath } from 'node:fs/promises';

const GENE_REVISION = 'c7eace43dffaccff6ad0597433ef85fa57c91e03';
const geneIn = (bundled: string) => path.join(bundled, 'mmdagent-ex', 'gene', GENE_REVISION, 'model', 'gene.pmx');
/** The packaged build's shape: the bundled folder inside app.asar of a versioned build folder (about 257 characters on the owner's machine). */
const packagedBundled = (root: string, build: string) => path.join(root, 'release', 'development', build.repeat(64).slice(0, 64), 'win-arm64-unpacked', 'resources', 'app.asar', 'assets', 'bundled');

const tinyModel = (name: string) => writePmx({ name, englishName: name, encoding: 0,
  positions: [0, 0, 0], skin: [{ deform: 0, bones: [0], weights: [1] }], bones: [{ name: 'センター', parent: -1, position: [0, 0, 0] }], morphs: [] });
async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-update-model-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function put(file: string, name: string): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, tinyModel(name));
  return file;
}
function draft(name: string): CharacterDraft {
  return { name, description: `${name} 的简介`, personality: `${name} 的性格`, scenario: '', greeting: '', examples: '', systemPrompt: '', mood: defaultCharacterMoodTemplate() };
}
/** A profile like a real one: the preinstalled Gene card (its installation record) plus cards the test adds. */
async function profile(directory: string): Promise<CharacterCardStore> {
  const cards = new CharacterCardStore(directory, 'legacy persona');
  await cards.load({ preinstalledGene: true, freshProfile: true });
  return cards;
}
async function restart(directory: string): Promise<CharacterCardStore> {
  const cards = new CharacterCardStore(directory, 'legacy persona');
  await cards.load({ preinstalledGene: true });
  return cards;
}
const exists = (file: string) => access(file).then(() => true, () => false);

test('a bundled model is known by where it sits in an app\'s bundled folder, not by the install folder', () => {
  const owner = 'C:\\Users\\someone\\soft-hearts';
  for (const [file, key] of [
    [geneIn(packagedBundled(owner, 'a')), 'bundled:gene'],
    [geneIn('C:\\soft-hearts\\assets\\bundled'), 'bundled:gene'],
    ['D:/soft-hearts-0.1.0/assets/bundled/mmdagent-ex/gene/0123456789abcdef0123456789abcdef01234567/model/GENE.PMX', 'bundled:gene'],
    ['C:\\soft-hearts\\assets\\bundled\\one\\one.vrm', 'bundled:one'],
    ['C:\\soft-hearts\\assets\\bundled\\mumi\\model.pmx', 'bundled:mumi'],
  ] as const) {
    assert.equal(bundledModelKeyForInstalledPath(file), key, file);
    assert.equal(canonicalModelReference(file), key);
  }
  // A model the user loaded is not one of them, wherever it sits and whatever it is called.
  for (const file of ['C:\\Models\\Gene copy\\gene.pmx', 'C:\\Models\\mumi\\model.pmx', 'C:\\Models\\one\\one.vrm', 'C:\\x\\assets\\bundled\\other\\model.pmx',
    'C:\\x\\assets\\bundled\\mmdagent-ex\\gene\\not-a-revision\\model\\gene.pmx', 'C:\\x\\assets\\bundled\\one\\one.vrm.bak']) {
    assert.equal(bundledModelKeyForInstalledPath(file), null, file);
    assert.equal(canonicalModelReference(file), file);
  }
  assert.equal(canonicalModelReference(BUNDLED_CHARACTER_MODEL), BUNDLED_CHARACTER_MODEL);
  assert.equal(canonicalModelReference(undefined), undefined);
  // The host's reference for a registered path: this install's copy and an old install's copy give the same key.
  const now = packagedBundled(owner, 'b'), before = packagedBundled(owner, 'a');
  assert.equal(bundledReferenceForPath(now, path.join(before, 'one', 'one.vrm')), 'bundled:one');
  assert.equal(bundledReferenceForPath(now, geneIn(before)), 'bundled:gene');
  assert.equal(bundledReferenceForPath(now, 'C:\\Models\\Alice\\alice.pmx'), 'C:\\Models\\Alice\\alice.pmx');
});

test('the startup decision with the stored shapes: an old install\'s copy of a bundled model never splits her card', () => {
  const old = 'C:\\soft-hearts\\assets\\bundled';
  const cards = [
    { id: 'gene', name: 'Gene', modelPath: BUNDLED_CHARACTER_MODEL }, // the preinstalled Gene (its installation record)
    { id: 'mine', name: 'Mine', modelPath: BUNDLED_CHARACTER_MODEL }, // a card the user made on the bundled Gene
    { id: 'one', name: 'One', modelPath: 'bundled:one' }, { id: 'mumi', name: 'Mumi', modelPath: 'bundled:mumi' },
    { id: 'stray', name: 'ジェネ / Gene', modelPath: geneIn(packagedBundled('C:\\u', 'c')) }, // the blank card an earlier update made
    { id: 'alice', name: 'Alice', modelPath: 'C:\\Models\\Alice\\alice.pmx' },
  ];
  for (const [active, stage] of [['gene', geneIn(old)], ['mine', geneIn(old)], ['one', path.join(old, 'one', 'one.vrm')], ['mumi', path.join(old, 'mumi', 'model.pmx')],
    ['stray', BUNDLED_CHARACTER_MODEL], ['stray', geneIn(old)]] as const) {
    const card = cards.find(value => value.id === active)!;
    assert.equal(startupNeedsModelSplit(card, 'gene', stage), false, `${active} on ${stage}`);
    assert.deepEqual(decideCharacterForModel({ cards, activeId: active, presetGeneId: 'gene', reference: stage, names: ['x'], newName: 'x' }), { kind: 'keep', id: active });
  }
  // The stray card stays the card of the bundled Gene; a user's own model at a changed path is still another model (as before).
  assert.equal(effectiveCardModel(cards[4], 'gene'), BUNDLED_CHARACTER_MODEL);
  assert.ok(sameModelReference(cards[4].modelPath, geneIn(old)));
  assert.equal(startupNeedsModelSplit(cards[5], 'gene', 'D:\\Moved\\Alice\\alice.pmx'), true);
  assert.deepEqual(decideCharacterForModel({ cards, activeId: 'alice', presetGeneId: 'gene', reference: 'D:\\Moved\\Alice\\alice.pmx', names: ['Alice'], newName: 'Alice 2' }),
    { kind: 'create', name: 'Alice 2' });
});

test('end to end: the same profile started from a second install folder keeps every card and the current one', async () => {
  await withDirectory(async root => {
    // Two installs side by side; the settings still point the stage at the first one's files.
    const before = packagedBundled(root, 'a'), now = packagedBundled(root, 'b');
    const factoryNow = await put(geneIn(now), 'ジェネ / Gene');
    const stages = { gene: await put(geneIn(before), 'ジェネ / Gene'), one: await put(path.join(before, 'one', 'one.vrm'), 'One'),
      mumi: await put(path.join(before, 'mumi', 'model.pmx'), 'Mumi') };
    const identity = (file: string) => stageModelIdentity(file, { directory: now, factoryPath: factoryNow });
    for (const shape of ['preinstalled Gene', 'own card on the bundled Gene', 'One', 'Mumi', 'blank card from an earlier update'] as const) {
      const directory = path.join(root, 'profile-' + shape.replace(/\W+/gu, '-'));
      await mkdir(directory);
      const cards = await profile(directory);
      let stage = stages.gene;
      if (shape !== 'preinstalled Gene') {
        const saved = await cards.save(draft(shape === 'One' ? 'One' : shape === 'Mumi' ? 'Mumi' : 'Mine'));
        const id = saved.cards.find(card => card.name !== 'Gene')!.id;
        const link = shape === 'One' ? 'bundled:one' : shape === 'Mumi' ? 'bundled:mumi' : shape === 'blank card from an earlier update' ? geneIn(packagedBundled(root, 'c')) : BUNDLED_CHARACTER_MODEL;
        await cards.bindModel(id, link, 'x');
        await cards.activate(id);
        if (shape === 'One') stage = stages.one;
        if (shape === 'Mumi') stage = stages.mumi;
      }
      const original = await readFile(path.join(directory, 'characters.json'), 'utf8');
      const restarted = await restart(directory);
      const seen = await identity(stage);
      assert.ok(seen.reference.startsWith('bundled:'), `${shape}: the old install's copy is the bundled model (${seen.reference})`);
      assert.equal(await planStartupSplit(restarted, seen), null, shape);
      assert.equal(await splitCardFromModelAtStartup(restarted, seen, directory), null, shape);
      assert.equal(await readFile(path.join(directory, 'characters.json'), 'utf8'), original, `${shape}: characters.json untouched`);
      assert.equal(await exists(path.join(directory, MODEL_SPLIT_BACKUP)), false, `${shape}: nothing to back up`);
      // And with this install's own copy on stage, as after a fresh start.
      assert.equal(await planStartupSplit(restarted, await identity(shape === 'One' || shape === 'Mumi' ? path.join(now, shape.toLowerCase() === 'one' ? 'one/one.vrm' : 'mumi/model.pmx') : factoryNow)), null, `${shape} on this install's copy`);
    }
  });
});

test('end to end: a user\'s own model at a changed path still gets its own card, as before', async () => {
  await withDirectory(async root => {
    const directory = path.join(root, 'profile');
    await mkdir(directory);
    const now = path.join(root, 'install-b', 'assets', 'bundled');
    const factoryNow = await put(geneIn(now), 'ジェネ / Gene');
    const first = await put(path.join(root, 'old-models', 'Alice', 'alice.pmx'), 'Alice');
    const moved = await put(path.join(root, 'new-models', 'Alice', 'alice.pmx'), 'Alice');
    const cards = await profile(directory);
    const saved = await cards.save(draft('Alice'));
    const id = saved.cards.find(card => card.name === 'Alice')!.id;
    await cards.bindModel(id, first, 'alice.pmx');
    await cards.activate(id);
    const restarted = await restart(directory);
    const split = await splitCardFromModelAtStartup(restarted, await stageModelIdentity(moved, { directory: now, factoryPath: factoryNow }), directory);
    assert.equal(split?.result.kind, 'create');
    assert.equal(restarted.getActive().name, 'Alice 2');
    assert.equal(await exists(path.join(directory, MODEL_SPLIT_BACKUP)), true, 'the startup backup rule stays');
  });
});

// The old folder deleted after the update (START-HERE step 7 offers it): the saved stage model cannot be read at the real startup read.
const secret = { isEncryptionAvailable: () => false, encryptString: (text: string) => Buffer.from(text), decryptString: (bytes: Buffer) => bytes.toString() };
const thisInstall = path.resolve('assets/bundled'); // the repository's own reviewed bundled files stand in for this install's copy
/** The startup read as electron/main.ts runs it: the bundled assets' start sets the hook (electron/wiring/actions-wiring.ts), then load(). */
async function startupRead(directory: string, hook = true): Promise<{ store: SettingsStore; bundled: BundledAssets }> {
  const assets = new AssetRegistry(), store = new SettingsStore(directory, secret, assets), bundled = new BundledAssets(thisInstall, assets);
  if (hook) store.relocateUnreadableModel = stored => relocateBundledModel(stored, { directory: thisInstall, registry: assets, geneModel: () => bundled.getModel() });
  await store.load();
  return { store, bundled };
}
async function savedModel(directory: string, file: string): Promise<string> {
  const text = JSON.stringify({ model: { path: file, name: path.basename(file), url: 'mmd-asset://old/x' } });
  await writeFile(path.join(directory, 'settings.json'), text);
  return text;
}

test('old install folder deleted: the saved preinstalled model comes back as this install\'s copy; anything else stays as before', async () => {
  await withDirectory(async root => {
    const gone = packagedBundled(root, 'a'); // never created: the old folder was deleted
    for (const [file, own] of [[geneIn(gone), path.join(thisInstall, 'mmdagent-ex', 'gene', GENE_REVISION, 'model', 'gene.pmx')],
      [path.join(gone, 'one', 'one.vrm'), path.join(thisInstall, 'one', 'one.vrm')], [path.join(gone, 'mumi', 'model.pmx'), path.join(thisInstall, 'mumi', 'model.pmx')]] as const) {
      const directory = await mkdtemp(path.join(root, 'p-'));
      await savedModel(directory, file);
      const { store } = await startupRead(directory);
      assert.equal(store.current.model?.path, await realpath(own), `${file} -> this install's copy`);
      // The read itself does not move the saved path (the memory pin's own one-time write-back keeps it as it was).
      assert.equal(JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8')).model.path, file, 'the saved model path is not rewritten by the read');
      // Without the hook (as before): the stage is empty.
      assert.equal((await startupRead(directory, false)).store.current.model, null);
    }
    // A readable old path keeps today's behaviour: the old folder's file stays on stage.
    const kept = await put(geneIn(packagedBundled(root, 'k')), 'ジェネ / Gene');
    const keptProfile = await mkdtemp(path.join(root, 'p-'));
    await savedModel(keptProfile, kept);
    assert.equal((await startupRead(keptProfile)).store.current.model?.path, await realpath(kept));
    // A user's own model that is gone is not guessed.
    const own = await mkdtemp(path.join(root, 'p-'));
    await savedModel(own, path.join(root, 'gone-models', 'Alice', 'alice.pmx'));
    assert.equal((await startupRead(own)).store.current.model, null);
  });
});

test('old install folder deleted, end to end: the preinstalled Gene is back on stage and her card stays current, nothing written', async () => {
  await withDirectory(async root => {
    const directory = path.join(root, 'profile');
    await mkdir(directory);
    const cards = await profile(directory);
    const original = await readFile(path.join(directory, 'characters.json'), 'utf8');
    await savedModel(directory, geneIn(packagedBundled(root, 'a')));
    const { store, bundled } = await startupRead(directory);
    assert.ok(store.current.model, 'she has a model on stage');
    const restarted = await restart(directory);
    const factory = await bundled.getModel();
    const seen = await stageModelIdentity(store.current.model!.path, { directory: thisInstall, factoryPath: factory.path });
    assert.equal(seen.reference, BUNDLED_CHARACTER_MODEL);
    assert.equal(await splitCardFromModelAtStartup(restarted, seen, directory), null);
    assert.equal(restarted.getActive().id, cards.getActive().id);
    assert.equal(await readFile(path.join(directory, 'characters.json'), 'utf8'), original);
    assert.equal(await exists(path.join(directory, MODEL_SPLIT_BACKUP)), false);
  });
});
