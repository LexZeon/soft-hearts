// I-071 v2 第三步, fix 7 after the seventh isolated test (every name here is synthetic: a made-up character "小橙" / Orange):
//  1. a left-out calling form that holds her name must not make the name check fail a translation that rightly lacks it;
//  2. who added an extra name is decided by the host from evidence, both ways, and a find in her memories says so;
//  3. quoted address candidates are ranked by how much they look like a form of address, not by raw count;
//  4. full-width punctuation only where the words next to the mark are Chinese.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findCandidateNames } from '../electron/cards/character-convert/addresses';
import { glossaryDeviations, translationProblems, type NameMap } from '../electron/cards/character-convert/translate';
import { CONVERSION_EXTRA_BY_LABELS, checkConversionExtra, enforceExtraBy } from '../shared/cards/character-convert';
import { fullWidthChinese } from '../shared/foundation/fullwidth-punctuation';

// ---- 1. her name inside a left-out form ---------------------------------------------------------------------------------------------

const names: NameMap = { 'her-name': { from: '小橙', to: 'Orange' }, 'user-nickname': { from: '爱妻小橙', to: '' } };

test('her name only inside a left-out form: not writing it is right; standing alone it is still required', () => {
  const source = { s: '他叫她爱妻小橙。' };
  const translated = { s: 'He used a pet name for her.' };
  assert.deepEqual(translationProblems(source, translated, 'zh-CN', 'en', names).deviations, []);
  const alone = { s: '他叫她爱妻小橙。小橙笑了。' };
  const bad = translationProblems(alone, { s: 'He used a pet name for her. She laughed.' }, 'zh-CN', 'en', names);
  assert.deepEqual(bad.deviations.map(entry => entry.from), ['小橙']);
  assert.deepEqual(translationProblems(alone, { s: 'He used a pet name for her. Orange laughed.' }, 'zh-CN', 'en', names).deviations, []);
  // the raw check on the unscrubbed source is what used to fail
  assert.equal(glossaryDeviations(source, translated, names).length, 1);
});

// ---- 2. who added it ----------------------------------------------------------------------------------------------------------------

test('by is decided from the evidence: the user\'s own words win over the model\'s claim, and the model\'s claim of user without words is dropped', () => {
  const out = enforceExtraBy({ extra: [
    { kind: 'alias', from: '橙宝', to: '', by: 'assistant' },
    { kind: 'alias', from: '橙橙', to: '' },
    { kind: 'alias', from: '小橙子', to: '', by: 'user' },
  ] }, ['再加一个“橙宝”和橙橙']) as { extra: { from: string; by: string }[] };
  assert.deepEqual(out.extra.map(item => [item.from, item.by]), [['橙宝', 'user'], ['橙橙', 'user'], ['小橙子', 'assistant']]);
});

test('a find by the assistant says where: persona, or her memories; the user\'s addition stays the user\'s', () => {
  const persona = '小橙是一只猫，大家叫她橙宝。';
  const corpus = `${persona}\n她的笔记里写着：用户叫她橙子。`;
  const extra = checkConversionExtra([], [
    { kind: 'alias', from: '橙宝', to: '', by: 'assistant' },
    { kind: 'alias', from: '橙子', to: '', by: 'assistant' },
  ], corpus, persona);
  assert.deepEqual(extra.map(item => item.by), ['assistant', 'assistant-memory']);
  assert.equal(checkConversionExtra([], [{ kind: 'alias', from: '橙子', to: '', by: 'user' }], corpus, persona)[0]!.by, 'user');
  assert.equal(checkConversionExtra([], [{ kind: 'alias', from: '橙子', to: '' }], corpus, persona)[0]!.by, undefined);
  assert.equal(CONVERSION_EXTRA_BY_LABELS.assistant, 'Claude 在人设里找到的');
  assert.equal(CONVERSION_EXTRA_BY_LABELS['assistant-memory'], 'Claude 在记忆里找到的');
});

// ---- 3. candidate ranking -----------------------------------------------------------------------------------------------------------

test('quoted candidates: nicknames outrank ordinary quoted phrases even when the phrases are said as often', () => {
  const texts = [
    '她问“还困么”，他说“好的”。用户叫她“橙宝”。',
    '“还困么”他又问了一遍。他喊她“小橙团”。',
    '“橙宝”，起床啦',
    '“还困么”“今天也要加油哦嘿嘿”',
    '“今天也要加油哦嘿嘿”她笑了；又叫“小橙团”。',
    '“橙宝”！\n“小橙团”！',
  ];
  const names = findCandidateNames(texts, [], []).filter(item => item.source === 'quoted').map(item => item.text);
  assert.deepEqual(names.slice(0, 2).sort(), ['小橙团', '橙宝'], names.join());
  assert.ok(names.indexOf('还困么') > names.indexOf('橙宝') && names.indexOf('还困么') > names.indexOf('小橙团'), names.join());
});

// ---- 4. full-width marks next to Chinese only ----------------------------------------------------------------------------------------

test('full-width marks need Chinese around them: an English answer holding one Chinese word keeps its ASCII marks', () => {
  assert.equal(fullWidthChinese('I called her 小橙?'), 'I called her 小橙?');
  assert.equal(fullWidthChinese('The name is 小橙,\nand then 橙宝!'), 'The name is 小橙,\nand then 橙宝!');
  assert.equal(fullWidthChinese('Which one: 小橙, 橙宝'), 'Which one: 小橙, 橙宝');
  assert.equal(fullWidthChinese('我叫她小橙,好吗?'), '我叫她小橙，好吗？');
  assert.equal(fullWidthChinese('用 AI 帮你,好吗?'), '用 AI 帮你，好吗？');
  assert.equal(fullWidthChinese('Done.\n好的,要转吗?'), 'Done.\n好的，要转吗？');
});
