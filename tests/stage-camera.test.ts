import assert from "node:assert/strict";
import test from "node:test";
import type { CameraConfig } from "../shared/contracts";
import { CameraController, cameraBasis, moveCamera, normalizeCamera, panCamera, rotateCamera } from "../src/stage/CameraController";

const initial: CameraConfig = { yaw: 0, pitch: 0, distance: 20, targetX: 0, targetY: 10, fov: 32 };
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const eye = (camera: CameraConfig) => {
  const { forward } = cameraBasis(camera);
  return [camera.targetX - forward.x * camera.distance, camera.targetY - forward.y * camera.distance, (camera.targetZ ?? 0) - forward.z * camera.distance];
};
const sameEye = (actual: CameraConfig, expected: CameraConfig) => eye(actual).forEach((value, index) => close(value, eye(expected)[index]));

test("camera travel follows view direction, with frame-independent normalized diagonals", () => {
  const forward = moveCamera(initial, { forward: 1, right: 0, up: 0 }, 0.1);
  assert.ok(forward.targetZ! < 0);
  assert.equal(forward.targetX, 0);
  const rotated = moveCamera({ ...initial, yaw: 90 }, { forward: 1, right: 0, up: 0 }, 0.1);
  assert.ok(rotated.targetX < 0);
  close(rotated.targetZ!, 0);
  const up = moveCamera({ ...initial, yaw: 65, pitch: 70 }, { forward: 0, right: 0, up: 1 }, 0.1);
  assert.ok(up.targetY > initial.targetY);
  assert.equal(up.targetX, initial.targetX);
  close(up.targetZ!, 0);
  function travel(fps: number, diagonal: boolean): CameraConfig {
    let camera = initial;
    for (let frame = 0; frame < fps; frame++) camera = moveCamera(camera, { forward: 1, right: Number(diagonal), up: Number(diagonal) }, 1 / fps);
    return camera;
  }
  const at30 = travel(30, true), at60 = travel(60, true), straight = travel(30, false);
  close(at30.targetX, at60.targetX);
  close(at30.targetY, at60.targetY);
  close(at30.targetZ!, at60.targetZ!);
  close(Math.hypot(at30.targetX, at30.targetY - 10, at30.targetZ!), Math.abs(straight.targetZ!));
  assert.equal(at30.distance, initial.distance);
});

test("screen-plane panning preserves orientation and camera normalization bounds edits", () => {
  const camera = { ...initial, yaw: 45, pitch: 25, targetZ: 7 };
  const panned = panCamera(camera, 20, 10, 600);
  assert.notEqual(panned.targetX, camera.targetX);
  assert.notEqual(panned.targetY, camera.targetY);
  assert.notEqual(panned.targetZ, camera.targetZ);
  assert.equal(panned.yaw, camera.yaw);
  assert.equal(panned.pitch, camera.pitch);
  assert.equal(panned.distance, camera.distance);
  const basis = cameraBasis(camera);
  close(basis.forward.x * basis.up.x + basis.forward.y * basis.up.y + basis.forward.z * basis.up.z, 0);
  const rotated = rotateCamera({ ...initial, yaw: 179 }, -20, 1000);
  assert.ok(rotated.yaw >= -180 && rotated.yaw <= 180);
  assert.equal(rotated.pitch, 80);
  assert.equal(normalizeCamera({ ...initial, distance: 1000, fov: 5 }).distance, 500);
  assert.equal(normalizeCamera(initial).targetZ, 0);
});

test("left rotation keeps the eye fixed through small, combined, wrapped and pitch-limited turns", () => {
  for (const camera of [initial, { ...initial, yaw: 179, pitch: 79, fov: 12 }, { ...initial, yaw: -74, pitch: -52, distance: 83, targetX: 235, targetY: -310, targetZ: 147, fov: 75 }]) {
    let current = camera;
    for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2], [17, -9], [-35, 18], [1600, 1000], [-1600, -1000]]) {
      const rotated = rotateCamera(current, dx, dy);
      sameEye(rotated, current); sameEye(rotated, camera);
      assert.equal(rotated.distance, camera.distance); assert.equal(rotated.fov, camera.fov);
      assert.ok(rotated.yaw >= -180 && rotated.yaw < 180); assert.ok(Math.abs(rotated.pitch) <= 80);
      current = rotated;
    }
  }
  const small = rotateCamera(initial, 2, -1);
  close(small.yaw, -0.5); close(small.pitch, -0.25);
  assert.notEqual(small.targetX, initial.targetX);
});

