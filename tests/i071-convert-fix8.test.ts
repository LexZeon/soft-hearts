// I-071 v2 第三步, fix 8 (Codex T-240's static review of 076f9c0d): data integrity of the conversion, end to end with real stores and
// a fake Claude. Every name here is synthetic (阿澄 / Cheng from the shared fixture, 澄澄 / Little Orange, other-N voice bindings).
//  1. a rollback that cannot remove a part keeps its marker and says so; a later start finishes it;
//  2. the marker is written before the backup: a backup that fails half way, or a quit during translation, leaves no backup; a failed
//     conversion does not prune older backups;
//  3. the voice binding list never drops another character's binding, and a rollback leaves it exactly as it was;
//  4. a left-out name's other written forms (pinyin, Xiao/Little forms, an English rendering next to it) never reach the model, and the
//     popup names them;
//  5. a field that came back missing or cut, a profile line the profile refuses, and diary days beyond the carried window are listed;
//  8. an English card has no full-width punctuation in any converted text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { userProfileScopeId } from '../electron/memory/user-profile';
import { relationshipFileName } from '../electron/memory/relationship/store';
import { createConversion } from '../electron/cards/character-convert/electron-wiring';
import { createConversionTools } from '../electron/cards/character-convert/tools';
import type { ConversionModel } from '../electron/cards/character-convert/translate';
import type { TtsStyleBinding } from '../shared/foundation/tts-config';
import { ALL_KEPT, DAY, makeFixture, makeTranslator, FIXTURE_TERMS, prefixTranslation, providerScope, withDirectory, type Fixture } from './helpers/convert-fixture';

async function convert(fixture: Fixture, names: unknown = ALL_KEPT) {
  await fixture.service.start({ characterId: fixture.sourceId, language: 'en', names });
  await fixture.service.idle();
  return fixture.service.view()!;
}
/** The app started again on the same folder (the conversion service is new; the stores and wiring are the same). */
function restart(fixture: Fixture) {
  return createConversion({ profileDirectory: fixture.directory, wiring: fixture.wiring, settings: () => structuredClone(fixture.settings.current),
    saveSettings: async next => { fixture.settings.current = structuredClone(next); }, modelChoice: () => ({ model: 'sonnet', effort: 'low' }),
    emit: () => {}, register: () => {}, send: async () => null, uiLanguage: () => 'zh-CN' }, fixture.model.current);
}
const waitFor = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check(), 'timed out'); };
const convertFolder = (fixture: Fixture, ...parts: string[]) => path.join(fixture.directory, 'character-convert', ...parts);
const listOf = (folder: string) => readdir(folder).catch(() => [] as string[]);

// ---- 1. rollback keeps its marker ------------------------------------------------------------------------------------------------------

test('fix 8.1: a part the rollback cannot remove keeps the marker, the message says what is left, and a later start finishes it', async () => withDirectory(async directory => {
  let locked = true, newId = '';
  const fixture = await makeFixture(directory, { wiring: wiring => ({ ...wiring,
    addCard: async id => { newId = id; throw new Error('磁盘写不进去。'); },
    relationship: () => { const real = wiring.relationship(); return { snapshot: id => real.snapshot(id), adopt: (id, data) => real.adopt(id, data),
      forget: async id => { if (locked) throw new Error('文件被占用。'); return real.forget(id); } }; } }) });
  const done = await convert(fixture);
  assert.equal(done.state, 'failed');
  assert.match(done.error!, /磁盘写不进去/, 'the real error is said');
  assert.match(done.error!, /没删掉/);
  assert.match(done.error!, /下次打开/);
  assert.doesNotMatch(done.error!, /已经全部撤回/);
  const relationshipFile = path.join(directory, 'relationship', relationshipFileName(newId));
  await stat(relationshipFile); // really still there
  const staged = await listOf(convertFolder(fixture, 'staging'));
  assert.equal(staged.length, 1, 'the marker stays');
  assert.equal(JSON.parse(await readFile(convertFolder(fixture, 'staging', staged[0]!, 'commit.json'), 'utf8')).newId, newId);
  // The next start, with the lock gone, rolls the rest back and only then removes the marker.
  locked = false;
  assert.equal(await restart(fixture).ensureRecovered(), 1);
  await assert.rejects(stat(relationshipFile));
  assert.deepEqual(await listOf(convertFolder(fixture, 'staging')), []);
}));

