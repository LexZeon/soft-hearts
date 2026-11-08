import { registerUiMessages, setUiLanguage } from '../shared/ui-language';
import { ENGLISH_SETTINGS_UI_COPY } from '../shared/ui-copy.settings.en';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CharacterStickerControls } from '../src/ui/CharacterStickerControls';
import type { CharacterStickerPorts, CharacterStickerView } from '../shared/character-sticker';
import type { EmojiId } from '../shared/single-emoji';

class Element {
  children: Element[] = []; parent: Element | null = null;
  className = ''; textContent = ''; value = ''; type = ''; src = ''; alt = ''; width = 0;
  hidden = false; disabled = false; dataset: Record<string, string> = {}; style: Record<string, string> = {};
  attributes = new Map<string, string>();
  onclick: (() => void) | null = null;
  constructor(readonly tagName: string) {}
  append(...children: Element[]) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children: Element[]) { this.children = []; this.append(...children); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); if (name === 'src') this.src = ''; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
}
const all = (root: Element): Element[] => [root, ...root.children.flatMap(all)];
function find(root: Element, name: string) { return all(root).find(node => node.dataset.stickerControl === name); }
function get(root: Element, name: string) { const node = find(root, name); assert.ok(node, name); return node; }
function click(root: Element, name: string) {
  const node = get(root, name); assert.equal(node.disabled, false, name + ' enabled'); node.onclick?.();
}
function preview(root: Element, id: string) {
  const node = all(root).find(node => node.dataset.stickerAsset === id);
  assert.ok(node); assert.equal(node.disabled, false); node.onclick?.();
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
// These DOM tests never decode or upload an image; PNG validation belongs to the host.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3UQAAAAASUVORK5CYII=';
function state(phase: CharacterStickerView['phase'] = 'idle', connected = true): CharacterStickerView {
  return { connected, reason: connected ? '' : '当前未连接已验证的 Claude 图片生成通道。', phase, reference: null, result: null, saved: [] };
}
function reference(id = 'reference-a', connected = true): CharacterStickerView {
  return { ...state('reference', connected), reference: { id, png: PNG, width: 1, height: 1 } };
}
function result(id = 'result-a', referenceId = 'reference-a'): CharacterStickerView {
  return { ...reference(referenceId), phase: 'result', result: { id, intent: 'heart', png: PNG } };
}
function fixture(overrides: Partial<CharacterStickerPorts> = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true,
    value: { createElement: (tag: string) => new Element(tag) } });
  const root = new Element('div');
  let prepares = 0, cancels = 0, listener: ((value: CharacterStickerView) => void) | undefined, unsubscribed = false;
  const generations: { referenceId: string; intent: EmojiId }[] = [], saves: string[] = [], previews: string[] = [];
  const ports: CharacterStickerPorts = {
    async get() { return state(); },
    async prepare() { prepares++; return reference(); },
    async generate(referenceId, intent) {
      generations.push({ referenceId, intent });
      return { ...result('result-a', referenceId), result: { id: 'result-a', intent, png: PNG } };
    },
    async save(id) { saves.push(id); return { ...state('saved'), saved: [{ id: 'asset-a', intent: 'heart' }] }; },
    async preview(id) { previews.push(id); return false; },
    async cancel() { cancels++; return state(); },
    changed(callback) { listener = callback; return () => { listener = undefined; unsubscribed = true; }; },
    ...overrides,
  };
  const ui = new CharacterStickerControls(root as unknown as HTMLElement, ports);
  return { ui, root, generations, saves, previews, get prepares() { return prepares; }, get cancels() { return cancels; },
    get unsubscribed() { return unsubscribed; },
    emit(value: CharacterStickerView) { listener?.(value); },
    restore() {
      ui.dispose();
      if (previous) Object.defineProperty(globalThis, 'document', previous);
      else Reflect.deleteProperty(globalThis, 'document');
    } };
}

