import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PetUI, renderPet } from '../src/ui/PetUI';
import { isPetControlPoint } from '../src/ui/MoodCompanion';

class Classes {
  private readonly names = new Set<string>();
  add(...values: string[]) { values.forEach(value => this.names.add(value)); }
  remove(...values: string[]) { values.forEach(value => this.names.delete(value)); }
  contains(value: string) { return this.names.has(value); }
  toggle(value: string, force?: boolean) { const enabled = force ?? !this.names.has(value); if (enabled) this.names.add(value); else this.names.delete(value); return enabled; }
}
class Element extends EventTarget {
  classList = new Classes(); attributes = new Map<string, string>(); dataset: Record<string, string> = {};
  style = {}; title = ''; value = ''; textContent = ''; keyboard = false;
  onclick: ((event: Event) => void) | null = null;
  onsubmit: unknown; onkeydown: unknown;
  readonly children: Element[] = [];
  constructor(readonly id: string, readonly rect = { left: 0, top: 0, width: 0, height: 0 }) { super(); }
  getBoundingClientRect() { return { ...this.rect, x: this.rect.left, y: this.rect.top, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height }; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  getAttribute(key: string) { return this.attributes.get(key) ?? null; }
  removeAttribute(key: string) { this.attributes.delete(key); }
  contains(other: unknown): boolean { return other === this || this.children.some(child => child.contains(other)); }
  matches(selector: string) { return selector.includes(':focus-visible') && this.keyboard; }
  click() { this.onclick?.(new Event('click')); }
}

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const originalDocument = globalThis.document, originalWindow = globalThis.window;
  const nodes = new Map<string, Element>(), root = new EventTarget();
  const byId = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Element(id)); return nodes.get(id)!; };
  const toolbar = new Element('pet-toolbar', { left: 80, top: 8, width: 312, height: 60 }); nodes.set(toolbar.id, toolbar);
  const chat = new Element('pet-chat', { left: 12, top: 480, width: 376, height: 60 });
  const input = byId('chat-input'); chat.children.push(input);
  const actionCalls: unknown[] = [];
  const document = { documentElement: root, body: { classList: new Classes() }, activeElement: null,
    getElementById: byId, querySelector: (selector: string) => selector === '.pet-chat' ? chat : null,
    querySelectorAll: (selector: string) => selector.startsWith('#pet-toolbar,') ? [toolbar, chat] : [] };
  const view = Object.assign(new EventTarget(), { innerWidth: 400, innerHeight: 560, desktop: {
    openControls: async () => actionCalls.push('open'), updatePetReply: async () => {}, setPetWindowOperation: async (operation: unknown) => actionCalls.push(operation),
  } });
  globalThis.document = document as unknown as Document;
  globalThis.window = view as unknown as Window & typeof globalThis;
  const ui = new PetUI({ edit: value => actionCalls.push(['edit', value]), feature: value => actionCalls.push(['feature', value]),
    systemAudio: () => actionCalls.push('audio'), watchTogether: () => actionCalls.push('watch'), developerMode: () => actionCalls.push('developer'),
    popups: { 'screen-sharing-options': { isOpen: () => false, close() {} }, 'mood-companion': { isOpen: () => false, close() {} } },
    send: () => actionCalls.push('send'), stop: () => actionCalls.push('stop'), error: error => { throw Error(error); } });
  t.after(() => { ui.dispose(); globalThis.document = originalDocument; globalThis.window = originalWindow; });
  return { ui, toolbar, chat, input, document, view, byId, actionCalls, toggle: byId('pet-toolbar-toggle'),
    point(x: number, y: number) { const event = new Event('pointermove'); Object.assign(event, { clientX: x, clientY: y }); root.dispatchEvent(event); },
    advance(ms: number) { t.mock.timers.tick(ms); },
  };
}

