import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { nearHoverZone } from '../src/ui/HoverVisibility';
import { PetUI } from '../src/ui/PetUI';

test('hover zones follow their real rectangles, with a small exit margin and no whole-half activation', () => {
  const toolbar = { left: 100, top: 8, width: 280, height: 60 };
  assert.equal(nearHoverZone(toolbar, 80, 75), true);
  assert.equal(nearHoverZone(toolbar, 71, 75), false);
  assert.equal(nearHoverZone(toolbar, 71, 75, true), true);
  assert.equal(nearHoverZone(toolbar, 67, 75, true), false);
  assert.equal(nearHoverZone(toolbar, 20, 160), false);
  assert.equal(nearHoverZone(toolbar, 200, 280), false);
  assert.equal(nearHoverZone({ ...toolbar, width: 0 }, 110, 20), false);
  assert.equal(nearHoverZone(toolbar, Number.NaN, 20), false);
});

class Classes {
  private readonly names = new Set<string>();
  add(...values: string[]) { values.forEach(value => this.names.add(value)); }
  remove(...values: string[]) { values.forEach(value => this.names.delete(value)); }
  contains(value: string) { return this.names.has(value); }
  toggle(value: string, force?: boolean) { const enabled = force ?? !this.names.has(value); if (enabled) this.names.add(value); else this.names.delete(value); return enabled; }
}
class Element extends EventTarget {
  classList = new Classes();
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  style = {};
  value = '';
  textContent = '';
  keyboard = false;
  onclick: unknown;
  onsubmit: unknown;
  onkeydown: unknown;
  constructor(readonly id: string, private readonly rect = { left: 0, top: 0, width: 0, height: 0 }, readonly children: Element[] = []) { super(); }
  getBoundingClientRect() { return { ...this.rect, x: this.rect.left, y: this.rect.top, bottom: this.rect.top + this.rect.height, right: this.rect.left + this.rect.width }; }
  contains(other: unknown): boolean { return other === this || this.children.some(child => child.contains(other)); }
  matches(selector: string) { return selector === ':focus-visible' && this.keyboard; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  removeAttribute(key: string) { this.attributes.delete(key); }
}

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const originalDocument = globalThis.document, originalWindow = globalThis.window;
  const root = new EventTarget(), nodes = new Map<string, Element>();
  const input = new Element('chat-input'), toolbar = new Element('pet-toolbar', { left: 100, top: 8, width: 280, height: 60 });
  const chat = new Element('chat', { left: 12, top: 480, width: 376, height: 60 }, [input]);
  nodes.set(input.id, input); nodes.set(toolbar.id, toolbar);
  const byId = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Element(id)); return nodes.get(id)!; };
  const owner = { documentElement: root, body: { classList: new Classes() }, activeElement: null as Element | null,
    getElementById: byId, querySelector: (selector: string) => selector === '.pet-chat' ? chat : null, querySelectorAll: () => [] };
  const view = Object.assign(new EventTarget(), { innerWidth: 400, innerHeight: 560, desktop: {
    openControls: async () => {}, updatePetReply: async () => {}, setPetWindowOperation: async () => {},
  } });
  globalThis.document = owner as unknown as Document;
  globalThis.window = view as unknown as Window & typeof globalThis;
  let ui: PetUI;
  ui = new PetUI({ edit() {}, feature() {}, popups: { 'screen-sharing-options': { isOpen: () => false, close() {} }, 'mood-companion': { isOpen: () => false, close() {} } }, send() {}, stop() {}, error(error) { throw Error(error); }, onInteractionBlockChange() { ui?.setInteraction(false); } });
  t.after(() => { ui.dispose(); globalThis.document = originalDocument; globalThis.window = originalWindow; });
  return { ui, toolbar, chat, input, owner, view, byId,
    point(x: number, y: number) { const event = new Event('pointermove'); Object.assign(event, { clientX: x, clientY: y }); root.dispatchEvent(event); },
    advance(ms: number) { t.mock.timers.tick(ms); },
    focusChat(focused: boolean) {
      owner.activeElement = focused ? input : null;
      const event = new Event(focused ? 'focusin' : 'focusout'); Object.assign(event, { relatedTarget: null }); chat.dispatchEvent(event);
    },
  };
}

test('PetUI reveals toolbar and chat independently near their own layout and leaves the middle inactive', t => {
  const f = fixture(t);
  f.point(200, 260); assert.equal(f.toolbar.classList.contains('is-visible'), false); assert.equal(f.chat.classList.contains('is-visible'), false);
  f.point(80, 75); assert.equal(f.toolbar.classList.contains('is-visible'), true); assert.equal(f.chat.classList.contains('is-visible'), false);
  f.point(200, 260); f.advance(1000); assert.equal(f.toolbar.classList.contains('is-visible'), false);
  f.point(200, 465); assert.equal(f.chat.classList.contains('is-visible'), true); assert.equal(f.toolbar.classList.contains('is-visible'), false);
  f.point(5, 200); f.advance(1000); assert.equal(f.chat.classList.contains('is-visible'), false);
});

test('PetUI contact waits two seconds after emoji entry, ignores continuous progress, and cannot summon hidden zones', t => {
  const f = fixture(t);
  f.ui.setInteraction(true); f.advance(2000); assert.equal(f.toolbar.classList.contains('is-visible'), false);
  f.ui.setInteraction(false); f.point(80, 75); f.ui.setInteraction(true); f.point(200, 260);
  f.advance(1000); assert.equal(f.toolbar.classList.contains('is-visible'), true);
  f.ui.setInteractionProgress(0.6); f.ui.setInteraction(true); f.advance(999); assert.equal(f.toolbar.classList.contains('is-visible'), true);
  f.advance(1); assert.equal(f.toolbar.classList.contains('is-visible'), false);
  f.point(80, 75); assert.equal(f.toolbar.classList.contains('is-visible'), false, 'same contact does not restart or reveal the toolbar');
  f.ui.setInteraction(false); assert.equal(f.toolbar.classList.contains('is-visible'), false);
  f.point(80, 75); assert.equal(f.toolbar.classList.contains('is-visible'), true);
});

test('focused chat keeps its original draft while pointer contact and toolbar timing remain independent', t => {
  const f = fixture(t); f.input.value = '未发送的草稿';
  f.point(200, 465); f.focusChat(true); f.point(200, 260); f.ui.setInteraction(true); f.advance(5000);
  assert.equal(f.chat.classList.contains('is-visible'), true); assert.equal(f.input.value, '未发送的草稿');
  assert.equal(f.toolbar.classList.contains('is-visible'), false);
  f.focusChat(false); f.advance(999); assert.equal(f.chat.classList.contains('is-visible'), true);
  f.advance(1); assert.equal(f.chat.classList.contains('is-visible'), false); assert.equal(f.input.value, '未发送的草稿');
});

test('window adjustment keeps controls available and host hide cancels old contact timers', t => {
  const f = fixture(t); f.point(80, 75); f.ui.setInteraction(true); f.advance(900);
  f.ui.setWindowAdjusting(true); f.point(200, 260); f.advance(5000); assert.equal(f.toolbar.classList.contains('is-visible'), true);
  f.ui.setHostVisible(false); f.advance(5000); assert.equal(f.toolbar.classList.contains('is-visible'), false); assert.equal(f.chat.classList.contains('is-visible'), false);
  assert.equal(f.byId('pet-size-toggle').attributes.get('aria-pressed'), 'false');
});
