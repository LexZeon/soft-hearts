// I-071 v2 step 1 (docs/claude/2026-11-11-i071-v2-plan.md): a card speaks one language. Synthetic cards and temp folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CharacterCardStore, parseCharacterCardText } from '../electron/cards/character-cards';
import {
  CHARACTER_CARD_FORMAT, ENGLISH_PERSONA_WORDING, cardLanguageOf, compileCharacterPersona, defaultCharacterMoodTemplate,
  validateCharacterDraft, type CharacterDraft,
} from '../shared/cards/character-cards';
import { planCharacterCardUpdate, cardUpdateSummaryLines } from '../shared/cards/character-card-update';
import { defaultCharacterResponseProfile } from '../shared/cards/character-response';
import { lintCharacterCard } from '../shared/cards/character-card-lint';
import { setUiLanguage } from '../shared/foundation/ui-language';
import { exportCharacterWithResponse, parseCharacterResponseImport } from '../shared/cards/character-response-portable';
import { speakersFromPersona } from '../electron/brain/reply-draft-guard';
import { GENE_ENGLISH_PRESET, GENE_PRESET, inspectGeneProfile, preinstalledGeneDraft, preinstalledGeneEnglishDraft } from '../electron/cards/gene-preinstalled-card';

const zh = { name: '小满', description: '住在桌面上的伙伴。', personality: '温和，爱笑。', scenario: '刚认识。', greeting: '你好呀。', examples: '用户：累了\n小满：先歇一会儿。', systemPrompt: '你就是小满。' };
const enText = { name: 'Xiaoman', description: 'A companion on the desktop.', personality: 'Gentle, smiles easily.', scenario: 'Just met.', greeting: 'Hi there.', examples: 'User: tired\nXiaoman: Rest a while.', systemPrompt: 'You are Xiaoman.' };
const englishCard = (): CharacterDraft => validateCharacterDraft({ ...enText, mood: defaultCharacterMoodTemplate(), language: 'en' });
async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-i071-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}

test('language field: zh-CN or en, nothing else; a card without one reads as zh-CN', () => {
  assert.equal(cardLanguageOf(undefined), 'zh-CN');
  assert.equal(cardLanguageOf(validateCharacterDraft(zh)), 'zh-CN');
  assert.equal(validateCharacterDraft(zh).language, undefined, 'an older card is left exactly as it was (no field added)');
  assert.equal(cardLanguageOf(englishCard()), 'en');
  assert.equal(validateCharacterDraft({ ...zh, language: 'zh-CN' }).language, 'zh-CN');
  assert.throws(() => validateCharacterDraft({ ...zh, language: 'fr' }));
  assert.throws(() => validateCharacterDraft({ ...zh, language: 3 }));
  // The removed one-card-two-languages variant is not accepted any more.
  assert.throws(() => validateCharacterDraft({ ...zh, languages: { en: { name: 'x' } } }));
});

