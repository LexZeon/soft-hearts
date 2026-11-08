import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatSettingCardView } from '../shared/chat-settings';
import { ChatSettingCards, readChatSettingCard, renderChatSettingCard } from '../src/ui/ChatSettingCard';
import { setUiLanguage } from '../shared/ui-language';

setUiLanguage('zh-CN');

// Renderer card: plain host data → DOM with textContent only; no markup is read or written.

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
  get innerHTML(): string { throw new Error('the card never reads or writes markup'); }
  set innerHTML(_value: string) { throw new Error('the card never reads or writes markup'); }
}
const doc = { createElement: (tag: string) => new Element(tag) } as unknown as Document;
const all = (root: Element): Element[] => [root, ...root.children.flatMap(all)];
const view = (patch: Partial<ChatSettingCardView> = {}): ChatSettingCardView => ({ kind: 'chat-setting-card', version: 1, proposalId: 'p1', replyId: 'r1',
  settingId: 'readout_volume', label: '朗读音量', current: '默认 80%', proposed: '小声 30%', reason: '', confirm: false, state: 'open',
  choices: [{ choiceId: 'c0', label: '小声 30%', proposed: true, current: false }, { choiceId: 'c1', label: '适中 60%', proposed: false, current: false }], ...patch });

test('the card renders host data as plain text only, with a cancel button and a confirm note', () => {
  const evil = '<img src=x onerror="alert(1)">';
  const chosen: string[] = [];
  const root = renderChatSettingCard(view({ reason: evil, label: `<b>${evil}</b>`, confirm: true }), doc, id => chosen.push(id)) as unknown as Element;
  const texts = all(root).map(node => node.textContent).filter(Boolean) as string[];
  assert.ok(texts.includes(evil), 'reason shown verbatim as text');
  assert.ok(texts.some(text => text.includes(`「<b>${evil}</b>」`)));
  assert.ok(texts.includes('点选后还会弹出确认框。'));
  const buttons = all(root).filter(node => node.tagName === 'button');
  assert.deepEqual(buttons.map(button => button.textContent), ['小声 30%（建议）', '适中 60%', '取消']);
  buttons[1].onclick!(); buttons[2].onclick!();
  assert.deepEqual(chosen, ['c1', 'cancel']);
  const settled = renderChatSettingCard(view({ state: 'applied', message: '由 Claude 操作：已把「朗读音量」改为 适中 60%。' }), doc, () => assert.fail('inert')) as unknown as Element;
  for (const button of all(settled).filter(node => node.tagName === 'button')) { assert.equal(button.disabled, true); button.onclick!(); }
  assert.equal(all(settled).find(node => node.attributes.get('role') === 'status')!.textContent, '由 Claude 操作：已把「朗读音量」改为 适中 60%。');
});

test('malformed card data is ignored before any DOM work', () => {
  assert.ok(readChatSettingCard(view()));
  for (const bad of [null, [], { ...view(), kind: 'other' }, { ...view(), state: 'hacked' }, { ...view(), choices: [] },
    { ...view(), choices: Array(5).fill(view().choices[0]) }, { ...view(), choices: [{ choiceId: 'cancel', label: 'x', proposed: true, current: false }] },
    { ...view(), proposalId: 5 }, { ...view(), confirm: 'yes' }, { ...view(), reason: undefined }])
    assert.equal(readChatSettingCard(bad), null);
});

test('cards: one tap per card, buttons disabled while the host answers, newest card is the only live one', async () => {
  const container = new Element('div');
  let release!: (value: ChatSettingCardView) => void;
  const requests: unknown[] = [];
  const cards = new ChatSettingCards({ container: () => container as unknown as HTMLElement,
    choose: request => { requests.push(request); return new Promise(resolve => { release = resolve; }); } }, doc);
  cards.present(view());
  cards.present({ ...view(), proposalId: 'unknown', state: 'applied' }); // An update for a card never shown.
  assert.equal(container.children.length, 1);
  const button = () => all(container).filter(node => node.tagName === 'button');
  button()[0].onclick!();
  assert.ok(button().every(item => item.disabled), 'disabled while applying');
  button()[1].onclick!();
  assert.deepEqual(requests, [{ proposalId: 'p1', choiceId: 'c0' }], 'one request only');
  release(view({ state: 'applied', message: '由 Claude 操作：已把「朗读音量」改为 小声 30%。' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(container.children[0].dataset.state, 'applied');
  cards.present(view({ proposalId: 'p2' }));
  cards.present(view({ proposalId: 'p3' }));
  assert.deepEqual(container.children.map(node => node.dataset.state), ['applied', 'expired', 'open']);
  cards.clear(); assert.equal(container.children.length, 0);
});