test("a rotation that exceeds target bounds is rejected without translating the eye", () => {
  for (const [camera, dx, dy] of [
    [{ ...initial, targetX: 999.999 }, 1, 0],
    [{ ...initial, targetX: -999.999 }, -1, 0],
    [{ ...initial, targetY: 999.999 }, 0, -1],
    [{ ...initial, targetY: -999.999 }, 0, 1],
    [{ ...initial, yaw: 90, targetZ: 999.999 }, -1, 0],
    [{ ...initial, yaw: 90, targetZ: -999.999 }, 1, 0],
  ] as const) {
    assert.equal(rotateCamera(camera, dx, dy), camera);
    sameEye(rotateCamera(camera, dx, dy), camera);
  }
  assert.equal(rotateCamera(initial, Number.NaN, 1), initial);
  assert.equal(rotateCamera(initial, 1, Number.POSITIVE_INFINITY), initial);
});

function controllerFixture(camera = initial) {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const documentMock = { activeElement: null as unknown };
  const windowMock = new EventTarget();
  class CanvasMock extends EventTarget {
    tabIndex = -1;
    clientHeight = 600;
    captured = new Set<number>();
    focus() { documentMock.activeElement = this; }
    hasPointerCapture(id: number) { return this.captured.has(id); }
    setPointerCapture(id: number) { this.captured.add(id); }
    releasePointerCapture(id: number) { this.captured.delete(id); }
  }
  const send = (target: EventTarget, type: string, properties: Record<string, unknown> = {}) => {
    const event = new Event(type, { cancelable: true, bubbles: true });
    for (const [key, value] of Object.entries({ shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, repeat: false, ...properties })) Object.defineProperty(event, key, { value });
    target.dispatchEvent(event);
    return event;
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowMock });
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentMock });
  const canvas = new CanvasMock();
  const changes: CameraConfig[] = [], modes: boolean[] = [], resets: number[] = [];
  const controller = new CameraController(canvas as unknown as HTMLCanvasElement, camera, next => changes.push(next), mode => modes.push(mode), () => resets.push(changes.length));
  return { controller, canvas, changes, modes, resets, documentMock, windowMock, send, dispose: () => {
    controller.dispose();
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow); else Reflect.deleteProperty(globalThis, "window");
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument); else Reflect.deleteProperty(globalThis, "document");
  } };
}

test("camera input is opt-in and focus-scoped; Shift refines while Space rises and exit releases capture", () => {
  const fixture = controllerFixture(), { controller, canvas, changes, modes, documentMock, windowMock, send } = fixture;
  try {
    send(canvas, "pointerdown", { pointerId: 1, button: 0, buttons: 1, clientX: 0, clientY: 0 });
    send(canvas, "pointermove", { pointerId: 1, buttons: 1, clientX: 20, clientY: 10 });
    assert.equal(changes.length, 0);
    controller.setEnabled(true);
    assert.equal(documentMock.activeElement, canvas);
    send(canvas, "keydown", { code: "ShiftLeft", shiftKey: true });
    controller.update(0.1); assert.equal(changes.length, 0, 'Shift alone never moves the camera');
    send(canvas, "pointerdown", { pointerId: 1, button: 0, buttons: 1, clientX: 0, clientY: 0, shiftKey: true });
    send(canvas, "pointermove", { pointerId: 1, buttons: 1, clientX: 20, clientY: 10, shiftKey: true });
    assert.notEqual(changes.at(-1)!.yaw, initial.yaw);
    close(changes.at(-1)!.yaw, -1.25);
    sameEye(changes.at(-1)!, initial);
    send(canvas, "pointerup", { pointerId: 1, shiftKey: true });
    const rotatedTargetY = changes.at(-1)!.targetY;
    controller.update(0.1); assert.equal(changes.length, 1, 'holding Shift after a turn does not rise');
    send(canvas, "keydown", { code: "Space", shiftKey: true });
    controller.update(0.1);
    assert.ok(changes.at(-1)!.targetY > rotatedTargetY);
    send(canvas, "keyup", { code: "Space", shiftKey: true });
    send(canvas, "pointerdown", { pointerId: 2, button: 2, clientX: 0, clientY: 0 });
    assert.equal(canvas.captured.size, 1);
    documentMock.activeElement = {};
    send(canvas, "blur");
    assert.equal(canvas.captured.size, 0);
    assert.deepEqual(modes, [true]);
    const beforeBlur = changes.length;
    send(canvas, "keydown", { code: "KeyW" });
    controller.update(0.1);
    assert.equal(changes.length, beforeBlur);
    canvas.focus();
    send(canvas, "keydown", { code: "KeyW", isComposing: true });
    send(canvas, "keydown", { code: "KeyW", ctrlKey: true });
    controller.update(0.1);
    assert.equal(changes.length, beforeBlur);
    send(canvas, "pointerdown", { pointerId: 3, button: 0, clientX: 0, clientY: 0 });
    send(canvas, "keydown", { code: "Escape" });
    assert.equal(canvas.captured.size, 0);
    assert.deepEqual(modes, [true, false]);
    controller.setEnabled(true);
    send(canvas, "keydown", { code: "KeyW" });
    send(windowMock, "blur");
    controller.update(0.1);
    assert.equal(changes.length, beforeBlur);
    assert.deepEqual(modes, [true, false, true, false]);
  } finally {
    fixture.dispose();
  }
});