test('fix 8.1: a rollback that cannot finish at the next start either keeps the marker for the start after', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory, { wiring: wiring => ({ ...wiring,
    relationship: () => { const real = wiring.relationship(); return { snapshot: id => real.snapshot(id), adopt: (id, data) => real.adopt(id, data), forget: async () => { throw new Error('文件被占用。'); } }; } }) });
  const newId = '00000000-1111-4222-8333-555555555555';
  await fixture.companion.relationship.adopt(newId, { ...(await fixture.companion.relationship.snapshot(fixture.sourceId)), backfilled: [] });
  const staging = convertFolder(fixture, 'staging', 'job-9');
  await mkdir(staging, { recursive: true });
  await writeFile(path.join(staging, 'commit.json'), JSON.stringify({ newId, providerScope }));
  await fixture.service.ensureRecovered();
  await stat(path.join(staging, 'commit.json'));
}));

// ---- 2. no orphan backup -----------------------------------------------------------------------------------------------------------------

test('fix 8.2: a backup that fails half way leaves no partial backup and no folder of its own', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory);
  await stat(path.join(directory, 'characters.json')); // copied first
  await mkdir(path.join(directory, 'settings.json')); // its copy fails after characters.json was copied
  const done = await convert(fixture);
  assert.equal(done.state, 'failed');
  assert.match(done.error!, /备份没能做好/);
  assert.deepEqual(await listOf(convertFolder(fixture)), [], 'nothing of this conversion is left');
}));

test('fix 8.2: the app quitting during translation: the next start removes that conversion\'s backup and marker', async () => withDirectory(async directory => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fixture = await makeFixture(directory, { model: async () => { await gate; throw new Error('stopped'); } });
  await fixture.service.start({ characterId: fixture.sourceId, language: 'en', names: ALL_KEPT });
  await waitFor(() => fixture.model.calls.length > 0);
  assert.equal((await listOf(convertFolder(fixture, 'backups'))).length, 1, 'the backup is made before translating');
  // The app is gone (this service never runs again); the next start recovers.
  await restart(fixture).ensureRecovered();
  assert.deepEqual(await listOf(convertFolder(fixture, 'backups')), []);
  assert.deepEqual(await listOf(convertFolder(fixture, 'staging')), []);
  release();
  await fixture.service.idle();
}));

test('fix 8.2: a failed conversion leaves older backups alone (only a finished one prunes to the newest three)', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory, { model: async () => 'not json' });
  const old = ['20200101T000000Z-aaaaaaaa', '20200102T000000Z-bbbbbbbb', '20200103T000000Z-cccccccc'];
  for (const name of old) { await mkdir(convertFolder(fixture, 'backups', name), { recursive: true }); await writeFile(convertFolder(fixture, 'backups', name, 'characters.json'), '{}'); }
  assert.equal((await convert(fixture)).state, 'failed');
  assert.deepEqual((await listOf(convertFolder(fixture, 'backups'))).sort(), old);
  fixture.model.current = prefixTranslation;
  assert.equal((await convert(fixture)).state, 'done');
  const kept = (await listOf(convertFolder(fixture, 'backups'))).sort();
  assert.equal(kept.length, 3);
  assert.deepEqual(kept.slice(0, 2), old.slice(1));
}));

// ---- 3. voice bindings of other characters ----------------------------------------------------------------------------------------------

const others = (count: number): TtsStyleBinding[] => Array.from({ length: count }, (_, index) => ({ characterId: `other-${index}`, modelPath: `m${index}.pmx`, voice: 'v', instruction: '', emotion: 'gentle', rate: 1 } as TtsStyleBinding));

test('fix 8.3: a full voice list (64) keeps every other character\'s binding; the new card\'s is not added and is listed as not carried', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory);
  const tts = fixture.settings.current.tts!;
  tts.styleBindings = [...others(63), ...tts.styleBindings!];
  const before = structuredClone(tts.styleBindings);
  const done = await convert(fixture);
  assert.equal(done.state, 'done', done.error);
  assert.deepEqual(fixture.settings.current.tts!.styleBindings, before);
  assert.ok(done.leftOut?.some(item => item.kind === 'voice' && (item.reasons as string[]).includes('no-room')), JSON.stringify(done.leftOut));
  assert.match(done.carried!.voice, /没有带.*64/);
}));

