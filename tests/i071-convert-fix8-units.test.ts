// I-071 v2 第三步, fix 8 (Codex T-240): the pure parts. Synthetic names only (小橙 / 橙宝 / 团团 / Orange / May).
//  4. the closure of a left-out name's written forms, and the output check on the same closure;
//  5. what a history cap left behind is listed;
//  6. "who added" a name only from the user's words on token or phrase boundaries;
//  7. a quoted candidate needs an address signal before frequency counts;
//  8. ASCII punctuation for an English card's texts (a Chinese card is left alone);
//  9. when "允许记录" and the nickname question really carry over, said exactly.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as variants from '../electron/cards/character-convert/variants';
import * as translate from '../electron/cards/character-convert/translate';
import * as shared from '../shared/cards/character-convert';
import * as punctuation from '../shared/foundation/fullwidth-punctuation';
import { findCandidateNames } from '../electron/cards/character-convert/addresses';
import { enforceExtraBy } from '../shared/cards/character-convert';

const v = variants as unknown as Record<string, any>;
const s = shared as unknown as Record<string, any>;
const p = punctuation as unknown as Record<string, any>;

// ---- 4 ----------------------------------------------------------------------------------------------------------------------------

test('fix 8.4: pinyin initials come from the system collation (no table of readings, no dependency)', () => {
  assert.deepEqual(Array.from('团橙小宝雨阿绿欧').map(ch => v.pinyinInitial(ch)), ['t', 'c', 'x', 'b', 'y', 'a', 'l', 'o']);
  assert.equal(v.pinyinInitial('A'), null);
});

test('fix 8.4: written forms of 团团 (spaced, joined, tone marks, Xiao/Little, a doubled name written once) count; look-alikes do not', () => {
  for (const form of ['Tuan Tuan', 'tuantuan', 'Tuán Tuán', 'tuan2 tuan2', 'Xiao Tuan Tuan', 'Little Tuan Tuan', 'Xiao Tuan', 'Lil Tuan', 'Tuan-Tuan'])
    assert.equal(v.romanizes(form, '团团'), true, form);
  for (const form of ['Tuan', 'Tom Tom', 'Tuanjie', 'little tuan', 'Tian Tian', 'Tuan Tian']) assert.equal(v.romanizes(form, '团团'), false, form);
  assert.equal(v.romanizes('Xiao Cheng', '小橙'), true);
  assert.equal(v.romanizes('Little Cheng', '小橙'), true);
  assert.equal(v.romanizes('Cheng', '小橙'), false, 'the name without its 小 is another name');
  assert.equal(v.romanizes('Cheng Bao', '橙宝'), true);
});

test('fix 8.4: the closure: the name, 小+name, pinyin forms in the text, an English form written next to it, the people-and-things group; never a kept name', () => {
  const texts = ['用户叫她团团。后来写成Tuan Tuan，也写tuantuan。', 'Xiao Tuan今天很开心。团团（Little Dumpling）是小名。', '小团团又来了；Little Dumpling睡着了。', '团子说晚安。', 'Tom Tom是猫。'];
  const forms = v.leftOutFormClosure('团团', texts, [['团团', '团子'], ['橙宝', 'Orange']], ['Orange', '橙宝']);
  for (const form of ['团团', '小团团', 'Tuan Tuan', 'tuantuan', 'Xiao Tuan', 'Little Dumpling', '团子']) assert.ok(forms.includes(form), `${form} in ${forms.join()}`);
  assert.ok(!forms.includes('Tom Tom'));
  assert.ok(!forms.includes('Orange'));
  assert.deepEqual(v.leftOutFormClosure('橙宝', ['橙宝（Orange）'], [], ['Orange']), ['橙宝'], 'a form equal to a name the user kept or chose is never taken out');
});