test('the native button starts expanded and manually switches direction and readable state', t => {
  const f = fixture(t);
  assert.equal(f.toggle.textContent, '>'); assert.equal(f.toggle.attributes.get('aria-expanded'), 'true');
  assert.equal(f.toolbar.classList.contains('is-collapsed'), false);
  f.toggle.click();
  assert.equal(f.toggle.textContent, '<'); assert.equal(f.toggle.attributes.get('aria-expanded'), 'false');
  assert.equal(f.toggle.attributes.get('aria-label'), '展开工具栏'); assert.equal(f.toggle.dataset.tooltip, '展开工具栏');
  assert.equal(f.toolbar.classList.contains('is-collapsed'), true);
  f.toggle.click();
  assert.equal(f.toggle.textContent, '>'); assert.equal(f.toggle.attributes.get('aria-expanded'), 'true');
  assert.equal(f.toolbar.classList.contains('is-collapsed'), false);
  assert.deepEqual(f.actionCalls, [], 'manual folding cannot grant capture, submit chat or change camera/window settings');
});

test('microphone-only rhythm has its own truthful toolbar status without enabling system capture', t => {
  const f = fixture(t);
  f.ui.setAudioDanceState(true, '音频律动 · 麦克风 · 仅本机分析');
  assert.equal(f.byId('pet-system-audio-sharing').attributes.get('aria-pressed'), 'true');
  assert.match(f.byId('pet-media-indicator').textContent, /麦克风/);
  f.ui.setAudioDanceState(false, '');
  assert.equal(f.byId('pet-system-audio-sharing').attributes.get('aria-pressed'), 'false');
  assert.doesNotMatch(f.byId('pet-media-indicator').textContent, /麦克风/);
  assert.deepEqual(f.actionCalls, []);
});

test('collapsed hover uses the browser-reported small footprint and never expands itself', t => {
  const f = fixture(t); f.point(200, 35); f.toggle.click();
  // Feed the resulting browser layout to the existing geometry consumers; a real
  // DOM hit-test of the CSS shrink-to-fit rule remains part of native smoke.
  Object.assign(f.toolbar.rect, { left: 351, top: 8, width: 41, height: 41 });
  f.point(200, 35); f.advance(1000);
  assert.equal(f.toolbar.classList.contains('is-visible'), false);
  assert.equal(isPetControlPoint(f.document as unknown as Document, 200, 35), false, 'old strip is no longer an input reservation');
  assert.equal(isPetControlPoint(f.document as unknown as Document, 370, 25), true, 'only the actual collapsed entry is reserved');
  f.point(370, 25);
  assert.equal(f.toolbar.classList.contains('is-visible'), true);
  assert.equal(f.toolbar.classList.contains('is-collapsed'), true);
  f.point(200, 260); f.advance(1000); f.point(370, 25);
  assert.equal(f.toolbar.classList.contains('is-collapsed'), true, 'ordinary hover only reveals the entry');
  assert.equal(f.toggle.textContent, '<');
});

test('manual folding preserves capture, music, camera editing, window mode and chat draft', t => {
  const f = fixture(t); f.input.value = '未发送草稿';
  f.ui.applyRuntime({ voiceInput: true, screenSharing: true, cameraSharing: true, voiceOwner: 'pet', cameraOwner: 'pet' });
  f.ui.setSystemAudioState({ active: true }); f.ui.setEditing(true);
  const before = ['pet-voice-input', 'pet-screen-sharing', 'pet-camera-sharing', 'pet-system-audio-sharing', 'pet-camera-edit'].map(id => f.byId(id).attributes.get('aria-pressed'));
  f.toggle.click(); f.toggle.click();
  assert.deepEqual(['pet-voice-input', 'pet-screen-sharing', 'pet-camera-sharing', 'pet-system-audio-sharing', 'pet-camera-edit'].map(id => f.byId(id).attributes.get('aria-pressed')), before);
  assert.equal(f.input.value, '未发送草稿'); assert.deepEqual(f.actionCalls, []);
  f.ui.setWindowAdjusting(true); const calls = f.actionCalls.length;
  f.toggle.click();
  assert.equal(f.ui.windowInteractionBlocked, true); assert.equal(f.byId('pet-size-toggle').attributes.get('aria-pressed'), 'true');
  assert.equal(f.actionCalls.length, calls, 'folding does not exit an active window mode');
});

