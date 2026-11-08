import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { PersonalizeVisualControls } from '../src/ui/PersonalizeVisualControls';
import { PersonalizeVisualAuthoring } from '../electron/personalize-visual-authoring';
import { VisualBehaviorStore } from '../electron/visual-behavior-store';
import { atomicWriteFile } from '../electron/atomic-file';
import type { SelectedVisualImage } from '../electron/selected-visual-image';
import { BEHAVIOR_RECIPES } from '../shared/behavior-recipes';
import type { BehaviorFaceMotionId, BehaviorMotionResource } from '../shared/behavior-motion';
import { VISUAL_MASK, VISUAL_GENE_SHA, type VisualPreview } from '../shared/personalize-visual';

class Element {
  children: Element[] = []; textContent = ''; value = ''; disabled = false; hidden = false;
  open = false; className = ''; src = ''; dataset: Record<string, string> = {};
  onclick: (() => void) | null = null; oninput: (() => void) | null = null;
  onchange: (() => void) | null = null; ontoggle: (() => void) | null = null;
  constructor(readonly tagName: string) {}
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = [...nodes]; }
  setAttribute(_name: string, _value: string) {}
}
const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
const microtasks = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const ownedRoot = path.resolve('.local/personalize-visual-main-v1/evidence/ui-owned-temp');
const study = JSON.stringify({ observations: [{ region: 'eye', visibility: 'ambiguous', description: '合成图中眼角看不清。' }],
  inferences: [{ label: '候选而非结论', rationale: '需要用户解释。', unknown: '不能确定是否表示愉快。' }],
  questions: ['你希望这个眼神表达什么？'], insufficient: '静图不提供动作时序。' });