test('unconnected controls can prepare an exact local reference but never create a generate button or upload', async () => {
  const f = fixture({ async get() { return state('idle', false); }, async prepare() { return reference('local-reference', false); } });
  try {
    await flush(); assert.match(get(f.root, 'connection').textContent, /当前未连接.*Claude/);
    assert.equal(find(f.root, 'generate'), undefined); assert.deepEqual(f.generations, []);
    click(f.root, 'prepare'); await flush();
    assert.equal(get(f.root, 'reference-image').src, PNG);
    assert.equal(find(f.root, 'generate'), undefined);
    assert.deepEqual(f.generations, []); assert.deepEqual(f.saves, []);
    assert.ok(all(f.root).some(node => node.textContent.includes('不会上传 PMX')));
  } finally { f.restore(); }
});

test('prepare then explicit exact-reference intent generation, current-result save and one local preview are distinct calls', async () => {
  const f = fixture();
  try {
    await flush(); assert.deepEqual(f.generations, []); assert.equal(find(f.root, 'generate'), undefined);
    click(f.root, 'prepare'); await flush();
    assert.equal(f.prepares, 1); assert.equal(get(f.root, 'reference-image').src, PNG);
    assert.deepEqual(f.generations, []);
    get(f.root, 'intent').value = 'heart';
    click(f.root, 'generate'); await flush();
    assert.deepEqual(f.generations, [{ referenceId: 'reference-a', intent: 'heart' }]);
    assert.equal(f.prepares, 1, 'sending does not silently capture a different reference');
    assert.equal(get(f.root, 'result-image').src, PNG); assert.deepEqual(f.saves, []);
    click(f.root, 'save'); await flush();
    assert.deepEqual(f.saves, ['result-a']); assert.deepEqual(f.previews, []);
    preview(f.root, 'asset-a'); await flush();
    assert.deepEqual(f.previews, ['asset-a']); assert.equal(f.generations.length, 1);
    assert.match(get(f.root, 'status').textContent, /这次未显示/);
  } finally { f.restore(); }
});

test('newer host context beats a slow get and retired reference buttons cannot send a different image', async () => {
  const read = deferred<CharacterStickerView>();
  const f = fixture({ get: () => read.promise });
  try {
    f.emit(reference('first'));
    const firstButton = get(f.root, 'generate');
    f.emit(reference('second'));
    firstButton.onclick?.();
    assert.deepEqual(f.generations, [], 'a queued old button cannot implicitly approve the new reference');
    read.resolve(reference('old-read')); await flush();
    click(f.root, 'generate'); await flush();
    assert.deepEqual(f.generations, [{ referenceId: 'second', intent: 'smile' }]);
    f.emit(state()); assert.equal(get(f.root, 'reference-image').src, '');
    f.emit(reference('second'));
    assert.equal(get(f.root, 'reference-image').src, '', 'a retired reference event cannot revive an old context');
  } finally { f.restore(); }
});

test('cancel clears image DOM immediately and rejects late operation results and orphan result events', async () => {
  const generated = deferred<CharacterStickerView>(), calls: string[] = [];
  const f = fixture({
    async get() { return reference(); },
    generate(referenceId) { calls.push(referenceId); return generated.promise; },
  });
  try {
    await flush(); click(f.root, 'generate');
    assert.deepEqual(calls, ['reference-a']);
    click(f.root, 'cancel');
    assert.equal(get(f.root, 'reference-image').src, '');
    assert.equal(get(f.root, 'result-image').src, '');
    await flush(); assert.equal(f.cancels, 1);
    generated.resolve(result()); await flush();
    assert.equal(get(f.root, 'result-image').src, ''); assert.equal(find(f.root, 'save'), undefined);
    f.emit(result());
    f.emit({ ...state('result'), result: { id: 'unknown-old-result', intent: 'heart', png: PNG } });
    assert.equal(get(f.root, 'result-image').src, ''); assert.equal(find(f.root, 'save'), undefined);
  } finally { f.restore(); }
});