test('fix 8.3: with room the binding is added; a failed save restores the list exactly', async () => withDirectory(async directory => {
  const room = await makeFixture(directory);
  room.settings.current.tts!.styleBindings = [...others(62), ...room.settings.current.tts!.styleBindings!];
  const done = await convert(room);
  assert.equal(done.state, 'done', done.error);
  assert.equal(room.settings.current.tts!.styleBindings!.length, 64);
  assert.ok(room.settings.current.tts!.styleBindings!.some(item => item.characterId === done.newCardId));
}));

test('fix 8.3: a failed save with a full list leaves the list exactly as it was', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory, { wiring: wiring => ({ ...wiring, addCard: async () => { throw new Error('磁盘写不进去。'); } }) });
  fixture.settings.current.tts!.styleBindings = [...others(63), ...fixture.settings.current.tts!.styleBindings!];
  const before = structuredClone(fixture.settings.current.tts!.styleBindings);
  assert.equal((await convert(fixture)).state, 'failed');
  assert.deepEqual(fixture.settings.current.tts!.styleBindings, before);
}));

// ---- 4. every written form of a left-out name ----------------------------------------------------------------------------------------------

const LEFT_HER_NICKNAME = [{ id: 'her-name' as const, to: 'Cheng' }, { id: 'her-nickname' as const, to: '' }, { id: 'user-nickname' as const, to: 'Rainy' }];
const VARIANTS_DESCRIPTION = '在海边长大的女孩。朋友写她的小名时写成Cheng Cheng，有时连写chengcheng，也有人叫Xiao Cheng；澄澄（Little Orange）这个叫法也常用，Little Orange很爱笑。';

test('fix 8.4: the pinyin, Xiao and English forms of a left-out name never reach the model, in any call', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory, { description: VARIANTS_DESCRIPTION });
  const done = await convert(fixture, LEFT_HER_NICKNAME);
  assert.equal(done.state, 'done', done.error);
  assert.ok(fixture.model.calls.length >= 2);
  for (const { prompt, system } of fixture.model.calls) for (const form of [/澄澄/u, /Cheng Cheng/iu, /chengcheng/iu, /Xiao Cheng/iu, /Little Orange/iu]) {
    assert.doesNotMatch(prompt, form); assert.doesNotMatch(system, form);
  }
}));

test('fix 8.4: the popup names the forms that are treated as left out', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory, { description: VARIANTS_DESCRIPTION });
  const tool = createConversionTools(() => fixture.service).find(item => item.name === 'convert_character_language')!;
  const request = tool.validate({ characterId: fixture.sourceId, language: 'en', names: LEFT_HER_NICKNAME });
  const prepared = await tool.prepare!(request);
  const detail = (tool.confirmation as (value: unknown) => { detail: string })(prepared).detail;
  assert.match(detail, /澄澄/);
  for (const form of ['Cheng Cheng', 'chengcheng', 'Xiao Cheng', 'Little Orange']) assert.ok(detail.includes(form), `${form} in: ${detail}`);
}));

// ---- 5. missing or cut content is said ---------------------------------------------------------------------------------------------------

test('fix 8.5: a persona field that came back empty (twice) is listed as not carried; it was asked again once', async () => withDirectory(async directory => {
  const model: ConversionModel = async (prompt, system, signal) => {
    const out = await prefixTranslation(prompt, system, signal);
    if (!system.includes('character card')) return out;
    const value = JSON.parse(out); value.personality = ''; return JSON.stringify(value);
  };
  const fixture = await makeFixture(directory, { model });
  const done = await convert(fixture);
  assert.equal(done.state, 'done', done.error);
  const item = done.leftOut?.find(entry => (entry.kind as string) === 'persona');
  assert.ok(item, JSON.stringify(done.leftOut));
  assert.match(item!.title, /性格/);
  assert.deepEqual(item!.reasons, ['missing']);
  assert.equal(fixture.model.calls.filter(call => call.system.includes('character card')).length, 2);
}));

