import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { MoodCompanion, type MoodCompanionAPI } from '../src/ui/MoodCompanion';
import { DEFAULT_PET_INTERACTION_CONFIG, type PetHeadRegion } from '../src/ui/PetInteraction';
import { createMoodState, getMoodSnapshot, DEFAULT_MOOD_PARAMETERS } from '../shared/mood';
import type { MoodInput, MoodView } from '../shared/mood-runtime';

class Style {
  [key: string]: unknown;
  setProperty(name: string, value: string): void { this[name] = value; }
  removeProperty(name: string): void { delete this[name]; }
  getPropertyValue(name: string): string { return String(this[name] ?? ''); }
  getPropertyPriority(): string { return ''; }
}
class Element extends EventTarget {
  children: Element[] = [];
  parent: Element | null = null;
  id = ''; className = ''; textContent = ''; value = ''; hidden = false; disabled = false;
  style = new Style(); dataset: Record<string, string> = {}; attributes = new Map<string, string>();
  offsetWidth = 156; offsetHeight = 54;
  readonly captured = new Set<number>();
  rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  readonly classList = {
    add: (...names: string[]) => { for (const name of names) this.classList.toggle(name, true); },
    remove: (...names: string[]) => { for (const name of names) this.classList.toggle(name, false); },
    contains: (name: string) => this.className.split(' ').includes(name),
    toggle: (name: string, force?: boolean) => {
      const names = new Set(this.className.split(' ').filter(Boolean));
      const active = force ?? !names.has(name); if (active) names.add(name); else names.delete(name);
      this.className = [...names].join(' '); return active;
    },
  };
  constructor(readonly ownerDocument: Owner, readonly tagName: string) { super(); }
  append(...nodes: Element[]): void { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  prepend(node: Element): void { node.parent = this; this.children.unshift(node); }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getBoundingClientRect() { return this.rect; }
  contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)); }
  click(): void { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  setPointerCapture(pointerId: number): void { this.captured.add(pointerId); }
  hasPointerCapture(pointerId: number): boolean { return this.captured.has(pointerId); }
  releasePointerCapture(pointerId: number): void {
    this.captured.delete(pointerId);
    this.dispatchEvent(Object.assign(new Event('lostpointercapture'), { pointerId }));
  }
}
const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
class Owner extends EventTarget {
  hidden = false;
  body = new Element(this, 'body'); documentElement = this.body;
  defaultView = Object.assign(new EventTarget(), { innerWidth: 400, innerHeight: 560, performance: { now: () => this.clock } });
  clock = 0;
  createElement(tag: string): Element { return new Element(this, tag); }
  getElementById(id: string): Element | null { return all(this.body).find(node => node.id === id) ?? null; }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selectors: string): Element[] {
    return all(this.body).filter(node => selectors.split(',').map(value => value.trim()).some(selector =>
      selector.startsWith('#') ? node.id === selector.slice(1)
        : selector.startsWith('.') ? node.classList.contains(selector.slice(1))
          : selector === '[data-mood-ui]' ? node.dataset.moodUi !== undefined : false));
  }
}
class Broadcast {
  static ports = new Set<Broadcast>();
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(readonly name: string) { Broadcast.ports.add(this); }
  postMessage(value: unknown): void { for (const peer of Broadcast.ports) if (peer !== this && peer.name === this.name) peer.onmessage?.({ data: structuredClone(value) } as MessageEvent); }
  close(): void { Broadcast.ports.delete(this); this.onmessage = null; }
}
async function flush() { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); }
function environment(t: TestContext) {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalChannel = Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel');
  Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, writable: true, value: Broadcast });
  const timers = new Map<number, () => void>();
  const timeouts = new Map<number, { callback: () => void; dueAt: number }>();
  let serial = 0, clock = 0;
  t.mock.method(globalThis, 'setInterval', (callback: () => void) => { timers.set(++serial, callback); return serial; });
  t.mock.method(globalThis, 'clearInterval', (id: number) => { timers.delete(id); });
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, delay: number) => { timeouts.set(++serial, { callback, dueAt: clock + delay }); return serial; });
  t.mock.method(globalThis, 'clearTimeout', (id: number) => { timeouts.delete(id); });
  const parameters = structuredClone(DEFAULT_MOOD_PARAMETERS);
  let stored: MoodView = { characterId: 'gene', token: 'gene-model-one', revision: 1, developerMode: true, expressions: true, parameters,
    snapshot: getMoodSnapshot(createMoodState(0, parameters)), gesture: null };
  const listeners = new Set<(view: MoodView) => void>();
  const inputs: MoodInput[] = []; let opened = 0;
  let deferredInteraction: { promise: Promise<void>; resolve(): void } | null = null;
  const publish = () => { stored.revision++; for (const callback of listeners) callback(structuredClone(stored)); return structuredClone(stored); };
  const api: MoodCompanionAPI = {
    async getMood() { return structuredClone(stored); },
    onMood(callback) { listeners.add(callback); return () => { listeners.delete(callback); }; },
    async setMoodDeveloperMode(value) { stored.developerMode = value; return publish(); },
    async setMoodExpressions(value) { stored.expressions = value; return publish(); },
    async setMoodParameters() { return publish(); }, async restoreMoodParameters() { return publish(); },
    async moodInteraction(input) {
      inputs.push(input);
      const result = structuredClone(stored), pending = deferredInteraction;
      deferredInteraction = null;
      if (pending) await pending.promise;
      return result;
    },
    async openControls() { opened++; },
  };
  const companions: MoodCompanion[] = [], owners: Owner[] = [];
  const make = async (isPet: boolean) => {
    const owner = new Owner(); owners.push(owner);
    Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: owner });
    const stage = owner.createElement('section'); stage.id = 'stage'; stage.rect = { left: 0, top: 0, right: 400, bottom: 560, width: 400, height: 560 };
    owner.body.append(stage);
    const content = owner.createElement('section'); content.className = 'content-card'; owner.body.append(content);
    const tab = owner.createElement('div'); tab.id = 'tab-chat'; tab.className = 'tab-panel active'; content.append(tab);
    const toolbar = owner.createElement('div'); toolbar.id = 'pet-toolbar'; toolbar.className = 'pet-toolbar';
    toolbar.rect = { left: 8, top: 3, right: 392, bottom: 60, width: 384, height: 57 };
    const chat = owner.createElement('div'); chat.className = 'pet-chat'; chat.rect = { left: 12, top: 490, right: 388, bottom: 550, width: 376, height: 60 };
    const draft = owner.createElement('textarea'); draft.id = 'chat-input'; draft.value = '保留这段草稿'; chat.append(draft); owner.body.append(toolbar, chat);
    let head: PetHeadRegion = { x: 195, y: 80, radius: 30 };
    const interaction: boolean[] = [];
    const companion = new MoodCompanion({ isPet, surface: stage as unknown as HTMLElement, api,
      getHeadRegion: () => head, canInteract: () => true, onFeedback() {}, onInteraction: value => interaction.push(value), onView() {} });
    companions.push(companion); await companion.init();
    function pointer(type: string, x = 180, y = 120, options: { at?: number; buttons?: number; pointerId?: number; button?: number } = {}) {
      if (options.at !== undefined) {
        clock = options.at;
        for (const current of owners) current.clock = clock;
      }
      const event = Object.assign(new Event(type, { cancelable: true }), {
        clientX: x, clientY: y, button: options.button ?? 0,
        buttons: options.buttons ?? (type === 'pointerdown' ? 1 : 0), pointerId: options.pointerId ?? 7,
        pointerType: 'mouse', isPrimary: true,
      });
      stage.dispatchEvent(event); return event;
    }
    return { owner, stage, content, tab, draft, companion, interaction, pointer,
      setHead(value: PetHeadRegion) { head = value; },
      field(id: string) { const node = owner.getElementById(id); assert.ok(node, id); return node; },
      move(x: number, y: number) { return pointer('pointermove', x, y); },
    };
  };
  t.after(() => {
    for (const companion of companions) companion.dispose();
    assert.equal(Broadcast.ports.size, 0);
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (originalChannel) Object.defineProperty(globalThis, 'BroadcastChannel', originalChannel); else Reflect.deleteProperty(globalThis, 'BroadcastChannel');
  });
  return { make, inputs, opened: () => opened,
    advance(to: number) {
      clock = to;
      for (const owner of owners) owner.clock = to;
      for (const timer of [...timers.values()]) timer();
      for (const [id, timer] of [...timeouts.entries()]) if (timer.dueAt <= to) { timeouts.delete(id); timer.callback(); }
    },
    changeToken(token: string) { stored.token = token; return publish(); },
    holdNextInteraction() {
      let resolve!: () => void;
      const promise = new Promise<void>(yes => { resolve = yes; });
      deferredInteraction = { promise, resolve };
      return { resolve };
    },
  };
}

