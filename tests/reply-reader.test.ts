import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyReader } from '../src/ui/ReplyReader';
import { PetUI, renderPet } from '../src/ui/PetUI';
import { isPetControlPoint } from '../src/ui/MoodCompanion';
import { ReplySpeechState } from '../src/ui/reply-speech';
import { ReplyPresentationState } from '../src/ui/reply-presentation';
import { registerUiMessages, setUiLanguage } from '../shared/ui-language';
import { ENGLISH_TASKS_UI_COPY } from '../shared/ui-copy.tasks.en';

function readerFixture() {
  let changed = 0;
  const listeners = new Map<string, () => void>();
  const dialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; listeners.get('close')?.(); }, addEventListener: (name: string, fn: () => void) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name) };
  const body = { textContent: '', scrollTop: 0, focus() {} };
  const trigger = { disabled: false, onclick: null }, close = { onclick: null }, status = { textContent: '' };
  const reader = new ReplyReader(dialog as unknown as HTMLDialogElement, body as unknown as HTMLElement, trigger as unknown as HTMLButtonElement, close as unknown as HTMLButtonElement, status as unknown as HTMLElement, () => changed++);
  return { reader, body, dialog, trigger, status, changed: () => changed };
}

test('English reader status preserves the exact private reply through updates and clear', () => {
  registerUiMessages({ en: ENGLISH_TASKS_UI_COPY, 'zh-CN': {} }); setUiLanguage('en');
  const f = readerFixture(), privateReply = '可滚动阅读或选中文字复制'.repeat(1000);
  try {
    f.reader.update(privateReply, true);
    assert.equal(f.status.textContent, 'Generating · Scroll up to read');
    f.reader.open(); assert.equal(f.body.textContent, privateReply);
    f.reader.update(privateReply, false);
    assert.equal(f.status.textContent, 'Scroll to read or select text to copy');
    assert.equal(f.body.textContent, privateReply);
    f.reader.clear(); assert.equal(f.body.textContent, '');
  } finally { f.reader.dispose(); setUiLanguage('zh-CN'); }
});

test('the actual reader markup reserves the existing mood input region only while open', () => {
  const app = {innerHTML:''}; renderPet(app as unknown as HTMLElement);
  assert.match(app.innerHTML,/<dialog[^>]+id="pet-reply-reader"[^>]+data-mood-ui/);
  let open = false;
  const node = {getBoundingClientRect:()=>open ? {left:50,top:60,right:300,bottom:460,width:250,height:400} : {left:0,top:0,right:0,bottom:0,width:0,height:0}};
  const owner = {querySelectorAll:(selector:string)=>selector.includes('[data-mood-ui]')?[node]:[]};
  const point = ()=>isPetControlPoint(owner as unknown as Pick<Document,'querySelectorAll'>,100,120);
  assert.equal(point(),false); open=true; assert.equal(point(),true); open=false; assert.equal(point(),false);
});

test('full reader preserves a 90000-unit reply including code and markup as text, independent of bubble TTL', () => {
  const f = readerFixture(), raw = ('这是第一句。这是第二句。\n```js\nconst value = "<script> & 演示";\n```\n').repeat(1500);
  f.reader.update(raw, true); assert.equal(f.trigger.disabled, false);
  f.reader.open(); assert.equal(f.dialog.open, true); assert.equal(f.body.textContent, raw);
  f.body.scrollTop = 350;
  f.reader.update(raw + '最后一句。', false);
  assert.equal(f.body.textContent, raw + '最后一句。'); assert.equal(f.body.scrollTop, 350);
  assert.match(f.status.textContent, /复制/); assert.equal(f.changed(), 1);
  f.reader.clear(); assert.equal(f.dialog.open, false); assert.equal(f.body.textContent, ''); assert.equal(f.trigger.disabled, true);
  f.reader.open(); assert.equal(f.dialog.open, false);
});

