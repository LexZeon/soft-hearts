// I-219: the first-install language hint and the language tag on card names. Synthetic folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyFirstLanguageHint, firstLanguageHintFile, parseFirstLanguageHint, takeFirstLanguageHint } from '../electron/settings/first-language-hint';
import { UiLanguageStore } from '../electron/settings/ui-language';
import { CharacterCardStore } from '../electron/cards/character-cards';
import { inspectGeneProfile } from '../electron/cards/gene-preinstalled-card';
import { resolveUiLanguage } from '../shared/foundation/ui-language';
import { baseCardName, cardDisplayNames, cardsMixLanguages, displayCardName, hasLanguageTag } from '../shared/cards';
import { openingLayerOne } from '../shared/foundation/i139-texts';
import { CompanyChoice } from '../shared/unbound/company';
import { companyPorts } from '../electron/unbound/company/ports';

async function withFolders(run: (app: string, profile: string, hint: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soft-i219-'));
  try {
    const app = path.join(root, 'app'), profile = path.join(root, 'profile');
    await mkdir(path.join(app, '.local'), { recursive: true }); await mkdir(profile, { recursive: true });
    await run(app, profile, path.join(app, '.local', 'first-language.txt'));
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}
const exists = (file: string) => stat(file).then(() => true, () => false);

test('hint text: only a language the app has; a word, a sentence or nothing is ignored', () => {
  assert.equal(parseFirstLanguageHint('en'), 'en');
  assert.equal(parseFirstLanguageHint('zh-CN\n'), 'zh-CN');
  assert.equal(parseFirstLanguageHint('﻿zh'), 'zh-CN');
  assert.equal(parseFirstLanguageHint('en-US'), 'en');
  for (const bad of ['', '  ', 'English', 'fr', 'xx', 'en; rm -rf', '中文', '{"language":"en"}']) assert.equal(parseFirstLanguageHint(bad), null, JSON.stringify(bad));
});

test('a fresh profile: the hint becomes the saved preference, the file is used up, the next start just follows the setting', async () => {
  await withFolders(async (app, profile, hint) => {
    await writeFile(hint, 'en');
    const store = new UiLanguageStore(path.join(profile, 'ui-language-settings.json'), 'zh-CN');
    await applyFirstLanguageHint(app, profile, store);
    assert.deepEqual(await store.load(), { preference: 'en', language: 'en' }, 'a Chinese system, but the user chose English');
    assert.equal(await exists(hint), false, 'consumed');
    assert.deepEqual(JSON.parse(await readFile(path.join(profile, 'ui-language-settings.json'), 'utf8')), { version: 1, preference: 'en' });
    // Second launch: a hint file that shows up again is not read (a language is saved now), and it is removed anyway.
    await writeFile(hint, 'zh-CN');
    const second = new UiLanguageStore(path.join(profile, 'ui-language-settings.json'), 'zh-CN');
    await applyFirstLanguageHint(app, profile, second);
    assert.equal((await second.load()).preference, 'en');
    assert.equal(await exists(hint), false);
  });
});

test('a saved choice is never overridden; a profile that already has settings is not fresh; the hint is consumed either way', async () => {
  await withFolders(async (app, profile, hint) => {
    const file = path.join(profile, 'ui-language-settings.json');
    await writeFile(file, JSON.stringify({ version: 1, preference: 'zh-CN' }));
    await writeFile(hint, 'en');
    const store = new UiLanguageStore(file, 'en-US');
    await applyFirstLanguageHint(app, profile, store);
    assert.equal((await store.load()).preference, 'zh-CN', 'her saved choice wins');
    assert.equal(await exists(hint), false);
  });
  await withFolders(async (app, profile, hint) => {
    await writeFile(path.join(profile, 'settings.json'), '{}'); // an older profile that never saved a language
    await writeFile(hint, 'en');
    const store = new UiLanguageStore(path.join(profile, 'ui-language-settings.json'), 'zh-CN');
    await applyFirstLanguageHint(app, profile, store);
    assert.deepEqual(await store.load(), { preference: 'system', language: 'zh-CN' });
    assert.equal(await exists(path.join(profile, 'ui-language-settings.json')), false);
    assert.equal(await exists(hint), false);
  });
});

test('a bad hint falls back to following the system, and no hint changes nothing', async () => {
  await withFolders(async (app, profile, hint) => {
    await writeFile(hint, 'klingon');
    const store = new UiLanguageStore(path.join(profile, 'ui-language-settings.json'), 'en-US');
    await applyFirstLanguageHint(app, profile, store);
    assert.deepEqual(await store.load(), { preference: 'system', language: 'en' });
    assert.equal(await exists(path.join(profile, 'ui-language-settings.json')), false, 'nothing saved');
    await applyFirstLanguageHint(app, profile, store); // no file at all
    assert.equal(await takeFirstLanguageHint({ hintFile: hint, uiLanguageFile: 'x', settingsFile: 'y' }), null);
  });
});

test('English first launch: the hint makes the interface English and Gene (English) the default, her card speaks English', async () => {
  await withFolders(async (app, profile, hint) => {
    await writeFile(hint, 'en');
    const language = new UiLanguageStore(path.join(profile, 'ui-language-settings.json'), 'zh-CN');
    const hadSettings = await exists(path.join(profile, 'settings.json'));
    const gene = await inspectGeneProfile(profile);
    await applyFirstLanguageHint(app, profile, language);
    const ui = (await language.load()).language;
    assert.equal(ui, 'en');
    assert.equal(resolveUiLanguage(language.current.preference, 'zh-CN'), 'en');
    const state = await new CharacterCardStore(profile, 'legacy').load({ preinstalledGene: true, freshProfile: !hadSettings && gene.fresh, uiLanguage: ui });
    const active = state.cards.find(card => card.id === state.activeId)!;
    assert.equal(active.name, 'Gene (English)');
    assert.equal(active.language, 'en');
  });
});

test('tag helper: mixed languages tag the untagged ones, one language shows clean names, both interface languages', () => {
  const mixed = [{ id: 'a', name: 'Gene', language: undefined }, { id: 'b', name: 'Gene (English)', language: 'en' }, { id: 'c', name: 'Amy', language: 'en' }, { id: 'd', name: '小满', language: 'zh-CN' }];
  assert.equal(cardsMixLanguages(mixed), true);
  const zh = cardDisplayNames(mixed, 'zh-CN'), en = cardDisplayNames(mixed, 'en');
  assert.deepEqual([...zh.values()], ['Gene（中文）', 'Gene (English)', 'Amy（English）', '小满（中文）']);
  assert.deepEqual([...en.values()], ['Gene (Chinese)', 'Gene (English)', 'Amy (English)', '小满 (Chinese)']);
  const chineseOnly = [{ id: 'a', name: 'Gene' }, { id: 'd', name: '小满', language: 'zh-CN' }];
  assert.equal(cardsMixLanguages(chineseOnly), false);
  assert.deepEqual([...cardDisplayNames(chineseOnly, 'zh-CN').values()], ['Gene', '小满'], 'a Chinese-only user sees clean names');
  assert.deepEqual([...cardDisplayNames([{ id: 'x', name: 'Amy', language: 'en' }], 'en').values()], ['Amy'], 'an English-only list too');
  // Already tagged names (either style, either language word) are left alone; the base name drops the tag only.
  for (const name of ['Gene (English)', 'Gene（中文）', 'Gene (Chinese)', '小满（英文）']) { assert.equal(hasLanguageTag(name), true, name); assert.equal(displayCardName({ name, language: 'en' }, true, 'en'), name); }
  assert.equal(baseCardName('Gene (English)'), 'Gene');
  assert.equal(baseCardName('小满（中文）'), '小满');
  assert.equal(baseCardName('Gene'), 'Gene');
  assert.equal(baseCardName('（中文）'), '（中文）', 'a name that is only a tag is kept');
  assert.equal(hasLanguageTag('Gene Chinese'), false);
});

test('the base name is what the opening layer already strips to (the lead moves openingLayerOne onto this helper)', () => {
  for (const name of ['Gene', 'Gene (English)', 'Gene（中文）', '小满 (Chinese)', 'Amy（英文）']) {
    assert.ok(openingLayerOne(name, 'en').startsWith(`You are ${baseCardName(name)}.`), name);
    assert.ok(!/[（(](?:English|英文|中文|Chinese)[)）]/.test(openingLayerOne(name, 'zh-CN')), name);
  }
});

test('the three-on-stage panel: the label carries the tag, the name she is told stays untagged', async () => {
  const cards = [{ id: 'a', name: 'Gene', modelPath: 'm' }, { id: 'b', name: 'Gene (English)', language: 'en', modelPath: 'm' }, { id: 'c', name: 'Amy', language: 'en' }];
  const ports = companyPorts(() => ({ cards: { modelCards: () => cards, presetGeneId: async () => 'a', publicState: () => ({ activeId: 'a' }) }, models: null }),
    undefined, undefined, list => cardDisplayNames(list, 'zh-CN'));
  const listed = await ports.cards();
  assert.deepEqual(listed.map(card => card.name), ['Gene', 'Gene (English)', 'Amy'], 'name: untagged, as before');
  assert.deepEqual(listed.map(card => card.label), ['Gene（中文）', 'Gene (English)', 'Amy（English）']);
  const look = new CompanyChoice().look('a', listed, true);
  assert.deepEqual(look.entries.map(entry => entry.name), ['Gene', 'Gene (English)', 'Amy']);
  assert.deepEqual(look.entries.map(entry => entry.label), ['Gene（中文）', 'Gene (English)', 'Amy（English）']);
  // One language only: no label at all, the panel falls back to the name.
  const cleanList = await companyPorts(() => ({ cards: { modelCards: () => [{ id: 'x', name: 'Amy', language: 'en' }, { id: 'y', name: 'Bo', language: 'en' }], presetGeneId: async () => null, publicState: () => ({ activeId: 'x' }) }, models: null }),
    undefined, undefined, list => cardDisplayNames(list, 'en')).cards();
  assert.deepEqual(cleanList.map(card => card.label), ['Amy', 'Bo']);
});

test('the hint folder override only works with the smoke profile switch (a stray variable never moves the real hint)', () => {
  const real = path.join('/app', '.local', 'first-language.txt');
  assert.equal(firstLanguageHintFile('/app', {}), real);
  assert.equal(firstLanguageHintFile('/app', { MMD_FIRST_LANGUAGE_HINT_DIR: '/x' }), real);
  assert.equal(firstLanguageHintFile('/app', { MMD_DESK_USER_DATA: '/p' }), real);
  assert.equal(firstLanguageHintFile('/app', { MMD_DESK_USER_DATA: '/p', MMD_FIRST_LANGUAGE_HINT_DIR: '/x' }), path.join('/x', 'first-language.txt'));
});