test("the first small drag applies immediately and losing its own button ends without another camera change", () => {
  const fixture = controllerFixture(), { controller, canvas, changes, send } = fixture;
  try {
    controller.setEnabled(true);
    send(canvas, "pointerdown", { pointerId: 1, button: 0, buttons: 1, clientX: 100.25, clientY: 400.5 });
    send(canvas, "pointermove", { pointerId: 1, buttons: 1, clientX: 100.25, clientY: 400.5 });
    assert.equal(changes.length, 0, 'a zero delta does not queue a camera save');
    send(canvas, "pointermove", { pointerId: 1, buttons: 1, clientX: 102.25, clientY: 399.5 });
    assert.equal(changes.length, 1); close(changes[0].yaw, -0.5); close(changes[0].pitch, -0.25); sameEye(changes[0], initial);
    send(canvas, "pointermove", { pointerId: 1, buttons: 0, clientX: 900, clientY: -900 });
    assert.equal(changes.length, 1); assert.equal(controller.interacting, false); assert.equal(canvas.captured.size, 0);
    send(canvas, "pointermove", { pointerId: 1, buttons: 1, clientX: 904, clientY: -896 });
    assert.equal(changes.length, 1);

    send(canvas, "pointerdown", { pointerId: 2, button: 2, buttons: 2, clientX: 20, clientY: 30 });
    send(canvas, "pointermove", { pointerId: 2, buttons: 3, clientX: 22, clientY: 31 });
    assert.equal(changes.length, 2, 'right drag remains held when another button is also down');
    send(canvas, "pointermove", { pointerId: 2, buttons: 1, clientX: 200, clientY: 300 });
    assert.equal(changes.length, 2); assert.equal(controller.interacting, false); assert.equal(canvas.captured.size, 0);
  } finally { fixture.dispose(); }
});

test("nonfinite pointer coordinates neither capture nor contaminate a later valid drag", () => {
  const fixture = controllerFixture(), { controller, canvas, changes, send } = fixture;
  try {
    controller.setEnabled(true);
    let id = 0;
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      for (const point of [{ clientX: invalid, clientY: 10 }, { clientX: 10, clientY: invalid }]) {
        send(canvas, "pointerdown", { pointerId: ++id, button: 0, buttons: 1, ...point });
        assert.equal(canvas.captured.size, 0); assert.equal(controller.interacting, false);
        send(canvas, "pointerdown", { pointerId: ++id, button: 0, buttons: 1, clientX: 10, clientY: 10 });
        send(canvas, "pointermove", { pointerId: id, buttons: 1, ...point });
        assert.equal(changes.length, 0); assert.equal(canvas.captured.size, 0); assert.equal(controller.interacting, false);
      }
    }
    send(canvas, "pointerdown", { pointerId: ++id, button: 0, buttons: 1, clientX: 10, clientY: 10 });
    send(canvas, "pointermove", { pointerId: id, buttons: 1, clientX: 11, clientY: 12 });
    assert.equal(changes.length, 1); close(changes[0].yaw, -0.25); close(changes[0].pitch, 0.5); sameEye(changes[0], initial);
  } finally { fixture.dispose(); }
});

