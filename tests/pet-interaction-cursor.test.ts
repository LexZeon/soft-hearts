import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PetInteraction, type PetInteractionEvent, type PetInteractionFeedback } from '../src/ui/PetInteraction';
import { PetInteractionCursor } from '../src/ui/PetInteractionCursor';

class Style {
  [key: string]: unknown;
  cursor = '';
  private priorities = new Map<string, string>();
  getPropertyValue(name: string): string { return typeof this[name] === 'string' ? this[name] as string : ''; }
  getPropertyPriority(name: string): string { return this.priorities.get(name) ?? ''; }
  setProperty(name: string, value: string, priority = ''): void { this[name] = value; this.priorities.set(name, priority); }
  removeProperty(name: string): string { const previous = this.getPropertyValue(name); this[name] = ''; this.priorities.delete(name); return previous; }
}
class Node extends EventTarget {
  children: Node[] = [];
  parent: Node | null = null;
  style = new Style();
  textContent = '';
  hidden = false;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  constructor(readonly ownerDocument: DocumentFixture, readonly tagName: string) { super(); }
  append(...nodes: Node[]): void { for (const child of nodes) { child.parent = this; this.children.push(child); } }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)); }
  getBoundingClientRect() { return { left: 10, top: 20, width: 300, height: 400 }; }
}
class DocumentFixture extends EventTarget {
  readonly body = new Node(this, 'body');
  readonly documentElement = this.body;
  hidden = false;
  constructor(readonly defaultView: EventTarget & { performance: { now(): number } }) { super(); }
  createElement(tag: string): Node { return new Node(this, tag); }
}
function fixture(t: TestContext) {
  let clock = 0, blocked = false;
  const view = Object.assign(new EventTarget(), { performance: { now: () => clock } });
  const owner = new DocumentFixture(view), surface = owner.createElement('section'); owner.body.append(surface);
  owner.body.style.setProperty('cursor', 'auto'); surface.style.setProperty('cursor', 'crosshair', 'important');
  const events: PetInteractionEvent[] = [], feedback: PetInteractionFeedback[] = [];
  const input = new PetInteraction(surface as unknown as HTMLElement, {
    getHeadRegion: () => ({ x: 100, y: 100, radius: 50 }),
    blocksPoint: () => blocked,
    onState() {}, onFeedback(value) { feedback.push(value); }, onEvent(value) { events.push(value); },
  });
  t.after(() => input.dispose());
  function dispatch(type: string, clientX = 110, clientY = 120, at = clock) {
    clock = at;
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { clientX, clientY, buttons: 0, pointerType: 'mouse', isPrimary: true });
    if (type.startsWith('drag') || type === 'drop') Object.assign(event, { dataTransfer: { types: ['Files'], dropEffect: 'copy', files: [{ name: 'snack.png', type: 'image/png', size: 100 }] } });
    surface.dispatchEvent(event); return event as Event & { clientX: number; clientY: number };
  }
  return {
    owner, surface, view, input, events, feedback, dispatch,
    contact() { return dispatch('pointermove', 110, 120, 0); },
    block(value: boolean) { blocked = value; },
    hand: () => owner.body.children.find(node => node.dataset.petInteractionCursor === 'true'),
  };
}

test('the first valid hit immediately shows the hand and establishes contact independently of measured activity', t => {
  const f = fixture(t);
  const first = f.dispatch('pointermove', 110, 120, 0);
  assert.equal(f.input.state.phase, 'rua'); assert.equal(f.hand()?.hidden, false);
  assert.equal(f.surface.style.cursor, 'none', 'the first valid hit immediately shows the owned emoji');
  assert.equal(f.feedback.at(-1)?.contact, true); assert.deepEqual(f.events, [], 'entry feedback grants no measured activity');
  const hand = f.hand()!; assert.ok(hand);
  assert.equal(hand.textContent, '👋'); assert.equal(hand.hidden, false);
  assert.equal(hand.style.position, 'fixed'); assert.equal(hand.style.pointerEvents, 'none'); assert.equal(hand.style.fontSize, '32px');
  assert.equal(hand.attributes.get('aria-hidden'), 'true');
  assert.equal(Number.parseFloat(hand.style.left as string) + 20, first.clientX);
  assert.equal(Number.parseFloat(hand.style.top as string) + 4, first.clientY);
  assert.equal(f.surface.style.cursor, 'none'); assert.equal(f.surface.style.getPropertyPriority('cursor'), 'important');
  assert.equal(f.owner.body.style.cursor, 'auto', 'no global cursor style is changed');
  const moved = f.dispatch('pointermove', 115, 120, 100);
  assert.equal(moved.clientX, 115); assert.equal(moved.clientY, 120);
  assert.equal(f.feedback.at(-1)?.speed, 0.5, 'rendering a hand does not alter measured mouse velocity');
  f.dispatch('pointermove', 115, 120, 1000);
  assert.equal(f.hand()!.hidden, false, 'stationary contact may keep the hand visible');
  assert.equal(f.hand(), hand, 'pointer movement reuses one owned overlay');
});

