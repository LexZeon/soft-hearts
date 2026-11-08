import { registerUiMessages, setUiLanguage } from '../shared/ui-language';
import { ENGLISH_SETTINGS_UI_COPY } from '../shared/ui-copy.settings.en';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SingleEmojiControls, type SingleEmojiControlPorts } from '../src/ui/SingleEmojiControls';
import { DEFAULT_EMOJI_SETTINGS, readEmojiSettings, type EmojiId, type EmojiSettings } from '../shared/single-emoji';

class Element {
  children: Element[] = []; parent: Element | null = null;
  id = ''; className = ''; textContent = ''; value = ''; type = '';
  checked = false; disabled = false;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  onchange: (() => void) | null = null; onclick: (() => void) | null = null;
  constructor(readonly tagName: string) {}
  append(...children: Element[]) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children: Element[]) { this.children = []; this.append(...children); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
}
const all = (root: Element): Element[] => [root, ...root.children.flatMap(all)];
function control(root: Element, name: string) {
  const node = all(root).find(value => value.dataset.emojiControl === name);
  assert.ok(node, name); return node;
}
function choice(root: Element, id: EmojiId) {
  const node = all(root).find(value => value.dataset.emojiId === id);
  assert.ok(node, id); return node;
}
function click(root: Element, name: string) {
  const node = control(root, name); assert.equal(node.disabled, false, name); node.onclick?.();
}
function toggle(root: Element, name: string, checked: boolean) {
  const node = name === 'enabled' ? control(root, name) : choice(root, name as EmojiId);
  assert.equal(node.disabled, false); node.checked = checked; node.onchange?.();
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); }
const settings = (enabled: boolean, selected: EmojiId[] = ['smile', 'heart']): EmojiSettings =>
  ({ version: 1, enabled, source: 'system', selected });
function fixture(overrides: Partial<SingleEmojiControlPorts> = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true,
    value: { createElement: (tag: string) => new Element(tag) } });
  const root = new Element('div'), saves: EmojiSettings[] = [], previews: EmojiId[] = [];
  let listener: ((value: EmojiSettings) => void) | undefined, unsubscribed = false;
  const ports: SingleEmojiControlPorts = {
    async get() { return readEmojiSettings(DEFAULT_EMOJI_SETTINGS); },
    async save(value) { saves.push(structuredClone(value)); return value; },
    async preview(id) { previews.push(id); return false; },
    changed(callback) { listener = callback; return () => { listener = undefined; unsubscribed = true; }; },
    ...overrides,
  };
  const ui = new SingleEmojiControls(root as unknown as HTMLElement, ports);
  return { ui, root, saves, previews,
    emit(value: EmojiSettings) { listener?.(value); },
    get unsubscribed() { return unsubscribed; },
    restore() {
      ui.dispose();
      if (previous) Object.defineProperty(globalThis, 'document', previous);
      else Reflect.deleteProperty(globalThis, 'document');
    } };
}

test('actual controls explicitly save complete state, adopt returned state and request one selected preview', async () => {
  const saved: EmojiSettings[] = [], previews: EmojiId[] = [];
  const f = fixture({
    async get() { return settings(false, ['smile', 'heart']); },
    async save(value) { saved.push(structuredClone(value)); return settings(true, ['heart']); },
    async preview(id) { previews.push(id); return false; },
  });
  try {
    await flush();
    assert.equal(control(f.root, 'enabled').checked, false);
    assert.equal(control(f.root, 'preview').disabled, true);
    toggle(f.root, 'enabled', true); toggle(f.root, 'heart', false);
    assert.deepEqual(saved, []); assert.equal(control(f.root, 'preview').disabled, true);
    click(f.root, 'save'); await flush();
    assert.deepEqual(saved, [settings(true, ['smile'])]);
    assert.equal(choice(f.root, 'heart').checked, true);
    assert.equal(choice(f.root, 'smile').checked, false, 'host returned state governs the originating controls');
    assert.equal(control(f.root, 'save').disabled, true);
    click(f.root, 'preview'); await flush();
    assert.deepEqual(previews, ['heart']); assert.equal(saved.length, 1, 'preview never saves');
    assert.match(control(f.root, 'status').textContent, /这次没有显示/);
    assert.ok(all(f.root).some(node => node.textContent.includes('角色贴图与系统表情共用安全位置和显示开关。')));
    assert.ok(all(f.root).some(node => node.textContent.includes('没有当前角色贴图时，使用电脑系统 emoji')));
    assert.equal(all(f.root).some(node => node.tagName === 'button' && /生成|发送/.test(node.textContent)), false,
      'system controls retain local save/preview only; generation permission belongs to neither this hint nor this component');
  } finally { f.restore(); }
});

