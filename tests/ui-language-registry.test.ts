// The interface-language registry (shared/foundation/ui-languages.ts): the table decides the type, the parser, the
// system-language match and the dropdown; a language added in a test (never in the real table) works through t().
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { currentUiLanguage, parseUiLanguagePreference, registerUiMessages, resolveUiLanguage, setUiLanguage, t, translateUiCopy, type UiLanguage } from '../shared/foundation/ui-language';
import { UI_LANGUAGES, builtInCopy, isUiLanguagePreference, matchSystemLocale, uiLanguageChoices, type UiLanguageEntry } from '../shared/foundation/ui-languages';
import { uiLanguageChoiceRows } from '../src/settings/ui-language-options';

const TABLE: readonly UiLanguageEntry[] = [
  ...UI_LANGUAGES,
  { id: 'xx-TEST', label: 'Testish', matchLocale: /^xx(?:[-_]|$)/i, copy: { '显示桌宠': 'Testish show' } },
];

test('the real table holds Chinese (the source, no copy) and English, and nothing else', () => {
  assert.deepEqual(UI_LANGUAGES.map(entry => entry.id), ['zh-CN', 'en']);
  assert.equal(builtInCopy('zh-CN'), undefined);
  assert.equal(builtInCopy('en')?.['显示桌宠'], 'Show companion');
});

test('a language added to a table is accepted by the parser, the system match and the dropdown choices', () => {
  assert.equal(isUiLanguagePreference('xx-TEST', TABLE), true);
  assert.equal(isUiLanguagePreference('xx-TEST'), false);
  assert.equal(isUiLanguagePreference('system', TABLE), true);
  assert.equal(matchSystemLocale('xx-YY', TABLE), 'xx-TEST' as UiLanguage);
  assert.equal(matchSystemLocale('xx-YY'), 'en');
  assert.equal(matchSystemLocale('zh-TW', TABLE), 'zh-CN');
  assert.deepEqual(uiLanguageChoices(TABLE).map(choice => choice.value), ['zh-CN', 'en', 'xx-TEST']);
  assert.throws(() => parseUiLanguagePreference('xx-TEST'));
});

test('t() finds a language that only has a dictionary registered, and untranslated copy falls back to Chinese', () => {
  registerUiMessages({ 'zh-CN': { 'fixture.slot': '中文源文' } });
  registerUiMessages({ ['xx-TEST' as UiLanguage]: { 'fixture.hello': 'Hello {name}' } });
  setUiLanguage('xx-TEST' as UiLanguage);
  try {
    assert.equal(currentUiLanguage(), 'xx-TEST');
    assert.equal(t('fixture.hello', { name: 'A' }), 'Hello A');
    assert.equal(t('fixture.slot'), '中文源文');
    assert.equal(t('完全没翻的字'), '完全没翻的字');
  } finally { setUiLanguage('zh-CN'); }
});

test('translateUiCopy uses the given dictionary for any language except the source', () => {
  assert.equal(translateUiCopy('en', '你好', { '你好': 'Hi' }), 'Hi');
  assert.equal(translateUiCopy('xx-TEST' as UiLanguage, '你好', { '你好': 'Hi' }), 'Hi');
  assert.equal(translateUiCopy('zh-CN', '你好', { '你好': 'Hi' }), '你好');
});

test('the settings dropdown lists "follow system" and every registered language, in registry order', () => {
  setUiLanguage('zh-CN');
  assert.deepEqual(uiLanguageChoiceRows().map(row => [row.value, row.label]),
    [['system', '跟随系统'], ...UI_LANGUAGES.map(entry => [entry.id, entry.label])]);
  setUiLanguage('en');
  try { assert.equal(uiLanguageChoiceRows()[0].label.length > 0 && uiLanguageChoiceRows()[0].label !== '跟随系统', true); }
  finally { setUiLanguage('zh-CN'); }
});

test('the first-paint options in layout.ts are rows of the registry (the control window rebuilds them from the registry on mount)', () => {
  const layout = readFileSync(new URL('../src/settings/layout.ts', import.meta.url), 'utf8');
  const select = layout.match(/<select id="ui-language"[^>]*>(.*?)<\/select>/)?.[1] ?? '';
  const rows = [...select.matchAll(/<option value="([^"]+)">([^<]*)<\/option>/g)].map(match => ({ value: match[1], label: match[2] }));
  assert.ok(rows.length >= 2);
  for (const row of rows) {
    if (row.value === 'system') continue;
    assert.deepEqual(uiLanguageChoiceRows().find(choice => choice.value === row.value), row);
  }
});

test('resolveUiLanguage keeps its old answers on the real table', () => {
  for (const locale of ['zh', 'zh-CN', 'zh_TW', 'ZH-Hans-SG']) assert.equal(resolveUiLanguage('system', locale), 'zh-CN');
  for (const locale of ['en-US', 'ja-JP', '', 'zhang']) assert.equal(resolveUiLanguage('system', locale), 'en');
});
