// 0.2.0: Gene, One and Mumi, each in Chinese and English, come with the app
// (docs/claude/2026-11-25-six-presets.md). Synthetic temp folders only; the bundled files are the repository's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CharacterCardStore } from '../electron/cards/character-cards';
import { PREINSTALLED_PRESETS, inspectGeneProfile } from '../electron/cards/gene-preinstalled-card';
import { bundledReferenceForPath, resolveBundledCharacterModel } from '../electron/cards/bundled-character-models';
import { BUNDLED_CHARACTER_MODELS, bundledModelName, isBundledModelKey } from '../shared/cards/bundled-characters';
import { sameModelReference } from '../shared/cards/character-model';
import { cardLanguageOf } from '../shared/cards/character-cards';

const FISH = { gene: '395e6370541e49948220a7af1a60bfae', one: '44d485610c1f497c86f3fcdfd52310d7', mumi: '4ed45d53ee9245d9abf20db5221b19b2' };
const WANT = [
  { name: 'Gene', lang: 'zh-CN', voice: FISH.gene, model: 'bundled:gene' },
  { name: 'Gene (English)', lang: 'en', voice: FISH.gene, model: 'bundled:gene' },
  { name: 'One', lang: 'zh-CN', voice: FISH.one, model: 'bundled:one' },
  { name: 'One (English)', lang: 'en', voice: FISH.one, model: 'bundled:one' },
  { name: 'Mumi', lang: 'zh-CN', voice: FISH.mumi, model: 'bundled:mumi' },
  { name: 'Mumi (English)', lang: 'en', voice: FISH.mumi, model: 'bundled:mumi' },
];
async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-six-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}
const stored = async (directory: string) => JSON.parse(await readFile(path.join(directory, 'characters.json'), 'utf8')) as { cards: Array<Record<string, unknown>>; activeId: string };

test('a fresh profile gets all six: own ids, own models, voices from the card, the language pair; the default follows the interface language', async () => {
  for (const ui of ['zh-CN', 'en'] as const) await withDirectory(async directory => {
    assert.equal((await inspectGeneProfile(directory)).fresh, true);
    const state = await new CharacterCardStore(directory, 'legacy').load({ preinstalledGene: true, freshProfile: true, uiLanguage: ui });
    assert.equal(state.cards.length, 6);
    assert.equal(new Set(state.cards.map(card => card.id)).size, 6, 'each its own id');
    const file = await stored(directory);
    for (const want of WANT) {
      const card = state.cards.find(value => value.name === want.name);
      assert.ok(card, want.name);
      assert.equal(cardLanguageOf(card), want.lang, `${want.name} language`);
      assert.equal((card as { voice?: { voiceId?: string } }).voice?.voiceId, want.voice, `${want.name} voice`);
      const record = file.cards.find(value => value.id === card.id)!;
      assert.equal(record.modelPath, want.model, `${want.name} model`);
      assert.equal(record.modelName, bundledModelName(want.model));
    }
    for (const preset of PREINSTALLED_PRESETS) assert.equal(JSON.parse(await readFile(path.join(directory, preset.file), 'utf8')).status, 'installed', preset.key);
    const active = state.cards.find(card => card.id === state.activeId)!;
    assert.equal(active.name, ui === 'en' ? 'Gene (English)' : 'Gene', 'the default still follows the interface language');
    // A second start (the models are valid references on reload) changes nothing.
    const again = await new CharacterCardStore(directory, 'legacy').load({ preinstalledGene: true, freshProfile: false, uiLanguage: ui });
    assert.deepEqual(again.cards.map(card => card.id), state.cards.map(card => card.id));
    assert.equal(again.activeId, state.activeId);
  });
});

test('an existing profile gets no One or Mumi, whatever the interface language', async () => {
  await withDirectory(async directory => {
    const own = (await new CharacterCardStore(directory, 'legacy').load()).cards[0];
    await writeFile(path.join(directory, 'settings.json'), '{}'); // not a fresh profile
    const state = await new CharacterCardStore(directory, 'legacy').load({ preinstalledGene: true, freshProfile: false, uiLanguage: 'en' });
    assert.equal(state.activeId, own.id);
    assert.ok(!state.cards.some(card => /^(One|Mumi)/.test(card.name)), 'no One or Mumi added');
    assert.deepEqual(readdirSync(directory).filter(name => /^(one|mumi)/.test(name)), [], 'no installation record either');
  });
  await withDirectory(async directory => {
    // Their own One and Mumi (a user's development or stable profile) stay exactly as they are.
    const first = await new CharacterCardStore(directory, 'legacy').load({ preinstalledGene: true, freshProfile: true, uiLanguage: 'zh-CN' });
    const before = JSON.stringify(await stored(directory));
    const second = await new CharacterCardStore(directory, 'legacy').load({ preinstalledGene: true, freshProfile: false, uiLanguage: 'zh-CN' });
    assert.equal(JSON.stringify(await stored(directory)), before);
    assert.equal(second.cards.length, first.cards.length);
  });
});

