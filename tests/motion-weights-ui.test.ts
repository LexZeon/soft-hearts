import * as uiCopy from '../src/ui/ui-language';
const { uiText, uiHtml, uiMarkup, uiTemplate } = uiCopy;
import { MotionTrackCoverageControls } from '../src/ui/MotionTrackCoverage';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { MotionLibrary } from '../electron/motion-library';
import { MotionWeightStore } from '../electron/motion-weights';
import { MotionWeightControls } from '../src/ui/MotionWeights';
import * as filters from '../src/ui/motion-filters';
import * as layers from '../shared/motion-layers';
import type { MotionCatalog, MotionDownloadFile } from '../shared/motion-library';
import type { MotionWeightView } from '../shared/motion-weights';

// Text/action-only DOM, following the existing character-card UI fixture pattern.
class Element {
  children: Element[] = []; parent: Element | null = null;
  id = ''; className = ''; textContent = ''; value = ''; disabled = false; hidden = false; open = false;
  attributes: Record<string, string> = {}; dataset: Record<string, string> = {};
  onclick: (() => void) | null = null; oninput: (() => void) | null = null;
  onchange: (() => void) | null = null; ontoggle: (() => void) | null = null;
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
  append(...nodes: Element[]): void {
    for (const child of nodes) { child.parent = this; this.children.push(child);
      if (this.tagName === 'select' && !this.value && child.tagName === 'option') this.value = child.value; }
  }
  replaceChildren(...nodes: Element[]): void { this.children = []; this.append(...nodes); }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
  setAttribute(key: string, value: string): void { this.attributes[key] = value; }
  click(): void { for (let p: Element | null = this; p; p = p.parent) assert.equal(p.disabled, false); this.onclick?.(); }
}
class OptionElement extends Element { constructor(text: string, value: string) { super('option'); this.textContent = text; this.value = value; } }
const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
const find = (node: Element, predicate: (v: Element) => boolean) => { const item = all(node).find(predicate); assert.ok(item); return item; };
const action = (root: Element, text: string) => find(root, n => n.tagName === 'button' && n.textContent === text).click();
const type = (row: Element, label: string, value: string) => {
  const n = find(row, n => n.attributes['aria-label'] === label); n.value = value; n.oninput?.(); return n;
};
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(r => setImmediate(r)); };
function globals(t: TestContext, api: unknown) {
  for (const [key, value] of Object.entries({ document: { createElement: (tag: string) => new Element(tag) }, window: { desktop: api }, Option: OptionElement })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (old) Object.defineProperty(globalThis, key, old); else Reflect.deleteProperty(globalThis, key); });
  }
}
function catalogFixture(): { catalog: MotionCatalog; bodies: Map<string, Buffer> } {
  const bodies = new Map<string, Buffer>(), revision = 'b'.repeat(40), upstream = `https://raw.githubusercontent.com/mmdagent-ex/gene/${revision}/`;
  const file = (relativePath: string, originalPath: string, bytes: Buffer, downloadUrl = upstream + originalPath): MotionDownloadFile => {
    bodies.set(relativePath, bytes); return { relativePath, originalPath, downloadUrl, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  return { bodies, catalog: { schemaVersion: 1, packs: [{ id: 'gene', name: 'Synthetic Gene catalog', source: 'mmdagent-ex',
    sourceUrl: 'https://github.com/mmdagent-ex/gene', revision,
    license: { id: 'CC-BY-4.0', url: 'https://creativecommons.org/licenses/by/4.0/', attribution: 'Synthetic metadata test' },
    motions: ['stand', 'happy'].map((id, i) => { const bytes = Buffer.alloc(74); bytes.write('Vocaloid Motion Data 0002'); bytes[40] = i;
      return { ...file(`motions/expression/${id}.vmd`, `motion/${id}.vmd`, bytes), id, name: id, category: 'expression', tags: i ? ['gentle', 'happy'] : ['gentle'],
        durationFrames: 0, boneFrames: 0, morphFrames: 0 }; }),
    documents: [file('metadata/upstream-readme.md', 'README.md', Buffer.from('Synthetic source notice')),
      file('metadata/cc-by-4.0.txt', 'license', Buffer.from('Synthetic license notice'), 'https://creativecommons.org/licenses/by/4.0/legalcode.txt')],
  }] } };
}

test('actual library UI annotates two installed assets, saves/reloads and opts into explained weighted order, then restores AND mode', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-r32-library-ui-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('soft-r32-library-ui-')); await rm(directory, { recursive: true, force: true }); });
  const fixture = catalogFixture(), pack = fixture.catalog.packs[0], bundled = path.join(directory, 'bundled');
  for (const [relative, bytes] of fixture.bodies) { const file = path.join(bundled, pack.source, pack.id, pack.revision, relative);
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes); }
  const library = new MotionLibrary(path.join(directory, 'installed'), { catalog: fixture.catalog, bundledDirectory: bundled,
    fetch: (async () => { assert.fail('annotation must never download'); }) as typeof fetch });
  const sidecar = path.join(directory, 'motion-tag-annotations.json');
  const store = new MotionWeightStore(sidecar, { assets: id => library.taggableAssets(id) });
  const pending: Promise<unknown>[] = [];
  const track = <T>(p: Promise<T>) => { pending.push(p); return p; };
  let ui: any; t.after(() => ui?.dispose());
  globals(t, { onWindowVisibility: () => () => {}, motionTrackCoverageRead: async () => { throw Error('No structural read requested by annotation fixture'); }, getMotionLibrary: () => track(library.getStatus()), onMotionDownload: () => () => {},
    readMotionWeights: (pack: string, motion: string) => track(store.read(7, pack, motion)),
    invalidateMotionWeightSelection: (pack: string) => { store.invalidateSelection(7, pack); return Promise.resolve(); },
    saveMotionWeights: (request: unknown) => track(store.save(7, request)), searchMotionWeights: (query: unknown) => track(store.search(query)) });
  const source = await readFile(new URL('../src/ui/MotionLibrary.ts', import.meta.url), 'utf8');
  const exports = {}, context = { exports, document: (globalThis as any).document, window: (globalThis as any).window, Option: OptionElement,
    require: (name: string) => {
      if (name === './ui-language') return uiCopy;
      if (name.endsWith('.css')) return {};
      if (name.endsWith('motion-catalog.json')) return fixture.catalog;
      if (name === './MotionWeights') return { MotionWeightControls };
      if (name === './MotionTrackCoverage') return { MotionTrackCoverageControls };
      if (name === './motion-filters') return filters;
      if (name.endsWith('motion-layers')) return layers;
      throw Error(`Unexpected UI import ${name}`);
    } };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, Object.assign(context, { uiText, uiHtml, uiMarkup, uiTemplate }));
  const Constructor = (exports as any).MotionLibraryControls, root = new Element('div');
  let enabled = 0, previewed = 0;
  ui = new Constructor(root, { getModel: () => null, onEnabled: async () => { enabled++; },
    onPreview: async () => { previewed++; return true; }, onStopPreview: async () => {}, onError: (message: string) => assert.fail(message) });
  const settle = async () => { for (let i = 0; i < 4; i++) { await Promise.all(pending.splice(0)); await flush(); } };
  await ui.init();
  const select = find(root, n => n.id === 'motion-select-gene');
  select.value = 'stand'; select.onchange?.();
  const editor = find(root, n => n.tagName === 'details' && n.children.some(c => c.tagName === 'summary' && c.textContent === '当前动作的个人 tag 权重'));
  editor.open = true; editor.ontoggle?.(); await settle();
  let row = find(editor, n => n.className === 'motion-weight-row');
  type(row, '标签维度', 'mood'); type(row, '权重，留空为未评估', '0.2');
  action(editor, '保存权重'); await settle();
  select.value = 'happy'; select.onchange?.(); await settle();
  row = find(editor, n => n.className === 'motion-weight-row');
  type(row, '标签维度', 'mood'); type(row, '权重，留空为未评估', '0.9');
  action(editor, '保存权重'); await settle(); action(editor, '放弃草稿并重读'); await settle();
  row = find(editor, n => n.className === 'motion-weight-row');
  assert.equal(find(row, n => n.attributes['aria-label'] === '权重，留空为未评估').value, '0.9');
  const mode = find(root, n => n.attributes['aria-label'] === '动作列表排序模式'); mode.value = 'weighted'; mode.onchange?.();
  const query = find(root, n => n.tagName === 'fieldset' && n.children.some(c => c.tagName === 'div' && all(c).some(r => r.attributes['aria-label'] === '查询重要度')));
  type(query, '标签维度', 'mood'); type(query, '标签', 'gentle'); action(query, '加权检索'); await settle();
  assert.deepEqual(all(select).filter(n => n.tagName === 'option').map(n => n.value), ['happy', 'stand']);
  assert.ok(all(root).some(n => n.textContent.includes('gentle=0.9')));
  mode.value = 'and'; mode.onchange?.();
  assert.deepEqual(all(select).filter(n => n.tagName === 'option').map(n => n.value), ['stand', 'happy']);
  const hardTag = find(root, n => n.id === 'motion-filter-tag'); hardTag.value = 'happy'; hardTag.onchange?.();
  assert.deepEqual(all(select).filter(n => n.tagName === 'option').map(n => n.value), ['happy']);
  assert.equal(enabled, 0); assert.equal(previewed, 0);
  assert.equal(JSON.parse(await readFile(sidecar, 'utf8')).records.length, 2);
  assert.equal((await library.taggableAssets('gene')).length, 2);
  await writeFile(path.join(bundled, pack.source, pack.id, pack.revision, pack.motions[0].relativePath), 'tampered');
  await assert.rejects(library.taggableAssets('gene'));
});

