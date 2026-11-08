import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PetInteraction, type PetInteractionEvent, type PetInteractionFeedback, type PetInteractionState } from '../src/ui/PetInteraction';

class Style {
  [key: string]: unknown;
  cursor = '';
  private readonly priorities = new Map<string, string>();
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
  readonly attributes = new Map<string, string>();
  readonly captured = new Set<number>();
  readonly captureCalls: number[] = [];
  readonly releaseCalls: number[] = [];
  captureMode: 'success' | 'throw' | 'unconfirmed' = 'success';
  constructor(readonly ownerDocument: DocumentFixture, readonly tagName: string) { super(); }
  append(...nodes: Node[]): void { for (const child of nodes) { child.parent = this; this.children.push(child); } }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)); }
  getBoundingClientRect() { return { left: 10, top: 20, width: 300, height: 400 }; }
  setPointerCapture(pointerId: number): void {
    this.captureCalls.push(pointerId);
    if (this.captureMode === 'throw') throw new Error('Pointer unavailable');
    if (this.captureMode === 'success') this.captured.add(pointerId);
  }
  hasPointerCapture(pointerId: number): boolean { return this.captured.has(pointerId); }
  releasePointerCapture(pointerId: number): void {
    this.releaseCalls.push(pointerId); this.captured.delete(pointerId);
    // A synchronous lost event exercises teardown reentrancy, too.
    this.dispatchEvent(Object.assign(new Event('lostpointercapture'), { pointerId }));
  }
}
class DocumentFixture extends EventTarget {
  readonly body = new Node(this, 'body');
  readonly documentElement = this.body;
  hidden = false;
  constructor(readonly defaultView: EventTarget & { performance: { now(): number } }) { super(); }
  createElement(tag: string): Node { return new Node(this, tag); }
}
interface PointerOptions { x?: number; y?: number; at?: number; pointerId?: number; button?: number; buttons?: number; isPrimary?: boolean; pointerType?: string }
function fixture(t: TestContext) {
  let clock = 0, blocked = false, enabled = true;
  const view = Object.assign(new EventTarget(), { performance: { now: () => clock } });
  const owner = new DocumentFixture(view), surface = owner.createElement('section'); owner.body.append(surface);
  owner.body.style.setProperty('cursor', 'auto'); surface.style.setProperty('cursor', 'crosshair', 'important');
  const events: PetInteractionEvent[] = [], feedback: PetInteractionFeedback[] = [], states: PetInteractionState[] = [], cancellations: string[] = [];
  const input = new PetInteraction(surface as unknown as HTMLElement, {
    getHeadRegion: () => ({ x: 100, y: 70, radius: 25, referenceWidth: 100, mouthX: 100, mouthY: 155, mouthRadius: 12,
      cheeks: [
        { side: 'left', x: 80, y: 125, axisXX: 12, axisXY: 0, axisYX: 0, axisYY: 14, referenceWidth: 100 },
        { side: 'right', x: 120, y: 125, axisXX: 12, axisXY: 0, axisYX: 0, axisYY: 14, referenceWidth: 100 },
      ],
    }),
    canInteract: () => enabled,
    blocksPoint: () => blocked,
    onState: value => states.push({ ...value }),
    onFeedback: value => feedback.push(structuredClone(value)),
    onEvent: value => { events.push({ ...value }); },
    onCancel: reason => cancellations.push(reason),
  });
  t.after(() => input.dispose());
  function pointer(type: string, options: PointerOptions = {}) {
    clock = options.at ?? clock;
    const event = Object.assign(new Event(type, { cancelable: true }), {
      clientX: (options.x ?? 80) + 10, clientY: (options.y ?? 125) + 20,
      pointerId: options.pointerId ?? 7,
      button: options.button ?? 0, buttons: options.buttons ?? (type === 'pointerdown' ? 1 : 0),
      pointerType: options.pointerType ?? 'mouse', isPrimary: options.isPrimary ?? true,
    });
    surface.dispatchEvent(event); return event;
  }
  function drag(type: string, x = 100, y = 155, at = clock) {
    clock = at;
    const event = Object.assign(new Event(type, { cancelable: true }), {
      clientX: x + 10, clientY: y + 20,
      dataTransfer: { types: ['Files'], dropEffect: 'copy', files: [{ name: 'snack.png', type: 'image/png', size: 100 }] },
    });
    surface.dispatchEvent(event); return event;
  }
  function ready() {
    pointer('pointermove', { at: 0 }); pointer('pointerdown', { at: 0 });
    assert.equal(input.state.phase, 'cheek');
    pointer('pointermove', { x: 90, at: 100, buttons: 1 });
    pointer('pointermove', { x: 100, at: 200, buttons: 1 });
    pointer('pointermove', { x: 110, at: 300, buttons: 1 });
    assert.equal(events.length, 0, 'eligible movement must wait for explicit release');
  }
  return {
    input, owner, surface, view, events, feedback, states, cancellations, pointer, drag, ready,
    clock(value: number) { clock = value; }, block(value: boolean) { blocked = value; }, enable(value: boolean) { enabled = value; },
    hand: () => owner.body.children.find(node => node.dataset.petInteractionCursor === 'true'),
  };
}
function assertClean(f: ReturnType<typeof fixture>) {
  assert.equal(f.input.state.phase, 'idle');
  assert.deepEqual([...f.surface.captured], []);
  assert.equal(f.surface.style.cursor, 'crosshair');
  assert.equal(f.surface.style.getPropertyPriority('cursor'), 'important');
  assert.equal(f.owner.body.style.cursor, 'auto');
  assert.equal(f.hand()?.hidden ?? true, true);
}

