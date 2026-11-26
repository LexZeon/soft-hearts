// A picture dragged across full-screen Unbound is a snack only over her body (docs/claude/2026-11-21-drop-zone.md). The touch input is the
// companion window's own (src/mood), given Unbound's drop zone (src/unbound/her/drop-zone.ts); without a zone it behaves as before.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { TouchInput } from '../src/mood';
import { HerOutTouch } from '../src/unbound/her/out-touch';
import type { MoodView } from '../shared/mood';
import { DROP_MARGIN_PX, atHerBody, dropZoneOf } from '../src/unbound/her/drop-zone';

class Node extends EventTarget {
  children: Node[] = []; style: Record<string, unknown> = { getPropertyValue: () => '', getPropertyPriority: () => '', setProperty() {}, removeProperty: () => '' };
  textContent = ''; hidden = false; dataset: Record<string, string> = {};
  constructor(readonly ownerDocument: DocumentFixture) { super(); }
  append(...nodes: Node[]) { this.children.push(...nodes); } remove() {} setAttribute() {} contains(node: unknown) { return node === this; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 1536, height: 912 }; }
}
class DocumentFixture extends EventTarget {
  readonly body: Node; readonly documentElement: Node; hidden = false;
  constructor(readonly defaultView: EventTarget & { performance: { now(): number } }) { super(); this.body = new Node(this); this.documentElement = this.body; }
  createElement() { return new Node(this); }
}

// Her body on the page: a disc of radius 60 around (700, 300); her mouth at (700, 330).
const BODY = { x: 700, y: 300, r: 60 };
const bodyDistance = (x: number, y: number) => Math.hypot(x - BODY.x, y - BODY.y) - BODY.r;

function fixture(t: TestContext, zone: ((x: number, y: number) => boolean) | undefined) {
  let clock = 0;
  const view = Object.assign(new EventTarget(), { performance: { now: () => clock } });
  const owner = new DocumentFixture(view), surface = owner.createElement(); owner.body.append(surface);
  const events: { type: string }[] = [], snacks: string[] = [], errors: string[] = [];
  const input = new TouchInput(surface as unknown as HTMLElement, {
    getHeadRegion: () => ({ x: 700, y: 290, radius: 40, referenceWidth: 80, mouthX: 700, mouthY: 330, mouthRadius: 20 }),
    acceptsDrop: zone,
    onState() {}, onFeedback() {}, onEvent: value => { events.push(value); },
    onSnack: file => { snacks.push(file.name); }, onError: message => { errors.push(message); },
  });
  t.after(() => input.dispose());
  const drag = (type: 'dragover' | 'drop', x: number, y: number, at: number) => {
    clock = at;
    const dataTransfer = { types: ['Files'], dropEffect: 'copy', files: [{ name: 'snack.png', type: 'image/png', size: 100 }] };
    const event = Object.assign(new Event(type, { cancelable: true }), { clientX: x, clientY: y, dataTransfer });
    surface.dispatchEvent(event);
    return event as Event & { dataTransfer: { dropEffect: string } };
  };
  return { input, events, snacks, errors, drag };
}

test('the zone helpers: her body and a small margin, nothing for an unknown distance', () => {
  assert.equal(atHerBody(-5), true); assert.equal(atHerBody(DROP_MARGIN_PX), true);
  assert.equal(atHerBody(DROP_MARGIN_PX + 1), false); assert.equal(atHerBody(Infinity), false);
  assert.equal(atHerBody(Number.NaN), false); assert.equal(atHerBody(undefined), false);
  assert.equal(dropZoneOf(undefined), undefined, 'no body function: the input\'s own default (anywhere)');
  assert.equal(dropZoneOf(bodyDistance)!(700, 330), true); assert.equal(dropZoneOf(bodyDistance)!(100, 100), false);
});