test('late weight reads and weighted results cannot replace another selection or a return to AND mode', async t => {
  const reads: { id: string; resolve: (view: MotionWeightView) => void }[] = [];
  const invalidated: string[] = [];
  let resolveQuery!: (value: unknown) => void, changed = 0;
  globals(t, { readMotionWeights: (_pack: string, id: string) => new Promise<MotionWeightView>(resolve => reads.push({ id, resolve })),
    invalidateMotionWeightSelection: (pack: string) => { invalidated.push(pack); return Promise.resolve(); },
    searchMotionWeights: () => new Promise(resolve => { resolveQuery = resolve; }) });
  const ui = new MotionWeightControls('gene', () => { changed++; }), root = ui.element as unknown as Element;
  const motions = catalogFixture().catalog.packs[0].motions;
  ui.select(motions[0]); ui.setAvailable(true);
  const editor = find(root, n => n.tagName === 'details'); editor.open = true; editor.ontoggle?.();
  ui.select(motions[1]);
  const view = (index: number): MotionWeightView => ({ token: 'a'.repeat(48), revision: 1, tags: [{ dimension: 'mood', tag: 'gentle', weight: 0.7 }],
    asset: { packId: 'gene', motionId: motions[index].id, assetKey: `synthetic/${motions[index].id}`, sha256: motions[index].sha256 } });
  reads[1].resolve(view(1)); await flush();
  const row = find(editor, n => n.className === 'motion-weight-row');
  type(row, '权重，留空为未评估', '0.6'); reads[0].resolve(view(0)); await flush();
  assert.equal(find(row, n => n.attributes['aria-label'] === '权重，留空为未评估').value, '0.6');
  const mode = find(root, n => n.attributes['aria-label'] === '动作列表排序模式'); mode.value = 'weighted'; mode.onchange?.();
  action(root, '加权检索'); mode.value = 'and'; mode.onchange?.(); const after = changed;
  resolveQuery({ rows: [], executionAuthority: false }); await flush();
  assert.equal(changed, after); assert.equal(ui.ranking, null); ui.dispose();
  assert.ok(invalidated.length >= 3); assert.ok(invalidated.every(pack => pack === 'gene'));
});

