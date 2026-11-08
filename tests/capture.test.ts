import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { cameraSnapshot } from '../src/ui/capture';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function environment(t: TestContext, options: { permission?: Promise<void>; media?: Promise<MediaStream>; waitForFrame?: boolean } = {}) {
  const original = Object.fromEntries(['window', 'navigator', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const permissions: boolean[] = [];
  const mediaStarted = deferred<void>();
  const frameStarted = deferred<void>();
  let acquisitions = 0;
  let stops = 0;
  let pauses = 0;
  let frameCancels = 0;
  let draws = 0;
  const stream = { getTracks: () => [{ stop: () => { stops++; } }] } as unknown as MediaStream;
  const video = {
    videoWidth: 1920, videoHeight: 1080, srcObject: null as MediaStream | null, muted: false,
    play: async () => {}, pause: () => { pauses++; },
    requestVideoFrameCallback: (callback: () => void) => { frameStarted.resolve(); if (!options.waitForFrame) queueMicrotask(callback); return 1; },
    cancelVideoFrameCallback: () => { frameCancels++; },
  };
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: () => { draws++; } }), toDataURL: () => 'data:image/jpeg;base64,AA==' };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { desktop: { setCameraPermission: async (enabled: boolean) => { permissions.push(enabled); if (enabled) await options.permission; } } } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => { acquisitions++; mediaStarted.resolve(); return options.media ?? Promise.resolve(stream); } } } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => tag === 'video' ? video : canvas } });
  t.after(() => {
    for (const [key, descriptor] of Object.entries(original)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return { permissions, mediaStarted, frameStarted, stream, video, canvas, counts: () => ({ acquisitions, stops, pauses, frameCancels, draws }) };
}

test('one camera frame releases tracks, video source, timer and permission', async t => {
  const env = environment(t);
  assert.deepEqual(await cameraSnapshot(), { source: 'camera', dataUrl: 'data:image/jpeg;base64,AA==' });
  assert.deepEqual(env.permissions, [true, false]);
  assert.deepEqual(env.counts(), { acquisitions: 1, stops: 1, pauses: 1, frameCancels: 1, draws: 1 });
  assert.equal(env.video.srcObject, null);
  assert.equal(env.canvas.width, 1280);
  assert.equal(env.canvas.height, 720);
});

test('already canceled request never enables permission or acquires a camera', async t => {
  const env = environment(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(cameraSnapshot(controller.signal), { name: 'AbortError' });
  assert.deepEqual(env.permissions, []);
  assert.equal(env.counts().acquisitions, 0);
});

test('cancel during permission IPC does not start getUserMedia', async t => {
  const permission = deferred<void>();
  const env = environment(t, { permission: permission.promise });
  const controller = new AbortController();
  const capture = cameraSnapshot(controller.signal);
  controller.abort();
  await assert.rejects(capture, { name: 'AbortError' });
  permission.resolve();
  assert.deepEqual(env.permissions, [true, false]);
  assert.equal(env.counts().acquisitions, 0);
});

test('cancel while getUserMedia is pending releases permission and stops late tracks', async t => {
  const media = deferred<MediaStream>();
  const env = environment(t, { media: media.promise });
  const controller = new AbortController();
  const capture = cameraSnapshot(controller.signal);
  await env.mediaStarted.promise;
  controller.abort();
  await assert.rejects(capture, { name: 'AbortError' });
  assert.deepEqual(env.permissions, [true, false]);
  media.resolve(env.stream);
  await Promise.resolve();
  assert.equal(env.counts().stops, 1);
  assert.equal(env.counts().draws, 0);
});

test('cancel during frame wait immediately releases camera and pending callback', async t => {
  const env = environment(t, { waitForFrame: true });
  const controller = new AbortController();
  const capture = cameraSnapshot(controller.signal);
  await env.frameStarted.promise;
  controller.abort();
  await assert.rejects(capture, { name: 'AbortError' });
  assert.deepEqual(env.permissions, [true, false]);
  assert.equal(env.counts().frameCancels, 1);
  assert.equal(env.counts().draws, 0);
  assert.equal(env.video.srcObject, null);
});

test('device failure still revokes camera permission', async t => {
  const media = deferred<MediaStream>();
  const env = environment(t, { media: media.promise });
  const capture = cameraSnapshot();
  await env.mediaStarted.promise;
  media.reject(new Error('device unavailable'));
  await assert.rejects(capture, /device unavailable/);
  assert.deepEqual(env.permissions, [true, false]);
  assert.equal(env.counts().draws, 0);
});