test('collapsed entry retains the original one-second leave and contact fade while keyboard focus can hold it', t => {
  const f = fixture(t); f.point(200, 35); f.toggle.click();
  f.ui.setInteraction(true); f.point(200, 260);
  f.advance(1999); assert.equal(f.toolbar.classList.contains('is-visible'), true);
  f.advance(1); assert.equal(f.toolbar.classList.contains('is-visible'), false);
  f.point(200, 35); assert.equal(f.toolbar.classList.contains('is-visible'), false, 'same contact cannot summon the folded entry');
  f.ui.setInteraction(false); f.point(200, 35);
  assert.equal(f.toolbar.classList.contains('is-visible'), true);
  f.toolbar.keyboard = true; f.toolbar.dispatchEvent(new Event('focusin')); f.point(200, 260); f.advance(3000);
  assert.equal(f.toolbar.classList.contains('is-visible'), true);
  f.toolbar.keyboard = false; const blur = new Event('focusout'); Object.assign(blur, { relatedTarget: null }); f.toolbar.dispatchEvent(blur);
  f.advance(1000); assert.equal(f.toolbar.classList.contains('is-visible'), false);
  assert.equal(f.toolbar.classList.contains('is-collapsed'), true);
});

test('framing reads the expanded toolbar bottom even while folded, and the fold survives the measurement', t => {
  const f = fixture(t);
  // Layout box only: offsetTop ignores the 4 px fade lift; folded it is the 41 px entry, expanded three rows.
  Object.defineProperties(f.toolbar, { offsetParent: { value: null }, offsetTop: { value: 7 },
    offsetHeight: { get() { return f.toolbar.classList.contains('is-collapsed') ? 41 : 90.2; } } });
  assert.equal(f.ui.expandedToolbarBottom(), 97.2);
  assert.equal(f.ui.toolbarReach(), 97.2 + 24, 'plus the margin where the faded toolbar reveals itself');
  f.toggle.click();
  assert.equal(f.ui.expandedToolbarBottom(), 97.2, 'a folded toolbar still reserves its expanded rows for framing');
  assert.equal(f.ui.toolbarReach(), 97.2 + 24);
  assert.equal(f.toolbar.classList.contains('is-collapsed'), true);
  assert.equal(f.toggle.attributes.get('aria-expanded'), 'false');
  assert.deepEqual(f.actionCalls, [], 'measuring changes no setting');
});

test('fresh rendering exposes a standard expanded button without a persisted preference', () => {
  const target = { innerHTML: '' }; renderPet(target as HTMLElement);
  assert.match(target.innerHTML, /id="pet-toolbar-toggle" type="button"[^>]*aria-expanded="true"[^>]*>&gt;<\/button>/);
  assert.doesNotMatch(target.innerHTML, /class="pet-toolbar is-collapsed"/);
});

test('和她一起看: one button, on only while both listening and screen sharing are on; a click asks the page to switch both', t => {
  const f = fixture(t), watch = f.byId('pet-watch-together');
  f.ui.applyRuntime({ voiceInput: false, screenSharing: true, cameraSharing: false, voiceOwner: 'pet', cameraOwner: 'pet' });
  assert.equal(watch.attributes.get('aria-pressed'), 'false', 'screen sharing alone is not watching together');
  f.ui.setSystemAudioState({ active: true });
  assert.equal(watch.attributes.get('aria-pressed'), 'true');
  assert.match(watch.dataset.tooltip, /开着/);
  f.ui.applyRuntime({ voiceInput: false, screenSharing: false, cameraSharing: false, voiceOwner: 'pet', cameraOwner: 'pet' });
  assert.equal(watch.attributes.get('aria-pressed'), 'false', 'listening alone is not watching together');
  assert.match(watch.dataset.tooltip, /同时打开/);
  watch.click();
  assert.equal(f.actionCalls.at(-1), 'watch');
});
