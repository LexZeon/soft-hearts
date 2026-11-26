// 「调整镜头」 from the companion's toolbar (2026-11-19): the Unbound window stage swallowed it (a not-yet stand-in), so the button did nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowCameraEdit } from '../src/unbound/window-mode/window-camera';
import { WindowStageNotYet } from '../src/unbound/window-mode/not-yet';
import { UnboundWindowStage } from '../src/unbound/window-mode/window-stage';
import { requestCameraEdit } from '../src/stage/camera-edit-entry';
import type { CameraConfig } from '../shared/foundation/settings';

const CAMERA: CameraConfig = { yaw: 0, pitch: 0, distance: 30, targetX: 0, targetY: 10, targetZ: 0, fov: 32 };

function fakeCanvas() {
  const target = new EventTarget();
  const canvas = Object.assign(target, { tabIndex: -1, clientHeight: 600, focus() { (globalThis as any).document.activeElement = canvas; }, hasPointerCapture: () => false, releasePointerCapture() {}, setPointerCapture() {} });
  return canvas as unknown as HTMLCanvasElement & EventTarget;
}
function withDom<T>(run: () => T): T {
  const g = globalThis as any, saved = { window: g.window, document: g.document };
  g.window = new EventTarget(); g.document = { activeElement: null, hidden: false };
  try { return run(); } finally { g.window = saved.window; g.document = saved.document; }
}

test('the Unbound window stage answers the camera-edit entry itself, not through the swallowing stand-in', () => {
  assert.equal(Object.getOwnPropertyNames(WindowStageNotYet.prototype).includes('setCameraEditMode'), false, 'a stand-in would make the button do nothing');
  assert.equal(Object.getOwnPropertyNames(UnboundWindowStage.prototype).includes('setCameraEditMode'), true);
});

test('window camera edit: entering reports the mode, a wheel turn moves the camera and is saved, Esc finishes; hidden refuses', () => {
  withDom(() => {
    const canvas = fakeCanvas(); const applied: CameraConfig[] = [], saved: CameraConfig[] = [], modes: boolean[] = []; let visible = true;
    const edit = new WindowCameraEdit(canvas, CAMERA, { apply: c => applied.push(c), changed: c => saved.push(c), mode: m => modes.push(m), reset: () => {}, canEdit: () => visible });
    canvas.dispatchEvent(Object.assign(new Event('wheel', { cancelable: true }), { deltaY: 100, shiftKey: false }));
    assert.equal(saved.length, 0, 'not editing: the wheel does nothing');
    edit.set(true);
    assert.deepEqual(modes, [true]);
    canvas.dispatchEvent(Object.assign(new Event('wheel', { cancelable: true }), { deltaY: 100, shiftKey: false }));
    assert.equal(saved.length, 1); assert.ok(saved[0].distance > CAMERA.distance); assert.deepEqual(applied, saved);
    canvas.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { code: 'Escape', isComposing: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false }));
    assert.deepEqual(modes, [true, false]);
    visible = false; edit.set(true);
    assert.deepEqual(modes, [true, false], 'hidden: it does not start');
    edit.dispose();
  });
});

test('the button always answers: a stage that cannot start camera editing makes a message, one that can stays quiet', () => {
  const said = [] as string[]; let editing = false as boolean;
  const good = { setCameraEditMode(enabled: boolean) { editing = enabled; } };
  requestCameraEdit(good, () => editing, undefined, m => said.push(m));
  assert.equal(editing, true); assert.equal(said.length, 0);
  requestCameraEdit(good, () => editing, undefined, m => said.push(m)); // toggles off
  assert.equal(editing, false); assert.equal(said.length, 0);
  const dead = { setCameraEditMode() {} };
  requestCameraEdit(dead, () => false, undefined, m => said.push(m));
  assert.equal(said.length, 1); assert.ok(said[0].length > 5);
  const broken = { setCameraEditMode() { throw new Error('x'); } };
  requestCameraEdit(broken, () => false, true, m => said.push(m));
  assert.equal(said.length, 2);
  requestCameraEdit(dead, () => false, false, m => said.push(m)); // turning off never complains
  assert.equal(said.length, 2);
});