test('pet inspection never expands over the model and the control observer sits outside all tabs', async t => {
  const env = environment(t), pet = await env.make(true), control = await env.make(false);
  const petObserver = pet.owner.querySelector('.mood-companion')!;
  const petBody = pet.owner.querySelector('.mood-companion-body')!;
  assert.equal(petBody.hidden, true);
  pet.field('mood-open-controls').click(); await flush();
  assert.equal(env.opened(), 1); assert.equal(petBody.hidden, true);
  const observer = control.owner.querySelector('.mood-controls-observer')!;
  assert.equal(observer.parent, control.content); assert.equal(control.content.children[0], observer);
  assert.equal(control.tab.contains(observer), false); assert.equal(control.stage.contains(observer), false);
  assert.equal(control.owner.querySelector('.mood-companion-body')!.hidden, false);
  assert.equal(control.owner.querySelector('.mood-channels')!.hidden, false);
  assert.ok(Number.parseFloat(petObserver.style.top as string) >= 320, 'compact status avoids the head and upper-body corridor');
  pet.setHead({ x: 195, y: 240, radius: 100 }); env.advance(100);
  assert.equal(petObserver.classList.contains('mood-no-room'), true, 'a close-up with no free space uses the control window');
  const close = all(observer).find(node => node.tagName === 'button' && node.textContent === '关闭'); assert.ok(close);
  close.click(); await flush(); assert.equal(observer.hidden, true); assert.equal(petObserver.hidden, true);
});

