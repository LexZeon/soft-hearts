import { registerUiMessages, setUiLanguage } from '../shared/ui-language';
import { ENGLISH_SETTINGS_UI_COPY } from '../shared/ui-copy.settings.en';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BlushCalibrationControls, type BlushCalibrationControlsOptions } from '../src/ui/BlushCalibrationControls';
import { DEFAULT_BLUSH_CALIBRATION, type BlushCalibration, type BlushCalibrationView } from '../shared/blush';

// Only text nodes and event callbacks are supplied here. Draft, save and model
// generation behavior runs through the real production controls class.
class Element {
  children: Element[] = [];
  parent: Element | null = null;
  id = ''; className = ''; textContent = ''; value = ''; type = '';
  min = ''; max = ''; step = ''; hidden = false; disabled = false;
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  onclick: (() => void) | null = null;
  oninput: (() => void) | null = null;
  constructor(readonly tagName: string) {}
  append(...nodes: Element[]): void { for (const child of nodes) { child.parent = this; this.children.push(child); } }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  click(): void { assert.equal(this.disabled, false); this.onclick?.(); }
}
const all = (root: Element): Element[] => [root, ...root.children.flatMap(all)];
const text = (root: Element): string => all(root).map(element => element.textContent).join('\n');
function byId(root: Element, id: string): Element { const found = all(root).find(element => element.id === id); assert.ok(found, `#${id}`); return found; }
const defaults = (): BlushCalibration => ({ ...DEFAULT_BLUSH_CALIBRATION });
function view(modelKey: string | null = 'model-a', revision = 1, calibration = defaults(), storageError?: string): BlushCalibrationView {
  return { modelKey, revision, calibration, ...(storageError ? { storageError } : {}) };
}
function edit(root: Element, field: keyof BlushCalibration, value: number): void {
  const input = byId(root, `blush-calibration-${field}`);
  assert.equal(input.disabled, false);
  input.value = String(value); input.oninput?.();
}
async function settle(): Promise<void> { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); }
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fixture(overrides: Partial<BlushCalibrationControlsOptions> = {}) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: { createElement: (tag: string) => new Element(tag) } });
  const root = new Element('div');
  const applied: { modelKey: string; value: BlushCalibration }[] = [];
  const previews: BlushCalibration[] = [], errors: string[] = [];
  const controls = new BlushCalibrationControls(root as unknown as HTMLElement, {
    onApply(modelKey, value) { applied.push({ modelKey, value: { ...value } }); },
    onPreview(value) { previews.push({ ...value }); },
    onError(message) { errors.push(message); },
    ...overrides,
  });
  return { controls, root, applied, previews, errors,
    restore() {
      controls.dispose();
      if (descriptor) Object.defineProperty(globalThis, 'document', descriptor); else Reflect.deleteProperty(globalThis, 'document');
    },
  };
}

test('the five real sliders show calibrated reference units, strict bounds and no model identity', () => {
  const f = fixture();
  try {
    f.controls.update(view('opaque-model-identifier'), '眼骨可用；嘴点为估算参考。');
    for (const field of ['eyeOffsetX', 'eyeOffsetY', 'mouthOffsetX', 'mouthOffsetY']) {
      const input = byId(f.root, `blush-calibration-${field}`);
      assert.equal(input.min, '-0.5'); assert.equal(input.max, '0.5'); assert.equal(input.step, '0.01');
      assert.match(input.attributes['aria-label'], /原眼距/);
    }
    const spacing = byId(f.root, 'blush-calibration-eyeSpacingScale');
    assert.equal(spacing.min, '0.5'); assert.equal(spacing.max, '1.5'); assert.equal(spacing.value, '1');
    assert.ok(text(f.root).includes('嘴点为估算参考'));
    assert.ok(text(f.root).includes('不调整脸红强度或大小'));
    assert.ok(!text(f.root).includes('opaque-model-identifier'));
    assert.equal(byId(f.root, 'blush-calibration-apply').disabled, true);
    assert.deepEqual(f.applied, []);
  } finally { f.restore(); }
});

test('slider edits stay in a complete local draft until explicit preview or save', async () => {
  const f = fixture();
  try {
    f.controls.update(view());
    edit(f.root, 'eyeOffsetX', 0.15);
    edit(f.root, 'mouthOffsetY', -0.2);
    assert.deepEqual(f.applied, []); assert.deepEqual(f.previews, []);
    byId(f.root, 'blush-calibration-preview').click(); await settle();
    assert.deepEqual(f.previews, [{ ...defaults(), eyeOffsetX: 0.15, mouthOffsetY: -0.2 }]);
    assert.deepEqual(f.applied, []);
    byId(f.root, 'blush-calibration-apply').click(); await settle();
    assert.deepEqual(f.applied, [{ modelKey: 'model-a', value: { ...defaults(), eyeOffsetX: 0.15, mouthOffsetY: -0.2 } }]);
    assert.equal(byId(f.root, 'blush-calibration-apply').disabled, true);
    assert.match(byId(f.root, 'blush-calibration-status').textContent, /已保存/);
  } finally { f.restore(); }
});

