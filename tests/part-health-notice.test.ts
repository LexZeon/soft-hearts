// 一部分关了 (overhaul step 7, docs/claude/2026-11-17-isolation-step7.md): the control window's banner (src/safety/PartHealthNotice.ts) shows
// the plan's words for each switched-off unit, only closed words (an unknown part or unit is never shown), greys that unit's switches with
// 「这部分暂时关了」, follows the host's pushes, and never writes markup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setUiLanguage } from '../shared/foundation/ui-language';
import type { PartHealthView, PartOffView } from '../shared/foundation/ports';
import { PART_SWITCH_ELEMENTS, PartHealthNotice } from '../src/safety/PartHealthNotice';

class Element {
  children: Element[] = []; className = ''; textContent: string | null = ''; disabled = false; hidden = false; attributes = new Map<string, string>();
  private classes = new Set<string>();
  classList = { add: (name: string) => this.classes.add(name), remove: (name: string) => this.classes.delete(name), contains: (name: string) => this.classes.has(name) };
  constructor(readonly tagName: string) {}
  append(...children: Element[]) { this.children.push(...children); }
  remove() { /* detached by the test's own lists */ }
  replaceChildren(...children: Element[]) { this.children = [...children]; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  querySelectorAll() { return this.children.filter(child => ['input', 'button', 'select'].includes(child.tagName)); }
  get innerHTML(): string { throw new Error('the banner never reads or writes markup'); }
  set innerHTML(_value: string) { throw new Error('the banner never reads or writes markup'); }
}
const all = (root: Element): Element[] => [root, ...root.children.flatMap(all)];
const text = (root: Element) => all(root).filter(node => !node.hidden && node.children.length === 0).map(node => node.textContent).filter(Boolean).join(' | ');
const flush = () => new Promise(resolve => setImmediate(resolve));
(globalThis as any).document = { createElement: (tag: string) => new Element(tag) };
setUiLanguage('zh-CN');

const off = (part: string, unit: string, when: 'start' | 'running'): PartOffView => ({ part, unit, category: when === 'start' ? 'start' : 'tick', when, reason: `${when === 'start' ? 'start' : 'tick'}:TypeError`, at: 1 });
const view = (...entries: PartOffView[]): PartHealthView => ({ mode: 'isolate', started: [], off: entries });

test('nothing off: hidden; a unit that did not start and one that failed running: the plan\'s words, the switches greyed', async () => {
  const root = new Element('section');
  let push: ((value: PartHealthView) => void) | null = null;
  const faceSwitch = new Element('div'); const input = new Element('input'); faceSwitch.append(input);
  const notice = new PartHealthNotice(root as never, { get: async () => view(), changed: callback => { push = callback; return () => { push = null; }; },
    switches: unit => unit === 'senses/face-check' ? [faceSwitch as never] : [] });
  await flush();
  assert.equal(root.hidden, true);
  push!(view(off('senses', 'face-check', 'start'), off('initiative', 'rps', 'running'), off('nope', 'x', 'start')));
  assert.equal(root.hidden, false);
  assert.equal(root.attributes.get('role'), 'status');
  assert.equal(text(root), '需要处理 | 有一部分暂时关了 | 感知（认出你）这次没能启动，我先把它单独关掉了，别的都照常。重启 soft hearts 通常就好；还不行的话，点「复制诊断信息」发给 Claude。 | 主动刚才连续出错，先关掉了，别的照常；重启后会再试。');
  assert.ok(!text(root).includes('nope'), 'an unknown part is never shown');
  assert.equal(input.disabled, true);
  assert.ok(faceSwitch.classList.contains('part-off'));
  assert.equal(faceSwitch.children.at(-1)?.textContent, '这部分暂时关了');
  // the same view again: nothing doubled
  push!(view(off('senses', 'face-check', 'start'), off('initiative', 'rps', 'running')));
  assert.equal(faceSwitch.children.filter(child => child.textContent === '这部分暂时关了').length, 1);
  notice.dispose();
  assert.equal(input.disabled, false);
  assert.equal(push, null, 'disposed: no longer listening');
});

test('English: the same lines from the catalog', async () => {
  setUiLanguage('en');
  try {
    const root = new Element('section');
    new PartHealthNotice(root as never, { get: async () => view(off('mood', 'reactions', 'start')), changed: () => () => {} });
    await flush();
    assert.ok(!/[一-鿿]/u.test(text(root)), text(root));
    assert.match(text(root), /Mood \(Reactions\) did not start this time/);
  } finally { setUiLanguage('zh-CN'); }
});

test('the switches named for each unit are units that can be switched off', async () => {
  const { partUnits } = await import('../shared/foundation/part-health');
  for (const unit of Object.keys(PART_SWITCH_ELEMENTS)) {
    const [part, name] = unit.split('/');
    assert.ok(partUnits(part).includes(name), unit);
  }
});