async function make() {
  await mkdir(ownedRoot, { recursive: true });
  const directory = await mkdtemp(path.join(ownedRoot, 'case-'));
  const a = randomUUID(), b = randomUUID(), owner = 7;
  let active = a, failWrite = false, confirmValue = true, unsubscribed = 0;
  let listener: ((value: { id: string; token: string }) => void) | undefined;
  const pending: Promise<unknown>[] = [], gates = new Map<string, ReturnType<typeof deferred>>();
  const confirmations: string[] = [], streams: { prompt: string; image: string; signal: AbortSignal }[] = [];
  const previews: VisualPreview[] = [], receipts: string[] = [], released: string[] = [], changed: string[] = [];
  const reservations: { signal: AbortSignal; released: boolean }[] = [];
  const track = <T>(p: Promise<T>) => { pending.push(p); void p.catch(() => {}); return p; };
  const wait = async (key: string) => { const g = gates.get(key); if (g) await g.promise; };
  const store = new VisualBehaviorStore(directory, () => [a, b], async (file, data) => {
    await wait('save'); if (failWrite) throw Error('synthetic disk detail must not leak');
    await atomicWriteFile(file, data);
  });
  await store.load();
  const service = new PersonalizeVisualAuthoring(store, {
    context: () => ({ characterId: active, identity: `synthetic:${active}`, codex: true,
      imageSupported: true, connectionLabel: '合成 Claude port', modelUrl: 'mmd-asset://synthetic/model' }),
    verifyTarget: async () => true,
    chooseImage: async () => {
      const id = randomUUID();
      // This is a typed in-memory material port, not a JPEG decoder/codec test.
      const image: SelectedVisualImage = { dataUrl: 'data:image/jpeg;base64,U1lOVEhFVElD',
        previewDataUrl: 'data:image/jpeg;base64,U1lOVEhFVElD', width: 32, height: 32,
        sha256: createHash('sha256').update(id).digest('hex'), release() {
          released.push(id); image.dataUrl = ''; image.previewDataUrl = ''; image.sha256 = '';
        } };
      await wait('choose'); return image;
    },
    reserve: (_owner, _id, controller) => {
      const row = { signal: controller.signal, released: false }; reservations.push(row);
      return () => { assert.equal(row.released, false); row.released = true; };
    },
    stream: async (prompt, image, signal, append) => {
      streams.push({ prompt, image, signal }); await wait('research'); append(study);
    },
    resolvePreview: async value => {
      const recipe = BEHAVIOR_RECIPES[value.selection.bindingId];
      const resource: BehaviorMotionResource = { cueId: value.id, bindingId: value.selection.bindingId,
        sha256: recipe.sha256, motionId: recipe.motionId as BehaviorFaceMotionId, durationMs: recipe.durationMs,
        packId: 'gene', recipe: 'emotion-face', url: `mmd-asset://synthetic/${recipe.motionId}` };
      return resource;
    },
    previewCancelled: (_owner, id, token) => listener?.({ id, token }),
    changed: id => changed.push(id), now: () => 1_000,
  });
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => new Element(tag) } });
  const root = new Element('div');
  const ui = new PersonalizeVisualControls(root as unknown as HTMLElement, {
    confirm: text => { confirmations.push(text); return confirmValue; },
    api: {
      getVisualAuthoring: id => track(service.get(owner, id)),
      chooseVisualMaterial: (id, revision) => track(service.choose(owner, id, revision)),
      researchVisual: request => track(service.research(owner, request)),
      previewVisualBinding: (id, revision, selection) => track(service.preview(owner, id, revision, selection)),
      visualPreviewReceipt: receipt => track(Promise.resolve().then(() => service.receipt(owner, receipt))),
      saveVisualBehavior: request => track(service.save(owner, request)),
      changeVisualBehavior: request => track(service.change(owner, request)),
      cancelVisualAuthoring: id => track(Promise.resolve().then(() => service.close(owner, id))),
      onVisualPreviewCancelled: callback => { listener = callback; return () => { listener = undefined; unsubscribed++; }; },
    },
    preview: value => track((async () => {
      previews.push(value); assert.equal(value.mask, VISUAL_MASK); assert.equal(value.targetModelSha, VISUAL_GENE_SHA);
      service.receipt(owner, { phase: 'bind', id: value.id, token: value.token, stageGeneration: 3 }); receipts.push('bind');
      const resource = await service.resolvePreview(owner, value.id, value.token, 3);
      assert.equal(resource.durationMs, 10_000); assert.equal(resource.sha256, BEHAVIOR_RECIPES[value.selection.bindingId].sha256);
      receipts.push('resolve'); await wait('preview');
      service.receipt(owner, { phase: 'ready', id: value.id, token: value.token, stageGeneration: 3 }); receipts.push('ready');
      return true;
    })()),
  });
  const field = (key: string) => { const item = all(root).find(n => n.dataset.visualField === key); assert.ok(item); return item; };
  const button = (key: string) => { const item = all(root).find(n => n.dataset.visualAction === key); assert.ok(item); return item; };
  const details = all(root).find(n => n.tagName === 'details')!;
  const settle = async () => { for (let i = 0; i < 12; i++) { const count = pending.length; await Promise.allSettled([...pending]); await microtasks(); if (count === pending.length) return; } throw Error('fixture did not settle'); };
  const f = { a, b, ui, root, store, directory, streams, previews, receipts, reservations, released, changed, confirmations,
    field, button, details, settle,
    select: (id = a) => { active = id; ui.select({ id, name: id === a ? '合成A' : '合成B' }); },
    toggle: (open: boolean) => { details.open = open; details.ontoggle?.(); },
    type: (key: string, text: string) => { const item = field(key); assert.equal(item.disabled, false); item.value = text; item.oninput?.(); },
    click: (key: string) => { const item = button(key); assert.equal(item.disabled, false, key); item.onclick?.(); },
    confirm: (yes: boolean) => { confirmValue = yes; }, fail: (yes: boolean) => { failWrite = yes; },
    gate: (key: string) => { const gate = deferred(); gates.set(key, gate); return { release: () => { gates.delete(key); gate.resolve(); } }; },
    text: () => all(root).map(n => n.textContent).join('\n'),
    close: async () => {
      ui.dispose(); service.invalidate(); for (const g of gates.values()) g.resolve(); gates.clear(); await settle();
      assert.equal(unsubscribed, 1); assert.ok(reservations.every(row => row.released));
      if (original) Object.defineProperty(globalThis, 'document', original); else Reflect.deleteProperty(globalThis, 'document');
      assert.equal(path.dirname(path.resolve(directory)), ownedRoot); assert.ok(path.basename(directory).startsWith('case-'));
      await rm(directory, { recursive: true, force: true });
    },
  };
  f.select(); return f;
}
async function fixture(run: (f: Awaited<ReturnType<typeof make>>) => Promise<void>) { const f = await make(); try { await run(f); } finally { await f.close(); } }
async function selected(f: Awaited<ReturnType<typeof make>>) { f.toggle(true); await f.settle(); f.click('choose'); await f.settle(); }
function selection(f: Awaited<ReturnType<typeof make>>, label = '我确认的眉眼') { f.type('choice', 'mood.content|face.smile'); f.type('label', label); }
async function preview(f: Awaited<ReturnType<typeof make>>) { f.click('preview'); await f.settle(); assert.equal(f.button('save').disabled, false); }

test('details must open; image selection and declined confirmations do not submit, each refinement requires fresh consent', async () => fixture(async f => {
  assert.equal(f.details.open, false); assert.equal(f.streams.length, 0);
  f.click('choose'); await f.settle(); assert.equal(f.streams.length, 0); assert.equal(f.released.length, 0);
  await selected(f); assert.equal(f.streams.length, 0);
  f.confirm(false); f.click('research'); await f.settle(); assert.equal(f.streams.length, 0);
  f.confirm(true); f.click('research'); await f.settle(); assert.equal(f.streams.length, 1);
  assert.ok(f.text().includes('你希望这个眼神表达什么')); assert.equal(f.field('choice').value, '');
  assert.equal(f.button('preview').disabled, true); assert.equal(f.store.get(f.a).revision, 0);
  f.type('feedback', '请保留认真，不是快乐'); f.confirm(false); f.click('research'); await f.settle(); assert.equal(f.streams.length, 1);
  f.confirm(true); f.click('research'); await f.settle(); assert.equal(f.streams.length, 2);
  assert.equal(f.streams[0].image, f.streams[1].image); assert.ok(f.streams[1].prompt.includes('请保留认真'));
  assert.ok(f.streams[1].prompt.includes('previousStudy')); assert.equal(f.confirmations.length, 4);
  assert.deepEqual(await readdir(f.directory), []);
}));

