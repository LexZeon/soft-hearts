// I-071 v2 第三步, fixes after the isolated test with a real character (all data here is synthetic): forms of address and proper
// nouns that live only in the memories get decided and translated one way everywhere; English is not cut by Chinese length caps;
// "允许记录" and its popup lines; the staging folder goes. A fake Claude, real stores.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { UserProfileStore, userProfileScopeId, RECORDING_ON_MARKER } from '../electron/memory/user-profile';
import { MEMORY_NOTES_FILE } from '../electron/memory/memory-notes/store';
import { findAddressForms, findProperNouns } from '../electron/cards/character-convert/addresses';
import { memoryRecallMatch } from '../shared/memory/memory';
import { clip, glossaryDeviations, memoryFieldLimits, readMemoryValue, translateMemories, type MemoryItem } from '../electron/cards/character-convert/translate';
import { resolveConversionNames, resolveConversionAliases, validateConversionRequest } from '../shared/cards/character-convert';
import { ALL_KEPT, FIXTURE_TERMS, fakeEnglish as E, filesOf, makeFixture, makeTranslator, providerScope, withDirectory, type Fixture } from './helpers/convert-fixture';

/** Her two notes mention a pet name ("团团") that is not stored as a nickname anywhere. */
async function addPetName(fixture: Fixture) {
  const file = path.join(fixture.directory, MEMORY_NOTES_FILE);
  const data = JSON.parse(await readFile(file, 'utf8'));
  for (const note of data.notes) note.body.summary = `她叫用户「团团」。${note.body.summary}团团很开心。`;
  await writeFile(file, JSON.stringify(data));
}
const convert = async (fixture: Fixture, names: unknown[]) => {
  await fixture.service.start({ characterId: fixture.sourceId, language: 'en', names });
  await fixture.service.idle();
  return fixture.service.view()!;
};
/** Her recollections as the new card recalls them (what she says she remembers), for both notes. */
const recalled = (fixture: Fixture, id: string) => [E('书店').toLowerCase(), E('面试').toLowerCase()].map(query => fixture.companion.memory.retrieve({ characterId: id, providerScope }, query, {}, Date.now()).map(item => item.excerpt).join(' ')).join(' ');
const TUAN: [string, string][] = [...FIXTURE_TERMS, ['团团', 'Tuan']];

test('addresses: a pet name used often in the notes is found; stored names and one-off words are not', () => {
  const texts = ['她叫用户「团团」。用户很开心。', '她叫用户「团团」，团团笑了。', '她叫用户小雨。', '今天去了书店', '她叫用户起床了'];
  const found = findAddressForms(texts, ['小雨', '阿澄']);
  assert.deepEqual(found.map(item => item.text), ['团团']);
  assert.ok(found[0]!.uses >= 3);
  assert.deepEqual(findAddressForms(['他叫我"Moss"。', 'She calls me "Moss" when it rains.', 'Moss was late'], []).map(item => item.text), ['Moss']);
  assert.deepEqual(findAddressForms(['宝宝今天好吗', '宝宝去吃饭', '宝宝早点睡'], ['宝宝']), []); // already a stored nickname
  assert.deepEqual(findAddressForms(['宝宝今天好吗', '宝宝去吃饭', '宝宝早点睡'], []).map(item => item.text), ['宝宝']);
});

test('proper nouns: bracketed, organization and title words of the card are offered; common words and known names are not', () => {
  const card = ['她是「晨星社」的成员，担任晨星社队长，住在海边。', '晨星社的人都叫她队长。'];
  const found = findProperNouns(card, ['阿澄']).map(item => item.text);
  assert.ok(found.includes('晨星社'), found.join());
  assert.ok(found.includes('晨星社队长'), found.join());
  assert.deepEqual(findProperNouns(['She lives in a small town. The Morning Star Society sent her a letter, and the Morning Star Society is far away.'], []).map(item => item.text), ['Morning Star Society']);
  assert.deepEqual(findProperNouns(card, ['晨星社']).map(item => item.text).filter(text => text.includes('晨星社')), []);
});

