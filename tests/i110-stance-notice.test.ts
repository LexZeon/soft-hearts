// I-110: one quiet line saying her words speak for the character, not for the
// model provider (Anthropic) or the developers. Shown in the first-run welcome, 「连接一颗大脑」 and the
// about block of the real control page; never inside the chat itself. Record: docs/claude/2026-11-13-stance-notice.md.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import ts from 'typescript';
import { setUiLanguage } from '../shared/foundation/ui-language';
import { uiHtml, uiMarkup, uiTemplate, uiText } from '../src/foundation/ui-language';
import { STANCE_NOTICE } from '../shared/foundation/stance-notice';

// Same extraction as tests/ui-language-entry.test.ts: run the real renderControls without a browser.
function renderControls(): string {
  const file = '../src/settings/layout.ts';
  const raw = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
  const tree = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true);
  const declarations = tree.statements.filter(ts.isFunctionDeclaration)
    .filter(node => ['button', 'toggle', 'number', 'range', 'renderControls'].includes(node.name?.text ?? ''))
    .map(node => node.getText(tree).replace(/^export /, ''));
  const body = ts.transpileModule(`${declarations.join('\n')}\nreturn renderControls;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const render = Function('icon', 'renderControlNavigation', 'uiText', 'uiHtml', 'uiMarkup', 'uiTemplate', body)(() => '', () => '', uiText, uiHtml, uiMarkup, uiTemplate);
  const app = { innerHTML: '' };
  render(app);
  return app.innerHTML;
}

const count = (text: string, sentence: string) => text.split(sentence).length - 1;
function between(html: string, from: string, to: string): string {
  const start = html.indexOf(from), end = html.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `${from} … ${to}`);
  return html.slice(start, end);
}
// How many times the notice appears on the whole page and inside each of the three quiet places.
function places(html: string, sentence: string) {
  return {
    total: count(html, sentence),
    welcome: count(between(html, 'class="welcome"', 'class="composer-wrap"'), sentence),
    brain: count(between(html, 'id="providers-connection"', 'id="character-cards-moved"'), sentence),
    about: count(between(html, 'class="about"', 'class="statusbar"'), sentence),
  };
}
const EXPECTED = { total: 3, welcome: 1, brain: 1, about: 1 };

test('the Chinese control page says it in the welcome, 「连接一颗大脑」 and the about block, and nowhere else', () => {
  setUiLanguage('zh-CN');
  try {
    const html = renderControls();
    assert.deepEqual(places(html, STANCE_NOTICE), EXPECTED);
    // The welcome line sits after the suggestions, inside the welcome block that the first message removes.
    const welcome = html.slice(html.indexOf('class="welcome"'), html.indexOf('class="composer-wrap"'));
    assert.ok(welcome.indexOf('class="suggestions"') < welcome.indexOf(STANCE_NOTICE));
    assert.match(welcome, /<p class="welcome-note">/);
  } finally { setUiLanguage('zh-CN'); }
});

test('the English control page says the same in English in the same three places', () => {
  setUiLanguage('en');
  try {
    const html = renderControls();
    const english = uiText(STANCE_NOTICE);
    assert.notEqual(english, STANCE_NOTICE, 'an English translation is registered');
    assert.match(english, /not for the model provider \(Anthropic\) or the developers/);
    assert.equal(html.includes(STANCE_NOTICE), false);
    assert.deepEqual(places(html, english), EXPECTED);
  } finally { setUiLanguage('zh-CN'); }
});