test('both cheeks immediately show hover and held emoji without an input or reward delay', async t => {
  for (const x of [80, 120]) await t.test(`cheek ${x}`, child => {
    const f = fixture(child);
    f.pointer('pointermove', { x });
    assert.equal(f.input.state.phase, 'cheek-hover');
    assert.equal(f.input.state.sessionId, null); assert.equal(f.events.length, 0);
    assert.equal(f.hand()?.textContent, '👉'); assert.equal(f.hand()?.hidden, false);
    const hand = f.hand();
    const press = f.pointer('pointerdown', { x });
    assert.equal(press.defaultPrevented, true);
    assert.equal(f.input.state.phase, 'cheek'); assert.ok(f.input.state.sessionId);
    assert.equal(f.hand(), hand, 'one owned overlay is reused');
    assert.equal(f.hand()?.textContent, '🤏'); assert.equal(f.hand()?.hidden, false);
    assert.equal(f.feedback.at(-1)?.pinch?.pinching, true);
    assert.equal(f.events.length, 0, 'hover and press cannot add activity');
    f.pointer('pointerup', { x, at: 1000 });
    assert.equal(f.events.length, 0, 'a stationary hold never adds a reward');
    assertClean(f);
  });
});

test('capture must be successful before a cheek phase is published', async t => {
  for (const mode of ['throw', 'unconfirmed'] as const) await t.test(mode, child => {
    const f = fixture(child); f.surface.captureMode = mode;
    f.pointer('pointermove');
    f.pointer('pointerdown');
    assert.equal(f.states.some(state => state.phase === 'cheek'), false);
    assert.deepEqual(f.surface.captureCalls, [7]); assert.equal(f.events.length, 0);
    assertClean(f);
  });
});

test('only the matching left release commits measured movement once and releases its capture', t => {
  const f = fixture(t); f.ready();
  f.pointer('pointerup', { x: 110, at: 310, pointerId: 99 });
  assert.equal(f.input.state.phase, 'cheek'); assert.equal(f.events.length, 0);
  f.pointer('pointerup', { x: 110, at: 320 });
  assert.equal(f.events.length, 1); assert.equal(f.events[0].type, 'cheek');
  if (f.events[0].type === 'cheek') assert.equal(f.events[0].activeMs, 300);
  f.pointer('pointerup', { x: 110, at: 330 });
  f.pointer('lostpointercapture', { at: 340 });
  assert.equal(f.events.length, 1);
  assert.deepEqual(f.surface.releaseCalls, [7]); assertClean(f);
});

test('invalid matching releases cannot commit a reward', async t => {
  const invalid: { name: string; options: PointerOptions }[] = [
    { name: 'secondary button', options: { button: 2 } },
    { name: 'left still down', options: { buttons: 1 } },
    { name: 'non-primary pointer', options: { isPrimary: false } },
    { name: 'non-mouse pointer', options: { pointerType: 'pen' } },
    { name: 'invalid coordinates', options: { x: NaN } },
  ];
  for (const entry of invalid) await t.test(entry.name, child => {
    const f = fixture(child); f.ready();
    f.pointer('pointerup', { x: 110, at: 350, ...entry.options });
    assert.equal(f.events.length, 0);
    f.input.reset(); assertClean(f);
  });
});

test('an additional press cannot replace the owned capture or restart the held interaction', t => {
  const f = fixture(t); f.ready(); const session = f.input.state.sessionId;
  f.pointer('pointerdown', { at: 310, pointerId: 99 });
  assert.equal(f.input.state.sessionId, session);
  assert.deepEqual([...f.surface.captured], [7]);
  assert.deepEqual(f.surface.captureCalls, [7]);
  f.pointer('pointerup', { at: 320, pointerId: 7 });
  assert.equal(f.events.length, 1); assertClean(f);
});