test('the presets carry no local path, no dated user words and none of the private markers', () => {
  const dir = path.resolve('shared/cards/presets');
  const files = ['one-card.json', 'one-english-card.json', 'mumi-card.json', 'mumi-english-card.json', 'gene-balanced-card.json', 'gene-english-card.json'];
  const termsFile = process.env.SOFT_HEARTS_BANNED_TERMS ?? path.resolve('.local', 'release-banned-terms.txt');
  const terms = existsSync(termsFile) ? readFileSync(termsFile, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')) : [];
  for (const file of files) {
    const text = readFileSync(path.join(dir, file), 'utf8');
    assert.doesNotMatch(text, /[A-Za-z]:\\\\|[A-Za-z]:\/|\\\\Users|\/Users\/|"modelPath"|"modelName"|"id"\s*:/, `${file}: a local path, model link or live id`);
    assert.doesNotMatch(text, new RegExp(`20\\d\\d[-年]\\d{1,2}[-月]\\d{1,2}|用户原话|${'One' + 'Drive'}|${'soft-hearts-' + 'private'}|\\.vrm"|\\.pmx"`), `${file}: a dated quote or private location`);
    for (const term of terms) assert.ok(!text.toLowerCase().includes(term.toLowerCase()), `${file} has a banned term`);
  }
});

test('the bundled models are present, match their manifest byte for byte, and carry a licence note', async () => {
  const bundled = path.resolve('assets/bundled');
  assert.deepEqual(BUNDLED_CHARACTER_MODELS.map(model => model.key), ['bundled:one', 'bundled:mumi']);
  for (const model of BUNDLED_CHARACTER_MODELS) {
    assert.ok(model.files.some(file => file.path === model.model), `${model.key}: the model file is listed`);
    for (const file of model.files) {
      const bytes = readFileSync(path.join(bundled, file.path));
      assert.equal(bytes.length, file.bytes, file.path);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.path);
    }
    const note = readFileSync(path.join(bundled, path.dirname(model.model), 'attribution.txt'), 'utf8');
    assert.match(note, /soft hearts project's author/);
  }
  assert.match(readFileSync(path.join(bundled, 'one/attribution.txt'), 'utf8'), /Credit: required/);
  const notices = readFileSync('THIRD_PARTY_NOTICES.md', 'utf8');
  assert.ok(notices.includes('assets/bundled/one/') && notices.includes('assets/bundled/mumi/'), 'the notices name both models');
  // The host check accepts the real files and registers the model file; a damaged byte is refused.
  const registered: string[] = [];
  const registry = { register: async (file: string) => { registered.push(file); return { path: file, name: path.basename(file), url: 'mmd-asset://x/y' }; } };
  for (const model of BUNDLED_CHARACTER_MODELS) assert.equal((await resolveBundledCharacterModel(model.key, bundled, registry as never)).path, path.join(bundled, ...model.model.split('/')));
  await assert.rejects(resolveBundledCharacterModel('bundled:one', path.resolve('tests'), registry as never));
  assert.equal(registered.length, 2);
});

test('bundled keys: a key is its own reference, a path under the resource folder maps back to its key', () => {
  assert.ok(isBundledModelKey('bundled:one') && isBundledModelKey('bundled:mumi') && isBundledModelKey('bundled:gene'));
  assert.ok(!isBundledModelKey('bundled:other') && !isBundledModelKey('C:\\x.pmx'));
  assert.equal(sameModelReference('bundled:one', 'bundled:one'), true);
  assert.equal(sameModelReference('bundled:one', 'bundled:mumi'), false);
  // 2026-11-26 (docs/claude/2026-11-26-update-blank-card.md): a bundled model's own file, in this or any install folder, is its key; a user's file never is.
  assert.equal(sameModelReference('bundled:mumi', path.resolve('assets/bundled/mumi/model.pmx')), true, 'the bundled file is its key');
  assert.equal(sameModelReference('bundled:mumi', 'C:\\Models\\mumi\\model.pmx'), false, 'a key never equals a user\'s path');
  const dir = path.resolve('assets/bundled');
  assert.equal(bundledReferenceForPath(dir, path.join(dir, 'mumi', 'model.pmx')), 'bundled:mumi');
  assert.equal(bundledReferenceForPath(dir, path.join(dir, 'one', 'one.vrm')), 'bundled:one');
  assert.equal(bundledReferenceForPath(dir, path.join(os.tmpdir(), 'mine.pmx')), path.join(os.tmpdir(), 'mine.pmx'));
  assert.equal(bundledReferenceForPath(dir, '/g/gene.pmx', '/g/gene.pmx'), 'bundled:gene');
});
