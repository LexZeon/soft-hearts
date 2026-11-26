// The Unbound small input box follows the interface language (the English Mumi's box said "对她说点什么…").
// src/unbound/input.ts is run for real with a stand-in page (a few fake elements); the host's open event carries the language.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createUnboundInputApi, UNBOUND_INPUT_CHANNELS } from '../electron/unbound/input-preload-api';
import { SUBMIT_HINTS } from '../electron/unbound/typing';
import { setUiLanguage, t } from '../shared/foundation/ui-language';

function fakePage(submit: (text: string) => Promise<{ ok: boolean; hint?: string }>) {
  const field = { value: '', placeholder: '', focus() {}, addEventListener() {} };
  const hint = { textContent: '', dataset: {} as Record<string, string> };
  let onOpen: ((language: string) => void) | null = null;
  const callButton = { textContent: '', classList: { toggle() {} }, addEventListener() {} };
  const doc = { title: '', documentElement: { lang: 'zh-CN' }, getElementById: (id: string) => id === 'line' ? field : id === 'call' ? callButton : hint };
  Object.assign(globalThis, {
    document: doc,
    window: { addEventListener() {}, unboundInput: { submit, cancel: async () => {}, call: async () => ({ ok: true, on: false }), onCallState: () => () => {}, onOpen: (cb: (language: string) => void) => { onOpen = cb; return () => {}; } } },
  });
  return { field, hint, callButton, doc, open: (language: string) => onOpen!(language) };
}

test('the box shows its title, placeholder and default hint in the interface language the host sends, and goes back to Chinese for zh-CN', async () => {
  const page = fakePage(async () => ({ ok: true }));
  try {
    await import('../src/unbound/input');
    assert.equal(page.field.placeholder, '对她说点什么…', 'Chinese before the host says anything');
    assert.equal(page.hint.dataset.default, 'Enter 发送 · Esc 关闭');
    page.open('en');
    assert.equal(page.field.placeholder, 'Say something to her…');
    assert.equal(page.hint.dataset.default, 'Enter to send · Esc to close');
    assert.equal(page.doc.title, 'soft hearts · Say something');
    assert.equal(page.doc.documentElement.lang, 'en');
    page.open('zh-CN');
    assert.equal(page.field.placeholder, '对她说点什么…');
    page.open('klingon');
    assert.equal(page.field.placeholder, '对她说点什么…', 'an unknown language changes nothing (stays as it was)');
  } finally { setUiLanguage('zh-CN'); }
});

test('the host\'s open event carries only a short string for the language; anything else is empty', () => {
  const listeners = new Map<string, (event: unknown, value?: unknown) => void>();
  const api = createUnboundInputApi({ invoke: async () => undefined, on: (c, l) => { listeners.set(c, l); }, removeListener: () => {} });
  const got: string[] = []; api.onOpen(language => got.push(language));
  const emit = listeners.get(UNBOUND_INPUT_CHANNELS.open)!;
  emit({}, 'en'); emit({}, 5); emit({}, undefined); emit({}, 'x'.repeat(100));
  assert.deepEqual(got, ['en', '', '', 'x'.repeat(16)]);
});

test('every line the box can show has English: its own and the two the host returns', () => {
  setUiLanguage('en');
  try {
    for (const line of ['没能发出去，再试一次。', SUBMIT_HINTS.unavailable, SUBMIT_HINTS.away])
      assert.match(t(line), /^[\x20-\x7e…·]+$/, `English for: ${line}`);
  } finally { setUiLanguage('zh-CN'); }
});

test('the page file holds no Chinese of its own any more (the words come from the copy tables)', () => {
  const html = readFileSync(new URL('../src/unbound/input.html', import.meta.url), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(html, /[一-鿿]/);
});
