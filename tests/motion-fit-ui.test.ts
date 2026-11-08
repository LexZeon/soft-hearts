import * as uiCopy from '../src/ui/ui-language';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as filters from '../src/ui/motion-filters';
import * as layers from '../shared/motion-layers';
import type { MotionCatalog } from '../shared/motion-library';
import type { MotionFitView } from '../src/stage/motion-retarget';

// Text/action-only DOM (the motion-weights-ui fixture pattern), plus <select>.options.
class Element {
  children: Element[] = []; parent: Element | null = null;
  id = ''; className = ''; textContent = ''; value = ''; disabled = false; hidden = false; open = false; htmlFor = ''; type = ''; placeholder = '';
  attributes: Record<string, string> = {}; dataset: Record<string, string> = {};
  onclick: (() => void) | null = null; oninput: (() => void) | null = null; onchange: (() => void) | null = null;
  readonly classList = {
    add: (...values: string[]) => { this.className = [...new Set([...this.className.split(' '), ...values])].join(' '); },
    remove: (...values: string[]) => { this.className = this.className.split(' ').filter(v => !values.includes(v)).join(' '); },
    toggle: (value: string, on?: boolean) => {
      const set = new Set(this.className.split(' ').filter(Boolean));
      if (on ?? !set.has(value)) set.add(value); else set.delete(value);
      this.className = [...set].join(' '); return set.has(value);
    },
  };
  constructor(readonly tagName: string) {}
  get options(): Element[] { return all(this).filter(node => node.tagName === 'option'); }
  append(...nodes: Element[]): void { for (const child of nodes) { child.parent = this; this.children.push(child); } }
  replaceChildren(...nodes: Element[]): void { this.children = []; this.append(...nodes); }
  setAttribute(key: string, value: string): void { this.attributes[key] = value; }
}
class OptionElement extends Element { constructor(text: string, value: string) { super('option'); this.textContent = text; this.value = value; } }
const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
const find = (node: Element, predicate: (v: Element) => boolean) => { const item = all(node).find(predicate); assert.ok(item); return item; };
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(r => setImmediate(r)); };
function globals(t: TestContext, api: unknown) {
  for (const [key, value] of Object.entries({ document: { createElement: (tag: string) => new Element(tag) }, window: { desktop: api }, Option: OptionElement })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (old) Object.defineProperty(globalThis, key, old); else Reflect.deleteProperty(globalThis, key); });
  }
}
const catalog: MotionCatalog = { schemaVersion: 1, packs: [{ id: 'gene', name: 'Synthetic Gene catalog', source: 'mmdagent-ex', sourceUrl: 'https://example.invalid/gene', revision: 'a'.repeat(40),
  license: { id: 'CC-BY-4.0', url: 'https://creativecommons.org/licenses/by/4.0/', attribution: 'Synthetic' },
  motions: ['stand', 'happy'].map(id => ({ id, name: id, category: 'expression' as const, tags: [id], relativePath: `motions/${id}.vmd`, originalPath: `${id}.vmd`,
    downloadUrl: 'https://example.invalid', sha256: id.padEnd(64, '0'), bytes: 1, durationFrames: 0, boneFrames: 0, morphFrames: 0 })), documents: [] }] };
const stub = class { element = new Element('div'); ranking = null; filtering = false; select() {} setAvailable() {} setModelKey() {} selectMotion() {} dispose() {}
  matches() { return true; } createPack() { return new Element('div'); } };

test('the library does not offer a motion the fit check hid on this model, and shows "N of M usable"', async t => {
  globals(t, { onMotionDownload: () => () => {}, getMotionLibrary: async () => ({ directory: 'x', packs: [{ id: 'gene', installedMotionIds: ['stand', 'happy'], complete: true, bundled: true }] }) });
  const source = await readFile(new URL('../src/ui/MotionLibrary.ts', import.meta.url), 'utf8');
  const exports = {}, context = { exports, document: (globalThis as any).document, window: (globalThis as any).window, Option: OptionElement,
    require: (name: string) => {
      if (name === './ui-language') return uiCopy;
      if (name.endsWith('.css')) return {};
      if (name.endsWith('motion-catalog.json')) return catalog;
      if (name === './MotionWeights') return { MotionWeightControls: stub };
      if (name === './MotionTrackCoverage') return { MotionTrackCoverageControls: stub };
      if (name === './motion-filters') return filters;
      if (name.endsWith('motion-layers')) return layers;
      throw Error(`Unexpected UI import ${name}`);
    } };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, context);
  const root = new Element('div');
  const ui = new (exports as any).MotionLibraryControls(root, { getModel: () => ({ name: 'other.pmx', path: 'x', url: 'mmd-asset://t/other.pmx' }),
    onEnabled: async () => {}, onPreview: async () => true, onStopPreview: async () => {}, onError: (message: string) => assert.fail(message) });
  t.after(() => ui.dispose());
  await ui.init(); await flush();
  const select = find(root, n => n.id === 'motion-select-gene'), install = find(root, n => n.id === 'motion-install-gene'), preview = find(root, n => n.id === 'motion-preview-gene');
  const status = find(root, n => n.id === 'motion-status-gene'), hint = find(root, n => n.id === 'motion-library-model-hint');
  assert.equal(install.disabled, false, 'before any fit report the old behaviour holds');
  const view = (scan: 'running' | 'done', checked: number): MotionFitView => ({ motions: { 'gene/stand': 'ok', 'gene/happy': 'hidden' },
    summary: { model: 'adapted', total: 2, checked, usable: 1, ok: 1, adjusted: 0, hidden: 1, hiddenMotions: ['gene/happy'], adjustedMotions: [], partial: 0, partialMotions: [], structure: [], scan, armAlignDeg: 34, scale: 0.99 } });
  ui.setMotionFit(view('running', 1));
  assert.equal(hint.textContent, '当前模型：正在检查动作是否适合（1 / 2）');
  ui.setMotionFit(view('done', 2));
  assert.equal(hint.textContent, '当前模型：2 个动作里 1 个可用（已按模型自动适配）');
  const happy = select.options.find(option => option.value === 'happy')!;
  assert.equal(happy.textContent, 'happy · 不适合当前模型');
  assert.equal(select.options.find(option => option.value === 'stand')!.textContent, 'stand');
  select.value = 'happy'; select.onchange?.();
  assert.equal(install.disabled, true); assert.equal(preview.disabled, true);
  assert.equal(status.textContent, '这个动作不适合当前模型');
  select.value = 'stand'; select.onchange?.();
  assert.equal(install.disabled, false); assert.equal(status.textContent, '');
  // Back on Gene (reviewed) or no model: the original copy and nothing hidden.
  ui.setMotionFit({ motions: {}, summary: { ...view('done', 2).summary, model: 'reviewed', hidden: 0, hiddenMotions: [] } });
  assert.equal(hint.textContent, '已为 Gene 适配；其它模型可能需要重新调整骨骼。短舞与手势由你选择启用。');
  assert.equal(happy.textContent === 'happy · 不适合当前模型', false);
});
