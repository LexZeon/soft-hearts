import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ChatSettingCardView } from '../shared/chat-settings';
import { CHAT_SETTING_LEAVE_MS, ChatSettingCards, renderChatSettingCard } from '../src/ui/ChatSettingCard';
import { setUiLanguage } from '../shared/ui-language';

setUiLanguage('zh-CN');

/**
 * R46.
 * On the pet the card vanished the moment it settled: its chat area was kept
 * visible only by an open/busy card, so the tap faded the whole area in 0.18 s,
 * and the card was cut out 8 s later. Now a settled card folds into its
 * one-line result, stays readable for a while, fades out and only then goes.
 */
class Element {
  children: Element[] = []; className = ''; textContent: string | null = ''; type = ''; disabled = false;
  dataset: Record<string, string> = {}; attributes = new Map<string, string>(); parent: Element | null = null;
  onclick: (() => void) | null = null;
  constructor(readonly tagName: string) {}
  append(...children: Element[]) { for (const child of children) { child.parent = this; this.children.push(child); } }
  prepend(...children: Element[]) { for (const child of children) child.parent = this; this.children.unshift(...children); }
  replaceWith(next: Element) { const list = this.parent!.children; list[list.indexOf(this)] = next; next.parent = this.parent; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
}
const doc = { createElement: (tag: string) => new Element(tag) } as unknown as Document;
const all = (root: Element): Element[] => [root, ...root.children.flatMap(all)];
const view = (patch: Partial<ChatSettingCardView> = {}): ChatSettingCardView => ({ kind: 'chat-setting-card', version: 1, proposalId: 'p1', replyId: 'r1',
  settingId: 'readout_volume', label: '朗读音量', current: '默认 80%', proposed: '小声 30%', reason: '有点吵', confirm: false, state: 'open',
  choices: [{ choiceId: 'c0', label: '小声 30%', proposed: true, current: false }], ...patch });
const APPLIED = '由 Claude 操作：已把「朗读音量」改为 小声 30%。随时可以在设置里改回。';

function fakeTimers() {
  let now = 0, next = 0;
  const pending = new Map<number, { at: number; run: () => void }>();
  return {
    set: (run: () => void, ms: number) => { pending.set(++next, { at: now + ms, run }); return next; },
    clear: (handle: unknown) => { pending.delete(handle as number); },
    advance(ms: number) {
      now += ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) return;
        pending.delete(due[0]); due[1].run();
      }
    },
  };
}

test('R46: a settled card keeps its details only in a folded, hidden part and shows one result line', () => {
  const open = renderChatSettingCard(view(), doc, () => {}) as unknown as Element;
  const openFold = all(open).find(node => node.className === 'chat-setting-card__fold');
  assert.ok(openFold, 'title, change, reason and buttons live in a fold');
  assert.equal(openFold.attributes.get('aria-hidden'), undefined);
  const settled = renderChatSettingCard(view({ state: 'applied', message: APPLIED }), doc, () => assert.fail('inert')) as unknown as Element;
  const fold = all(settled).find(node => node.className === 'chat-setting-card__fold')!;
  assert.equal(fold.attributes.get('aria-hidden'), 'true', 'the folded details are hidden from assistive tech');
  assert.ok(all(fold).some(node => node.tagName === 'button'), 'the buttons fold away with them');
  const lines = all(settled).filter(node => node.attributes.get('role') === 'status');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].textContent, APPLIED);
  assert.ok(!all(fold).includes(lines[0]), 'the result line stays outside the fold');
});

test('R46: on the pet a settled card stays readable, then fades, then is removed; in the chat log it stays as one line', async () => {
  const timers = fakeTimers();
  const pet = new Element('div');
  let release!: (value: ChatSettingCardView) => void;
  const cards = new ChatSettingCards({ container: () => pet as unknown as HTMLElement, prepend: true, settledLifetimeMs: 4_500, timers,
    choose: () => new Promise(resolve => { release = resolve; }) }, doc);
  cards.present(view());
  all(pet).find(node => node.tagName === 'button')!.onclick!();
  release(view({ state: 'applied', message: APPLIED }));
  await new Promise(resolve => setImmediate(resolve));
  const card = () => pet.children[0];
  assert.equal(card()?.dataset.state, 'applied');
  timers.advance(4_499);
  assert.equal(card()?.dataset.leaving, undefined, 'still readable');
  timers.advance(1);
  assert.equal(card()?.dataset.leaving, 'true', 'fading out, not cut');
  timers.advance(CHAT_SETTING_LEAVE_MS - 1);
  assert.equal(pet.children.length, 1, 'removed only after the fade');
  timers.advance(1);
  assert.equal(pet.children.length, 0);

  const log = new Element('div');
  const kept = new ChatSettingCards({ container: () => log as unknown as HTMLElement, timers, choose: async () => view({ state: 'cancelled', message: '已取消，设置没有改。' }) }, doc);
  kept.present(view());
  all(log).find(node => node.tagName === 'button')!.onclick!();
  await new Promise(resolve => setImmediate(resolve));
  timers.advance(60_000);
  assert.equal(log.children.length, 1, 'the chat log keeps the one-line result');
  assert.equal(log.children[0].dataset.leaving, undefined);
  assert.equal(all(log).find(node => node.attributes.get('role') === 'status')!.textContent, '已取消，设置没有改。');
  kept.clear(); cards.clear();
});

test('R46: the pet chat area stays up while any card is shown, the fold animates, and reduced motion skips it', () => {
  const css = readFileSync(new URL('../src/ui/chat-setting-card.css', import.meta.url), 'utf8');
  assert.match(css, /\.pet-chat:has\(\.chat-setting-card\)\s*\{[^}]*opacity:\s*1/, 'a settled or leaving card no longer drops the chat area at once');
  assert.match(css, /@keyframes\s+chat-setting-fold/);
  assert.match(css, /\[data-leaving="true"\][^{]*\{[^}]*opacity:\s*0[^}]*transition:[^}]*opacity\s*\.6s/, `fade length matches CHAT_SETTING_LEAVE_MS (${CHAT_SETTING_LEAVE_MS} ms)`);
  assert.equal(CHAT_SETTING_LEAVE_MS, 600);
  assert.match(css, /prefers-reduced-motion/);
});
