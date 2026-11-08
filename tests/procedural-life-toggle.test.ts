import assert from 'node:assert/strict';
import test from 'node:test';
import { ProceduralLifeToggle } from '../src/ui/procedural-life-toggle';

class Element extends EventTarget {
  children: Element[] = []; className = ''; id = ''; type = ''; checked = false; textContent = ''; title = '';
  attributes: Record<string, string> = {};
  constructor(readonly ownerDocument: Owner, readonly tagName: string) { super(); }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
}
class Owner { createElement(tag: string) { return new Element(this, tag); } }
/** A same-origin BroadcastChannel stand-in: a post reaches every other open port, asynchronously. */
class Bus {
  ports: Port[] = [];
  open(): Port { const port = new Port(this); this.ports.push(port); return port; }
}
class Port {
  onmessage: ((event: MessageEvent) => void) | null = null; closed = false; sent: unknown[] = [];
  constructor(private readonly bus: Bus) {}
  postMessage(value: unknown) {
    if (this.closed) throw new Error('closed');
    this.sent.push(value);
    for (const port of this.bus.ports) if (port !== this && !port.closed) queueMicrotask(() => port.onmessage?.({ data: structuredClone(value) } as MessageEvent));
  }
  close() { this.closed = true; }
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function mount(bus: Bus) {
  const parent = new Owner().createElement('div'), applied: boolean[] = [];
  const toggle = new ProceduralLifeToggle(parent as unknown as HTMLElement, { onChange: value => applied.push(value), createPort: () => bus.open() });
  const input = (toggle.element as unknown as Element).children[0];
  return { toggle, applied, input, parent };
}

test('toggle: default on, a click applies locally and reaches the other window', async () => {
  const bus = new Bus(), controls = mount(bus), pet = mount(bus);
  assert.equal(controls.input.type, 'checkbox'); assert.equal(controls.input.checked, true); assert.equal(controls.toggle.value, true);
  assert.equal(controls.parent.children[0], controls.toggle.element as unknown as Element, 'mounted in the developer panel');
  controls.toggle.connect(); pet.toggle.connect(); await flush();
  assert.deepEqual(controls.applied, [], 'both start on: the query changes nothing');
  controls.input.checked = false; controls.input.dispatchEvent(new Event('change')); await flush();
  assert.deepEqual(controls.applied, [false]); assert.deepEqual(pet.applied, [false]); assert.equal(pet.input.checked, false);
  // The relay is one hop: the receiver does not echo the value back.
  assert.equal(bus.ports[1].sent.filter(message => (message as { kind: string }).kind === 'procedural-life').length, 0);
});

test('toggle: a reopened window adopts the running value once; malformed messages are ignored', async () => {
  const bus = new Bus(), controls = mount(bus);
  controls.toggle.connect(); controls.toggle.set(false); await flush();
  const pet = mount(bus); pet.toggle.connect(); await flush();
  assert.deepEqual(pet.applied, [false], 'the new window asked and adopted off');
  for (const junk of [null, [], 'x', { kind: 'procedural-life' }, { kind: 'procedural-life', enabled: 'yes' }, { kind: 'procedural-life', enabled: true, extra: 1 }])
    bus.ports[0].postMessage(junk);
  await flush();
  assert.deepEqual(pet.applied, [false]);
  pet.toggle.dispose(); assert.equal(bus.ports[1].closed, true);
  controls.toggle.set(true); await flush();
  assert.deepEqual(pet.applied, [false], 'a disposed toggle no longer applies');
});

test('toggle: no channel available still works locally', () => {
  const parent = new Owner().createElement('div'), applied: boolean[] = [];
  const toggle = new ProceduralLifeToggle(parent as unknown as HTMLElement, { onChange: value => applied.push(value), createPort: () => null });
  toggle.connect(); toggle.set(false); toggle.set(true);
  assert.deepEqual(applied, [false, true]);
  toggle.dispose();
});