test('same-model broadcasts preserve a dirty draft and surface storage errors independently', () => {
  const f = fixture();
  try {
    f.controls.update(view()); edit(f.root, 'eyeOffsetY', 0.2);
    f.controls.update(view('model-a', 2, { ...defaults(), eyeOffsetY: -0.1 }, '校准保存失败，仍在内存。'));
    assert.equal(byId(f.root, 'blush-calibration-eyeOffsetY').value, '0.2');
    assert.match(byId(f.root, 'blush-calibration-status').textContent, /保存失败/);
    assert.equal(byId(f.root, 'blush-calibration-status').dataset.error, 'true');
    f.controls.update(view('model-a', 3));
    assert.equal(byId(f.root, 'blush-calibration-eyeOffsetY').value, '0.2');
    assert.ok(!byId(f.root, 'blush-calibration-status').textContent.includes('保存失败'));
  } finally { f.restore(); }
});

test('switching models discards the former draft and old-model support immediately', () => {
  const f = fixture();
  try {
    f.controls.update(view(), 'OLD_MODEL_SUPPORT'); edit(f.root, 'eyeOffsetX', 0.3);
    f.controls.update(view('model-b', 1, { ...defaults(), mouthOffsetX: 0.1 }));
    assert.equal(byId(f.root, 'blush-calibration-eyeOffsetX').value, '0');
    assert.equal(byId(f.root, 'blush-calibration-mouthOffsetX').value, '0.1');
    assert.ok(!text(f.root).includes('OLD_MODEL_SUPPORT'));
    assert.equal(byId(f.root, 'blush-calibration-apply').disabled, true);
  } finally { f.restore(); }
});

test('default reset fills only a pending draft and cannot silently persist or preview it', async () => {
  const f = fixture();
  try {
    f.controls.update(view('model-a', 1, { ...defaults(), eyeOffsetX: 0.25, eyeSpacingScale: 1.2 }));
    byId(f.root, 'blush-calibration-reset').click(); await settle();
    assert.equal(byId(f.root, 'blush-calibration-eyeOffsetX').value, '0');
    assert.equal(byId(f.root, 'blush-calibration-eyeSpacingScale').value, '1');
    assert.deepEqual(f.applied, []); assert.deepEqual(f.previews, []);
    assert.equal(byId(f.root, 'blush-calibration-apply').disabled, false);
    byId(f.root, 'blush-calibration-apply').click(); await settle();
    assert.deepEqual(f.applied[0], { modelKey: 'model-a', value: defaults() });
  } finally { f.restore(); }
});

test('save captures the model key and a late completion cannot replace the next model draft', async () => {
  const pending = deferred(), calls: { key: string; value: BlushCalibration }[] = [];
  const f = fixture({ onApply(key, value) { calls.push({ key, value }); return pending.promise; } });
  try {
    f.controls.update(view()); edit(f.root, 'eyeOffsetX', 0.1);
    byId(f.root, 'blush-calibration-apply').click();
    f.controls.update(view('model-b', 1)); edit(f.root, 'mouthOffsetX', -0.25);
    pending.resolve(); await settle();
    assert.equal(calls[0].key, 'model-a');
    assert.equal(calls[0].value.eyeOffsetX, 0.1);
    assert.equal(byId(f.root, 'blush-calibration-mouthOffsetX').value, '-0.25');
    assert.equal(byId(f.root, 'blush-calibration-apply').disabled, false);
    assert.ok(!byId(f.root, 'blush-calibration-status').textContent.includes('已保存'));
  } finally { pending.resolve(); f.restore(); }
});

test('old-model save errors are ignored after a switch and cannot expose stale notices', async () => {
  const pending = deferred();
  const f = fixture({ onApply() { return pending.promise; } });
  try {
    f.controls.update(view()); edit(f.root, 'eyeOffsetX', 0.1);
    byId(f.root, 'blush-calibration-apply').click(); f.controls.update(view('model-b'));
    pending.reject(new Error('OLD_MODEL_ERROR')); await settle();
    assert.deepEqual(f.errors, []);
    assert.ok(!text(f.root).includes('OLD_MODEL_ERROR'));
  } finally { f.restore(); }
});