test('control-window runtime feel editing is acknowledged by the pet and visible in its readback', async t => {
  const env = environment(t), pet = await env.make(true), control = await env.make(false);
  const changed = { ...DEFAULT_PET_INTERACTION_CONFIG, minSpeed: 0.2, maxSpeed: 2 };
  control.field('mood-touch-parameters').value = JSON.stringify(changed);
  control.field('mood-touch-apply').click(); await flush();
  assert.deepEqual(JSON.parse(pet.field('mood-local-feedback').dataset.touchConfig), changed);
  assert.deepEqual(JSON.parse(control.field('mood-touch-parameters').value), changed);
  assert.ok(all(control.content).some(node => node.textContent.startsWith('已确认应用桌宠本次手感')));
  assert.equal(env.inputs.length, 0, 'setting local feel does not fabricate a host reward or phase');
});

test('immediate contact updates the feedback channel and entering reserved UI restores it without losing the draft', async t => {
  const env = environment(t), pet = await env.make(true);
  pet.move(195, 80);
  await flush();
  for (let time = 100; time <= 1000; time += 100) env.advance(time);
  assert.equal(pet.owner.body.style.getPropertyValue('--pet-interaction-opacity'), '0');
  assert.deepEqual(env.inputs.map(input => input.type === 'phase' ? input.phase : input.type), ['rua'], 'entry opens one contact phase, not a reward');
  assert.equal(pet.interaction.at(-1), true);
  for (let time = 1100; time <= 2000; time += 100) env.advance(time);
  await flush(); assert.equal(pet.owner.body.classList.contains('pet-ui-faded'), true);
  assert.equal(pet.owner.body.style.getPropertyValue('--pet-interaction-opacity'), '0');
  assert.deepEqual(env.inputs.map(input => input.type === 'phase' ? input.phase : input.type), ['rua']);
  pet.move(195, 520);
  assert.equal(pet.owner.body.style.getPropertyValue('--pet-interaction-opacity'), '1');
  assert.equal(pet.owner.body.classList.contains('pet-ui-faded'), false);
  assert.equal(pet.draft.value, '保留这段草稿');
  assert.equal(pet.owner.getElementById('chat-input'), pet.draft, 'the same editable node survives both fades');
});

function addCheeks(pet: Awaited<ReturnType<ReturnType<typeof environment>['make']>>) {
  pet.setHead({ x: 195, y: 80, radius: 30, referenceWidth: 60,
    cheeks: [
      { side: 'left', x: 180, y: 120, axisXX: 10, axisXY: 0, axisYX: 0, axisYY: 12, referenceWidth: 60 },
      { side: 'right', x: 210, y: 120, axisXX: 10, axisXY: 0, axisYX: 0, axisYY: 12, referenceWidth: 60 },
    ],
  });
}
function moveHeldCheek(pet: Awaited<ReturnType<ReturnType<typeof environment>['make']>>) {
  pet.pointer('pointermove', 185, 120, { at: 100, buttons: 1 });
  pet.pointer('pointermove', 190, 120, { at: 200, buttons: 1 });
  pet.pointer('pointermove', 195, 120, { at: 300, buttons: 1 });
}

