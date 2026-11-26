// 2026-11-19: the user turned developer mode on after the control window had loaded and could not find
// 「桌宠用 Unbound 引擎（实验）」. The 「Unbound（试验）」 section had read "not available" once at load, hid itself, and the host
// sends no new view when developer mode changes. Now the section is never hidden by that, and opening it reads the view again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { UnboundSwitch } from '../src/unbound/control-switch';
import type { UnboundControlView } from '../shared/unbound/scene';

class El extends EventTarget {
  [key: string]: unknown;
  children: El[] = [];
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  textContent = ''; value = ''; hidden = false; open = false; checked = false; disabled = false;
  constructor(readonly ownerDocument: Doc, readonly tagName: string) { super(); }
  append(...nodes: El[]): void { this.children.push(...nodes); }
  prepend(...nodes: El[]): void { this.children.unshift(...nodes); }
  replaceChildren(...nodes: El[]): void { this.children = nodes; }
  setAttribute(name: string, value: string): void { this[`attr:${name}`] = value; }
  removeAttribute(name: string): void { delete this[`attr:${name}`]; }
  remove(): void { /* not needed */ }
}
class Doc {
  activeElement: El | null = null;
  createElement(tag: string): El { return new El(this, tag); }
  createTextNode(text: string): El { const node = new El(this, '#text'); node.textContent = text; return node; }
}
const texts = (node: El): string => [node.textContent, ...node.children.map(texts)].join(' ');

const view = (available: boolean): UnboundControlView => ({
  available, state: 'normal', viewerDistanceCm: 55, depthM: 6,
  body: { walkSpeedMps: 1, stepLengthM: 0.6, stance: 'both' } as UnboundControlView['body'],
  debug: false, screen: null, stats: null, error: null, fullscreen: false, peek: null, life: null,
});
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function mount(answers: boolean[]) {
  const doc = new Doc();
  const parent = doc.createElement('div');
  let reads = 0;
  const api = {
    getUnbound: async () => view(answers[Math.min(reads++, answers.length - 1)]!),
    setUnbound: async () => view(true),
    onUnbound: () => () => undefined,
  };
  new UnboundSwitch(parent as unknown as HTMLElement, api);
  const root = parent.children[0]!;
  const enter = (function find(node: El): El | undefined {
    if (node.tagName === 'input' && node.id === 'unbound-active') return node;
    for (const child of node.children) { const hit = find(child); if (hit) return hit; }
    return undefined;
  })(root)!;
  return { root, enter, reads: () => reads };
}

test('read "not available" at load: the section still shows, with the personal-feel slider inside it', async () => {
  const { root, enter } = mount([false]);
  await settle();
  assert.equal(root.hidden, false);
  assert.match(texts(root), /个人感/);
  assert.equal(enter.disabled, true, 'entering Unbound from here still waits for developer mode');
});

test('opening the section reads the view again, so turning developer mode on later is picked up', async () => {
  const { root, enter, reads } = mount([false, true]);
  await settle();
  assert.equal(reads(), 1);
  root.open = true; root.dispatchEvent(new Event('toggle'));
  await settle();
  assert.equal(reads(), 2);
  assert.equal(enter.disabled, false);
  assert.equal(root.hidden, false);
});

test('closing the section does not read again', async () => {
  const { root, reads } = mount([true]);
  await settle();
  root.open = false; root.dispatchEvent(new Event('toggle'));
  await settle();
  assert.equal(reads(), 1);
});