test('failed saves preserve the complete editable draft and allow an explicit retry', async () => {
  let attempts = 0;
  const f = fixture({ onApply() { if (!attempts++) throw new Error('本机保存失败'); } });
  try {
    f.controls.update(view()); edit(f.root, 'eyeSpacingScale', 1.1);
    byId(f.root, 'blush-calibration-apply').click(); await settle();
    assert.deepEqual(f.errors, ['本机保存失败']);
    assert.equal(byId(f.root, 'blush-calibration-eyeSpacingScale').value, '1.1');
    assert.equal(byId(f.root, 'blush-calibration-apply').disabled, false);
    byId(f.root, 'blush-calibration-apply').click(); await settle();
    assert.equal(attempts, 2);
    assert.equal(byId(f.root, 'blush-calibration-apply').disabled, true);
  } finally { f.restore(); }
});

test('no-model controls cannot save or preview, even through retained click callbacks', async () => {
  const f = fixture();
  try {
    f.controls.update(view(null));
    assert.equal(byId(f.root, 'blush-calibration-apply').disabled, true);
    assert.equal(byId(f.root, 'blush-calibration-preview').disabled, true);
    byId(f.root, 'blush-calibration-apply').onclick?.();
    byId(f.root, 'blush-calibration-preview').onclick?.(); await settle();
    assert.deepEqual(f.applied, []); assert.deepEqual(f.previews, []);
  } finally { f.restore(); }
});

test('shared validation rejects invalid drafts before preview or persistence', async () => {
  const f = fixture();
  try {
    f.controls.update(view()); edit(f.root, 'eyeOffsetX', 0.6);
    assert.equal(byId(f.root, 'blush-calibration-apply').disabled, true);
    assert.equal(byId(f.root, 'blush-calibration-preview').disabled, true);
    byId(f.root, 'blush-calibration-preview').onclick?.();
    byId(f.root, 'blush-calibration-apply').onclick?.(); await settle();
    assert.deepEqual(f.applied, []); assert.deepEqual(f.previews, []);
    assert.ok(f.errors.length > 0);
    edit(f.root, 'eyeOffsetX', 0.1);
    assert.equal(byId(f.root, 'blush-calibration-apply').disabled, false);
  } finally { f.restore(); }
});

test('stale same-model revisions do not roll back controls, and support is rendered as text', () => {
  const f = fixture();
  try {
    f.controls.update(view('model-a', 4, { ...defaults(), mouthOffsetY: 0.15 }), '<img src=x onerror=unsafe> 嘴点估算');
    f.controls.update(view('model-a', 3));
    assert.equal(byId(f.root, 'blush-calibration-mouthOffsetY').value, '0.15');
    assert.ok(text(f.root).includes('<img src=x onerror=unsafe>'));
    assert.equal(all(f.root).some(element => element.tagName === 'img'), false);
    assert.ok(all(f.root).some(element => element.tagName === 'output' && element.attributes.role === 'status'));
  } finally { f.restore(); }
});

test('preview receives a copy, and disposal detaches handlers and ignores pending completion', async () => {
  const pending = deferred();
  const f = fixture({ onPreview(value) { value.eyeOffsetX = 0.4; return pending.promise; } });
  try {
    f.controls.update(view()); edit(f.root, 'eyeOffsetX', 0.1);
    const preview = byId(f.root, 'blush-calibration-preview'); preview.click();
    assert.equal(byId(f.root, 'blush-calibration-eyeOffsetX').value, '0.1');
    f.controls.dispose(); pending.resolve(); await settle();
    assert.equal(f.root.children.length, 0);
    assert.equal(preview.onclick, null);
    assert.deepEqual(f.applied, []); assert.deepEqual(f.errors, []);
  } finally { pending.resolve(); f.restore(); }
});

test('English calibration labels retain host model identity and do not save or preview automatically',async()=>{
 const raw='synthetic calibration store E_DISK_123';
 registerUiMessages({en:ENGLISH_SETTINGS_UI_COPY,'zh-CN':{}});setUiLanguage('en');const f=fixture({onApply(){throw Error(raw);}});
 try{f.controls.update(view('保存当前模型校准'));
 assert.equal(byId(f.root,'blush-calibration-apply').textContent,'Save model calibration');
 assert.equal(byId(f.root,'blush-calibration-eyeOffsetX').attributes['aria-label'],'Eye reference horizontal offset, in original eye spacing');
 assert.deepEqual(f.applied,[]);assert.deepEqual(f.previews,[]);
 edit(f.root,'eyeOffsetX',0.1);byId(f.root,'blush-calibration-apply').click();await settle();
 assert.ok(!byId(f.root,'blush-calibration-status').textContent.includes(raw));
 assert.ok(text(f.root).includes(raw));assert.deepEqual(f.errors,[raw]);
 }finally{f.restore();setUiLanguage('zh-CN');}
});