test('reader new reply replaces the old body, clears on hide, and retains no content after dispose', () => {
  const f = readerFixture(); f.reader.update('旧回复', false); f.reader.open(); f.reader.clear();
  f.reader.update('新回复', true); assert.equal(f.body.textContent, ''); f.reader.open(); assert.equal(f.body.textContent, '新回复');
  f.reader.dispose(); assert.equal(f.dialog.open, false); assert.equal(f.trigger.disabled, true); assert.equal(f.body.textContent, '');
});

test('suppressing an accepted reply prevents restored late text/done from replaying until the next ID', () => {
  const state = new ReplyPresentationState(); state.begin('first'); assert.equal(state.canPresent('first'), true);
  state.content('first', '第一句'); state.suppressWaiting();
  state.content('first', '第一句。迟到句。'); assert.equal(state.canPresent('first'), false);
  assert.equal(state.begin('first'), false); assert.equal(state.canPresent('first'), false);
  state.close('first'); assert.equal(state.canPresent('first'), false);
  state.begin('second'); assert.equal(state.canPresent('second'), true); assert.equal(state.canPresent('first'), false);
});

test('ordinary PetUI preview follows the tail while its body/reader retain raw text; proactive literal proof is unchanged', () => {
  const originalDocument = globalThis.document, originalWindow = globalThis.window;
  const body = { textContent: '', classList: { remove() {} } }, updates: {text?: string; state?: string}[] = [];
  const f = readerFixture();
  globalThis.document = { getElementById: (id: string) => id === 'pet-answer-body' ? body : null } as unknown as Document;
  globalThis.window = { desktop: { updatePetReply: async (patch: {text?: string; state?: string}) => { updates.push(patch); } } } as unknown as Window & typeof globalThis;
  const ui = Object.create(PetUI.prototype) as PetUI;
  Object.assign(ui, { replySpeech: new ReplySpeechState(), replyReader: f.reader, anchor: {x:1,y:1,visible:true}, interactionProgress: 0, actions: { error(message: string) { assert.fail(message); } } });
  try {
    const raw = '第一句。第二句。'.repeat(6000) + '结尾完整可见。';
    ui.beginAnswer('ordinary'); ui.showAnswer('第一句。', true, 'ordinary', true); ui.showAnswer(raw, true, 'ordinary', true);
    assert.equal(body.textContent, raw); assert.ok(updates.at(-1)!.text!.length <= 32000); assert.match(updates.at(-1)!.text!, /结尾完整可见。$/);
    f.reader.open(); assert.equal(f.body.textContent, raw);
    ui.finishAnswer(raw, 'ordinary', false, false, true); assert.equal(f.body.textContent, raw);
    ui.hideAnswer(); assert.equal(f.dialog.open, false); assert.equal(f.body.textContent, '');
    ui.showAnswer(raw, true, 'one-chunk', true);
    assert.ok(updates.at(-1)!.text!.startsWith('第一句。'), 'a single long provider chunk starts with its first sentence');
    const firstPreview = updates.at(-1)!.text;
    ui.finishAnswer(raw, 'one-chunk', false, false, true); assert.equal(updates.at(-1)!.text, firstPreview, 'done does not jump to an unread tail');
    ui.hideAnswer(); const beforeRestore = updates.length;
    ui.refreshAnswerReader(raw, false); f.reader.open(); assert.equal(f.body.textContent, raw);
    assert.equal(updates.length, beforeRestore, 'manual reader restoration never revives the bubble');
    const literal = '来自屏幕：第一句。第二句。';
    ui.showAnswer(literal, true, 'vision'); assert.equal(updates.at(-1)!.text, literal);
    const count = updates.length; ui.finishAnswer(literal, 'vision', false, true);
    assert.equal(updates.length, count + 1); assert.equal(updates.at(-1)!.text, undefined, 'same-ID literal completion preserves nonce');
  } finally { globalThis.document = originalDocument; globalThis.window = originalWindow; }
});