test('a picture dropped at her mouth is a snack', t => {
  const f = fixture(t, dropZoneOf(bodyDistance));
  const over = f.drag('dragover', 700, 330, 100);
  assert.equal(over.defaultPrevented, true, 'over her the page takes the drag');
  assert.equal(over.dataTransfer.dropEffect, 'copy');
  assert.equal(f.input.state.phase, 'feeding-wait');
  f.drag('dragover', 700, 330, 900);
  assert.equal(f.input.state.phase, 'feeding-ready');
  const drop = f.drag('drop', 700, 330, 950);
  assert.equal(drop.defaultPrevented, true);
  assert.deepEqual(f.events.map(event => event.type), ['food']);
  assert.deepEqual(f.snacks, ['snack.png']);
});

test('a picture dragged or dropped beside her, in an empty screen area, is neither accepted nor answered', t => {
  const f = fixture(t, dropZoneOf(bodyDistance));
  for (const [x, y] of [[100, 100], [700 + BODY.r + DROP_MARGIN_PX + 40, 300], [700, 60]]) {
    const over = f.drag('dragover', x, y, 100);
    assert.equal(over.defaultPrevented, false, `(${x}, ${y}) is not a drop target`);
    assert.equal(over.dataTransfer.dropEffect, 'none');
    assert.equal(f.input.state.phase, 'idle', 'no feeding began');
    const drop = f.drag('drop', x, y, 1500);
    assert.equal(drop.defaultPrevented, true, 'a stray drop never navigates the page to the file');
  }
  assert.deepEqual(f.events, []); assert.deepEqual(f.snacks, []); assert.deepEqual(f.errors, [], 'no complaint either: it was not meant for her');
});

test('a drag that wanders from her out of the zone stops the feeding, and coming back starts it afresh', t => {
  const f = fixture(t, dropZoneOf(bodyDistance));
  f.drag('dragover', 700, 330, 100); assert.equal(f.input.state.phase, 'feeding-wait');
  f.drag('dragover', 1200, 700, 200); assert.equal(f.input.state.phase, 'idle');
  f.drag('drop', 1200, 700, 1000);
  assert.deepEqual(f.events, []); assert.deepEqual(f.snacks, []);
  f.drag('dragover', 700, 330, 1100); assert.equal(f.input.state.phase, 'feeding-wait');
});

test('without a zone (the companion window) the whole surface still takes a drag, as before', t => {
  const f = fixture(t, undefined);
  const over = f.drag('dragover', 100, 100, 100);
  assert.equal(over.defaultPrevented, true); assert.equal(f.input.state.phase, 'feeding-wait');
  f.drag('drop', 100, 100, 200);
  assert.equal(f.errors.length, 1, 'a drop away from her mouth is still answered there');
});

// The page's own wiring: HerOutTouch passes the page's zone to the touch input (a mutation of that line fails here).
test("HerOutTouch: the page's drop zone decides where a dragged picture is taken", async t => {
  const owner = new DocumentFixture(Object.assign(new EventTarget(), { performance: { now: () => 0 } }));
  const surface = owner.createElement(); owner.body.append(surface);
  const view = { characterId: 'gene', token: 'tok', revision: 1 } as unknown as MoodView;
  const touch = new HerOutTouch(surface as unknown as HTMLElement, { getMood: async () => view, onMood: () => () => {}, moodInteraction: async () => view },
    { region: () => ({ x: 700, y: 290, radius: 40, referenceWidth: 80, mouthX: 700, mouthY: 330, mouthRadius: 20 }), canTouch: () => true, view() {}, contact() {},
      dropZone: dropZoneOf(bodyDistance) });
  touch.start(); await new Promise(resolve => setTimeout(resolve, 20));
  t.after(() => touch.dispose());
  const over = (x: number, y: number) => {
    const dataTransfer = { types: ['Files'], dropEffect: 'copy', files: [] };
    const event = Object.assign(new Event('dragover', { cancelable: true }), { clientX: x, clientY: y, dataTransfer });
    surface.dispatchEvent(event); return event.defaultPrevented;
  };
  assert.equal(over(700, 330), true, 'at her mouth');
  assert.equal(over(100, 100), false, 'in an empty screen area');
});