test('preview lists the pet name as a name to decide; each one must be decided; the request shape takes alias, term, ignore and unset', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory);
  await addPetName(fixture);
  const preview = await fixture.service.preview(fixture.sourceId);
  assert.deepEqual(preview.names.map(name => [name.id, name.text]), [['her-name', '阿澄'], ['her-nickname', '澄澄'], ['user-nickname', '小雨'], ['alias-1', '团团']]);
  await assert.rejects(fixture.service.start({ characterId: fixture.sourceId, language: 'en', names: ALL_KEPT }), /团团.*还没选/);
  assert.equal(fixture.service.view(), null);
  // unset ("先不带，以后在聊天里起") and ignore are decisions; a name for her own card cannot be empty
  const resolved = resolveConversionNames(preview.names, [ALL_KEPT[0]!, { id: 'her-nickname', to: '' }, { id: 'user-nickname', to: '' }, { id: 'alias-1', to: '', ignore: true }]);
  assert.deepEqual(resolved, { 'her-name': 'Cheng', 'her-nickname': null, 'user-nickname': null });
  assert.deepEqual(resolveConversionAliases(preview.names, [{ id: 'alias-1', to: '', ignore: true }]), []);
  assert.deepEqual(resolveConversionAliases(preview.names, [{ id: 'alias-1', to: '' }]), [{ from: '团团', to: '', refers: 'user' }]); // fix 4: 「她叫用户「团团」」 says whom it names
  assert.throws(() => resolveConversionNames(preview.names, [{ id: 'her-name', to: '' }, ...ALL_KEPT.slice(1), { id: 'alias-1', to: 'x' }]), /1～40/);
  assert.deepEqual(validateConversionRequest({ characterId: 'a', language: 'en', names: [{ id: 'alias-2', to: '', ignore: true }, { id: 'term-1', to: 'Society' }] }).names.length, 2);
  assert.throws(() => validateConversionRequest({ characterId: 'a', language: 'en', names: [{ id: 'her-name', to: 'X', ignore: true }, { id: 'alias-9', to: 'x' }] }), /id 只能是/);
}));

test('a pet name only in the notes: one glossary goes to the persona call and every batch, and the card reads the chosen form everywhere', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory, { model: makeTranslator(TUAN) });
  await addPetName(fixture);
  const done = await convert(fixture, [...ALL_KEPT, { id: 'alias-1', to: 'Tuan' }]);
  assert.equal(done.state, 'done', done.error);
  assert.ok(fixture.model.calls.length >= 2);
  for (const call of fixture.model.calls) assert.match(call.prompt, /"团团" becomes "Tuan" everywhere/);
  const scope = { characterId: done.newCardId!, providerScope };
  const text = recalled(fixture, done.newCardId!);
  assert.match(text, /Tuan/);
  assert.doesNotMatch(text, /团团/);
}));

test('nicknames and forms of address left unset: nothing is invented, the new card has none, and the usual nickname flow works afterwards', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory, { model: makeTranslator([...FIXTURE_TERMS, ['团团', ''], ['澄澄', '']]) });
  await addPetName(fixture);
  const done = await convert(fixture, [ALL_KEPT[0]!, { id: 'her-nickname', to: '' }, { id: 'user-nickname', to: '' }, { id: 'alias-1', to: '' }]);
  assert.equal(done.state, 'done', done.error);
  // fix 4: the names left for later never reach the model at all; the prompt only explains the mark where one was
  for (const call of fixture.model.calls) {
    assert.doesNotMatch(call.prompt, /团团|澄澄|小雨/);
    assert.match(call.prompt, /Some pet names were taken out of the text before you got it/);
  }
  const scope = { characterId: done.newCardId!, providerScope };
  const relationship = await fixture.companion.relationship.snapshot(done.newCardId!);
  assert.equal(relationship.nickname, null);
  assert.equal(relationship.herNickname, null);
  assert.doesNotMatch(recalled(fixture, done.newCardId!), /团团/);
  assert.ok(recalled(fixture, done.newCardId!).includes(E('她叫用户「〔昵称〕」')));
  // later, in the new language: the user says "call me Y" and it is stored on the new card only
  await fixture.companion.relationship.setNickname(done.newCardId!, 'Y');
  assert.equal((await fixture.companion.relationship.snapshot(done.newCardId!)).nickname, 'Y');
  assert.equal((await fixture.companion.relationship.snapshot(fixture.sourceId)).nickname, '小雨');
}));