test('every held-input cancellation discards eligible movement and restores capture and cursor', async t => {
  const cases: { name: string; exit(f: ReturnType<typeof fixture>): void }[] = [
    { name: 'lost left button', exit: f => { f.pointer('pointermove', { x: 115, at: 350, buttons: 0 }); } },
    { name: 'blur', exit: f => { f.view.dispatchEvent(new Event('blur')); } },
    { name: 'resize', exit: f => { f.view.dispatchEvent(new Event('resize')); } },
    { name: 'lost capture', exit: f => { f.surface.captured.delete(7); f.pointer('lostpointercapture'); } },
    { name: 'pointercancel', exit: f => { f.pointer('pointercancel'); } },
    { name: 'blocked UI', exit: f => { f.block(true); f.pointer('pointermove', { x: 115, at: 350, buttons: 1 }); } },
    { name: 'document hidden', exit: f => { f.owner.hidden = true; f.owner.dispatchEvent(new Event('visibilitychange')); } },
    { name: 'host hidden', exit: f => { f.input.setHostVisible(false); } },
    { name: 'model or role reset', exit: f => { f.input.reset('model'); } },
    { name: 'Escape', exit: f => { f.owner.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' })); } },
    { name: 'disabled interaction', exit: f => { f.enable(false); f.pointer('pointermove', { at: 350, buttons: 1 }); } },
  ];
  for (const entry of cases) await t.test(entry.name, child => {
    const f = fixture(child); f.ready(); entry.exit(f);
    assertClean(f); assert.equal(f.events.length, 0);
    f.pointer('pointerup', { at: 400 });
    assert.equal(f.events.length, 0, 'a late release cannot revive cancelled activity');
  });
});

test('captured pointer leave retains the hold, while a different move cannot change it', t => {
  const f = fixture(t); f.ready(); const session = f.input.state.sessionId;
  f.pointer('pointerleave', { at: 320 });
  f.pointer('pointermove', { x: 200, y: 300, at: 350, pointerId: 99, buttons: 1 });
  assert.equal(f.input.state.sessionId, session);
  assert.equal(f.feedback.at(-1)?.pinch?.x, 0.3);
  assert.deepEqual([...f.surface.captured], [7]);
  f.pointer('pointerup', { at: 360 });
  assert.equal(f.events.length, 1); assertClean(f);
});

test('feeding cancels a held cheek and cannot create a simultaneous cheek session', t => {
  const f = fixture(t); f.ready();
  f.drag('dragover', 100, 155, 350);
  assert.equal(f.input.state.phase, 'feeding-wait');
  assert.deepEqual([...f.surface.captured], []); assert.equal(f.events.length, 0);
  assert.equal(f.hand()?.hidden ?? true, true);
  f.pointer('pointermove', { x: 80, y: 125, at: 450 });
  assert.equal(f.input.state.phase, 'feeding-wait');
  f.drag('dragover', 100, 155, 1050);
  assert.equal(f.input.state.phase, 'feeding-ready');
  f.drag('drop', 100, 155, 1100);
  assert.equal(f.events.length, 1); assert.equal(f.events[0].type, 'food');
  assert.equal(f.events.some(event => event.type === 'cheek'), false);
});

test('a direct file drop cannot leave a held cheek or native capture behind', t => {
  const f = fixture(t); f.ready(); f.drag('drop', 100, 155, 350);
  assert.equal(f.events.length, 0); assertClean(f);
});

test('legacy scalp rua still immediately shows its hand and reports only measured rua activity', t => {
  const f = fixture(t);
  f.pointer('pointermove', { x: 100, y: 70, at: 0 });
  assert.equal(f.input.state.phase, 'rua');
  assert.equal(f.hand()?.textContent, '👋'); assert.equal(f.hand()?.hidden, false);
  assert.equal(f.events.length, 0);
  f.pointer('pointermove', { x: 110, y: 70, at: 100 });
  assert.equal(f.events.length, 1); assert.equal(f.events[0].type, 'rua');
  assert.equal(f.events.some(event => event.type === 'cheek' || event.type === 'food'), false);
  f.input.reset(); assertClean(f);
});

test('dispose releases the native capture, removes its cursor and ignores all late input', t => {
  const f = fixture(t); f.ready(); f.input.dispose(); assertClean(f);
  assert.equal(f.hand(), undefined); const count = f.states.length;
  f.pointer('pointerup', { at: 500 }); f.pointer('pointermove', { at: 550 });
  f.pointer('pointerdown', { at: 600 }); f.view.dispatchEvent(new Event('blur'));
  assert.equal(f.states.length, count); assert.equal(f.events.length, 0);
  assert.deepEqual(f.surface.captureCalls, [7]);
});
