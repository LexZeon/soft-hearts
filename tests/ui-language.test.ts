import assert from 'node:assert/strict';
import test from 'node:test';
import { currentUiLanguage, parseUiLanguagePreference, registerUiMessages, resolveUiLanguage, setUiLanguage, t } from '../shared/ui-language';
import { uiHtml } from '../src/ui/ui-language';
import { conciseFailure } from '../src/notice-policy';

test('system locale resolves Chinese families and otherwise English without changing preference', () => {
  for (const locale of ['zh', 'zh-CN', 'zh_TW', 'ZH-Hans-SG']) assert.equal(resolveUiLanguage('system', locale), 'zh-CN');
  for (const locale of ['en-US', 'ja-JP', 'de-DE', '', 'zhang']) assert.equal(resolveUiLanguage('system', locale), 'en');
  assert.equal(resolveUiLanguage('en', 'zh-CN'), 'en');
  assert.equal(resolveUiLanguage('zh-CN', 'en-US'), 'zh-CN');
  for (const invalid of [null, {}, [], true, 1, 'EN', 'auto', '../en']) assert.throws(() => parseUiLanguagePreference(invalid));
});

test('English and Chinese interchange; missing keys keep readable source', () => {
  setUiLanguage('en');
  assert.equal(t('显示桌宠'), 'Show companion');
  assert.equal(t('未译固定文案'), '未译固定文案');
  registerUiMessages({ en: {}, 'zh-CN': { 'fixture.missing': '中文回退' } });
  assert.equal(t('fixture.missing'), '中文回退');
  setUiLanguage('zh-CN');
  assert.equal(t('显示桌宠'), '显示桌宠');
  assert.equal(currentUiLanguage(), 'zh-CN');
});

test('markup translates fixed visible and accessible copy without touching IDs, values or inserted private data', () => {
  setUiLanguage('en');
  const privateText = '显示桌宠';
  const markup = uiHtml`<button id="显示桌宠" data-event="显示桌宠" title="显示桌宠" aria-label="显示桌宠">显示桌宠</button><input value="显示桌宠" placeholder="和我说点什么…" /><p>${privateText}</p>`;
  assert.match(markup, /id="显示桌宠" data-event="显示桌宠" title="Show companion" aria-label="Show companion">Show companion/);
  assert.match(markup, /value="显示桌宠" placeholder="Say something…"/);
  assert.match(markup, /<p>显示桌宠<\/p>/);
  setUiLanguage('zh-CN');
});

test('long private placeholder values are preserved exactly and never become another translation key', () => {
  registerUiMessages({ en: { 'fixture.long': 'Selected: {name}' }, 'zh-CN': { 'fixture.long': '已选：{name}' } });
  const name = '显示桌宠'.repeat(1000) + '{name}';
  setUiLanguage('en');
  assert.equal(t('fixture.long', { name }), `Selected: ${name}`);
  assert.equal(t('fixture.long'), 'Selected: {name}');
  setUiLanguage('zh-CN');
  assert.equal(t('fixture.long', { name }), `已选：${name}`);
});

test('translated failures retain their network, saved-input and setup guidance categories',()=>{
 setUiLanguage('en');
 assert.equal(conciseFailure('ECONNREFUSED fixture'), 'The connection is unavailable. Check the service and try again.');
 assert.equal(conciseFailure('Some speech was not fully processed. The original text is kept in the input box.'), 'This input did not finish processing. The original text is kept so you can try again.');
 assert.equal(conciseFailure('Choose a chat model in Connection & voice first'), 'Choose a connection and model in settings first.');
 setUiLanguage('zh-CN');
 assert.equal(conciseFailure('部分语音未完成处理，原文已保留在输入框。'), '这段输入未处理完，原文已保留，可重试。');
});