test('changing a collapsed editor selection while save is pending revokes the old host write', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-r32-selection-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('soft-r32-selection-')); await rm(directory, { recursive: true, force: true }); });
  const motions = catalogFixture().catalog.packs[0].motions;
  const assets = motions.map(motion => ({ packId: 'gene' as const, motionId: motion.id,
    assetKey: `synthetic/gene/${motion.id}`, sha256: motion.sha256 }));
  let block = false, release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }), reached = new Promise<void>(r => { entered = r; });
  const file = path.join(directory, 'motion-tag-annotations.json');
  const store = new MotionWeightStore(file, { assets: async () => { if (block) { block = false; entered(); await gate; } return assets; } });
  const pending: Promise<unknown>[] = [], track = <T>(p: Promise<T>) => { pending.push(p); return p; };
  let ui: MotionWeightControls | null = null; t.after(() => ui?.dispose());
  globals(t, { readMotionWeights: (pack: string, id: string) => track(store.read(7, pack, id)),
    saveMotionWeights: (value: unknown) => track(store.save(7, value)),
    invalidateMotionWeightSelection: (pack: string) => { store.invalidateSelection(7, pack); return Promise.resolve(); } });
  ui = new MotionWeightControls('gene', () => {}); const root = ui.element as unknown as Element;
  ui.select(motions[0]); ui.setAvailable(true);
  const editor = find(root, n => n.tagName === 'details'); editor.open = true; editor.ontoggle?.();
  const settle = async () => { for (let i = 0; i < 4; i++) { await Promise.allSettled(pending.splice(0)); await flush(); } };
  await settle(); type(editor, '权重，留空为未评估', '0.8');
  block = true; action(editor, '保存权重'); await reached;
  editor.open = false; editor.ontoggle?.(); ui.select(motions[1]); release(); await settle();
  await assert.rejects(readFile(file), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  editor.open = true; editor.ontoggle?.(); await settle();
  assert.equal(find(editor, n => n.attributes['aria-label'] === '权重，留空为未评估').value, '');
});
