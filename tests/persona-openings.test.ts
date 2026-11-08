// R28 / F1 (real-chat finding 3): the card's example lines are a tone reference, and an ellipsis is not the habitual opening.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EXAMPLES_HEADING, OPENING_VARIETY_RULE, compileCharacterPersona, type CharacterTextDraft } from '../shared/character-cards';
import { containsExample, exampleLines, legacyPersona, openingLine, openingStats, opensWithEllipsis, runOpeningStats } from '../scripts/lib/fidelity-openings';
import { FIDELITY_CARDS } from '../scripts/lib/fidelity-scenarios';

const card: CharacterTextDraft = {
  name: '林溪', description: '合成测试卡。', personality: '话少、细心。', scenario: '', greeting: '',
  examples: '用户：今天好累。\n林溪：……那就早点睡，我替你看着时间。\n用户：我回来了。\n林溪：嗯，回来啦。外面冷不冷？',
  systemPrompt: '',
};

test('the persona marks the examples as a tone reference and carries the opening rule', () => {
  const persona = compileCharacterPersona(card);
  assert.ok(persona.includes(`${EXAMPLES_HEADING}\n用户：今天好累。`), 'the heading sits right above the examples');
  assert.ok(EXAMPLES_HEADING.includes('不要原样照抄'));
  assert.ok(persona.endsWith(OPENING_VARIETY_RULE));
  assert.ok(OPENING_VARIETY_RULE.includes('省略号') && OPENING_VARIETY_RULE.includes('偶尔'), 'an ellipsis now and then is still fine');
  assert.ok(persona.includes('话少、细心。'), 'the card keeps its own voice');
});

test('a card with no examples gets only the rule; a legacy prompt-only card is unchanged', () => {
  const plain = compileCharacterPersona({ ...card, examples: '' });
  assert.ok(!plain.includes('对话示例') && plain.endsWith(OPENING_VARIETY_RULE));
  const legacy = compileCharacterPersona({ ...card, description: '', personality: '', examples: '', systemPrompt: '你是旧版的自定义人设。' });
  assert.equal(legacy, '你是旧版的自定义人设。');
});

test('legacyPersona gives back the wording from before', () => {
  const before = legacyPersona(compileCharacterPersona(card));
  assert.ok(before.includes('\n\n对话示例：\n用户：今天好累。') && !before.includes('原样照抄') && !before.includes('表达变化'));
});

test('ellipsis openings: ……, … and ... count, after quotes or spaces; a later ellipsis does not', () => {
  for (const text of ['……那就早点睡', '…嗯', '...好吧', '  ……嗯', '“……嗯”', '。。。算了']) assert.equal(opensWithEllipsis(text), true, text);
  for (const text of ['嗯……那就早点睡', '那就早点睡……', '好呀。', '', '.5 倍速']) assert.equal(opensWithEllipsis(text), false, text);
});

test('example lines are the character\'s, at least 8 characters, and found word for word', () => {
  const lines = exampleLines(compileCharacterPersona(card));
  assert.ok(lines.length >= 2);
  assert.ok(!lines.some(line => line.includes('今天好累')), 'the user\'s lines are not examples');
  assert.equal(containsExample('……那就早点睡，我替你看着时间。', lines), true, 'the whole line');
  assert.equal(containsExample('好，那我就替你看着时间 ，早点睡', lines), false, 'a re-worded line is not a copy');
  assert.equal(containsExample('嗯，回来啦。今天外面冷不冷？', lines), false, 'under 8 characters of the original');
  assert.equal(containsExample('哦，嗯，回来啦。外面冷不冷？先坐下。', lines), true, 'a full sentence of the example inside a longer reply');
  assert.deepEqual(exampleLines('角色名称：X'), []);
});

test('the two numbers over a set of replies', () => {
  const lines = exampleLines(compileCharacterPersona(card));
  const stats = openingStats([
    { reply: '……嗯，我在。', examples: lines }, { reply: '……那就早点睡，我替你看着时间。', examples: lines },
    { reply: '在呢。', examples: lines }, { reply: '好呀，慢慢说。', examples: lines }, { reply: '   ', examples: lines },
  ]);
  assert.deepEqual([stats.replies, stats.ellipsisOpenings, stats.exampleCopies], [4, 2, 1]);
  assert.equal(stats.ellipsisShare, 0.5);
  assert.match(openingLine(stats), /2 \/ 4 条（50%）.*1 条/u);
  assert.equal(openingStats([]).ellipsisShare, null);
});

test('over a run: each case uses its own card\'s example lines', () => {
  const gene = FIDELITY_CARDS.find(item => item.id === 'gene')!;
  const stats = runOpeningStats([{ card: 'gene', replies: [{ reply: '……嗯' }, { reply: '在的。' }] }], id => id === 'gene' ? gene.persona : undefined);
  assert.equal(stats.ellipsisOpenings, 1);
});

test('a card that fitted before never becomes too long because of the two added wordings', () => {
  const base = compileCharacterPersona({ ...card, examples: '' }).length - OPENING_VARIETY_RULE.length - 2;
  // Filler sized so the plain wording is just under the limit and the added wording would be over it.
  const tight = compileCharacterPersona({ ...card, examples: '', description: '字'.repeat(12000 - base - 10) });
  assert.ok(tight.length <= 12000 && !tight.includes(OPENING_VARIETY_RULE), 'kept the plain wording');
  assert.throws(() => compileCharacterPersona({ ...card, examples: '', description: '字'.repeat(12000) }), /超过/);
});
