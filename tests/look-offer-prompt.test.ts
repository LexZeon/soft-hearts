// 屏幕只读大概：她问"要我凑近看看吗"时，桌宠聊天区弹一个小确认框
// "让她看清楚屏幕吗？"（看吧 / 不用），样子和她别的卡片一致，登记在 I-028 的浮窗登记表里。假的窗口，不碰宿主。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installPetWindow, type FakeElement } from './helpers/pet-window-dom';
import { LOOK_OFFER_MESSAGE, LOOK_OFFER_NO, LOOK_OFFER_QUESTION, LOOK_OFFER_YES, LookOfferPrompt, lookOfferContent, readLookOffer } from '../src/ui/LookOfferPrompt';
import { PET_FLOATING_NOT_POPUPS, PET_POPUPS } from '../src/ui/pet-popups';
import { ENGLISH_UI_COPY } from '../shared/ui-copy.en';

const ID = '0f8d7c6b-5a49-4382-9170-6e5d4c3b2a19';

function prompt(t: import('node:test').TestContext) {
  const dom = installPetWindow(t);
  const chat = dom.document.createElement('div'); chat.className = 'pet-chat'; dom.app.append(chat);
  const calls: string[] = [];
  const timers = new Map<number, () => void>(); let sequence = 0;
  const ui = new LookOfferPrompt({
    container: () => chat as unknown as HTMLElement,
    look: () => calls.push('look'),
    decline: id => calls.push(`decline:${id}`),
    timers: { set: (callback, ms) => { const id = ++sequence; timers.set(id, callback); calls.push(`timer:${ms}`); return id; }, clear: id => { timers.delete(id as number); } },
  }, dom.document as unknown as Document);
  const card = () => chat.querySelector('.look-offer-card');
  const buttons = () => (card()?.querySelectorAll('button') ?? []) as FakeElement[];
  return { ui, chat, calls, timers, card, buttons };
}

test('邀请来了：聊天区最上面一个小框，问"让她看清楚屏幕吗？"，两个按钮"看吧""不用"', t => {
  const p = prompt(t);
  p.ui.present({ id: ID, ttlMs: 600_000 });
  assert.equal(p.ui.isOpen, true);
  const card = p.card()!;
  assert.equal(p.chat.children[0], card, 'first in the pet chat, above the input');
  assert.equal(card.querySelector('.look-offer-card__question')!.textContent, LOOK_OFFER_QUESTION);
  assert.equal(LOOK_OFFER_QUESTION, '让她看清楚屏幕吗？');
  assert.deepEqual(p.buttons().map(button => button.textContent), [LOOK_OFFER_YES, LOOK_OFFER_NO]);
  assert.deepEqual([LOOK_OFFER_YES, LOOK_OFFER_NO], ['看吧', '不用']);
  assert.equal(p.buttons()[0]!.className.includes('is-proposed'), true);
  assert.equal(card.getAttribute('role'), 'group');
  assert.ok(p.calls.includes('timer:600000'), 'it goes when her offer runs out');
});

test('点"看吧"：收起框，像"给她看看屏幕"一样发（空着发"看吧。"）；点"不用"：收起框，告诉宿主这一个邀请的 id', t => {
  const p = prompt(t);
  p.ui.present({ id: ID, ttlMs: 1000 });
  p.buttons()[0]!.click();
  assert.equal(p.ui.isOpen, false);
  assert.equal(p.card(), null);
  assert.deepEqual(p.calls.filter(call => !call.startsWith('timer')), ['look']);
  assert.equal(lookOfferContent(''), LOOK_OFFER_MESSAGE);
  assert.equal(lookOfferContent('  这里怎么改 '), '这里怎么改', 'what the user typed goes instead');
  p.ui.present({ id: ID, ttlMs: 1000 });
  const stale = p.buttons()[1]!;
  stale.click();
  assert.deepEqual(p.calls.filter(call => !call.startsWith('timer')), ['look', `decline:${ID}`]);
  assert.equal(p.ui.isOpen, false);
  stale.click();
  assert.equal(p.calls.filter(call => call.startsWith('decline')).length, 1, 'a button of a prompt already gone does nothing');
});

test('宿主说关（被回答、换对话、关共享）、邀请过期、新邀请替换旧的：框跟着走；格式不对的忽略', t => {
  const p = prompt(t);
  p.ui.present({ id: ID, ttlMs: 1000 });
  p.ui.present(null);
  assert.equal(p.card(), null);
  p.ui.present({ id: ID, ttlMs: 1000 });
  const [expire] = [...p.timers.values()];
  expire!();
  assert.equal(p.ui.isOpen, false, 'her offer ran out');
  p.ui.present({ id: ID, ttlMs: 1000 });
  const other = 'a1b2c3d4-0000-4000-8000-000000000000';
  p.ui.present({ id: other, ttlMs: 1000 });
  assert.equal(p.chat.querySelectorAll('.look-offer-card').length, 1, 'one prompt at a time');
  assert.equal(p.ui.offerId, other);
  for (const bad of [undefined, 'x', [], { id: 'not an id!', ttlMs: 1 }, { id: ID }, { id: ID, ttlMs: -1 }, { id: ID, ttlMs: 1, extra: true }]) {
    assert.equal(readLookOffer(bad), undefined, JSON.stringify(bad));
    p.ui.present(bad);
    assert.equal(p.ui.offerId, other, 'ignored');
  }
  assert.deepEqual(readLookOffer({ id: ID, ttlMs: 99_999_999 }), { id: ID, ttlMs: 600_000 }, 'never longer than her offer');
  p.ui.dispose();
  assert.equal(p.card(), null);
  p.ui.present({ id: ID, ttlMs: 1000 });
  assert.equal(p.card(), null, 'disposed');
});

test('登记在 I-028 的浮窗登记表里（她在对话里问的话：收起工具栏不替你回答）；样子和她的卡片一致；中英文都有', () => {
  const entry = PET_FLOATING_NOT_POPUPS['look-offer'];
  assert.ok(entry, 'registered');
  assert.deepEqual(entry.sources, ['src/ui/LookOfferPrompt.ts']);
  assert.ok(!Object.values(PET_POPUPS).some(popup => (popup.sources as readonly string[]).includes('src/ui/LookOfferPrompt.ts')));
  const css = readFileSync(new URL('../src/ui/look-button.css', import.meta.url), 'utf8');
  assert.match(css, /\.look-offer-card \{[^}]*border-radius: 12px; background: #1b2830f2;/u, 'the same card look as chat-setting-card.css');
  assert.match(css, /\.pet-chat:has\(\.look-offer-card\) \{ opacity: 1; pointer-events: auto;/u, 'the chat area stays up while it is there');
  for (const text of [LOOK_OFFER_QUESTION, LOOK_OFFER_YES, LOOK_OFFER_NO, LOOK_OFFER_MESSAGE]) assert.ok(ENGLISH_UI_COPY[text], text);
});
