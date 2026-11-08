/**
 * A small fake DOM for the pet window: it parses the real renderPet markup into elements, so the real PetUI and the real
 * panels around it (ReplyReader, ImmersiveNotice, UserProfilePanel, AudioReadingClient, ScreenSharingOptions,
 * MoodCompanion) run against the ids, classes and attributes the app really has. No layout, no CSS: what is "open" is
 * read from the same state the panels set (hidden, dialog open, aria-expanded).
 */
import type { TestContext } from 'node:test';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const decode = (text: string) => text.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const camel = (name: string) => name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

class Style {
  [key: string]: unknown;
  private readonly priorities = new Map<string, string>();
  setProperty(name: string, value: string, priority = ''): void { this[name] = value; this.priorities.set(name, priority); }
  removeProperty(name: string): string { const previous = this.getPropertyValue(name); delete this[name]; this.priorities.delete(name); return previous; }
  getPropertyValue(name: string): string { return typeof this[name] === 'string' ? this[name] as string : ''; }
  getPropertyPriority(name: string): string { return this.priorities.get(name) ?? ''; }
}

type Simple = { tag?: string; id?: string; classes: string[]; attributes: { name: string; value?: string }[]; never: boolean };
type Step = { simple: Simple; combinator: ' ' | '>' };
function parseSelector(selector: string): Step[] {
  const steps: Step[] = [];
  let combinator: ' ' | '>' = ' ';
  for (const token of selector.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/)) {
    if (token === '>') { combinator = '>'; continue; }
    const simple: Simple = { classes: [], attributes: [], never: false };
    for (const part of token.match(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|:[\w-]+(?:\([^)]*\))?|^[\w-]+|\*/g) ?? []) {
      if (part.startsWith('#')) simple.id = part.slice(1);
      else if (part.startsWith('.')) simple.classes.push(part.slice(1));
      else if (part.startsWith('[')) {
        const [, name, value] = /^\[([\w-]+)(?:="?([^"\]]*)"?)?\]$/.exec(part) ?? [];
        simple.attributes.push({ name, value });
      } else if (part.startsWith(':')) simple.never = true; // :hover, :focus-visible … never true here
      else if (part !== '*') simple.tag = part.toLowerCase();
    }
    steps.push({ simple, combinator }); combinator = ' ';
  }
  return steps;
}
function matchesSimple(node: FakeElement, simple: Simple): boolean {
  if (simple.never) return false;
  if (simple.tag && node.tagName !== simple.tag) return false;
  if (simple.id && node.id !== simple.id) return false;
  if (simple.classes.some(name => !node.classList.contains(name))) return false;
  return simple.attributes.every(({ name, value }) => { const actual = node.getAttribute(name); return actual !== null && (value === undefined || actual === value); });
}
function matchesSteps(node: FakeElement, steps: Step[], index = steps.length - 1): boolean {
  if (!matchesSimple(node, steps[index].simple)) return false;
  if (index === 0) return true;
  if (steps[index].combinator === '>') return !!node.parent && matchesSteps(node.parent, steps, index - 1);
  for (let up = node.parent; up; up = up.parent) if (matchesSteps(up, steps, index - 1)) return true;
  return false;
}
const matchesList = (node: FakeElement, selectors: string) => selectors.split(',').some(selector => matchesSteps(node, parseSelector(selector)));

