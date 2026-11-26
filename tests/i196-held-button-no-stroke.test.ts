import assert from 'node:assert/strict';
import test from 'node:test';
import { TouchInput } from '../src/mood';

// I-196. A button held on her never strokes; no button strokes as before; after a release the stroke starts fresh.
const head = { x: 100, y: 100, radius: 50 };
type Ev = ConstructorParameters<typeof TouchInput>[1] extends { onEvent(e: infer E): unknown } ? E : never;
type St = ConstructorParameters<typeof TouchInput>[1] extends { onState(s: infer S): unknown } ? S : never;

function rig(t: { after: (f: () => void) => void }) {
  let clock = 0;
  const view = Object.assign(new EventTarget(), { performance: { now: () => clock } });
  const owner = Object.assign(new EventTarget(), { defaultView: view, hidden: false });
  const surface = Object.assign(new EventTarget(), { ownerDocument: owner, getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 400 }), contains: () => false,
    setPointerCapture() {}, hasPointerCapture: () => false, releasePointerCapture() {} });
  const events: Ev[] = [], states: St[] = [];
  const input = new TouchInput(surface as unknown as HTMLElement, { getHeadRegion: () => head, onState: s => states.push(s), onFeedback() {}, onEvent: e => { events.push(e); } });
  t.after(() => input.dispose());
  const fire = (type: string, x: number, at: number, buttons: number, button = 0) => {
    clock = at; const event = new Event(type);
    Object.assign(event, { clientX: x, clientY: 100, buttons, button, pointerId: 1, pointerType: 'mouse', isPrimary: true, preventDefault() {} });
    surface.dispatchEvent(event);
  };
  const sweep = (from: number, at: number, buttons: number) => { for (let i = 0; i < 8; i++) fire('pointermove', from + (i % 2 ? 30 : 0) + i, at + i * 40, buttons); };
  const ruaMs = () => events.reduce((sum, e) => sum + (e.type === 'rua' ? e.activeMs : 0), 0);
  return { input, fire, sweep, events, states, ruaMs };
}

test('a held button over her hair never strokes (no session, no rua time)', t => {
  const r = rig(t);
  r.fire('pointerdown', 100, 0, 1);
  r.sweep(90, 10, 1);
  assert.notEqual(r.input.state.phase, 'rua');
  assert.equal(r.states.some(s => s.phase === 'rua'), false);
  assert.equal(r.ruaMs(), 0);
});

test('no button, the same motion strokes as before', t => {
  const r = rig(t);
  r.sweep(90, 10, 0);
  assert.equal(r.input.state.phase, 'rua');
});

test('after a release only the motion after it counts', t => {
  const r = rig(t);
  r.fire('pointerdown', 100, 0, 1);
  r.sweep(90, 10, 1);
  r.fire('pointerup', 100, 400, 0);
  assert.equal(r.input.state.phase, 'idle');
  assert.equal(r.states.some(s => s.phase === 'rua'), false, 'the pull stroked nothing');
  r.fire('pointermove', 100, 420, 0);
  assert.equal(r.input.state.phase, 'rua', 'a fresh origin at the first move after the release');
  assert.equal(r.ruaMs(), 0, 'no carried-over motion');
});

test('hovering first, then pressing: the press ends the stroke and holding adds none', t => {
  const r = rig(t);
  r.sweep(90, 0, 0);
  assert.equal(r.input.state.phase, 'rua');
  r.fire('pointerdown', 100, 400, 1);
  assert.notEqual(r.input.state.phase, 'rua');
  const before = r.ruaMs();
  r.sweep(90, 420, 1);
  assert.equal(r.ruaMs(), before);
});