test('leaving immediately removes the emoji and a new hit immediately starts a fresh contact without backfill', t => {
  const f = fixture(t);
  f.dispatch('pointermove', 110, 120, 0); assert.equal(f.hand()?.hidden, false);
  const session = f.input.state.sessionId;
  f.dispatch('pointermove', 112, 120, 700); assert.equal(f.input.state.phase, 'rua');
  f.dispatch('pointerleave', 112, 120, 800);
  assert.equal(f.hand()?.hidden, true); assert.equal(f.surface.style.cursor, 'crosshair'); assert.deepEqual(f.events, []);
  f.dispatch('pointermove', 110, 120, 900); assert.equal(f.hand()?.hidden, false);
  assert.equal(f.input.state.phase, 'rua'); assert.equal(f.feedback.at(-1)?.contact, true);
  assert.notEqual(f.input.state.sessionId, session); assert.equal(f.feedback.at(-1)?.speed, 0);
  f.dispatch('pointermove', 110, 120, 2899); assert.equal(f.input.state.phase, 'rua');
  assert.deepEqual(f.events, [], 'emoji visibility, a long gap and a stationary contact add no measured activity');
});

test('all exits and exclusions restore the prior cursor and cannot leave a floating hand', async t => {
  const cases: { name: string; exit: (f: ReturnType<typeof fixture>) => void }[] = [
    { name: 'leave', exit: f => { f.dispatch('pointerleave'); } },
    { name: 'cancel', exit: f => { f.dispatch('pointercancel'); } },
    { name: 'pointer down', exit: f => { f.dispatch('pointerdown'); } },
    { name: 'blur', exit: f => { f.view.dispatchEvent(new Event('blur')); } },
    { name: 'resize', exit: f => { f.view.dispatchEvent(new Event('resize')); } },
    { name: 'document hidden', exit: f => { f.owner.hidden = true; f.owner.dispatchEvent(new Event('visibilitychange')); } },
    { name: 'host hidden', exit: f => { f.input.setHostVisible(false); } },
    { name: 'model/context reset', exit: f => { f.input.reset('model'); } },
    { name: 'feeding', exit: f => { f.dispatch('dragover', 110, 139, 100); } },
    { name: 'blocked UI', exit: f => { f.block(true); f.dispatch('pointermove', 110, 120, 100); } },
    { name: 'escape', exit: f => { const event = new Event('keydown'); Object.assign(event, { key: 'Escape' }); f.owner.dispatchEvent(event); } },
    { name: 'dispose', exit: f => { f.input.dispose(); } },
  ];
  for (const entry of cases) await t.test(entry.name, child => {
    const f = fixture(child); f.contact(); assert.equal(f.hand()?.hidden, false);
    entry.exit(f);
    assert.equal(f.surface.style.cursor, 'crosshair'); assert.equal(f.surface.style.getPropertyPriority('cursor'), 'important');
    assert.equal(f.hand()?.hidden ?? true, true);
    assert.equal(f.owner.body.style.cursor, 'auto');
    assert.equal(f.events.length, 0, 'entering/ending contact does not itself create a reward');
  });
});

test('cursor disposal removes only its own node and restores the exact empty inline cursor', () => {
  const view = Object.assign(new EventTarget(), { performance: { now: () => 0 } });
  const owner = new DocumentFixture(view), surface = owner.createElement('section'), sibling = owner.createElement('p');
  owner.body.append(surface, sibling); sibling.textContent = 'Keep existing UI';
  const cursor = new PetInteractionCursor(surface as unknown as HTMLElement);
  cursor.show(200, 150); assert.equal(owner.body.children.length, 3);
  cursor.hide(); assert.equal(surface.style.cursor, ''); assert.equal(surface.style.getPropertyPriority('cursor'), '');
  surface.style.setProperty('cursor', 'help'); cursor.show(200, 150); cursor.hide();
  assert.equal(surface.style.cursor, 'help', 'each new contact preserves the then-current cursor');
  cursor.dispose(); cursor.dispose(); cursor.show(1, 1);
  assert.deepEqual(owner.body.children, [surface, sibling]); assert.equal(surface.style.cursor, 'help');
});
