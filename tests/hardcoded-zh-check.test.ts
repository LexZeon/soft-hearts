// The hard-coded-Chinese check (scripts/dev/hardcoded-zh-check.mjs): interface code may not gain Chinese that skips
// uiText / uiTemplate / uiHtml / t; today's debt is the baseline file and may only shrink.
import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error plain .mjs script without types
import { HINT, loadBaseline, newOnes, scanHtml, scanRepository, scanTs } from '../scripts/dev/hardcoded-zh-check.mjs';

const texts = (hits: { text: string }[]) => hits.map(hit => hit.text);

test('the real repository adds no new hard-coded Chinese (baseline only shrinks; fix: route it through uiText and give English in ui-copy.*.en.ts)', () => {
  const fresh = newOnes(scanRepository(), loadBaseline());
  assert.deepEqual(fresh.map((f: { file: string; text: string }) => `${f.file}: ${f.text}`), [], HINT);
});

test('new hard-coded Chinese in interface code is reported', () => {
  const source = [
    "const box = document.createElement('div');",
    "box.textContent = '全新的提示文字';",
    "box.title = `悬停提示`;",
    "box.innerHTML = `<b>加粗的字</b>${name}`;",
    "notify(cond ? '成功了' : '失败了');",
  ].join('\n');
  assert.deepEqual(texts(scanTs('src/fake/Panel.ts', source)).sort(),
    ['全新的提示文字', '加粗的字', '失败了', '成功了', '悬停提示'].sort());
});

test('copy that goes through the language layer, comments, logs, regexes and marked lines are not counted', () => {
  const source = [
    "// 注释里的中文不算",
    "/* 块注释里的中文也不算 */",
    "el.textContent = uiText('经过语言层');",
    "el.title = t('也经过语言层');",
    "el.textContent = uiText(cond ? '甲' : '乙');",
    "el.textContent = uiTemplate`已选 ${name} 项`;",
    "el.innerHTML = uiHtml`<b>固定标记</b>${name}`;",
    "console.warn('开发者日志');",
    "registerUiMessages({ en: { '键': 'Key' }, 'zh-CN': {} });",
    "const looksChinese = /[\\u4e00-\\u9fff]|你好/;",
    "const prompt = '给模型的提示词'; // ui-zh-ok: sent to the model, never shown",
    "// ui-zh-ok: developer-only label",
    "const devLabel = '开发者专用';",
  ].join('\n');
  assert.deepEqual(scanTs('src/fake/Panel.ts', source), []);
});

test('Chinese inside an interpolation of a uiHtml template is still counted (only the fixed chunks are translated)', () => {
  const source = "el.innerHTML = uiHtml`<b>固定</b>${cond ? '插值里的中文' : ''}`;";
  assert.deepEqual(texts(scanTs('src/fake/Panel.ts', source)), ['插值里的中文']);
});

test('a literal that already has an English dictionary entry is translatable, so it is not counted', () => {
  const source = "el.textContent = '显示桌宠'; el.title = '没有词条';";
  assert.deepEqual(texts(scanTs('src/fake/Panel.ts', source, new Set(['显示桌宠']))), ['没有词条']);
});

test('HTML pages: visible text and accessible attributes count, comments do not', () => {
  const html = '<!-- 注释 --><input placeholder="对她说点什么…" /><p>你好</p><span data-x="不显示">hi</span>';
  assert.deepEqual(texts(scanHtml('src/fake/page.html', html)).sort(), ['你好', '对她说点什么…'].sort());
});

test('the baseline lets today\'s debt through but fails on one more, in an old file or a new one', () => {
  const baseline = { 'src/a.ts': ['旧的', '旧的'] };
  assert.deepEqual(newOnes({ 'src/a.ts': ['旧的', '旧的'] }, baseline), []);
  assert.deepEqual(newOnes({ 'src/a.ts': ['旧的'] }, baseline), []);
  assert.deepEqual(newOnes({ 'src/a.ts': ['旧的', '旧的', '旧的'] }, baseline), [{ file: 'src/a.ts', text: '旧的' }]);
  assert.deepEqual(newOnes({ 'src/a.ts': ['旧的', '新的'] }, baseline), [{ file: 'src/a.ts', text: '新的' }]);
  assert.deepEqual(newOnes({ 'src/b.ts': ['旧的'] }, baseline), [{ file: 'src/b.ts', text: '旧的' }]);
});

test('the Unbound input box is fixed (2026-11-19): it is out of the baseline and stays out', () => {
  const baseline = loadBaseline();
  assert.equal(baseline['src/unbound/input.html'], undefined);
  assert.equal(baseline['src/unbound/input.ts'], undefined);
});