test('context loss invalidates late prepare and save returns without restoring transient pictures or old assets', async () => {
  const prepared = deferred<CharacterStickerView>(), saved = deferred<CharacterStickerView>(), saves: string[] = [];
  const f = fixture({
    prepare: () => prepared.promise,
    save(id) { saves.push(id); return saved.promise; },
  });
  try {
    await flush(); click(f.root, 'prepare');
    f.emit(state());
    prepared.resolve(reference('late-reference')); await flush();
    assert.equal(get(f.root, 'reference-image').src, ''); assert.equal(find(f.root, 'generate'), undefined);
    f.emit(result('current-result', 'current-reference'));
    const staleSave = get(f.root, 'save');
    click(f.root, 'save'); assert.deepEqual(saves, ['current-result']);
    f.emit(result('new-result', 'new-reference'));
    staleSave.onclick?.();
    assert.deepEqual(saves, ['current-result'], 'an old save button does not approve the new result');
    f.emit(state());
    saved.resolve({ ...state('saved'), saved: [{ id: 'late-asset', intent: 'heart' }] }); await flush();
    assert.equal(get(f.root, 'reference-image').src, ''); assert.equal(get(f.root, 'result-image').src, '');
    assert.equal(all(f.root).some(node => node.dataset.stickerAsset === 'late-asset'), false);
  } finally { f.restore(); }
});

test('dispose removes transient image sources and subscriptions; pending preview and initial get cannot resurrect DOM', async () => {
  const read = deferred<CharacterStickerView>(), displayed = deferred<boolean>();
  const f = fixture({ get: () => read.promise, preview: () => displayed.promise });
  try {
    f.emit({ ...result('saved-result', 'saved-reference'), phase: 'saved', saved: [{ id: 'asset-current', intent: 'heart' }] });
    const referenceImage = get(f.root, 'reference-image'), resultImage = get(f.root, 'result-image');
    preview(f.root, 'asset-current');
    f.ui.dispose();
    assert.equal(f.unsubscribed, true); assert.equal(f.root.children.length, 0);
    assert.equal(referenceImage.src, ''); assert.equal(resultImage.src, '');
    displayed.resolve(true); read.resolve(reference('late-read')); await flush();
    assert.equal(f.root.children.length, 0);
  } finally { f.restore(); }
});

test('failures stay honest and an invalid remote picture cannot be loaded as a host PNG preview', async () => {
  const f = fixture({ async prepare() { throw Error('synthetic preparation unavailable'); } });
  try {
    await flush(); click(f.root, 'prepare'); await flush();
    assert.match(get(f.root, 'status').textContent, /参考图未准备完成.*没有发送/);
    assert.deepEqual(f.generations, []);
    f.emit({ ...reference(), reference: { ...reference().reference!, png: 'https://never-called.invalid/private.png' } });
    assert.equal(get(f.root, 'reference-image').src, ''); assert.equal(find(f.root, 'generate'), undefined);
    assert.match(get(f.root, 'status').textContent, /图片无效/);
  } finally { f.restore(); }
});

test('English sticker preparation stays separate from sending or generation', async()=>{
 registerUiMessages({en:ENGLISH_SETTINGS_UI_COPY,'zh-CN':{}});setUiLanguage('en');
 const f=fixture({async get(){return {...state('idle',false),reason:'图片生成通道尚未连接；可以先查看当前模型参考。'};}});
 try{await flush();assert.equal(get(f.root,'prepare').textContent,'Prepare current character reference');
 assert.equal(get(f.root,'connection').textContent,'Not connected: Image generation is not connected. You can view the current model reference first.');
 assert.equal(find(f.root,'generate'),undefined);assert.equal(get(f.root,'reference-image').alt,'Current character reference to send after confirmation');
 const raw='synthetic transport diagnostic E_NO_WIRE';f.emit({...state('idle',false),reason:raw});
 assert.ok(!get(f.root,'connection').textContent.includes(raw));
 assert.match(get(f.root,'connection').textContent,/View connection details/);
 assert.ok(all(f.root).some(node=>node.tagName==='pre'&&node.textContent===raw));
 }finally{f.restore();setUiLanguage('zh-CN');}
});
