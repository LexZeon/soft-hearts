import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReplyWaiting, WAITING_DOTS_CSS } from '../shared/reply-waiting-presentation';

class Classes {
  readonly names = new Set<string>();
  add(...names: string[]): void { names.forEach(name => this.names.add(name)); }
  remove(...names: string[]): void { names.forEach(name => this.names.delete(name)); }
  contains(name: string): boolean { return this.names.has(name); }
}
class Element {
  id = '';
  readonly classList = new Classes();
  readonly attributes = new Map<string, string>();
  children: Element[] = [];
  replacements = 0;
  private text = '';
  constructor(readonly tagName: string, readonly ownerDocument: DocumentFixture) {}
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  append(...children: Element[]): void { this.children.push(...children); }
  replaceChildren(...children: Element[]): void { this.replacements++; this.text = ''; this.children = children; }
}
class DocumentFixture {
  readonly head = new Element('HEAD', this);
  readonly body = new Element('BODY', this);
  createElement(tag: string): Element { return new Element(tag.toUpperCase(), this); }
  getElementById(id: string): Element | null {
    const visit = (element: Element): Element | null => element.id === id ? element : element.children.map(visit).find(Boolean) ?? null;
    return visit(this.head) ?? visit(this.body);
  }
  target(): Element { const target = this.createElement('div'); this.body.append(target); return target; }
}
const render = (element: Element, waiting: boolean) => renderReplyWaiting(element as unknown as HTMLElement, waiting);

test('waiting presentation exposes one readable status and three decorative dots without chat text', () => {
  const document = new DocumentFixture(), element = document.target();
  element.textContent = 'Previous reply';
  render(element, true);
  assert.equal(element.textContent, '');
  assert.equal(element.children.length, 3);
  assert.ok(element.children.every(dot => dot.tagName === 'SPAN' && dot.getAttribute('aria-hidden') === 'true'));
  assert.ok(element.classList.contains('reply-waiting'));
  assert.equal(element.getAttribute('role'), 'status');
  assert.equal(element.getAttribute('aria-label'), '正在等待回复');
  assert.equal(element.getAttribute('aria-live'), 'polite');
  assert.equal(document.head.children.length, 1);
  assert.equal(document.head.children[0].textContent, WAITING_DOTS_CSS);
});

test('native layout repaints preserve dot nodes and both surfaces share one stylesheet per document', () => {
  const document = new DocumentFixture(), element = document.target(), second = document.target();
  render(element, true);
  const nodes = [...element.children], replacements = element.replacements, style = document.head.children[0];
  for (let frame = 0; frame < 120; frame++) render(element, true);
  assert.equal(element.replacements, replacements);
  assert.deepEqual(element.children, nodes);
  render(second, true);
  assert.equal(document.head.children.length, 1);
  assert.equal(document.head.children[0], style);
});

test('first text removes waiting decoration and restores the original accessibility attributes', () => {
  const document = new DocumentFixture(), element = document.target();
  element.classList.add('message-body');
  element.setAttribute('role', 'article');
  element.setAttribute('aria-label', 'Reply');
  element.setAttribute('aria-describedby', 'label');
  render(element, true); render(element, false);
  assert.equal(element.children.length, 0);
  assert.ok(!element.classList.contains('reply-waiting'));
  assert.ok(element.classList.contains('message-body'));
  assert.equal(element.getAttribute('role'), 'article');
  assert.equal(element.getAttribute('aria-label'), 'Reply');
  assert.equal(element.getAttribute('aria-live'), null);
  assert.equal(element.getAttribute('aria-describedby'), 'label');
  element.textContent = 'First visible text';
  const replacements = element.replacements;
  render(element, false);
  assert.equal(element.textContent, 'First visible text');
  assert.equal(element.replacements, replacements);
});

test('ordinary replies are unchanged and a later request gets fresh dots without accumulating styles', () => {
  const document = new DocumentFixture(), element = document.target();
  element.textContent = 'Completed answer';
  render(element, false);
  assert.equal(element.textContent, 'Completed answer');
  assert.equal(element.replacements, 0);
  assert.equal(document.head.children.length, 0);
  render(element, true); const firstDots = [...element.children]; render(element, false);
  render(element, true);
  assert.equal(element.children.length, 3);
  assert.notEqual(element.children[0], firstDots[0]);
  assert.equal(document.head.children.length, 1);
  render(element, false);
  assert.equal(element.getAttribute('role'), null);
  assert.equal(element.getAttribute('aria-label'), null);
  assert.equal(element.getAttribute('aria-live'), null);
});