test('a batch that translates the name another way is asked once more with the glossary stressed', async () => withDirectory(async directory => {
  const model = makeTranslator(TUAN, (value, kind, _key, call) => call === 2 && kind === 'note' ? JSON.parse(JSON.stringify(value).split('Tuan').join('Dumpling')) : value);
  const fixture = await makeFixture(directory, { model });
  await addPetName(fixture);
  const done = await convert(fixture, [...ALL_KEPT, { id: 'alias-1', to: 'Tuan' }]);
  assert.equal(done.state, 'done', done.error);
  assert.equal(fixture.model.calls.length, 3); // persona + batch + the same batch asked again
  assert.match(fixture.model.calls[2]!.prompt, /IMPORTANT: your previous answer did not follow the names above for: "团团" must read "Tuan"/);
  assert.doesNotMatch(recalled(fixture, done.newCardId!), /Dumpling/);
  assert.match(recalled(fixture, done.newCardId!), /Tuan/);
}));

test('a batch that keeps translating the name another way fails safely: nothing is left, the source is untouched', async () => withDirectory(async directory => {
  const model = makeTranslator(TUAN, (value, kind) => kind === 'note' ? JSON.parse(JSON.stringify(value).split('Tuan').join('Dumpling')) : value);
  const fixture = await makeFixture(directory, { model });
  await addPetName(fixture);
  const before = await filesOf(directory);
  const done = await convert(fixture, [...ALL_KEPT, { id: 'alias-1', to: 'Tuan' }]);
  assert.equal(done.state, 'failed');
  assert.match(done.error!, /不一致/);
  const after = await filesOf(directory);
  const outside = (files: Map<string, Buffer>) => [...files.keys()].filter(file => !file.startsWith('character-convert/')).sort();
  assert.deepEqual(outside(after), outside(before));
  for (const file of outside(before)) assert.ok(before.get(file)!.equals(after.get(file)!), `${file} changed`);
  assert.deepEqual([...after.keys()].filter(file => file.startsWith('character-convert/')), []);
}));

test('glossaryDeviations: used form, old form left behind, and unset names', () => {
  const names = { 'her-nickname': { from: '澄澄', to: '' }, aliases: [{ from: '团团', to: 'Tuan' }, { from: '晨星社', to: 'Morning Star Society', kind: 'term' as const }] };
  assert.deepEqual(glossaryDeviations({ s: '团团来了' }, { s: 'Tuan came' }, names), []);
  assert.deepEqual(glossaryDeviations({ s: '团团来了' }, { s: 'Dumpling came' }, names).map(item => item.from), ['团团']);
  assert.deepEqual(glossaryDeviations({ s: '团团来了' }, { s: 'Tuan 团团 came' }, names).map(item => item.from), ['团团']);
  assert.deepEqual(glossaryDeviations({ s: '澄澄好' }, { s: 'Sweetie is fine' }, names), []);
  assert.deepEqual(glossaryDeviations({ s: '澄澄好' }, { s: '澄澄 is fine' }, names).map(item => item.from), ['澄澄']);
  assert.deepEqual(glossaryDeviations({ s: '晨星社来信' }, { s: 'a letter from the Morning Star Order' }, names).map(item => item.from), ['晨星社']);
  assert.deepEqual(glossaryDeviations({ s: '今天下雨' }, { s: 'rain' }, names), []); // a term the source does not use needs nothing
});

test('proper nouns: terms of the card are decided with the names, go into the glossary and read the official form', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory, { description: '她是「晨星社」的成员，担任晨星社队长，住在海边。晨星社的人都叫她队长。', model: makeTranslator([...FIXTURE_TERMS, ['晨星社队长', 'Captain of the Morning Star Society'], ['晨星社', 'Morning Star Society']]) });
  // Fix 3: a pattern match is offered only when her notes name it too (else the assistant proposes it from the persona).
  const notesFile = path.join(directory, MEMORY_NOTES_FILE);
  const notes = JSON.parse(await readFile(notesFile, 'utf8'));
  notes.notes[0].body.things.push('晨星社队长');
  await writeFile(notesFile, JSON.stringify(notes));
  const preview = await fixture.service.preview(fixture.sourceId);
  const terms = preview.names.filter(name => name.id.startsWith('term-'));
  assert.ok(terms.some(term => term.text === '晨星社') && terms.some(term => term.text === '晨星社队长'), JSON.stringify(terms));
  await assert.rejects(fixture.service.start({ characterId: fixture.sourceId, language: 'en', names: ALL_KEPT }), /还没选/);
  const choices = terms.map(term => ({ id: term.id, to: term.text === '晨星社' ? 'Morning Star Society' : term.text === '晨星社队长' ? 'Captain of the Morning Star Society' : '', ...(term.text === '晨星社' || term.text === '晨星社队长' ? {} : { ignore: true }) }));
  const done = await convert(fixture, [...ALL_KEPT, ...choices]);
  assert.equal(done.state, 'done', done.error);
  assert.match(fixture.model.calls[0]!.prompt, /"晨星社" becomes "Morning Star Society"/);
  assert.match(fixture.model.calls[0]!.prompt, /proper noun of her setting/);
  assert.match(fixture.cards.publicState().cards.find(card => card.id === done.newCardId)!.description, /Captain of the Morning Star Society/);
}));