test("Shift applies one quarter to actual left rotation and right pan, including a modifier held before focus", () => {
  function drag(button: number, fine: boolean) {
    const fixture = controllerFixture(), { controller, canvas, changes, documentMock, windowMock, send } = fixture;
    try {
      documentMock.activeElement = {};
      if (fine) send(windowMock, "keydown", { code: "ShiftLeft", shiftKey: true });
      controller.setEnabled(true);
      send(canvas, "pointerdown", { pointerId: 1, button, buttons: button === 0 ? 1 : 2, clientX: 20, clientY: 30, shiftKey: fine });
      send(canvas, "pointermove", { pointerId: 1, buttons: button === 0 ? 1 : 2, clientX: 36, clientY: 38, shiftKey: fine });
      assert.equal(changes.length, 1); return changes[0];
    } finally { fixture.dispose(); }
  }
  const normal = drag(0, false), fine = drag(0, true);
  close(fine.yaw - initial.yaw, (normal.yaw - initial.yaw) * 0.25);
  close(fine.pitch - initial.pitch, (normal.pitch - initial.pitch) * 0.25);
  sameEye(normal, initial); sameEye(fine, initial);
  const normalPan = drag(2, false), finePan = drag(2, true);
  for (const key of ['targetX', 'targetY', 'targetZ'] as const) close((finePan[key] ?? 0) - (initial[key] ?? 0), ((normalPan[key] ?? 0) - (initial[key] ?? 0)) * 0.25);
  assert.equal(finePan.yaw, initial.yaw); assert.equal(finePan.pitch, initial.pitch);
});

test("Shift quarters all keyboard movement after the frame limit, and Space/Z retain world vertical travel", () => {
  function travel(keys: string[], fine: boolean, delta: number) {
    const fixture = controllerFixture(), { controller, canvas, changes, send } = fixture;
    try {
      controller.setEnabled(true);
      for (const code of keys) send(canvas, 'keydown', { code, shiftKey: fine });
      controller.update(delta); assert.equal(changes.length, 1); return changes[0];
    } finally { fixture.dispose(); }
  }
  for (const keys of [['KeyW'], ['KeyS'], ['KeyA'], ['KeyD'], ['Space'], ['KeyZ'], ['KeyW', 'KeyD', 'Space']]) {
    for (const delta of [0.04, 0.5]) {
      const normal = travel(keys, false, delta), fine = travel(keys, true, delta);
      for (const key of ['targetX', 'targetY', 'targetZ'] as const) close((fine[key] ?? 0) - (initial[key] ?? 0), ((normal[key] ?? 0) - (initial[key] ?? 0)) * 0.25);
      assert.equal(fine.yaw, initial.yaw); assert.equal(fine.pitch, initial.pitch);
    }
  }
  const up = travel(['Space'], false, 0.1), down = travel(['KeyZ'], false, 0.1);
  assert.ok(up.targetY > initial.targetY && down.targetY < initial.targetY);
  close(up.targetX, initial.targetX); close(up.targetZ ?? 0, 0);
});

test("Shift quarters actual wheel distance changes, including near both distance bounds", () => {
  function zoom(camera: CameraConfig, fine: boolean, deltaY: number) {
    const fixture = controllerFixture(camera), { controller, canvas, changes, send } = fixture;
    try {
      controller.setEnabled(true); send(canvas, 'wheel', { deltaY, shiftKey: fine });
      assert.equal(changes.length, 1); return changes[0];
    } finally { fixture.dispose(); }
  }
  for (const [camera, deltaY] of [[initial, 120], [initial, -120], [{ ...initial, distance: 499 }, 500], [{ ...initial, distance: 1.1 }, -500]] as const) {
    const normal = zoom(camera, false, deltaY), fine = zoom(camera, true, deltaY);
    close(fine.distance - camera.distance, (normal.distance - camera.distance) * 0.25);
    for (const key of ['yaw', 'pitch', 'targetX', 'targetY', 'fov'] as const) assert.equal(fine[key], camera[key]);
  }
});