test('persona: a Chinese card is byte-identical to main; an English card has English headings and the English variety rule', () => {
  const plain = validateCharacterDraft({ ...zh, understandingNotes: '头衔是职务。' });
  const pinned = ['你就是小满。', '角色名称：小满', '角色描述：\n住在桌面上的伙伴。', '理解说明（和用户确认过的理解；卡里的头衔、组织和专有名词按这里理解）：\n头衔是职务。',
    '性格：\n温和，爱笑。', '情境：\n刚认识。', '对话示例（这是她说话的味道：照着这个味道说自己的话，不要原样照抄）：\n用户：累了\n小满：先歇一会儿。',
    '表达变化：回复别总以省略号“……”开头，偶尔用一次可以；性格和口气照旧，只是开头和句子每次自己换着说。'].join('\n\n');
  assert.equal(compileCharacterPersona(plain), pinned, 'pinned: the exact Chinese persona');
  assert.equal(compileCharacterPersona({ ...plain, language: 'zh-CN' }), pinned, 'an explicit zh-CN is the same text');
  const gene = createHash('sha256').update(compileCharacterPersona(preinstalledGeneDraft())).digest('hex');
  // I-172: pinned again for the courier-intern Gene (the approved trial card); the compiler itself is unchanged.
  assert.equal(gene, '867af1ab9557fc0be42fc3177b69e74712126500040dc6e5973cea5721dbed83', 'Chinese Gene persona is the bytes the compiler produces for the shipped card');

  const english = compileCharacterPersona(englishCard());
  assert.match(english, /^You are Xiaoman\.\n\nName: Xiaoman\n\nDescription:\nA companion on the desktop\./);
  assert.match(english, /Personality:\nGentle, smiles easily\./);
  assert.ok(english.includes('Scenario:\nJust met.'));
  assert.ok(english.includes(ENGLISH_PERSONA_WORDING.examplesWithWording) && english.endsWith(ENGLISH_PERSONA_WORDING.openingVariety));
  assert.ok(!/角色名称|性格：|情境：|对话示例|表达变化|理解说明/.test(english));
  assert.match(compileCharacterPersona({ ...englishCard(), understandingNotes: 'Titles are jobs.' }), /Understanding notes \(confirmed with the user;/);
});

test('speakers: an English persona still gives the draft guard her name, with and without a trailing "(English)"', () => {
  assert.deepEqual(speakersFromPersona(compileCharacterPersona(validateCharacterDraft(zh))), ['小满'], 'Chinese as before');
  assert.deepEqual(speakersFromPersona(compileCharacterPersona(englishCard())), ['Xiaoman']);
  assert.deepEqual(speakersFromPersona(compileCharacterPersona(preinstalledGeneEnglishDraft())), ['Gene (English)', 'Gene']);
});

test('the two preinstalled Genes: separate keys, files and cards; English Gene is English all through', () => {
  assert.notEqual(GENE_PRESET.key, GENE_ENGLISH_PRESET.key);
  assert.notEqual(GENE_PRESET.file, GENE_ENGLISH_PRESET.file);
  const english = preinstalledGeneEnglishDraft();
  assert.equal(cardLanguageOf(english), 'en');
  assert.equal(cardLanguageOf(preinstalledGeneDraft()), 'zh-CN');
  assert.equal(english.name, 'Gene (English)');
  for (const key of ['description', 'personality', 'scenario', 'greeting', 'examples', 'systemPrompt'] as const) assert.ok(!/[一-鿿]/.test(english[key]), `${key} has no Chinese`);
  assert.match(english.systemPrompt, /Speak English, short and concrete/); // I-172 wording
  assert.ok(compileCharacterPersona(english).length < 12000);
  assert.deepEqual(english.mood, preinstalledGeneDraft().mood, 'the same baseline mood template');
  assert.ok(!JSON.stringify(english).includes('fishVoiceId'), 'no binding-style voice key ships in the preset (the card voice is the public Drama 3 reference id the user chose, I-172)');
});

test('import / export / duplicate carry the language; version 1 and Tavern files are Chinese; the old variant is refused', async () => {
  const card = englishCard();
  const file = JSON.stringify({ format: CHARACTER_CARD_FORMAT, version: 2, card });
  assert.equal(parseCharacterCardText(file).draft.language, 'en');
  const v1 = JSON.stringify({ format: CHARACTER_CARD_FORMAT, version: 1, card: { ...zh } });
  assert.equal(cardLanguageOf(parseCharacterCardText(v1).draft), 'zh-CN');
  assert.throws(() => parseCharacterCardText(JSON.stringify({ format: CHARACTER_CARD_FORMAT, version: 1, card: { ...zh, language: 'en' } })), /未知字段/);
  assert.equal(cardLanguageOf(parseCharacterCardText(JSON.stringify({ name: 'T', personality: 'p' })).draft), 'zh-CN');
  assert.throws(() => parseCharacterCardText(JSON.stringify({ format: CHARACTER_CARD_FORMAT, version: 2, card: { ...zh, mood: defaultCharacterMoodTemplate(), languages: { en: {} } } })));
  await withDirectory(async directory => {
    const store = new CharacterCardStore(directory, 'legacy');
    await store.load();
    const saved = (await store.import(file)).cards.find(item => item.name === 'Xiaoman')!;
    assert.equal(saved.language, 'en');
    const exported = store.export(saved.id);
    assert.equal(JSON.parse(exported).card.language, 'en');
    assert.ok(!/modelPath|apiKey|"id"/.test(exported));
    const { id: _id, modelName: _model, ...draft } = saved as typeof saved & { modelName?: string };
    const copied = (await store.save({ ...draft, name: 'Xiaoman 2' } as CharacterDraft)).cards.find(item => item.name === 'Xiaoman 2')!;
    assert.equal(copied.language, 'en');
    assert.notEqual(copied.id, saved.id, 'a copy is another character with its own memory');
    const v3 = JSON.stringify({ format: CHARACTER_CARD_FORMAT, version: 3, card: { ...card, responseProfile: defaultCharacterResponseProfile() } });
    assert.equal(parseCharacterCardText(parseCharacterResponseImport(v3).baseText).draft.language, 'en');
    assert.equal(JSON.parse(exportCharacterWithResponse(exported, defaultCharacterResponseProfile())).card.language, 'en');
    // A Chinese card exports exactly as before: no language field.
    const chinese = (await store.save(validateCharacterDraft({ ...zh, mood: defaultCharacterMoodTemplate() }))).cards.find(item => item.name === '小满')!;
    assert.equal(Object.hasOwn(JSON.parse(store.export(chinese.id)).card, 'language'), false);
  });
});

test('a stored cards file without the field loads as zh-CN and is not rewritten by loading', async () => {
  await withDirectory(async directory => {
    const first = new CharacterCardStore(directory, 'legacy');
    const state = await first.load();
    const before = await readFile(path.join(directory, 'characters.json'), 'utf8');
    assert.ok(!before.includes('"language"'));
    assert.equal(cardLanguageOf(state.cards[0]), 'zh-CN');
    const again = await new CharacterCardStore(directory, 'legacy').load();
    assert.equal(cardLanguageOf(again.cards[0]), 'zh-CN');
    assert.equal(await readFile(path.join(directory, 'characters.json'), 'utf8'), before);
  });
});

test('in-place update: the id stays, the language is set from the file, kept when the file has none', async () => {
  await withDirectory(async directory => {
    const store = new CharacterCardStore(directory, 'legacy');
    await store.load();
    const first = await store.save(validateCharacterDraft({ ...zh, mood: defaultCharacterMoodTemplate() }));
    const id = first.cards.find(item => item.name === '小满')!.id;
    const current = first.cards.find(item => item.id === id)!;
    const toEnglish = planCharacterCardUpdate(current, defaultCharacterResponseProfile(), { format: 'soft-hearts-v2', response: null, draft: englishCard() });
    assert.equal(toEnglish.summary.language, 'replaced');
    assert.equal(toEnglish.summary.unchanged, false);
    assert.ok(cardUpdateSummaryLines(toEnglish.summary, text => text).some(line => line.text.startsWith('语言：换成')));
    const updated = await store.updateInPlace(id, toEnglish.draft, { expected: store.cardFingerprint(id), backup: async () => {} });
    const after = updated.state.cards.find(item => item.id === id)!;
    assert.equal(after.id, id);
    assert.equal(after.language, 'en');
    // A file without a language keeps hers; the same file naming zh-CN switches her back.
    const withoutField = planCharacterCardUpdate(after, defaultCharacterResponseProfile(), { format: 'soft-hearts-v2', response: null, draft: validateCharacterDraft({ ...enText, mood: defaultCharacterMoodTemplate() }) });
    assert.equal(withoutField.summary.language, 'kept');
    assert.equal(withoutField.draft.language, 'en');
    assert.equal(withoutField.summary.unchanged, true);
    const same = planCharacterCardUpdate(after, defaultCharacterResponseProfile(), { format: 'soft-hearts-v2', response: null, draft: englishCard() });
    assert.equal(same.summary.language, 'same');
    const back = planCharacterCardUpdate(after, defaultCharacterResponseProfile(), { format: 'soft-hearts-v2', response: null, draft: validateCharacterDraft({ ...enText, language: 'zh-CN', mood: defaultCharacterMoodTemplate() }) });
    assert.equal(back.summary.language, 'replaced');
    assert.equal(back.draft.language, 'zh-CN');
  });
});

test('import lint: the English role-play openers are caught like the Chinese ones', () => {
  setUiLanguage('zh-CN');
  assert.deepEqual(lintCharacterCard(englishCard()), []);
  assert.equal(lintCharacterCard({ ...enText, systemPrompt: 'Act as Xiaoman, a cheerful girl.' }).length, 1);
  assert.equal(lintCharacterCard({ ...enText, systemPrompt: 'You are an AI that plays Xiaoman.' }).length, 1);
  assert.deepEqual(lintCharacterCard({ ...enText, systemPrompt: 'You are Gene in soft hearts.' }), []);
  assert.equal(lintCharacterCard({ ...zh, systemPrompt: '扮演小满' }).length, 1, 'Chinese opener still caught');
});

test('fresh profile: Chinese interface starts with Chinese Gene, English interface with English Gene; both are there, with different ids', async () => {
  for (const ui of ['zh-CN', 'en'] as const) await withDirectory(async directory => {
    const profile = await inspectGeneProfile(directory);
    assert.equal(profile.fresh, true);
    const store = new CharacterCardStore(directory, 'legacy');
    const state = await store.load({ preinstalledGene: true, freshProfile: true, uiLanguage: ui });
    assert.equal(state.cards.length, 6, "0.2.0: both Genes plus One and Mumi in both languages (tests/preinstalled-six-characters.test.ts)");
    const chinese = state.cards.find(card => card.name === 'Gene')!, english = state.cards.find(card => card.name === 'Gene (English)')!;
    assert.notEqual(chinese.id, english.id, 'own id, so its own memory scope');
    assert.equal(cardLanguageOf(chinese), 'zh-CN');
    assert.equal(cardLanguageOf(english), 'en');
    assert.equal(state.activeId, ui === 'en' ? english.id : chinese.id);
    for (const preset of [GENE_PRESET, GENE_ENGLISH_PRESET]) assert.equal(JSON.parse(await readFile(path.join(directory, preset.file), 'utf8')).status, 'installed');
    // The first-model setup is still offered, once, for whichever Gene is the default.
    assert.equal(await store.needsInitialGeneModel(false), true);
    await store.completeInitialGeneModel();
    assert.equal(await store.needsInitialGeneModel(false), false);
    // A second start changes nothing: no third card, same active card.
    const again = await new CharacterCardStore(directory, 'legacy').load({ preinstalledGene: true, freshProfile: false, uiLanguage: ui });
    assert.deepEqual(again.cards.map(card => card.id).sort(), state.cards.map(card => card.id).sort());
    assert.equal(again.activeId, state.activeId);
  });
});

test("existing profiles never get English Gene or a switched active card; no uiLanguage means today's single Gene", async () => {
  await withDirectory(async directory => {
    const store = new CharacterCardStore(directory, 'legacy');
    const own = (await store.load()).cards[0];
    await writeFile(path.join(directory, 'settings.json'), '{}'); // not a fresh profile
    const state = await new CharacterCardStore(directory, 'legacy').load({ preinstalledGene: true, freshProfile: false, uiLanguage: 'en' });
    assert.equal(state.activeId, own.id, 'her active card stays');
    assert.ok(!state.cards.some(card => card.name === 'Gene (English)'));
  });
  await withDirectory(async directory => {
    const state = await new CharacterCardStore(directory, 'legacy').load({ preinstalledGene: true, freshProfile: true });
    assert.deepEqual(state.cards.map(card => card.name), ['Gene']);
  });
});