test('late initial read and host events cannot overwrite an unsaved draft', async () => {
  const read = deferred<EmojiSettings>(), captured: EmojiSettings[] = [];
  const f = fixture({
    get: () => read.promise,
    async save(value) { captured.push(structuredClone(value)); return value; },
  });
  try {
    f.emit(settings(false)); toggle(f.root, 'enabled', true); toggle(f.root, 'heart', false);
    read.resolve(settings(false, ['sad'])); await flush();
    f.emit(settings(false, ['upset']));
    assert.equal(control(f.root, 'enabled').checked, true);
    assert.equal(choice(f.root, 'smile').checked, true);
    assert.equal(choice(f.root, 'heart').checked, false);
    assert.equal(choice(f.root, 'sad').checked, false);
    click(f.root, 'save'); await flush();
    assert.deepEqual(captured, [settings(true, ['smile'])]);
  } finally { f.restore(); }
});

test('failed save retains edits and newer edits during a save remain an explicit retry draft', async () => {
  const first = deferred<EmojiSettings>(), second = deferred<EmojiSettings>(), saves: EmojiSettings[] = [];
  let count = 0;
  const f = fixture({
    async get() { return settings(false); },
    save(value) {
      saves.push(structuredClone(value)); count++;
      return count === 1 ? first.promise : count === 2 ? second.promise : Promise.resolve(value);
    },
  });
  try {
    await flush(); toggle(f.root, 'enabled', true); click(f.root, 'save');
    assert.equal(control(f.root, 'save').disabled, true);
    first.reject(new Error('owned synthetic write failure')); await flush();
    assert.equal(control(f.root, 'enabled').checked, true);
    assert.match(control(f.root, 'status').textContent, /未保存.*已保留/);
    click(f.root, 'save'); toggle(f.root, 'heart', false);
    second.resolve(settings(true)); await flush();
    assert.equal(choice(f.root, 'heart').checked, false, 'newer local edit survives older successful return');
    assert.equal(control(f.root, 'save').disabled, false);
    assert.match(control(f.root, 'status').textContent, /较新的修改仍是草稿/);
    click(f.root, 'save'); await flush();
    assert.deepEqual(saves, [settings(true), settings(true), settings(true, ['smile'])]);
  } finally { f.restore(); }
});

test('last catalog item cannot be deselected and disposal ignores late results', async () => {
  const preview = deferred<boolean>(), read = deferred<EmojiSettings>();
  const f = fixture({ get: () => read.promise, preview: () => preview.promise });
  try {
    f.emit(settings(true, ['heart']));
    toggle(f.root, 'heart', false);
    assert.equal(choice(f.root, 'heart').checked, true);
    assert.equal(control(f.root, 'save').disabled, true);
    assert.match(control(f.root, 'status').textContent, /至少保留一个/);
    click(f.root, 'preview');
    f.ui.dispose(); assert.equal(f.unsubscribed, true); assert.equal(f.root.children.length, 0);
    preview.resolve(true); read.resolve(settings(false)); await flush();
    assert.equal(f.root.children.length, 0);
  } finally { f.restore(); }
});

test('a late preview result cannot replace the status of newer unsaved edits', async () => {
  const preview = deferred<boolean>();
  const f = fixture({ async get() { return settings(true); }, preview: () => preview.promise });
  try {
    await flush(); click(f.root, 'preview'); toggle(f.root, 'enabled', false);
    preview.resolve(true); await flush();
    assert.equal(control(f.root, 'enabled').checked, false);
    assert.equal(control(f.root, 'save').disabled, false);
    assert.match(control(f.root, 'status').textContent, /未保存的修改/);
    assert.deepEqual(f.saves, []);
  } finally { f.restore(); }
});

test('English emoji controls translate fixed labels while catalog IDs and defaultoff remain intact', async () => {
 registerUiMessages({en:ENGLISH_SETTINGS_UI_COPY,'zh-CN':{}});setUiLanguage('en');const f=fixture();
 try {await flush();assert.equal(control(f.root,'save').textContent,'Save emoji settings');
 assert.equal(control(f.root,'enabled').checked,false);assert.ok(all(f.root).some(n=>n.textContent==='Smile'));
 assert.ok(choice(f.root,'smile'));assert.deepEqual(f.saves,[]);assert.deepEqual(f.previews,[]);
 } finally {f.restore();setUiLanguage('zh-CN');}
});
