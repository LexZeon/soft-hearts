import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { PetWindowDrag } from '../electron/pet-window-drag';
import type { Bounds } from '../electron/pet-view';

function fixture(t: TestContext, initial: Bounds = { x: 200, y: 150, width: 400, height: 400 }, area: Bounds = { x: 0, y: 0, width: 1600, height: 900 }) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let bounds = { ...initial }, cursor = { x: 300, y: 300 };
  const writes: { kind: 'position' | 'bounds'; bounds: Bounds }[] = [];
  const drag = new PetWindowDrag({
    getBounds: () => ({ ...bounds }),
    setBounds(next) { bounds = { ...next }; writes.push({ kind: 'bounds', bounds: { ...bounds } }); },
  }, {
    getCursorScreenPoint: () => ({ ...cursor }),
    getDisplayNearestPoint: () => ({ workArea: { ...area } }),
  });
  t.after(() => drag.stop());
  return {
    drag, writes,
    get bounds() { return { ...bounds }; },
    cursor(x: number, y: number) { cursor = { x, y }; },
    advance(ms = 16) { t.mock.timers.tick(ms); },
    externalResize(next: Bounds) { bounds = { ...next }; },
  };
}

test('a held move follows the native cursor from one fixed origin and does not accumulate window relocation', t => {
  const f = fixture(t); f.drag.start('move');
  for (const [x, y] of [[320, 310], [380, 350], [340, 315], [300, 300], [275, 280]]) {
    f.cursor(x, y); f.advance();
    assert.deepEqual(f.bounds, { x: 200 + x - 300, y: 150 + y - 300, width: 400, height: 400 });
  }
  assert.equal(f.writes.length, 5);
  assert.ok(f.writes.every(write => write.kind === 'bounds'));
  const count = f.writes.length; f.advance(2000);
  assert.equal(f.writes.length, count, 'a held but stationary pointer must cause no native window updates');
});

test('fractional-DPI bounds rounding never accumulates dimensions or creates stationary writes across holds', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let actual = { x: 200, y: 150, width: 400, height: 560 }, cursor = { x: 300, y: 300 };
  const requested: Bounds[] = [];
  const drag = new PetWindowDrag({ getBounds: () => ({ ...actual }), setBounds(bounds) {
    requested.push({ ...bounds }); actual = { ...bounds, width: bounds.width + 1, height: bounds.height + 1 };
  } }, { getCursorScreenPoint: () => ({ ...cursor }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 2000, height: 1200 } }) });
  t.after(() => drag.cancel());
  for (let hold = 0; hold < 3; hold++) {
    drag.start('move');
    for (let step = 0; step < 12; step++) { cursor.x += 7; cursor.y += 3; t.mock.timers.tick(16); }
    const count = requested.length; t.mock.timers.tick(2000);
    assert.equal(requested.length, count, 'rounded native bounds cannot trigger a corrective loop at rest');
    const finished = drag.stop()!;
    assert.equal(finished.bounds.width, 400); assert.equal(finished.bounds.height, 560);
  }
  assert.equal(requested.length, 36);
  assert.ok(requested.every(b => b.width === 400 && b.height === 560), 'each native command retains the original logical dimensions');
});

test('edge clamping does not accumulate excess movement or stick when the cursor comes back', t => {
  const f = fixture(t); f.drag.start('move');
  f.cursor(-400, -400); f.advance();
  assert.deepEqual(f.bounds, { x: 0, y: 0, width: 400, height: 400 });
  f.cursor(310, 320); f.advance();
  assert.deepEqual(f.bounds, { x: 210, y: 170, width: 400, height: 400 });
  f.cursor(3000, 3000); f.advance();
  assert.deepEqual(f.bounds, { x: 1200, y: 500, width: 400, height: 400 });
  f.cursor(300, 300); f.advance();
  assert.deepEqual(f.bounds, { x: 200, y: 150, width: 400, height: 400 });
});

test('negative desktop coordinates stay in the selected monitor coordinate space', t => {
  const f = fixture(t, { x: -1000, y: 100, width: 400, height: 400 }, { x: -1280, y: 40, width: 1280, height: 720 });
  f.drag.start('move'); f.cursor(370, 320); f.advance();
  assert.deepEqual(f.bounds, { x: -930, y: 120, width: 400, height: 400 });
  f.cursor(-500, -500); f.advance();
  assert.deepEqual(f.bounds, { x: -1280, y: 40, width: 400, height: 400 });
});