export class FakeElement extends EventTarget {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  id = ''; className = ''; textContent = ''; title = ''; type = ''; value = ''; name = '';
  hidden = false; disabled = false; checked = false; open = false;
  dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  style = new Style();
  rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
  offsetWidth = 0; offsetHeight = 0; offsetTop = 0; offsetParent: FakeElement | null = null;
  scrollTop = 0; clientTop = 0;
  onclick: ((event: Event) => void) | null = null;
  onchange: ((event: Event) => void) | null = null;
  oninput: ((event: Event) => void) | null = null;
  onkeydown: ((event: Event) => void) | null = null;
  onsubmit: ((event: Event) => void) | null = null;
  private readonly captured = new Set<number>();
  readonly classList = {
    add: (...names: string[]) => { for (const name of names) this.classList.toggle(name, true); },
    remove: (...names: string[]) => { for (const name of names) this.classList.toggle(name, false); },
    contains: (name: string) => this.className.split(/\s+/).includes(name),
    toggle: (name: string, force?: boolean) => {
      const names = new Set(this.className.split(/\s+/).filter(Boolean));
      const active = force ?? !names.has(name); if (active) names.add(name); else names.delete(name);
      this.className = [...names].join(' '); return active;
    },
  };
  constructor(readonly ownerDocument: FakeDocument, readonly tagName: string) { super(); }
  get firstElementChild(): FakeElement | null { return this.children[0] ?? null; }
  get parentElement(): FakeElement | null { return this.parent; }
  set innerHTML(markup: string) { this.replaceChildren(...this.ownerDocument.parse(markup)); }
  getAttribute(name: string): string | null {
    if (name === 'id') return this.id || null;
    if (name === 'class') return this.className || null;
    if (name === 'hidden') return this.hidden ? '' : null;
    if (name === 'title') return this.title || null;
    if (name.startsWith('data-')) return this.dataset[camel(name.slice(5))] ?? null;
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean { return this.getAttribute(name) !== null; }
  setAttribute(name: string, value: string): void {
    if (name === 'id') this.id = value; else if (name === 'class') this.className = value; else if (name === 'hidden') this.hidden = true;
    else if (name === 'title') this.title = value; else if (name === 'type') this.type = value; else if (name === 'disabled') this.disabled = true;
    else if (name.startsWith('data-')) this.dataset[camel(name.slice(5))] = value;
    else this.attributes.set(name, value);
  }
  removeAttribute(name: string): void {
    if (name === 'hidden') this.hidden = false; else if (name === 'title') this.title = ''; else if (name === 'disabled') this.disabled = false;
    else if (name.startsWith('data-')) delete this.dataset[camel(name.slice(5))];
    else this.attributes.delete(name);
  }
  append(...nodes: (FakeElement | string)[]): void {
    for (const node of nodes) {
      if (typeof node === 'string') { this.textContent += node; continue; }
      node.remove(); node.parent = this; this.children.push(node);
    }
  }
  prepend(...nodes: FakeElement[]): void { for (const node of [...nodes].reverse()) { node.remove(); node.parent = this; this.children.unshift(node); } }
  replaceChildren(...nodes: FakeElement[]): void { for (const child of this.children) child.parent = null; this.children = []; this.append(...nodes); }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
  before(...nodes: FakeElement[]): void { const parent = this.parent!; for (const node of nodes) { node.remove(); node.parent = parent; parent.children.splice(parent.children.indexOf(this), 0, node); } }
  after(...nodes: FakeElement[]): void { const parent = this.parent!; let at = parent.children.indexOf(this) + 1; for (const node of nodes) { node.remove(); node.parent = parent; parent.children.splice(at++, 0, node); } }
  contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)); }
  matches(selectors: string): boolean { return matchesList(this, selectors); }
  closest(selectors: string): FakeElement | null { for (let node: FakeElement | null = this; node; node = node.parent) if (node.matches(selectors)) return node; return null; }
  querySelectorAll(selectors: string): FakeElement[] { return descendants(this).filter(node => node !== this && node.matches(selectors)); }
  querySelector(selectors: string): FakeElement | null { return this.querySelectorAll(selectors)[0] ?? null; }
  getBoundingClientRect() { return { ...this.rect }; }
  focus(): void { this.ownerDocument.activeElement = this; }
  blur(): void { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }
  /** A real click: nothing on a disabled control; listeners first, then the on-property. */
  click(): void {
    if (this.disabled) return;
    const event = new Event('click', { cancelable: true });
    this.dispatchEvent(event); this.onclick?.(event);
  }
  showModal(): void { this.open = true; }
  close(): void { if (!this.open) return; this.open = false; this.dispatchEvent(new Event('close')); }
  setPointerCapture(pointerId: number): void { this.captured.add(pointerId); }
  hasPointerCapture(pointerId: number): boolean { return this.captured.has(pointerId); }
  releasePointerCapture(pointerId: number): void { this.captured.delete(pointerId); }
}
const descendants = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap(descendants)];