test('cheek hover immediately starts only the visual contact clock and never sends a host phase or reward', async t => {
  const env = environment(t), pet = await env.make(true); addCheeks(pet);
  const initialInteractions = pet.interaction.length;
  pet.pointer('pointermove', 180, 120, { at: 0 });
  assert.equal(pet.field('mood-local-feedback').dataset.phase, 'cheek-hover');
  assert.deepEqual(pet.interaction.slice(initialInteractions), [true]);
  const cursor = all(pet.owner.body).find(node => node.dataset.petInteractionCursor === 'true');
  assert.equal(cursor?.textContent, '👉'); assert.equal(cursor?.hidden, false);
  await flush(); assert.deepEqual(env.inputs, []);
  env.advance(1000); env.advance(2100); await flush();
  assert.deepEqual(env.inputs, [], 'UI contact time and hover polling do not open an interaction session');
  pet.pointer('pointermove', 350, 300, { at: 2200 });
  await flush();
  assert.equal(pet.interaction.at(-1), false);
  assert.deepEqual(env.inputs, []);
  assert.equal(pet.draft.value, '保留这段草稿');
});

test('a real companion queues cheek press, one release event and delayed idle in order without rua or food phases', async t => {
  const env = environment(t), pet = await env.make(true); addCheeks(pet);
  const pending = env.holdNextInteraction();
  pet.pointer('pointermove', 180, 120, { at: 0 });
  const clockStart = pet.interaction.length;
  pet.pointer('pointerdown', 180, 120, { at: 0 });
  await flush();
  assert.deepEqual(env.inputs.map(input => input.type === 'phase' ? input.phase : input.type), ['cheek']);
  moveHeldCheek(pet);
  assert.equal(pet.interaction.slice(clockStart).some(value => !value), false, 'hover to press never resets the visual contact clock');
  pet.pointer('pointerup', 195, 120, { at: 310 }); await flush();
  assert.deepEqual([...pet.stage.captured], []);
  assert.deepEqual(env.inputs.map(input => input.type === 'phase' ? input.phase : input.type), ['cheek'], 'release waits behind its in-flight press');
  env.advance(529); await flush();
  pending.resolve(); await flush();
  assert.deepEqual(env.inputs.map(input => input.type === 'phase' ? input.phase : input.type), ['cheek', 'cheek']);
  assert.equal(env.inputs[1].type, 'cheek');
  if (env.inputs[1].type === 'cheek') assert.equal(env.inputs[1].activeMs, 300);
  env.advance(530); await flush();
  assert.deepEqual(env.inputs.map(input => input.type === 'phase' ? input.phase : input.type), ['cheek', 'cheek', 'idle']);
  assert.equal(new Set(env.inputs.map(input => input.sessionId)).size, 1);
  assert.equal(env.inputs.every(input => input.token === 'gene-model-one'), true);
  assert.equal(env.inputs.some(input => input.type === 'rua' || input.type === 'food' || (input.type === 'phase' && input.phase === 'food-eating')), false);
});

test('explicit cancellation removes a queued cheek reward and only closes the in-flight session', async t => {
  const env = environment(t), pet = await env.make(true); addCheeks(pet);
  const pending = env.holdNextInteraction();
  pet.pointer('pointerdown', 180, 120, { at: 0 }); await flush();
  moveHeldCheek(pet); pet.pointer('pointerup', 195, 120, { at: 310 });
  pet.companion.reset('cancelled');
  pending.resolve(); await flush(); env.advance(1000); await flush();
  assert.deepEqual(env.inputs.map(input => input.type === 'phase' ? input.phase : input.type), ['cheek', 'idle']);
  assert.equal(env.inputs.some(input => input.type === 'cheek'), false);
  assert.equal(pet.field('mood-local-feedback').dataset.phase, 'idle');
  assert.equal(pet.interaction.at(-1), false); assert.deepEqual([...pet.stage.captured], []);
});

test('a new token invalidates queued cheek input and late old replies cannot replace the new character context', async t => {
  const env = environment(t), pet = await env.make(true); addCheeks(pet);
  const pending = env.holdNextInteraction();
  pet.pointer('pointerdown', 180, 120, { at: 0 }); await flush();
  const oldSession = env.inputs[0].sessionId;
  moveHeldCheek(pet); pet.pointer('pointerup', 195, 120, { at: 310 });
  env.changeToken('gene-model-two');
  pending.resolve(); await flush(); env.advance(1000); await flush();
  assert.equal(env.inputs.length, 1);
  assert.equal(pet.field('mood-local-feedback').dataset.phase, 'idle');
  assert.equal(pet.interaction.at(-1), false); assert.deepEqual([...pet.stage.captured], []);
  pet.pointer('pointerdown', 180, 120, { at: 1100 }); await flush();
  assert.equal(env.inputs.length, 2);
  assert.equal(env.inputs[1].token, 'gene-model-two'); assert.notEqual(env.inputs[1].sessionId, oldSession);
  assert.equal(env.inputs[1].type, 'phase');
  if (env.inputs[1].type === 'phase') assert.equal(env.inputs[1].phase, 'cheek');
});
