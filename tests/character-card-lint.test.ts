import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { cardLintNotice, lintCharacterCard } from '../shared/cards/character-card-lint';
import { setUiLanguage } from '../shared/foundation/ui-language';
import { lintCardFileText, withCardLint } from '../electron/cards/character-card-lint';

const base = { name: '小满', description: '住在桌面上的伙伴。', personality: '温和，爱笑。', scenario: '', greeting: '你好呀。', examples: '', systemPrompt: '' };
const lint = (patch: Record<string, string>, options = {}) => lintCharacterCard({ ...base, ...patch }, options);

test('a plain card gets no reminders', () => {
  assert.deepEqual(lint({}), []);
  assert.deepEqual(lint({ systemPrompt: '你就是小满。一般一到三句，口语。她 18 岁，生日 3 月 5 日，今天心情：不错。' }), []);
});
test('guide 1: role-play and "you are an AI" openers', () => {
  for (const value of ['扮演一个温柔的少女。', '请扮演小满。', '你是一个 AI，请扮演小满', '你是一个人工智能助手', ' 现在请你扮演她'])
    assert.equal(lint({ systemPrompt: value }).length, 1, value);
  assert.equal(lint({ personality: '请扮演她' }).length, 1);
  for (const value of ['你就是小满。', '她很擅长扮演各种角色。', '你是一个爱笑的女孩。', '你是 soft hearts 中的小满'])
    assert.deepEqual(lint({ systemPrompt: value }), [], value);
});
test('guide 3: fixed example formats need at least three lines', () => {
  const dots = '用户：嗨\n小满：……嗯，来啦\n用户：今天好累\n小满：……先坐下吧\n用户：谢谢\n小满：……不客气';
  assert.equal(lint({ examples: dots }).length, 1);
  assert.equal(lint({ examples: '小满：...嗯\n小满：...好\n小满：...哦' }).length, 1);
  const same = '用户：嗨\n小满：（歪头）来啦\n用户：累\n小满：（歪头）坐吧\n用户：谢\n小满：（歪头）不客气';
  assert.equal(lint({ examples: same }).length, 1);
  assert.deepEqual(lint({ examples: '用户：嗨\n小满：……嗯，来啦\n用户：累\n小满：先坐下吧\n用户：谢\n小满：（笑）不客气' }), []);
  assert.deepEqual(lint({ examples: '用户：嗨\n小满：……嗯\n用户：累\n小满：……好' }), [], 'only two lines');
  assert.deepEqual(lint({ examples: '用户：（挥手）嗨\n小满：来啦\n用户：（挥手）累\n小满：坐吧\n用户：（挥手）谢\n小满：不客气' }), [], 'user lines do not count');
  assert.deepEqual(lint({ examples: '用户：嗨\n小满：（歪头）来啦\n用户：累\n小满：（点头）坐吧\n用户：谢\n小满：（笑）不客气' }), []);
});
test('guide 4: trait word plus number, but not ordinary numbers', () => {
  for (const value of ['黏人度 90', '好感度：80', '傲娇值 7/10', '撒娇：85'])
    assert.equal(lint({ systemPrompt: value }).length, 1, value);
  assert.equal(lint({ personality: '黏人度90' }).length, 1);
  for (const value of ['18 岁', '3 月 5 日生日', '温柔 3 点钟起床', '主动 5 次', '她有 2 个姐姐，脾气 很好', '第 1 章', '好感度很高'])
    assert.deepEqual(lint({ systemPrompt: value }), [], value);
});
test('guide 9: long replies, Markdown and lists, unless the card says not to', () => {
  for (const value of ['回复至少 200 字', '用 Markdown 格式回答', '请分点回答', '用列表列出', '回答要详细，长篇大论也行', '不少于300字'])
    assert.equal(lint({ systemPrompt: value }).length, 1, value);
  for (const value of ['不要用列表和 Markdown', '别分点', '一般一到三句，口语。', '她有一份愿望清单', '大部分点心她都爱吃', '她回答问题总是很详细', '购物清单上写满了零食', '十分点头'])
    assert.deepEqual(lint({ systemPrompt: value }), [], value);
});
test('guide 10: file paths and key-shaped strings', () => {
  for (const value of ['图在 C:\\Users\\a\\x.png', '/Users/bob/notes', '\\Users\\bob', '/home/bob/x', 'sk-abcdefghijklmnopqrstuvwxyz123456',
    '0123456789abcdef0123456789abcdef0123', 'QWxhZGRpbjpvcGVuIHNlc2FtZVRoaXNJc0Z1bGxPZkRpZ2l0czEyMzQ1Njc4OTA='])
    assert.equal(lint({ description: value }).length, 1, value);
  for (const value of ['访问 https://example.com/page', '生日是 2000 年 1 月 1 日', '电话 12345', 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz', '她住在 C 区 3 栋'])
    assert.deepEqual(lint({ description: value }), [], value);
});
test('guide 5: same name as an existing card, compared without edge spaces', () => {
  assert.equal(lint({ name: ' 小满 ' }, { existingNames: ['小满'] }).length, 1);
  assert.ok(lint({ name: '小满' }, { existingNames: ['小满 '] })[0].includes('小满'));
  assert.deepEqual(lint({ name: '小满' }, { existingNames: ['小暖', 'Gene'] }), []);
  assert.deepEqual(lint({ name: '小满' }), [], 'an update gives no existing names');
  assert.deepEqual(lint({ name: '' }, { existingNames: [''] }), []);
});
test('at most three, the name clash first', () => {
  const notes = lint({ name: '小满', systemPrompt: '扮演小满。黏人度 90。回复至少 200 字。', description: 'C:\\Users\\a' }, { existingNames: ['小满'] });
  assert.equal(notes.length, 3);
  assert.ok(notes[0].includes('已经有一张叫'));
});
test('English copy exists for every reminder', () => {
  const sets = () => [lint({ name: '小满' }, { existingNames: ['小满'] }), lint({ description: 'C:\\Users\\a' }), lint({ systemPrompt: '扮演她' }), lint({ systemPrompt: '至少 200 字' }),
    lint({ systemPrompt: '黏人度 90' }), lint({ examples: '小满：...嗯\n小满：...好\n小满：...哦' })].flat();
  assert.equal(sets().length, 6);
  setUiLanguage('en');
  try {
    const english = sets();
    for (const line of english) assert.ok(!/[\u4e00-\u9fff]/.test(line.replace('小满', '')), line);
    assert.ok(cardLintNotice(english.slice(0, 1))!.startsWith('Heads-up'));
  } finally { setUiLanguage('zh-CN'); }
});
test('the notice joins the import notice and never replaces it', () => {
  assert.equal(cardLintNotice([]), undefined);
  assert.equal(cardLintNotice([], '原来的'), '原来的');
  assert.ok(cardLintNotice(['甲。'], '原来的')!.startsWith('原来的 提醒'));
});
test('card files: reminders ride on the result and unreadable files give none', () => {
  const file = (card: object) => JSON.stringify({ format: 'soft-hearts-character-card', version: 1, card });
  const text = file({ ...base, systemPrompt: '扮演小满' });
  assert.equal(lintCardFileText(text).length, 1);
  assert.equal(lintCardFileText(text, ['小满']).length, 2);
  assert.deepEqual(lintCardFileText('not json'), []);
  const result = withCardLint({ state: 1, notice: undefined as string | undefined }, text);
  assert.ok(result.notice?.includes('提醒'));
  assert.equal(withCardLint({ state: 1 } as { state: number; notice?: string }, file(base)).notice, undefined);
});
// The docs example card is checked by hand (docs/claude/2026-11-10-card-lint.md): docs/ is not in the frozen update copy.
test('every card shipped with the app gives no reminders', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full); else if (entry.endsWith('.json')) files.push(full);
    }
  };
  walk('assets/bundled'); walk('shared/cards/presets');
  let cards = 0;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (!/soft-hearts-character-card|chara_card_v2/.test(text)) continue;
    cards += 1;
    assert.deepEqual(lintCardFileText(text, []), [], file);
  }
  assert.ok(cards >= 1);
});