test("live modifier release, focus loss and pointer cancellation clear fine movement without a global key listener", () => {
  const fixture = controllerFixture(), { controller, canvas, changes, send } = fixture;
  try {
    controller.setEnabled(true);
    send(canvas, 'keydown', { code: 'KeyW', shiftKey: true }); controller.update(0.1);
    const fineStep = changes[0].targetZ ?? 0;
    send(canvas, 'keyup', { code: 'ShiftLeft', shiftKey: false }); controller.update(0.1);
    const normalStep = (changes[1].targetZ ?? 0) - fineStep;
    close(normalStep, fineStep * 4);
    send(canvas, 'blur'); canvas.focus();
    send(canvas, 'keydown', { code: 'KeyW' }); controller.update(0.1);
    close((changes[2].targetZ ?? 0) - (changes[1].targetZ ?? 0), normalStep);
    send(canvas, 'pointerdown', { pointerId: 1, button: 0, buttons: 1, clientX: 20, clientY: 30, shiftKey: true });
    send(canvas, 'pointercancel', { pointerId: 1 });
    assert.equal(controller.interacting, false); assert.equal(canvas.captured.size, 0);
    controller.update(0.1); assert.equal(changes.length, 3);
    send(canvas, 'keydown', { code: 'KeyW' }); controller.update(0.1);
    close((changes[3].targetZ ?? 0) - (changes[2].targetZ ?? 0), normalStep);
    send(canvas, 'keyup', { code: 'KeyW' });
    send(canvas, 'pointerdown', { pointerId: 2, button: 0, buttons: 1, clientX: 20, clientY: 30, shiftKey: true });
    send(canvas, 'pointermove', { pointerId: 2, buttons: 1, clientX: 28, clientY: 30, shiftKey: true });
    close(changes[4].yaw, -0.5);
    send(canvas, 'pointermove', { pointerId: 2, buttons: 1, clientX: 36, clientY: 30, shiftKey: false });
    close(changes[5].yaw - changes[4].yaw, -2);
  } finally { fixture.dispose(); }
});

test("Tab resets once within the focused camera, releases held input and keeps editing; text and modified shortcuts win", () => {
  const fixture = controllerFixture(), { controller, canvas, changes, modes, resets, documentMock, send } = fixture;
  try {
    assert.equal(send(canvas, 'keydown', { code: 'Tab' }).defaultPrevented, false);
    controller.setEnabled(true);
    send(canvas, 'keydown', { code: 'KeyW' });
    send(canvas, 'pointerdown', { pointerId: 1, button: 0, buttons: 1, clientX: 20, clientY: 30 });
    assert.equal(send(canvas, 'keydown', { code: 'Tab' }).defaultPrevented, true);
    assert.equal(resets.length, 1); assert.equal(controller.interacting, false); assert.equal(canvas.captured.size, 0);
    controller.update(0.1); assert.equal(changes.length, 0); assert.deepEqual(modes, [true]);
    assert.equal(send(canvas, 'keydown', { code: 'Tab', repeat: true }).defaultPrevented, true);
    assert.equal(resets.length, 1);
    send(canvas, 'keyup', { code: 'Tab' });
    assert.equal(send(canvas, 'keydown', { code: 'Tab', shiftKey: true }).defaultPrevented, true);
    assert.equal(resets.length, 2);
    for (const blocked of [{ isComposing: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
      assert.equal(send(canvas, 'keydown', { code: 'Tab', ...blocked }).defaultPrevented, false);
      assert.equal(resets.length, 2);
    }
    documentMock.activeElement = {};
    assert.equal(send(canvas, 'keydown', { code: 'Tab' }).defaultPrevented, false); assert.equal(resets.length, 2);
    canvas.focus();
    send(canvas, 'pointerdown', { pointerId: 2, button: 0, buttons: 1, clientX: 20, clientY: 30 });
    send(canvas, 'pointermove', { pointerId: 2, buttons: 1, clientX: 21, clientY: 31 });
    assert.equal(changes.length, 1, 'reset leaves camera editing enabled');
    controller.setEnabled(false);
    assert.equal(send(canvas, 'keydown', { code: 'Tab' }).defaultPrevented, false); assert.equal(resets.length, 2);
  } finally { fixture.dispose(); }
});