test('fix 8.4: every form is replaced before the call, and the output check uses the same closure', () => {
  const names = { 'her-name': { from: '小橙', to: 'Orange' }, aliases: [{ from: '团团', to: '' }], leftOutForms: [{ of: '团团', forms: ['Tuan Tuan', 'Little Dumpling', '团子'] }] } as translate.NameMap;
  const scrubbed = translate.withoutLeftOutNames({ text: '小橙说Tuan Tuan和Little Dumpling都是团子，Tuan Tuan！' }, names, 'zh-CN');
  assert.doesNotMatch(scrubbed.text, /Tuan|Dumpling|团子/u);
  assert.match(scrubbed.text, /小橙/u);
  // the result of a value whose source had any form of the name: every form of the closure is looked for
  const leaked = translate.translationProblems({ text: '小橙和团子睡了。' }, { text: 'Orange and Little Dumpling slept.' }, 'zh-CN', 'en', names);
  assert.equal(leaked.deviations.some(entry => !entry.to), true);
  assert.deepEqual(translate.translationProblems({ text: '小橙和团子睡了。' }, { text: 'Orange and the user slept.' }, 'zh-CN', 'en', names).deviations, []);
  // a Latin left-out name matches whole words only (May is not in "Maybe")
  const may = { 'her-name': { from: '小橙', to: 'Orange' }, aliases: [{ from: 'May', to: '' }] } as translate.NameMap;
  assert.deepEqual(translate.translationProblems({ text: 'May 说小橙睡了。' }, { text: 'Maybe Orange slept.' }, 'zh-CN', 'en', may).deviations, []);
});

// ---- 5 ----------------------------------------------------------------------------------------------------------------------------

test('fix 8.5: the history caps stay, and what they left behind is listed', () => {
  const items = s.conversionCappedItems({ notes: 250, notesCarried: 200, profileEntries: 1, diaryDays: 30, diaryOlder: 4, memes: 0, reviews: 6, reviewsOlder: 3, knownDays: 1, qualityDays: 0, metDate: null });
  assert.deepEqual(items.map((item: any) => [item.kind, item.title, item.reasons]), [
    ['note', '更早的 50 条聊天笔记', ['capped']], ['diary', '更早的 4 天日记', ['capped']], ['review', '更早的 3 段回顾', ['capped']]]);
  assert.deepEqual(s.conversionCappedItems({ notes: 2, notesCarried: 2, profileEntries: 0, diaryDays: 0, memes: 0, knownDays: 0, qualityDays: 0, metDate: null }), []);
  assert.ok(shared.CONVERSION_LEFT_OUT_REASONS.includes('capped' as never));
});

// ---- 6 ----------------------------------------------------------------------------------------------------------------------------

const byOf = (from: string, typed: string[]) => (enforceExtraBy({ extra: [{ kind: 'alias', from, to: '' }] }, typed) as { extra: { by: string }[] }).extra[0]!.by;

test('fix 8.6: a Latin name is the user\'s only as a whole word (May is not in "Maybe later")', () => {
  assert.equal(byOf('May', ['Maybe later']), 'assistant');
  assert.equal(byOf('May', ['please call her may, thanks']), 'user');
  assert.equal(byOf('May', ['MAY!']), 'user');
});

test('fix 8.6: a Chinese name is the user\'s when it stands alone, is quoted, follows 叫/喊/叫做/就叫/改成, or is most of a short message', () => {
  assert.equal(byOf('小橙', ['就叫小橙子吧']), 'assistant', 'a longer word the user typed');
  assert.equal(byOf('小橙', ['我喜欢小橙色的杯子']), 'assistant');
  assert.equal(byOf('小橙', ['叫她小橙吧']), 'user');
  assert.equal(byOf('小橙', ['改成小橙']), 'user');
  assert.equal(byOf('小橙', ['加一个“小橙”']), 'user');
  assert.equal(byOf('小橙', ['小橙']), 'user');
  assert.equal(byOf('小橙', ['小橙，就这个']), 'user');
  assert.equal(byOf('橙橙', ['再加一个“橙宝”和橙橙']), 'user', 'one more in a list after a quoted one');
});