test('manual semantic and label plus matching software preview gate explicit save, disable and one undo', async () => fixture(async f => {
  await selected(f); selection(f); await preview(f);
  assert.deepEqual(f.receipts, ['bind', 'resolve', 'ready']); assert.equal(f.store.get(f.a).revision, 0);
  f.confirm(false); f.click('save'); await f.settle(); assert.equal(f.store.get(f.a).revision, 0);
  f.confirm(true); f.click('save'); await f.settle(); assert.equal(f.store.get(f.a).profile.label, '我确认的眉眼');
  assert.equal(f.store.get(f.a).profile.enabled, true); assert.equal(f.store.get(f.b).revision, 0);
  const json = JSON.parse(await readFile(path.join(f.directory, 'personalize-visual.json'), 'utf8'));
  assert.deepEqual(Object.keys(json.entries[0].profile).sort(), ['bindingId', 'enabled', 'label', 'semantic', 'strength', 'targetModelSha']);
  assert.ok(!JSON.stringify(json).includes('base64')); assert.ok(!JSON.stringify(json).includes('observations'));
  f.click('disable'); await f.settle(); assert.equal(f.store.get(f.a).profile.enabled, false);
  f.click('undo'); await f.settle(); assert.equal(f.store.get(f.a).profile.enabled, true); assert.equal(f.button('undo').disabled, true);
  assert.equal(f.streams.length, 0);
}));

test('failed save keeps same-card draft and preview for explicit retry without leaking disk error', async () => fixture(async f => {
  await selected(f); selection(f, '同卡重试'); await preview(f); f.fail(true); f.click('save'); await f.settle();
  assert.equal(f.store.get(f.a).revision, 0); assert.equal(f.field('label').value, '同卡重试');
  assert.ok(!f.text().includes('synthetic disk detail')); assert.ok(f.text().includes('草稿已保留'));
  f.fail(false); f.click('save'); await f.settle(); assert.equal(f.store.get(f.a).revision, 1);
  assert.equal(f.store.get(f.a).profile.label, '同卡重试'); assert.equal(f.store.get(f.b).revision, 0);
}));

test('editing while research is pending aborts its lease and ignores even a late provider result', async () => fixture(async f => {
  await selected(f); const gate = f.gate('research'); f.click('research'); await microtasks();
  assert.equal(f.streams.length, 1); f.type('feedback', '新的个人意图'); await microtasks();
  assert.equal(f.reservations[0].signal.aborted, true); gate.release(); await f.settle();
  assert.equal(f.reservations[0].released, true); assert.equal(f.store.get(f.a).revision, 0);
  assert.ok(!f.text().includes('合成图中眼角看不清')); assert.equal(f.field('choice').value, '');
  assert.equal(all(f.root).find(n => n.tagName === 'img')!.src, 'data:,');
}));

test('late image choice after switching cards is released and cannot populate the new card', async () => fixture(async f => {
  f.toggle(true); await f.settle(); const gate = f.gate('choose'); f.click('choose'); await microtasks();
  f.select(f.b); await microtasks(); gate.release(); await f.settle();
  assert.equal(f.released.length, 1); assert.ok(f.text().includes(`合成B · ${f.b}`));
  assert.equal(all(f.root).find(n => n.tagName === 'img')!.src, 'data:,');
  assert.equal(f.store.get(f.a).revision, 0); assert.equal(f.store.get(f.b).revision, 0); assert.equal(f.streams.length, 0);
}));

test('accepted save may finish for captured A but cannot overwrite edited A draft or current B', async () => fixture(async f => {
  await selected(f); selection(f, '已明确确认A'); await preview(f); const gate = f.gate('save');
  f.click('save'); await microtasks(); f.type('label', '保存期间新草稿'); f.select(f.b); await microtasks();
  gate.release(); await f.settle(); assert.equal(f.store.get(f.a).profile.label, '已明确确认A');
  assert.equal(f.store.get(f.b).revision, 0); assert.equal(f.field('label').value, '');
  f.select(f.a); await f.settle(); assert.equal(f.field('label').value, '保存期间新草稿');
}));

test('closing during preview rejects late readiness; reopening and removing material releases it without saving', async () => fixture(async f => {
  await selected(f); selection(f); const gate = f.gate('preview'); f.click('preview'); await microtasks();
  assert.deepEqual(f.receipts, ['bind', 'resolve']); f.toggle(false); gate.release(); await f.settle();
  assert.equal(f.store.get(f.a).revision, 0); assert.equal(f.released.length, 1); assert.equal(f.button('save').disabled, true);
  f.toggle(true); await f.settle(); f.click('choose'); await f.settle(); selection(f); await preview(f);
  f.click('remove'); await f.settle(); assert.equal(f.released.length, 2); assert.equal(f.button('save').disabled, true);
  assert.equal(all(f.root).find(n => n.tagName === 'img')!.src, 'data:,'); assert.deepEqual(await readdir(f.directory), []);
}));