test('caps per language: English gets about 2.5 times the room, within what the stores accept; Chinese keeps its caps', () => {
  const en = memoryFieldLimits('en'), zh = memoryFieldLimits('zh-CN');
  assert.deepEqual([zh.noteTitle, zh.diaryMeme, zh.noteTag], [40, 40, 24]);
  assert.deepEqual([en.noteTitle, en.diaryMeme, en.noteTag, en.notePerson, en.noteThing, en.diaryText, en.profileText], [80, 100, 40, 60, 100, 500, 270]);
  const title = 'The rainy day bookstore that we both really love';
  const note: MemoryItem = { k: 'n0', kind: 'note', v: { title: '下雨天的书店', summary: 's', people: [], things: [], mood: '', plans: [], tags: ['书店'] } };
  const value = { title, summary: 'x', people: [], things: [], mood: '', plans: [], tags: ['bookstore', 'rainy day', 'a very long english tag for a bookstore on a rainy day'] };
  assert.equal((readMemoryValue(note, value, 'en') as { title: string }).title, title);
  assert.equal((readMemoryValue(note, value, 'en') as { tags: string[] }).tags[2], 'a very long english tag for a bookstore…');
  assert.equal((readMemoryValue(note, value, 'zh-CN') as { title: string }).title.endsWith('…'), true);
  const diary: MemoryItem = { k: 'd1', kind: 'diary', v: { text: 't', meme: '布丁' } };
  assert.equal((readMemoryValue(diary, { text: 'x', meme: 'The pudding somebody grabbed right before we could get it' }, 'en') as { meme: string }).meme, 'The pudding somebody grabbed right before we could get it');
});

test('clip never cuts inside a word (a single word longer than the cap is the only exception)', () => {
  assert.equal(clip('alpha beta gamma delta', 13), 'alpha beta…');
  assert.equal(clip('alpha beta gamma delta', 11), 'alpha beta…');
  assert.equal(clip('alpha beta. Gamma delta epsilon', 22), 'alpha beta. Gamma…');
  assert.equal(clip('Supercalifragilistic', 8), 'Superca…');
  assert.equal(clip('short', 10), 'short');
});

test('English titles and in-jokes are kept whole all the way into the stores', async () => withDirectory(async directory => {
  const meme = 'The pudding somebody grabbed right before we could get it'; // 58 characters
  const title = 'The rainy day bookstore that we both really love'; // 48 characters
  const model = makeTranslator(FIXTURE_TERMS, (value, kind, key) => kind === 'diary' && value.meme ? { ...value, meme } : kind === 'note' && key === 'n0' ? { ...value, title } : value);
  const fixture = await makeFixture(directory, { model });
  const done = await convert(fixture, ALL_KEPT);
  assert.equal(done.state, 'done', done.error);
  const scope = { characterId: done.newCardId!, providerScope };
  assert.match(JSON.stringify(fixture.companion.memory.list(scope, { limit: 50 }, 1_900_000_000_000)), new RegExp(title));
  const profiles = new UserProfileStore(path.join(directory, 'user-profiles'));
  await profiles.activate(scope);
  assert.equal(profiles.view().diary.find(entry => entry.meme)?.meme, meme);
  const batch = fixture.model.calls[1]!.prompt;
  assert.match(batch, /note title ≤ 80/);
  assert.match(batch, /meme ≤ 100/);
}));