// ---- 7 ----------------------------------------------------------------------------------------------------------------------------

test('fix 8.7: ordinary quoted words at line starts cannot take the slots from a name with an address signal', () => {
  const block = '“明天”\n“早晨”\n“蓝色”\n“窗外”\n“音乐”';
  const texts = [block, block, block, block, block, block, '用户叫她“橙宝”。', '他又喊“橙宝”。'];
  const quoted = findCandidateNames(texts, [], []).filter(item => item.source === 'quoted').map(item => item.text);
  assert.equal(quoted[0], '橙宝', quoted.join());
});

test('fix 8.7: a vocative at a line start is a signal; a word that only starts lines is not', () => {
  // 明天 is spread over more notes and said more often: without the signal rule it would rank first
  const texts = ['“甜豆”，起床啦', '“甜豆”！吃饭了', '“明天”见', '“明天”再说', '“明天”也行', '“明天”吧'];
  const quoted = findCandidateNames(texts, [], []).filter(item => item.source === 'quoted').map(item => item.text);
  assert.deepEqual(quoted, ['甜豆', '明天']);
});

// ---- 8 ----------------------------------------------------------------------------------------------------------------------------

test('fix 8.8: ASCII punctuation for English text; marks and curly quotes stay; a Chinese card keeps its full-width marks', () => {
  assert.equal(p.asciiPunctuation('I went for a walk！Then home。'), 'I went for a walk! Then home.');
  assert.equal(p.asciiPunctuation('（smiles）Hi，you！'), '(smiles) Hi, you!');
  assert.equal(p.asciiPunctuation('Tea、cake；and：this？'), 'Tea, cake; and: this?');
  assert.equal(p.asciiPunctuation('“Hi,” she said ～ ok……'), '“Hi,” she said ~ ok…');
  assert.equal(p.asciiPunctuation('〔pet name〕'), '〔pet name〕');
  const persona = translate.readPersona('{"name":"Orange","description":"Hi！"}', 'en' as never);
  assert.equal(persona.description, 'Hi!');
  assert.equal(translate.readPersona('{"name":"小橙","description":"你好！"}', 'zh-CN' as never).description, '你好！');
  const item = { k: 'p0', kind: 'profile' as const, v: { text: '她喜欢茶。' } };
  assert.deepEqual(translate.readMemoryValue(item, { text: 'Likes tea。' }, 'en'), { text: 'Likes tea.' });
  assert.deepEqual(translate.readMemoryValue(item, { text: '喜欢茶！' }, 'zh-CN'), { text: '喜欢茶！' });
});

// ---- 9 ----------------------------------------------------------------------------------------------------------------------------

test('fix 8.9: she asks again what to call the user only when no nickname for the user is carried and one was left for later', () => {
  assert.equal(s.nicknameAskStartsOver('小雨', null, false), true);
  assert.equal(s.nicknameAskStartsOver(null, null, true), true);
  assert.equal(s.nicknameAskStartsOver('小雨', 'Rainy', true), false);
  assert.equal(s.nicknameAskStartsOver(null, null, false), false);
});

test('fix 8.9: "允许记录" is said as it really is: the shared switch when the user chose it, else the carried profile\'s own (and which one)', () => {
  const global = shared.conversionSettingsLines(true, { global: true } as never);
  assert.match(global.carried.join(), /所有角色共用/);
  const globalOff = shared.conversionSettingsLines(true, { global: false } as never);
  assert.deepEqual(globalOff.carried, []);
  assert.match(globalOff.off.join(), /所有角色共用.*关着/);
  const other = shared.conversionSettingsLines(true, { global: null, otherConnection: true } as never);
  assert.match(other.carried.join(), /之前用过的另一个连接/);
});