for (const operation of ['nw', 'ne', 'sw', 'se'] as const) {
  test(`${operation} changes width and height independently while keeping its opposite corner fixed`, t => {
    const f = fixture(t), left = operation.endsWith('w'), top = operation.startsWith('n');
    f.drag.start(operation);
    f.cursor(300 + (left ? -80 : 80), 300 + (top ? -40 : 40)); f.advance();
    assert.deepEqual(f.bounds, { x: left ? 120 : 200, y: top ? 110 : 150, width: 480, height: 440 });
    assert.equal(left ? f.bounds.x + f.bounds.width : f.bounds.x, left ? 600 : 200);
    assert.equal(top ? f.bounds.y + f.bounds.height : f.bounds.y, top ? 550 : 150);
    assert.notEqual(f.bounds.width / f.bounds.height, 1, 'the window is free to change aspect ratio');
    assert.ok(f.writes.every(write => write.kind === 'bounds'));
    const count = f.writes.length; f.advance(2000);
    assert.equal(f.writes.length, count, 'stationary resize must not keep resizing the viewport');
    f.cursor(300, 300); f.advance();
    assert.deepEqual(f.bounds, { x: 200, y: 150, width: 400, height: 400 });
  });

  test(`${operation} respects minimum size and monitor edges without moving the fixed corner`, t => {
    const f = fixture(t), left = operation.endsWith('w'), top = operation.startsWith('n');
    f.drag.start(operation);
    f.cursor(300 + (left ? 1000 : -1000), 300 + (top ? 1000 : -1000)); f.advance();
    assert.equal(f.bounds.width, 200); assert.equal(f.bounds.height, 200);
    assert.equal(left ? f.bounds.x + f.bounds.width : f.bounds.x, left ? 600 : 200);
    assert.equal(top ? f.bounds.y + f.bounds.height : f.bounds.y, top ? 550 : 150);
    f.cursor(300 + (left ? -3000 : 3000), 300 + (top ? -3000 : 3000)); f.advance();
    assert.ok(f.bounds.x >= 0 && f.bounds.y >= 0);
    assert.ok(f.bounds.x + f.bounds.width <= 1600 && f.bounds.y + f.bounds.height <= 900);
    assert.equal(left ? f.bounds.x + f.bounds.width : f.bounds.x, left ? 600 : 200);
    assert.equal(top ? f.bounds.y + f.bounds.height : f.bounds.y, top ? 550 : 150);
  });
}

test('a work area smaller than the normal minimum still contains the entire resized window', t => {
  const f = fixture(t, { x: 0, y: 0, width: 160, height: 120 }, { x: 0, y: 0, width: 160, height: 120 });
  f.drag.start('se'); f.cursor(100, 100); f.advance();
  assert.deepEqual(f.bounds, { x: 0, y: 0, width: 160, height: 120 });
});

test('stop samples the final cursor once, releases the loop and makes subsequent stop calls inert', t => {
  const f = fixture(t); f.drag.start('se'); f.cursor(355, 330);
  const finished = f.drag.stop();
  assert.deepEqual(finished, { operation: 'se', bounds: { x: 200, y: 150, width: 455, height: 430 } });
  assert.deepEqual(f.bounds, finished?.bounds);
  const count = f.writes.length; f.cursor(500, 500); f.advance(5000);
  assert.equal(f.writes.length, count);
  assert.equal(f.drag.stop(), null);
});

test('repeated start cannot change the active operation or re-anchor an existing hold', t => {
  const f = fixture(t); f.drag.start('move');
  f.cursor(340, 310); f.advance(); f.drag.start('se');
  f.cursor(380, 320); f.advance();
  assert.deepEqual(f.bounds, { x: 280, y: 170, width: 400, height: 400 });
  assert.equal(f.drag.stop()?.operation, 'move');
  f.drag.start('se'); f.cursor(400, 350); f.advance();
  assert.deepEqual(f.bounds, { x: 280, y: 170, width: 420, height: 430 });
});

test('an external resize ends a move instead of restoring the old viewport geometry', t => {
  const f = fixture(t); f.drag.start('move');
  const recovered = { x: 500, y: 200, width: 600, height: 500 };
  f.externalResize(recovered); f.cursor(700, 600); f.advance(); f.advance(1000);
  assert.deepEqual(f.bounds, recovered); assert.equal(f.writes.length, 0);
  assert.equal(f.drag.stop(), null);
});

test('cancel drops an unsampled cursor change and a later hold starts with a fresh origin', t => {
  const f = fixture(t); f.drag.start('move');
  f.cursor(340, 310); f.advance();
  const accepted = f.bounds, count = f.writes.length;
  f.cursor(700, 700); f.drag.cancel(); f.advance(2000);
  assert.equal(f.drag.active, false); assert.equal(f.drag.stop(), null);
  assert.deepEqual(f.bounds, accepted); assert.equal(f.writes.length, count);
  f.drag.start('move'); f.cursor(710, 705); f.advance();
  assert.deepEqual(f.bounds, { ...accepted, x: accepted.x + 10, y: accepted.y + 5 });
});

test('recovery during a corner resize cancels the old hold without undoing the new geometry', t => {
  const f = fixture(t); f.drag.start('nw');
  f.cursor(270, 280); f.advance();
  assert.deepEqual(f.bounds, { x: 170, y: 130, width: 430, height: 420 });
  const count = f.writes.length, recovered = { x: 500, y: 200, width: 600, height: 500 };
  f.externalResize(recovered); f.cursor(200, 200); f.advance(1000);
  assert.deepEqual(f.bounds, recovered); assert.equal(f.writes.length, count);
  assert.equal(f.drag.active, false); assert.equal(f.drag.stop(), null);
});