test('"允许记录": carried when the source had it on (and the popup says so); off stays off and the popup says what that means', async () => withDirectory(async directory => {
  const on = await makeFixture(directory);
  const preview = await on.service.preview(on.sourceId);
  assert.match(preview.settings.carried.join(), /原来开着，新卡也开着/);
  const done = await convert(on, ALL_KEPT);
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.carried?.recording, true);
  const file = (id: string) => path.join(directory, 'user-profiles', `profile-${userProfileScopeId({ characterId: id, providerScope })}.json`);
  const stored = JSON.parse(await readFile(file(done.newCardId!), 'utf8'));
  assert.ok(stored.blocked.includes(RECORDING_ON_MARKER));
  assert.ok(JSON.parse(await readFile(file(on.sourceId), 'utf8')).blocked.includes(RECORDING_ON_MARKER)); // the source is as it was
}));

test('"允许记录" off on the source: the new card keeps it off, and the preview says the carried profile and diary will not be used until it is turned on', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory);
  const scopeId = userProfileScopeId({ characterId: fixture.sourceId, providerScope });
  const file = path.join(directory, 'user-profiles', `profile-${scopeId}.json`);
  const data = JSON.parse(await readFile(file, 'utf8'));
  data.blocked = data.blocked.filter((item: string) => item !== RECORDING_ON_MARKER);
  // Fix 8: the card's own marker decides only when the shared switch was never chosen (the fixture's setEnabled chose it).
  await rm(path.join(directory, 'user-profiles', 'recording.json'));
  await writeFile(file, JSON.stringify(data) + '\n');
  const preview = await fixture.service.preview(fixture.sourceId);
  assert.deepEqual(preview.settings.carried, []);
  assert.match(preview.settings.off.join(), /原来就关着，新卡也关着.*不会被用到/);
  const done = await convert(fixture, ALL_KEPT);
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.carried?.recording, false);
  const stored = JSON.parse(await readFile(path.join(directory, 'user-profiles', `profile-${userProfileScopeId({ characterId: done.newCardId!, providerScope })}.json`), 'utf8'));
  assert.equal(stored.blocked.includes(RECORDING_ON_MARKER), false);
}));

test('the staging folder itself is gone after a conversion', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory);
  assert.equal((await convert(fixture, ALL_KEPT)).state, 'done');
  assert.deepEqual(await readdir(path.join(directory, 'character-convert')), ['backups']);
}));

test('translateMemories: an unset name left in a translation is asked again', async () => {
  const items: MemoryItem[] = [{ k: 'p0', kind: 'profile', v: { text: '团团喜欢钢琴' } }];
  const answers = ['{"items":[{"k":"p0","v":{"text":"团团 likes the piano"}}]}', '{"items":[{"k":"p0","v":{"text":"The user likes the piano"}}]}'];
  const prompts: string[] = [];
  const result = await translateMemories(items, 'zh-CN', 'en', { aliases: [{ from: '团团', to: '' }] }, async prompt => { prompts.push(prompt); return answers.shift()!; }, new AbortController().signal);
  assert.equal((result.get('p0') as { text: string }).text, 'The user likes the piano');
  assert.equal(prompts.length, 2);
  // fix 4: the name never reaches the model (taken out before the call), not even in the retry note
  assert.match(prompts[1]!, /your previous answer wrote a pet name that was taken out of the text/);
  for (const prompt of prompts) assert.doesNotMatch(prompt, /团团/);
});

test('English recall on converted memories: whole-word English tags, and English "that time / how did it go" cues', () => {
  const record = { title: 'Dentist on Friday', tags: ['dentist', 'cat', 'friday'] };
  assert.equal(memoryRecallMatch('I took the cat to the vet', record).score > 0, true);
  assert.equal(memoryRecallMatch('my education was fine', record).score, 0); // "cat" inside "education"
  assert.equal(memoryRecallMatch('two dentists said so', record).score > 0, true); // plural still matches
  assert.equal(memoryRecallMatch('how did the dentist thing go?', record).explicit, true);
  assert.equal(memoryRecallMatch('that time I was at the dentist', record).explicit, true);
  assert.equal(memoryRecallMatch('the weather is nice', record).explicit, false);
  assert.equal(memoryRecallMatch('今天去牙医', { title: '牙医', tags: ['牙医'] }).score > 0, true); // Chinese tags: substring as before
});