export class FakeDocument extends EventTarget {
  hidden = false;
  activeElement: FakeElement | null = null;
  readonly documentElement: FakeElement;
  readonly body: FakeElement;
  constructor(readonly defaultView: FakeWindow) {
    super();
    this.documentElement = new FakeElement(this, 'html');
    this.body = new FakeElement(this, 'body');
    this.documentElement.append(this.body);
  }
  createElement(tag: string): FakeElement { return new FakeElement(this, tag.toLowerCase()); }
  getElementById(id: string): FakeElement | null { return descendants(this.documentElement).find(node => node.id === id) ?? null; }
  querySelectorAll(selectors: string): FakeElement[] { return this.documentElement.querySelectorAll(selectors); }
  querySelector(selectors: string): FakeElement | null { return this.querySelectorAll(selectors)[0] ?? null; }
  /** Enough HTML for the app's own templates: elements, attributes, text, void and self-closing tags. */
  parse(markup: string): FakeElement[] {
    const root = new FakeElement(this, '#fragment');
    const stack: FakeElement[] = [root];
    for (const match of markup.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g)) {
      const [, closing, rawTag, attributes, selfClosing, text] = match;
      const top = stack[stack.length - 1];
      if (text !== undefined) { top.textContent += decode(text); continue; }
      const tag = rawTag.toLowerCase();
      if (closing) { while (stack.length > 1 && stack.pop()!.tagName !== tag); continue; }
      const element = this.createElement(tag);
      for (const [, name, double, single, bare] of attributes.matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))
        element.setAttribute(name, decode(double ?? single ?? bare ?? ''));
      top.append(element);
      if (!selfClosing && !VOID.has(tag)) stack.push(element);
    }
    const nodes = [...root.children]; for (const node of nodes) node.parent = null;
    return nodes;
  }
}

export interface FakeWindow extends EventTarget {
  innerWidth: number; innerHeight: number;
  desktop: Record<string, (...args: never[]) => unknown>;
  confirm(message: string): boolean;
}

/** Same-window BroadcastChannel stand-in (Node's real one would keep the test process alive). */
class Broadcast {
  static readonly ports = new Set<Broadcast>();
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(readonly name: string) { Broadcast.ports.add(this); }
  postMessage(value: unknown): void { for (const peer of Broadcast.ports) if (peer !== this && peer.name === this.name) peer.onmessage?.({ data: structuredClone(value) } as MessageEvent); }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void { Broadcast.ports.delete(this); this.onmessage = null; }
}

/** Installs a fresh pet window as `document` / `window` for this test and restores the real globals after it. */
export function installPetWindow(t: TestContext, desktop: FakeWindow['desktop'] = {}) {
  const saved = ['document', 'window', 'BroadcastChannel'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const view = Object.assign(new EventTarget(), { innerWidth: 400, innerHeight: 560, desktop, confirm: () => true, performance }) as FakeWindow;
  const document = new FakeDocument(view);
  const app = document.createElement('div'); app.id = 'app'; document.body.append(app);
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: document });
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: view });
  Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, writable: true, value: Broadcast });
  const disposers: (() => void)[] = [];
  t.after(() => {
    try { for (const dispose of disposers.reverse()) dispose(); }
    finally { for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  });
  const byId = (id: string): FakeElement => { const node = document.getElementById(id); if (!node) throw Error(`no #${id} in the pet window`); return node; };
  /** Runs at the end of the test, latest first, while this window is still `document` / `window`. */
  const beforeClose = (dispose: () => void) => { disposers.push(dispose); };
  return { document, window: view, app, byId, beforeClose };
}