test('fix 8.5: a note whose people came back missing and a summary cut to the limit are listed; the rest is carried', async () => withDirectory(async directory => {
  const long = Array.from({ length: 400 }, (_, index) => `word${index}`).join(' ');
  const fixture = await makeFixture(directory, { model: makeTranslator(FIXTURE_TERMS, (value, kind, key) => {
    if (kind !== 'note') return value;
    return value.people.length ? { ...value, people: [] } : { ...value, summary: long };
  }) });
  const done = await convert(fixture);
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.carried!.notes, 2);
  const reasons = (done.leftOut ?? []).filter(item => item.kind === 'note').map(item => [item.title, item.reasons.join()]);
  assert.ok(reasons.some(([title, why]) => /人物/.test(title!) && why === 'missing'), JSON.stringify(reasons));
  assert.ok(reasons.some(([title, why]) => /概要/.test(title!) && why === 'cut'), JSON.stringify(reasons));
}));

test('fix 8.5: a profile line the profile store refuses and diary days older than the carried window are listed', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory, { model: makeTranslator(FIXTURE_TERMS, (value, kind) => kind === 'profile' ? { text: 'password: hunter22' } : value) });
  const file = path.join(directory, 'user-profiles', `profile-${userProfileScopeId({ characterId: fixture.sourceId, providerScope })}.json`);
  const data = JSON.parse(await readFile(file, 'utf8'));
  const old = new Date(Date.now() - 40 * DAY), date = `${old.getFullYear()}-${String(old.getMonth() + 1).padStart(2, '0')}-${String(old.getDate()).padStart(2, '0')}`;
  data.diary = [...(data.diary ?? []), { date, text: '很久以前的一天。', writtenAt: old.getTime() }];
  await writeFile(file, JSON.stringify(data) + '\n');
  const done = await convert(fixture);
  assert.equal(done.state, 'done', done.error);
  const items = done.leftOut ?? [];
  assert.ok(items.some(item => item.kind === 'profile' && (item.reasons as string[]).includes('private')), JSON.stringify(items));
  assert.ok(items.some(item => item.kind === 'diary' && (item.reasons as string[]).includes('capped') && /1 天/.test(item.title)), JSON.stringify(items));
  assert.equal(done.carried!.profileEntries, 0);
}));

// ---- 8. an English card has no full-width punctuation -----------------------------------------------------------------------------------------

test('fix 8.8: full-width punctuation the model wrote into an English card is turned into ASCII in every converted text', async () => withDirectory(async directory => {
  const marks = /[，。！？：；、（）【】「」『』《》～]/u;
  const model: ConversionModel = async (prompt, system, signal) => {
    const out = await prefixTranslation(prompt, system, signal);
    if (system.includes('character card')) { const value = JSON.parse(out); value.description = 'I went for a walk！Then home。'; value.greeting = '（smiles）Hi，you！'; return JSON.stringify(value); }
    return makeTranslator(FIXTURE_TERMS, (value, kind) => kind === 'note' ? { ...value, summary: `${value.summary}！Really？`, title: `${value.title}：ok` }
      : kind === 'diary' ? { ...value, text: `${value.text}；fine。` } : kind === 'profile' ? { text: 'Learns piano（slowly）。' }
      : kind === 'voice' ? { ...value, instruction: 'Soft，sleepy。' } : value)(prompt, system, signal);
  };
  const fixture = await makeFixture(directory, { model });
  const done = await convert(fixture);
  assert.equal(done.state, 'done', done.error);
  const card = fixture.cards.publicState().cards.find(item => item.id === done.newCardId)!;
  assert.equal(card.description, 'I went for a walk! Then home.');
  assert.equal(card.greeting, '(smiles) Hi, you!');
  await fixture.companion.flush();
  const records = (await readFile(path.join(directory, 'memories.jsonl'), 'utf8')).split('\n').filter(line => line.includes(`converted-${done.newCardId}`));
  assert.ok(records.length);
  assert.doesNotMatch(records.join('\n'), marks);
  assert.match(records.join('\n'), /! Really\?/);
  const profile = await readFile(path.join(directory, 'user-profiles', `profile-${userProfileScopeId({ characterId: done.newCardId!, providerScope })}.json`), 'utf8');
  assert.doesNotMatch(profile, marks);
  assert.match(profile, /Learns piano \(slowly\)\./);
  const binding = fixture.settings.current.tts!.styleBindings!.find(item => item.characterId === done.newCardId)!;
  assert.equal(binding.instruction, 'Soft, sleepy.');
}));
